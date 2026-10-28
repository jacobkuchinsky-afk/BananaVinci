// Live animation recording ("performance capture").
//
// While recording, the whole viewer is a controller for the recorded object:
//   left-drag  → position      scroll wheel → rotation      right-drag → scale
// Each channel is recorded continuously (every frame) from the first moment you touch it until
// you stop, so pauses become holds and nothing is invented between gestures. When you stop, the
// samples are smoothed into keyframes.
import { isVisual, type Animatable, type Project } from '../format/schema';
import { mergePath, samplesToPath, type Sample } from '../format/recording';
import { getPath, valueAt } from '../format/values';
import { commit, editor, toast } from '../state/store';
import { findObject } from '../state/commands';
import { pause, pauseHooks, play, tickHooks } from './playback';
import { setOverride } from './overrides';
import { notify } from './mediaCache';

type Group = 'position' | 'scale' | 'rotation';
const GROUP_PATHS: Record<Group, string[]> = {
  position: ['transform.x', 'transform.y'],
  scale: ['transform.scale'],
  rotation: ['transform.rotation'],
};
const groupOf = (path: string): Group => (path === 'transform.scale' ? 'scale' : path === 'transform.rotation' ? 'rotation' : 'position');

interface Take {
  objId: string;
  values: Record<string, number>; // current values of touched channels
  samples: Partial<Record<Group, Sample[]>>; // one continuous stretch per touched group
}

let take: Take | null = null;

/** The position path being recorded right now (object-local samples), for drawing a live trail. */
export function liveTrail(): { x: number; y: number }[] {
  const arr = take?.samples.position;
  return arr ? arr.map((s) => ({ x: s.v['transform.x'], y: s.v['transform.y'] })) : [];
}

export function startRecording(): boolean {
  const s = editor.get();
  if (s.recording) return true;
  const id = s.selection.length === 1 ? s.selection[0] : null;
  const f = id ? findObject(s.project, id) : null;
  if (!f || !isVisual(f.obj)) {
    toast('Select one visual object (video, image, text or shape) first, then press Rec', 'error');
    return false;
  }
  if (f.track.locked) {
    toast(`Track ${f.track.id} is locked`, 'error');
    return false;
  }
  take = { objId: f.obj.id, values: {}, samples: {} };
  let t = s.playhead;
  if (t < f.obj.start || t >= f.obj.start + f.obj.duration - 0.05) t = f.obj.start; // jump into the object
  editor.set({ recording: true, recordTarget: f.obj.id, playhead: t });
  play(s.recordSpeed);
  return true;
}

/** Current value of a channel: what you're performing, or the object's own (animated) value. */
export function liveValue(path: string): number {
  const s = editor.get();
  if (take && take.values[path] !== undefined) return take.values[path];
  const f = take ? findObject(s.project, take.objId) : null;
  if (!f) return 0;
  return valueAt(getPath(f.obj, path) as Animatable, s.playhead - f.obj.start);
}

/** Feed new values for channels (from the viewer's mouse / wheel input). */
export function recordInput(values: Record<string, number>) {
  const s = editor.get();
  if (!take || !s.recording) return;
  const f = findObject(s.project, take.objId);
  if (!f) return;
  const localT = Math.max(0, s.playhead - f.obj.start);
  for (const [path, v] of Object.entries(values)) {
    const group = groupOf(path);
    if (!take.samples[group]) {
      // first touch of this channel group: anchor the recording at the current pose, so the
      // motion starts exactly where the object was
      for (const p of GROUP_PATHS[group]) if (take.values[p] === undefined) take.values[p] = liveValue(p);
      const pose = Object.fromEntries(GROUP_PATHS[group].map((p) => [p, take!.values[p]]));
      take.samples[group] = [{ t: Math.max(0, localT - 1 / 240), v: pose }];
    }
    take.values[path] = v;
  }
  for (const group of new Set(Object.keys(values).map(groupOf))) pushSample(group, localT);
  setOverride(take.objId, { ...take.values });
  notify();
}

function pushSample(group: Group, localT: number) {
  if (!take) return;
  const arr = take.samples[group]!;
  const v = Object.fromEntries(GROUP_PATHS[group].map((p) => [p, take!.values[p]]));
  const last = arr[arr.length - 1];
  if (last && Math.abs(localT - last.t) < 1e-6) {
    if (arr.length > 1) last.v = v; // same frame: keep the newest (but never move the start anchor)
  }
  else if (!last || localT > last.t) arr.push({ t: localT, v });
}

tickHooks.add((t) => {
  const s = editor.get();
  if (!take || !s.recording) return;
  const f = findObject(s.project, take.objId);
  if (!f) return stopRecording();
  const localT = t - f.obj.start;
  if (localT >= f.obj.duration) return void pause(); // reached the end of the object → stop
  for (const group of Object.keys(take.samples) as Group[]) pushSample(group, localT);
});

pauseHooks.add(() => {
  if (editor.get().recording) stopRecording();
});

export function stopRecording() {
  const s = editor.get();
  if (!s.recording || !take) {
    editor.set({ recording: false, recordTarget: null });
    return;
  }
  const t = take;
  take = null;
  editor.set({ recording: false, recordTarget: null });
  if (s.playing) pause();

  const groups = (Object.keys(t.samples) as Group[]).filter((g) => (t.samples[g]?.length ?? 0) >= 2);
  if (!groups.length) {
    setOverride(null);
    notify();
    toast('Nothing recorded — while recording, drag in the viewer (left = move, right = scale, wheel = rotate)');
    return;
  }
  const names: string[] = [];
  let seconds = 0;
  commit((d) => {
    const f = findObject(d as Project, t.objId);
    if (!f || !isVisual(f.obj)) return;
    for (const g of groups) {
      // every frame of the performance is kept: the object follows this path exactly
      const samples = t.samples[g]!.map((x) => ({ t: x.t, v: Object.fromEntries(Object.entries(x.v).map(([k, v]) => [k.replace('transform.', ''), v])) }));
      const path = samplesToPath(samples, s.recordSmoothing);
      if (!path) continue;
      f.obj.motion = mergePath(f.obj.motion, path);
      seconds = Math.max(seconds, samples[samples.length - 1].t - samples[0].t);
      names.push(g);
    }
  });
  setOverride(null);
  notify();
  toast(`Recorded ${names.join(' + ')} (${seconds.toFixed(1)} s) as a motion path. Drag the object to move the whole path.`, 'success');
}

export function toggleRecording() {
  editor.get().recording ? stopRecording() : startRecording();
}
