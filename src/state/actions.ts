// High-level editor actions shared by menus, keyboard shortcuts, toolbar and context menus.
import { current, isDraft, type Draft } from 'immer';
import { defaultsFor, type LibraryItem, type Project, type TimelineObject, type Track, type ObjectType, trackKindFor, MARKER_COLORS } from '../format/schema';
import { serializeProject } from '../format/serialize';
import {
  addTrack,
  allObjects,
  closeGap,
  deleteObjects,
  end,
  findObject,
  groupObjects,
  insertObject,
  projectDuration,
  splitAt,
  ungroupObject,
  ungroupProblem,
} from './commands';
import { walkObjects } from '../format/groups';
import { commit, editor, select, setPlayhead, toast } from './store';
import { api, save } from './sync';

export type GeneratorKind = 'text' | 'shape' | 'ellipse' | 'solid' | 'adjustment';

const plain = <T>(v: T): T => JSON.parse(JSON.stringify(isDraft(v) ? current(v as any) : v));

/** A track of `kind` that is empty over [s, e). Searches top-down for video (above existing content) and top-down for audio. */
export function freeTrack(p: Draft<Project> | Project, kind: 'video' | 'audio', s: number, e: number, preferTop = false): Track {
  const tracks = p.tracks.filter((t) => t.kind === kind && !t.locked);
  const ordered = preferTop ? [...tracks].reverse() : tracks;
  const isFree = (t: Track) => !t.objects.some((o) => o.start < e - 1e-6 && end(o) > s + 1e-6);
  if (preferTop) {
    const top = ordered[0];
    if (top && isFree(top)) return top as Track;
  } else {
    const found = ordered.find(isFree);
    if (found) return found as Track;
  }
  return addTrack(p as Project, kind);
}

export function generatorObject(kind: GeneratorKind, start: number, project: Project): TimelineObject {
  const base = { start, duration: 4 };
  switch (kind) {
    case 'text':
      return defaultsFor('text', { ...base, text: 'Your Title' });
    case 'shape':
      return defaultsFor('shape', { ...base, shape: 'rect', cornerRadius: 16 });
    case 'ellipse':
      return defaultsFor('shape', { ...base, shape: 'ellipse', width: 300, height: 300, fill: '#facc15' });
    case 'solid':
      return defaultsFor('shape', { ...base, shape: 'solid', fill: '#1c1c1f', width: project.project.width, height: project.project.height });
    case 'adjustment':
      return defaultsFor('adjustment', { ...base, effects: [{ type: 'contrast', amount: 1.15 }, { type: 'saturation', amount: 1.3 }] });
  }
}

export function libraryObject(item: LibraryItem, start: number, asAudio = false): TimelineObject {
  if (item.kind === 'image') return defaultsFor('image', { source: item.id, start, duration: 5 });
  const duration = item.duration ?? 5;
  if (item.kind === 'audio' || asAudio) return defaultsFor('audio', { source: item.id, start, duration });
  return defaultsFor('video', { source: item.id, start, duration, muted: item.hasAudio === false });
}

/** Place an object; returns its id. If `trackId` is incompatible/missing, a free track is chosen (or created). */
export function placeObject(obj: TimelineObject, trackId?: string | 'new'): string | null {
  let id: string | null = null;
  commit((d) => {
    const kind = trackKindFor(obj.type);
    let track = trackId && trackId !== 'new' ? d.tracks.find((t) => t.id === trackId) : undefined;
    if (track && (track.kind !== kind || track.locked)) track = undefined;
    if (!track) track = trackId === 'new' ? addTrack(d as Project, kind) : freeTrack(d, kind, obj.start, obj.start + obj.duration, obj.type !== 'video' && obj.type !== 'image' && kind === 'video');
    id = insertObject(d as Project, track.id, obj).id;
  });
  if (id) select([id]);
  return id;
}

export function addGenerator(kind: GeneratorKind, at?: number, trackId?: string) {
  const s = editor.get();
  placeObject(generatorObject(kind, at ?? s.playhead, s.project), trackId);
}

export function addLibraryItem(libId: string, at?: number, trackId?: string) {
  const s = editor.get();
  const item = s.project.library.find((l) => l.id === libId);
  if (!item) return;
  const target = trackId && trackId !== 'new' ? s.project.tracks.find((t) => t.id === trackId) : undefined;
  const asAudio = item.kind === 'video' && target?.kind === 'audio';
  placeObject(libraryObject(item, at ?? s.playhead, asAudio), trackId);
}

