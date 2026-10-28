// Microphone recording (voice-over): pick a mic, watch its level, count down, record while the
// timeline plays, then drop the take onto an audio track at the point where recording started.
import { create } from 'zustand';
import { defaultsFor, type LibraryItem, type Project } from '../format/schema';
import { commit, editor, select, toast } from '../state/store';
import { insertObject } from '../state/commands';
import { freeTrack } from '../state/actions';
import { pause, pauseHooks, play, setKeepRolling, setPreviewMuted } from './playback';
import { getAudioContext } from './mediaCache';

export type VoiceStatus = 'idle' | 'countdown' | 'recording' | 'saving';

interface VoiceState {
  open: boolean;
  devices: { id: string; label: string }[];
  deviceId: string;
  status: VoiceStatus;
  countdown: number; // seconds left in the countdown
  countdownSecs: number; // 0 = no countdown
  playAlong: boolean; // play the timeline while recording
  muteWhileRecording: boolean; // silence the preview while recording (avoid speaker bleed)
  noiseSuppression: boolean;
  startedAt: number; // performance.now() when recording began
  startTime: number; // timeline seconds where the take starts
  error: string | null;
}

const load = <T,>(key: string, def: T): T => {
  try {
    const v = localStorage.getItem(`bv.voice.${key}`);
    return v === null ? def : (JSON.parse(v) as T);
  } catch {
    return def;
  }
};
const saveSetting = (key: string, v: unknown) => {
  try {
    localStorage.setItem(`bv.voice.${key}`, JSON.stringify(v));
  } catch {}
};

export const useVoice = create<VoiceState>()(() => ({
  open: false,
  devices: [],
  deviceId: load('deviceId', ''),
  status: 'idle',
  countdown: 0,
  countdownSecs: load('countdownSecs', 3),
  playAlong: load('playAlong', true),
  muteWhileRecording: load('muteWhileRecording', true),
  noiseSuppression: load('noiseSuppression', true),
  startedAt: 0,
  startTime: 0,
  error: null,
}));
const V = useVoice;

let stream: MediaStream | null = null;
let analyser: AnalyserNode | null = null;
let sourceNode: MediaStreamAudioSourceNode | null = null;
let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let countdownTimer: ReturnType<typeof setTimeout> | null = null;

export const getAnalyser = () => analyser;

/** List microphones. Labels are only available after permission has been granted once. */
export async function refreshDevices() {
  const all = await navigator.mediaDevices.enumerateDevices();
  const devices = all
    .filter((d) => d.kind === 'audioinput')
    .map((d, i) => ({ id: d.deviceId, label: d.label || (d.deviceId === 'default' ? 'Default microphone' : `Microphone ${i + 1}`) }));
  const cur = V.getState().deviceId;
  V.setState({ devices, deviceId: devices.some((d) => d.id === cur) ? cur : (devices[0]?.id ?? '') });
}

/** Open (or re-open) the selected microphone and connect the level meter. */
export async function openMic(deviceId = V.getState().deviceId) {
  closeMic();
  try {
    const ns = V.getState().noiseSuppression;
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: ns,
        autoGainControl: false,
        channelCount: 1,
      },
    });
    const ctx = getAudioContext();
    sourceNode = ctx.createMediaStreamSource(stream);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0;
    sourceNode.connect(analyser); // analyser only: we never play the mic back (no feedback)
    const actual = stream.getAudioTracks()[0]?.getSettings().deviceId;
    V.setState({ error: null, deviceId: actual ?? deviceId });
    saveSetting('deviceId', actual ?? deviceId);
    await refreshDevices();
  } catch (e: any) {
    const msg =
      e?.name === 'NotAllowedError'
        ? 'Microphone access was blocked. Allow it in the browser (padlock icon in the address bar) and try again.'
        : e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError'
          ? 'That microphone is not available. Pick another one.'
          : `Could not open the microphone: ${e?.message ?? e}`;
    V.setState({ error: msg });
  }
}

export function closeMic() {
  sourceNode?.disconnect();
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  analyser = null;
  sourceNode = null;
}

export async function openVoicePanel() {
  V.setState({ open: true });
  await openMic();
}

export function closeVoicePanel() {
  if (V.getState().status !== 'idle') cancelVoice();
  closeMic();
  V.setState({ open: false });
}

export function setVoiceOption<K extends 'countdownSecs' | 'playAlong' | 'muteWhileRecording' | 'noiseSuppression'>(key: K, value: VoiceState[K]) {
  V.setState({ [key]: value } as Partial<VoiceState>);
  saveSetting(key, value);
  if (key === 'noiseSuppression') openMic();
}

function beep(freq: number, dur = 0.09) {
  try {
    const ctx = getAudioContext();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.12, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + dur);
  } catch {}
}

