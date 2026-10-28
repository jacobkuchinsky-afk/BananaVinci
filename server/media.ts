// Media import: copy into <project>/media, probe with ffprobe, convert what the browser can't decode,
// make thumbnails for videos.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { LibraryItem } from '../src/format/schema';
import { CONVERTED, NATIVE, SUPPORTED } from '../src/format/mediaTypes';

export { SUPPORTED };

const run = promisify(execFile);

const { image: IMAGE, audio: AUDIO, video: VIDEO } = NATIVE;
const ALL_IMAGE = [...IMAGE, ...CONVERTED.image];
const ALL_AUDIO = [...AUDIO, ...CONVERTED.audio];
const ALL_VIDEO = [...VIDEO, ...CONVERTED.video];

// Codecs Chromium plays in <video>/<audio> (HEVC needs a hardware decoder, which current Windows/macOS machines have).
const WEB_VIDEO_CODECS = ['h264', 'hevc', 'vp8', 'vp9', 'av1'];
const WEB_AUDIO_CODECS = ['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le', 'pcm_u8'];
/** Audio codecs browsers play inside an MP4/MOV next to the picture (PCM there is not played). */
const MP4_AUDIO_CODECS = ['aac', 'mp3', 'opus', 'flac'];

export function kindOf(file: string): LibraryItem['kind'] | null {
  const ext = path.extname(file).toLowerCase();
  if (ALL_IMAGE.includes(ext)) return 'image';
  if (ALL_AUDIO.includes(ext)) return 'audio';
  if (ALL_VIDEO.includes(ext)) return 'video';
  return null;
}

export function safeFileName(dir: string, original: string): string {
  const ext = path.extname(original).toLowerCase();
  const base = path.basename(original, path.extname(original)).replace(/[^a-zA-Z0-9_\-. ]+/g, '').trim().replace(/\s+/g, '_') || 'file';
  let name = `${base}${ext}`;
  let n = 2;
  while (fs.existsSync(path.join(dir, name))) name = `${base}_${n++}${ext}`;
  return name;
}

interface Probe {
  width?: number;
  height?: number;
  duration?: number;
  hasAudio?: boolean;
  hasVideo?: boolean;
  videoCodec?: string;
  audioCodec?: string;
  pixFmt?: string;
}

export async function probe(file: string): Promise<Probe> {
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]);
    const j = JSON.parse(stdout);
    // cover art in mp3/m4a files shows up as a video stream, but it isn't picture content
    const v = j.streams?.find((s: any) => s.codec_type === 'video' && !s.disposition?.attached_pic);
    const a = j.streams?.find((s: any) => s.codec_type === 'audio');
    const dur = parseFloat(j.format?.duration ?? v?.duration ?? a?.duration);
    let width = v?.width;
    let height = v?.height;
    const rot = Number(v?.tags?.rotate ?? v?.side_data_list?.find((d: any) => d.rotation !== undefined)?.rotation ?? 0);
    if (Math.abs(rot) % 180 === 90) [width, height] = [height, width];
    return {
      width,
      height,
      duration: Number.isFinite(dur) ? Math.round(dur * 1000) / 1000 : undefined,
      hasAudio: !!a,
      hasVideo: !!v,
      videoCodec: v?.codec_name,
      audioCodec: a?.codec_name,
      pixFmt: v?.pix_fmt,
    };
  } catch {
    return {};
  }
}

export async function makeThumbnail(projectDir: string, relFile: string, duration?: number) {
  const out = path.join(projectDir, 'media', '.thumbs', path.basename(relFile) + '.jpg');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const at = Math.min(1, (duration ?? 0) / 3);
  try {
    await run('ffmpeg', ['-y', '-v', 'error', '-ss', String(at), '-i', path.join(projectDir, relFile), '-frames:v', '1', '-vf', 'scale=320:-2', out]);
  } catch {
    /* thumbnail is optional */
  }
}

/**
 * How to turn a file into one the browser can decode, or null if it already can. Video whose picture
 * plays but whose sound doesn't only has its audio re-encoded (fast); anything else becomes an
 * H.264/AAC MP4, a PNG or an AAC M4A.
 */
