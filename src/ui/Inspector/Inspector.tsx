import { useMemo } from 'react';
import {
  EFFECT_INFO,
  EFFECT_TYPES,
  defaultsFor,
  hasSourceTime,
  type Animatable,
  type AnimValue,
  type EffectType,
  type Project,
  type TimelineObject,
  type VisualObject,
} from '../../format/schema';
import { commit, editor, setPlayhead, useEditor } from '../../state/store';
import { clearAnimation, getPath, isAnimated, keyIndexAt, setPath, setValueAt, toggleKeyframe, valueAt } from '../../format/values';
import { openContextMenu } from '../ContextMenu';
import { animatableProps } from '../../format/values';
import { toggleRecording } from '../../engine/recorder';
import { pathEnd } from '../../format/recording';
import { MOTION_CHANNELS } from '../../format/schema';
import { findObject, frameDur, maxEnd, slip, sourceDuration } from '../../state/commands';
import { removeLibraryItem, ungroupSelected } from '../../state/actions';
import { countDeep } from '../../format/groups';
import { thumbUrl } from '../../state/sync';
import { Icon } from '../icons';
import { durLabel, timecode } from '../time';
import { ColorField, Field, KeyButton, NumField, PairField, SegField, SelectField, Section, TextField, Toggle, ToggleField, type Change, type KeyState } from './fields';

/**
 * Helpers for animatable properties of the selected object(s) at the playhead:
 *   A.v(path)   current value (interpolated if keyframed)
 *   A.on(path)  setter: sets the static value, or a keyframe at the playhead if animated
 *   A.kf(paths) the keyframe diamond for those properties
 */
function animHelpers(o: TimelineObject, ids: string[], playhead: number) {
  const localT = playhead - o.start;
  const v = (path: string) => valueAt(getPath(o, path) as Animatable, localT);
  const forEach = (fn: (obj: TimelineObject, localT: number) => void) => (d: Project) => {
    for (const id of ids) {
      const f = findObject(d, id);
      if (f && f.obj.type === o.type) fn(f.obj, playhead - f.obj.start);
    }
  };
  const on = (path: string, clampMin?: number) => (val: number, c?: Change) =>
    commit((d) => forEach((obj, t) => setValueAt(obj, path, clampMin !== undefined ? Math.max(clampMin, val) : val, t))(d as Project), {
      coalesce: `${ids.join(',')}:${path}`,
    });
  const toggle = (paths: string[]) => commit((d) => forEach((obj, t) => paths.forEach((p) => toggleKeyframe(obj, p, t)))(d as Project));
  const kf = (...paths: string[]) => {
    const cur = getPath(o, paths[0]);
    const animated = isAnimated(cur);
    const state: KeyState = !animated ? 'none' : keyIndexAt(cur, localT) >= 0 ? 'onKey' : 'animated';
    const times = paths.flatMap((p) => {
      const a = getPath(o, p);
      return isAnimated(a) ? a.keyframes.map((k) => k.t) : [];
    });
    const jump = (dir: 1 | -1) => {
      const later = times.filter((t) => t > localT + 1e-4).sort((a, b) => a - b);
      const earlier = times.filter((t) => t < localT - 1e-4).sort((a, b) => b - a);
      const target = dir > 0 ? later[0] : earlier[0];
      if (target !== undefined) setPlayhead(o.start + target);
    };
    return (
      <KeyButton
        state={state}
        recorded={animated && !!(cur as AnimValue).recorded}
        onClick={() => toggle(paths)}
        onContextMenu={(e) =>
          openContextMenu(e, [
            { label: state === 'onKey' ? 'Remove keyframe here' : 'Add keyframe here', onClick: () => toggle(paths) },
            { label: 'Previous keyframe', disabled: !animated, onClick: () => jump(-1) },
            { label: 'Next keyframe', disabled: !animated, onClick: () => jump(1) },
            { sep: true },
            { label: 'Open in Graph Editor', disabled: !animated, onClick: () => editor.set({ bottomTab: 'graph', graphPath: paths[0], graphKeys: [] }) },
            {
              label: 'Remove animation (keep current value)',
              disabled: !animated,
              onClick: () => commit((d) => forEach((obj, t) => paths.forEach((p) => clearAnimation(obj, p, t)))(d as Project)),
            },
          ])
        }
      />
    );
  };
  return { v, on, kf, localT };
}

