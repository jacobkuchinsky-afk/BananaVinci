// Pure timeline edit operations. Each one mutates an immer draft of the Project
// (or a plain object in tests) and knows nothing about React or the UI.
import { idBase, uniqueId } from '../format/parse';
import { defaultsFor, hasSourceTime, isGroup, isVisual, trackKindFor, type GroupObject, type Project, type TimelineObject, type Track } from '../format/schema';
import { allIds, walkObjects } from '../format/groups';
import { isAnimated, shiftKeyframes, shiftValue } from '../format/values';

export const EPS = 1e-6;
export const frameDur = (p: Project) => 1 / p.project.fps;
export const end = (o: TimelineObject) => o.start + o.duration;

export function findObject(p: Project, id: string): { track: Track; obj: TimelineObject; ti: number; oi: number } | null {
  for (let ti = 0; ti < p.tracks.length; ti++) {
    const oi = p.tracks[ti].objects.findIndex((o) => o.id === id);
    if (oi >= 0) return { track: p.tracks[ti], obj: p.tracks[ti].objects[oi], ti, oi };
  }
  return null;
}

export const allObjects = (p: Project) => p.tracks.flatMap((track) => track.objects.map((obj) => ({ track, obj })));

export function projectDuration(p: Project): number {
  return Math.max(0, ...allObjects(p).map(({ obj }) => end(obj)));
}

/** Length of the source file in seconds (video/audio), if known. */
export function sourceDuration(p: Project, o: TimelineObject): number | undefined {
  if (!hasSourceTime(o)) return undefined;
  return p.library.find((l) => l.id === o.source)?.duration;
}

export function newObjectId(p: Project, o: { type: string; source?: string }): string {
  return uniqueId(idBase(o), allIds(p));
}

/** Give every object inside a (copied) group a fresh id, so copies never share ids with the original. */
export function freshChildIds(p: Project, o: TimelineObject): void {
  if (!isGroup(o)) return;
  const used = allIds(p);
  o.objects = JSON.parse(JSON.stringify(o.objects));
  walkObjects(o.objects, (c) => (c.id = uniqueId(idBase(c), used)));
}

