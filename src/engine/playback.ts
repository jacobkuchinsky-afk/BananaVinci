// Playback clock + keeping <video>/<audio> elements in sync with the timeline.
import type { Project, TimelineObject } from '../format/schema';
import { fadeFactor, isActiveAt, sourceTimeAt, valueAt } from '../format/values';
import { projectDuration } from '../state/commands';
import { editor, useEditor } from '../state/store';
import { allMediaElements, getAudio, getAudioContext, getImage, getVideo, notify, peekAudio, peekVideo, setVolume } from './mediaCache';
import type { FrameSources } from './compositor';
import { playedMedia } from '../format/groups';

let raf = 0;
let startWall = 0;
let startT = 0;

/** Called every playback frame with the current time (used by the recorder). */
export const tickHooks = new Set<(t: number) => void>();
/** Called whenever playback stops. */
export const pauseHooks = new Set<() => void>();

/** Silence the preview (used while recording a voice-over so speakers don't bleed into the mic). */
let previewMuted = false;
export const setPreviewMuted = (v: boolean) => {
  previewMuted = v;
};

/** Frame sources for the live preview. */
export const previewSources: FrameSources = {
  image: (item, localT) => getImage(item, localT),
  video: (obj, item) => {
    const v = getVideo(obj.id, item);
    return v.readyState >= 2 ? v : null;
  },
};

/**
 * While something is being recorded over the timeline (a voice-over), playback must not stop or loop by itself at
 * the end of the timeline or at an Out point; only the person recording ends the take.
 */
let keepRolling = false;
export const setKeepRolling = (v: boolean) => {
  keepRolling = v;
};

export function play(rate = 1) {
  const s = editor.get();
  getAudioContext();
  const end = playEnd(s.project);
  let t = s.playhead;
  if (rate > 0 && t >= end - 1e-3 && !keepRolling) t = s.inPoint ?? 0;
  startWall = performance.now();
  startT = t;
  editor.set({ playing: true, rate, playhead: t });
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(tick);
}

export function pause() {
  cancelAnimationFrame(raf);
  const wasPlaying = editor.get().playing;
  const s = editor.get();
  const fps = s.project.project.fps;
  editor.set({ playing: false, rate: 1, playhead: Math.round(s.playhead * fps) / fps });
  for (const el of allMediaElements()) if (!el.paused) el.pause();
  syncMedia(editor.get().project, editor.get().playhead, false);
  if (wasPlaying) pauseHooks.forEach((h) => h());
}

export function togglePlay() {
  editor.get().playing ? pause() : play();
}

/** J/K/L shuttle: dir -1 (J), 0 (K) or +1 (L). Repeated presses speed up. */
export function shuttle(dir: -1 | 0 | 1) {
  const s = editor.get();
  if (dir === 0) return pause();
  const cur = s.playing ? s.rate : 0;
  const next = Math.sign(cur) === dir ? Math.min(Math.abs(cur) * 2, 8) * dir : dir;
  if (s.playing) {
    startT = s.playhead;
    startWall = performance.now();
    editor.set({ rate: next });
  } else play(next);
}

function playEnd(p: Project) {
  const s = editor.get();
  return s.outPoint ?? Math.max(projectDuration(p), 0.001);
}

function tick(now: number) {
  const s = editor.get();
  if (!s.playing) return;
  let t = startT + ((now - startWall) / 1000) * s.rate;
  const end = playEnd(s.project);
  const begin = s.inPoint ?? 0;
  if (s.rate > 0 && t >= end && !keepRolling) {
    if (s.loop) {
      startT = begin;
      startWall = now;
      t = begin;
      for (const el of allMediaElements()) el.pause();
    } else {
      editor.set({ playhead: end });
      pause();
      return;
    }
  }
  if (s.rate < 0 && t <= 0) {
    editor.set({ playhead: 0 });
    pause();
    return;
  }
  editor.set({ playhead: t });
  tickHooks.forEach((h) => h(t));
  syncMedia(s.project, t, true, s.rate);
  raf = requestAnimationFrame(tick);
}

const audibleTrack = (p: Project) => {
  const anySolo = p.tracks.some((t) => t.kind === 'audio' && t.solo);
  return (t: Project['tracks'][number]) => (t.kind === 'audio' ? !t.muted && (!anySolo || t.solo) : true);
};

/** Bring every media element to the state it should have at time `t`. */
export function syncMedia(p: Project, t: number, playing: boolean, rate = 1) {
  const audible = audibleTrack(p);
  const fps = p.project.fps;
  // every video/audio clip, including the sounds inside groups (with group-relative times resolved)
  for (const { obj: o, track, gain } of playedMedia(p)) {
    const item = p.library.find((l) => l.id === o.source);
    if (!item) continue;
    const active = isActiveAt(o, t);
    const soon = !active && o.enabled && o.start > t && o.start - t < 1.5;
    let el: HTMLMediaElement | undefined;
    if (active || soon) el = o.type === 'video' ? getVideo(o.id, item) : getAudio(o.id, item);
    else el = o.type === 'video' ? peekVideo(o.id, item) : peekAudio(o.id, item);
    if (!el) continue;

    if (!active) {
      if (!el.paused) el.pause();
      if (soon && Math.abs(el.currentTime - o.in) > 0.05 && el.readyState >= 1) el.currentTime = o.in; // pre-roll
      continue;
    }
    const desired = sourceTimeAt(o, t);
    const forward = playing && rate > 0;
    if (forward) {
      el.playbackRate = Math.min(16, o.speed * rate);
      if (el.paused) {
        el.currentTime = desired;
        el.play().catch(() => {});
      } else if (Math.abs(el.currentTime - desired) > 0.2 * Math.max(1, rate)) {
        el.currentTime = desired;
      }
    } else {
      if (!el.paused) el.pause();
      if (Math.abs(el.currentTime - desired) > 0.5 / fps) el.currentTime = desired;
    }
    setVolume(el, previewMuted ? 0 : gain * volumeOf(o, t, audible(track)) * (forward && Math.abs(rate) <= 2 ? 1 : 0));
  }
}

function volumeOf(o: TimelineObject, t: number, trackAudible: boolean): number {
  if (o.type !== 'video' && o.type !== 'audio') return 0;
  if (!trackAudible || (o.type === 'video' && o.muted)) return 0;
  const localT = t - o.start;
  return valueAt(o.volume, localT) * fadeFactor(localT, o.duration, o.fadeIn, o.fadeOut);
}

// keep paused media in sync when the playhead or project changes
useEditor.subscribe((s, prev) => {
  if (s.playing) return;
  if (s.playhead !== prev.playhead || s.project !== prev.project) {
    syncMedia(s.project, s.playhead, false);
    notify();
  }
});
