// The shared asset library on disk:
//   assets/assets.yaml              the catalog (names, tags, descriptions)
//   assets/images|audio|video/      files copied into the library
//   linked folders                  folders anywhere on disk; their media files are added automatically and stay put
// Projects never point into this folder. Using an asset copies it into <project>/media/, tagged with `asset: <name>`.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import chokidar, { type FSWatcher } from 'chokidar';
import YAML, { isMap } from 'yaml';
import { ROOT, hash } from './projects';
import { SUPPORTED, describeMedia, kindOf, probe, safeFileName } from './media';
import { AssetRequestSchema, assetName, cleanTags, emptyCatalog, parseCatalog, parseRequests, serializeCatalog, serializeRequests, uniqueAssetName, type Asset, type AssetCatalog, type AssetRequest } from '../src/format/assets';
import { PYTHON } from './stt';
import { unresolvedAssets, type FormatIssue } from '../src/format/parse';
import type { LibraryItem } from '../src/format/schema';

const run = promisify(execFile);

export const ASSETS_DIR = path.resolve(process.env.BANANA_ASSETS_DIR ?? path.join(ROOT, 'assets'));
export const CATALOG_FILE = path.join(ASSETS_DIR, 'assets.yaml');
const KIND_DIR: Record<Asset['kind'], string> = { image: 'images', video: 'video', audio: 'audio' };
const IGNORED_FILES = new Set(['desktop.ini', 'thumbs.db', '.ds_store']);

const posix = (p: string) => p.replace(/\\/g, '/');
const samePath = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const isInside = (file: string, dir: string) => {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

export class CatalogError extends Error {
  constructor(public errors: FormatIssue[]) {
    super(`${posix(path.relative(ROOT, CATALOG_FILE))} has errors:\n` + errors.map((e) => `  line ${e.line ?? '?'}  ${e.path || '(root)'}: ${e.message}`).join('\n'));
  }
}

// ----------------------------------------------------------------------------- catalog file
export function loadCatalog(): AssetCatalog {
  if (!fs.existsSync(CATALOG_FILE)) return emptyCatalog();
  const r = parseCatalog(fs.readFileSync(CATALOG_FILE, 'utf8'));
  if (!r.ok) throw new CatalogError(r.errors);
  return r.catalog;
}

/** Called after the catalog changed, whether through the API, the CLI or a hand edit. */
export const catalogChangeHooks = new Set<() => void>();
let lastWritten = '';

function saveCatalog(c: AssetCatalog) {
  const text = serializeCatalog(c);
  if (fs.existsSync(CATALOG_FILE) && fs.readFileSync(CATALOG_FILE, 'utf8') === text) return;
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
  lastWritten = hash(text);
  fs.writeFileSync(CATALOG_FILE, text, 'utf8');
  catalogChangeHooks.forEach((h) => h());
}

/** Load → change → save, one at a time, so overlapping requests can't overwrite each other. */
let queue: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: (c: AssetCatalog) => Promise<T> | T): Promise<T> {
  const next = queue.then(async () => {
    const c = loadCatalog();
    const out = await fn(c);
    saveCatalog(c);
    return out;
  });
  queue = next.catch(() => {});
  return next;
}

// ----------------------------------------------------------------------------- lookups
export const assetPath = (a: Asset) => (path.isAbsolute(a.file) ? a.file : path.join(ASSETS_DIR, a.file));
export const assetThumbPath = (a: Asset) => path.join(ASSETS_DIR, '.thumbs', `${a.name}.jpg`);
const isLinked = (a: Asset) => path.isAbsolute(a.file);

export function findAsset(c: AssetCatalog, name: string): Asset | undefined {
  return c.assets.find((a) => a.name === name) ?? c.assets.find((a) => a.name === assetName(name));
}

function noSuchAsset(name: string): Error {
  return new Error(`no asset named "${name}" (list them with: npm run asset -- list)`);
}

/** The catalog plus a `missing` flag for files that are no longer on disk. */
export function listAssets() {
  const c = loadCatalog();
  return { folders: c.folders, assets: c.assets.map((a) => ({ ...a, missing: !fs.existsSync(assetPath(a)) })), dir: posix(ASSETS_DIR) };
}