export function nextTrackId(p: Project, kind: 'video' | 'audio'): string {
  const prefix = kind === 'video' ? 'V' : 'A';
  let n = 1;
  while (p.tracks.some((t) => t.id === `${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

/** Add a track. Video tracks go above the other video tracks; audio tracks go at the end. */
export function addTrack(p: Project, kind: 'video' | 'audio'): Track {
  const track: Track = { id: nextTrackId(p, kind), kind, name: '', hidden: false, muted: false, solo: false, locked: false, objects: [] };
  track.name = (kind === 'video' ? 'Video ' : 'Audio ') + track.id.slice(1);
  if (kind === 'video') {
    let lastVideo = -1;
    p.tracks.forEach((t, i) => t.kind === 'video' && (lastVideo = i));
    p.tracks.splice(lastVideo + 1, 0, track);
  } else p.tracks.push(track);
  return p.tracks.find((t) => t.id === track.id)!;
}

// ---------------------------------------------------------------------------
// Trimming
// ---------------------------------------------------------------------------

/** Earliest start the left edge can be dragged to (limited by 0 and by the source's beginning). */
export function minStart(o: TimelineObject): number {
  return hasSourceTime(o) ? Math.max(0, o.start - o.in / o.speed) : 0;
}

/** Latest end the right edge can be dragged to (limited by the source's length). */
export function maxEnd(p: Project, o: TimelineObject): number {
  const sd = sourceDuration(p, o);
  if (sd === undefined || !hasSourceTime(o)) return Infinity;
  return o.start + (sd - o.in) / o.speed;
}

/** Move the left edge to `newStart`, keeping the right edge fixed. Returns the applied start. */
export function trimStart(p: Project, o: TimelineObject, newStart: number): number {
  const e = end(o);
  const s = Math.min(Math.max(newStart, minStart(o)), e - frameDur(p));
  if (hasSourceTime(o)) o.in = Math.max(0, o.in + (s - o.start) * o.speed);
  shiftKeyframes(o, o.start - s); // keyframes stay where they were on the timeline
  o.start = s;
  o.duration = e - s;
  return s;
}

/** Move the right edge to `newEnd`. Returns the applied end. */
export function trimEnd(p: Project, o: TimelineObject, newEnd: number): number {
  const e = Math.max(Math.min(newEnd, maxEnd(p, o)), o.start + frameDur(p));
  o.duration = e - o.start;
  return e;
}

/** Shift which part of the source is shown without moving the object (slip). */
export function slip(p: Project, o: TimelineObject, newIn: number): void {
  if (!hasSourceTime(o)) return;
  const sd = sourceDuration(p, o);
  const max = sd === undefined ? Infinity : Math.max(0, sd - o.duration * o.speed);
  o.in = Math.min(Math.max(0, newIn), max);
}

// ---------------------------------------------------------------------------
// Splitting
// ---------------------------------------------------------------------------

/** Split an object at timeline time `t`. Returns the new right-hand object, or null if `t` is not inside it. */
export function splitObject(p: Project, id: string, t: number): TimelineObject | null {
  const found = findObject(p, id);
  if (!found) return null;
  const { track, obj, oi } = found;
  const fd = frameDur(p);
  if (t <= obj.start + fd / 2 || t >= end(obj) - fd / 2) return null;
  const right = JSON.parse(JSON.stringify(obj)) as TimelineObject;
  right.id = newObjectId(p, obj);
  freshChildIds(p, right);
  right.start = t;
  right.duration = end(obj) - t;
  if (hasSourceTime(right) && hasSourceTime(obj)) right.in = obj.in + (t - obj.start) * obj.speed;
  shiftKeyframes(right, obj.start - t); // the right half keeps the same animation, re-based to its new start
  obj.duration = t - obj.start;
  if (isGroup(obj)) obj.objects = obj.objects.filter((c) => c.start < obj.duration); // the rest lives on in the right half
  // fades belong to the outer edges
  obj.fadeOut = 0;
  right.fadeIn = 0;
  track.objects.splice(oi + 1, 0, right);
  return right;
}

/** Split every object under the playhead (optionally only `ids`). Returns the ids of the new right halves. */
export function splitAt(p: Project, t: number, ids?: string[]): string[] {
  const targets = allObjects(p)
    .filter(({ track, obj }) => !track.locked && obj.start < t && end(obj) > t && (!ids || ids.includes(obj.id)))
    .map(({ obj }) => obj.id);
  return targets.map((id) => splitObject(p, id, t)?.id).filter((x): x is string => !!x);
}

// ---------------------------------------------------------------------------
// Overwrite / delete / gaps
// ---------------------------------------------------------------------------

/** Make room for [s, e) on a track by trimming, splitting or removing other objects (overwrite edit). */
export function clearRange(p: Project, track: Track, s: number, e: number, except: string[] = []): void {
  for (const o of [...track.objects]) {
    if (except.includes(o.id) || !(o.start < e - EPS && end(o) > s + EPS)) continue;
    if (o.start >= s - EPS && end(o) <= e + EPS) {
      track.objects.splice(track.objects.indexOf(o), 1);
    } else if (o.start < s && end(o) > e) {
      const right = splitObject(p, o.id, e);
      o.duration = s - o.start;
      void right;
    } else if (o.start < s) {
      o.duration = s - o.start;
    } else {
      const e0 = end(o);
      if (hasSourceTime(o)) o.in += (e - o.start) * o.speed;
      shiftKeyframes(o, o.start - e);
      o.start = e;
      o.duration = e0 - e;
    }
  }
}

export function deleteObjects(p: Project, ids: string[], ripple = false): void {
  for (const track of p.tracks) {
    const removed = track.objects.filter((o) => ids.includes(o.id));
    if (!removed.length) continue;
    track.objects = track.objects.filter((o) => !ids.includes(o.id));
    if (!ripple) continue;
    const gaps = mergeIntervals(removed.map((o) => [o.start, end(o)] as [number, number]));
    for (const o of track.objects) {
      let shift = 0;
      for (const [s, e] of gaps) if (e <= o.start + EPS) shift += e - s;
      o.start = Math.max(0, o.start - shift);
    }
  }
}

/** Close the empty gap at time `t` on a track by pulling later objects left. */
export function closeGap(p: Project, trackId: string, t: number): boolean {
  const track = p.tracks.find((tr) => tr.id === trackId);
  if (!track) return false;
  if (track.objects.some((o) => o.start <= t && end(o) > t)) return false;
  const prevEnd = Math.max(0, ...track.objects.filter((o) => end(o) <= t + EPS).map(end));
  const after = track.objects.filter((o) => o.start >= t - EPS);
  if (!after.length) return false;
  const nextStart = Math.min(...after.map((o) => o.start));
  const shift = nextStart - prevEnd;
  if (shift <= EPS) return false;
  for (const o of after) o.start -= shift;
  return true;
}

function mergeIntervals(list: [number, number][]): [number, number][] {
  const sorted = [...list].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1] + EPS) last[1] = Math.max(last[1], iv[1]);
    else out.push([...iv]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Moving / inserting
// ---------------------------------------------------------------------------

/** Move objects by `dt` seconds and `dTrack` track steps (within compatible tracks), then overwrite what's underneath. */
export function moveObjects(p: Project, ids: string[], dt: number, trackMap: Record<string, string> = {}, overwrite = true): void {
  const moving = allObjects(p).filter(({ obj }) => ids.includes(obj.id));
  const minStartAll = Math.min(...moving.map(({ obj }) => obj.start));
  const delta = Math.max(dt, -minStartAll);
  for (const { track, obj } of moving) {
    obj.start = Math.max(0, obj.start + delta);
    const targetId = trackMap[obj.id];
    if (targetId && targetId !== track.id) {
      const target = p.tracks.find((t) => t.id === targetId);
      if (target && target.kind === track.kind && !target.locked) {
        track.objects.splice(track.objects.indexOf(obj), 1);
        target.objects.push(obj);
      }
    }
  }
  if (overwrite) {
    for (const id of ids) {
      const f = findObject(p, id);
      if (f) clearRange(p, f.track, f.obj.start, end(f.obj), ids);
    }
  }
  for (const t of p.tracks) t.objects.sort((a, b) => a.start - b.start);
}

/** Insert an object (assigning a fresh id) onto a track, overwriting what's underneath. */
export function insertObject(p: Project, trackId: string, obj: TimelineObject, overwrite = true): TimelineObject {
  const track = p.tracks.find((t) => t.id === trackId);
  if (!track) throw new Error(`no track ${trackId}`);
  if (track.kind !== trackKindFor(obj.type)) throw new Error(`can't put ${obj.type} on ${track.kind} track`);
  const o = { ...obj, id: newObjectId(p, obj) } as TimelineObject;
  freshChildIds(p, o);
  if (overwrite) clearRange(p, track, o.start, end(o));
  track.objects.push(o);
  track.objects.sort((a, b) => a.start - b.start);
  return o;
}

/** Find (or create) a track of the right kind that is free in [start, end). Prefers `preferredId`. */
export function trackFor(p: Project, type: TimelineObject['type'], preferredId?: string): Track {
  const kind = trackKindFor(type);
  const pref = p.tracks.find((t) => t.id === preferredId);
  if (pref && pref.kind === kind && !pref.locked) return pref;
  const first = p.tracks.find((t) => t.kind === kind && !t.locked);
  return first ?? addTrack(p, kind);
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

/**
 * Pack objects into one group clip (on the topmost video track among them). Children keep their place on the timeline
 * and on screen: their start becomes relative to the group's start, and the group sits at the canvas center.
 * Returns the group, or null when nothing could be grouped.
 */
export function groupObjects(p: Project, ids: string[]): GroupObject | null {
  const found = ids
    .map((id) => findObject(p, id))
    .filter((f): f is NonNullable<ReturnType<typeof findObject>> => !!f && !f.track.locked && f.obj.type !== 'adjustment');
  if (!found.length) return null;
  const s = Math.min(...found.map((f) => f.obj.start));
  const e = Math.max(...found.map((f) => end(f.obj)));
  const videoTracks = found.filter((f) => f.track.kind === 'video').map((f) => p.tracks.indexOf(f.track));
  const track = videoTracks.length ? p.tracks[Math.max(...videoTracks)] : (p.tracks.find((t) => t.kind === 'video' && !t.locked) ?? addTrack(p, 'video'));
  // keep the drawing order: lower tracks first, then file order
  const ordered = [...found].sort((a, b) => p.tracks.indexOf(a.track) - p.tracks.indexOf(b.track) || a.oi - b.oi);
  const children = ordered.map((f) => ({ ...JSON.parse(JSON.stringify(f.obj)), start: f.obj.start - s }) as TimelineObject);
  for (const f of found) f.track.objects = f.track.objects.filter((o) => o.id !== f.obj.id);
  const g = defaultsFor<GroupObject>('group', { start: s, duration: e - s });
  g.objects = children;
  g.id = newObjectId(p, g);
  track.objects.push(g);
  track.objects.sort((a, b) => a.start - b.start);
  return track.objects.find((o) => o.id === g.id) as GroupObject;
}

/** Why a group can't be ungrouped exactly (null = it can). */
export function ungroupProblem(g: GroupObject): string | null {
  const tr = g.transform;
  if (g.motion?.length || [tr.x, tr.y, tr.scale, tr.rotation, tr.opacity].some(isAnimated)) return 'the group itself is animated (remove its keyframes first)';
  if (tr.flipX || tr.flipY) return 'the group is flipped';
  if (tr.rotation !== 0 && g.objects.some((c) => isVisual(c) && (isAnimated(c.transform.x) || isAnimated(c.transform.y) || !!c.motion?.length)))
    return 'the group is rotated and objects inside it move';
  return null;
}

/**
 * Put a group's objects back on the timeline. The group's position, size, rotation, opacity, volume and effects are
 * baked into its children. Pictures go on the group's track, sounds on one audio track. Returns the new ids.
 */
export function ungroupObject(p: Project, id: string): string[] {
  const f = findObject(p, id);
  if (!f || !isGroup(f.obj) || f.track.locked || ungroupProblem(f.obj)) return [];
  const g = f.obj;
  const gx = g.transform.x as number;
  const gy = g.transform.y as number;
  const gs = g.transform.scale as number;
  const gr = g.transform.rotation as number;
  const go = g.transform.opacity as number;
  const rad = (gr * Math.PI) / 180;
  const out: TimelineObject[] = [];
  for (const c0 of g.objects) {
    const c = JSON.parse(JSON.stringify(c0)) as TimelineObject;
    const cEnd = Math.min(end(c), g.duration);
    if (cEnd <= c.start + EPS) continue;
    if (c.start < EPS) c.fadeIn = Math.max(c.fadeIn, g.fadeIn);
    if (cEnd > g.duration - EPS) c.fadeOut = Math.max(c.fadeOut, g.fadeOut);
    c.duration = cEnd - c.start;
    c.start += g.start;
    if (isVisual(c)) {
      const tr = c.transform;
      if (gr && !isAnimated(tr.x) && !isAnimated(tr.y)) {
        const x = tr.x as number;
        const y = tr.y as number;
        tr.x = gx + gs * (x * Math.cos(rad) - y * Math.sin(rad));
        tr.y = gy + gs * (x * Math.sin(rad) + y * Math.cos(rad));
      } else {
        shiftValue(c, 'transform.x', { mul: gs });
        shiftValue(c, 'transform.x', { add: gx });
        shiftValue(c, 'transform.y', { mul: gs });
        shiftValue(c, 'transform.y', { add: gy });
      }
      // (shiftValue moves recorded motion paths along with the values)
      shiftValue(c, 'transform.scale', { mul: gs });
      shiftValue(c, 'transform.rotation', { add: gr });
      shiftValue(c, 'transform.opacity', { mul: go });
      c.effects = [...JSON.parse(JSON.stringify(g.effects)), ...c.effects];
    }
    if ((c.type === 'audio' || c.type === 'video') && g.volume !== 1) shiftValue(c, 'volume', { mul: g.volume });
    out.push(c);
  }
  f.track.objects = f.track.objects.filter((o) => o.id !== g.id);
  const sounds = out.filter((c) => c.type === 'audio');
  let audio: Track | undefined;
  if (sounds.length) {
    const s = Math.min(...sounds.map((c) => c.start));
    const e = Math.max(...sounds.map(end));
    audio = p.tracks.find((t) => t.kind === 'audio' && !t.locked && !t.objects.some((o) => o.start < e - EPS && end(o) > s + EPS)) ?? addTrack(p, 'audio');
  }
  for (const c of out) (c.type === 'audio' ? audio! : f.track).objects.push(c);
  for (const t of p.tracks) t.objects.sort((a, b) => a.start - b.start);
  return out.map((c) => c.id);
}
