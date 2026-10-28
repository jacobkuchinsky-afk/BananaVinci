// Transcripts: speech-to-text results and how they line up with the edit.
//
// A *source transcript* belongs to one media file (library item) and uses that file's own time.
// The *timeline transcript* is derived from those by following the edit: each video/audio object
// plays `in .. in + duration × speed` of its source starting at `start`, so every heard word gets
// a TIMELINE time that can be used directly for `start` / `duration` in the .banana file.
import { defaultsFor, hasSourceTime, type Project, type TextObject, type Track } from './schema';
import { addTrack, insertObject } from '../state/commands';

export interface Word {
  start: number;
  end: number;
  word: string;
  p?: number; // confidence 0..1
}

export interface SourceSegment {
  start: number;
  end: number;
  text: string;
  words: Word[];
}

export interface SourceTranscript {
  source: string; // library id
  file: string; // media file it was made from
  fileSize: number;
  fileMtime: number;
  engine: string;
  model: string;
  language: string;
  duration: number;
  createdAt: string;
  segments: SourceSegment[];
}

export interface TimelineWord {
  start: number; // timeline seconds
  end: number;
  word: string;
  p?: number;
  sourceStart: number; // seconds in the source file
}

export interface TimelineSegment {
  start: number;
  end: number;
  text: string;
  object: string; // timeline object that plays it
  track: string;
  source: string; // library id
  sourceStart: number;
  sourceEnd: number;
  words: TimelineWord[];
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Follow the edit: which transcribed words are heard on the timeline, and when. */
export function timelineTranscript(project: Project, sources: Record<string, SourceTranscript>): TimelineSegment[] {
  const out: TimelineSegment[] = [];
  const anySolo = project.tracks.some((t) => t.kind === 'audio' && t.solo);
  for (const track of project.tracks) {
    if (track.kind === 'audio' && (track.muted || (anySolo && !track.solo))) continue;
    for (const o of track.objects) {
      if (!o.enabled || !hasSourceTime(o)) continue;
      if (o.type === 'video' && o.muted) continue;
      if (typeof o.volume === 'number' && o.volume <= 0) continue;
      const tr = sources[o.source];
      if (!tr) continue;
      const srcFrom = o.in;
      const srcTo = o.in + o.duration * o.speed;
      const toTimeline = (s: number) => o.start + (s - o.in) / o.speed;
      for (const seg of tr.segments) {
        if (seg.end < srcFrom || seg.start > srcTo) continue;
        const words: TimelineWord[] = [];
        for (const w of seg.words) {
          const mid = (w.start + w.end) / 2;
          if (mid < srcFrom || mid > srcTo) continue; // word was cut out
          words.push({
            start: r3(Math.max(o.start, toTimeline(w.start))),
            end: r3(Math.min(o.start + o.duration, toTimeline(w.end))),
            word: w.word,
            p: w.p,
            sourceStart: r3(w.start),
          });
        }
        if (!words.length) continue;
        out.push({
          start: words[0].start,
          end: words[words.length - 1].end,
          text: words.map((w) => w.word).join(' '),
          object: o.id,
          track: track.id,
          source: o.source,
          sourceStart: words[0].sourceStart,
          sourceEnd: r3(o.in + (words[words.length - 1].end - o.start) * o.speed),
          words,
        });
      }
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

// ----------------------------------------------------------------------------- captions

export interface Caption {
  start: number;
  end: number;
  text: string;
}

export interface CaptionOptions {
  maxChars: number; // per caption
  maxGap: number; // a pause longer than this starts a new caption (s)
  minDuration: number; // shortest a caption may stay on screen (s)
}

export const DEFAULT_CAPTION_OPTIONS: CaptionOptions = { maxChars: 42, maxGap: 0.6, minDuration: 0.8 };

/** Group heard words into short, readable captions. */
export function buildCaptions(segments: TimelineSegment[], opts: CaptionOptions = DEFAULT_CAPTION_OPTIONS): Caption[] {
  const words = segments.flatMap((s) => s.words).sort((a, b) => a.start - b.start);
  // 1) phrases: break at pauses and sentence ends
  const phrases: TimelineWord[][] = [];
  let cur: TimelineWord[] = [];
  for (const w of words) {
    const prev = cur[cur.length - 1];
    if (prev && (w.start - prev.end > opts.maxGap || /[.?!]$/.test(prev.word))) {
      phrases.push(cur);
      cur = [];
    }
    cur.push(w);
  }
  if (cur.length) phrases.push(cur);
  // 2) long phrases: split into balanced chunks (no one-word orphans), preferring breaks after commas
  const textLen = (ws: TimelineWord[]) => ws.reduce((n, w) => n + w.word.length + 1, -1);
  const caps: { words: TimelineWord[] }[] = [];
  for (const ph of phrases) {
    const n = Math.ceil(textLen(ph) / opts.maxChars);
    if (n <= 1) {
      caps.push({ words: ph });
      continue;
    }
    const target = textLen(ph) / n;
    let chunk: TimelineWord[] = [];
    for (let i = 0; i < ph.length; i++) {
      chunk.push(ph[i]);
      const len = textLen(chunk);
      const left = ph.length - i - 1;
      const comma = /,$/.test(ph[i].word) && len >= target * 0.6;
      if (left >= 2 && (len >= target || comma)) {
        caps.push({ words: chunk });
        chunk = [];
      }
    }
    if (chunk.length) caps.push({ words: chunk });
  }
  const out: Caption[] = caps.map((c) => ({ start: c.words[0].start, end: c.words[c.words.length - 1].end, text: c.words.map((w) => w.word).join(' ') }));
  for (let i = 0; i < out.length; i++) {
    const next = out[i + 1];
    let end = Math.max(out[i].end, out[i].start + opts.minDuration);
    if (next) {
      if (next.start - out[i].end < 0.35) end = next.start; // bridge tiny gaps to avoid flicker
      end = Math.min(end, next.start);
    }
    out[i].end = r3(Math.max(end, out[i].start + 0.1));
  }
  return out;
}

export const CAPTION_NOTE = 'auto-caption';

/** Replace the auto-captions in a project with fresh ones (on a "Captions" video track at the top). */
export function applyCaptions(project: Project, captions: Caption[], style: Partial<TextObject> = {}): { track: string; count: number } {
  // remove old auto-captions
  for (const t of project.tracks) t.objects = t.objects.filter((o) => o.note !== CAPTION_NOTE);
  let track: Track | undefined = project.tracks.find((t) => t.kind === 'video' && t.name === 'Captions');
  if (!track) {
    track = addTrack(project, 'video');
    track.name = 'Captions';
  }
  const y = project.project.height / 2 - Math.round(project.project.height * 0.13);
  for (const c of captions) {
    const obj = defaultsFor<TextObject>('text', {
      start: c.start,
      duration: Math.max(0.1, c.end - c.start),
      text: c.text,
      size: Math.round(project.project.height * 0.052),
      bold: true,
      color: '#ffffff',
      outline: { color: '#000000', width: Math.max(3, Math.round(project.project.height * 0.005)) },
      background: { color: '#00000066', padding: 14, radius: 10 },
      transform: { y },
      note: CAPTION_NOTE,
    });
    insertObject(project, track.id, { ...obj, ...style, note: CAPTION_NOTE } as TextObject, false);
  }
  return { track: track.id, count: captions.length };
}

export function removeCaptions(project: Project): number {
  let n = 0;
  for (const t of project.tracks) {
    const before = t.objects.length;
    t.objects = t.objects.filter((o) => o.note !== CAPTION_NOTE);
    n += before - t.objects.length;
  }
  project.tracks = project.tracks.filter((t) => !(t.name === 'Captions' && t.objects.length === 0));
  return n;
}

// ----------------------------------------------------------------------------- export formats

const srtTime = (t: number) => {
  const ms = Math.round(Math.max(0, t) * 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};

export function toSrt(captions: Caption[]): string {
  return captions.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join('\n');
}
