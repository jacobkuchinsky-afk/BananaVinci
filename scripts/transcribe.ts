// Transcribe a project's audio (speech-to-text with word timestamps) from the command line.
//
//   npm run transcribe -- <project> [--model small.en] [--force] [--captions] [--remove-captions]
//
// <project> is a name in projects/ (e.g. my-video) or a path to a .banana file.
// Writes:
//   projects/<name>/transcripts/<library-id>.json   word timings in each media file's own time (cache)
//   projects/<name>/<name>.transcript.yaml          word timings in TIMELINE seconds (read this to edit)
//   projects/<name>/<name>.srt                      captions as subtitles
// --captions also adds caption text objects to the .banana file (an open editor reloads it live).
import fs from 'node:fs';
import path from 'node:path';
import { parseProject } from '../src/format/parse';
import { serializeProject } from '../src/format/serialize';
import { applyCaptions, buildCaptions, removeCaptions, timelineTranscript } from '../src/format/transcript';
import { cachedModels, checkEngine, defaultModel, loadSourceTranscripts, transcribeProject, transcriptFiles, writeTimelineTranscript } from '../server/stt';
import { projectFile, writeProject } from '../server/projects';

const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const opt = (f: string) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};
const target = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--model');
if (!target) {
  console.error('usage: npm run transcribe -- <project-name | path/to/file.banana> [--model small.en] [--force] [--captions] [--remove-captions]');
  process.exit(2);
}
const name = target.endsWith('.banana') ? path.basename(path.dirname(path.resolve(target))) : target;

async function main() {
  const file = projectFile(name);
  if (!file) throw new Error(`project "${name}" not found in projects/`);

  if (!flag('--remove-captions')) {
    const engine = await checkEngine();
    if (!engine.ok) throw new Error(engine.message);
    const model = opt('--model') ?? defaultModel();
    console.log(`Transcribing "${name}" with ${engine.message}, model ${model} (cached models: ${cachedModels().join(', ') || 'none'})`);
    let last = '';
    const ids = await transcribeProject(name, { model, force: flag('--force') }, (p) => {
      if (p.phase === 'transcribing' || p.phase === 'preparing') {
        const line = `  [${p.index}/${p.total}] ${p.item}: ${Math.round((p.pct ?? 0) * 100)}%`;
        if (line !== last) process.stdout.write(`\r${line}   `);
        last = line;
      }
    });
    process.stdout.write('\n');
    console.log(ids.length ? `Transcribed: ${ids.join(', ')}` : 'All media already transcribed (use --force to redo).');
  }

  const parsed = parseProject(fs.readFileSync(file, 'utf8'));
  if (!parsed.ok) throw new Error(`${file} has errors`);
  const project = parsed.project;
  const sources = loadSourceTranscripts(name, project);
  const segs = timelineTranscript(project, sources);

  if (flag('--captions') || flag('--remove-captions')) {
    if (flag('--remove-captions')) console.log(`Removed ${removeCaptions(project)} auto-captions.`);
    else {
      const r = applyCaptions(project, buildCaptions(segs));
      console.log(`Added ${r.count} captions on track ${r.track}.`);
    }
    writeProject(name, serializeProject(project));
  }
  writeTimelineTranscript(name, project);

  const files = transcriptFiles(name);
  console.log(`\nTimeline transcript: ${path.relative(process.cwd(), files.yaml)}  (${segs.length} segments, ${segs.reduce((n, s) => n + s.words.length, 0)} words)`);
  console.log(`Subtitles:           ${path.relative(process.cwd(), files.srt)}`);
  for (const s of segs.slice(0, 8)) console.log(`  ${s.start.toFixed(2).padStart(7)}–${s.end.toFixed(2).padEnd(7)} ${s.object.padEnd(16)} ${s.text}`);
  if (segs.length > 8) console.log(`  … ${segs.length - 8} more`);
}

main().catch((e) => {
  console.error(`✗ ${e.message ?? e}`);
  process.exit(1);
});
