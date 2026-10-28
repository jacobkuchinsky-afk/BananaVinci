// Client side of speech-to-text: source transcripts from the server, transcription jobs, captions.
import { create } from 'zustand';
import type { Project } from '../format/schema';
import { applyCaptions, buildCaptions, removeCaptions, timelineTranscript, type SourceTranscript, type TimelineSegment } from '../format/transcript';
import { commit, editor, toast, useEditor } from './store';
import { onMessage } from './sync';

interface TranscriptState {
  sources: Record<string, SourceTranscript>;
  loadedFor: string | null;
  engine: { ok: boolean; message: string } | null;
  models: string[];
  model: string;
  job: { phase: string; item?: string; index?: number; total?: number; pct?: number } | null;
  files: { yaml: string; srt: string } | null;
}

export const useTranscripts = create<TranscriptState>()(() => ({
  sources: {},
  loadedFor: null,
  engine: null,
  models: [],
  model: (() => {
    try {
      return localStorage.getItem('bv.stt.model') ?? '';
    } catch {
      return '';
    }
  })(),
  job: null,
  files: null,
}));
const T = useTranscripts;

export async function loadTranscripts() {
  const name = editor.get().projectName;
  if (!name) return;
  const [status, data] = await Promise.all([
    fetch('/api/stt/status').then((r) => r.json()),
    fetch(`/api/projects/${encodeURIComponent(name)}/transcripts`).then((r) => r.json()),
  ]);
  const model = T.getState().model && status.models.includes(T.getState().model) ? T.getState().model : status.defaultModel;
  T.setState({ sources: data.sources ?? {}, files: data.files ?? null, loadedFor: name, engine: status.engine, models: status.models, model });
}

export function setSttModel(model: string) {
  T.setState({ model });
  try {
    localStorage.setItem('bv.stt.model', model);
  } catch {}
}

export async function startTranscription(force = false) {
  const name = editor.get().projectName;
  if (!name) return;
  T.setState({ job: { phase: 'preparing', pct: 0 } });
  const res = await fetch(`/api/projects/${encodeURIComponent(name)}/transcribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: T.getState().model, force }),
  });
  if (!res.ok) {
    T.setState({ job: null });
    toast(await res.text(), 'error');
  }
}

/** Words heard on the timeline (follows the current, possibly unsaved, edit). */
export function currentTimelineTranscript(project: Project): TimelineSegment[] {
  return timelineTranscript(project, T.getState().sources);
}

export function addCaptions() {
  const p = editor.get().project;
  const segs = currentTimelineTranscript(p);
  if (!segs.length) return toast('Nothing to caption yet — transcribe the audio first', 'error');
  let result = { track: '', count: 0 };
  commit((d) => {
    result = applyCaptions(d as Project, buildCaptions(segs));
  });
  toast(`Added ${result.count} captions on track ${result.track}. Select them all to restyle at once.`, 'success');
}

export function clearCaptions() {
  let n = 0;
  commit((d) => {
    n = removeCaptions(d as Project);
  });
  toast(n ? `Removed ${n} auto-captions` : 'No auto-captions to remove');
}

onMessage((msg) => {
  if (msg.project !== editor.get().projectName) return;
  if (msg.type === 'stt-progress') T.setState({ job: msg });
  if (msg.type === 'stt-done') {
    T.setState({ job: null });
    loadTranscripts();
    toast(msg.transcribed.length ? `Transcribed ${msg.transcribed.join(', ')}` : 'Everything was already transcribed', 'success');
  }
  if (msg.type === 'stt-error') {
    T.setState({ job: null });
    toast(`Transcription failed: ${msg.message}`, 'error');
  }
});

// reload when another project is opened
useEditor.subscribe((s, prev) => {
  if (s.projectName !== prev.projectName) {
    T.setState({ sources: {}, loadedFor: null, files: null });
    if (s.projectName) loadTranscripts();
  }
});
