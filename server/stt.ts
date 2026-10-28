// Speech-to-text: transcribe library media with faster-whisper (word timestamps), cache the
// results per file, and keep an AI-readable timeline transcript next to the project file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import YAML from 'yaml';
import { parseProject } from '../src/format/parse';
import type { LibraryItem, Project } from '../src/format/schema';
import { buildCaptions, timelineTranscript, toSrt, type SourceTranscript } from '../src/format/transcript';
import { ROOT, projectDir, projectFile, slugify } from './projects';

const run = promisify(execFile);
const WORKER = path.join(ROOT, 'scripts', 'stt_worker.py');
// BANANA_PYTHON wins; otherwise use the project's own .venv if there is one, then the system Python.
const VENV_PYTHON = path.join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
export const PYTHON =
  process.env.BANANA_PYTHON ||
  (fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : process.platform === 'win32' ? 'python' : 'python3');

export interface SttProgress {
  phase: 'preparing' | 'transcribing' | 'done' | 'error';
  item?: string;
  index?: number;
  total?: number;
  pct?: number; // 0..1 within the current item
  message?: string;
}

// ----------------------------------------------------------------------------- engine discovery

let engineCheck: Promise<{ ok: boolean; message: string }> | null = null;

/** Is faster-whisper importable? (cached) */
export function checkEngine() {
  engineCheck ??= run(PYTHON, ['-c', 'import faster_whisper; print(faster_whisper.__version__)'])
    .then(({ stdout }) => ({ ok: true, message: `faster-whisper ${stdout.trim()}` }))
    .catch(() => ({
      ok: false,
      message: `faster-whisper is not installed for "${PYTHON}". Install it with:  ${PYTHON} -m pip install faster-whisper`,
    }));
  return engineCheck;
}

/** faster-whisper models already in the Hugging Face cache (no download needed). */
export function cachedModels(): string[] {
  const hub = process.env.HF_HOME ? path.join(process.env.HF_HOME, 'hub') : path.join(os.homedir(), '.cache', 'huggingface', 'hub');
  try {
    const found = fs
      .readdirSync(hub)
      .map((d) => /^models--Systran--faster-whisper-(.+)$/.exec(d)?.[1])
      .filter((m): m is string => !!m);
    const order = ['tiny.en', 'tiny', 'base.en', 'base', 'small.en', 'small', 'medium.en', 'medium', 'large-v3'];
    const rank = (m: string) => (order.includes(m) ? order.indexOf(m) : order.length);
    return found.sort((a, b) => rank(a) - rank(b));
  } catch {
    return [];
  }
}

export function defaultModel(): string {
  const models = cachedModels();
  return ['small.en', 'small', 'base.en', 'base', 'medium.en', 'tiny.en'].find((m) => models.includes(m)) ?? models[0] ?? 'base.en';
}

// ----------------------------------------------------------------------------- source transcripts

const transcriptsDir = (name: string) => path.join(projectDir(name), 'transcripts');
const sourcePath = (name: string, id: string) => path.join(transcriptsDir(name), `${id}.json`);

/** Library items that can contain speech. */
export const speechItems = (p: Project) => p.library.filter((l) => l.kind === 'audio' || (l.kind === 'video' && l.hasAudio !== false));

function isFresh(name: string, item: LibraryItem, t: SourceTranscript | null) {
  if (!t || t.file !== item.file) return false;
  try {
    const st = fs.statSync(path.join(projectDir(name), item.file));
    return st.size === t.fileSize && Math.abs(st.mtimeMs - t.fileMtime) < 1;
  } catch {
    return false;
  }
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** All up-to-date source transcripts of a project, keyed by library id. */
export function loadSourceTranscripts(name: string, project: Project): Record<string, SourceTranscript> {
  const out: Record<string, SourceTranscript> = {};
  for (const item of speechItems(project)) {
    const t = readJson<SourceTranscript>(sourcePath(name, item.id));
    if (t && isFresh(name, item, t)) out[item.id] = t;
  }
  return out;
}

function runWorker(wav: string, json: string, model: string, onPct: (p: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, PYTHONIOENCODING: 'utf-8' };
    if (cachedModels().includes(model)) env.HF_HUB_OFFLINE = '1'; // already downloaded: never touch the network
    const p = spawn(PYTHON, [WORKER, wav, json, '--model', model], { env });
    let err = '';
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? '';
      for (const l of lines) {
        const m = /^PROGRESS ([\d.]+)/.exec(l);
        if (m) onPct(Number(m[1]));
      }
    });
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.split('\n').filter(Boolean).slice(-6).join('\n') || `worker exited with ${code}`))));
  });
}

/**
 * Transcribe every speech-carrying library item that has no up-to-date transcript (or all of
 * them with `force`). Calls `onProgress` along the way. Returns the ids that were transcribed.
 */
