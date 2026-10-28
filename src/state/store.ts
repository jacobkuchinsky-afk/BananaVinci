import { create } from 'zustand';
import { produce, freeze, type Draft } from 'immer';
import { emptyProject, type Project, type TimelineObject } from '../format/schema';
import { parseProject, type FormatIssue } from '../format/parse';
import { serializeProject } from '../format/serialize';
import { findObject, projectDuration } from './commands';

export type Tool = 'select' | 'blade' | 'slip';

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error' | 'success';
}

export interface ExportProgress {
  frame: number;
  total: number;
  status: 'preparing' | 'rendering' | 'encoding' | 'done' | 'error' | 'cancelled';
  message?: string;
  /** Frames rendered per second so far (for the time-left estimate). */
  speed?: number;
  file?: string;
}

interface EditorState {
  projectName: string | null;
  projectFile: string;
  project: Project;
  savedText: string;
  dirty: boolean;
  saving: boolean;
  past: Project[];
  future: Project[];
  coalesce: { key: string; time: number } | null;

  selection: string[];
  selectedLibrary: string | null;
  selectedTrack: string | null;

  playhead: number;
  playing: boolean;
  rate: number;
  loop: boolean;
  inPoint: number | null;
  outPoint: number | null;

  tool: Tool;
  snapping: boolean;
  zoom: number; // timeline pixels per second
  autosave: boolean;

  diskErrors: FormatIssue[] | null; // the file on disk currently fails to parse
  conflict: Project | null; // external change arrived while we had unsaved edits
  toasts: Toast[];
  dialog: null | 'export' | 'projects' | 'shortcuts' | 'settings' | 'saveAs' | 'new';
  exportProgress: ExportProgress | null;
  libraryVersion: number;

  bottomTab: 'timeline' | 'graph' | 'transcript';
  /** Graph editor: which property curve is shown, and which keyframes (by object-local time) are selected. */
  graphPath: string;
  graphKeys: number[];

  recording: boolean;
  recordTarget: string | null;
  recordSpeed: number; // playback rate while recording (0.5 = slow motion, easier to perform)
  recordSmoothing: 'exact' | 'light' | 'smooth';
}

const HISTORY_LIMIT = 200;
let toastId = 1;

const initial: EditorState = {
  projectName: null,
  projectFile: '',
  project: freeze(emptyProject(), true),
  savedText: '',
  dirty: false,
  saving: false,
  past: [],
  future: [],
  coalesce: null,
  selection: [],
  selectedLibrary: null,
  selectedTrack: null,
  playhead: 0,
  playing: false,
  rate: 1,
  loop: false,
  inPoint: null,
  outPoint: null,
  tool: 'select',
  snapping: true,
  zoom: 60,
  autosave: (() => {
    try {
      return localStorage.getItem('bv.autosave') !== 'off';
    } catch {
      return true;
    }
  })(),
  diskErrors: null,
  conflict: null,
  toasts: [],
  dialog: null,
  exportProgress: null,
  libraryVersion: 0,
  bottomTab: 'timeline',
  graphPath: 'transform.x',
  graphKeys: [],
  recording: false,
  recordTarget: null,
  recordSpeed: 1,
  recordSmoothing: 'exact',
};

export const useEditor = create<EditorState>()(() => initial);
const set = useEditor.setState;
const get = useEditor.getState;

// ----------------------------------------------------------------------------- project / history

export function loadProject(name: string, file: string, text: string): boolean {
  const r = parseProject(text);
  if (!r.ok) {
    set({ projectName: name, projectFile: file, diskErrors: r.errors, project: freeze(emptyProject(name), true), savedText: text, dirty: false, past: [], future: [] });
    toast(`${file} has errors — fix the file and it will reload`, 'error');
    return false;
  }
  set({
    projectName: name,
    projectFile: file,
    project: freeze(r.project, true),
    savedText: serializeProject(r.project),
    dirty: false,
    past: [],
    future: [],
    selection: [],
    selectedLibrary: null,
    playhead: 0,
    playing: false,
    inPoint: null,
    outPoint: null,
    diskErrors: null,
    conflict: null,
  });
  for (const w of r.warnings) toast(`line ${w.line}: ${w.message}`, 'info');
  try {
    localStorage.setItem('bv.lastProject', name);
  } catch {}
  return true;
}

