import { useEffect, useRef } from 'react';
import { produce } from 'immer';
import { MARKER_COLORS } from '../../format/schema';
import { commit, editor, endLive, setLive, setPlayhead, useEditor } from '../../state/store';
import { snapTime } from '../../state/snap';
import { openContextMenu } from '../ContextMenu';
import { shortTime } from '../time';
import { MARKER_CSS } from './Timeline';

export const RULER_H = 30;

const STEPS = [1 / 30, 1 / 10, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];

export function Ruler({ width, scrollLeft, viewWidth }: { width: number; scrollLeft: number; viewWidth: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const zoom = useEditor((s) => s.zoom);
  const fps = useEditor((s) => s.project.project.fps);
  const markers = useEditor((s) => s.project.markers);
  const inPoint = useEditor((s) => s.inPoint);
  const outPoint = useEditor((s) => s.outPoint);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = devicePixelRatio || 1;
    const w = viewWidth + 2;
    c.width = w * dpr;
    c.height = RULER_H * dpr;
    c.style.width = `${w}px`;
    c.style.height = `${RULER_H}px`;
    const ctx = c.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, RULER_H);
    const major = STEPS.find((s) => s * zoom >= 90) ?? 3600;
    const minor = [...STEPS].reverse().find((s) => s < major && s * zoom >= 9 && (major / s) % 1 < 1e-6) ?? major / 5;
    const t0 = scrollLeft / zoom;
    const t1 = (scrollLeft + w) / zoom;
    ctx.font = '10px "JetBrains Mono", Consolas, monospace';
    ctx.textBaseline = 'top';
    for (let t = Math.floor(t0 / minor) * minor; t <= t1; t += minor) {
      const x = Math.round(t * zoom - scrollLeft) + 0.5;
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      ctx.strokeStyle = isMajor ? '#5c5c64' : '#34343a';
      ctx.beginPath();
      ctx.moveTo(x, isMajor ? 14 : 22);
      ctx.lineTo(x, RULER_H);
      ctx.stroke();
      if (isMajor) {
        ctx.fillStyle = '#8a8a92';
        ctx.fillText(major < 1 ? `${shortTime(Math.floor(t))}:${String(Math.round((t % 1) * fps)).padStart(2, '0')}` : shortTime(t), x + 4, 4);
      }
    }
  }, [zoom, scrollLeft, viewWidth, fps]);

  const scrub = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.marker')) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const at = (x: number) => snapTime((x - rect.left) / editor.get().zoom).t;
    setPlayhead(at(e.clientX));
    const move = (ev: PointerEvent) => setPlayhead(at(ev.clientX));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const dragMarker = (e: React.PointerEvent, index: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const before = editor.get().project;
    const t0 = before.markers[index].time;
    let moved = false;
    const move = (ev: PointerEvent) => {
      moved = true;
      const t = snapTime(t0 + (ev.clientX - e.clientX) / editor.get().zoom).t;
      setLive(produce(before, (d) => void (d.markers[index].time = t)));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (moved) endLive(before);
      else setPlayhead(t0);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div className="ruler" style={{ width }} onPointerDown={scrub}>
      <canvas ref={ref} style={{ left: scrollLeft }} />
      {inPoint !== null || outPoint !== null ? (
        <div className="inout" style={{ left: (inPoint ?? 0) * zoom, width: Math.max(2, ((outPoint ?? inPoint! + 0) - (inPoint ?? 0)) * zoom) || 2 }} />
      ) : null}
      {markers.map((m, i) => (
        <div
          key={i}
          className="marker"
          style={{ left: m.time * zoom }}
          title={`${m.name} — ${m.time.toFixed(2)}s (double-click to rename, right-click for options)`}
          onPointerDown={(e) => dragMarker(e, i)}
          onDoubleClick={() => {
            const name = prompt('Marker name', m.name);
            if (name !== null) commit((d) => void (d.markers[i].name = name));
          }}
          onContextMenu={(e) =>
            openContextMenu(e, [
              {
                label: 'Rename…',
                onClick: () => {
                  const name = prompt('Marker name', m.name);
                  if (name !== null) commit((d) => void (d.markers[i].name = name));
                },
              },
              ...MARKER_COLORS.map((c) => ({ label: `Color: ${c}${c === m.color ? ' ✓' : ''}`, onClick: () => commit((d) => void (d.markers[i].color = c)) })),
              { sep: true },
              { label: 'Delete marker', onClick: () => commit((d) => void d.markers.splice(i, 1)) },
            ])
          }
        >
          <div className="flag" style={{ background: MARKER_CSS[m.color] }} />
          {m.name && <div className="mlabel">{m.name}</div>}
        </div>
      ))}
    </div>
  );
}
