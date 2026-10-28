// The shared asset library: assets/assets.yaml plus the files next to it.
// Projects copy an asset into their own media/ folder when they use it, so a project never breaks if the
// library changes later. The catalog gives every asset a stable, readable name that people and AI can ask for.
import YAML, { LineCounter, isNode } from 'yaml';
import { z } from 'zod';
import { formatPath, type FormatIssue } from './parse';

export const CATALOG_VERSION = 1;

/** Lowercase words joined by dashes: `explosion-sfx`, `red-arrow`. */
export const ASSET_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const AssetSchema = z
  .object({
    name: z.string().regex(ASSET_NAME_RE, 'asset names are lowercase words joined by dashes, like "explosion-sfx"'),
    kind: z.enum(['image', 'video', 'audio']),
    file: z.string().min(1), // relative to assets/ (copied in), or an absolute path (inside a linked folder)
    description: z.string().default(''),
    tags: z.array(z.string().min(1)).default([]),
    width: z.number().optional(),
    height: z.number().optional(),
    duration: z.number().optional(), // seconds (video/audio)
    hasAudio: z.boolean().optional(), // video files with a sound track
  })
  .strict();
export type Asset = z.output<typeof AssetSchema>;

/** A folder outside assets/ whose media files are added automatically (files stay where they are). */
export const LinkedFolderSchema = z.union([
  z.string().min(1).transform((path) => ({ path, tags: [] as string[], exclude: [] as string[] })),
  z
    .object({
      path: z.string().min(1),
      tags: z.array(z.string().min(1)).default([]), // given to every asset found in this folder
      exclude: z.array(z.string()).default([]), // file names (relative to the folder) removed from the library
    })
    .strict(),
]);
export type LinkedFolder = { path: string; tags: string[]; exclude: string[] };

export const AssetCatalogSchema = z
  .object({
    format: z.literal(CATALOG_VERSION).default(CATALOG_VERSION),
    folders: z.array(LinkedFolderSchema).default([]),
    assets: z.array(AssetSchema).default([]),
  })
  .strict();
export type AssetCatalog = { format: number; folders: LinkedFolder[]; assets: Asset[] };

export const emptyCatalog = (): AssetCatalog => ({ format: CATALOG_VERSION, folders: [], assets: [] });

export type CatalogParseResult = { ok: true; catalog: AssetCatalog } | { ok: false; errors: FormatIssue[] };

export function parseCatalog(text: string): CatalogParseResult {
  const lineCounter = new LineCounter();
  const doc = YAML.parseDocument(text, { lineCounter, uniqueKeys: true });
  if (doc.errors.length) return { ok: false, errors: doc.errors.map((e) => ({ message: e.message.split('\n')[0], path: '', line: e.linePos?.[0]?.line })) };
  const lineOf = (p: (string | number)[]) => {
    for (let n = p.length; n >= 0; n--) {
      const node = doc.getIn(p.slice(0, n), true);
      if (isNode(node) && node.range) return lineCounter.linePos(node.range[0]).line;
    }
    return undefined;
  };
  const res = AssetCatalogSchema.safeParse(doc.toJS() ?? {});
  if (!res.success) {
    return {
      ok: false,
      errors: res.error.issues.map((i) => {
        const at = i.code === 'unrecognized_keys' ? [...i.path, i.keys[0]] : i.path;
        const message = i.code === 'unrecognized_keys' ? `unknown property ${i.keys.map((k) => `"${k}"`).join(', ')}` : i.message;
        return { message, path: formatPath(i.path), line: lineOf(at) };
      }),
    };
  }
  const catalog = res.data as AssetCatalog;
  const errors: FormatIssue[] = [];
  const seen = new Set<string>();
  catalog.assets.forEach((a, i) => {
    if (seen.has(a.name)) errors.push({ message: `duplicate asset name "${a.name}"`, path: `assets[${i}].name`, line: lineOf(['assets', i, 'name']) });
    seen.add(a.name);
  });
  return errors.length ? { ok: false, errors } : { ok: true, catalog };
}

