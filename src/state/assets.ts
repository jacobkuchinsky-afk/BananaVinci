// The shared asset library (assets/assets.yaml) as seen by the editor, and the actions that move media
// between it and the open project.
import { create } from 'zustand';
import type { Asset, LinkedFolder } from '../format/assets';
import type { LibraryItem } from '../format/schema';
import { addLibraryItem } from './actions';
import { commit, editor, toast } from './store';
import { onMessage } from './sync';

export type LibraryAsset = Asset & { missing?: boolean };

interface AssetState {
  assets: LibraryAsset[];
  folders: LinkedFolder[];
  dir: string;
  loaded: boolean;
  error: string | null;
  version: number; // bumps on every reload, so thumbnails refresh after a rename
}

export const useAssets = create<AssetState>(() => ({ assets: [], folders: [], dir: '', loaded: false, error: null, version: 0 }));

async function req<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.json !== undefined ? { 'content-type': 'application/json' } : init?.headers,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  if (!res.ok) throw new Error((await res.text()) || res.statusText);
  return res.json();
}

export async function refreshAssets() {
  try {
    const r = await req<{ assets: LibraryAsset[]; folders: LinkedFolder[]; dir: string }>('/api/assets');
    useAssets.setState((s) => ({ ...r, loaded: true, error: null, version: s.version + 1 }));
  } catch (e) {
    useAssets.setState({ loaded: true, error: String((e as Error).message) });
  }
}

onMessage((msg) => {
  if (msg.type === 'assets-changed') refreshAssets();
});

export const assetFileUrl = (a: Asset, thumb = false) => `/asset-files/${encodeURIComponent(a.name)}?v=${useAssets.getState().version}${thumb ? '&thumb' : ''}`;

interface AddResult {
  added: Asset[];
  existing: Asset[];
  skipped: string[];
  folders: string[];
}

function reportAdd(r: AddResult) {
  const parts = [];
  if (r.added.length) parts.push(`Added ${r.added.map((a) => a.name).join(', ')}`);
  if (r.existing.length) parts.push(`${r.existing.length} already in the library`);
  if (r.skipped.length) parts.push(`${r.skipped.length} unsupported file(s) skipped`);
  if (r.folders.length) parts.unshift(`Linked ${r.folders.join(', ')}`);
  toast(parts.join(' · ') || 'Nothing to add', r.added.length || r.folders.length ? 'success' : 'info');
  refreshAssets();
  return r;
}

/** Files dropped or picked in the browser: copied into assets/. */
export async function uploadAssets(files: File[]) {
  if (!files.length) return;
  toast(`Adding ${files.length} file${files.length > 1 ? 's' : ''} to the asset library…`);
  const fd = new FormData();
  for (const f of files) fd.append('files', f, f.name);
  try {
    return reportAdd(await req<AddResult>('/api/assets/upload', { method: 'POST', body: fd }));
  } catch (e) {
    toast(`Couldn't add assets: ${(e as Error).message}`, 'error');
  }
}