// ----------------------------------------------------------------------------- adding
export interface AddOptions {
  name?: string; // only used when adding a single file
  tags?: string[];
  description?: string;
  link?: boolean; // keep files where they are (folders are remembered and watched for new files)
  move?: boolean; // move instead of copy (used for browser uploads, which arrive as temp files)
}

export interface AddResult {
  added: Asset[];
  existing: Asset[]; // already in the library (same file, or identical contents)
  skipped: string[]; // unsupported or unreadable files
  folders: string[]; // folders that were linked
}

/** Every supported media file in a folder, recursively (hidden files and folders are skipped). */
export function mediaFilesIn(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.') || IGNORED_FILES.has(e.name.toLowerCase())) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (kindOf(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

function fileHash(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    fs.createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

async function duplicateOf(c: AssetCatalog, file: string, link: boolean): Promise<Asset | undefined> {
  const linkedMatch = c.assets.find((a) => samePath(assetPath(a), file));
  if (linkedMatch || link) return linkedMatch;
  const size = fs.statSync(file).size;
  const sameSize = c.assets.filter((a) => fs.existsSync(assetPath(a)) && fs.statSync(assetPath(a)).size === size);
  if (!sameSize.length) return undefined;
  const h = await fileHash(file);
  for (const a of sameSize) if ((await fileHash(assetPath(a))) === h) return a;
  return undefined;
}

async function makeThumb(a: Asset) {
  if (a.kind !== 'video') return;
  const out = assetThumbPath(a);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  try {
    await run('ffmpeg', ['-y', '-v', 'error', '-ss', String(Math.min(1, (a.duration ?? 0) / 3)), '-i', assetPath(a), '-frames:v', '1', '-vf', 'scale=320:-2', out]);
  } catch {
    /* thumbnail is optional */
  }
}

async function addFile(c: AssetCatalog, src: string, opts: AddOptions, r: AddResult) {
  const file = path.resolve(src);
  const kind = kindOf(file);
  if (!kind) return void r.skipped.push(file);
  const dup = await duplicateOf(c, file, !!opts.link);
  if (dup) {
    if (opts.move) fs.rmSync(file, { force: true });
    return void r.existing.push(dup);
  }
  const info = kind === 'image' && file.toLowerCase().endsWith('.svg') ? {} : await probe(file);
  const realKind: Asset['kind'] = kind === 'video' && info.hasVideo === false ? 'audio' : kind;
  const name = uniqueAssetName(
    assetName(opts.name ?? path.basename(file), realKind),
    c.assets.map((a) => a.name),
  );
  let rel: string;
  if (opts.link) rel = posix(file);
  else {
    const dir = path.join(ASSETS_DIR, KIND_DIR[realKind]);
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, safeFileName(dir, name + path.extname(file).toLowerCase()));
    if (opts.move) fs.renameSync(file, dest);
    else fs.copyFileSync(file, dest);
    rel = posix(path.relative(ASSETS_DIR, dest));
  }
  const asset: Asset = { name, kind: realKind, file: rel, description: opts.description ?? '', tags: cleanTags(opts.tags ?? []) };
  if (info.width) asset.width = info.width;
  if (info.height) asset.height = info.height;
  if (realKind !== 'image' && info.duration) asset.duration = info.duration;
  if (realKind === 'video') asset.hasAudio = !!info.hasAudio;
  c.assets.push(asset);
  await makeThumb(asset);
  r.added.push(asset);
}

/**
 * Add files and/or folders to the library. Folders are searched recursively.
 * With `link`, nothing is copied and each folder is remembered, so files dropped into it later show up too.
 */
export function addAssets(paths: string[], opts: AddOptions = {}): Promise<AddResult> {
  return mutate(async (c) => {
    const r: AddResult = { added: [], existing: [], skipped: [], folders: [] };
    for (const raw of paths) {
      const p = path.resolve(raw.trim().replace(/^"(.*)"$/, '$1'));
      if (!fs.existsSync(p)) throw new Error(`not found: ${p}`);
      if (fs.statSync(p).isDirectory()) {
        if (opts.link) {
          if (isInside(p, ASSETS_DIR) || samePath(p, ASSETS_DIR)) throw new Error('that folder is already inside the asset library');
          let folder = c.folders.find((f) => samePath(f.path, p));
          if (!folder) c.folders.push((folder = { path: posix(p), tags: cleanTags(opts.tags ?? []), exclude: [] }));
          r.folders.push(folder.path);
          for (const f of mediaFilesIn(p)) await addFile(c, f, { ...opts, name: undefined, tags: [...folder.tags, ...(opts.tags ?? [])] }, r);
        } else {
          for (const f of mediaFilesIn(p)) await addFile(c, f, { ...opts, name: undefined }, r);
        }
      } else {
        await addFile(c, p, paths.length === 1 ? opts : { ...opts, name: undefined }, r);
      }
    }
    return r;
  });
}

/** Stop watching a linked folder and drop the assets that came from it (the files themselves are untouched). */
export function unlinkFolder(folder: string): Promise<number> {
  return mutate((c) => {
    const before = c.assets.length;
    c.folders = c.folders.filter((f) => !samePath(f.path, folder));
    c.assets = c.assets.filter((a) => !(isLinked(a) && isInside(a.file, folder)));
    return before - c.assets.length;
  });
}

/** Pick up files that appeared in linked folders since the last scan. */
export function scanLinkedFolders(): Promise<Asset[]> {
  return mutate(async (c) => {
    const r: AddResult = { added: [], existing: [], skipped: [], folders: [] };
    for (const folder of c.folders) {
      if (!fs.existsSync(folder.path)) continue;
      const excluded = new Set(folder.exclude.map((e) => path.resolve(folder.path, e).toLowerCase()));
      for (const f of mediaFilesIn(folder.path)) {
        if (excluded.has(path.resolve(f).toLowerCase()) || c.assets.some((a) => samePath(assetPath(a), f))) continue;
        await addFile(c, f, { link: true, tags: folder.tags }, r);
      }
    }
    return r.added;
  });
}

// ----------------------------------------------------------------------------- editing
export function updateAsset(name: string, patch: { name?: string; tags?: string[] | string; description?: string }): Promise<Asset> {
  return mutate((c) => {
    const a = findAsset(c, name);
    if (!a) throw noSuchAsset(name);
    if (patch.name !== undefined && assetName(patch.name) !== a.name) {
      const next = assetName(patch.name);
      if (c.assets.some((x) => x.name === next)) throw new Error(`there is already an asset named "${next}"`);
      const oldThumb = assetThumbPath(a);
      if (!isLinked(a)) {
        // keep copied files named after their asset
        const src = assetPath(a);
        const dir = path.dirname(src);
        const dest = path.join(dir, safeFileName(dir, next + path.extname(src)));
        if (fs.existsSync(src)) fs.renameSync(src, dest);
        a.file = posix(path.relative(ASSETS_DIR, dest));
      }
      a.name = next;
      if (fs.existsSync(oldThumb)) fs.renameSync(oldThumb, assetThumbPath(a));
    }
    if (patch.tags !== undefined) a.tags = cleanTags(patch.tags);
    if (patch.description !== undefined) a.description = patch.description.trim();
    return a;
  });
}

/** Remove an asset. Copied files go to assets/.trash/; linked files stay put and are excluded from future scans. */
export function removeAsset(name: string): Promise<Asset> {
  return mutate((c) => {
    const a = findAsset(c, name);
    if (!a) throw noSuchAsset(name);
    c.assets = c.assets.filter((x) => x !== a);
    if (isLinked(a)) {
      const folder = c.folders.find((f) => isInside(a.file, f.path));
      if (folder) folder.exclude.push(posix(path.relative(folder.path, a.file)));
    } else if (fs.existsSync(assetPath(a))) {
      const trash = path.join(ASSETS_DIR, '.trash');
      fs.mkdirSync(trash, { recursive: true });
      fs.renameSync(assetPath(a), path.join(trash, safeFileName(trash, path.basename(a.file))));
    }
    fs.rmSync(assetThumbPath(a), { force: true });
    return a;
  });
}

// ----------------------------------------------------------------------------- using assets in projects
export type ProjectMediaItem = Omit<LibraryItem, 'id'> & { suggestedId: string };

/** Copy an asset into <projectDir>/media/ and describe it as a project library entry (`asset:` records where it came from). */
export async function copyAssetIntoProject(projectDir: string, name: string): Promise<ProjectMediaItem> {
  const a = findAsset(loadCatalog(), name);
  if (!a) throw noSuchAsset(name);
  const src = assetPath(a);
  if (!fs.existsSync(src)) throw new Error(`the file for asset "${a.name}" is missing: ${src}`);
  const mediaDir = path.join(projectDir, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  const fileName = safeFileName(mediaDir, a.name + path.extname(src).toLowerCase());
  fs.copyFileSync(src, path.join(mediaDir, fileName));
  const item = await describeMedia(projectDir, fileName);
  return { ...item, suggestedId: a.name, asset: a.name };
}

/**
 * Fill in library entries written as `{ id: boom, asset: explosion-sfx }`: copy each asset into the project and
 * add its file, kind and size. Edits the YAML in place (comments survive). Returns what it did.
 */
export async function resolveAssetRefs(bananaFile: string): Promise<{ resolved: { id: string; asset: string; file: string }[]; errors: string[] }> {
  const text = fs.readFileSync(bananaFile, 'utf8');
  const out = { resolved: [] as { id: string; asset: string; file: string }[], errors: [] as string[] };
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch {
    return out; // syntax errors are reported by the normal parser
  }
  const pending = unresolvedAssets(raw);
  if (!pending.length) return out;
  const doc = YAML.parseDocument(text);
  const lib = (raw as { library: (Partial<LibraryItem> | null)[] }).library;
  const usedIds = new Set(lib.map((l) => l?.id).filter(Boolean) as string[]);
  for (const p of pending) {
    const node = doc.getIn(['library', p.index], true);
    if (!isMap(node)) continue;
    try {
      // the same asset already copied in under another id: share its file instead of copying it again
      const twin = lib.find((l) => l?.file && l.asset && assetName(l.asset) === assetName(p.asset));
      const item: ProjectMediaItem = twin
        ? { ...(twin as LibraryItem), suggestedId: twin.asset! }
        : await copyAssetIntoProject(path.dirname(bananaFile), p.asset);
      let id = p.id;
      if (!id) {
        id = uniqueAssetName(item.suggestedId, usedIds);
        usedIds.add(id);
        node.items.unshift(doc.createPair('id', id));
      }
      node.set('asset', item.asset);
      for (const k of ['file', 'kind', 'width', 'height', 'duration', 'hasAudio'] as const) if (item[k] !== undefined && !node.has(k)) node.set(k, item[k]);
      out.resolved.push({ id, asset: item.asset!, file: item.file });
    } catch (e) {
      out.errors.push(`library[${p.index}]: ${(e as Error).message}`);
    }
  }
  if (out.resolved.length) fs.writeFileSync(bananaFile, doc.toString({ lineWidth: 0 }), 'utf8');
  return out;
}

/** Add a project's media file to the asset library (copied, so the project and the library stay independent). */
export async function saveProjectMediaAsAsset(projectDir: string, relFile: string, opts: Omit<AddOptions, 'link' | 'move'>): Promise<Asset> {
  const abs = path.resolve(projectDir, relFile);
  if (!isInside(abs, projectDir) || !fs.existsSync(abs)) throw new Error(`not a file in this project: ${relFile}`);
  const r = await addAssets([abs], opts);
  return r.added[0] ?? r.existing[0];
}

// ----------------------------------------------------------------------------- watching
/** Watch the catalog for hand edits and linked folders for new files. `onChange` runs after every catalog change. */
export function watchAssets(onChange: () => void) {
  catalogChangeHooks.add(onChange);
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
  chokidar
    .watch(CATALOG_FILE, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 40 } })
    .on('all', () => {
      const text = fs.existsSync(CATALOG_FILE) ? fs.readFileSync(CATALOG_FILE, 'utf8') : '';
      if (hash(text) === lastWritten) return;
      lastWritten = hash(text);
      console.log('[assets] assets.yaml changed on disk');
      onChange();
      rewatchFolders();
    });

  let folderWatcher: FSWatcher | null = null;
  let watched = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const rescan = () => {
    clearTimeout(timer);
    timer = setTimeout(() => scanLinkedFolders().then((added) => added.length && console.log(`[assets] added ${added.map((a) => a.name).join(', ')}`)).catch(() => {}), 400);
  };
  const rewatchFolders = () => {
    let folders: string[] = [];
    try {
      folders = loadCatalog().folders.map((f) => f.path).filter((p) => fs.existsSync(p));
    } catch {
      return;
    }
    if (folders.join('\n') === watched) return;
    watched = folders.join('\n');
    folderWatcher?.close();
    folderWatcher = folders.length ? chokidar.watch(folders, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 } }).on('add', rescan).on('ready', rescan) : null;
  };
  catalogChangeHooks.add(rewatchFolders);
  rewatchFolders();
  rescan(); // catch files added while the editor wasn't running
}

