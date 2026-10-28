// YAML text -> validated Project.
// Lenient: missing properties get defaults and missing ids get generated.
// Strict: unknown keys, wrong types and dangling references are errors, reported with a line number.
import YAML, { LineCounter, isNode } from 'yaml';
import type { ZodIssue } from 'zod';
import { EASE_PRESETS, ProjectSchema, trackKindFor, type Project, type TimelineObject } from './schema';

export interface FormatIssue {
  message: string;
  path: string; // e.g. tracks[1].objects[0].size
  line?: number; // 1-based
}

export type ParseResult =
  | { ok: true; project: Project; warnings: FormatIssue[] }
  | { ok: false; errors: FormatIssue[] };

export function formatPath(path: (string | number)[]): string {
  return path.reduce<string>((acc, p) => (typeof p === 'number' ? `${acc}[${p}]` : acc ? `${acc}.${p}` : p), '');
}

export function parseProject(text: string): ParseResult {
  const lineCounter = new LineCounter();
  const doc = YAML.parseDocument(text, { lineCounter, prettyErrors: true, uniqueKeys: true });

  if (doc.errors.length) {
    return {
      ok: false,
      errors: doc.errors.map((e) => ({
        message: e.message.split('\n')[0],
        path: '',
        line: e.linePos?.[0]?.line,
      })),
    };
  }

  const raw = doc.toJS() ?? {};
  const lineOf = (path: (string | number)[]): number | undefined => {
    for (let n = path.length; n >= 0; n--) {
      const node = doc.getIn(path.slice(0, n), true);
      if (isNode(node) && node.range) return lineCounter.linePos(node.range[0]).line;
    }
    return undefined;
  };

  const pending = unresolvedAssets(raw);
  if (pending.length) {
    return {
      ok: false,
      errors: pending.map(({ index, asset }) => ({
        message: `asset "${asset}" hasn't been copied into the project yet: run npm run check (or keep the editor open) to fill in its file`,
        path: `library[${index}]`,
        line: lineOf(['library', index]),
      })),
    };
  }

  const res = ProjectSchema.safeParse(raw);
  if (!res.success) {
    return { ok: false, errors: res.error.issues.map((i) => issueToError(i, lineOf)) };
  }

  const project = res.data as Project;
  const { errors, warnings } = checkReferences(project, lineOf);
  if (errors.length) return { ok: false, errors };
  return { ok: true, project, warnings };
}

/** Library entries written as `{ id, asset: <name> }` that still need their file copied in from the asset library. */
export function unresolvedAssets(raw: unknown): { index: number; id?: string; asset: string }[] {
  const lib = (raw as { library?: unknown })?.library;
  if (!Array.isArray(lib)) return [];
  return lib.flatMap((item, index) =>
    item && typeof item === 'object' && typeof item.asset === 'string' && !item.file ? [{ index, id: item.id, asset: item.asset as string }] : [],
  );
}

function issueToError(issue: ZodIssue, lineOf: (p: (string | number)[]) => number | undefined): FormatIssue {
  if (issue.code === 'invalid_union') {
    // Pick the most specific branch error (deepest path, not a plain "wrong type" at the same spot).
    const all = issue.unionErrors.flatMap((e) => e.issues);
    const score = (i: ZodIssue) => i.path.length * 10 + (i.code === 'invalid_type' ? 0 : 1);
    const best = all.sort((a, b) => score(b) - score(a))[0];
    if (best && best.path.length > issue.path.length) return issueToError(best, lineOf);
    if (best && best.code !== 'invalid_type') return issueToError(best, lineOf);
    const what = issue.path[issue.path.length - 1] === 'ease' ? `an ease name (${EASE_PRESETS.join(', ')}) or { type: back | spring | bezier, … }` : 'a number or { keyframes: [ { t, v, ease } ] }';
    return { message: `expected ${what}`, path: formatPath(issue.path), line: lineOf(issue.path) };
  }
  let message = issue.message;
  if (issue.code === 'unrecognized_keys') message = `unknown property ${issue.keys.map((k) => `"${k}"`).join(', ')}`;
  if (issue.code === 'invalid_union_discriminator') message = `"type" must be one of ${issue.options.join(', ')}`;
  if (issue.code === 'invalid_type') message = `expected ${issue.expected}, got ${issue.received}`;
  const at = issue.code === 'unrecognized_keys' ? [...issue.path, issue.keys[0]] : issue.path;
  return { message, path: formatPath(issue.path), line: lineOf(at) };
}

