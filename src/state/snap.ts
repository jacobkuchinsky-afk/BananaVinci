import { allObjects, end } from './commands';
import { editor } from './store';

const SNAP_PX = 9;

export const frameRound = (t: number) => {
  const fps = editor.get().project.project.fps;
  return Math.max(0, Math.round(t * fps) / fps);
};

function points(exclude: Set<string>): number[] {
  const s = editor.get();
  const pts = [0, s.playhead, ...s.project.markers.map((m) => m.time)];
  if (s.inPoint !== null) pts.push(s.inPoint);
  if (s.outPoint !== null) pts.push(s.outPoint);
  for (const { obj } of allObjects(s.project)) if (!exclude.has(obj.id)) pts.push(obj.start, end(obj));
  return pts;
}

/** Snap a single time. `snapped` is the point it snapped to (for drawing the snap line). */
export function snapTime(t: number, exclude: Set<string> = new Set(), force = false): { t: number; snapped: number | null } {
  const s = editor.get();
  if (!s.snapping && !force) return { t: frameRound(t), snapped: null };
  const thr = SNAP_PX / s.zoom;
  let best: number | null = null;
  for (const p of points(exclude)) if (Math.abs(p - t) <= thr && (best === null || Math.abs(p - t) < Math.abs(best - t))) best = p;
  return best === null ? { t: frameRound(t), snapped: null } : { t: best, snapped: best };
}

/** Snap a block [start, end): returns the delta adjustment so whichever edge is closest snaps. */
export function snapBlock(start: number, endT: number, exclude: Set<string>): { adjust: number; snapped: number | null } {
  const s = editor.get();
  if (!s.snapping) return { adjust: frameRound(start) - start, snapped: null };
  const thr = SNAP_PX / s.zoom;
  let best: { adjust: number; snapped: number } | null = null;
  for (const p of points(exclude)) {
    for (const edge of [start, endT]) {
      const d = p - edge;
      if (Math.abs(d) <= thr && (!best || Math.abs(d) < Math.abs(best.adjust))) best = { adjust: d, snapped: p };
    }
  }
  return best ?? { adjust: frameRound(start) - start, snapped: null };
}
