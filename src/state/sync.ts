// Talking to the local server: REST for projects/media, a WebSocket for live file changes and export.
import { serializeProject } from '../format/serialize';
import type { LibraryItem } from '../format/schema';
import { applyExternal, editor, loadProject, toast, useEditor } from './store';

export interface ProjectInfo {
  name: string;
  file: string;
  modified: number;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error((await res.text()) || res.statusText);
  return res.json();
}

export const api = {
  list: () => fetch('/api/projects').then((r) => json<ProjectInfo[]>(r)),
  create: (name: string) =>
    fetch('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) }).then((r) => json<{ name: string }>(r)),
  read: (name: string) => fetch(`/api/projects/${encodeURIComponent(name)}`).then((r) => json<{ name: string; file: string; text: string }>(r)),
  write: (name: string, text: string) =>
    fetch(`/api/projects/${encodeURIComponent(name)}`, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: text }).then((r) => json<{ file: string }>(r)),
  saveAs: (from: string, name: string, text: string) =>
    fetch(`/api/projects/${encodeURIComponent(from)}/save-as`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, text }) }).then((r) =>
      json<{ name: string }>(r),
    ),
  upload: async (name: string, files: File[]) => {
    const fd = new FormData();
    for (const f of files) fd.append('files', f, f.name);
    return fetch(`/api/projects/${encodeURIComponent(name)}/media`, { method: 'POST', body: fd }).then((r) =>
      json<{ items: (Omit<LibraryItem, 'id'> & { suggestedId: string })[]; errors?: string[] }>(r),
    );
  },
};

/** URL of a project-relative file (media, thumbnails, renders). */
export const fileUrl = (rel: string) => {
  const name = editor.get().projectName ?? '';
  return `/files/${encodeURIComponent(name)}/${rel.split('/').map(encodeURIComponent).join('/')}`;
};
/** Bumped when the server reports that a media file was replaced on disk (so cached pictures/sounds reload). */
const mediaVersions = new Map<string, number>();
export const bumpMediaVersion = (rel: string) => mediaVersions.set(rel, (mediaVersions.get(rel) ?? 0) + 1);
/** URL of a library item's file. Changes whenever the file is replaced, so the editor never shows a stale copy. */
export const mediaUrl = (item: LibraryItem) => `${fileUrl(item.file)}?v=${mediaVersions.get(item.file) ?? 0}-${item.width ?? ''}x${item.height ?? ''}-${item.duration ?? ''}`;
export const thumbUrl = (item: LibraryItem) =>
  item.kind === 'video' ? `${fileUrl(`media/.thumbs/${item.file.split('/').pop()}.jpg`)}?v=${mediaVersions.get(item.file) ?? 0}` : mediaUrl(item);

export async function openProject(name: string) {
  const p = await api.read(name);
  loadProject(p.name, p.file, p.text);
}

export async function save(): Promise<boolean> {
  const s = editor.get();
  if (!s.projectName) return false;
  const text = serializeProject(s.project);
  const snapshot = s.project;
  editor.set({ saving: true });
  try {
    await api.write(s.projectName, text);
    // only clear dirty if nothing changed while saving
    editor.set({ savedText: text, saving: false, dirty: editor.get().project !== snapshot, diskErrors: null });
    return true;
  } catch (e) {
    editor.set({ saving: false });
    toast(`Save failed: ${e}`, 'error');
    return false;
  }
}

// ----------------------------------------------------------------------------- websocket
type Listener = (msg: any) => void;
const listeners = new Set<Listener>();
let socket: WebSocket | null = null;

export function onMessage(fn: Listener) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getSocket(): WebSocket | null {
  return socket && socket.readyState === WebSocket.OPEN ? socket : null;
}

export function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => (socket = ws);
  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') return;
    const msg = JSON.parse(e.data);
    if (msg.type === 'file-changed' && msg.project === editor.get().projectName) applyExternal(msg.text);
    if (msg.type === 'media-changed' && msg.project === editor.get().projectName) {
      bumpMediaVersion(msg.file);
      editor.set({ libraryVersion: editor.get().libraryVersion + 1, project: { ...editor.get().project } }); // re-render with the new file
    }
    for (const l of listeners) l(msg);
  };
  ws.onclose = () => {
    socket = null;
    setTimeout(connect, 1000);
  };
}

// ----------------------------------------------------------------------------- autosave
let timer: ReturnType<typeof setTimeout> | undefined;
useEditor.subscribe((s, prev) => {
  if (s.project === prev.project && s.dirty === prev.dirty && s.autosave === prev.autosave) return;
  if (!s.autosave || !s.dirty || s.diskErrors || s.conflict || !s.projectName) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    const now = editor.get();
    if (now.autosave && now.dirty && !now.diskErrors && !now.conflict) save();
  }, 900);
});
