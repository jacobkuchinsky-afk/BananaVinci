// Reading (and writing) property values at a point in time.
//
// Every renderer/exporter reads animatable properties through valueAt() instead of touching the raw
// value. A value is either a plain number or `{ keyframes: [{ t, v, ease }] }` where `t` is seconds
// from the object's start and `ease` describes how the value travels INTO that keyframe.
import type { Animatable, AnimValue, Ease, Keyframe, TimelineObject, Transform } from './schema';

export const isAnimated = (v: unknown): v is AnimValue => !!v && typeof v === 'object' && Array.isArray((v as AnimValue).keyframes);

// ----------------------------------------------------------------------------- easing

function cubicBezier(x1: number, y1: number, x2: number, y2: number, u: number): number {
  // solve x(s) = u for s (Newton, then bisection fallback), return y(s)
  const bx = (s: number) => 3 * x1 * s * (1 - s) ** 2 + 3 * x2 * s * s * (1 - s) + s ** 3;
  const by = (s: number) => 3 * y1 * s * (1 - s) ** 2 + 3 * y2 * s * s * (1 - s) + s ** 3;
  const dbx = (s: number) => 3 * x1 * (1 - s) ** 2 + 6 * (x2 - x1) * s * (1 - s) + 3 * (1 - x2) * s * s;
  let s = u;
  for (let i = 0; i < 8; i++) {
    const err = bx(s) - u;
    if (Math.abs(err) < 1e-6) return by(s);
    const d = dbx(s);
    if (Math.abs(d) < 1e-6) break;
    s -= err / d;
  }
  let lo = 0;
  let hi = 1;
  s = u;
  for (let i = 0; i < 30; i++) {
    const x = bx(s);
    if (Math.abs(x - u) < 1e-6) break;
    if (x < u) lo = s;
    else hi = s;
    s = (lo + hi) / 2;
  }
  return by(s);
}

/** Damped spring released from 0 toward 1, after `t` seconds. */
function springAt(damping: number, frequency: number, t: number): number {
  const w0 = 2 * Math.PI * frequency;
  const z = damping;
  if (z < 1) {
    const wd = w0 * Math.sqrt(1 - z * z);
    return 1 - Math.exp(-z * w0 * t) * (Math.cos(wd * t) + ((z * w0) / wd) * Math.sin(wd * t));
  }
  return 1 - Math.exp(-w0 * t) * (1 + w0 * t);
}

function bounceOut(u: number): number {
  const n = 7.5625;
  const d = 2.75;
  if (u < 1 / d) return n * u * u;
  if (u < 2 / d) return n * (u -= 1.5 / d) * u + 0.75;
  if (u < 2.5 / d) return n * (u -= 2.25 / d) * u + 0.9375;
  return n * (u -= 2.625 / d) * u + 0.984375;
}

/**
 * Progress 0→1 of an ease at fraction `u` (0..1) of a segment lasting `segDur` seconds.
 * Results may go outside 0..1 (overshoot / anticipation). Always 0 at u=0 and 1 at u=1.
 * ('smooth' is handled in valueAt because it needs neighbouring keyframes.)
 */
export function easeProgress(ease: Ease, u: number, segDur = 1): number {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  switch (ease.type) {
    case 'linear':
    case 'smooth':
      return u;
    case 'hold':
      return 0;
    case 'easeIn':
      return u * u * u;
    case 'easeOut':
      return 1 - (1 - u) ** 3;
    case 'easeInOut':
      return u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2;
    case 'back': {
      const c1 = ease.overshoot;
      const c3 = c1 + 1;
      return 1 + c3 * (u - 1) ** 3 + c1 * (u - 1) ** 2;
    }
    case 'spring': {
      const T = Math.max(segDur, 1e-3);
      const x = springAt(ease.damping, ease.frequency, u * T);
      const residual = 1 - springAt(ease.damping, ease.frequency, T);
      return x + residual * u ** 4; // make sure we land exactly on the keyframe
    }
    case 'bounce':
      return bounceOut(u);
    case 'bezier':
      return cubicBezier(ease.x1, ease.y1, ease.x2, ease.y2, u);
  }
}