/** A file or folder path on this computer. `link` keeps it in place (and watches a folder for new files). */
export async function addAssetPaths(paths: string[], opts: { link?: boolean; tags?: string[] } = {}) {
  try {
    return reportAdd(await req<AddResult>('/api/assets/add-paths', { method: 'POST', json: { paths, ...opts } }));
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

export async function unlinkFolder(path: string) {
  try {
    const r = await req<{ removed: number }>('/api/assets/unlink', { method: 'POST', json: { path } });
    toast(`Unlinked folder (${r.removed} asset${r.removed === 1 ? '' : 's'} removed from the library, files untouched)`, 'success');
    refreshAssets();
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

export async function updateAsset(name: string, patch: { name?: string; tags?: string[] | string; description?: string }): Promise<Asset | null> {
  try {
    const r = await req<{ asset: Asset }>(`/api/assets/${encodeURIComponent(name)}`, { method: 'PATCH', json: patch });
    await refreshAssets();
    return r.asset;
  } catch (e) {
    toast((e as Error).message, 'error');
    return null;
  }
}

export async function removeAsset(name: string) {
  if (!confirm(`Remove "${name}" from the asset library?\n\nProjects that already use it keep their own copy.`)) return;
  try {
    await req(`/api/assets/${encodeURIComponent(name)}`, { method: 'DELETE' });
    refreshAssets();
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

/**
 * Make sure an asset is in the project's Media Pool (copying it into media/ the first time) and return its
 * library id. An asset that's already in the project is reused.
 */
export async function ensureAssetInProject(name: string): Promise<string | null> {
  const s = editor.get();
  if (!s.projectName) return null;
  const existing = s.project.library.find((l) => l.asset === name);
  if (existing) return existing.id;
  try {
    const { item } = await req<{ item: Omit<LibraryItem, 'id'> & { suggestedId: string } }>(`/api/projects/${encodeURIComponent(s.projectName)}/use-asset`, {
      method: 'POST',
      json: { asset: name },
    });
    const { suggestedId, ...rest } = item;
    let id = suggestedId;
    commit((d) => {
      const used = new Set(d.library.map((l) => l.id));
      let n = 2;
      while (used.has(id)) id = `${suggestedId}-${n++}`;
      d.library.push({ id, ...rest } as LibraryItem);
    });
    editor.set({ libraryVersion: editor.get().libraryVersion + 1 });
    return id;
  } catch (e) {
    toast(`Couldn't use asset: ${(e as Error).message}`, 'error');
    return null;
  }
}

/** Put an asset on the timeline (at the playhead unless a time/track is given). */
export async function placeAsset(name: string, at?: number, trackId?: string) {
  const id = await ensureAssetInProject(name);
  if (id) addLibraryItem(id, at, trackId);
}

/** Save one of the project's media files into the asset library, and remember the link on the project item. */
export async function saveLibraryItemAsAsset(libId: string) {
  const s = editor.get();
  const item = s.project.library.find((l) => l.id === libId);
  if (!item || !s.projectName) return;
  try {
    const { asset } = await req<{ asset: Asset }>(`/api/projects/${encodeURIComponent(s.projectName)}/save-asset`, {
      method: 'POST',
      json: { file: item.file, name: item.id },
    });
    commit((d) => {
      const it = d.library.find((l) => l.id === libId);
      if (it) it.asset = asset.name;
    });
    toast(`Saved to the asset library as "${asset.name}"`, 'success');
    refreshAssets();
  } catch (e) {
    toast(`Couldn't save to the asset library: ${(e as Error).message}`, 'error');
  }
}

// ----------------------------------------------------------------------------- asset requests
import type { AssetRequest } from '../format/assets';

export const useRequests = create<{ requests: AssetRequest[]; loaded: boolean; error: string | null; busy: Record<string, boolean> }>(() => ({
  requests: [],
  loaded: false,
  error: null,
  busy: {},
}));

export async function refreshRequests() {
  try {
    const r = await req<{ requests: AssetRequest[] }>('/api/asset-requests');
    useRequests.setState({ requests: r.requests, loaded: true, error: null });
  } catch (e) {
    useRequests.setState({ loaded: true, error: String((e as Error).message) });
  }
}

onMessage((msg) => {
  if (msg.type === 'asset-requests-changed') {
    const before = useRequests.getState().requests.filter((r) => r.status === 'open').length;
    refreshRequests().then(() => {
      const after = useRequests.getState().requests.filter((r) => r.status === 'open').length;
      if (after > before) toast(`${after - before} new asset request${after - before > 1 ? 's' : ''}: see Assets → Requests`, 'info');
    });
  }
});

const setBusy = (name: string, v: boolean) => useRequests.setState((s) => ({ busy: { ...s.busy, [name]: v } }));

/** Fill a request with a dropped / pasted file, or with a URL (an image dragged from another tab). */
export async function fulfilRequest(name: string, input: File | string) {
  const r = useRequests.getState().requests.find((x) => x.name === name);
  setBusy(name, true);
  try {
    let res: { request: AssetRequest; asset: Asset };
    if (typeof input === 'string') res = await req(`/api/asset-requests/${encodeURIComponent(name)}/fulfil`, { method: 'POST', json: { url: input } });
    else {
      const fd = new FormData();
      // pasted screenshots arrive as "image.png": give them the request's name
      const file = input.name && input.name !== 'image.png' ? input : new File([input], `${name}.${(input.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: input.type });
      fd.append('file', file, file.name);
      res = await req(`/api/asset-requests/${encodeURIComponent(name)}/fulfil`, { method: 'POST', body: fd });
    }
    toast(`"${res.asset.name}" added to the asset library${r?.removeBackground ? ' (background removed)' : ''}`, 'success');
    await Promise.all([refreshRequests(), refreshAssets()]);
  } catch (e) {
    toast(`Couldn't fill "${name}": ${(e as Error).message}`, 'error');
  } finally {
    setBusy(name, false);
  }
}

export async function setRequestOption(name: string, patch: Partial<Pick<AssetRequest, 'removeBackground'>>) {
  useRequests.setState((s) => ({ requests: s.requests.map((r) => (r.name === name ? { ...r, ...patch } : r)) }));
  try {
    await req(`/api/asset-requests/${encodeURIComponent(name)}`, { method: 'PATCH', json: patch });
  } catch (e) {
    toast(String((e as Error).message), 'error');
    refreshRequests();
  }
}

export async function deleteRequest(name: string) {
  try {
    await req(`/api/asset-requests/${encodeURIComponent(name)}`, { method: 'DELETE' });
    refreshRequests();
  } catch (e) {
    toast(String((e as Error).message), 'error');
  }
}