// ----------------------------------------------------------------------------- asset requests (assets/requests.yaml)
export const REQUESTS_FILE = path.join(ASSETS_DIR, 'requests.yaml');
export const requestChangeHooks = new Set<() => void>();
let lastRequestsWritten = '';

export function loadRequests(): AssetRequest[] {
  if (!fs.existsSync(REQUESTS_FILE)) return [];
  const r = parseRequests(fs.readFileSync(REQUESTS_FILE, 'utf8'));
  if (!r.ok) throw new Error(`${posix(path.relative(ROOT, REQUESTS_FILE))} has errors:\n` + r.errors.map((e) => `  line ${e.line ?? '?'}  ${e.path || '(root)'}: ${e.message}`).join('\n'));
  return r.requests;
}

let requestQueue: Promise<unknown> = Promise.resolve();
function mutateRequests<T>(fn: (list: AssetRequest[]) => Promise<T> | T): Promise<T> {
  const next = requestQueue.then(async () => {
    const list = loadRequests();
    const out = await fn(list);
    const text = serializeRequests(list);
    if (!fs.existsSync(REQUESTS_FILE) || fs.readFileSync(REQUESTS_FILE, 'utf8') !== text) {
      fs.mkdirSync(ASSETS_DIR, { recursive: true });
      lastRequestsWritten = hash(text);
      fs.writeFileSync(REQUESTS_FILE, text, 'utf8');
      requestChangeHooks.forEach((h) => h());
    }
    return out;
  });
  requestQueue = next.catch(() => {});
  return next;
}

