// MP4 export. The browser renders every frame with the same compositor as the preview and streams
// raw RGBA frames here. ffmpeg encodes them and mixes the audio straight from the project description.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { WebSocket } from 'ws';
import type { Project } from '../src/format/schema';
import { isAnimated, valueAt } from '../src/format/values';
import type { Animatable } from '../src/format/schema';
import { projectDir, slugify } from './projects';
import { playedMedia } from '../src/format/groups';

export interface ExportSettings {
  start: number;
  end: number;
  fps: number;
  width: number;
  height: number;
  crf: number;
  fileName?: string;
  /** What the browser sends per frame: raw RGBA pixels (encoded here with x264), or H.264 it encoded itself (copied). */
  video?: 'rgba' | 'h264';
}

function atempoChain(speed: number): string[] {
  const out: string[] = [];
  let s = speed;
  while (s > 2) (out.push('atempo=2'), (s /= 2));
  while (s < 0.5) (out.push('atempo=0.5'), (s /= 0.5));
  if (Math.abs(s - 1) > 1e-6) out.push(`atempo=${s.toFixed(6)}`);
  return out;
}

const f = (n: number) => Math.max(0, n).toFixed(4);

/**
 * ffmpeg volume filter. Keyframed volume becomes a piecewise-linear expression sampled from the
 * curve (so easing/overshoot is kept). `t` inside the filter = seconds since this clip started playing.
 */
function volumeFilter(v: Animatable, skip: number, len: number): string {
  if (!isAnimated(v)) return `volume=${Math.max(0, v).toFixed(4)}`;
  const step = Math.max(1 / 20, len / 200);
  const pts: [number, number][] = [];
  for (let t = 0; t < len + step; t += step) pts.push([Math.min(t, len), Math.max(0, valueAt(v, skip + Math.min(t, len)))]);
  const terms = [`${pts[0][1].toFixed(4)}*lt(t,0)`];
  for (let i = 0; i < pts.length - 1; i++) {
    const [ta, va] = pts[i];
    const [tb, vb] = pts[i + 1];
    if (tb <= ta) continue;
    terms.push(`gte(t,${ta.toFixed(4)})*lt(t,${tb.toFixed(4)})*(${va.toFixed(4)}+${(vb - va).toFixed(4)}*(t-${ta.toFixed(4)})/${(tb - ta).toFixed(4)})`);
  }
  const lastPt = pts[pts.length - 1];
  terms.push(`${lastPt[1].toFixed(4)}*gte(t,${lastPt[0].toFixed(4)})`);
  // ffmpeg's expression parser has a recursion limit, so sum the pieces as a balanced tree (depth ≈ log2 n).
  const tree = (a: string[]): string => (a.length === 1 ? a[0] : `(${tree(a.slice(0, a.length >> 1))}+${tree(a.slice(a.length >> 1))})`);
  // ffmpeg also evaluates once at startup with t = NAN; answer with the first value then
  return `volume='if(isnan(t),${pts[0][1].toFixed(4)},${tree(terms)})':eval=frame`;
}

/**
 * ffmpeg inputs + filter graph for every audible object inside [start, end), including the sounds inside groups.
 * Each media file is opened once and split for every clip that uses it, so a group with hundreds of pops doesn't turn
 * into hundreds of inputs (or a command line longer than Windows allows; the graph itself goes to a script file).
 */