export async function transcribeProject(
  name: string,
  opts: { model?: string; force?: boolean; ids?: string[] } = {},
  onProgress: (p: SttProgress) => void = () => {},
): Promise<string[]> {
  const engine = await checkEngine();
  if (!engine.ok) throw new Error(engine.message);
  const file = projectFile(name);
  if (!file) throw new Error(`no project "${name}"`);
  const parsed = parseProject(fs.readFileSync(file, 'utf8'));
  if (!parsed.ok) throw new Error(`${file} has errors: ${parsed.errors[0].message}`);
  const project = parsed.project;
  const model = opts.model || defaultModel();
  const dir = projectDir(name);
  fs.mkdirSync(transcriptsDir(name), { recursive: true });

  const todo = speechItems(project).filter((item) => (!opts.ids || opts.ids.includes(item.id)) && (opts.force || !isFresh(name, item, readJson(sourcePath(name, item.id)))));
  const done: string[] = [];
  for (let i = 0; i < todo.length; i++) {
    const item = todo[i];
    const base = { item: item.id, index: i + 1, total: todo.length };
    onProgress({ phase: 'preparing', ...base, pct: 0 });
    const tmp = path.join(os.tmpdir(), `bv-stt-${process.pid}-${slugify(item.id)}`);
    const wav = `${tmp}.wav`;
    const json = `${tmp}.json`;
    try {
      // 16 kHz mono is what whisper wants
      await run('ffmpeg', ['-y', '-v', 'error', '-i', path.join(dir, item.file), '-vn', '-ac', '1', '-ar', '16000', wav]);
      await runWorker(wav, json, model, (pct) => onProgress({ phase: 'transcribing', ...base, pct }));
      const res = JSON.parse(fs.readFileSync(json, 'utf8'));
      const st = fs.statSync(path.join(dir, item.file));
      const t: SourceTranscript = {
        source: item.id,
        file: item.file,
        fileSize: st.size,
        fileMtime: st.mtimeMs,
        engine: res.engine,
        model: res.model,
        language: res.language,
        duration: res.duration,
        createdAt: new Date().toISOString(),
        segments: res.segments,
      };
      fs.writeFileSync(sourcePath(name, item.id), JSON.stringify(t));
      done.push(item.id);
    } finally {
      fs.rmSync(wav, { force: true });
      fs.rmSync(json, { force: true });
    }
  }
  writeTimelineTranscript(name, project);
  onProgress({ phase: 'done', total: todo.length });
  return done;
}

// ----------------------------------------------------------------------------- the AI-readable timeline transcript

export function transcriptFiles(name: string) {
  const file = projectFile(name);
  const base = file ? file.replace(/\.banana$/, '') : path.join(projectDir(name), slugify(name));
  return { yaml: `${base}.transcript.yaml`, srt: `${base}.srt` };
}

/** Write <name>.transcript.yaml (timeline times, word level) and <name>.srt. No-op if nothing is transcribed. */
export function writeTimelineTranscript(name: string, project: Project): boolean {
  const sources = loadSourceTranscripts(name, project);
  if (!Object.keys(sources).length) return false;
  const segs = timelineTranscript(project, sources);
  const { yaml, srt } = transcriptFiles(name);
  const doc = new YAML.Document({
    project: project.project.name,
    generated: new Date().toISOString(),
    sources: Object.fromEntries(Object.values(sources).map((s) => [s.source, { file: s.file, model: s.model, language: s.language, duration: s.duration }])),
    segments: segs.map((s) => ({
      start: s.start,
      end: s.end,
      object: s.object,
      track: s.track,
      source: s.source,
      sourceTime: [s.sourceStart, s.sourceEnd],
      text: s.text,
      words: s.words.map((w) => [w.start, w.end, w.word]),
    })),
  });
  doc.commentBefore = ` Timeline transcript — AUTO-GENERATED by BananaVinci (do not edit; regenerated when the project changes).
 All times are TIMELINE SECONDS: use them directly for start / duration in the .banana file.
 segments[].object = the timeline object that plays this speech; source = its library id;
 sourceTime = the same span in the source file's own time (for the object's "in").
 words: [start, end, "word"]. Words cut out by the edit are not listed.
 Re-transcribe with:  npm run transcribe -- ${name}`;
  YAML.visit(doc, {
    Pair(_, pair: any) {
      const key = String(pair.key?.value ?? '');
      if (key === 'sourceTime' || key === 'words') pair.value.flow = true;
    },
  });
  fs.writeFileSync(yaml, doc.toString({ lineWidth: 0 }));
  fs.writeFileSync(srt, toSrt(buildCaptions(segs)));
  return true;
}

const pending = new Map<string, ReturnType<typeof setTimeout>>();
/** Debounced: regenerate the timeline transcript after the project file changed. */
export function scheduleTranscriptRefresh(name: string, text: string) {
  clearTimeout(pending.get(name));
  pending.set(
    name,
    setTimeout(() => {
      pending.delete(name);
      const r = parseProject(text);
      if (r.ok) {
        try {
          writeTimelineTranscript(name, r.project);
        } catch {
          /* best effort */
        }
      }
    }, 400),
  );
}
