import { useEffect, useRef } from 'react';
import type { Ease, EaseType, Keyframe, Project, TimelineObject } from '../../format/schema';
import { easeProgress, getPath, isAnimated, KEY_EPS } from '../../format/values';
import { commit, editor, useEditor } from '../../state/store';
import { findObject } from '../../state/commands';
import { NumField } from '../Inspector/fields';

export const EASE_CHOICES: { type: EaseType; label: string; hint: string }[] = [
  { type: 'linear', label: 'Linear', hint: 'Constant speed' },
  { type: 'easeInOut', label: 'Ease In-Out', hint: 'Slow start and end' },
  { type: 'easeOut', label: 'Ease Out', hint: 'Fast start, gentle landing' },
  { type: 'easeIn', label: 'Ease In', hint: 'Gentle start, fast finish' },
  { type: 'back', label: 'Overshoot', hint: 'Goes past the target, then settles back' },
  { type: 'spring', label: 'Spring', hint: 'Bouncy damped spring' },
  { type: 'bounce', label: 'Bounce', hint: 'Drops and bounces like a ball' },
  { type: 'smooth', label: 'Smooth', hint: 'Flows through neighbouring keyframes (used by recordings)' },
  { type: 'hold', label: 'Hold', hint: 'Jumps at the keyframe (no motion)' },
  { type: 'bezier', label: 'Custom', hint: 'Your own curve — drag the handles' },
];

/** A fresh ease of `type`, keeping parameters from `prev` when it is the same type. */
export function easeFromChoice(type: EaseType, prev?: Ease): Ease {
  if (prev && prev.type === type) return prev;
  switch (type) {
    case 'back':
      return { type, overshoot: 1.7 };
    case 'spring':
      return { type, damping: 0.35, frequency: 3 };
    case 'bezier':
      return { type, x1: 0.34, y1: 1.56, x2: 0.64, y2: 1 };
    default:
      return { type } as Ease;
  }
}

/** Progress curve for previews ('smooth' depends on neighbours, so preview it as a smoothstep). */
function preview(ease: Ease, u: number, segDur: number) {
  if (ease.type === 'smooth') return u * u * (3 - 2 * u);
  return easeProgress(ease, u, segDur);
}