/** Apply an edit as one undo step. Edits with the same `coalesce` key within 700ms merge into one step. */
export function commit(recipe: (d: Draft<Project>) => void, opts: { coalesce?: string } = {}) {
  const s = get();
  const next = produce(s.project, recipe);
  if (next === s.project) return;
  const now = performance.now();
  const merge = opts.coalesce && s.coalesce && s.coalesce.key === opts.coalesce && now - s.coalesce.time < 700;
  set({
    project: next,
    past: merge ? s.past : [...s.past.slice(-HISTORY_LIMIT + 1), s.project],
    future: [],
    dirty: true,
    coalesce: opts.coalesce ? { key: opts.coalesce, time: now } : null,
  });
  pruneSelection();
}

/** Live preview during a drag: replace the project without touching history. */
export function setLive(p: Project) {
  set({ project: p });
}

/** Finish a drag: record `before` as the undo step. */
export function endLive(before: Project) {
  const s = get();
  if (s.project === before) return;
  set({ past: [...s.past.slice(-HISTORY_LIMIT + 1), before], future: [], dirty: true, coalesce: null });
  pruneSelection();
}

export function undo() {
  const s = get();
  const prev = s.past[s.past.length - 1];
  if (!prev) return;
  set({ project: prev, past: s.past.slice(0, -1), future: [s.project, ...s.future], dirty: true, coalesce: null });
  pruneSelection();
}

export function redo() {
  const s = get();
  const next = s.future[0];
  if (!next) return;
  set({ project: next, future: s.future.slice(1), past: [...s.past, s.project], dirty: true, coalesce: null });
  pruneSelection();
}

function pruneSelection() {
  const s = get();
  const sel = s.selection.filter((id) => findObject(s.project, id));
  if (sel.length !== s.selection.length) set({ selection: sel });
}

/** The file changed on disk (an AI or another editor saved it). */
export function applyExternal(text: string) {
  const r = parseProject(text);
  if (!r.ok) {
    set({ diskErrors: r.errors });
    return;
  }
  const s = get();
  set({ diskErrors: null });
  if (serializeProject(r.project) === serializeProject(s.project)) {
    set({ savedText: text, dirty: false });
    return;
  }
  if (s.dirty) {
    set({ conflict: freeze(r.project, true) });
    return;
  }
  replaceFromDisk(r.project, text);
  toast('Reloaded — the project file changed on disk', 'info');
  for (const w of r.warnings) toast(`line ${w.line}: ${w.message}`, 'info');
}

export function replaceFromDisk(p: Project, text?: string) {
  const s = get();
  set({
    project: freeze(p, true),
    past: [...s.past.slice(-HISTORY_LIMIT + 1), s.project],
    future: [],
    savedText: text ?? serializeProject(p),
    dirty: false,
    conflict: null,
    coalesce: null,
  });
  pruneSelection();
}

// ----------------------------------------------------------------------------- selection / ui

export function select(ids: string[], mode: 'replace' | 'toggle' | 'add' = 'replace') {
  const s = get();
  let sel: string[];
  if (mode === 'replace') sel = ids;
  else if (mode === 'add') sel = [...new Set([...s.selection, ...ids])];
  else {
    sel = [...s.selection];
    for (const id of ids) sel = sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id];
  }
  set({ selection: sel, selectedLibrary: sel.length ? null : s.selectedLibrary });
}

export function selectedObjects(): TimelineObject[] {
  const s = get();
  return s.selection.map((id) => findObject(s.project, id)?.obj).filter((o): o is TimelineObject => !!o);
}

export function setPlayhead(t: number) {
  const s = get();
  const fps = s.project.project.fps;
  const max = Math.max(projectDuration(s.project), 0) + 3600;
  set({ playhead: Math.min(Math.max(0, Math.round(t * fps) / fps), max) });
}

export function toast(text: string, kind: Toast['kind'] = 'info') {
  const id = toastId++;
  set({ toasts: [...get().toasts.slice(-4), { id, text, kind }] });
  setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), kind === 'error' ? 7000 : 3500);
}

export const editor = { get, set };
