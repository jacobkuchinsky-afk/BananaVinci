// Recorded motion: what you perform with ● Rec is stored as a motion path (dense samples) that the object
// follows exactly. Nothing is simplified away, so every wiggle, pause and quick turn plays back as performed.
import type { MotionChannel, MotionPath } from './schema';
import { MOTION_CHANNELS } from './schema';

export interface Sample {
  t: number; // object-local seconds
  v: Record<string, number>; // channel ('x' | 'y' | 'scale' | 'rotation') -> value
}

export type Smoothing = 'exact' | 'light' | 'smooth';
const WINDOW: Record<Smoothing, number> = { exact: 0, light: 1, smooth: 3 };

export const PATH_RATE = 60; // samples per second stored in the file

const round = (v: number, ch: string) => (ch === 'scale' ? Math.round(v * 10000) / 10000 : Math.round(v * 10) / 10);

/** Resample raw (irregular) samples to a fixed rate, optionally smoothing a little. */
export function samplesToPath(samples: Sample[], smoothing: Smoothing = 'exact', rate = PATH_RATE): MotionPath | null {
  const s = [...samples].sort((a, b) => a.t - b.t);
  if (s.length < 2) return null;
  const channels = MOTION_CHANNELS.filter((c) => s.some((x) => x.v[c] !== undefined));
  const t0 = s[0].t;
  const n = Math.max(2, Math.round((s[s.length - 1].t - t0) * rate) + 1);
  const path: MotionPath = { start: Math.round(t0 * 10000) / 10000, rate };
  for (const ch of channels) {
    const pts = s.filter((x) => x.v[ch] !== undefined);
    const out: number[] = [];
    let j = 0;
    for (let i = 0; i < n; i++) {
      const t = t0 + i / rate;
      while (j < pts.length - 2 && pts[j + 1].t <= t) j++;
      const a = pts[j];
      const b = pts[Math.min(j + 1, pts.length - 1)];
      const u = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
      out.push(a.v[ch] + (b.v[ch] - a.v[ch]) * u);
    }
    const w = WINDOW[smoothing];
    const smoothed = w ? out.map((_, i) => (i === 0 || i === out.length - 1 ? out[i] : avg(out, i, w))) : out;
    path[ch] = smoothed.map((v) => round(v, ch));
  }
  return path;
}

function avg(a: number[], i: number, w: number) {
  let sum = 0;
  let n = 0;
  for (let k = Math.max(0, i - w); k <= Math.min(a.length - 1, i + w); k++) {
    sum += a[k];
    n++;
  }
  return sum / n;
}

export const pathEnd = (p: MotionPath) => p.start + (Math.max(0, ...MOTION_CHANNELS.map((c) => (p[c]?.length ?? 0))) - 1) / p.rate;

/** A piece of a path from local time `from` to `to` (only the given channels), or null if empty. */
function slice(p: MotionPath, from: number, to: number, channels: readonly MotionChannel[]): MotionPath | null {
  const i0 = Math.max(0, Math.ceil((from - p.start) * p.rate - 1e-6));
  const out: MotionPath = { start: Math.round((p.start + i0 / p.rate) * 10000) / 10000, rate: p.rate };
  let any = false;
  for (const ch of channels) {
    const arr = p[ch];
    if (!arr) continue;
    const i1 = Math.min(arr.length - 1, Math.floor((to - p.start) * p.rate + 1e-6));
    if (i1 - i0 >= 1) {
      out[ch] = arr.slice(i0, i1 + 1);
      any = true;
    }
  }
  return any ? out : null;
}

/**
 * Put a new take into an object's paths. Older paths keep everything outside the new take's time range; inside it,
 * they keep only the channels the new take didn't record.
 */
export function mergePath(existing: MotionPath[] | undefined, take: MotionPath): MotionPath[] {
  const t0 = take.start;
  const t1 = pathEnd(take);
  const taken = MOTION_CHANNELS.filter((c) => take[c]);
  const others = MOTION_CHANNELS.filter((c) => !take[c]);
  const out: MotionPath[] = [];
  for (const p of existing ?? []) {
    const end = pathEnd(p);
    if (end < t0 || p.start > t1) {
      out.push(p);
      continue;
    }
    const before = slice(p, p.start, t0 - 1 / p.rate, MOTION_CHANNELS);
    const during = slice(p, t0, t1, others);
    const after = slice(p, t1 + 1 / p.rate, end, MOTION_CHANNELS);
    for (const piece of [before, during, after]) if (piece) out.push(piece);
  }
  out.push(take);
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Value of a channel from the paths at `localT`: the path that started most recently wins; inside it the samples are
 * interpolated, after its end its last value is held. Undefined before the first path (use the normal transform).
 */
export function pathValueAt(paths: MotionPath[] | undefined, ch: MotionChannel, localT: number): number | undefined {
  if (!paths?.length) return undefined;
  let best: MotionPath | undefined;
  for (const p of paths) if (p[ch]?.length && p.start <= localT + 1e-9 && (!best || p.start >= best.start)) best = p;
  if (!best) return undefined;
  const arr = best[ch]!;
  const f = (localT - best.start) * best.rate;
  if (f <= 0) return arr[0];
  if (f >= arr.length - 1) return arr[arr.length - 1];
  const i = Math.floor(f);
  return arr[i] + (arr[i + 1] - arr[i]) * (f - i);
}
