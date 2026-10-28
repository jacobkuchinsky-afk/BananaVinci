// Project -> YAML text.
// Output is deterministic: properties are written in schema order, every property is written
// explicitly, small groups (transform, crop, effects...) go on one line, and numbers are rounded.
import YAML, { isMap, isPair, isScalar, isSeq, type Pair, type YAMLMap } from 'yaml';
import { ObjectSchema, defaultsFor, type GroupObject, type Project, type TimelineObject, type Track } from './schema';

const HEADER = ` BananaVinci project file (.banana) — safe to edit by hand or by AI.
 The editor reloads automatically when this file is saved.

 Units:  times are SECONDS  ·  x / y are PIXELS from the canvas CENTER (+y = down)
         rotation is DEGREES  ·  opacity is 0..1  ·  volume is 0..2 (1 = original)
 Layers: video tracks are listed bottom-to-top (later tracks draw on top).
 Missing properties fall back to defaults; missing object ids are generated on load.
 Full reference: docs/BANANA_FORMAT.md`;

const SECTION_COMMENTS: Record<string, string> = {
  project: ' Canvas / output settings',
  library: ' Media files you can place on the timeline (paths are relative to this file)',
  markers: ' Named points in time',
  tracks: ' Timeline. Each object: start = timeline position (s), duration = length on the timeline (s)',
};

const FLOW_KEYS = new Set(['transform', 'crop', 'outline', 'background', 'shadow']);
const FLOW_ITEM_SEQS = new Set(['effects', 'markers']);

export function round(n: number, digits = 4): number {
  const f = 10 ** digits;
  const r = Math.round(n * f) / f;
  return Object.is(r, -0) ? 0 : r;
}

/** Round numbers, drop undefined, and write parameter-less eases as a bare word (`ease: easeOut`). */
function roundDeep<T>(v: T): T {
  if (typeof v === 'number') return round(v) as T;
  if (Array.isArray(v)) return v.map(roundDeep) as T;
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      if (val === undefined) continue;
      if (k === 'ease' && val && typeof val === 'object' && Object.keys(val).length === 1) out[k] = (val as { type: string }).type;
      else out[k] = roundDeep(val);
    }
    return out as T;
  }
  return v;
}

const allScalar = (n: unknown) => isMap(n) && n.items.every((p) => isPair(p) && isScalar(p.value));

/** Re-order an object's keys: id, type, source, start, duration, then the rest in schema order. */
export function normalizeObject(o: TimelineObject): Record<string, unknown> {
  let parsed: Record<string, unknown>;
  try {
    parsed = ObjectSchema.parse(o) as Record<string, unknown>;
  } catch {
    parsed = { ...o };
  }
  const { id, type, source, start, duration, ...rest } = parsed;
  const head: Record<string, unknown> = { id: id ?? o.id, type };
  if (source !== undefined) head.source = source;
  const out: Record<string, unknown> = { ...head, start, duration, ...rest };
  // list order inside a group is drawing order (later = on top), so it is kept as is
  if (o.type === 'group') out.objects = (o as GroupObject).objects.map(compactObject);
  return out;
}

const KEEP = new Set(['id', 'type', 'source', 'start', 'duration', 'objects']);
const same = (a: unknown, b: unknown) => JSON.stringify(roundDeep(a)) === JSON.stringify(roundDeep(b));

/**
 * Objects inside a group are written compactly (one line each, see serializeProject): properties that equal their
 * default are left out, including single transform / crop fields. Missing properties get the same defaults on load.
 */
export function compactObject(o: TimelineObject): Record<string, unknown> {
  const full = normalizeObject(o);
  const def = normalizeObject({ ...defaultsFor(o.type, 'source' in o ? { source: o.source } : {}), id: o.id } as TimelineObject);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(full)) {
    if (KEEP.has(k)) {
      out[k] = v;
      continue;
    }
    const d = def[k];
    if (same(v, d)) continue;
    if ((k === 'transform' || k === 'crop') && v && typeof v === 'object' && d && typeof d === 'object') {
      const part: Record<string, unknown> = {};
      for (const [sk, sv] of Object.entries(v)) if (!same(sv, (d as Record<string, unknown>)[sk])) part[sk] = sv;
      out[k] = part;
      continue;
    }
    out[k] = v;
  }
  return out;
}

function trackOut(t: Track) {
  const out: Record<string, unknown> = { id: t.id, kind: t.kind, name: t.name };
  if (t.kind === 'video') out.hidden = t.hidden;
  else {
    out.muted = t.muted;
    out.solo = t.solo;
  }
  out.locked = t.locked;
  out.objects = [...t.objects].sort((a, b) => a.start - b.start).map(normalizeObject);
  return out;
}

export function toPlain(p: Project) {
  return roundDeep({
    format: p.format,
    project: p.project,
    library: p.library,
    markers: [...p.markers].sort((a, b) => a.time - b.time),
    tracks: p.tracks.map(trackOut),
  });
}

export function serializeProject(p: Project): string {
  const doc = new YAML.Document(toPlain(p));
  doc.commentBefore = HEADER;

  YAML.visit(doc, {
    Pair(_, pair: Pair, path) {
      const key = isScalar(pair.key) ? String(pair.key.value) : '';
      // objects inside a group: one line each
      const parent = path[path.length - 1];
      if (key === 'objects' && isSeq(pair.value) && isMap(parent) && parent.get('type') === 'group')
        for (const item of pair.value.items) if (isMap(item)) item.flow = true;
      // small groups go on one line — unless they contain keyframes, which get their own block
      if (FLOW_KEYS.has(key) && allScalar(pair.value)) (pair.value as YAMLMap).flow = true;
      if (FLOW_ITEM_SEQS.has(key) && isSeq(pair.value)) for (const item of pair.value.items) if (allScalar(item)) (item as YAMLMap).flow = true;
      // one keyframe per line: - { t: 0.5, v: 300, ease: easeOut }
      if (key === 'keyframes' && isSeq(pair.value)) for (const item of pair.value.items) if (isMap(item)) item.flow = true;
      // motion paths: one line per channel ( x: [ 12, 12.4, … ] )
      if (key === 'motion' && isSeq(pair.value))
        for (const item of pair.value.items)
          if (isMap(item)) for (const p of item.items) if (isPair(p) && isSeq(p.value)) p.value.flow = true;
    },
  });

  if (isMap(doc.contents)) {
    for (const item of doc.contents.items) {
      if (!isPair(item) || !isScalar(item.key)) continue;
      const c = SECTION_COMMENTS[String(item.key.value)];
      if (c) {
        item.key.commentBefore = c;
        item.key.spaceBefore = true;
      }
    }
  }

  return doc.toString({ lineWidth: 0, flowCollectionPadding: true, defaultStringType: 'PLAIN', defaultKeyType: 'PLAIN' });
}