// ----------------------------------------------------------------------------- interpolation

/** Resolve an animatable value at `localT` seconds into the object. */
export function valueAt(v: Animatable, localT: number): number {
  if (typeof v === 'number') return v;
  const k = v.keyframes;
  if (!k.length) return 0;
  if (localT <= k[0].t) return k[0].v;
  const last = k[k.length - 1];
  if (localT >= last.t) return last.v;
  let i = 0;
  while (i < k.length - 2 && k[i + 1].t <= localT) i++;
  const a = k[i];
  const b = k[i + 1];
  const span = b.t - a.t;
  if (span <= 0) return b.v;
  const u = (localT - a.t) / span;
  if (b.ease.type === 'smooth') return hermite(k, i, u);
  return a.v + (b.v - a.v) * easeProgress(b.ease, u, span);
}

/** Catmull-Rom style curve through keyframes i and i+1 (used by `smooth` and recordings). */
function hermite(k: Keyframe[], i: number, u: number): number {
  const a = k[i];
  const b = k[i + 1];
  const span = b.t - a.t;
  // Monotone (Fritsch–Carlson style) slopes: the curve never overshoots a keyframe, so recorded
  // holds and turning points stay exactly where they were performed.
  const slope = (j: number) => {
    const p = k[j - 1];
    const c = k[j];
    const n = k[j + 1];
    if (!p || !n) return 0; // ease out of / into the ends
    const d0 = (c.v - p.v) / (c.t - p.t || 1e-9);
    const d1 = (n.v - c.v) / (n.t - c.t || 1e-9);
    if (d0 * d1 <= 0) return 0; // turning point or hold
    const m = (d0 + d1) / 2;
    const lim = 3 * Math.min(Math.abs(d0), Math.abs(d1));
    return Math.sign(m) * Math.min(Math.abs(m), lim);
  };
  const m0 = slope(i) * span;
  const m1 = slope(i + 1) * span;
  const u2 = u * u;
  const u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * a.v + (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) * b.v + (u3 - u2) * m1;
}

/** 0..1 multiplier from fadeIn/fadeOut at `localT` seconds into an object of `duration`. */
export function fadeFactor(localT: number, duration: number, fadeIn: number, fadeOut: number): number {
  let f = 1;
  if (fadeIn > 0 && localT < fadeIn) f = Math.min(f, Math.max(0, localT / fadeIn));
  const left = duration - localT;
  if (fadeOut > 0 && left < fadeOut) f = Math.min(f, Math.max(0, left / fadeOut));
  return f;
}

export interface ResolvedTransform {
  x: number;
  y: number;
  scale: number;
  /** extra horizontal / vertical stretch on top of scale (1 = none) */
  scaleX: number;
  scaleY: number;
  rotation: number;
  opacity: number;
  flipX: boolean;
  flipY: boolean;
}

export function transformAt(t: Transform, localT: number): ResolvedTransform {
  return {
    x: valueAt(t.x, localT),
    y: valueAt(t.y, localT),
    scale: valueAt(t.scale, localT),
    scaleX: t.scaleX === undefined ? 1 : valueAt(t.scaleX, localT),
    scaleY: t.scaleY === undefined ? 1 : valueAt(t.scaleY, localT),
    rotation: valueAt(t.rotation, localT),
    opacity: valueAt(t.opacity, localT),
    flipX: t.flipX,
    flipY: t.flipY,
  };
}

export const objectEnd = (o: TimelineObject) => o.start + o.duration;
export const isActiveAt = (o: TimelineObject, t: number) => o.enabled && t >= o.start && t < o.start + o.duration;

/** Seconds into the source file shown at timeline time `t` (video/audio). */
export const sourceTimeAt = (o: { start: number; in: number; speed: number }, t: number) => o.in + (t - o.start) * o.speed;

// ----------------------------------------------------------------------------- animatable properties

export interface AnimProp {
  path: string; // e.g. 'transform.x', 'effects.0.amount'
  label: string;
  unit?: string;
  step: number;
  min?: number;
  max?: number;
}

