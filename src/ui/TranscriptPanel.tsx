import { useEffect, useMemo, useRef, useState } from 'react';
import { timelineTranscript } from '../format/transcript';
import { editor, select, setPlayhead, useEditor } from '../state/store';
import { addCaptions, clearCaptions, loadTranscripts, setSttModel, startTranscription, useTranscripts } from '../state/transcripts';
import { Icon } from './icons';
import { timecode } from './time';

export function TranscriptPanel() {
  const st = useTranscripts();
  const project = useEditor((s) => s.project);
  const name = useEditor((s) => s.projectName);
  const fps = useEditor((s) => s.project.project.fps);
  const playhead = useEditor((s) => (s.playing ? Math.round(s.playhead * 15) / 15 : s.playhead));
  const playing = useEditor((s) => s.playing);
  const [query, setQuery] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (name && st.loadedFor !== name) loadTranscripts();
  }, [name, st.loadedFor]);

  const segs = useMemo(() => timelineTranscript(project, st.sources), [project, st.sources]);
  const speech = project.library.filter((l) => l.kind === 'audio' || (l.kind === 'video' && l.hasAudio !== false));
  const missing = speech.filter((l) => !st.sources[l.id]);
  const hasCaptions = project.tracks.some((t) => t.objects.some((o) => o.note === 'auto-caption'));
  const q = query.trim().toLowerCase();
  const shown = q ? segs.filter((s) => s.text.toLowerCase().includes(q)) : segs;
  const activeSeg = segs.findIndex((s) => playhead >= s.start && playhead < s.end + 0.05);

  // keep the spoken line in view while playing
  useEffect(() => {
    if (!playing || activeSeg < 0) return;
    listRef.current?.querySelector(`[data-seg="${activeSeg}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [activeSeg, playing]);

  const job = st.job;
  const busy = !!job;
  const pct = job ? (((job.index ?? 1) - 1 + (job.pct ?? 0)) / Math.max(1, job.total ?? 1)) * 100 : 0;

  return (
    <div className="transcript">
      <div className="tr-bar">
        <button className="btn primary" disabled={busy || !st.engine?.ok || !speech.length} onClick={() => startTranscription(!missing.length)} title={missing.length ? 'Transcribe media that has no transcript yet' : 'Transcribe everything again'}>
          <Icon name="text" size={13} /> {missing.length ? `Transcribe ${missing.length === speech.length ? 'audio' : `${missing.length} new file${missing.length > 1 ? 's' : ''}`}` : 'Re-transcribe'}
        </button>
        <select className="input" style={{ width: 110 }} value={st.model} disabled={busy} onChange={(e) => setSttModel(e.target.value)} title="Whisper model (bigger = more accurate, slower)">
          {st.models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        {busy && (
          <div className="tr-progress" title={job.item}>
            <div className="progress">
              <div style={{ width: `${pct}%` }} />
            </div>
            <span>
              {job.phase === 'preparing' ? 'Preparing' : 'Transcribing'} {job.item ?? ''} {job.total ? `(${job.index}/${job.total})` : ''}
            </span>
          </div>
        )}
        <span className="sep" />
        <button className="btn" disabled={!segs.length} onClick={addCaptions} title="Create caption text objects from the transcript (replaces earlier auto-captions)">
          <Icon name="text" size={13} /> {hasCaptions ? 'Update captions' : 'Add captions'}
        </button>
        {hasCaptions && (
          <button className="btn ghost" onClick={clearCaptions}>
            Remove captions
          </button>
        )}
        <span className="spacer" />
        <div style={{ position: 'relative', width: 180 }}>
          <input className="input" placeholder="Search transcript…" value={query} onChange={(e) => setQuery(e.target.value)} style={{ paddingLeft: 24 }} />
          <Icon name="search" size={12} style={{ position: 'absolute', left: 7, top: 6, color: 'var(--dim)' }} />
        </div>
      </div>

      <div className="tr-list" ref={listRef}>
        {st.engine && !st.engine.ok && <div className="tr-empty error">{st.engine.message}</div>}
        {st.engine?.ok && !speech.length && <div className="tr-empty">Import a video or audio file with speech, then transcribe it here.</div>}
        {st.engine?.ok && !!speech.length && !segs.length && !busy && (
          <div className="tr-empty">
            {Object.keys(st.sources).length ? 'No speech is heard on the timeline (clips may be muted, cut, or not placed yet).' : 'No transcript yet — press Transcribe. Words get exact timestamps so you (or an AI) can cut on them.'}
          </div>
        )}
        {shown.map((s) => {
          const i = segs.indexOf(s);
          return (
            <div key={`${s.object}-${s.start}`} data-seg={i} className={`tr-seg ${i === activeSeg ? 'active' : ''}`}>
              <button className="tr-time" onClick={() => setPlayhead(s.start)} title="Jump here">
                {timecode(s.start, fps)}
              </button>
              <button className="tr-obj" onClick={() => select([s.object])} title={`Plays from ${s.source} at ${s.sourceStart.toFixed(2)}s — click to select`}>
                {s.object}
              </button>
              <div className="tr-words">
                {s.words.map((w, wi) => {
                  const now = playhead >= w.start && playhead < w.end;
                  const hit = q && w.word.toLowerCase().includes(q);
                  return [
                    <span
                      key={wi}
                      className={`tr-word ${now ? 'now' : ''} ${w.p !== undefined && w.p < 0.5 ? 'unsure' : ''} ${hit ? 'hit' : ''}`}
                      title={`${w.start.toFixed(2)}–${w.end.toFixed(2)}s${w.p !== undefined ? ` · ${Math.round(w.p * 100)}% sure` : ''}`}
                      onClick={() => setPlayhead(w.start)}
                      onDoubleClick={() => {
                        select([s.object]);
                        editor.set({ bottomTab: 'timeline' });
                      }}
                    >
                      {w.word}
                    </span>,
                    ' ',
                  ];
                })}
              </div>
            </div>
          );
        })}
      </div>

      {st.files && segs.length > 0 && (
        <div className="tr-foot">
          For AI editing: <code>{st.files.yaml.split(/[\\/]/).slice(-3).join('/')}</code> lists every word in timeline seconds (updated automatically) · subtitles: <code>{st.files.srt.split(/[\\/]/).pop()}</code> · CLI: <code>npm run transcribe -- {name}</code>
        </div>
      )}
    </div>
  );
}
