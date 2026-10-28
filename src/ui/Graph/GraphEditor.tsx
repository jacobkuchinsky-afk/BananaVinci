import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { produce } from 'immer';
import type { Animatable, AnimValue, Keyframe, Project, TimelineObject } from '../../format/schema';
import {
  animatableProps,
  animatedPaths,
  getPath,
  isAnimated,
  keyIndexAt,
  setPath,
  toggleKeyframe,
  upsertKeyframe,
  valueAt,
  KEY_EPS,
  type AnimProp,
} from '../../format/values';
import { commit, editor, endLive, setLive, setPlayhead, useEditor } from '../../state/store';
import { findObject } from '../../state/commands';
import { openContextMenu, type MenuEntry } from '../ContextMenu';
import { EasePanel, EASE_CHOICES, easeFromChoice } from './EasePanel';

// ----------------------------------------------------------------------------- actions (also used by shortcuts)

function current() {
  const s = editor.get();
  const id = s.selection.length === 1 ? s.selection[0] : null;
  const f = id ? findObject(s.project, id) : null;
  return f ? { s, obj: f.obj } : null;
}

const has = (times: number[], t: number) => times.some((x) => Math.abs(x - t) < KEY_EPS);

/** Delete the selected keyframes of the active curve. Returns false if there was nothing to delete. */
export function deleteGraphKeys(): boolean {
  const c = current();
  if (!c || !c.s.graphKeys.length) return false;
  const { s, obj } = c;
  const path = s.graphPath;
  commit((d) => {
    const o = findObject(d as Project, obj.id)!.obj;
    const a = getPath(o, path);
    if (!isAnimated(a)) return;
    const localT = s.playhead - o.start;
    const keep = a.keyframes.filter((k) => !has(s.graphKeys, k.t));
    if (keep.length) a.keyframes = keep;
    else setPath(o, path, valueAt(a, localT));
  });
  editor.set({ graphKeys: [] });
  return true;
}

export function setKeysEase(times: number[], choice: (typeof EASE_CHOICES)[number]['type']) {
  const c = current();
  if (!c) return;
  const { s, obj } = c;
  commit((d) => {
    const o = findObject(d as Project, obj.id)!.obj;
    const a = getPath(o, s.graphPath);
    if (isAnimated(a)) for (const k of a.keyframes) if (has(times, k.t)) k.ease = easeFromChoice(choice, k.ease);
  });
}

// ----------------------------------------------------------------------------- component

export function GraphEditor() {
  const selection = useEditor((s) => s.selection);
  const project = useEditor((s) => s.project);
  const graphPath = useEditor((s) => s.graphPath);
  const obj = selection.length === 1 ? findObject(project, selection[0])?.obj : undefined;

  if (!obj) return <AnimationHome project={project} />;
  const props = animatableProps(obj);
  const animated = animatedPaths(obj);
  const path = props.some((p) => p.path === graphPath) ? graphPath : (animated[0] ?? props[0].path);
  const prop = props.find((p) => p.path === path)!;
  return (
    <div className="graph">
      <PropList obj={obj} props={props} path={path} />
      <CurveView obj={obj} prop={prop} fps={project.project.fps} />
      <EasePanel obj={obj} path={path} />
    </div>
  );
}

