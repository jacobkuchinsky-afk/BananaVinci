import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../icons';

export interface Change {
  /** true while dragging/scrubbing: callers merge these into one undo step */
  live?: boolean;
}

function fmt(v: number, precision: number) {
  if (!Number.isFinite(v)) return '';
  const r = Number(v.toFixed(precision));
  return String(r);
}

export function NumberInput({
  value,
  onChange,
  step = 1,
  min,
  max,
  precision = 3,
  unit,
  mixed,
}: {
  value: number;
  onChange: (v: number, c?: Change) => void;
  step?: number;
  min?: number;
  max?: number;
  precision?: number;
  unit?: string;
  mixed?: boolean;
}) {
  const [text, setText] = useState(fmt(value, precision));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(mixed ? '' : fmt(value, precision));
  }, [value, focused, precision, mixed]);
  const clampV = (v: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
  const commitText = () => {
    // allow simple math like "2+0.5" or "1920/2"
    let v = Number(text);
    if (!Number.isFinite(v) && /^[\d+\-*/. ()]+$/.test(text)) {
      try {
        v = Function(`"use strict";return (${text})`)();
      } catch {
        v = NaN;
      }
    }
    if (Number.isFinite(v)) onChange(clampV(v));
    else setText(fmt(value, precision));
  };
  return (
    <div className="num">
      <input
        className="input mono"
        value={text}
        placeholder={mixed ? 'mixed' : ''}
        onFocus={(e) => {
          setFocused(true);
          e.target.select();
        }}
        onBlur={() => {
          setFocused(false);
          commitText();
        }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setText(fmt(value, precision));
            setTimeout(() => (e.target as HTMLInputElement).blur());
          }
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const k = (e.shiftKey ? 10 : e.altKey ? 0.1 : 1) * step * (e.key === 'ArrowUp' ? 1 : -1);
            const v = clampV(value + k);
            onChange(v, { live: true });
            setText(fmt(v, precision));
          }
        }}
      />
      {unit && <span className="unit">{unit}</span>}
    </div>
  );
}

/** A label you can drag left/right to scrub a number (Shift = ×10, Alt = ×0.1). */
export function ScrubLabel({ children, value, onChange, step = 1, min, max }: { children: ReactNode; value: number; onChange: (v: number, c?: Change) => void; step?: number; min?: number; max?: number }) {
  const ref = useRef<{ x: number; v: number } | null>(null);
  return (
    <label
      className="scrub"
      title="Drag to adjust (Shift ×10, Alt ×0.1)"
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        ref.current = { x: e.clientX, v: value };
        document.body.style.cursor = 'ew-resize';
      }}
      onPointerMove={(e) => {
        if (!ref.current) return;
        const k = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
        const v = ref.current.v + Math.round((e.clientX - ref.current.x) / 2) * step * k;
        onChange(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v)), { live: true });
      }}
      onPointerUp={() => {
        ref.current = null;
        document.body.style.cursor = '';
      }}
    >
      {children}
    </label>
  );
}

export function ResetBtn({ changed, onReset }: { changed: boolean; onReset: () => void }) {
  return (
    <button className={`reset ${changed ? 'changed' : ''}`} title="Reset to default" onClick={onReset} disabled={!changed} tabIndex={-1}>
      {changed && <Icon name="reset" size={12} />}
    </button>
  );
}

export function Field({ label, children, reset, kf }: { label: ReactNode; children: ReactNode; reset?: ReactNode; kf?: ReactNode }) {
  return (
    <div className="field">
      {typeof label === 'string' ? <label>{label}</label> : label}
      <div className="row">{children}</div>
      {reset ?? <span />}
      {kf ?? <span />}
    </div>
  );
}

export type KeyState = 'none' | 'animated' | 'onKey';

