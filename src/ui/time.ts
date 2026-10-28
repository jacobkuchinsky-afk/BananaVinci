/** HH:MM:SS:FF timecode. */
export function timecode(t: number, fps: number): string {
  const totalFrames = Math.round(Math.max(0, t) * fps);
  const f = totalFrames % Math.round(fps);
  const s = Math.floor(totalFrames / Math.round(fps));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}:${p(f)}`;
}

/** Short ruler label: 0:05, 1:30, 1:02:00 */
export function shortTime(t: number): string {
  const s = Math.round(t * 100) / 100;
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const sec = s - m * 60;
  const secStr = Number.isInteger(sec) ? String(sec).padStart(2, '0') : sec.toFixed(1).padStart(4, '0');
  return h ? `${h}:${String(m % 60).padStart(2, '0')}:${secStr}` : `${m}:${secStr}`;
}

/** Duration label for library items. */
export function durLabel(t?: number): string {
  if (t === undefined) return '';
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