export function buildAudioGraph(project: Project, dir: string, s: ExportSettings, firstInput: number) {
  const anySolo = project.tracks.some((t) => t.kind === 'audio' && t.solo);
  const uses = new Map<string, string[]>(); // file -> filter chains (each starts from its own split of that file)

  for (const { obj: o, track, gain } of playedMedia(project)) {
    if (track.kind === 'audio' && (track.muted || (anySolo && !track.solo))) continue;
    if (!o.enabled) continue;
    if (o.type === 'video' && o.muted) continue;
    const lib = project.library.find((l) => l.id === o.source);
    if (!lib || (lib.kind === 'video' && lib.hasAudio === false)) continue;
    const vol = valueAt(o.volume, 0);
    if ((!isAnimated(o.volume) && vol <= 0) || gain <= 0) continue;
    const clipStart = Math.max(o.start, s.start);
    const clipEnd = Math.min(o.start + o.duration, s.end);
    if (clipEnd <= clipStart + 1e-4) continue;
    const skip = clipStart - o.start; // timeline seconds cut off at the front
    const len = clipEnd - clipStart; // timeline seconds that play
    const from = o.in + skip * o.speed;
    const fl: string[] = [`atrim=start=${f(from)}:duration=${f(len * o.speed)}`, 'asetpts=PTS-STARTPTS', ...atempoChain(o.speed), volumeFilter(o.volume, skip, len)];
    if (gain !== 1) fl.push(`volume=${gain.toFixed(4)}`);
    if (o.fadeIn > skip) fl.push(`afade=t=in:st=0:d=${f(o.fadeIn - skip)}:curve=tri`);
    const tailCut = o.start + o.duration - clipEnd;
    if (o.fadeOut > tailCut) {
      const d = Math.min(o.fadeOut - tailCut, len);
      fl.push(`afade=t=out:st=${f(len - d)}:d=${f(d)}:curve=tri`);
    }
    fl.push(`adelay=${Math.round((clipStart - s.start) * 1000)}:all=1`);
    const file = path.join(dir, lib.file);
    if (!uses.has(file)) uses.set(file, []);
    uses.get(file)!.push(fl.join(','));
  }
  if (!uses.size) return null;

  const inputs: string[] = [];
  const chains: string[] = [];
  const labels: string[] = [];
  let idx = firstInput;
  let n = 0;
  for (const [file, list] of uses) {
    inputs.push('-i', file);
    const outs = list.map((_, i) => `[s${idx}_${i}]`);
    chains.push(list.length === 1 ? `[${idx}:a]anull${outs[0]}` : `[${idx}:a]asplit=${list.length}${outs.join('')}`);
    list.forEach((chain, i) => {
      chains.push(`${outs[i]}${chain}[a${n}]`);
      labels.push(`[a${n}]`);
      n++;
    });
    idx++;
  }
  // Everything is mixed over a silent bed of exactly the export's length. (An endless apad + atrim at the end hangs
  // ffmpeg 8 once an asplit is in the graph.)
  const total = f(s.end - s.start);
  const bed = `anullsrc=r=48000:cl=stereo,atrim=0:${total}[bed]`;
  const mix = `[bed]${labels.join('')}amix=inputs=${labels.length + 1}:normalize=0:duration=first[aout]`;
  return { inputs, filter: [bed, ...chains, mix].join(';\n') };
}

/**
 * All-keyframe copies of the project's videos, used only by the export. The export seeks every video once per frame,
 * and in a normal file (a keyframe every few seconds) each seek decodes from the last keyframe: ~90-180 ms a frame.
 * With every frame a keyframe a seek decodes one frame (~7 ms). Cached in media/.export-proxies until the file changes.
 */
const proxyJobs = new Map<string, Promise<string>>();

function makeProxy(dir: string, rel: string): Promise<string> {
  const src = path.join(dir, rel);
  const st = fs.statSync(src);
  const base = path.basename(rel);
  const outRel = `media/.export-proxies/${base}.${st.size}-${Math.round(st.mtimeMs)}.mp4`;
  const out = path.join(dir, outRel);
  if (fs.existsSync(out)) return Promise.resolve(outRel);
  let job = proxyJobs.get(out);
  if (job) return job;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  // older proxies of the same file are stale now
  for (const f of fs.readdirSync(path.dirname(out))) if (f.startsWith(base + '.') && f !== path.basename(out)) fs.rmSync(path.join(path.dirname(out), f), { force: true });
  const tmp = out + '.part.mp4';
  job = new Promise<string>((resolve, reject) => {
    const args = ['-y', '-v', 'error', '-i', src, '-map', '0:v:0', '-an', '-fps_mode', 'passthrough', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '15', '-g', '1', '-pix_fmt', 'yuv420p', tmp];
    const proc = spawn('ffmpeg', args);
    let err = '';
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) {
        fs.renameSync(tmp, out);
        resolve(outRel);
      } else {
        fs.rmSync(tmp, { force: true });
        reject(new Error(err.slice(-500) || `ffmpeg exited with ${code}`));
      }
    });
  }).finally(() => proxyJobs.delete(out));
  proxyJobs.set(out, job);
  return job;
}

