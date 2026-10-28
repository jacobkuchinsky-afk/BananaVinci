// Project folders on disk: projects/<name>/<name>.banana (+ media/, renders/)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import chokidar from 'chokidar';
import { serializeProject } from '../src/format/serialize';
import { emptyProject } from '../src/format/schema';

export const ROOT = process.cwd();
export const PROJECTS_DIR = path.join(ROOT, 'projects');
fs.mkdirSync(PROJECTS_DIR, { recursive: true });

export const hash = (s: string) => crypto.createHash('sha1').update(s).digest('hex');

export function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'project';
}

export function projectDir(name: string): string {
  const dir = path.join(PROJECTS_DIR, slugify(name));
  if (!dir.startsWith(PROJECTS_DIR)) throw new Error('bad project name');
  return dir;
}

/** The .banana file in a project folder (prefers <name>.banana). */
export function projectFile(name: string): string | null {
  const dir = projectDir(name);
  if (!fs.existsSync(dir)) return null;
  const preferred = path.join(dir, `${slugify(name)}.banana`);
  if (fs.existsSync(preferred)) return preferred;
  const any = fs.readdirSync(dir).find((f) => f.endsWith('.banana'));
  return any ? path.join(dir, any) : null;
}

export function listProjects() {
  return fs
    .readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const file = projectFile(d.name);
      if (!file) return null;
      return { name: d.name, file: path.relative(ROOT, file).replace(/\\/g, '/'), modified: fs.statSync(file).mtimeMs };
    })
    .filter(Boolean)
    .sort((a, b) => b!.modified - a!.modified);
}

/** Listeners called after a project file was written by the editor or changed on disk. */
export const projectChangeHooks = new Set<(name: string, text: string) => void>();

/** Hash of the last content *we* wrote per file, so our own saves don't echo back as "external" changes. */
const lastWritten = new Map<string, string>();

export function readProject(name: string) {
  const file = projectFile(name);
  if (!file) return null;
  const text = fs.readFileSync(file, 'utf8');
  return { name: slugify(name), file: path.relative(ROOT, file).replace(/\\/g, '/'), text };
}

export function writeProject(name: string, text: string) {
  const dir = projectDir(name);
  fs.mkdirSync(path.join(dir, 'media'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'renders'), { recursive: true });
  const file = projectFile(name) ?? path.join(dir, `${slugify(name)}.banana`);
  lastWritten.set(path.resolve(file), hash(text));
  fs.writeFileSync(file, text, 'utf8');
  projectChangeHooks.forEach((h) => h(slugify(name), text));
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

export function createProject(displayName: string) {
  let slug = slugify(displayName);
  let n = 2;
  while (fs.existsSync(path.join(PROJECTS_DIR, slug))) slug = `${slugify(displayName)}-${n++}`;
  writeProject(slug, serializeProject(emptyProject(displayName)));
  return slug;
}

export function saveProjectAs(from: string, displayName: string, text: string) {
  let slug = slugify(displayName);
  let n = 2;
  while (fs.existsSync(path.join(PROJECTS_DIR, slug))) slug = `${slugify(displayName)}-${n++}`;
  const src = path.join(projectDir(from), 'media');
  const dst = path.join(projectDir(slug), 'media');
  if (fs.existsSync(src)) fs.cpSync(src, dst, { recursive: true });
  writeProject(slug, text);
  return slug;
}

/**
 * Watch project files for edits made outside the editor. `prepare` runs first and may rewrite the file
 * (e.g. to fill in asset references); if it did, the rewrite triggers its own change event.
 */
/** Tell the editor when a media file is replaced in place (same name, new contents). */
export function watchProjectMedia(onChange: (name: string, rel: string) => void) {
  chokidar
    .watch(PROJECTS_DIR, {
      depth: 2,
      ignoreInitial: true,
      ignored: (p: string) => /[\\/](renders|transcripts|\.thumbs|\.export-proxies)([\\/]|$)/.test(p),
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    })
    .on('change', (file) => {
      const rel = path.relative(PROJECTS_DIR, file).split(path.sep);
      if (rel.length !== 3 || rel[1] !== 'media') return;
      onChange(rel[0], `media/${rel[2]}`);
    });
}

export function watchProjects(onExternalChange: (name: string, text: string) => void, prepare?: (file: string) => Promise<boolean>) {
  const watcher = chokidar.watch(PROJECTS_DIR, {
    depth: 1,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 40 },
  });
  const handle = async (file: string) => {
    if (!file.endsWith('.banana')) return;
    if (prepare && (await prepare(file).catch(() => false))) return;
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return;
    }
    const abs = path.resolve(file);
    if (lastWritten.get(abs) === hash(text)) return;
    lastWritten.set(abs, hash(text));
    const name = path.basename(path.dirname(abs));
    projectChangeHooks.forEach((h) => h(name, text));
    onExternalChange(name, text);
  };
  watcher.on('change', handle).on('add', handle);
  return watcher;
}
