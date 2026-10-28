import { describe, expect, it } from 'vitest';
import { produce } from 'immer';
import { parseProject } from '../src/format/parse';
import { serializeProject } from '../src/format/serialize';
import { easeProgress, keyframeTimes, setValueAt, shiftValue, toggleKeyframe, valueAt } from '../src/format/values';
import { mergePath, pathEnd, pathValueAt, samplesToPath, type Sample } from '../src/format/recording';
import type { AnimValue, Project, TextObject } from '../src/format/schema';
import { findObject, splitObject, trimStart } from '../src/state/commands';

const src = `
project: { fps: 30 }
tracks:
  - id: V1
    kind: video
    objects:
      - id: title
        type: text
        start: 2
        duration: 4
        transform:
          x:
            keyframes:
              - { t: 0, v: -800 }
              - { t: 1, v: 0, ease: { type: spring, damping: 0.3, frequency: 3 } }
          scale:
            keyframes:
              - { t: 0, v: 0.5 }
              - { t: 0.5, v: 1, ease: back }
              - { t: 2, v: 1.2, ease: easeInOut }
`;

const load = () => {
  const r = parseProject(src);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.project;
};
const title = (p: Project) => findObject(p, 'title')!.obj as TextObject;

describe('easing', () => {
  it('every ease starts at 0 and lands exactly on 1', () => {
    const eases = [
      { type: 'linear' },
      { type: 'easeIn' },
      { type: 'easeOut' },
      { type: 'easeInOut' },
      { type: 'bounce' },
      { type: 'back', overshoot: 1.7 },
      { type: 'spring', damping: 0.2, frequency: 2 },
      { type: 'bezier', x1: 0.3, y1: 1.6, x2: 0.6, y2: 1 },
    ] as const;
    for (const e of eases) {
      expect(easeProgress(e as any, 0, 1)).toBeCloseTo(0, 6);
      expect(easeProgress(e as any, 1, 1)).toBeCloseTo(1, 6);
    }
  });

  it('back and spring overshoot the target', () => {
    const back = Math.max(...Array.from({ length: 100 }, (_, i) => easeProgress({ type: 'back', overshoot: 1.7 }, i / 100)));
    const spring = Math.max(...Array.from({ length: 100 }, (_, i) => easeProgress({ type: 'spring', damping: 0.25, frequency: 3 }, i / 100, 1)));
    expect(back).toBeGreaterThan(1.05);
    expect(spring).toBeGreaterThan(1.2);
    // fully damped spring never overshoots
    const stiff = Math.max(...Array.from({ length: 100 }, (_, i) => easeProgress({ type: 'spring', damping: 1, frequency: 3 }, i / 100, 1)));
    expect(stiff).toBeLessThanOrEqual(1.0001);
  });

  it('hold jumps at the keyframe', () => {
    expect(easeProgress({ type: 'hold' }, 0.99)).toBe(0);
  });
});

describe('keyframes', () => {
  it('parses eases (bare words become objects) and interpolates', () => {
    const o = title(load());
    expect((o.transform.scale as AnimValue).keyframes[1].ease).toEqual({ type: 'back', overshoot: 1.7 });
    expect(valueAt(o.transform.x, -1)).toBe(-800); // before first key: holds
    expect(valueAt(o.transform.x, 1)).toBe(0);
    expect(valueAt(o.transform.x, 9)).toBe(0); // after last key: holds
    expect(valueAt(o.transform.scale, 0.25)).toBeGreaterThan(0.5);
  });

  it('round-trips keyframes through the file in a readable form', () => {
    const text = serializeProject(load());
    expect(text).toContain('- { t: 1, v: 0, ease: { type: spring, damping: 0.3, frequency: 3 } }');
    expect(text).toContain('- { t: 0.5, v: 1, ease: { type: back, overshoot: 1.7 } }');
    expect(text).toContain('ease: easeInOut }');
    const again = parseProject(text);
    if (!again.ok) throw new Error(JSON.stringify(again.errors));
    expect(again.project).toEqual(load());
  });

  it('reports bad keyframes clearly', () => {
    const r = parseProject(src.replace('ease: back', 'ease: wobble'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0].path).toContain('transform.scale.keyframes[1].ease');
  });

  it('setValueAt keyframes animated props and edits static ones', () => {
    const p = produce(load(), (d) => {
      const o = title(d as Project);
      setValueAt(o, 'transform.x', 50, 0.5); // animated -> new key
      setValueAt(o, 'transform.y', 30, 0.5); // static -> plain value
      toggleKeyframe(o, 'transform.rotation', 1); // start animating
    });
    const o = title(p);
    expect((o.transform.x as AnimValue).keyframes.map((k) => k.t)).toEqual([0, 0.5, 1]);
    expect(o.transform.y).toBe(30);
    expect((o.transform.rotation as AnimValue).keyframes).toHaveLength(1);
    expect(keyframeTimes(o).map((k) => k.t)).toEqual([0, 0.5, 1, 2]);
  });

  it('keyframes stay put on the timeline when trimming or splitting', () => {
    const before = valueAt(title(load()).transform.x, 0.5); // timeline 2.5s
    const trimmed = produce(load(), (d) => void trimStart(d as Project, title(d as Project), 2.2));
    expect(valueAt(title(trimmed).transform.x, 0.3)).toBeCloseTo(before, 6); // still timeline 2.5s
    const split = produce(load(), (d) => void splitObject(d as Project, 'title', 2.4));
    const right = split.tracks[0].objects[1] as TextObject;
    expect(valueAt(right.transform.x, 0.1)).toBeCloseTo(before, 6);
  });
});