const FONTS = [
  'Inter, Segoe UI, Arial, sans-serif',
  'Arial, sans-serif',
  'Impact, sans-serif',
  'Georgia, serif',
  'Times New Roman, serif',
  'Courier New, monospace',
  'Comic Sans MS, cursive',
  'Trebuchet MS, sans-serif',
  'Verdana, sans-serif',
];

const TYPE_ICON = { video: 'video', image: 'image', audio: 'audio', text: 'text', shape: 'shape', adjustment: 'adjust', group: 'group' } as const;

export function Inspector() {
  const selection = useEditor((s) => s.selection);
  const project = useEditor((s) => s.project);
  const selectedLibrary = useEditor((s) => s.selectedLibrary);

  const objs = useMemo(() => selection.map((id) => findObject(project, id)?.obj).filter((o): o is TimelineObject => !!o), [selection, project]);

  let body;
  if (objs.length) body = <ObjectInspector objs={objs} project={project} />;
  else if (selectedLibrary) body = <LibraryInspector id={selectedLibrary} project={project} />;
  else body = <ProjectInspector project={project} />;

  return (
    <div className="panel">
      <div className="panel-head">
        <Icon name="adjust" size={13} /> Inspector
      </div>
      <div className="panel-body">{body}</div>
    </div>
  );
}

