import { describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { parseProject } from '../src/format/parse';
import type { Project, VideoObject } from '../src/format/schema';
import { closeGap, deleteObjects, findObject, moveObjects, slip, splitObject, trimEnd, trimStart } from '../src/state/commands';

const base = (() => {
  const r = parseProject(`
project: { fps: 10 }
library:
  - { id: clip, file: media/clip.mp4, kind: video, duration: 10 }
tracks:
  - id: V1
    kind: video
    objects:
      - { id: a, type: video, source: clip, start: 0, duration: 4, in: 1 }
      - { id: b, type: video, source: clip, start: 4, duration: 2 }
      - { id: c, type: video, source: clip, start: 8, duration: 2 }
`);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.project;
})();

const get = (p: Project, id: string) => findObject(p, id)!.obj as VideoObject;

describe('commands', () => {
  it('split sets the right half in-point and keeps total length', () => {
    const p = produce(base, (d) => {
      splitObject(d, 'a', 1.5);
    });
    const objs = p.tracks[0].objects;
    expect(objs.map((o) => o.id)).toEqual(['a', 'clip-1', 'b', 'c']);
    expect(get(p, 'a').duration).toBe(1.5);
    expect(get(p, 'clip-1').start).toBe(1.5);
    expect(get(p, 'clip-1').duration).toBe(2.5);
    expect(get(p, 'clip-1').in).toBe(2.5);
    expect(base.tracks[0].objects.length).toBe(3); // original untouched (undo-safe)
  });

  it('trim clamps to the source media', () => {
    const p = produce(base, (d) => {
      trimStart(d, get(d, 'a'), -5); // can only go back 1s of source... but not below 0
      trimEnd(d, get(d, 'b'), 100); // b: in 0, source 10s
    });
    expect(get(p, 'a').start).toBe(0);
    expect(get(p, 'a').in).toBe(1);
    expect(get(p, 'b').duration).toBe(10);
  });

  it('trim start moves in-point', () => {
    const p = produce(base, (d) => {
      trimStart(d, get(d, 'c'), 9);
    });
    expect(get(p, 'c')).toMatchObject({ start: 9, duration: 1, in: 1 });
  });

  it('slip clamps to source length', () => {
    const p = produce(base, (d) => slip(d, get(d, 'a'), 50));
    expect(get(p, 'a').in).toBe(6);
  });

  it('ripple delete pulls later clips left', () => {
    const p = produce(base, (d) => deleteObjects(d, ['b'], true));
    expect(get(p, 'c').start).toBe(6);
    const q = produce(base, (d) => deleteObjects(d, ['b']));
    expect(get(q, 'c').start).toBe(8);
  });

  it('close gap', () => {
    const p = produce(base, (d) => {
      closeGap(d, 'V1', 7);
    });
    expect(get(p, 'c').start).toBe(6);
  });

  it('move overwrites what is underneath', () => {
    const p = produce(base, (d) => moveObjects(d, ['c'], -5)); // c -> [3,5): trims a to 3, b becomes [5,6)
    expect(get(p, 'a').duration).toBe(3);
    expect(get(p, 'b')).toMatchObject({ start: 5, duration: 1, in: 1 });
    expect(get(p, 'c').start).toBe(3);
  });
});