const CATALOG_HEADER = ` BananaVinci asset library: reusable media shared by every project.
 Safe to edit by hand or by AI. The editor picks up changes automatically.

 Use an asset in a project by its name. In a .banana file, add a library entry with just an id and the asset:
     library:
       - { id: boom, asset: explosion-sfx }
 and the file is copied into the project's media/ folder (by the running editor, or by npm run check).

 name:   unique, lowercase-with-dashes. This is what you refer to.
 file:   relative to this folder, or an absolute path for files inside a linked folder.
 folders: linked folders. Media files in them are added automatically and stay where they are.
 Full reference: docs/BANANA_FORMAT.md (section "Asset library")`;

export function serializeCatalog(c: AssetCatalog): string {
  const plain = {
    format: c.format,
    folders: c.folders.map((f) => (f.tags.length || f.exclude.length ? { path: f.path, tags: f.tags, exclude: f.exclude } : f.path)),
    assets: [...c.assets]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((a) => {
        const out: Record<string, unknown> = { name: a.name, kind: a.kind, file: a.file, description: a.description, tags: a.tags };
        for (const k of ['width', 'height', 'duration', 'hasAudio'] as const) if (a[k] !== undefined) out[k] = a[k];
        return out;
      }),
  };
  const doc = new YAML.Document(plain);
  doc.commentBefore = CATALOG_HEADER;
  YAML.visit(doc, {
    Pair(_, pair) {
      const key = YAML.isScalar(pair.key) ? String(pair.key.value) : '';
      if ((key === 'tags' || key === 'exclude') && YAML.isSeq(pair.value)) pair.value.flow = true;
    },
    Seq(_, seq) {
      // a blank line between assets keeps the file easy to scan
      seq.items.forEach((item, i) => {
        if (i > 0 && YAML.isMap(item) && item.items.some((p) => YAML.isScalar(p.key) && p.key.value === 'name')) item.spaceBefore = true;
      });
    },
  });
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false, defaultStringType: 'PLAIN', defaultKeyType: 'PLAIN' });
}

/** Turn any text (a file name, a title) into a valid asset name. */
export function assetName(text: string, fallback = 'asset'): string {
  return (
    text
      .toLowerCase()
      .replace(/\.[a-z0-9]{2,5}$/, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/, '') || fallback
  );
}

export function uniqueAssetName(base: string, used: Iterable<string>): string {
  const taken = new Set(used);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** Normalise a free-form tag list ("SFX, boom" → ["sfx", "boom"]). */
export function cleanTags(tags: string | string[]): string[] {
  const list = Array.isArray(tags) ? tags : tags.split(/[,\n]/);
  return [...new Set(list.map((t) => t.trim().toLowerCase()).filter(Boolean))];
}

/**
 * Search assets. Every word must match the name, a tag, the description, the kind or the file name.
 * Results are ranked: exact name, then name/tag hits, then description hits.
 */
export function searchAssets<T extends Asset>(assets: T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...assets].sort((a, b) => a.name.localeCompare(b.name));
  const scored: { a: T; score: number }[] = [];
  for (const a of assets) {
    let score = 0;
    let all = true;
    for (const w of words) {
      const s =
        a.name === w ? 100 : a.tags.includes(w) ? 40 : a.name.includes(w) ? 30 : a.kind === w ? 20 : a.tags.some((t) => t.includes(w)) ? 15 : a.description.toLowerCase().includes(w) ? 10 : a.file.toLowerCase().includes(w) ? 5 : 0;
      if (!s) {
        all = false;
        break;
      }
      score += s;
    }
    if (all) scored.push({ a, score });
  }
  return scored.sort((x, y) => y.score - x.score || x.a.name.localeCompare(y.a.name)).map((s) => s.a);
}

// ----------------------------------------------------------------------------- asset requests
// assets/requests.yaml: media someone (usually an AI editing a project) wants but the library doesn't have yet.
// The editor shows each open request as a drop box; dropping or pasting a file adds it to the library under
// the requested name and marks the request done.