// ----------------------------------------------------------------------------- import
export async function importFiles(files: File[], place?: { at: number; trackId?: string }) {
  const s = editor.get();
  if (!s.projectName) return;
  if (!files.length) return;
  toast(`Importing ${files.length} file${files.length > 1 ? 's' : ''}…`);
  try {
    const { items, errors = [] } = await api.upload(s.projectName, files);
    for (const e of errors) toast(e, 'error');
    if (!items.length) return errors.length ? undefined : toast('No supported files (images, video, audio)', 'error');
    const added: string[] = [];
    commit((d) => {
      const used = new Set(d.library.map((l) => l.id));
      for (const { suggestedId, ...rest } of items) {
        let id = suggestedId;
        let n = 2;
        while (used.has(id)) id = `${suggestedId}-${n++}`;
        used.add(id);
        d.library.push({ id, ...rest } as LibraryItem);
        added.push(id);
      }
    });
    editor.set({ libraryVersion: editor.get().libraryVersion + 1 });
    toast(`Imported ${added.join(', ')}`, 'success');
    if (place) {
      let t = place.at;
      for (const id of added) {
        addLibraryItem(id, t, place.trackId);
        const o = findObject(editor.get().project, editor.get().selection[0] ?? '')?.obj;
        if (o) t = end(o);
      }
    }
  } catch (e) {
    toast(`Import failed: ${e}`, 'error');
  }
}

export function removeLibraryItem(id: string) {
  const p = editor.get().project;
  let uses = 0;
  for (const t of p.tracks) walkObjects(t.objects, (o) => 'source' in o && o.source === id && uses++);
  if (uses && !confirm(`"${id}" is used by ${uses} object(s) on the timeline. Remove it and those objects?`)) return;
  const keep = (objs: TimelineObject[]): TimelineObject[] =>
    objs.filter((o) => !('source' in o) || o.source !== id).map((o) => (o.type === 'group' ? { ...o, objects: keep(o.objects) } : o));
  commit((d) => {
    d.library = d.library.filter((l) => l.id !== id);
    for (const t of d.tracks) t.objects = keep(t.objects as TimelineObject[]);
  });
  editor.set({ selectedLibrary: null });
}

// ----------------------------------------------------------------------------- edit
export function splitAtPlayhead() {
  const s = editor.get();
  const ids = s.selection.length ? s.selection : undefined;
  let made: string[] = [];
  commit((d) => {
    made = splitAt(d as Project, s.playhead, ids);
  });
  if (!made.length) toast('Nothing under the playhead to cut');
}

export function deleteSelected(ripple = false) {
  const s = editor.get();
  if (!s.selection.length) return;
  const locked = new Set(s.project.tracks.filter((t) => t.locked).flatMap((t) => t.objects.map((o) => o.id)));
  const ids = s.selection.filter((id) => !locked.has(id));
  commit((d) => deleteObjects(d as Project, ids, ripple));
  select([]);
}

let clipboard: { objects: { obj: TimelineObject; trackId: string }[]; origin: number } | null = null;

export function copySelected() {
  const s = editor.get();
  const items = s.selection.map((id) => findObject(s.project, id)).filter(Boolean) as NonNullable<ReturnType<typeof findObject>>[];
  if (!items.length) return false;
  clipboard = { objects: items.map((f) => ({ obj: plain(f.obj), trackId: f.track.id })), origin: Math.min(...items.map((f) => f.obj.start)) };
  return true;
}

export function cutSelected() {
  if (copySelected()) deleteSelected(false);
}

export function paste(at?: number) {
  if (!clipboard) return;
  const s = editor.get();
  const t0 = at ?? s.playhead;
  const ids: string[] = [];
  const clip = clipboard;
  commit((d) => {
    for (const { obj, trackId } of clip.objects) {
      const o = { ...plain(obj), start: t0 + (obj.start - clip.origin) } as TimelineObject;
      let track = d.tracks.find((t) => t.id === trackId && !t.locked);
      if (!track || track.kind !== trackKindFor(o.type)) track = freeTrack(d, trackKindFor(o.type), o.start, o.start + o.duration);
      ids.push(insertObject(d as Project, track.id, o).id);
    }
  });
  select(ids);
}

export function duplicateSelected() {
  const s = editor.get();
  if (!copySelected() || !clipboard) return;
  const endT = Math.max(...s.selection.map((id) => findObject(s.project, id)).filter(Boolean).map((f) => end(f!.obj)));
  // put copies directly after the selection on free tracks
  const clip = clipboard;
  const ids: string[] = [];
  commit((d) => {
    for (const { obj, trackId } of clip.objects) {
      const o = { ...plain(obj), start: endT + (obj.start - clip.origin) } as TimelineObject;
      const track = d.tracks.find((t) => t.id === trackId)!;
      const free = !track.objects.some((x) => x.start < o.start + o.duration - 1e-6 && end(x) > o.start + 1e-6);
      const target = free && !track.locked ? track : freeTrack(d, track.kind, o.start, o.start + o.duration);
      ids.push(insertObject(d as Project, target.id, o, false).id);
    }
  });
  select(ids);
}

/** Pack the selected objects into one group clip (Ctrl+G). */
export function groupSelected() {
  const s = editor.get();
  if (s.selection.length < 2) return toast('Select two or more objects to group');
  let id: string | null = null;
  commit((d) => {
    id = groupObjects(d as Project, s.selection)?.id ?? null;
  });
  if (id) select([id]);
}