const T: AnimProp[] = [
  { path: 'transform.x', label: 'Position X', unit: 'px', step: 1 },
  { path: 'transform.y', label: 'Position Y', unit: 'px', step: 1 },
  { path: 'transform.scale', label: 'Zoom', step: 0.01, min: 0 },
  { path: 'transform.rotation', label: 'Rotation', unit: '°', step: 0.5 },
  { path: 'transform.opacity', label: 'Opacity', step: 0.01, min: 0, max: 1 },
];
const STRETCH: AnimProp[] = [
  { path: 'transform.scaleX', label: 'Stretch X', step: 0.01, min: 0 },
  { path: 'transform.scaleY', label: 'Stretch Y', step: 0.01, min: 0 },
];
/** The transform's properties; the optional stretches only when the object uses them. */
const tProps = (o: TimelineObject): AnimProp[] =>
  'transform' in o ? [...T, ...STRETCH.filter((p) => getPath(o, p.path) !== undefined)] : T;
const CROP: AnimProp[] = ['left', 'right', 'top', 'bottom'].map((s) => ({ path: `crop.${s}`, label: `Crop ${s}`, unit: 'px', step: 1, min: 0 }));

/** Every property of an object that can be keyframed. */
export function animatableProps(o: TimelineObject): AnimProp[] {
  const fx = 'effects' in o ? o.effects.map((e, i) => ({ path: `effects.${i}.amount`, label: `${e.type[0].toUpperCase()}${e.type.slice(1)} amount`, step: 0.01 })) : [];
  switch (o.type) {
    case 'video':
      return [...tProps(o), ...CROP, { path: 'volume', label: 'Volume', step: 0.01, min: 0, max: 2 }, ...fx];
    case 'image':
      return [...tProps(o), ...CROP, ...fx];
    case 'audio':
      return [{ path: 'volume', label: 'Volume', step: 0.01, min: 0, max: 2 }];
    case 'text':
      return [...tProps(o), { path: 'size', label: 'Text size', unit: 'px', step: 1, min: 1 }, { path: 'letterSpacing', label: 'Letter spacing', unit: 'px', step: 0.5 }, ...fx];
    case 'shape':
      return [...tProps(o), { path: 'width', label: 'Width', unit: 'px', step: 1, min: 1 }, { path: 'height', label: 'Height', unit: 'px', step: 1, min: 1 }, ...fx];
    case 'adjustment':
      return [{ path: 'opacity', label: 'Mix', step: 0.01, min: 0, max: 1 }, ...fx];
    case 'group':
      return [...T, ...fx];
  }
}

export function getPath(obj: any, path: string): any {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

export function setPath(obj: any, path: string, value: unknown) {
  const keys = path.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k];
  o[keys[keys.length - 1]] = value;
}

/** Paths of all properties of `o` that currently have keyframes. */
export function animatedPaths(o: TimelineObject): string[] {
  return animatableProps(o)
    .map((p) => p.path)
    .filter((p) => isAnimated(getPath(o, p)));
}

/** Sorted unique keyframe times (object-local seconds) across all animated properties. */
export function keyframeTimes(o: TimelineObject): { t: number; recorded: boolean }[] {
  const map = new Map<string, { t: number; recorded: boolean }>();
  for (const p of animatedPaths(o)) {
    const a = getPath(o, p) as AnimValue;
    for (const k of a.keyframes) {
      const key = k.t.toFixed(4);
      const prev = map.get(key);
      map.set(key, { t: k.t, recorded: (prev?.recorded ?? true) && !!a.recorded });
    }
  }
  return [...map.values()].sort((a, b) => a.t - b.t);
}

// ----------------------------------------------------------------------------- editing helpers (work on immer drafts)

export const KEY_EPS = 1e-3;
export const DEFAULT_EASE: Ease = { type: 'easeInOut' };

export function keyIndexAt(a: AnimValue, t: number): number {
  return a.keyframes.findIndex((k) => Math.abs(k.t - t) < KEY_EPS);
}

/** Insert or replace a keyframe; keeps keyframes sorted. */
const cleanT = (t: number) => Math.round(t * 10000) / 10000;

