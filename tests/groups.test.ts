import { describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { parseProject } from '../src/format/parse';
import { serializeProject } from '../src/format/serialize';
import { allIds, playedMedia } from '../src/format/groups';
import type { GroupObject, ImageObject, Project } from '../src/format/schema';
import { findObject, groupObjects, insertObject, splitObject, trimStart, ungroupObject } from '../src/state/commands';
import { buildAudioGraph } from '../server/export';

const parse = (text: string) => {
  const r = parseProject(text);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.project;
};

const base = parse(`
project: { fps: 10 }
library:
  - { id: block, file: media/block.png, kind: image, width: 100, height: 100 }
  - { id: pop, file: media/pop.mp3, kind: audio, duration: 0.3 }
tracks:
  - id: V1
    kind: video
    objects:
      - id: g
        type: group
        start: 2
        duration: 3
        volume: 0.5
        transform: { x: 100 }
        objects:
          - { id: b1, type: image, source: block, start: 0, duration: 3, transform: { x: -50 } }
          - { id: b2, type: image, source: block, start: 1, duration: 2, transform: { x: 50, scale: 0.5 } }
          - { id: p1, type: audio, source: pop, start: 0, duration: 0.3 }
          - { id: p2, type: audio, source: pop, start: 1, duration: 0.3, volume: 0.8 }
          - { id: late, type: audio, source: pop, start: 2.9, duration: 0.3 }
  - id: A1
    kind: audio
    objects: []
`);

const group = (p: Project, id = 'g') => findObject(p, id)!.obj as GroupObject;

describe('groups', () => {
  it('parses nested objects and knows every id', () => {
    expect(group(base).objects.map((o) => o.id)).toEqual(['b1', 'b2', 'p1', 'p2', 'late']);
    expect([...allIds(base)]).toEqual(['g', 'b1', 'b2', 'p1', 'p2', 'late']);
  });

  it('assigns ids inside groups and rejects bad children', () => {
    const p = parse(`
library: [ { id: block, file: b.png, kind: image } ]
tracks:
  - { id: V1, kind: video, objects: [ { type: group, objects: [ { type: image, source: block }, { type: image, source: block } ] } ] }
`);
    expect(group(p, 'group-1').objects.map((o) => o.id)).toEqual(['block-1', 'block-2']);
    const bad = parseProject(`
tracks:
  - { id: V1, kind: video, objects: [ { type: group, objects: [ { type: image, source: nope }, { type: adjustment } ] } ] }
`);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors.map((e) => e.message)).toEqual(['source "nope" is not in the library', "adjustment objects can't go inside a group"]);
      expect(bad.errors[0].path).toBe('tracks[0].objects[0].objects[0].source');
    }
  });

  it('flattens group sounds onto the timeline, clipped to the group, with its volume', () => {
    const sounds = playedMedia(base).filter((m) => m.inGroup);
    expect(sounds.map((m) => [m.obj.id, m.obj.start, Math.round(m.obj.duration * 100) / 100, m.gain])).toEqual([
      ['p1', 2, 0.3, 0.5],
      ['p2', 3, 0.3, 0.5],
      ['late', 4.9, 0.1, 0.5], // cut off by the group's end
    ]);
  });

  it('writes children one per line without defaults and reads them back the same', () => {
    const text = serializeProject(base);
    expect(text).toContain('- { id: b2, type: image, source: block, start: 1, duration: 2, transform: { x: 50, scale: 0.5 } }');
    expect(text).toContain('- { id: p2, type: audio, source: pop, start: 1, duration: 0.3, volume: 0.8 }');
    const again = parse(text);
    expect(again.tracks).toEqual(base.tracks);
  });

  it('split keeps everything in place on the timeline', () => {
    const p = produce(base, (d) => void splitObject(d, 'g', 3.5));
    const [left, right] = p.tracks[0].objects as GroupObject[];
    expect(left.objects.map((o) => o.id)).toEqual(['b1', 'b2', 'p1', 'p2']); // 'late' starts after the cut
    expect(right.start).toBe(3.5);
    // b1 (2..5) continues in the right half from 3.5; p1 (2..2.3) and p2 (3..3.3) are gone from it
    const r = right.objects.map((o) => [o.start, Math.round(o.duration * 100) / 100]);
    expect(r).toEqual([
      [0, 1.5],
      [0, 1.5],
      [1.4, 0.3],
    ]);
    expect(new Set(right.objects.map((o) => o.id)).has('b1')).toBe(false); // fresh ids, no duplicates
    expect(allIds(p).size).toBe(5 + 4);
  });

  it('trimming the front keeps children where they were', () => {
    const p = produce(base, (d) => void trimStart(d, group(d), 3));
    const g = group(p);
    expect(g.start).toBe(3);
    expect(g.objects.map((o) => [o.id, o.start, Math.round(o.duration * 100) / 100])).toEqual([
      ['b1', 0, 2],
      ['b2', 0, 2],
      ['p2', 0, 0.3],
      ['late', 1.9, 0.3],
    ]);
  });

  it('pasting a group gives its children new ids', () => {
    const p = produce(base, (d) => void insertObject(d, 'V1', JSON.parse(JSON.stringify(group(base))), false));
    expect(allIds(p).size).toBe(12);
  });

  it('group + ungroup round-trips position and timing', () => {
    const p = produce(base, (d) => void ungroupObject(d, 'g'));
    const b2 = findObject(p, 'b2')!.obj as ImageObject;
    expect(b2.start).toBe(3);
    expect(b2.transform.x).toBe(150); // 50 + the group's x 100
    const p2 = findObject(p, 'p2')!;
    expect(p2.track.id).toBe('A1');
    expect((p2.obj as { volume: number }).volume).toBe(0.4); // 0.8 × group volume 0.5
    const regrouped = produce(p, (d) => void groupObjects(d, ['b1', 'b2']));
    const g = regrouped.tracks[0].objects[0] as GroupObject;
    expect(g.start).toBe(2);
    expect(g.objects.map((o) => [o.id, o.start])).toEqual([
      ['b1', 0],
      ['b2', 1],
    ]);
  });

  it('export opens each sound file once', () => {
    const graph = buildAudioGraph(base, '/proj', { start: 0, end: 10, fps: 10, width: 10, height: 10, crf: 20 }, 1)!;
    expect(graph.inputs.filter((a) => a === '-i').length).toBe(1);
    expect(graph.filter).toContain('[1:a]asplit=3');
    expect(graph.filter).toContain('adelay=4900');
    expect(graph.filter).toContain('volume=0.5000');
  });
});