export type RequestInput = { name: string } & Partial<Omit<AssetRequest, 'name' | 'tags'>> & { tags?: string[] | string };

/** Add a request (or update an open one with the same name). */
export function addRequest(input: RequestInput): Promise<AssetRequest> {
  return mutateRequests((list) => {
    const name = assetName(input.name);
    const existing = list.find((r) => r.name === name);
    if (existing && existing.status === 'done') throw new Error(`"${name}" was already fulfilled (asset "${existing.asset}"). Remove the request first to ask again.`);
    if (!existing && loadCatalog().assets.some((a) => a.name === name)) throw new Error(`the asset library already has "${name}", so use it directly`);
    const r: AssetRequest = AssetRequestSchema.parse({
      ...(existing ?? { requested: new Date().toISOString() }),
      ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)),
      name,
      tags: cleanTags(input.tags ?? existing?.tags ?? []),
      status: 'open',
    });
    if (existing) Object.assign(existing, r);
    else list.push(r);
    return r;
  });
}

export function updateRequest(name: string, patch: Partial<Pick<AssetRequest, 'removeBackground' | 'description' | 'note' | 'kind'>>): Promise<AssetRequest> {
  return mutateRequests((list) => {
    const r = list.find((x) => x.name === name);
    if (!r) throw new Error(`no request named "${name}"`);
    Object.assign(r, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
    return r;
  });
}

export function removeRequest(name: string): Promise<number> {
  return mutateRequests((list) => {
    const i = list.findIndex((r) => r.name === name);
    if (i < 0) throw new Error(`no request named "${name}"`);
    list.splice(i, 1);
    return list.length;
  });
}

async function cutOut(src: string): Promise<string> {
  const out = src.replace(/\.[^.\\/]+$/, '') + '.cutout.png';
  try {
    await run(PYTHON, [path.join(ROOT, 'scripts', 'remove_bg.py'), src, out], { maxBuffer: 1 << 20 });
  } catch (e) {
    throw new Error(`background removal failed (needs Python with rembg: ${PYTHON} -m pip install rembg): ${(e as Error).message.split('\n').slice(-3).join(' ')}`);
  }
  return out;
}

/** A file arrived for a request: (optionally cut it out,) add it to the library under the requested name, mark it done. */
export async function fulfilRequest(name: string, file: string, opts: { move?: boolean } = {}): Promise<{ request: AssetRequest; asset: Asset }> {
  const req = loadRequests().find((r) => r.name === name);
  if (!req) throw new Error(`no request named "${name}"`);
  const kind = kindOf(file);
  if (!kind) throw new Error(`that file type is not supported (${path.extname(file) || 'no extension'})`);
  const article = (k: string) => (k === 'image' ? 'an image' : k === 'audio' ? 'an audio file' : 'a video file');
  if (kind !== req.kind && !(req.kind === 'audio' && kind === 'video')) throw new Error(`"${name}" asks for ${article(req.kind)}, but this is ${article(kind)}`);
  let src = file;
  let move = !!opts.move;
  const cuttable = kind === 'image' && !/\.(svg|gif)$/i.test(file);
  if (req.removeBackground && cuttable) {
    src = await cutOut(file);
    if (opts.move) fs.rmSync(file, { force: true });
    move = true;
  }
  const r = await addAssets([src], { move, name: req.name, tags: req.tags, description: req.description || req.note || '' });
  const asset = r.added[0] ?? r.existing[0];
  if (!asset) throw new Error('the file could not be added');
  const request = await mutateRequests((list) => {
    const x = list.find((q) => q.name === name)!;
    Object.assign(x, { status: 'done', asset: asset.name, fulfilled: new Date().toISOString() });
    return x;
  });
  return { request, asset };
}

const EXT_BY_TYPE: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
  'image/avif': '.avif',
  'image/bmp': '.bmp',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/ogg': '.ogg',
  'audio/mp4': '.m4a',
  'audio/flac': '.flac',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
};

