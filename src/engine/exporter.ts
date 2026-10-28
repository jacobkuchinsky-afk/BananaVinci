// Frame-by-frame export: seek media, render with the shared compositor, stream raw RGBA frames to the server's ffmpeg.
// (Raw pixels instead of canvas.toBlob(): toBlob is scheduled as an idle task and can take ~1s per frame.)
import { isActiveAt, sourceTimeAt } from '../format/values';
import type { LibraryItem, Project } from '../format/schema';
import { editor, toast } from '../state/store';
import { getSocket, onMessage } from '../state/sync';
import { renderFrame, type FrameSources } from './compositor';
import { playedMedia } from '../format/groups';
import { getImage, getVideo, imageReady, releasePurpose } from './mediaCache';

export interface ExportOptions {
  start: number;
  end: number;
  scale: number; // 1 = project resolution
  crf: number;
  fileName: string;
}

let cancelled = false;
export const cancelExport = () => {
  cancelled = true;
  getSocket()?.send(JSON.stringify({ type: 'export-cancel' }));
};

function seek(v: HTMLVideoElement, time: number): Promise<void> {
  return new Promise((resolve) => {
    const ready = () => v.readyState >= 2;
    if (Math.abs(v.currentTime - time) < 1e-3 && ready()) return resolve();
    const done = () => {
      clearTimeout(timer);
      v.removeEventListener('seeked', done);
      v.removeEventListener('loadeddata', onLoad);
      resolve();
    };
    const onLoad = () => {
      v.currentTime = time;
    };
    const timer = setTimeout(done, 2500);
    v.addEventListener('seeked', done);
    if (v.readyState >= 1) v.currentTime = time;
    else v.addEventListener('loadeddata', onLoad, { once: true });
  });
}

/**
 * All-keyframe copies of the videos playing in [start, end) (made once by the server, see exportProxies). Seeking one
 * decodes a single frame instead of everything since the last keyframe, which was most of the export time.
 */