/** Red button: count down, then record. */
export async function startVoice() {
  const s = V.getState();
  if (s.status !== 'idle') return;
  if (!stream) await openMic();
  if (!stream) return;
  if (editor.get().playing) pause();
  if (s.countdownSecs <= 0) return beginRecording();
  V.setState({ status: 'countdown', countdown: s.countdownSecs });
  const step = (n: number) => {
    if (V.getState().status !== 'countdown') return;
    if (n <= 0) return beginRecording();
    V.setState({ countdown: n });
    beep(n === 1 ? 880 : 660);
    countdownTimer = setTimeout(() => step(n - 1), 1000);
  };
  step(s.countdownSecs);
}

function pickMime() {
  const options = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  return options.find((m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) ?? '';
}

function beginRecording() {
  if (!stream) return;
  const s = V.getState();
  chunks = [];
  const mime = pickMime();
  recorder = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 192000 } : undefined);
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = () => finishRecording();
  recorder.onstart = () => {
    // the take starts where the playhead is the moment the recorder actually starts
    V.setState({ status: 'recording', startedAt: performance.now(), startTime: editor.get().playhead, countdown: 0 });
  };
  recorder.onerror = () => endUnexpectedly('the browser stopped the recorder');
  // if the microphone goes away mid-take (unplugged, Bluetooth headset switching mode, taken by another app), say so
  for (const track of stream.getAudioTracks()) track.onended = () => endUnexpectedly('the microphone disconnected or was taken by another app');
  if (s.muteWhileRecording) setPreviewMuted(true);
  setKeepRolling(true); // the timeline keeps playing past its end / Out point until you stop
  recorder.start(250);
  if (s.playAlong) play();
}

function endUnexpectedly(why: string) {
  if (V.getState().status !== 'recording') return;
  toast(`Recording stopped: ${why}. What was recorded so far is kept.`, 'error');
  stopVoice();
}

/** Stop button (or Space / reaching the end of the timeline). */
export function stopVoice() {
  const s = V.getState();
  if (s.status === 'countdown') return cancelVoice();
  if (s.status !== 'recording' || !recorder) return;
  setKeepRolling(false);
  if (recorder.state !== 'inactive') recorder.stop();
  if (editor.get().playing) pause();
  setPreviewMuted(false);
}

export function cancelVoice() {
  if (countdownTimer) clearTimeout(countdownTimer);
  countdownTimer = null;
  if (recorder && recorder.state !== 'inactive') {
    recorder.onstop = null;
    recorder.stop();
  }
  recorder = null;
  chunks = [];
  setKeepRolling(false);
  setPreviewMuted(false);
  if (editor.get().playing) pause();
  V.setState({ status: 'idle', countdown: 0 });
}

pauseHooks.add(() => {
  // playback was stopped by the person (pause button / Space): end the take too.
  // (It no longer stops by itself at the end of the timeline while recording, see setKeepRolling.)
  if (V.getState().status === 'recording') stopVoice();
});

async function finishRecording() {
  const s = V.getState();
  const blob = new Blob(chunks, { type: recorder?.mimeType || 'audio/webm' });
  recorder = null;
  chunks = [];
  setPreviewMuted(false);
  const name = editor.get().projectName;
  if (!name || blob.size < 1000) {
    V.setState({ status: 'idle' });
    toast('Recording was empty', 'error');
    return;
  }
  V.setState({ status: 'saving' });
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(name)}/record`, { method: 'POST', headers: { 'content-type': blob.type }, body: blob });
    if (!res.ok) throw new Error(await res.text());
    const { item } = (await res.json()) as { item: Omit<LibraryItem, 'id'> & { suggestedId: string } };
    let placedId = '';
    let trackId = '';
    commit((d) => {
      const used = new Set(d.library.map((l) => l.id));
      let id = item.suggestedId;
      let n = 2;
      while (used.has(id)) id = `${item.suggestedId}-${n++}`;
      const { suggestedId: _, ...rest } = item;
      d.library.push({ id, ...rest } as LibraryItem);
      const duration = item.duration ?? 1;
      const track = freeTrack(d, 'audio', s.startTime, s.startTime + duration);
      const obj = insertObject(d as Project, track.id, defaultsFor('audio', { source: id, start: s.startTime, duration }), false);
      placedId = obj.id;
      trackId = track.id;
    });
    editor.set({ libraryVersion: editor.get().libraryVersion + 1 });
    if (placedId) select([placedId]);
    toast(`Voice recording added to ${trackId} at ${s.startTime.toFixed(2)}s`, 'success');
  } catch (e) {
    toast(`Saving the recording failed: ${e}`, 'error');
  } finally {
    V.setState({ status: 'idle' });
  }
}

if (typeof navigator !== 'undefined' && navigator.mediaDevices?.addEventListener) {
  navigator.mediaDevices.addEventListener('devicechange', () => {
    if (V.getState().open) refreshDevices();
  });
}