/** Cross-object checks zod can't express; also assigns missing / duplicate ids. */
function checkReferences(project: Project, lineOf: (p: (string | number)[]) => number | undefined) {
  const errors: FormatIssue[] = [];
  const warnings: FormatIssue[] = [];
  const libIds = new Set<string>();
  project.library.forEach((item, i) => {
    if (libIds.has(item.id)) errors.push({ message: `duplicate library id "${item.id}"`, path: `library[${i}].id`, line: lineOf(['library', i, 'id']) });
    libIds.add(item.id);
  });
  const libKind = new Map(project.library.map((l) => [l.id, l.kind]));

  const trackIds = new Set<string>();
  project.tracks.forEach((track, ti) => {
    if (trackIds.has(track.id)) errors.push({ message: `duplicate track id "${track.id}"`, path: `tracks[${ti}].id`, line: lineOf(['tracks', ti, 'id']) });
    trackIds.add(track.id);
    const check = (o: TimelineObject, p: (string | number)[], inGroup: boolean) => {
      if (!inGroup && trackKindFor(o.type) !== track.kind)
        errors.push({ message: `a ${o.type} object can't go on ${track.kind} track "${track.id}"`, path: formatPath(p), line: lineOf(p) });
      if (inGroup && o.type === 'adjustment')
        errors.push({ message: `adjustment objects can't go inside a group`, path: formatPath(p), line: lineOf(p) });
      if ('source' in o) {
        const kind = libKind.get(o.source);
        if (!kind) errors.push({ message: `source "${o.source}" is not in the library`, path: formatPath([...p, 'source']), line: lineOf([...p, 'source']) });
        else if (kind !== o.type && !(o.type === 'audio' && kind === 'video'))
          errors.push({ message: `source "${o.source}" is ${kind}, but object type is ${o.type}`, path: formatPath([...p, 'source']), line: lineOf([...p, 'source']) });
      }
      if (o.type === 'group') o.objects.forEach((c, ci) => check(c, [...p, 'objects', ci], true));
    };
    track.objects.forEach((o, oi) => check(o, ['tracks', ti, 'objects', oi], false));
  });

  // ids: assign missing, fix duplicates
  const used = new Set<string>();
  const all: { o: TimelineObject; path: (string | number)[] }[] = [];
  const collect = (objs: TimelineObject[], base: (string | number)[]) =>
    objs.forEach((o, oi) => {
      all.push({ o, path: [...base, oi] });
      if (o.type === 'group') collect(o.objects, [...base, oi, 'objects']);
    });
  project.tracks.forEach((t, ti) => collect(t.objects, ['tracks', ti, 'objects']));
  for (const { o } of all) if (o.id && !used.has(o.id)) used.add(o.id);
  const seen = new Set<string>();
  for (const { o, path } of all) {
    if (o.id && !seen.has(o.id)) {
      seen.add(o.id);
      continue;
    }
    const old = o.id;
    o.id = uniqueId(idBase(o), used);
    seen.add(o.id);
    if (old) warnings.push({ message: `duplicate id "${old}" renamed to "${o.id}"`, path: formatPath(path), line: lineOf(path) });
  }
  return { errors, warnings };
}

export function idBase(o: { type: string; source?: string }): string {
  const s = 'source' in o && o.source ? o.source : o.type;
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || o.type;
}

export function uniqueId(base: string, used: Set<string>): string {
  let n = 1;
  while (used.has(`${base}-${n}`)) n++;
  const id = `${base}-${n}`;
  used.add(id);
  return id;
}