async function videoProxies(p: Project, name: string, start: number, end: number): Promise<Record<string, string>> {
  const files = new Set<string>();
  for (const { obj: o, track } of playedMedia(p)) {
    if (track.kind !== 'video' || track.hidden || o.type !== 'video' || o.start >= end || o.start + o.duration <= start) continue;
    const item = p.library.find((l) => l.id === o.source);
    if (item) files.add(item.file);
  }
  if (!files.size) return {};
  try {
    const r = await fetch(`/api/projects/${encodeURIComponent(name)}/export-proxies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ files: [...files] }),
    });
    return r.ok ? (await r.json()).proxies ?? {} : {};
  } catch {
    return {}; // the originals still work, just slower
  }
}

/**
 * The browser's hardware H.264 encoder (WebCodecs), if it has one. Frames then go to ffmpeg already encoded (tens of
 * KB) instead of as raw pixels (8 MB a 1080p frame), which capped the export at ~10 fps on the websocket alone, and
 * the canvas never has to be read back. `null` = fall back to raw pixels, encoded by ffmpeg's x264.
 */
async function h264Config(width: number, height: number, fps: number): Promise<VideoEncoderConfig | null> {
  if (typeof VideoEncoder === 'undefined') return null;
  // High profile, level 5.1 (fits up to 4K30), else 4.0 (1080p)
  for (const codec of ['avc1.640033', 'avc1.640028']) {
    const cfg: VideoEncoderConfig = { codec, width, height, framerate: fps, hardwareAcceleration: 'prefer-hardware', bitrateMode: 'quantizer', avc: { format: 'annexb' } };
    try {
      if ((await VideoEncoder.isConfigSupported(cfg)).supported) return cfg;
    } catch {
      /* try the next one */
    }
  }
  return null;
}

async function waitImages(p: Project) {
  const imgs = p.library.filter((l) => l.kind === 'image');
  // getImage starts loading anything not requested yet (otherwise this waited out its full 15 s on unseen images)
  for (let i = 0; i < 300 && imgs.some((l) => (getImage(l), !imageReady(l))); i++) await new Promise((r) => setTimeout(r, 50));
}

export async function runExport(project: Project, opts: ExportOptions) {
  const ws = getSocket();
  const name = editor.get().projectName;
  if (!ws || !name) return toast('Not connected to the BananaVinci server', 'error');
  cancelled = false;

  const fps = project.project.fps;
  const width = Math.round((project.project.width * opts.scale) / 2) * 2;
  const height = Math.round((project.project.height * opts.scale) / 2) * 2;
  const total = Math.max(1, Math.round((opts.end - opts.start) * fps));
  editor.set({ exportProgress: { frame: 0, total, status: 'preparing' } });
  const proxies = await videoProxies(project, name, opts.start, opts.end);
  if (cancelled) return editor.set({ exportProgress: { frame: 0, total, status: 'cancelled' } });
  const proxied = (item: LibraryItem): LibraryItem => (proxies[item.file] ? { ...item, file: proxies[item.file] } : item);
  editor.set({ exportProgress: { frame: 0, total, status: 'rendering' } });

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  // No willReadFrequently: that keeps the canvas on the CPU, where the blurs and filters cost ~40 ms a frame. On the
  // GPU a frame takes a few ms. (It's also the same renderer the preview uses.)
  const ctx = canvas.getContext('2d')!;
  const h264 = await h264Config(width, height, fps);
  await document.fonts.ready;
  await waitImages(project);

  const sources: FrameSources = {
    image: (item, localT) => getImage(item, localT),
    video: (obj, item) => getVideo(obj.id, proxied(item), 'export'),
  };

  let acked = 0;
  let finished: ((v: { ok: boolean; file?: string; message?: string }) => void) | null = null;
  const result = new Promise<{ ok: boolean; file?: string; message?: string }>((r) => (finished = r));
  let ready: () => void = () => {};
  const readyP = new Promise<void>((r) => (ready = r));
  let ackWaiter: (() => void) | null = null;
  const off = onMessage((msg) => {
    if (msg.type === 'export-ready') ready();
    if (msg.type === 'export-ack') {
      acked = msg.frame;
      ackWaiter?.();
    }
    if (msg.type === 'export-done') finished?.({ ok: true, file: msg.file });
    if (msg.type === 'export-error') {
      ready();
      finished?.({ ok: false, message: msg.message });
    }
  });

  ws.send(
    JSON.stringify({
      type: 'export-start',
      projectName: name,
      project,
      settings: { start: opts.start, end: opts.end, fps, width, height, crf: opts.crf, fileName: opts.fileName, video: h264 ? 'h264' : 'rgba' },
    }),
  );
  await readyP;

  // One encoded frame per websocket message, sent as soon as the encoder hands it over; acks throttle them like raw frames.
  let sent = 0;
  let encoderError = '';
  const encoder = h264
    ? new VideoEncoder({
        output: (chunk) => {
          const b = new Uint8Array(chunk.byteLength);
          chunk.copyTo(b);
          ws.send(b);
          sent++;
        },
        error: (e) => {
          encoderError = String(e?.message ?? e);
          ackWaiter?.();
        },
      })
    : null;
  if (encoder && h264) {
    encoder.configure(h264);
    encoder.addEventListener('dequeue', () => ackWaiter?.());
  }

  const began = performance.now();
  try {
    for (let f = 0; f < total; f++) {
      if (cancelled || encoderError) break;
      const t = opts.start + f / fps;
      // Browsers stop decoding video in hidden tabs, which would stall every seek.
      while (document.hidden && !cancelled) {
        editor.set({ exportProgress: { frame: f, total, status: 'rendering', message: 'Paused: keep this tab visible while exporting' } });
        await new Promise((r) => setTimeout(r, 250));
      }
      const seeks: Promise<void>[] = [];
      for (const { obj: o, track } of playedMedia(project)) {
        if (track.kind !== 'video' || track.hidden || o.type !== 'video' || !isActiveAt(o, t)) continue;
        const item = project.library.find((l) => l.id === o.source);
        if (item) seeks.push(seek(getVideo(o.id, proxied(item), 'export'), sourceTimeAt(o, t) + 0.0005));
      }
      await Promise.all(seeks);
      renderFrame(ctx, project, t, sources);
      if (encoder) {
        while ((encoder.encodeQueueSize > 4 || sent - acked > 8) && !cancelled && !encoderError) await new Promise<void>((r) => (ackWaiter = r));
        ackWaiter = null;
        const frame = new VideoFrame(canvas, { timestamp: Math.round((f * 1e6) / fps), duration: Math.round(1e6 / fps) });
        // a keyframe every 2 s; the quantizer plays the part of x264's CRF (same numbers, same look)
        // (`avc.quantizer` is in Chrome but not yet in TypeScript's DOM types)
        encoder.encode(frame, { keyFrame: f % (fps * 2) === 0, avc: { quantizer: opts.crf } } as VideoEncoderEncodeOptions);
        frame.close();
      } else {
        const buf = ctx.getImageData(0, 0, width, height).data.buffer;
        while (f + 1 - acked > 4 && !cancelled) await new Promise<void>((r) => (ackWaiter = r));
        ackWaiter = null;
        ws.send(buf);
      }
      if (f % 3 === 0 || f === total - 1) {
        const speed = (f + 1) / ((performance.now() - began) / 1000);
        editor.set({ exportProgress: { frame: f + 1, total, status: 'rendering', speed } });
      }
    }
    if (encoder && !cancelled && !encoderError) await encoder.flush().catch((e) => (encoderError ||= String(e?.message ?? e)));
    if (encoderError) {
      ws.send(JSON.stringify({ type: 'export-cancel' }));
      editor.set({ exportProgress: { frame: 0, total, status: 'error', message: `Video encoder failed: ${encoderError}` } });
      return;
    }
    if (cancelled) {
      editor.set({ exportProgress: { frame: 0, total, status: 'cancelled' } });
      return;
    }
    editor.set({ exportProgress: { frame: total, total, status: 'encoding' } });
    ws.send(JSON.stringify({ type: 'export-end' }));
    const r = await result;
    if (r.ok) {
      editor.set({ exportProgress: { frame: total, total, status: 'done', file: r.file } });
      toast(`Exported ${r.file}`, 'success');
    } else editor.set({ exportProgress: { frame: 0, total, status: 'error', message: r.message } });
  } finally {
    if (encoder?.state === 'configured') encoder.close();
    off();
    releasePurpose('export');
  }
}