/** Fulfil a request from a URL (an image dragged out of another browser tab) or a data: URL. */
export async function fulfilRequestFromUrl(name: string, url: string): Promise<{ request: AssetRequest; asset: Asset }> {
  const dir = path.join(ASSETS_DIR, '.incoming', crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  try {
    let buf: Buffer;
    let type: string;
    const data = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(url);
    if (data) {
      type = data[1];
      buf = data[2] ? Buffer.from(data[3], 'base64') : Buffer.from(decodeURIComponent(data[3]));
    } else {
      if (!/^https?:\/\//i.test(url)) throw new Error('not a web link');
      const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (BananaVinci asset request)' }, redirect: 'follow' });
      if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
      type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      if (type === 'text/html') throw new Error('that link is a web page, not a file. Drag the image itself, or right-click it and choose "Copy image", then paste.');
      buf = Buffer.from(await res.arrayBuffer());
    }
    const urlExt = data ? '' : path.extname(new URL(url).pathname).toLowerCase();
    const ext = EXT_BY_TYPE[type] ?? (urlExt && kindOf(`f${urlExt}`) ? urlExt : '');
    if (!ext) throw new Error(`unsupported file type (${type || 'unknown'})`);
    const file = path.join(dir, `${name}${ext}`);
    fs.writeFileSync(file, buf);
    return await fulfilRequest(name, file, { move: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Watch requests.yaml for hand / AI edits. */
export function watchRequests(onChange: () => void) {
  requestChangeHooks.add(onChange);
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
  chokidar
    .watch(REQUESTS_FILE, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 40 } })
    .on('all', () => {
      const text = fs.existsSync(REQUESTS_FILE) ? fs.readFileSync(REQUESTS_FILE, 'utf8') : '';
      if (hash(text) === lastRequestsWritten) return;
      lastRequestsWritten = hash(text);
      console.log('[assets] requests.yaml changed on disk');
      onChange();
    });
}

export { SUPPORTED };