function AnimationHome({ project }: { project: Project }) {
  const animated = project.tracks.flatMap((t) => t.objects.map((o) => ({ o, paths: animatedPaths(o) }))).filter((x) => x.paths.length);
  return (
    <div className="anim-home">
      <div className="anim-how">
        <div className="big">
          <span className="kf-glyph">◆</span> Animation
        </div>
        <ol>
          <li>
            <b>Select an object</b> on the timeline or in the viewer.
          </li>
          <li>
            <b>Keyframes:</b> move the playhead, click the <span className="kf-glyph">◆</span> next to a property in the Inspector, then change the value at another time.
          </li>
          <li>
            <b>Easing:</b> come back here, click a keyframe on the curve, and pick Overshoot, Spring, Bounce… (tweak damping and overshoot with the sliders).
          </li>
          <li>
            <b>Record:</b> press <span className="rec-inline">● Rec</span> above the viewer (or <kbd className="k">R</kbd>) and drag the object while it plays.
          </li>
        </ol>
      </div>
      <div className="anim-objects">
        <div className="lib-section">Animated objects · {animated.length}</div>
        {!animated.length && <div className="hint" style={{ padding: '4px 10px' }}>Nothing is animated yet.</div>}
        {animated.map(({ o, paths }) => (
          <button key={o.id} className="anim-row" onClick={() => editor.set({ selection: [o.id], graphPath: paths[0], graphKeys: [] })}>
            <span className="kf-glyph">◆</span>
            <span className="name">{o.id}</span>
            <span className="meta">{paths.map((p) => p.replace('transform.', '')).join(', ')}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function PropList({ obj, props, path }: { obj: TimelineObject; props: AnimProp[]; path: string }) {
  const playhead = useEditor((s) => (s.playing ? Math.round(s.playhead * 8) / 8 : s.playhead)); // throttled while playing
  const localT = playhead - obj.start;
  return (
    <div className="graph-props">
      <div className="graph-props-head">{obj.id}</div>
      {props.map((p) => {
        const v = getPath(obj, p.path) as Animatable;
        const anim = isAnimated(v);
        const onKey = anim && keyIndexAt(v, localT) >= 0;
        return (
          <div key={p.path} className={`graph-prop ${p.path === path ? 'active' : ''} ${anim ? 'animated' : ''}`} onClick={() => editor.set({ graphPath: p.path, graphKeys: [] })}>
            <button
              className={`kf-btn ${!anim ? 'none' : onKey ? 'onKey' : 'animated'} ${anim && v.recorded ? 'recorded' : ''}`}
              title={onKey ? 'Remove keyframe at playhead' : 'Add keyframe at playhead'}
              onClick={(e) => {
                e.stopPropagation();
                commit((d) => toggleKeyframe(findObject(d as Project, obj.id)!.obj, p.path, localT));
                editor.set({ graphPath: p.path });
              }}
            >
              <svg width="11" height="11" viewBox="0 0 10 10">
                <path d="M5 0.8 9.2 5 5 9.2 0.8 5Z" />
              </svg>
            </button>
            <span className="name">{p.label}</span>
            <span className="val">
              {fmtVal(valueAt(v, localT), p)}
              {anim && <span className="count">{v.keyframes.length}◆</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function fmtVal(v: number, p: AnimProp) {
  const digits = p.step < 0.1 ? 2 : p.step < 1 ? 1 : 0;
  return `${v.toFixed(digits)}${p.unit && p.unit !== 'px' ? p.unit : ''}`;
}

function niceStep(range: number, target: number) {
  const raw = range / Math.max(1, target);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
}

const PAD = { l: 58, r: 18, t: 24, b: 22 };

function CurveView({ obj, prop, fps }: { obj: TimelineObject; prop: AnimProp; fps: number }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 600, h: 260 });
  const playhead = useEditor((s) => (s.playing ? Math.round(s.playhead * 8) / 8 : s.playhead)); // throttled while playing
  const graphKeys = useEditor((s) => s.graphKeys);
  const frozen = useRef<{ T0: number; T1: number; V0: number; V1: number } | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number; text: string } | null>(null);

  useLayoutEffect(() => {
    const el = wrapRef.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const val = getPath(obj, prop.path) as Animatable;
  const anim = isAnimated(val) ? val : null;
  const keys = anim?.keyframes ?? [];

  // ---- domains (frozen while dragging so the view doesn't jump)
  const range = useMemo(() => {
    const lo = Math.min(0, keys[0]?.t ?? 0);
    const hi = Math.max(obj.duration, keys[keys.length - 1]?.t ?? 0);
    const span = hi - lo || 1;
    const T0 = lo - span * 0.03;
    const T1 = hi + span * 0.03;
    let vmin = Infinity;
    let vmax = -Infinity;
    for (let i = 0; i <= 240; i++) {
      const v = valueAt(val, T0 + ((T1 - T0) * i) / 240);
      vmin = Math.min(vmin, v);
      vmax = Math.max(vmax, v);
    }
    for (const k of keys) {
      vmin = Math.min(vmin, k.v);
      vmax = Math.max(vmax, k.v);
    }
    if (vmax - vmin < 1e-9) {
      const pad = Math.max(Math.abs(vmax) * 0.25, prop.step * 20, prop.max !== undefined ? prop.max * 0.25 : 1);
      vmin -= pad;
      vmax += pad;
    } else {
      const pad = (vmax - vmin) * 0.14;
      vmin -= pad;
      vmax += pad;
    }
    return { T0, T1, V0: vmin, V1: vmax };
  }, [val, obj.duration, prop]);
  const R = frozen.current ?? range;

  const W = Math.max(50, size.w);
  const H = Math.max(50, size.h);
  const X = (t: number) => PAD.l + ((t - R.T0) / (R.T1 - R.T0)) * (W - PAD.l - PAD.r);
  const Y = (v: number) => PAD.t + (1 - (v - R.V0) / (R.V1 - R.V0)) * (H - PAD.t - PAD.b);
  const invX = (x: number) => R.T0 + ((x - PAD.l) / (W - PAD.l - PAD.r)) * (R.T1 - R.T0);
  const invY = (y: number) => R.V0 + (1 - (y - PAD.t) / (H - PAD.t - PAD.b)) * (R.V1 - R.V0);

  // ---- curve path
  let d = '';
  for (let x = PAD.l; x <= W - PAD.r; x += 2) {
    const y = Y(valueAt(val, invX(x)));
    d += `${d ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
  }
  // highlight the segment(s) leading into selected keyframes
  const hl: string[] = [];
  keys.forEach((k, i) => {
    if (i === 0 || !has(graphKeys, k.t)) return;
    let p = '';
    for (let x = X(keys[i - 1].t); x <= X(k.t); x += 2) p += `${p ? 'L' : 'M'}${x.toFixed(1)},${Y(valueAt(val, invX(x))).toFixed(1)}`;
    hl.push(p);
  });

  const vStep = niceStep(R.V1 - R.V0, H / 50);
  const tStep = niceStep(R.T1 - R.T0, W / 90);
  const vTicks: number[] = [];
  for (let v = Math.ceil(R.V0 / vStep) * vStep; v <= R.V1; v += vStep) vTicks.push(v);
  const tTicks: number[] = [];
  for (let t = Math.ceil(R.T0 / tStep) * tStep; t <= R.T1; t += tStep) tTicks.push(t);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = wrapRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const snapT = (t: number) => Math.round(t * fps) / fps;
  const clampV = (v: number) => Math.min(prop.max ?? Infinity, Math.max(prop.min ?? -Infinity, v));

  // ---- interactions
  const onKeyDown = (e: React.PointerEvent, k: Keyframe) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const s = editor.get();
    let sel = s.graphKeys;
    if (e.shiftKey || e.ctrlKey || e.metaKey) sel = has(sel, k.t) ? sel.filter((t) => Math.abs(t - k.t) >= KEY_EPS) : [...sel, k.t];
    else if (!has(sel, k.t)) sel = [k.t];
    editor.set({ graphKeys: sel });
    if (!has(sel, k.t)) return;

    const before = s.project;
    const orig = new Map(keys.filter((x) => has(sel, x.t)).map((x) => [x.t, x.v]));
    frozen.current = R;
    const pxT = (W - PAD.l - PAD.r) / (R.T1 - R.T0);
    const pxV = (H - PAD.t - PAD.b) / (R.V1 - R.V0);
    let moved = false;
    const move = (ev: PointerEvent) => {
      let dxp = ev.clientX - e.clientX;
      let dyp = ev.clientY - e.clientY;
      if (!moved && Math.hypot(dxp, dyp) < 3) return;
      moved = true;
      if (ev.shiftKey) Math.abs(dxp) > Math.abs(dyp) ? (dyp = 0) : (dxp = 0);
      let dt = dxp / pxT;
      dt = (ev.ctrlKey ? k.t + dt : snapT(k.t + dt)) - k.t;
      const dv = -dyp / pxV;
      const newSel = [...orig.keys()].map((t) => t + dt);
      setLive(
        produce(before, (dd) => {
          const o = findObject(dd as Project, obj.id)!.obj;
          const a = getPath(o, prop.path) as AnimValue;
          const movedKeys = new Set<Keyframe>();
          for (const kk of a.keyframes) {
            const ov = [...orig.entries()].find(([t]) => Math.abs(t - kk.t) < KEY_EPS);
            if (ov) {
              kk.t = ov[0] + dt;
              kk.v = clampV(ov[1] + dv);
              movedKeys.add(kk);
            }
          }
          // keep times unique: drop unselected keys that the moved ones landed on
          a.keyframes = a.keyframes.filter((kk) => movedKeys.has(kk) || !has(newSel, kk.t));
          a.keyframes.sort((x, y) => x.t - y.t);
        }),
      );
      editor.set({ graphKeys: newSel });
      const p = local(ev);
      setHover({ x: p.x, y: p.y, text: `${(obj.start + k.t + dt).toFixed(2)}s  ·  ${fmtVal(clampV(k.v + dv), prop)}` });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      frozen.current = null;
      setHover(null);
      if (moved) endLive(before);
      else setPlayhead(obj.start + k.t);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onBgDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    editor.set({ graphKeys: [] });
    const scrub = (ev: { clientX: number; clientY: number }) => setPlayhead(obj.start + Math.max(0, Math.min(obj.duration, invX(local(ev).x))));
    scrub(e);
    const up = () => {
      window.removeEventListener('pointermove', scrub);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', scrub);
    window.addEventListener('pointerup', up);
  };

  const onDouble = (e: React.MouseEvent) => {
    const p = local(e);
    const t = snapT(invX(p.x));
    const v = clampV(invY(p.y));
    commit((dd) => {
      const o = findObject(dd as Project, obj.id)!.obj;
      const cur = getPath(o, prop.path);
      if (isAnimated(cur)) upsertKeyframe(cur, t, v);
      else setPath(o, prop.path, { keyframes: [{ t, v, ease: { type: 'easeInOut' } }] });
    });
    editor.set({ graphKeys: [t] });
  };

  const keyMenu = (e: React.MouseEvent, k: Keyframe) => {
    const sel = has(editor.get().graphKeys, k.t) ? editor.get().graphKeys : [k.t];
    editor.set({ graphKeys: sel });
    const items: MenuEntry[] = EASE_CHOICES.map((c) => ({ label: `Ease in: ${c.label}`, onClick: () => setKeysEase(sel, c.type) }));
    openContextMenu(e, [...items, { sep: true }, { label: 'Go to keyframe', onClick: () => setPlayhead(obj.start + k.t) }, { label: 'Delete keyframe', kbd: 'Del', onClick: deleteGraphKeys }]);
  };

  const ph = playhead - obj.start;
  return (
    <div className="graph-main" ref={wrapRef} onDoubleClick={onDouble}>
      <svg width={W} height={H} onPointerDown={onBgDown}>
        <rect x={X(R.T0)} y={PAD.t} width={Math.max(0, X(0) - X(R.T0))} height={H - PAD.t - PAD.b} className="g-out" />
        <rect x={X(obj.duration)} y={PAD.t} width={Math.max(0, X(R.T1) - X(obj.duration))} height={H - PAD.t - PAD.b} className="g-out" />
        {vTicks.map((v) => (
          <g key={`v${v}`}>
            <line x1={PAD.l} x2={W - PAD.r} y1={Y(v)} y2={Y(v)} className="g-grid" />
            <text x={PAD.l - 8} y={Y(v) + 4} className="g-label" textAnchor="end">
              {Math.abs(vStep) < 0.1 ? v.toFixed(2) : Math.abs(vStep) < 1 ? v.toFixed(1) : Math.round(v)}
            </text>
          </g>
        ))}
        {tTicks.map((t) => (
          <g key={`t${t}`}>
            <line x1={X(t)} x2={X(t)} y1={PAD.t} y2={H - PAD.b} className="g-grid" />
            <text x={X(t) + 3} y={PAD.t - 8} className="g-label">
              {(obj.start + t).toFixed(tStep < 0.1 ? 2 : 1)}s
            </text>
          </g>
        ))}
        <path d={d} className={`g-curve ${anim ? '' : 'static'} ${anim?.recorded ? 'recorded' : ''}`} />
        {hl.map((p, i) => (
          <path key={i} d={p} className="g-curve hl" />
        ))}
        <line x1={X(ph)} x2={X(ph)} y1={PAD.t - 4} y2={H - PAD.b} className="g-playhead" />
        {keys.map((k, i) => (
          <g key={`${k.t}-${i}`} transform={`translate(${X(k.t)},${Y(k.v)})`} className={`g-key ${has(graphKeys, k.t) ? 'sel' : ''}`} onPointerDown={(e) => onKeyDown(e, k)} onContextMenu={(e) => keyMenu(e, k)}>
            <circle r="11" className="g-key-hit" />
            <path d="M0 -6.5 6.5 0 0 6.5 -6.5 0Z" />
          </g>
        ))}
      </svg>
      <div className="g-title">
        <b>{prop.label}</b>
        {anim ? (
          <span>
            {keys.length} keyframe{keys.length === 1 ? '' : 's'}
            {anim.recorded ? ' · recorded' : ''} — drag ◆ to move (Shift = one axis, Ctrl = no snap), double-click to add, Del to remove
          </span>
        ) : (
          <span>not animated — double-click the graph or click ◆ to add a keyframe</span>
        )}
      </div>
      {hover && (
        <div className="g-tip" style={{ left: hover.x + 12, top: hover.y - 26 }}>
          {hover.text}
        </div>
      )}
    </div>
  );
}