export function upsertKeyframe(a: AnimValue, t: number, v: number, ease?: Ease) {
  t = cleanT(t);
  const i = keyIndexAt(a, t);
  if (i >= 0) {
    a.keyframes[i].v = v;
    if (ease) a.keyframes[i].ease = ease;
    return;
  }
  a.keyframes.push({ t, v, ease: ease ?? { ...DEFAULT_EASE } });
  a.keyframes.sort((x, y) => x.t - y.t);
}

/**
 * Set a property "at the playhead": a static property just changes; an animated property gets a
 * keyframe at `localT` (added or updated). This is how the inspector and viewer edit values.
 */
export function setValueAt(obj: any, path: string, value: number, localT: number) {
  const cur = getPath(obj, path);
  if (isAnimated(cur)) {
    cur.recorded = undefined;
    upsertKeyframe(cur, localT, value);
  } else setPath(obj, path, value);
}

/**
 * Move a property as a whole: add `add` to it (or multiply it by `mul`). A static value simply changes; an
 * animated one has EVERY keyframe shifted, so the motion keeps its shape and just moves (drag an animated
 * object in the viewer and its whole animation goes with it).
 */
export function shiftValue(obj: any, path: string, op: { add?: number; mul?: number }) {
  const f = (v: number) => (op.mul !== undefined ? v * op.mul : v + (op.add ?? 0));
  const cur = getPath(obj, path);
  if (isAnimated(cur)) for (const k of cur.keyframes) k.v = Math.round(f(k.v) * 10000) / 10000;
  else if (typeof cur === 'number') setPath(obj, path, Math.round(f(cur) * 10000) / 10000);
  // a recorded motion path for this channel moves along with it
  const ch = path.startsWith('transform.') ? path.slice(10) : '';
  const motion = obj.motion as Record<string, number[] | number>[] | undefined;
  if (ch && Array.isArray(motion))
    for (const m of motion) {
      const arr = m[ch];
      if (Array.isArray(arr)) m[ch] = arr.map((v) => Math.round(f(v) * 10000) / 10000);
    }
}

/** Toggle a keyframe at `localT`: starts animating a static property, or removes an existing key. */
export function toggleKeyframe(obj: any, path: string, localT: number) {
  const cur = getPath(obj, path) as Animatable;
  if (!isAnimated(cur)) {
    setPath(obj, path, { keyframes: [{ t: cleanT(localT), v: cur, ease: { ...DEFAULT_EASE } }] });
    return;
  }
  const i = keyIndexAt(cur, localT);
  if (i >= 0) {
    if (cur.keyframes.length === 1) setPath(obj, path, cur.keyframes[0].v);
    else cur.keyframes.splice(i, 1);
  } else upsertKeyframe(cur, localT, valueAt(cur, localT));
}

/** Turn an animated property back into a static number (its value at `localT`). */
export function clearAnimation(obj: any, path: string, localT: number) {
  const cur = getPath(obj, path);
  if (isAnimated(cur)) setPath(obj, path, valueAt(cur, localT));
}

/** Move all keyframes of an object by `dt` seconds (used when its left edge is trimmed or it is split). */
export function shiftKeyframes(o: TimelineObject, dt: number) {
  if (Math.abs(dt) < 1e-9) return;
  for (const p of animatedPaths(o)) for (const k of (getPath(o, p) as AnimValue).keyframes) k.t += dt;
  // recorded motion paths are timed the same way
  const motion = (o as { motion?: { start: number }[] }).motion;
  if (motion) for (const m of motion) m.start = Math.max(0, Math.round((m.start + dt) * 10000) / 10000);
  // a group's contents are timed from its start too: they stay put on the timeline. Children pushed before the
  // group's start are trimmed (or dropped when nothing of them is left).
  if (o.type === 'group') {
    const kept: TimelineObject[] = [];
    for (const c of o.objects) {
      c.start += dt;
      if (c.start < 0) {
        if (c.start + c.duration <= 1e-6) continue;
        const cut = -c.start;
        if (c.type === 'video' || c.type === 'audio') c.in += cut * c.speed;
        c.duration -= cut;
        c.start = 0;
        shiftKeyframes(c, -cut);
      }
      kept.push(c);
    }
    o.objects = kept;
  }
}
