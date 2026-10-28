import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { produce } from 'immer';
import { isVisual, type Project, type VisualObject } from '../format/schema';
import { isActiveAt, setValueAt, shiftValue } from '../format/values';
import { boxCenter, effectiveTransform, hitTest, objectBox, renderFrame } from '../engine/compositor';
import { liveTrail, liveValue, recordInput, toggleRecording } from '../engine/recorder';
import { onMediaUpdate } from '../engine/mediaCache';
import { pause, previewSources, togglePlay } from '../engine/playback';
import { editor, endLive, select, setLive, setPlayhead, useEditor } from '../state/store';
import { findObject, projectDuration } from '../state/commands';
import { jumpMarker } from '../state/actions';
import { Icon } from './icons';
import { VoiceOverlay } from './VoicePanel';
import { timecode } from './time';

export function Viewer() {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [fit, setFit] = useState({ w: 640, h: 360, left: 0, top: 0 });
  const pw = useEditor((s) => s.project.project.width);
  const recording = useEditor((s) => s.recording);
  const ph = useEditor((s) => s.project.project.height);

  // fit canvas into the stage, keeping aspect ratio
  useLayoutEffect(() => {
    const el = stageRef.current!;
    const update = () => {
      const W = el.clientWidth - 24;
      const H = el.clientHeight - 24;
      const k = Math.min(W / pw, H / ph);
      const w = Math.max(10, Math.floor(pw * k));
      const h = Math.max(10, Math.floor(ph * k));
      setFit({ w, h, left: (el.clientWidth - w) / 2, top: (el.clientHeight - h) / 2 });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [pw, ph]);

  // render loop: redraw whenever something changed (or every frame while playing)
  useEffect(() => {
    let dirty = true;
    let raf = 0;
    const mark = () => (dirty = true);
    const unsubStore = useEditor.subscribe((s, prev) => {
      if (s.project !== prev.project || s.playhead !== prev.playhead) dirty = true;
    });
    const unsubMedia = onMediaUpdate(mark);
    const loop = () => {
      const s = editor.get();
      const c = canvasRef.current;
      if (c && (dirty || s.playing)) {
        dirty = false;
        const dpr = Math.min(devicePixelRatio || 1, 2);
        // render at display resolution (capped at project resolution) for speed
        const k = Math.min(1, (c.clientWidth * dpr) / s.project.project.width);
        const w = Math.max(2, Math.round(s.project.project.width * k));
        const h = Math.max(2, Math.round(s.project.project.height * k));
        if (c.width !== w || c.height !== h) {
          c.width = w;
          c.height = h;
        }
        renderFrame(c.getContext('2d')!, s.project, s.playhead, previewSources);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const ro = new ResizeObserver(mark);
    if (canvasRef.current) ro.observe(canvasRef.current);
    return () => {
      cancelAnimationFrame(raf);
      unsubStore();
      unsubMedia();
      ro.disconnect();
    };
  }, []);

  const toProject = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    const s = editor.get().project.project;
    return { x: ((e.clientX - r.left) / r.width) * s.width, y: ((e.clientY - r.top) / r.height) * s.height };
  };

  // While recording, the whole viewer is a controller: left-drag = move, right-drag = scale, wheel = rotate.
  useEffect(() => {
    const el = stageRef.current!;
    const wheel = (e: WheelEvent) => {
      if (!editor.get().recording) return;
      e.preventDefault();
      const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      const step = e.shiftKey ? 0.03 : 0.12; // degrees per pixel of scroll
      recordInput({ 'transform.rotation': Math.round((liveValue('transform.rotation') + px * step) * 100) / 100 });
    };
    const ctx = (e: MouseEvent) => editor.get().recording && e.preventDefault();
    el.addEventListener('wheel', wheel, { passive: false });
    el.addEventListener('contextmenu', ctx);
    return () => {
      el.removeEventListener('wheel', wheel);
      el.removeEventListener('contextmenu', ctx);
    };
  }, []);

  const startPerformance = (e: React.PointerEvent) => {
    e.preventDefault();
    const canvas = canvasRef.current!;
    const k = editor.get().project.project.width / canvas.getBoundingClientRect().width; // project px per screen px
    let lastX = e.clientX;
    let lastY = e.clientY;
    const apply = (ev: PointerEvent, buttons: number) => {
      const dx = ev.clientX - lastX;
      const dy = ev.clientY - lastY;
      lastX = ev.clientX;
      lastY = ev.clientY;
      const values: Record<string, number> = {};
      if (buttons & 1) {
        values['transform.x'] = Math.round((liveValue('transform.x') + dx * k) * 10) / 10;
        values['transform.y'] = Math.round((liveValue('transform.y') + dy * k) * 10) / 10;
      }
      if (buttons & 2) {
        const f = Math.exp((dx - dy) / 220); // drag up / right = bigger
        values['transform.scale'] = Math.max(0.01, Math.round(liveValue('transform.scale') * f * 10000) / 10000);
      }
      if (Object.keys(values).length) recordInput(values);
    };
    // touching a channel starts recording it right away (even before the mouse moves)
    apply(e.nativeEvent, e.buttons);
    const move = (ev: PointerEvent) => apply(ev, ev.buttons);
    const up = (ev: PointerEvent) => {
      if (ev.buttons) return; // another button is still held
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onStageDown = (e: React.PointerEvent) => {
    if (editor.get().recording) {
      // a second button pressed while the first is held arrives as pointermove, so only start once
      if ((e.buttons & ~(e.button === 0 ? 1 : 2)) === 0) startPerformance(e);
      return;
    }
    if (e.button !== 0 || (e.target as HTMLElement).closest('.sel-box')) return;
    const s = editor.get();
    const p = toProject(e);
    const id = hitTest(s.project, s.playhead, p.x, p.y, previewSources);
    if (id) {
      select([id], e.shiftKey ? 'toggle' : 'replace');
      if (!e.shiftKey) startTransformDrag(e, id, 'move');
    } else select([]);
  };

  return (
    <div className="panel viewer">
      <div className="panel-head">
        <Icon name="video" size={13} /> Viewer
        <span style={{ color: 'var(--muted)', fontWeight: 400, fontFamily: 'var(--mono)', fontSize: 11 }}>
          {pw}×{ph} · {Math.round((fit.w / pw) * 100)}%
        </span>
        <span className="spacer" />
        <RecordControls />
      </div>
      <div className={`viewer-stage ${recording ? 'recording' : ''}`} ref={stageRef} onPointerDown={onStageDown}>
        {recording && (
          <div className="rec-badge">
            ● REC &nbsp; left-drag <b>move</b> · scroll <b>rotate</b> · right-drag <b>scale</b> · Space <b>stop</b>
          </div>
        )}
        <VoiceOverlay />
        <canvas ref={canvasRef} style={{ width: fit.w, height: fit.h }} />
        <div className="viewer-overlay" style={{ left: fit.left, top: fit.top, width: fit.w, height: fit.h }}>
          <MotionPathOverlay scale={fit.w / pw} w={fit.w} h={fit.h} />
          <SelectionBox scale={fit.w / pw} />
        </div>
      </div>
      <Transport />
    </div>
  );
}

/**
 * Drag on the canvas to move; corner handles scale; top knob rotates. Each drag is one undo step.
 * Animated objects move AS A WHOLE: every keyframe shifts by the drag, so the motion keeps its shape.
 * Hold Alt to edit only the value at the playhead instead (adds / updates a keyframe there).
 * Moving drags every selected object together.
 */
function startTransformDrag(e: React.PointerEvent, id: string, mode: 'move' | 'scale' | 'rotate') {
  const s = editor.get();
  const f = findObject(s.project, id);
  if (!f || !isVisual(f.obj) || f.track.locked) return;
  if (s.recording) return;
  const recording = false;
  const before = s.project;
  const localT = s.playhead - f.obj.start;
  const t0 = effectiveTransform(f.obj, localT);
  const canvas = document.querySelector('.viewer-stage canvas') as HTMLCanvasElement;
  const r = canvas.getBoundingClientRect();
  const k = s.project.project.width / r.width; // project px per screen px
  const cx = r.left + (s.project.project.width / 2 + t0.x) / k;
  const cy = r.top + (s.project.project.height / 2 + t0.y) / k;
  const d0 = Math.hypot(e.clientX - cx, e.clientY - cy) || 1;
  const a0 = Math.atan2(e.clientY - cy, e.clientX - cx);
  let moved = false;

  const valuesFor = (ev: PointerEvent): Record<string, number> => {
    const dx = (ev.clientX - e.clientX) * k;
    const dy = (ev.clientY - e.clientY) * k;
    if (mode === 'move') {
      let x = t0.x + dx;
      let y = t0.y + dy;
      if (ev.shiftKey) Math.abs(dx) > Math.abs(dy) ? (y = t0.y) : (x = t0.x);
      if (!recording && s.selection.length <= 1) {
        // snap to center
        if (Math.abs(x) < 8 * k) x = 0;
        if (Math.abs(y) < 8 * k) y = 0;
      }
      return { 'transform.x': Math.round(x * 10) / 10, 'transform.y': Math.round(y * 10) / 10 };
    }
    if (mode === 'scale') {
      const dist = Math.hypot(ev.clientX - cx, ev.clientY - cy);
      return { 'transform.scale': Math.max(0.01, Math.round(t0.scale * (dist / d0) * 1000) / 1000) };
    }
    const a = Math.atan2(ev.clientY - cy, ev.clientX - cx);
    let deg = t0.rotation + ((a - a0) * 180) / Math.PI;
    if (ev.shiftKey) deg = Math.round(deg / 15) * 15;
    return { 'transform.rotation': Math.round(deg * 10) / 10 };
  };

  // everything selected moves together (only the grabbed object scales / rotates)
  const movers = mode === 'move' ? [id, ...s.selection.filter((x) => x !== id && findObject(before, x)?.track.locked === false)] : [id];
  const move = (ev: PointerEvent) => {
    if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 2) return;
    moved = true;
    const values = valuesFor(ev);
    setLive(
      produce(before, (d) => {
        for (const oid of movers) {
          const f2 = findObject(d as Project, oid);
          if (!f2 || !isVisual(f2.obj)) continue;
          const o = f2.obj;
          if (ev.altKey) {
            // Alt: just this moment, keyframe at the playhead (grabbed object only)
            if (oid === id) for (const [path, v] of Object.entries(values)) setValueAt(o, path, v, localT);
            continue;
          }
          for (const [path, v] of Object.entries(values)) {
            const base = path === 'transform.x' ? t0.x : path === 'transform.y' ? t0.y : path === 'transform.scale' ? t0.scale : t0.rotation;
            if (path === 'transform.scale') shiftValue(o, path, { mul: base ? v / base : 1 });
            else shiftValue(o, path, { add: v - base });
          }
        }
      }),
    );
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    if (moved) endLive(before);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

/** The recorded motion path(s) of the selected object, drawn as a line it follows (plus the live trail while recording). */
function MotionPathOverlay({ scale, w, h }: { scale: number; w: number; h: number }) {
  const selection = useEditor((s) => s.selection);
  const project = useEditor((s) => s.project);
  const recording = useEditor((s) => s.recording);
  const recordTarget = useEditor((s) => s.recordTarget);
  const [, bump] = useState(0);
  useEffect(() => onMediaUpdate(() => bump((n) => n + 1)), []);
  const id = recording ? recordTarget : selection.length === 1 ? selection[0] : null;
  const f = id ? findObject(project, id) : null;
  if (!f || !isVisual(f.obj)) return null;
  const W = project.project.width / 2;
  const H = project.project.height / 2;
  const pt = (x: number, y: number) => `${((W + x) * scale).toFixed(1)},${((H + y) * scale).toFixed(1)}`;
  const lines: string[] = [];
  for (const m of f.obj.motion ?? []) {
    if (!m.x && !m.y) continue;
    const n = Math.max(m.x?.length ?? 0, m.y?.length ?? 0);
    const pts: string[] = [];
    for (let i = 0; i < n; i++) {
      const t = m.start + i / m.rate;
      const tr = effectiveTransform(f.obj, t);
      pts.push(pt(m.x?.[i] ?? tr.x, m.y?.[i] ?? tr.y));
    }
    lines.push(pts.join(' '));
  }
  const trail = recording ? liveTrail() : [];
  if (!lines.length && trail.length < 2) return null;
  return (
    <svg className="motion-overlay" width={w} height={h}>
      {lines.map((l, i) => (
        <g key={i}>
          <polyline points={l} className="mp-line" />
          <circle cx={l.split(' ')[0].split(',')[0]} cy={l.split(' ')[0].split(',')[1]} r={3.5} className="mp-start" />
        </g>
      ))}
      {trail.length > 1 && <polyline points={trail.map((p) => pt(p.x, p.y)).join(' ')} className="mp-line live" />}
    </svg>
  );
}

function SelectionBox({ scale }: { scale: number }) {
  const selection = useEditor((s) => s.selection);
  const project = useEditor((s) => s.project);
  const playhead = useEditor((s) => s.playhead);
  const recording = useEditor((s) => s.recording);
  const [, bump] = useState(0);
  useEffect(() => onMediaUpdate(() => bump((n) => n + 1)), []);
  if (selection.length !== 1) return null;
  const f = findObject(project, selection[0]);
  if (!f || !isVisual(f.obj) || !isActiveAt(f.obj, playhead) || f.track.hidden) return null;
  const o = f.obj;
  const box = objectBox(o, project, previewSources, playhead - o.start);
  if (!box) return null;
  const tr = effectiveTransform(o, playhead - o.start);
  const w = box.w * Math.abs(tr.scale) * scale;
  const h = box.h * Math.abs(tr.scale) * scale;
  const c = boxCenter(tr, box); // groups: their contents aren't necessarily centered on the group's position
  const cx = (project.project.width / 2 + c.x) * scale;
  const cy = (project.project.height / 2 + c.y) * scale;
  const handle = (cls: string) => <div className={`h ${cls}`} onPointerDown={(e) => (e.stopPropagation(), startTransformDrag(e, o.id, 'scale'))} />;
  if (recording) {
    return <div className="sel-box rec" style={{ left: cx - w / 2, top: cy - h / 2, width: w, height: h, transform: `rotate(${tr.rotation}deg)`, pointerEvents: 'none' }} />;
  }
  return (
    <div
      className="sel-box"
      style={{ left: cx - w / 2, top: cy - h / 2, width: w, height: h, transform: `rotate(${tr.rotation}deg)` }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        startTransformDrag(e, o.id, 'move');
      }}
    >
      {handle('nw')}
      {handle('ne')}
      {handle('sw')}
      {handle('se')}
      <div className="rot" title="Rotate (Shift = 15° steps)" onPointerDown={(e) => (e.stopPropagation(), startTransformDrag(e, o.id, 'rotate'))} />
    </div>
  );
}

function RecordControls() {
  const recording = useEditor((s) => s.recording);
  const speed = useEditor((s) => s.recordSpeed);
  const smoothing = useEditor((s) => s.recordSmoothing);
  return (
    <div className="rec-controls">
      <button
        className={`rec-btn ${recording ? 'on' : ''}`}
        title={'Record animation (R)\nSelect an object, press Rec, then perform while the video plays:\nleft-drag = move · scroll = rotate · right-drag = scale (anywhere in the viewer).\nSpace or Rec stops.'}
        onClick={toggleRecording}
      >
        <span className="rec-dot" /> {recording ? 'Stop' : 'Rec'}
      </button>
      <select className="input rec-select" title="Playback speed while recording (slower = easier to perform)" value={speed} disabled={recording} onChange={(e) => editor.set({ recordSpeed: Number(e.target.value) })}>
        <option value={1}>1×</option>
        <option value={0.5}>½×</option>
        <option value={0.25}>¼×</option>
      </select>
      <select className="input rec-select" title="How much the recorded motion is smoothed" value={smoothing} disabled={recording} onChange={(e) => editor.set({ recordSmoothing: e.target.value as any })}>
        <option value="exact">Exact</option>
        <option value="light">Light smoothing</option>
        <option value="smooth">Smooth</option>
      </select>
    </div>
  );
}

function Transport() {
  const playhead = useEditor((s) => s.playhead);
  const playing = useEditor((s) => s.playing);
  const rate = useEditor((s) => s.rate);
  const loop = useEditor((s) => s.loop);
  const fps = useEditor((s) => s.project.project.fps);
  const duration = useEditor((s) => projectDuration(s.project));
  const step = (n: number) => {
    if (editor.get().playing) pause();
    setPlayhead(editor.get().playhead + n / fps);
  };
  return (
    <div className="transport">
      <span className="timecode" title="Playhead (HH:MM:SS:FF)">
        {timecode(playhead, fps)}
      </span>
      <div className="center">
        <button className="icon-btn" title="Go to start (Home)" onClick={() => setPlayhead(0)}>
          <Icon name="start" size={14} />
        </button>
        <button className="icon-btn" title="Previous edit / marker (Up)" onClick={() => jumpMarker(-1)}>
          <Icon name="prev" size={14} />
        </button>
        <button className="icon-btn" title="Back one frame (Left)" onClick={() => step(-1)}>
          <Icon name="prev" size={11} />
        </button>
        <button className={`icon-btn play-btn ${playing ? 'on-yellow' : ''}`} title="Play / Pause (Space)" onClick={() => togglePlay()}>
          <Icon name={playing ? 'pause' : 'play'} size={16} />
        </button>
        <button className="icon-btn" title="Forward one frame (Right)" onClick={() => step(1)}>
          <Icon name="next" size={11} />
        </button>
        <button className="icon-btn" title="Next edit / marker (Down)" onClick={() => jumpMarker(1)}>
          <Icon name="next" size={14} />
        </button>
        <button className="icon-btn" title="Go to end (End)" onClick={() => setPlayhead(duration)}>
          <Icon name="end" size={14} />
        </button>
        <button className={`icon-btn ${loop ? 'active' : ''}`} title="Loop playback (Ctrl+L)" onClick={() => editor.set({ loop: !loop })}>
          <Icon name="loop" size={14} />
        </button>
      </div>
      <span className="timecode small" style={{ minWidth: 120, textAlign: 'right' }}>
        {playing && rate !== 1 ? <b style={{ color: 'var(--yellow)', marginRight: 8 }}>{rate}×</b> : null}
        {timecode(duration, fps)}
      </span>
    </div>
  );
}