/** Library file -> its export proxy. Files that fail keep using the original (slower to seek, same picture). */
export async function exportProxies(projectName: string, files: string[]): Promise<Record<string, string>> {
  const dir = projectDir(projectName);
  const map: Record<string, string> = {};
  for (const rel of new Set(files)) {
    if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..') || !fs.existsSync(path.join(dir, rel))) continue;
    try {
      map[rel] = await makeProxy(dir, rel);
    } catch (e) {
      console.warn(`export proxy for ${rel} failed:`, (e as Error).message);
    }
  }
  return map;
}

export class ExportJob {
  proc: ChildProcessWithoutNullStreams;
  file: string;
  stderr = '';
  frames = 0;
  graphFile: string | null = null;

  constructor(projectName: string, project: Project, s: ExportSettings, private ws: WebSocket) {
    const dir = projectDir(projectName);
    fs.mkdirSync(path.join(dir, 'renders'), { recursive: true });
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    this.file = path.join(dir, 'renders', `${slugify(s.fileName || project.project.name)}-${stamp}.mp4`);

    const h264 = s.video === 'h264';
    const args = h264
      ? ['-y', '-v', 'error', '-f', 'h264', '-framerate', String(s.fps), '-i', 'pipe:0']
      : ['-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${s.width}x${s.height}`, '-framerate', String(s.fps), '-i', 'pipe:0'];
    const audio = buildAudioGraph(project, dir, s, 1);
    if (audio) args.push(...audio.inputs);
    const vf = `scale=${s.width}:${s.height}:flags=lanczos,format=yuv420p`;
    if (audio) {
      // the graph can be long (one chain per sound), so it goes in a file instead of on the command line
      this.graphFile = this.file.replace(/\.mp4$/, '.filtergraph.txt');
      fs.writeFileSync(this.graphFile, h264 ? audio.filter : `[0:v]${vf}[vout];\n${audio.filter}`);
      args.push('-/filter_complex', this.graphFile, '-map', h264 ? '0:v' : '[vout]', '-map', '[aout]', '-c:a', 'aac', '-b:a', '192k');
    } else if (!h264) args.push('-vf', vf);
    // A raw H.264 stream has no timestamps, and ffmpeg's guesses can collapse (on macOS/VideoToolbox, every frame after
    // ~1.7 s landed 1 µs apart, so players showed 2 s and then nothing). Frames arrive in order with no B-frames, so
    // stamp them by count instead.
    if (h264) args.push('-bsf:v', `setts=ts=N/(${s.fps}*TB):duration=1/(${s.fps}*TB)`, '-c:v', 'copy');
    else args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', String(s.crf), '-r', String(s.fps));
    args.push('-t', f(s.end - s.start), '-movflags', '+faststart', this.file);

    this.proc = spawn('ffmpeg', args);
    this.proc.stderr.on('data', (d) => (this.stderr += d.toString()));
    this.proc.stdin.on('error', () => {});
    this.proc.on('close', (code) => {
      if (this.graphFile) fs.rm(this.graphFile, { force: true }, () => {});
      if (code === 0) this.send({ type: 'export-done', file: path.relative(dir, this.file).replace(/\\/g, '/'), project: projectName });
      else if (code !== null) this.send({ type: 'export-error', message: this.stderr.slice(-2000) || `ffmpeg exited with ${code}` });
    });
  }

  private send(msg: object) {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Write one frame (raw RGBA, or one encoded H.264 frame); ack once ffmpeg has accepted it so the client can throttle. */
  frame(buf: Buffer) {
    const n = ++this.frames;
    const ok = this.proc.stdin.write(buf);
    if (ok) this.send({ type: 'export-ack', frame: n });
    else this.proc.stdin.once('drain', () => this.send({ type: 'export-ack', frame: n }));
  }

  finish() {
    this.proc.stdin.end();
  }

  cancel() {
    this.proc.kill('SIGKILL');
    setTimeout(() => fs.rm(this.file, { force: true }, () => {}), 500);
  }
}
