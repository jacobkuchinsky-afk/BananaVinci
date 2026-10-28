// Groups: one timeline clip holding many objects. Children are timed from the group's start and positioned relative
// to the group's position. These helpers walk nested objects and "flatten" the sounds/videos inside groups so the
// playback and export code can treat them like any other clip.
import { isGroup, type AudioObject, type GroupObject, type Project, type TimelineObject, type Track, type VideoObject } from './schema';

/** Visit every object (depth-first, parents before children). */
export function walkObjects(objs: TimelineObject[], fn: (o: TimelineObject, parent: GroupObject | null) => void, parent: GroupObject | null = null) {
  for (const o of objs) {
    fn(o, parent);
    if (isGroup(o)) walkObjects(o.objects, fn, o);
  }
}

/** Every object id in the project, including objects inside groups. */
export function allIds(p: Project): Set<string> {
  const ids = new Set<string>();
  for (const t of p.tracks) walkObjects(t.objects, (o) => ids.add(o.id));
  return ids;
}

/** Find an object by id anywhere in the project (also inside groups). */
export function findDeep(p: Project, id: string): { obj: TimelineObject; track: Track; parent: GroupObject | null } | null {
  for (const track of p.tracks) {
    let hit: { obj: TimelineObject; parent: GroupObject | null } | null = null;
    walkObjects(track.objects, (o, parent) => {
      if (!hit && o.id === id) hit = { obj: o, parent };
    });
    if (hit) return { ...(hit as { obj: TimelineObject; parent: GroupObject | null }), track };
  }
  return null;
}

export interface PlayedMedia {
  obj: VideoObject | AudioObject; // for group children: a copy with timeline (absolute) start, clipped to the group
  track: Track;
  gain: number; // product of the volumes of the groups it sits in (1 at top level)
  inGroup: boolean;
}

/** Every video/audio clip as it plays on the timeline, including the ones inside (enabled) groups. */
export function playedMedia(p: Project): PlayedMedia[] {
  const out: PlayedMedia[] = [];
  const visit = (objs: TimelineObject[], track: Track, offset: number, limit: number, gain: number, inGroup: boolean) => {
    for (const o of objs) {
      if (o.type === 'video' || o.type === 'audio') {
        if (!inGroup) {
          out.push({ obj: o, track, gain, inGroup });
          continue;
        }
        const end = Math.min(o.start + o.duration, limit);
        if (end <= o.start + 1e-6) continue;
        out.push({ obj: { ...o, start: offset + o.start, duration: end - o.start }, track, gain, inGroup });
      } else if (isGroup(o) && o.enabled) {
        const end = inGroup ? Math.min(o.start + o.duration, limit) : o.start + o.duration;
        if (end <= o.start + 1e-6) continue;
        visit(o.objects, track, offset + o.start, end - o.start, gain * o.volume, true);
      }
    }
  };
  for (const t of p.tracks) visit(t.objects, t, 0, Infinity, 1, false);
  return out;
}

/** Number of objects inside a group, counting nested groups' contents. */
export function countDeep(g: GroupObject): number {
  let n = 0;
  walkObjects(g.objects, () => n++);
  return n;
}