function conversionFor(fileName: string, kind: LibraryItem['kind'], info: Probe): { ext: string; args: string[] } | null {
  const ext = path.extname(fileName).toLowerCase();
  if (kind === 'image') return IMAGE.includes(ext) ? null : { ext: '.png', args: ['-frames:v', '1', '-update', '1'] };
  const aac = ['-c:a', 'aac', '-b:a', '256k'];
  if (kind === 'audio' || info.hasVideo === false) {
    const known = AUDIO.includes(ext) || VIDEO.includes(ext);
    if (known && (!info.audioCodec || WEB_AUDIO_CODECS.includes(info.audioCodec))) return null;
    return { ext: '.m4a', args: ['-vn', ...aac] };
  }
  const codec = info.videoCodec ?? '';
  // Chromium has no decoder for 10/12-bit H.264
  const pictureOk = WEB_VIDEO_CODECS.includes(codec) && !(codec === 'h264' && /1[02]/.test(info.pixFmt ?? ''));
  const isMp4 = ['.mp4', '.mov', '.m4v'].includes(ext);
  const soundOk = !info.audioCodec || (isMp4 ? MP4_AUDIO_CODECS : WEB_AUDIO_CODECS).includes(info.audioCodec);
  if (VIDEO.includes(ext) && pictureOk && soundOk) return null;
  const video = pictureOk && ['h264', 'hevc', 'av1'].includes(codec) ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p'];
  const audio = info.audioCodec && ['aac', 'mp3'].includes(info.audioCodec) ? ['-c:a', 'copy'] : aac;
  return { ext: '.mp4', args: ['-map', '0:v:0', '-map', '0:a:0?', ...video, ...audio, '-movflags', '+faststart'] };
}

/**
 * Convert a file in <project>/media into a browser-friendly copy if needed. The converted file replaces
 * the imported one. Returns the file name to use and its probe info.
 */
async function browserFriendly(projectDir: string, fileName: string, kind: LibraryItem['kind'], info: Probe): Promise<{ fileName: string; info: Probe }> {
  const conv = conversionFor(fileName, kind, info);
  if (!conv) return { fileName, info };
  const mediaDir = path.join(projectDir, 'media');
  const src = path.join(mediaDir, fileName);
  const sameExt = path.extname(fileName).toLowerCase() === conv.ext;
  const out = sameExt ? fileName : safeFileName(mediaDir, path.basename(fileName, path.extname(fileName)) + conv.ext);
  const tmp = path.join(mediaDir, `.${out}.converting${conv.ext}`);
  try {
    await run('ffmpeg', ['-y', '-v', 'error', '-i', src, ...conv.args, tmp], { maxBuffer: 16 * 1024 * 1024 });
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    const why = String((e as { stderr?: string }).stderr || e).trim().split('\n').pop();
    throw new Error(`could not convert ${fileName} into a format the browser can play: ${why}`);
  }
  if (!sameExt) fs.rmSync(src, { force: true });
  fs.renameSync(tmp, path.join(mediaDir, out));
  return { fileName: out, info: await probe(path.join(mediaDir, out)) };
}

/**
 * Build a library entry (without a unique id; the client picks one) for a file already in <project>/media.
 * Files the browser can't decode (AVI, ProRes, TIFF, AIFF...) are converted first, so `file` may not
 * point at `importedName`.
 */
export async function describeMedia(projectDir: string, importedName: string): Promise<Omit<LibraryItem, 'id'> & { suggestedId: string }> {
  const importedKind = kindOf(importedName)!;
  const probed = importedKind === 'image' && importedName.toLowerCase().endsWith('.svg') ? {} : await probe(path.join(projectDir, 'media', importedName));
  const { fileName, info } = await browserFriendly(projectDir, importedName, importedKind, probed);
  const rel = `media/${fileName}`;
  const kind = kindOf(fileName)!;
  const item: Omit<LibraryItem, 'id'> & { suggestedId: string } = {
    suggestedId: path
      .basename(fileName, path.extname(fileName))
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || kind,
    file: rel,
    kind: kind === 'video' && info.hasVideo === false ? 'audio' : kind,
  };
  if (info.width) item.width = info.width;
  if (info.height) item.height = info.height;
  if (item.kind !== 'image' && info.duration) item.duration = info.duration;
  if (item.kind === 'video') {
    item.hasAudio = !!info.hasAudio;
    await makeThumbnail(projectDir, rel, info.duration);
  }
  return item;
}

/**
 * Save a microphone recording (whatever the browser produced, usually webm/opus) as a clean
 * 48 kHz mono WAV in <project>/media, and describe it for the library.
 */
export async function saveRecording(projectDir: string, data: Buffer) {
  const mediaDir = path.join(projectDir, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });
  const fileName = safeFileName(mediaDir, 'voice.wav');
  const tmp = path.join(mediaDir, `.${fileName}.upload`);
  fs.writeFileSync(tmp, data);
  try {
    await run('ffmpeg', ['-y', '-v', 'error', '-i', tmp, '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', path.join(mediaDir, fileName)]);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return describeMedia(projectDir, fileName);
}