describe('recording (motion paths)', () => {
  // a jittery circle recorded at an irregular ~60 fps
  const samples: Sample[] = [];
  for (let i = 0, t = 0.5; t <= 2.5; i++, t += 1 / 60 + (i % 3) * 0.002) samples.push({ t, v: { x: Math.sin((t - 0.5) * Math.PI) * 400 + (i % 2 ? 3 : -3), y: (t - 0.5) * 100 } });

  it('keeps the whole performance (nothing simplified away)', () => {
    const p = samplesToPath(samples, 'exact')!;
    expect(p.start).toBeCloseTo(0.5, 3);
    expect(p.rate).toBe(60);
    expect(p.x!.length).toBeGreaterThan(110); // ~2 s at 60/s
    // every sample is reproduced within the jitter, including the wiggle
    for (const s of samples.slice(1, -1)) expect(Math.abs(pathValueAt([p], 'x', s.t)! - s.v.x)).toBeLessThan(6.5);
  });

  it('holds the last value after the path, and nothing before it', () => {
    const p = samplesToPath(samples)!;
    expect(pathValueAt([p], 'x', 0.2)).toBeUndefined();
    expect(pathValueAt([p], 'y', pathEnd(p) + 5)).toBe(p.y![p.y!.length - 1]);
  });

  it('a new take replaces only its own time range and channels', () => {
    const first = samplesToPath(samples)!; // x + y, 0.5 .. 2.5
    const take = samplesToPath([ { t: 1, v: { x: 0 } }, { t: 1.5, v: { x: 50 } } ])!; // x only, 1 .. 1.5
    const merged = mergePath([first], take);
    expect(pathValueAt(merged, 'x', 1.25)).toBeCloseTo(25, 1); // the new take
    expect(pathValueAt(merged, 'y', 1.25)).toBeCloseTo(75, 0); // y untouched inside the take
    expect(pathValueAt(merged, 'x', 2)).toBeCloseTo(pathValueAt([first], 'x', 2)!, 1); // old x resumes after
  });

  it('moves with the object and survives the file round trip', () => {
    const p = parseProject(src);
    if (!p.ok) throw new Error();
    const moved = produce(p.project, (d) => {
      const o = title(d as Project);
      o.motion = [samplesToPath(samples)!];
      shiftValue(o, 'transform.x', { add: 10 });
    });
    const o = title(moved);
    expect(o.motion![0].x![0]).toBeCloseTo(samplesToPath(samples)!.x![0] + 10, 3);
    const again = parseProject(serializeProject(moved));
    if (!again.ok) throw new Error(JSON.stringify(again.errors));
    expect(title(again.project).motion![0].x).toEqual(o.motion![0].x);
    expect(serializeProject(moved)).toMatch(/\n\s+x: \[ [-\d.]+, /); // one line per channel
  });
});

describe('moving an animation as a whole', () => {
  it('shiftValue moves every keyframe (and plain values)', () => {
    const p = produce(load(), (d) => {
      const o = title(d as Project);
      shiftValue(o, 'transform.x', { add: 25 });
      shiftValue(o, 'transform.y', { add: 10 }); // static
      shiftValue(o, 'transform.scale', { mul: 2 });
    });
    const o = title(p);
    expect((o.transform.x as AnimValue).keyframes.map((k) => k.v)).toEqual([-775, 25]);
    expect(o.transform.y).toBe(10);
    expect((o.transform.scale as AnimValue).keyframes.map((k) => k.v)).toEqual([1, 2, 2.4]);
    // the motion keeps its shape: same ease, same times
    expect((o.transform.x as AnimValue).keyframes[1].ease).toEqual((title(load()).transform.x as AnimValue).keyframes[1].ease);
  });
});