/** The keyframe diamond: click = add/remove a keyframe at the playhead; right-click = more. */
export function KeyButton({ state, onClick, onContextMenu, recorded }: { state: KeyState; onClick: () => void; onContextMenu?: (e: React.MouseEvent) => void; recorded?: boolean }) {
  const title =
    state === 'none'
      ? 'Animate: add a keyframe at the playhead'
      : state === 'onKey'
        ? 'Keyframe at playhead — click to remove (right-click for more)'
        : 'Animated — click to add a keyframe at the playhead (right-click for more)';
  return (
    <button className={`kf-btn ${state} ${recorded ? 'recorded' : ''}`} title={title} onClick={onClick} onContextMenu={onContextMenu} tabIndex={-1}>
      <svg width="11" height="11" viewBox="0 0 10 10">
        <path d="M5 0.8 9.2 5 5 9.2 0.8 5Z" />
      </svg>
    </button>
  );
}

export function NumField({
  label,
  value,
  onChange,
  def,
  step = 1,
  min,
  max,
  unit,
  slider,
  precision,
  mixed,
  kf,
}: {
  kf?: ReactNode;
  label: string;
  value: number;
  onChange: (v: number, c?: Change) => void;
  def?: number;
  step?: number;
  min?: number;
  max?: number;
  unit?: string;
  slider?: [number, number];
  precision?: number;
  mixed?: boolean;
}) {
  return (
    <Field
      label={
        <ScrubLabel value={value} onChange={onChange} step={step} min={min} max={max}>
          {label}
        </ScrubLabel>
      }
      reset={def !== undefined ? <ResetBtn changed={Math.abs(value - def) > 1e-9} onReset={() => onChange(def)} /> : undefined}
      kf={kf}
    >
      {slider && (
        <input
          className="slider"
          type="range"
          min={slider[0]}
          max={slider[1]}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value), { live: true })}
          style={{ flex: 1.4 }}
        />
      )}
      <div style={{ flex: 1, minWidth: 60 }}>
        <NumberInput value={value} onChange={onChange} step={step} min={min} max={max} unit={unit} precision={precision} mixed={mixed} />
      </div>
    </Field>
  );
}

export function PairField({
  label,
  a,
  b,
  onA,
  onB,
  la,
  lb,
  step = 1,
  def,
  kf,
}: {
  kf?: ReactNode;
  label: string;
  a: number;
  b: number;
  onA: (v: number, c?: Change) => void;
  onB: (v: number, c?: Change) => void;
  la: string;
  lb: string;
  step?: number;
  def?: [number, number];
}) {
  return (
    <Field
      label={label}
      reset={
        def ? (
          <ResetBtn
            changed={a !== def[0] || b !== def[1]}
            onReset={() => {
              onA(def[0]);
              onB(def[1]);
            }}
          />
        ) : undefined
      }
      kf={kf}
    >
      <div className="pair" style={{ flex: 1 }}>
        <div className="row" style={{ gap: 4 }}>
          <ScrubLabel value={a} onChange={onA} step={step}>
            <span style={{ color: 'var(--dim)', fontSize: 10.5, cursor: 'ew-resize' }}>{la}</span>
          </ScrubLabel>
          <NumberInput value={a} onChange={onA} step={step} precision={2} />
        </div>
        <div className="row" style={{ gap: 4 }}>
          <ScrubLabel value={b} onChange={onB} step={step}>
            <span style={{ color: 'var(--dim)', fontSize: 10.5, cursor: 'ew-resize' }}>{lb}</span>
          </ScrubLabel>
          <NumberInput value={b} onChange={onB} step={step} precision={2} />
        </div>
      </div>
    </Field>
  );
}

export function TextField({ label, value, onChange, def, multiline, mono, placeholder }: { label: string; value: string; onChange: (v: string, c?: Change) => void; def?: string; multiline?: boolean; mono?: boolean; placeholder?: string }) {
  return (
    <Field label={label} reset={def !== undefined ? <ResetBtn changed={value !== def} onReset={() => onChange(def)} /> : undefined}>
      {multiline ? (
        <textarea className="input" rows={3} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value, { live: true })} />
      ) : (
        <input className={`input ${mono ? 'mono' : ''}`} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value, { live: true })} />
      )}
    </Field>
  );
}

