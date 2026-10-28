// Loads and keeps the browser elements that back library items and timeline objects.
import type { LibraryItem } from '../format/schema';
import { mediaUrl } from '../state/sync';

type Listener = () => void;
const listeners = new Set<Listener>();
/** Called whenever new media data is available (image loaded, video seeked...) so the viewer can redraw. */
export function onMediaUpdate(fn: Listener) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}
export const notify = () => listeners.forEach((l) => l());

const images = new Map<string, HTMLImageElement>();
const videos = new Map<string, HTMLVideoElement>();
const audios = new Map<string, HTMLAudioElement>();
const gains = new Map<HTMLMediaElement, GainNode>();
let audioCtx: AudioContext | null = null;

export function getAudioContext(): AudioContext {
  if (!audioCtx) audioCtx = new AudioContext();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

const bitmaps = new Map<string, HTMLCanvasElement>();

// ----------------------------------------------------------------------------- animated images
// An <img> drawn onto a canvas only ever shows one frame of a GIF / animated WebP / APNG, and the
// browser's own animation clock has nothing to do with the playhead. So animated images are decoded
// up front into frames (WebCodecs ImageDecoder) and the frame is picked from the object's local time,
// which keeps preview scrubbing and the export frame-exact. The animation loops for as long as the
// object lasts.

interface Anim {
  frames: ImageBitmap[];
  /** Start time of each frame in seconds, plus the total loop length at the end. */
  starts: number[];
}

/** Minimal typings for WebCodecs ImageDecoder (not in TypeScript's DOM lib yet). */
interface ImageDecoderLike {
  tracks: { ready: Promise<void>; selectedTrack: { frameCount: number; animated: boolean } | null };
  decode(o: { frameIndex: number }): Promise<{ image: VideoFrame }>;
  close(): void;
}
interface ImageDecoderCtor {
  new (init: { data: ArrayBuffer; type: string }): ImageDecoderLike;
  isTypeSupported(type: string): Promise<boolean>;
}

const ANIMATABLE: Record<string, string> = { gif: 'image/gif', webp: 'image/webp', png: 'image/png', apng: 'image/apng', avif: 'image/avif' };
const MAX_FRAMES = 2000;
/** 'static' = not animated (or can't be decoded here): the plain <img> path is used. */
const anims = new Map<string, Anim | 'loading' | 'static'>();

function extOf(file: string) {
  return file.toLowerCase().split(/[?#]/)[0].split('.').pop() ?? '';
}

function loadAnim(url: string, file: string) {
  const mime = ANIMATABLE[extOf(file)];
  const Decoder = (globalThis as { ImageDecoder?: ImageDecoderCtor }).ImageDecoder;
  if (!mime || !Decoder) return void anims.set(url, 'static');
  anims.set(url, 'loading');
  (async () => {
    let dec: ImageDecoderLike | null = null;
    try {
      if (!(await Decoder.isTypeSupported(mime))) throw new Error('unsupported');
      const data = await (await fetch(url)).arrayBuffer();
      dec = new Decoder({ data, type: mime });
      await dec.tracks.ready;
      const track = dec.tracks.selectedTrack;
      const count = Math.min(track?.frameCount ?? 1, MAX_FRAMES);
      if (!track || !track.animated || count < 2) throw new Error('static');
      const frames: ImageBitmap[] = [];
      const starts: number[] = [];
      let at = 0;
      for (let i = 0; i < count; i++) {
        const { image } = await dec.decode({ frameIndex: i });
        // Like browsers do, treat delays of 10 ms or less as 100 ms (many GIFs rely on this).
        const d = (image.duration ?? 0) / 1e6;
        frames.push(await createImageBitmap(image));
        image.close();
        starts.push(at);
        at += d > 0.011 ? d : 0.1;
      }
      starts.push(at);
      anims.set(url, { frames, starts });
    } catch {
      anims.set(url, 'static');
    } finally {
      dec?.close();
      notify();
    }
  })();
}

function frameAt(a: Anim, t: number): ImageBitmap {
  const total = a.starts[a.starts.length - 1];
  const lt = ((t % total) + total) % total;
  let lo = 0;
  let hi = a.frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (a.starts[mid] <= lt) lo = mid;
    else hi = mid - 1;
  }
  return a.frames[lo];
}

/** Loop length in seconds of an animated image, or null if it isn't (known to be) animated. */
export function animationDuration(item: LibraryItem): number | null {
  const a = anims.get(mediaUrl(item));
  return a && typeof a === 'object' ? a.starts[a.starts.length - 1] : null;
}

/** True once an image item can be drawn in its final form (export waits for this). */
export function imageReady(item: LibraryItem): boolean {
  const a = anims.get(mediaUrl(item));
  if (a && typeof a === 'object') return true;
  return a === 'static' && getImage(item) !== null;
}

/**
 * A drawable for an image item at `t` seconds into the object. Animated images (GIF, WebP, APNG,
 * AVIF) return the frame for that moment. SVGs are rasterized once into a bitmap (at 2× their size
 * so zooming in stays crisp); otherwise the browser re-rasterizes the vector on every frame.
 */
export function getImage(item: LibraryItem, t = 0): CanvasImageSource | null {
  const url = mediaUrl(item);
  if (!anims.has(url)) loadAnim(url, item.file);
  const anim = anims.get(url);
  if (anim && typeof anim === 'object') return frameAt(anim, t);
  let img = images.get(url);
  if (!img) {
    img = new Image();
    img.decoding = 'async';
    img.onload = notify;
    img.onerror = notify;
    img.src = url;
    images.set(url, img);
  }
  if (!img.complete || img.naturalWidth <= 0) return null;
  if (extOf(item.file) !== 'svg') return img;
  let bmp = bitmaps.get(url);
  if (!bmp) {
    bmp = document.createElement('canvas');
    bmp.width = img.naturalWidth * 2;
    bmp.height = img.naturalHeight * 2;
    bmp.getContext('2d')!.drawImage(img, 0, 0, bmp.width, bmp.height);
    bitmaps.set(url, bmp);
  }
  return bmp;
}

function mediaKey(objId: string, item: LibraryItem, purpose: string) {
  return `${purpose}|${objId}|${mediaUrl(item)}`;
}

export function getVideo(objId: string, item: LibraryItem, purpose = 'preview'): HTMLVideoElement {
  const key = mediaKey(objId, item, purpose);
  let v = videos.get(key);
  if (!v) {
    v = document.createElement('video');
    v.preload = 'auto';
    v.playsInline = true;
    v.crossOrigin = 'anonymous';
    v.muted = purpose !== 'preview';
    v.src = mediaUrl(item);
    v.addEventListener('seeked', notify);
    v.addEventListener('loadeddata', notify);
    videos.set(key, v);
  }
  return v;
}

export function peekVideo(objId: string, item: LibraryItem, purpose = 'preview') {
  return videos.get(mediaKey(objId, item, purpose));
}

export function getAudio(objId: string, item: LibraryItem): HTMLAudioElement {
  const key = mediaKey(objId, item, 'preview');
  let a = audios.get(key);
  if (!a) {
    a = new Audio();
    a.preload = 'auto';
    a.crossOrigin = 'anonymous';
    a.src = mediaUrl(item);
    audios.set(key, a);
  }
  return a;
}

export function peekAudio(objId: string, item: LibraryItem) {
  return audios.get(mediaKey(objId, item, 'preview'));
}

/** Volume control through Web Audio (allows boosting above 100%). Falls back to element.volume before audio is unlocked. */
export function setVolume(el: HTMLMediaElement, volume: number) {
  let g = gains.get(el);
  if (!g && audioCtx && audioCtx.state === 'running') {
    try {
      const src = audioCtx.createMediaElementSource(el);
      g = audioCtx.createGain();
      src.connect(g).connect(audioCtx.destination);
      gains.set(el, g);
      el.volume = 1;
    } catch {
      /* already connected elsewhere */
    }
  }
  if (g) g.gain.value = Math.max(0, volume);
  else el.volume = Math.min(1, Math.max(0, volume));
}

/** All preview media elements (to pause everything). */
export function allMediaElements(): HTMLMediaElement[] {
  return [...[...videos.entries()].filter(([k]) => k.startsWith('preview|')).map(([, v]) => v), ...audios.values()];
}

/** Drop elements for objects that no longer exist. */
export function collectGarbage(liveObjectIds: Set<string>) {
  for (const map of [videos, audios] as Map<string, HTMLMediaElement>[]) {
    for (const [key, el] of map) {
      const id = key.split('|')[1];
      if (!liveObjectIds.has(id)) {
        el.pause();
        el.removeAttribute('src');
        el.load();
        map.delete(key);
        gains.delete(el);
      }
    }
  }
}

export function releasePurpose(purpose: string) {
  for (const [key, v] of videos) {
    if (key.startsWith(purpose + '|')) {
      v.pause();
      v.removeAttribute('src');
      v.load();
      videos.delete(key);
    }
  }
}

// ----------------------------------------------------------------------------- waveforms
const peaks = new Map<string, Float32Array | 'loading' | 'error'>();
const PEAKS_PER_SEC = 100;

/** Peak amplitudes (0..1), PEAKS_PER_SEC per second of source, or null while loading. */
export function getPeaks(item: LibraryItem): { data: Float32Array; perSec: number } | null {
  const url = mediaUrl(item);
  const p = peaks.get(url);
  if (p instanceof Float32Array) return { data: p, perSec: PEAKS_PER_SEC };
  if (p) return null;
  peaks.set(url, 'loading');
  (async () => {
    try {
      const buf = await (await fetch(url)).arrayBuffer();
      const ctx = new OfflineAudioContext(1, 1, 44100);
      const audio = await ctx.decodeAudioData(buf);
      const n = Math.ceil(audio.duration * PEAKS_PER_SEC);
      const out = new Float32Array(n);
      const step = audio.sampleRate / PEAKS_PER_SEC;
      for (let c = 0; c < audio.numberOfChannels; c++) {
        const ch = audio.getChannelData(c);
        for (let i = 0; i < n; i++) {
          let m = 0;
          const s = Math.floor(i * step);
          const e = Math.min(ch.length, Math.floor((i + 1) * step));
          for (let j = s; j < e; j += 4) {
            const v = Math.abs(ch[j]);
            if (v > m) m = v;
          }
          if (m > out[i]) out[i] = m;
        }
      }
      peaks.set(url, out);
      notify();
      peakListeners.forEach((l) => l());
    } catch {
      peaks.set(url, 'error');
    }
  })();
  return null;
}

const peakListeners = new Set<Listener>();
export function onPeaks(fn: Listener) {
  peakListeners.add(fn);
  return () => void peakListeners.delete(fn);
}