/** Put the objects of the selected group(s) back on the timeline (Ctrl+Shift+G). */
export function ungroupSelected() {
  const s = editor.get();
  const groups = s.selection.map((id) => findObject(s.project, id)?.obj).filter((o) => o?.type === 'group');
  if (!groups.length) return toast('Select a group to ungroup');
  for (const g of groups) {
    const why = g && g.type === 'group' ? ungroupProblem(g) : null;
    if (why) return toast(`Can't ungroup ${g!.id}: ${why}`, 'error');
  }
  const ids: string[] = [];
  commit((d) => {
    for (const g of groups) ids.push(...ungroupObject(d as Project, g!.id));
  });
  select(ids);
}

export function selectAll() {
  select(allObjects(editor.get().project).map(({ obj }) => obj.id));
}

export function nudge(frames: number) {
  const s = editor.get();
  if (!s.selection.length) return;
  const dt = frames / s.project.project.fps;
  commit(
    (d) => {
      for (const id of s.selection) {
        const f = findObject(d as Project, id);
        if (f && !f.track.locked) f.obj.start = Math.max(0, f.obj.start + dt);
      }
    },
    { coalesce: 'nudge' },
  );
}

export function closeGapAt(trackId: string, t: number) {
  let ok = false;
  commit((d) => {
    ok = closeGap(d as Project, trackId, t);
  });
  if (!ok) toast('No gap there');
}

export function toggleEnabled() {
  const s = editor.get();
  commit((d) => {
    for (const id of s.selection) {
      const f = findObject(d as Project, id);
      if (f) f.obj.enabled = !f.obj.enabled;
    }
  });
}

// ----------------------------------------------------------------------------- tracks / markers / range
export function newTrack(kind: 'video' | 'audio') {
  commit((d) => {
    addTrack(d as Project, kind);
  });
}

export function removeTrack(id: string) {
  const t = editor.get().project.tracks.find((x) => x.id === id);
  if (!t) return;
  if (t.objects.length && !confirm(`Delete track ${t.id} and its ${t.objects.length} object(s)?`)) return;
  commit((d) => {
    d.tracks = d.tracks.filter((x) => x.id !== id);
  });
}

export function addMarker(at?: number) {
  const s = editor.get();
  const t = at ?? s.playhead;
  if (s.project.markers.some((m) => Math.abs(m.time - t) < 1e-3)) return;
  commit((d) => {
    d.markers.push({ time: t, name: `Marker ${d.markers.length + 1}`, color: MARKER_COLORS[0] });
    d.markers.sort((a, b) => a.time - b.time);
  });
}

export function jumpMarker(dir: 1 | -1) {
  const s = editor.get();
  const points = [0, ...s.project.markers.map((m) => m.time), ...allObjects(s.project).flatMap(({ obj }) => [obj.start, end(obj)])].sort((a, b) => a - b);
  const eps = 0.5 / s.project.project.fps;
  const target = dir > 0 ? points.find((p) => p > s.playhead + eps) : [...points].reverse().find((p) => p < s.playhead - eps);
  if (target !== undefined) setPlayhead(target);
}

export function setIn() {
  const s = editor.get();
  editor.set({ inPoint: s.playhead, outPoint: s.outPoint !== null && s.outPoint <= s.playhead ? null : s.outPoint });
}
export function setOut() {
  const s = editor.get();
  editor.set({ outPoint: s.playhead, inPoint: s.inPoint !== null && s.inPoint >= s.playhead ? null : s.inPoint });
}
export function clearInOut() {
  editor.set({ inPoint: null, outPoint: null });
}

// ----------------------------------------------------------------------------- view
let timelineWidth = 1000;
export const setTimelineWidth = (w: number) => (timelineWidth = w);
export function zoomToFit() {
  const d = Math.max(projectDuration(editor.get().project), 10);
  editor.set({ zoom: Math.max(2, Math.min(600, (timelineWidth - 40) / d)) });
}
export function zoomBy(factor: number) {
  editor.set({ zoom: Math.max(2, Math.min(600, editor.get().zoom * factor)) });
}

// ----------------------------------------------------------------------------- project
export async function saveNow() {
  if (await save()) toast('Saved', 'success');
}

export function projectText(): string {
  return serializeProject(editor.get().project);
}

export const generatorTypes: { kind: GeneratorKind; label: string; type: ObjectType }[] = [
  { kind: 'text', label: 'Text', type: 'text' },
  { kind: 'shape', label: 'Rectangle', type: 'shape' },
  { kind: 'ellipse', label: 'Ellipse', type: 'shape' },
  { kind: 'solid', label: 'Solid Color', type: 'shape' },
  { kind: 'adjustment', label: 'Adjustment', type: 'adjustment' },
];