function splitAlpha(hex: string): [string, string] {
  if (hex.length === 9) return [hex.slice(0, 7), hex.slice(7)];
  if (hex.length === 4) return ['#' + [...hex.slice(1)].map((c) => c + c).join(''), ''];
  if (hex.length === 5) return ['#' + [...hex.slice(1, 4)].map((c) => c + c).join(''), hex[4] + hex[4]];
  return [hex, ''];
}

export function ColorField({ label, value, onChange, def }: { label: string; value: string; onChange: (v: string, c?: Change) => void; def?: string }) {
  const [rgb, alpha] = splitAlpha(value);
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const alphaPct = alpha ? Math.round((parseInt(alpha, 16) / 255) * 100) : 100;
  return (
    <Field label={label} reset={def !== undefined ? <ResetBtn changed={value.toLowerCase() !== def.toLowerCase()} onReset={() => onChange(def)} /> : undefined}>
      <div className="swatch">
        <span style={{ background: value }} />
        <input type="color" value={rgb} onChange={(e) => onChange(e.target.value + alpha, { live: true })} />
      </div>
      <input
        className="input mono"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => (/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(text) ? onChange(text) : setText(value))}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      <div style={{ width: 62, flex: 'none' }} title="Opacity of this color">
        <NumberInput
          value={alphaPct}
          min={0}
          max={100}
          precision={0}
          unit="%"
          onChange={(v, c) => {
            const a = Math.round((v / 100) * 255);
            onChange(rgb + (a >= 255 ? '' : a.toString(16).padStart(2, '0')), c);
          }}
        />
      </div>
    </Field>
  );
}

export function ToggleField({ label, value, onChange, def }: { label: string; value: boolean; onChange: (v: boolean) => void; def?: boolean }) {
  return (
    <Field label={label} reset={def !== undefined ? <ResetBtn changed={value !== def} onReset={() => onChange(def)} /> : undefined}>
      <button className={`toggle ${value ? 'on' : ''}`} onClick={() => onChange(!value)} />
    </Field>
  );
}

export function Toggle({ value, onChange, title }: { value: boolean; onChange: (v: boolean) => void; title?: string }) {
  return <button title={title} className={`toggle ${value ? 'on' : ''}`} onClick={() => onChange(!value)} />;
}

export function SegField<T extends string>({ label, value, options, onChange, def }: { label: string; value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; def?: T }) {
  return (
    <Field label={label} reset={def !== undefined ? <ResetBtn changed={value !== def} onReset={() => onChange(def)} /> : undefined}>
      <div className="seg" style={{ flex: 1 }}>
        {options.map((o) => (
          <button key={o.value} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>
            {o.label}
          </button>
        ))}
      </div>
    </Field>
  );
}

export function SelectField<T extends string>({ label, value, options, onChange, def }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; def?: T }) {
  return (
    <Field label={label} reset={def !== undefined ? <ResetBtn changed={value !== def} onReset={() => onChange(def)} /> : undefined}>
      <select className="input" value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function Section({ title, children, defaultOpen = true, right }: { title: string; children: ReactNode; defaultOpen?: boolean; right?: ReactNode }) {
  const key = `bv.section.${title}`;
  const [open, setOpen] = useState(() => {
    try {
      const v = localStorage.getItem(key);
      return v === null ? defaultOpen : v === '1';
    } catch {
      return defaultOpen;
    }
  });
  return (
    <div className="section">
      <div
        className={`section-head ${open ? '' : 'closed'}`}
        onClick={() => {
          setOpen(!open);
          try {
            localStorage.setItem(key, open ? '0' : '1');
          } catch {}
        }}
      >
        <Icon name="chevron" size={12} className="chev" />
        <span className="bullet" />
        <span>{title}</span>
        <span className="spacer" />
        <span onClick={(e) => e.stopPropagation()}>{right}</span>
      </div>
      {open && <div className="section-body">{children}</div>}
    </div>
  );
}
