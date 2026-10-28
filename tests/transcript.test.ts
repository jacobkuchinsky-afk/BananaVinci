import { describe, expect, it } from 'vitest';
import { parseProject } from '../src/format/parse';
import { applyCaptions, buildCaptions, removeCaptions, timelineTranscript, toSrt, type SourceTranscript } from '../src/format/transcript';

const words = (list: [number, number, string][]) => list.map(([start, end, word]) => ({ start, end, word, p: 0.9 }));
const source: SourceTranscript = {
  source: 'talk',
  file: 'media/talk.wav',
  fileSize: 1,
  fileMtime: 1,
  engine: 'test',
  model: 'test',
  language: 'en',
  duration: 20,
  createdAt: '',
  segments: [
    { start: 1, end: 3, text: 'Hello there world.', words: words([[1, 1.4, 'Hello'], [1.5, 2, 'there'], [2.1, 3, 'world.']]) },
    { start: 10, end: 12, text: 'Second line here.', words: words([[10, 10.5, 'Second'], [10.6, 11, 'line'], [11.1, 12, 'here.']]) },
  ],
};

const project = (objects: string) => {
  const r = parseProject(`
library: [ { id: talk, file: media/talk.wav, kind: audio, duration: 20 } ]
tracks:
  - id: A1
    kind: audio
    objects: ${objects}
`);
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.project;
};

describe('timeline transcript', () => {
  it('maps source words to timeline time through start / in', () => {
    const p = project('[ { id: c, type: audio, source: talk, start: 5, in: 1, duration: 12 } ]');
    const segs = timelineTranscript(p, { talk: source });
    expect(segs).toHaveLength(2);
    expect(segs[0].words[0]).toMatchObject({ start: 5, word: 'Hello', sourceStart: 1 });
    expect(segs[1].start).toBe(14); // source 10 -> 5 + (10 - 1)
    expect(segs[1].object).toBe('c');
  });

  it('drops words that were cut out and respects speed', () => {
    const p = project('[ { id: c, type: audio, source: talk, start: 0, in: 1.45, duration: 1, speed: 2 } ]'); // plays source 1.45 .. 3.45
    const segs = timelineTranscript(p, { talk: source });
    expect(segs[0].words.map((w) => w.word)).toEqual(['there', 'world.']);
    expect(segs[0].words[0].start).toBeCloseTo(0.025, 3); // (1.5 - 1.45) / 2
  });

  it('ignores muted / disabled clips', () => {
    expect(timelineTranscript(project('[ { type: audio, source: talk, start: 0, duration: 15, enabled: false } ]'), { talk: source })).toHaveLength(0);
    expect(timelineTranscript(project('[ { type: audio, source: talk, start: 0, duration: 15, volume: 0 } ]'), { talk: source })).toHaveLength(0);
  });
});

describe('captions', () => {
  it('builds captions, writes SRT, adds and removes caption objects', () => {
    const p = project('[ { id: c, type: audio, source: talk, start: 0, duration: 15 } ]');
    const caps = buildCaptions(timelineTranscript(p, { talk: source }));
    expect(caps.map((c) => c.text)).toEqual(['Hello there world.', 'Second line here.']);
    expect(toSrt(caps)).toContain('00:00:01,000 --> 00:00:03,000');
    const r = applyCaptions(p, caps);
    expect(r.count).toBe(2);
    const track = p.tracks.find((t) => t.name === 'Captions')!;
    expect(track.objects.map((o) => o.type === 'text' && o.text)).toEqual(['Hello there world.', 'Second line here.']);
    applyCaptions(p, caps); // re-running replaces, doesn't duplicate
    expect(p.tracks.find((t) => t.name === 'Captions')!.objects).toHaveLength(2);
    expect(removeCaptions(p)).toBe(2);
    expect(p.tracks.some((t) => t.name === 'Captions')).toBe(false);
  });

  it('splits long sentences into balanced lines without orphans', () => {
    const long: SourceTranscript = {
      ...source,
      segments: [{ start: 0, end: 4, text: '', words: words('Every neural network starts out knowing nothing.'.split(' ').map((w, i) => [i * 0.5, i * 0.5 + 0.4, w] as [number, number, string])) }],
    };
    const p = project('[ { id: c, type: audio, source: talk, start: 0, duration: 15 } ]');
    const caps = buildCaptions(timelineTranscript(p, { talk: long }));
    expect(caps.length).toBe(2);
    expect(caps.every((c) => c.text.split(' ').length >= 2)).toBe(true);
  });
});
