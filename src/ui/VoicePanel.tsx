import { useEffect, useRef, useState } from 'react';
import { useEditor } from '../state/store';
import { cancelVoice, closeVoicePanel, getAnalyser, openMic, setVoiceOption, startVoice, stopVoice, useVoice } from '../engine/voice';
import { Icon } from './icons';
import { timecode } from './time';

const MIN_DB = -60;
const dbOf = (amp: number) => (amp > 0 ? Math.max(MIN_DB, 20 * Math.log10(amp)) : MIN_DB);

/** Floating "Record Audio" panel, opened from the 🎙 button above the timeline. */
export function VoicePanel() {
  const v = useVoice();
  const fps = useEditor((s) => s.project.project.fps);
  const playhead = useEditor((s) => s.playhead);
  if (!v.open) return null;
  const busy = v.status !== 'idle';
  return (
    <div className="voice-panel" onKeyDown={(e) => e.stopPropagation()}>
      <div className="voice-head">
        <Icon name="mic" size={14} /> Record Audio
        <span className="spacer" />
        <button className="icon-btn sm" onClick={closeVoicePanel} title="Close">
          <Icon name="close" size={12} />
        </button>
      </div>

      <div className="voice-body">
        <label className="voice-label">Microphone</label>
        <div className="row" style={{ gap: 6 }}>
          <select className="input" value={v.deviceId} disabled={busy} onChange={(e) => openMic(e.target.value)}>
            {!v.devices.length && <option value="">(no microphone found)</option>}
            {v.devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
          <button className="icon-btn" title="Re-scan microphones" disabled={busy} onClick={() => openMic()}>
            <Icon name="sync" size={13} />
          </button>
        </div>
        {v.error && <div className="voice-error">{v.error}</div>}

        <label className="voice-label">Input level</label>
        <LevelMeter />

        {v.status === 'recording' || v.status === 'saving' ? (
          <LiveWave active={v.status === 'recording'} />
        ) : (
          <div className="voice-options">
            <label>
              Countdown
              <select className="input" value={v.countdownSecs} onChange={(e) => setVoiceOption('countdownSecs', Number(e.target.value))}>
                <option value={0}>Off</option>
                <option value={3}>3 s</option>
                <option value={5}>5 s</option>
              </select>
            </label>
            <label className="chk">
              <input type="checkbox" checked={v.playAlong} onChange={(e) => setVoiceOption('playAlong', e.target.checked)} /> Play video while recording
            </label>
            <label className="chk">
              <input type="checkbox" checked={v.muteWhileRecording} onChange={(e) => setVoiceOption('muteWhileRecording', e.target.checked)} /> Mute timeline audio (no speaker bleed)
            </label>
            <label className="chk">
              <input type="checkbox" checked={v.noiseSuppression} onChange={(e) => setVoiceOption('noiseSuppression', e.target.checked)} /> Noise suppression
            </label>
          </div>
        )}

        <div className="voice-record-row">
          {v.status === 'idle' && (
            <button className="voice-rec" onClick={startVoice} disabled={!!v.error || !v.devices.length} title="Start recording (after the countdown)">
              <span className="dot" />
            </button>
          )}
          {v.status === 'countdown' && (
            <button className="voice-rec counting" onClick={cancelVoice} title="Cancel">
              <span className="num">{v.countdown}</span>
            </button>
          )}
          {v.status === 'recording' && (
            <button className="voice-rec recording" onClick={stopVoice} title="Stop recording (Space)">
              <span className="square" />
            </button>
          )}
          {v.status === 'saving' && <div className="hint">Saving…</div>}
          <div className="voice-status">
            {v.status === 'idle' && (
              <>
                <b>Ready</b>
                <span>starts at {timecode(playhead, fps)}</span>
              </>
            )}
            {v.status === 'countdown' && (
              <>
                <b>Get ready…</b>
                <span>click to cancel</span>
              </>
            )}
            {v.status === 'recording' && <Elapsed />}
            {v.status === 'saving' && (
              <>
                <b>Saving take</b>
                <span>adding it to the timeline</span>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Elapsed() {
  const startedAt = useVoice((s) => s.startedAt);
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 100);
    return () => clearInterval(id);
  }, []);
  const secs = (performance.now() - startedAt) / 1000;
  return (
    <>
      <b className="rec-time">● {Math.floor(secs / 60)}:{(secs % 60).toFixed(1).padStart(4, '0')}</b>
      <span>Space or ■ to stop</span>
    </>
  );
}

/** Horizontal level meter: RMS bar, peak tick with hold, dB scale and a clip warning. */
function LevelMeter() {
  const ref = useRef<HTMLCanvasElement>(null);
  const [db, setDb] = useState({ peak: MIN_DB, clip: false });
  useEffect(() => {
    let raf = 0;
    let hold = MIN_DB;
    let holdUntil = 0;
    let clipUntil = 0;
    let lastUi = 0;
    let rmsSmooth = MIN_DB;
    const buf = new Float32Array(2048);
    const draw = (now: number) => {
      const c = ref.current;
      const an = getAnalyser();
      if (c) {
        const w = (c.width = c.clientWidth * devicePixelRatio);
        const h = (c.height = c.clientHeight * devicePixelRatio);
        const ctx = c.getContext('2d')!;
        let peak = 0;
        let sum = 0;
        if (an) {
          an.getFloatTimeDomainData(buf);
          for (let i = 0; i < buf.length; i++) {
            const a = Math.abs(buf[i]);
            if (a > peak) peak = a;
            sum += buf[i] * buf[i];
          }
        }
        const rms = dbOf(Math.sqrt(sum / buf.length));
        const pk = dbOf(peak);
        rmsSmooth = rms > rmsSmooth ? rms : rmsSmooth + (rms - rmsSmooth) * 0.15; // fast attack, slow release
        if (pk >= hold || now > holdUntil) {
          hold = pk;
          holdUntil = now + 1200;
        }
        if (peak >= 0.99) clipUntil = now + 1500;
        const X = (d: number) => ((d - MIN_DB) / -MIN_DB) * w;
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = '#0b0b0c';
        ctx.fillRect(0, 0, w, h);
        // segmented bar: green → yellow (-12 dB) → red (-3 dB)
        const seg = 3 * devicePixelRatio;
        for (let x = 0; x < X(rmsSmooth); x += seg + devicePixelRatio) {
          const d = MIN_DB + (x / w) * -MIN_DB;
          ctx.fillStyle = d > -3 ? '#ef4444' : d > -12 ? '#facc15' : '#22c55e';
          ctx.fillRect(x, h * 0.18, seg, h * 0.64);
        }
        // peak hold tick
        ctx.fillStyle = hold > -3 ? '#ef4444' : '#e5e7eb';
        ctx.fillRect(Math.max(0, X(hold) - devicePixelRatio), h * 0.08, 2 * devicePixelRatio, h * 0.84);
        // scale ticks
        ctx.fillStyle = '#34343a';
        for (const d of [-48, -36, -24, -12, -6, -3]) ctx.fillRect(X(d), 0, devicePixelRatio, h * 0.12);
        if (now - lastUi > 120) {
          lastUi = now;
          setDb({ peak: hold, clip: now < clipUntil });
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div className="meter">
      <canvas ref={ref} />
      <div className="meter-scale">
        {[-48, -36, -24, -12, -6, 0].map((d) => (
          <span key={d} style={{ left: `${((d - MIN_DB) / -MIN_DB) * 100}%` }}>
            {d}
          </span>
        ))}
      </div>
      <div className={`meter-readout ${db.clip ? 'clip' : db.peak > -12 ? 'hot' : db.peak > -40 ? 'ok' : 'low'}`}>
        {db.clip ? 'CLIPPING — move back or lower the mic gain' : db.peak <= -59 ? 'No signal' : db.peak < -40 ? `${db.peak.toFixed(0)} dB · a bit quiet` : `${db.peak.toFixed(0)} dB peak`}
      </div>
    </div>
  );
}

/** Scrolling waveform of what is being recorded right now. */
function LiveWave({ active }: { active: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let raf = 0;
    const peaks: number[] = [];
    const buf = new Float32Array(2048);
    const draw = () => {
      const c = ref.current;
      const an = getAnalyser();
      if (c) {
        const w = (c.width = c.clientWidth * devicePixelRatio);
        const h = (c.height = c.clientHeight * devicePixelRatio);
        const ctx = c.getContext('2d')!;
        if (an && active) {
          an.getFloatTimeDomainData(buf);
          let p = 0;
          for (let i = 0; i < buf.length; i++) p = Math.max(p, Math.abs(buf[i]));
          peaks.push(p);
          if (peaks.length > w / (2 * devicePixelRatio)) peaks.shift();
        }
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = '#0b0b0c';
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#6ee7d2';
        const step = 2 * devicePixelRatio;
        peaks.forEach((p, i) => {
          const ph = Math.max(devicePixelRatio, Math.min(1, p * 1.4) * h * 0.9);
          ctx.fillRect(w - (peaks.length - i) * step, (h - ph) / 2, step - devicePixelRatio * 0.5, ph);
        });
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [active]);
  return <canvas ref={ref} className="live-wave" />;
}

/** Big 3-2-1 over the viewer during the countdown, and a REC dot while recording. */
export function VoiceOverlay() {
  const status = useVoice((s) => s.status);
  const countdown = useVoice((s) => s.countdown);
  if (status === 'countdown') return <div className="voice-countdown">{countdown}</div>;
  if (status === 'recording') return <div className="rec-badge">● RECORDING AUDIO</div>;
  return null;
}