function curvePath(ease: Ease, segDur: number, w: number, h: number, y0: number, y1: number, n = 80) {
  let d = '';
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const v = preview(ease, u, segDur);
    const x = u * w;
    const y = h - ((v - y0) / (y1 - y0)) * h;
    d += `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
  }
  return d;
}

function MiniCurve({ type }: { type: EaseType }) {
  const e = easeFromChoice(type);
  return (
    <svg width="34" height="22" viewBox="-2 -4 38 30">
      <path d={curvePath(e, 1, 34, 22, -0.35, 1.35, 40)} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function EasePanel({ obj, path }: { obj: TimelineObject; path: string }) {
  const graphKeys = useEditor((s) => s.graphKeys);
  const val = getPath(obj, path);
  const keys: Keyframe[] = isAnimated(val) ? val.keyframes : [];
  const selIdx = keys.map((k, i) => (graphKeys.some((t) => Math.abs(t - k.t) < KEY_EPS) ? i : -1)).filter((i) => i >= 0);
  const editable = selIdx.filter((i) => i > 0);
  const i = editable[0];
  const key = i !== undefined ? keys[i] : undefined;
  const segDur = key ? key.t - keys[i - 1].t : 1;

  const setEase = (ease: Ease, coalesce?: string, all = false) =>
    commit(
      (d) => {
        const o = findObject(d as Project, obj.id)!.obj;
        const a = getPath(o, path);
        if (!isAnimated(a)) return;
        a.keyframes.forEach((k, idx) => {
          if (idx === 0) return;
          if (all || editable.some((e) => Math.abs(keys[e].t - k.t) < KEY_EPS)) k.ease = { ...ease };
        });
      },
      coalesce ? { coalesce: `${obj.id}:${path}:ease:${coalesce}` } : undefined,
    );

  if (!key) {
    return (
      <div className="ease-panel">
        <div className="ease-head">Easing</div>
        <div className="hint" style={{ padding: '6px 12px' }}>
          {!keys.length
            ? 'Add at least two keyframes, then select one to choose how the motion arrives at it.'
            : selIdx.includes(0) && selIdx.length === 1
              ? 'This is the first keyframe — nothing moves into it. Select a later keyframe to shape its curve.'
              : 'Click a ◆ in the graph to shape how the value travels into it — e.g. overshoot or a spring.'}
        </div>
        <div className="ease-grid disabled">
          {EASE_CHOICES.map((c) => (
            <button key={c.type} className="ease-choice" disabled title={c.hint}>
              <MiniCurve type={c.type} />
              <span>{c.label}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  const ease = key.ease;
  return (
    <div className="ease-panel">
      <div className="ease-head">
        Ease into keyframe {i + 1}
        <span className="hint">
          {editable.length > 1 ? `${editable.length} keyframes selected · ` : ''}
          {segDur.toFixed(2)}s move
        </span>
      </div>
      <BigCurve ease={ease} segDur={segDur} onBezier={(b) => setEase(b, 'bez')} />
      <FeelPreview ease={ease} segDur={segDur} />
      <div className="ease-grid">
        {EASE_CHOICES.map((c) => (
          <button key={c.type} className={`ease-choice ${ease.type === c.type ? 'on' : ''}`} title={c.hint} onClick={() => setEase(easeFromChoice(c.type, ease))}>
            <MiniCurve type={c.type} />
            <span>{c.label}</span>
          </button>
        ))}
      </div>
      <div className="ease-params">
        {ease.type === 'back' && (
          <NumField label="Overshoot" value={ease.overshoot} def={1.7} min={0} max={10} step={0.05} slider={[0, 6]} precision={2} onChange={(v) => setEase({ ...ease, overshoot: v }, 'ov')} />
        )}
        {ease.type === 'spring' && (
          <>
            <NumField label="Damping" value={ease.damping} def={0.35} min={0.01} max={1} step={0.01} slider={[0.03, 1]} precision={2} onChange={(v) => setEase({ ...ease, damping: v }, 'damp')} />
            <NumField label="Frequency" value={ease.frequency} def={3} min={0.1} max={20} step={0.1} slider={[0.5, 10]} precision={1} unit="Hz" onChange={(v) => setEase({ ...ease, frequency: v }, 'freq')} />
            <div className="hint">Low damping = more wobble. Frequency = wobbles per second.</div>
          </>
        )}
        {ease.type === 'bezier' && (
          <>
            <NumField label="Handle 1 x" value={ease.x1} min={0} max={1} step={0.01} precision={2} onChange={(v) => setEase({ ...ease, x1: v }, 'x1')} />
            <NumField label="Handle 1 y" value={ease.y1} min={-5} max={5} step={0.01} precision={2} onChange={(v) => setEase({ ...ease, y1: v }, 'y1')} />
            <NumField label="Handle 2 x" value={ease.x2} min={0} max={1} step={0.01} precision={2} onChange={(v) => setEase({ ...ease, x2: v }, 'x2')} />
            <NumField label="Handle 2 y" value={ease.y2} min={-5} max={5} step={0.01} precision={2} onChange={(v) => setEase({ ...ease, y2: v }, 'y2')} />
          </>
        )}
      </div>
      <div className="ease-foot">
        <button className="btn" onClick={() => setEase(ease, undefined, true)} title="Use this ease for every keyframe of this property">
          Apply to all keyframes
        </button>
      </div>
    </div>
  );
}

const BW = 240;
const BH = 150;

function BigCurve({ ease, segDur, onBezier }: { ease: Ease; segDur: number; onBezier: (e: Ease) => void }) {
  const svgRef = useRef<SVGSVGElement>(null);
  let lo = 0;
  let hi = 1;
  for (let i = 0; i <= 120; i++) {
    const v = preview(ease, i / 120, segDur);
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  if (ease.type === 'bezier') {
    lo = Math.min(lo, ease.y1, ease.y2);
    hi = Math.max(hi, ease.y1, ease.y2);
  }
  const pad = (hi - lo) * 0.1 + 0.05;
  const y0 = lo - pad;
  const y1 = hi + pad;
  const Y = (v: number) => BH - ((v - y0) / (y1 - y0)) * BH;
  const X = (u: number) => u * BW;

  const dragHandle = (which: 1 | 2) => (e: React.PointerEvent) => {
    if (ease.type !== 'bezier') return;
    e.stopPropagation();
    const r = svgRef.current!.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const x = Math.min(1, Math.max(0, (ev.clientX - r.left - 10) / BW));
      const y = Math.min(5, Math.max(-5, y0 + (1 - (ev.clientY - r.top - 10) / BH) * (y1 - y0)));
      const rx = Math.round(x * 100) / 100;
      const ry = Math.round(y * 100) / 100;
      onBezier(which === 1 ? { ...ease, x1: rx, y1: ry } : { ...ease, x2: rx, y2: ry });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <svg ref={svgRef} className="ease-big" width={BW + 20} height={BH + 20} viewBox={`-10 -10 ${BW + 20} ${BH + 20}`}>
      <rect x={0} y={0} width={BW} height={BH} className="eb-frame" />
      <line x1={0} x2={BW} y1={Y(0)} y2={Y(0)} className="eb-ref" />
      <line x1={0} x2={BW} y1={Y(1)} y2={Y(1)} className="eb-ref" />
      <text x={4} y={Y(1) - 4} className="eb-label">
        target
      </text>
      <text x={4} y={Y(0) - 4} className="eb-label">
        start
      </text>
      {ease.type === 'bezier' && (
        <g>
          <line x1={X(0)} y1={Y(0)} x2={X(ease.x1)} y2={Y(ease.y1)} className="eb-handle-line" />
          <line x1={X(1)} y1={Y(1)} x2={X(ease.x2)} y2={Y(ease.y2)} className="eb-handle-line" />
        </g>
      )}
      <path d={curvePath(ease, segDur, BW, BH, y0, y1, 160)} className="eb-curve" />
      {ease.type === 'bezier' && (
        <g>
          <circle cx={X(ease.x1)} cy={Y(ease.y1)} r={6} className="eb-handle" onPointerDown={dragHandle(1)} />
          <circle cx={X(ease.x2)} cy={Y(ease.y2)} r={6} className="eb-handle" onPointerDown={dragHandle(2)} />
        </g>
      )}
    </svg>
  );
}

/** A ball that moves with the ease, on loop — so you can feel the motion. */
function FeelPreview({ ease, segDur }: { ease: Ease; segDur: number }) {
  const ballRef = useRef<HTMLDivElement>(null);
  const easeRef = useRef(ease);
  easeRef.current = ease;
  useEffect(() => {
    let raf = 0;
    const t0 = performance.now();
    const loop = (now: number) => {
      const dur = Math.min(3, Math.max(0.35, segDur));
      const cycle = dur + 0.7;
      const t = ((now - t0) / 1000) % cycle;
      const u = Math.min(1, t / dur);
      const p = preview(easeRef.current, u, segDur);
      if (ballRef.current) ballRef.current.style.left = `calc(${12 + p * 76}% - 7px)`;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [segDur]);
  return (
    <div className="feel" title="Live preview of the motion">
      <span className="mark" style={{ left: '12%' }} />
      <span className="mark target" style={{ left: '88%' }} />
      <div className="ball" ref={ballRef} />
    </div>
  );
}
