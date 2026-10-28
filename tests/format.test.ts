import { describe, expect, it } from 'vitest';
import { parseProject } from '../src/format/parse';
import { serializeProject } from '../src/format/serialize';
import { emptyProject } from '../src/format/schema';

const minimal = `
project: { name: Test, width: 1280, height: 720 }
library:
  - { id: banana, file: media/banana.png, kind: image }
tracks:
  - id: V1
    kind: video
    objects:
      - type: image
        source: banana
        start: 1
        duration: 4
      - type: text
        text: Hello
        start: 2
        duration: 3
`;

describe('format', () => {
  it('fills defaults and generates ids for minimal objects', () => {
    const r = parseProject(minimal);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    const [img, txt] = r.project.tracks[0].objects;
    expect(img.id).toBe('banana-1');
    expect(txt.id).toBe('text-1');
    expect(img.type === 'image' && img.transform.scale).toBe(1);
    expect(txt.type === 'text' && txt.size).toBe(96);
    expect(r.project.project.fps).toBe(30);
  });

  it('round-trips parse -> serialize -> parse identically', () => {
    const a = parseProject(minimal);
    if (!a.ok) throw new Error();
    const text = serializeProject(a.project);
    const b = parseProject(text);
    if (!b.ok) throw new Error(JSON.stringify(b.errors));
    expect(b.project).toEqual(a.project);
    expect(serializeProject(b.project)).toBe(text);
    expect(text).toContain('transform: { x: 0, y: 0, scale: 1');
    expect(text.startsWith('# BananaVinci project file')).toBe(true);
  });

  it('serializes an empty project', () => {
    const r = parseProject(serializeProject(emptyProject('X')));
    expect(r.ok).toBe(true);
  });

  it('reports unknown keys with path and line', () => {
    const r = parseProject(minimal.replace('text: Hello', 'text: Hello\n        fontsize: 12'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0].message).toContain('fontsize');
    expect(r.errors[0].path).toBe('tracks[0].objects[1]');
    expect(r.errors[0].line).toBe(15);
  });

  it('reports wrong types', () => {
    const r = parseProject(minimal.replace('start: 2', 'start: soon'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0].path).toBe('tracks[0].objects[1].start');
    expect(r.errors[0].line).toBe(15);
  });

  it('reports YAML syntax errors with a line', () => {
    const r = parseProject('project:\n  name: [oops\n');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0].line).toBeGreaterThan(0);
  });

  it('rejects dangling sources and wrong track kinds', () => {
    const r = parseProject(minimal.replace('source: banana', 'source: nope'));
    expect(r.ok).toBe(false);
    const r2 = parseProject(minimal.replace('kind: video', 'kind: audio'));
    expect(r2.ok).toBe(false);
  });

  it('renames duplicate ids with a warning', () => {
    const r = parseProject(minimal.replace('type: image', 'id: a\n        type: image').replace('type: text', 'id: a\n        type: text'));
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(r.project.tracks[0].objects[1].id).toBe('text-1');
    expect(r.warnings.length).toBe(1);
  });
});