function ObjectInspector({ objs, project }: { objs: TimelineObject[]; project: Project }) {
  const o = objs[0];
  const same = objs.filter((x) => x.type === o.type);
  const ids = same.map((x) => x.id);
  const defs = useMemo(() => defaultsFor(o.type) as any, [o.type]);
  const fps = project.project.fps;
  const playhead = useEditor((s) => (s.playing ? Math.round(s.playhead * 8) / 8 : s.playhead)); // throttled while playing
  const A = animHelpers(o, ids, playhead);

  /** Set a property on every selected object of this type. Live (drag) edits merge into one undo step. */
  const set = (path: string, value: unknown, c?: Change) =>
    commit(
      (d) => {
        for (const id of ids) {
          const f = findObject(d as Project, id);
          if (f && f.obj.type === o.type) setPath(f.obj, path, value);
        }
      },
      { coalesce: `${ids.join(',')}:${path}` },
    );
  const on = (path: string) => (v: any, c?: Change) => set(path, v, c);

  const label = o.type === 'text' ? o.text.split('\n')[0] : 'source' in o ? o.source : o.type === 'shape' ? `${o.shape}` : o.type === 'group' ? `Group of ${countDeep(o)}` : 'Adjustment';

  return (
    <>
      <div className="insp-title">
        <Icon name={TYPE_ICON[o.type]} size={15} />
        <span className="type-chip">{o.type}</span>
        <span className="name">{label}</span>
        <span className="id" title="Object id in the .banana file">{o.id}</span>
      </div>
      {objs.length > 1 && (
        <div className="multi-banner">
          {objs.length} objects selected{same.length < objs.length ? ` — editing the ${same.length} ${o.type} object(s)` : ' — edits apply to all'}
        </div>
      )}

      <AnimationSection o={o} />

      <TimingSection o={o} ids={ids} project={project} fps={fps} />

      {o.type !== 'audio' && o.type !== 'adjustment' && <TransformSection o={o} set={on} A={A} />}

      {(o.type === 'video' || o.type === 'image') && (
        <Section title="Image" defaultOpen>
          <SelectField
            label="Fit"
            value={o.fit}
            def={defs.fit}
            onChange={on('fit')}
            options={[
              { value: 'contain', label: 'Fit (contain)' },
              { value: 'cover', label: 'Fill (cover)' },
              { value: 'stretch', label: 'Stretch' },
              { value: 'none', label: 'Original size' },
            ]}
          />
        </Section>
      )}

      {(o.type === 'video' || o.type === 'image') && (
        <Section title="Cropping" defaultOpen={false}>
          <PairField label="Left / Right" la="L" lb="R" a={A.v('crop.left')} b={A.v('crop.right')} onA={A.on('crop.left', 0)} onB={A.on('crop.right', 0)} def={[0, 0]} kf={A.kf('crop.left', 'crop.right')} />
          <PairField label="Top / Bottom" la="T" lb="B" a={A.v('crop.top')} b={A.v('crop.bottom')} onA={A.on('crop.top', 0)} onB={A.on('crop.bottom', 0)} def={[0, 0]} kf={A.kf('crop.top', 'crop.bottom')} />
          <div className="hint">Crop amounts are in source pixels.</div>
        </Section>
      )}

      {(o.type === 'video' || o.type === 'audio') && (
        <Section title="Audio">
          <NumField label="Volume" value={A.v('volume')} def={1} min={0} max={2} step={0.01} slider={[0, 2]} onChange={A.on('volume', 0)} precision={2} kf={A.kf('volume')} />
          {o.type === 'video' && <ToggleField label="Mute" value={o.muted} def={false} onChange={on('muted')} />}
          {o.type === 'video' && project.library.find((l) => l.id === o.source)?.hasAudio === false && <div className="hint">This video file has no sound track.</div>}
        </Section>
      )}

      {o.type === 'text' && (
        <Section title="Text">
          <TextField label="Text" value={o.text} onChange={on('text')} multiline />
          <Field label="Font">
            <select className="input" value={FONTS.includes(o.font) ? o.font : '__custom'} onChange={(e) => e.target.value !== '__custom' && set('font', e.target.value)}>
              {FONTS.map((f) => (
                <option key={f} value={f} style={{ fontFamily: f }}>
                  {f.split(',')[0]}
                </option>
              ))}
              {!FONTS.includes(o.font) && <option value="__custom">{o.font}</option>}
            </select>
          </Field>
          <NumField label="Size" value={A.v('size')} def={defs.size} min={1} max={2000} step={1} slider={[8, 400]} onChange={A.on('size', 1)} unit="px" precision={1} kf={A.kf('size')} />
          <ColorField label="Color" value={o.color} def={defs.color} onChange={on('color')} />
          <Field label="Style">
            <div className="seg" style={{ flex: 1 }}>
              <button className={o.bold ? 'on' : ''} onClick={() => set('bold', !o.bold)} style={{ fontWeight: 700 }}>
                B
              </button>
              <button className={o.italic ? 'on' : ''} onClick={() => set('italic', !o.italic)} style={{ fontStyle: 'italic' }}>
                I
              </button>
            </div>
            <div className="seg" style={{ flex: 1.6 }}>
              {(['left', 'center', 'right'] as const).map((a) => (
                <button key={a} className={o.align === a ? 'on' : ''} onClick={() => set('align', a)}>
                  {a[0].toUpperCase() + a.slice(1)}
                </button>
              ))}
            </div>
          </Field>
          <NumField label="Line height" value={o.lineHeight} def={defs.lineHeight} min={0.5} max={4} step={0.05} onChange={on('lineHeight')} unit="×" precision={2} />
          <NumField label="Letter spacing" value={A.v('letterSpacing')} def={0} min={-50} max={200} step={0.5} onChange={A.on('letterSpacing')} unit="px" precision={1} kf={A.kf('letterSpacing')} />
        </Section>
      )}
      {o.type === 'text' && (
        <Section title="Text Style" defaultOpen={false}>
          <ColorField label="Outline" value={o.outline.color} def={defs.outline.color} onChange={on('outline.color')} />
          <NumField label="Outline width" value={o.outline.width} def={0} min={0} max={60} step={0.5} slider={[0, 30]} onChange={on('outline.width')} unit="px" precision={1} />
          <ColorField label="Background" value={o.background.color} def={defs.background.color} onChange={on('background.color')} />
          <NumField label="Padding" value={o.background.padding} def={defs.background.padding} min={0} max={400} onChange={on('background.padding')} unit="px" precision={0} />
          <NumField label="Corner radius" value={o.background.radius} def={defs.background.radius} min={0} max={400} onChange={on('background.radius')} unit="px" precision={0} />
          <ColorField label="Shadow" value={o.shadow.color} def={defs.shadow.color} onChange={on('shadow.color')} />
          <NumField label="Shadow blur" value={o.shadow.blur} def={0} min={0} max={200} onChange={on('shadow.blur')} unit="px" precision={0} />
          <PairField label="Shadow offset" la="X" lb="Y" a={o.shadow.x} b={o.shadow.y} onA={on('shadow.x')} onB={on('shadow.y')} def={[0, 0]} />
        </Section>
      )}

      {o.type === 'shape' && (
        <Section title="Shape">
          <SegField
            label="Shape"
            value={o.shape}
            def={defs.shape}
            onChange={on('shape')}
            options={[
              { value: 'rect', label: 'Rectangle' },
              { value: 'ellipse', label: 'Ellipse' },
              { value: 'solid', label: 'Solid' },
            ]}
          />
          {o.shape !== 'solid' && (
            <PairField label="Size" la="W" lb="H" a={A.v('width')} b={A.v('height')} onA={A.on('width', 1)} onB={A.on('height', 1)} kf={A.kf('width', 'height')} />
          )}
          <ColorField label="Fill" value={o.fill} def={defs.fill} onChange={on('fill')} />
          {o.shape !== 'solid' && (
            <>
              <ColorField label="Stroke" value={o.stroke} def={defs.stroke} onChange={on('stroke')} />
              <NumField label="Stroke width" value={o.strokeWidth} def={0} min={0} max={200} slider={[0, 40]} onChange={on('strokeWidth')} unit="px" precision={1} />
            </>
          )}
          {o.shape === 'rect' && <NumField label="Corner radius" value={o.cornerRadius} def={0} min={0} max={2000} slider={[0, 200]} onChange={on('cornerRadius')} unit="px" precision={0} />}
        </Section>
      )}

      {o.type === 'group' && (
        <Section title="Group" defaultOpen>
          <NumField label="Sound volume" value={o.volume} def={1} min={0} max={2} step={0.01} slider={[0, 2]} onChange={on('volume')} precision={2} />
          <div className="hint">
            {countDeep(o)} objects inside. Moving, trimming or animating the group moves all of them; this volume scales every sound inside.
          </div>
          <button className="btn" onClick={ungroupSelected} title="Put the objects back on the timeline (Ctrl+Shift+G)">
            Ungroup
          </button>
        </Section>
      )}

      {o.type === 'adjustment' && (
        <Section title="Adjustment Layer">
          <NumField label="Mix" value={A.v('opacity')} def={1} min={0} max={1} step={0.01} slider={[0, 1]} onChange={A.on('opacity', 0)} precision={2} kf={A.kf('opacity')} />
          <div className="hint">Effects below are applied to every layer underneath this one while it is active.</div>
        </Section>
      )}

      <Section title="Fades">
        <NumField label="Fade in" value={o.fadeIn} def={0} min={0} max={o.duration} step={1 / fps} onChange={on('fadeIn')} unit="s" precision={3} />
        <NumField label="Fade out" value={o.fadeOut} def={0} min={0} max={o.duration} step={1 / fps} onChange={on('fadeOut')} unit="s" precision={3} />
      </Section>

      {o.type !== 'audio' && <EffectsSection o={o} ids={ids} A={A} />}

      <Section title="Note" defaultOpen={false}>
        <TextField label="Note" value={o.note} onChange={on('note')} multiline placeholder="Saved in the file — handy for instructions to/from AI" />
      </Section>
    </>
  );
}