export const AssetRequestSchema = z
  .object({
    name: z.string().regex(ASSET_NAME_RE, 'request names are lowercase words joined by dashes, like "cartoon-baby"'),
    kind: z.enum(['image', 'video', 'audio']).default('image'),
    description: z.string().default(''), // what it should look / sound like
    tags: z.array(z.string().min(1)).default([]),
    project: z.string().optional(), // project that wants it
    note: z.string().optional(), // how it will be used ("pops in when I say 'babies' at 0.9 s")
    links: z.array(z.string()).default([]), // suggested sources
    removeBackground: z.boolean().default(false), // cut the subject out (transparent background) when the file arrives
    status: z.enum(['open', 'done']).default('open'),
    asset: z.string().optional(), // the asset that fulfilled it (usually the same as name)
    requested: z.string().optional(), // ISO date
    fulfilled: z.string().optional(), // ISO date
  })
  .strict();
export type AssetRequest = z.output<typeof AssetRequestSchema>;

const RequestsFileSchema = z.object({ requests: z.array(AssetRequestSchema).default([]) }).strict();

export function parseRequests(text: string): { ok: true; requests: AssetRequest[] } | { ok: false; errors: FormatIssue[] } {
  const lineCounter = new LineCounter();
  const doc = YAML.parseDocument(text, { lineCounter, uniqueKeys: true });
  if (doc.errors.length) return { ok: false, errors: doc.errors.map((e) => ({ message: e.message.split('\n')[0], path: '', line: e.linePos?.[0]?.line })) };
  const res = RequestsFileSchema.safeParse(doc.toJS() ?? {});
  if (!res.success) {
    return {
      ok: false,
      errors: res.error.issues.map((i) => {
        const node = doc.getIn(i.path, true);
        const line = isNode(node) && node.range ? lineCounter.linePos(node.range[0]).line : undefined;
        return { message: i.code === 'unrecognized_keys' ? `unknown property ${i.keys.map((k) => `"${k}"`).join(', ')}` : i.message, path: formatPath(i.path), line };
      }),
    };
  }
  const seen = new Set<string>();
  for (const r of res.data.requests) {
    if (seen.has(r.name)) return { ok: false, errors: [{ message: `duplicate request "${r.name}"`, path: 'requests' }] };
    seen.add(r.name);
  }
  return { ok: true, requests: res.data.requests };
}

const REQUESTS_HEADER = ` Asset requests: media that is wanted but not in the asset library yet.
 An AI (or you) adds a request here or with:  npm run asset -- request <name> --description "…"
 The editor shows every open request as a drop box (Assets tab → Requests). Drop or paste a file there and it
 is added to the library under that name and marked done; then use it as  - { id: x, asset: <name> }.
 Safe to edit by hand. Fields: name, kind (image|audio|video), description, tags, project, note, links,
 removeBackground (true = cut the subject out to a transparent PNG when the image arrives), status.`;

export function serializeRequests(requests: AssetRequest[]): string {
  const order = (r: AssetRequest) => (r.status === 'open' ? 0 : 1);
  const plain = {
    requests: [...requests]
      .sort((a, b) => order(a) - order(b) || (a.requested ?? '').localeCompare(b.requested ?? ''))
      .map((r) => {
        const out: Record<string, unknown> = { name: r.name, kind: r.kind, description: r.description, tags: r.tags };
        for (const k of ['project', 'note'] as const) if (r[k]) out[k] = r[k];
        if (r.links.length) out.links = r.links;
        out.removeBackground = r.removeBackground;
        out.status = r.status;
        for (const k of ['asset', 'requested', 'fulfilled'] as const) if (r[k]) out[k] = r[k];
        return out;
      }),
  };
  const doc = new YAML.Document(plain);
  doc.commentBefore = REQUESTS_HEADER;
  YAML.visit(doc, {
    Pair(_, pair) {
      const key = YAML.isScalar(pair.key) ? String(pair.key.value) : '';
      if (key === 'tags' && YAML.isSeq(pair.value)) pair.value.flow = true;
    },
    Seq(_, seq) {
      seq.items.forEach((item, i) => {
        if (i > 0 && YAML.isMap(item) && item.items.some((p) => YAML.isScalar(p.key) && p.key.value === 'status')) item.spaceBefore = true;
      });
    },
  });
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false, defaultStringType: 'PLAIN', defaultKeyType: 'PLAIN' });
}
