import { describe, expect, it } from 'vitest';
import { parseProject } from '../src/format/parse';
import { serializeProject } from '../src/format/serialize';
import { animatedPaths, transformAt } from '../src/format/values';
import type { Project, TextObject } from '../src/format/schema';

const src = (transform: string) => `
project: { fps: 30 }
tracks:
  - id: V1
    kind: video
    objects:
      - { id: t, type: text, start: 0, duration: 2, transform: ${transform} }
`;

function load(transform: string): Project {
  const r = parseProject(src(transform));
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.project;
}
const obj = (p: Project) => p.tracks[0].objects[0] as TextObject;

describe('transform stretch (scaleX / scaleY)', () => {
  it('defaults to no stretch and is not written when unused', () => {
    const p = load('{ scale: 2 }');
    const tr = transformAt(obj(p).transform, 0);
    expect(tr.scaleX).toBe(1);
    expect(tr.scaleY).toBe(1);
    expect(serializeProject(p)).not.toMatch(/scaleX|scaleY/);
    expect(animatedPaths(obj(p))).not.toContain('transform.scaleX');
  });

  it('keyframes squash and survive a save', () => {
    const p = load('{ scaleX: { keyframes: [ { t: 0, v: 1 }, { t: 1, v: 1.2 } ] }, scaleY: 0.8 }');
    expect(transformAt(obj(p).transform, 0.5).scaleX).toBeCloseTo(1.1);
    expect(transformAt(obj(p).transform, 0.5).scaleY).toBe(0.8);
    expect(animatedPaths(obj(p))).toContain('transform.scaleX');
    const again = parseProject(serializeProject(p));
    if (!again.ok) throw new Error('re-parse failed');
    expect(transformAt(obj(again.project).transform, 1).scaleX).toBeCloseTo(1.2);
    expect(transformAt(obj(again.project).transform, 1).scaleY).toBe(0.8);
  });
});