function AnimationSection({ o }: { o: TimelineObject }) {
  const playhead = useEditor((s) => (s.playing ? Math.round(s.playhead * 8) / 8 : s.playhead)); // throttled while playing
  const recording = useEditor((s) => s.recording);
  const props = animatableProps(o);
  const animated = props.filter((p) => isAnimated(getPath(o, p.path)));
  const visual = o.type !== 'audio' && o.type !== 'adjustment';
  const open = (path?: string) => editor.set({ bottomTab: 'graph', ...(path ? { graphPath: path, graphKeys: [] } : {}) });
  const paths = 'motion' in o ? (o.motion ?? []) : [];
  const removePath = (i: number) =>
    commit((d) => {
      const x = findObject(d as Project, o.id)?.obj;
      if (x && 'motion' in x && x.motion) {
        x.motion.splice(i, 1);
        if (!x.motion.length) delete x.motion;
      }
    });
  const count = animated.length + paths.length;
  return (
    <Section title={`Animation${count ? ` (${count})` : ''}`}>
      {paths.length > 0 && (
        <div className="anim-list" style={{ marginBottom: 4 }}>
          {paths.map((m, i) => (
            <div key={i} className="anim-row recorded" title="Recorded motion: the object follows this path exactly. Drag the object in the viewer to move the whole path.">
              <span className="rec-dot" style={{ width: 7, height: 7 }} />
              <span className="name">Recorded path</span>
              <span className="meta">
                {(o.start + m.start).toFixed(2)}–{(o.start + pathEnd(m)).toFixed(2)}s · {MOTION_CHANNELS.filter((c) => m[c]).join(' ')}
              </span>
              <button className="icon-btn sm" title="Delete this recorded path" onClick={() => removePath(i)}>
                <Icon name="trash" size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
      {animated.length ? (
        <div className="anim-list">
          {animated.map((p) => {
            const a = getPath(o, p.path) as AnimValue;
            return (
              <button key={p.path} className={`anim-row ${a.recorded ? 'recorded' : ''}`} onClick={() => open(p.path)} title="Open in the Animation tab">
                <span className="kf-glyph">◆</span>
                <span className="name">{p.label}</span>
                <span className="meta">
                  {a.keyframes.length} keys{a.recorded ? ' · recorded' : ''}
                </span>
              </button>
            );
          })}
        </div>
      ) : paths.length ? null : (
        <div className="hint">
          Not animated yet. Click a <span className="kf-glyph">◆</span> next to any property below to add a keyframe at the playhead ({(playhead - o.start).toFixed(2)}s into this clip){visual ? ', or record motion live.' : '.'}
        </div>
      )}
      <div className="row" style={{ gap: 6, marginTop: 4 }}>
        <button className="btn" onClick={() => open()}>
          <span className="kf-glyph">◆</span> Curves &amp; easing
        </button>
        {visual && (
          <button className={`rec-btn ${recording ? 'on' : ''}`} onClick={toggleRecording} title="Plays the video; drag this object in the viewer to record its motion (R)">
            <span className="rec-dot" /> {recording ? 'Stop recording' : 'Record motion'}
          </button>
        )}
      </div>
    </Section>
  );
}

function TimingSection({ o, ids, project, fps }: { o: TimelineObject; ids: string[]; project: Project; fps: number }) {
  const fd = frameDur(project);
  const edit = (fn: (x: TimelineObject, d: Project) => void, key: string) =>
    commit(
      (d) => {
        for (const id of ids) {
          const f = findObject(d as Project, id);
          if (f) fn(f.obj, d as Project);
        }
      },
      { coalesce: `${ids.join(',')}:${key}` },
    );
  const sd = sourceDuration(project, o);
  return (
    <Section title="Timing">
      <NumField label="Start" value={o.start} min={0} step={fd} onChange={(v) => edit((x) => (x.start = Math.max(0, v)), 'start')} unit="s" />
      <NumField
        label="Duration"
        value={o.duration}
        min={fd}
        step={fd}
        onChange={(v) => edit((x, d) => (x.duration = Math.max(fd, Math.min(v, maxEnd(d, x) - x.start))), 'duration')}
        unit="s"
      />
      <NumField label="End" value={o.start + o.duration} step={fd} onChange={(v) => edit((x, d) => (x.duration = Math.max(fd, Math.min(v, maxEnd(d, x)) - x.start)), 'duration')} unit="s" />
      {hasSourceTime(o) && (
        <>
          <NumField label="Source in" value={o.in} min={0} step={fd} onChange={(v) => edit((x, d) => slip(d, x, v), 'in')} unit="s" />
          <NumField
            label="Speed"
            value={o.speed}
            def={1}
            min={0.1}
            max={16}
            step={0.05}
            precision={2}
            unit="×"
            onChange={(v) =>
              edit((x, d) => {
                if (!hasSourceTime(x)) return;
                const span = x.duration * x.speed;
                x.speed = v;
                x.duration = Math.max(fd, span / v);
                x.duration = Math.min(x.duration, maxEnd(d, x) - x.start);
              }, 'speed')
            }
          />
          {sd !== undefined && <div className="hint">Source length {sd.toFixed(2)}s · showing {o.in.toFixed(2)}s – {(o.in + o.duration * o.speed).toFixed(2)}s</div>}
        </>
      )}
      <Field label="Enabled">
        <Toggle value={o.enabled} onChange={(v) => edit((x) => (x.enabled = v), 'enabled')} />
        <span className="hint" style={{ marginLeft: 'auto', fontFamily: 'var(--mono)' }}>
          {timecode(o.start, fps)}
        </span>
      </Field>
    </Section>
  );
}

function TransformSection({ o, set, A }: { o: VisualObject; set: (path: string) => (v: any, c?: Change) => void; A: ReturnType<typeof animHelpers> }) {
  const t = o.transform;
  return (
    <Section title="Transform">
      <NumField label="Zoom" value={A.v('transform.scale')} def={1} min={0.01} max={20} step={0.01} slider={[0.05, 4]} onChange={A.on('transform.scale', 0.001)} precision={3} kf={A.kf('transform.scale')} />
      <PairField label="Position" la="X" lb="Y" a={A.v('transform.x')} b={A.v('transform.y')} onA={A.on('transform.x')} onB={A.on('transform.y')} def={[0, 0]} kf={A.kf('transform.x', 'transform.y')} />
      <NumField label="Rotation" value={A.v('transform.rotation')} def={0} step={0.5} slider={[-180, 180]} onChange={A.on('transform.rotation')} unit="°" precision={2} kf={A.kf('transform.rotation')} />
      <NumField label="Opacity" value={A.v('transform.opacity')} def={1} min={0} max={1} step={0.01} slider={[0, 1]} onChange={A.on('transform.opacity', 0)} precision={2} kf={A.kf('transform.opacity')} />
      <Field label="Flip">
        <div className="seg" style={{ flex: 1 }}>
          <button className={t.flipX ? 'on' : ''} onClick={() => set('transform.flipX')(!t.flipX)}>
            Horizontal
          </button>
          <button className={t.flipY ? 'on' : ''} onClick={() => set('transform.flipY')(!t.flipY)}>
            Vertical
          </button>
        </div>
      </Field>
    </Section>
  );
}

function EffectsSection({ o, ids, A }: { o: Exclude<TimelineObject, { type: 'audio' }>; ids: string[]; A: ReturnType<typeof animHelpers> }) {
  const edit = (fn: (effects: any[]) => void, key: string) =>
    commit(
      (d) => {
        for (const id of ids) {
          const f = findObject(d as Project, id);
          if (f && 'effects' in f.obj) fn(f.obj.effects);
        }
      },
      { coalesce: `${ids.join(',')}:fx:${key}` },
    );
  return (
    <Section
      title={`Effects${o.effects.length ? ` (${o.effects.length})` : ''}`}
      right={
        <select
          className="input"
          style={{ width: 118, height: 22 }}
          value=""
          onChange={(e) => {
            const type = e.target.value as EffectType;
            if (type) edit((fx) => fx.push({ type, amount: EFFECT_INFO[type].amount, enabled: true }), 'add' + Math.random());
          }}
        >
          <option value="">+ Add effect</option>
          {EFFECT_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      }
    >
      {!o.effects.length && <div className="hint">No effects. Use “+ Add effect” to add brightness, blur, hue and more.</div>}
      {o.effects.map((e, i) => {
        const info = EFFECT_INFO[e.type];
        return (
          <div className="effect-card" key={i}>
            <div className="head">
              <Toggle value={e.enabled} onChange={(v) => edit((fx) => (fx[i].enabled = v), `en${i}`)} title="Enable / disable" />
              {e.type}
              <span className="spacer" />
              <button className="icon-btn sm" title="Move up" disabled={i === 0} onClick={() => edit((fx) => fx.splice(i - 1, 0, fx.splice(i, 1)[0]), `mv${Math.random()}`)}>
                <Icon name="chevron" size={11} style={{ transform: 'rotate(180deg)' }} />
              </button>
              <button className="icon-btn sm" title="Remove effect" onClick={() => edit((fx) => fx.splice(i, 1), `rm${Math.random()}`)}>
                <Icon name="trash" size={12} />
              </button>
            </div>
            <NumField
              label="Amount"
              value={A.v(`effects.${i}.amount`)}
              kf={A.kf(`effects.${i}.amount`)}
              def={info.amount}
              min={info.min}
              max={info.max}
              step={info.step}
              slider={[info.min, info.max]}
              unit={info.unit}
              precision={2}
              onChange={A.on(`effects.${i}.amount`)}
            />
          </div>
        );
      })}
    </Section>
  );
}

function LibraryInspector({ id, project }: { id: string; project: Project }) {
  const item = project.library.find((l) => l.id === id);
  if (!item) return null;
  const uses = project.tracks.flatMap((t) => t.objects).filter((o) => 'source' in o && o.source === id).length;
  return (
    <>
      <div className="insp-title">
        <Icon name={item.kind === 'image' ? 'image' : item.kind === 'video' ? 'video' : 'audio'} size={15} />
        <span className="type-chip">{item.kind}</span>
        <span className="name">{item.id}</span>
      </div>
      {item.kind !== 'audio' && (
        <div style={{ padding: 12 }}>
          <img src={thumbUrl(item)} style={{ width: '100%', borderRadius: 4, background: '#000', maxHeight: 200, objectFit: 'contain' }} />
        </div>
      )}
      <Section title="Media">
        <Field label="Library id">
          <span className="code">{item.id}</span>
        </Field>
        <Field label="File">
          <span className="code" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {item.file}
          </span>
        </Field>
        {item.width && (
          <Field label="Resolution">
            {item.width} × {item.height}
          </Field>
        )}
        {item.duration !== undefined && <Field label="Duration">{durLabel(item.duration)} ({item.duration}s)</Field>}
        {item.kind === 'video' && <Field label="Has audio">{item.hasAudio ? 'yes' : 'no'}</Field>}
        {item.asset && (
          <Field label="From asset">
            <span className="code">{item.asset}</span>
          </Field>
        )}
        <Field label="Used">{uses} time(s) on the timeline</Field>
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 6 }}>
          <button className="btn" onClick={() => removeLibraryItem(item.id)}>
            <Icon name="trash" size={13} /> Remove from library
          </button>
        </div>
      </Section>
      <div className="hint" style={{ padding: 12 }}>
        Drag onto the timeline, or double-click to add at the playhead. In the .banana file, objects reference this item with <code>source: {item.id}</code>.
      </div>
    </>
  );
}

function ProjectInspector({ project }: { project: Project }) {
  const p = project.project;
  const set = (key: keyof typeof p) => (v: any) => commit((d) => void ((d.project as any)[key] = v), { coalesce: `project:${key}` });
  const file = useEditor((s) => s.projectFile);
  const objects = project.tracks.reduce((n, t) => n + t.objects.length, 0);
  return (
    <>
      <div className="insp-title">
        <Icon name="file" size={15} />
        <span className="type-chip">project</span>
        <span className="name">{p.name}</span>
      </div>
      <Section title="Project Settings">
        <TextField label="Name" value={p.name} onChange={set('name')} />
        <PairField label="Resolution" la="W" lb="H" a={p.width} b={p.height} onA={(v) => set('width')(Math.max(16, Math.round(v)))} onB={(v) => set('height')(Math.max(16, Math.round(v)))} />
        <Field label="Presets">
          <select
            className="input"
            value=""
            onChange={(e) => {
              const [w, h] = e.target.value.split('x').map(Number);
              if (w) commit((d) => void ((d.project.width = w), (d.project.height = h)));
            }}
          >
            <option value="">Choose…</option>
            <option value="1920x1080">1080p landscape (1920×1080)</option>
            <option value="1280x720">720p landscape (1280×720)</option>
            <option value="3840x2160">4K UHD (3840×2160)</option>
            <option value="1080x1920">Vertical / Shorts (1080×1920)</option>
            <option value="1080x1080">Square (1080×1080)</option>
            <option value="1080x1350">Portrait 4:5 (1080×1350)</option>
          </select>
        </Field>
        <SelectField
          label="Frame rate"
          value={String(p.fps)}
          onChange={(v) => set('fps')(Number(v))}
          options={['23.976', '24', '25', '30', '50', '60'].map((v) => ({ value: v, label: `${v} fps` }))}
        />
        <ColorField label="Background" value={p.background} def="#000000" onChange={set('background')} />
      </Section>
      <Section title="Project File">
        <Field label="File">
          <span className="code" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }} title={file}>
            {file}
          </span>
        </Field>
        <Field label="Contents">
          {project.tracks.length} tracks · {objects} objects · {project.library.length} media
        </Field>
        <div className="hint">
          This is a plain YAML file. Edit it in any editor, or let an AI edit it — BananaVinci reloads it live. See <code>docs/BANANA_FORMAT.md</code>.
        </div>
      </Section>
      <div className="empty">
        <div className="big">Nothing selected</div>
        Click an object on the timeline or in the viewer to edit its properties.
      </div>
    </>
  );
}
