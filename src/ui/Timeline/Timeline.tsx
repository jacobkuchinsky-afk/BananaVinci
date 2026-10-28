import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent as RPointerEvent } from 'react';
import { produce } from 'immer';
import { hasSourceTime, type Project, type TimelineObject, type Track } from '../../format/schema';
import { placeAsset } from '../../state/assets';
import { commit, editor, endLive, select, setLive, setPlayhead, useEditor } from '../../state/store';
import { end, findObject, moveObjects, newObjectId, projectDuration, slip, splitObject, trimEnd, trimStart } from '../../state/commands';
import { frameRound, snapBlock, snapTime } from '../../state/snap';
import {
  addLibraryItem,
  addGenerator,
  closeGapAt,
  copySelected,
  cutSelected,
  deleteSelected,
  duplicateSelected,
  importFiles,
  paste,
  removeTrack,
  newTrack,
  setTimelineWidth,
  splitAtPlayhead,
  toggleEnabled,
  addMarker,
  groupSelected,
  ungroupSelected,
  type GeneratorKind,
} from '../../state/actions';
import { openContextMenu } from '../ContextMenu';
import { Icon } from '../icons';
import { Clip } from './Clip';
import { Ruler, RULER_H } from './Ruler';

const ROW_H = { video: 64, audio: 54 } as const;
const NEW_ZONE_H = 44;

interface Row {
  track: Track;
  y: number;
  h: number;
  index: number;
}

/** Display order: video tracks top-down (highest layer first), then audio tracks. */
function layoutRows(tracks: Track[]): Row[] {
  const ordered = [...tracks.filter((t) => t.kind === 'video').reverse(), ...tracks.filter((t) => t.kind === 'audio')];
  let y = 0;
  return ordered.map((track, index) => {
    const r = { track, y, h: ROW_H[track.kind], index };
    y += r.h;
    return r;
  });
}

function dragKind(e: DragEvent): 'video' | 'audio' | 'any' | null {
  const types = [...e.dataTransfer.types];
  if (types.includes('application/x-bv-kind-audio')) return 'audio';
  if (types.includes('application/x-bv-kind-video')) return 'video';
  if (types.includes('Files')) return 'any';
  return null;
}

export function Timeline() {
  const project = useEditor((s) => s.project);
  const zoom = useEditor((s) => s.zoom);
  const selection = useEditor((s) => s.selection);
  const tool = useEditor((s) => s.tool);
  const rows = useMemo(() => layoutRows(project.tracks), [project.tracks]);
  const totalH = rows.reduce((n, r) => n + r.h, 0);

  const scrollRef = useRef<HTMLDivElement>(null);
  const tracksRef = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ left: 0, top: 0, width: 1000 });
  const [snapLine, setSnapLine] = useState<number | null>(null);
  const [bladeX, setBladeX] = useState<number | null>(null);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [dropRow, setDropRow] = useState<string | null>(null);

  const duration = projectDuration(project);
  const contentW = Math.max((duration + 30) * zoom, scroll.width + scroll.left + 200);
  const sel = useMemo(() => new Set(selection), [selection]);
  const libById = useMemo(() => new Map(project.library.map((l) => [l.id, l])), [project.library]);

  // ---------------------------------------------------------------- scroll / zoom
  useLayoutEffect(() => {
    const el = scrollRef.current!;
    const update = () => {
      setScroll({ left: el.scrollLeft, top: el.scrollTop, width: el.clientWidth });
      setTimelineWidth(el.clientWidth);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    el.addEventListener('scroll', update);
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey && !e.altKey) return;
      e.preventDefault();
      const s = editor.get();
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left - 0;
      const t = (px + el.scrollLeft) / s.zoom;
      const z = Math.max(2, Math.min(600, s.zoom * Math.exp(-e.deltaY * 0.0015)));
      editor.set({ zoom: z });
      requestAnimationFrame(() => (el.scrollLeft = Math.max(0, t * z - px)));
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => {
      ro.disconnect();
      el.removeEventListener('scroll', update);
      el.removeEventListener('wheel', wheel);
    };
  }, []);

  // ---------------------------------------------------------------- coordinate helpers
  const local = (e: { clientX: number; clientY: number }) => {
    const r = tracksRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const rowAtY = (y: number) => rows.find((r) => y >= r.y && y < r.y + r.h);
  const rowOf = (trackId: string) => rows.find((r) => r.track.id === trackId)!;

  function drag(onMove: (ev: PointerEvent) => void, onUp: (ev: PointerEvent) => void) {
    const move = (ev: PointerEvent) => onMove(ev);
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setSnapLine(null);
      onUp(ev);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // ---------------------------------------------------------------- pointer interactions
  const onPointerDown = (e: RPointerEvent) => {
    if (e.button !== 0) return;
    const s = editor.get();
    const target = e.target as HTMLElement;
    const clipEl = target.closest('[data-clip]') as HTMLElement | null;
    const p0 = local(e);
    (document.activeElement as HTMLElement | null)?.blur?.();

    if (!clipEl) return startMarquee(e, p0);

    const id = clipEl.dataset.clip!;
    const found = findObject(s.project, id);
    if (!found) return;
    const multi = e.shiftKey || e.ctrlKey || e.metaKey;
    if (target.dataset.keyt !== undefined) {
      select([id]);
      setPlayhead(found.obj.start + Number(target.dataset.keyt));
      return;
    }

    if (s.tool === 'blade') {
      const t = snapTime(p0.x / s.zoom, new Set([id])).t;
      commit((d) => {
        if (e.shiftKey) {
          for (const tr of d.tracks) if (!tr.locked) for (const o of [...tr.objects]) if (o.start < t && end(o) > t) splitObject(d as Project, o.id, t);
        } else if (!found.track.locked) splitObject(d as Project, id, t);
      });
      return;
    }

    if (multi) select([id], 'toggle');
    else if (!s.selection.includes(id)) select([id]);
    if (found.track.locked) return;

    const edge = target.dataset.edge as 'l' | 'r' | undefined;
    if (s.tool === 'slip' && hasSourceTime(found.obj)) return startSlip(e, found.obj);
    if (edge) return startTrim(e, found.obj, found.track, edge);
    startMove(e, found.obj, multi);
  };

  function startMove(e: RPointerEvent, primary: TimelineObject, multi: boolean) {
    const before = editor.get().project;
    const lockedIds = new Set(before.tracks.filter((t) => t.locked).flatMap((t) => t.objects.map((o) => o.id)));
    let ids = editor.get().selection.filter((x) => !lockedIds.has(x));
    if (!ids.includes(primary.id)) return;
    const origRow = new Map(ids.map((id) => [id, rowOf(findObject(before, id)!.track.id).index]));
    const primaryRow = origRow.get(primary.id)!;
    let base = before;
    let primaryId = primary.id;
    let started = false;
    let last: { dt: number; map: Record<string, string> } = { dt: 0, map: {} };

    drag(
      (ev) => {
        const dx = ev.clientX - e.clientX;
        const dy = ev.clientY - e.clientY;
        if (!started && Math.hypot(dx, dy) < 4) return;
        if (!started) {
          started = true;
          if (ev.altKey || e.altKey) {
            // Alt-drag: leave the originals and drag copies
            const map = new Map<string, string>();
            base = produce(before, (d) => {
              for (const id of ids) {
                const f = findObject(d as Project, id)!;
                const copy = JSON.parse(JSON.stringify(f.obj)) as TimelineObject;
                copy.id = newObjectId(d as Project, copy);
                f.track.objects.push(copy);
                map.set(id, copy.id);
              }
            });
            for (const [a, b] of map) origRow.set(b, origRow.get(a)!);
            ids = ids.map((id) => map.get(id)!);
            primaryId = map.get(primaryId)!;
            select(ids);
          }
        }
        const z = editor.get().zoom;
        let dt = dx / z;
        const minStart = Math.min(...ids.map((id) => findObject(base, id)!.obj.start));
        if (minStart + dt < 0) dt = -minStart;
        const ns = primary.start + dt;
        const sn = snapBlock(ns, ns + primary.duration, new Set(ids));
        dt += sn.adjust;
        setSnapLine(sn.snapped);

        const row = rowAtY(local(ev).y);
        let dRow = row ? row.index - primaryRow : 0;
        const map: Record<string, string> = {};
        const valid = ids.every((id) => {
          const target = rows[origRow.get(id)! + dRow];
          return target && target.track.kind === findObject(base, id)!.track.kind && !target.track.locked;
        });
        if (!valid) dRow = 0;
        for (const id of ids) map[id] = rows[origRow.get(id)! + dRow].track.id;
        last = { dt, map };
        setLive(produce(base, (d) => moveObjects(d as Project, ids, dt, map, false)));
      },
      () => {
        if (!started) {
          if (!multi && editor.get().selection.length > 1) select([primaryId]);
          return;
        }
        setLive(produce(base, (d) => moveObjects(d as Project, ids, last.dt, last.map, true)));
        endLive(before);
      },
    );
  }

  function startTrim(e: RPointerEvent, obj: TimelineObject, track: Track, side: 'l' | 'r') {
    const before = editor.get().project;
    const others = track.objects.filter((o) => o.id !== obj.id);
    const prevEnd = Math.max(0, ...others.filter((o) => end(o) <= obj.start + 1e-6).map(end));
    const nextStart = Math.min(Infinity, ...others.filter((o) => o.start >= end(obj) - 1e-6).map((o) => o.start));
    const edgeT = side === 'l' ? obj.start : end(obj);
    let moved = false;
    drag(
      (ev) => {
        moved = true;
        const z = editor.get().zoom;
        const sn = snapTime(edgeT + (ev.clientX - e.clientX) / z, new Set([obj.id]));
        setSnapLine(sn.snapped);
        let t = sn.t;
        t = side === 'l' ? Math.max(t, prevEnd) : Math.min(t, nextStart);
        setLive(
          produce(before, (d) => {
            const o = findObject(d as Project, obj.id)!.obj;
            side === 'l' ? trimStart(d as Project, o, t) : trimEnd(d as Project, o, t);
          }),
        );
      },
      () => moved && endLive(before),
    );
  }

  function startSlip(e: RPointerEvent, obj: TimelineObject) {
    if (!hasSourceTime(obj)) return;
    const before = editor.get().project;
    let moved = false;
    drag(
      (ev) => {
        moved = true;
        const z = editor.get().zoom;
        const newIn = obj.in - ((ev.clientX - e.clientX) / z) * obj.speed;
        setLive(
          produce(before, (d) => {
            slip(d as Project, findObject(d as Project, obj.id)!.obj, newIn);
          }),
        );
      },
      () => moved && endLive(before),
    );
  }

  function startMarquee(e: RPointerEvent, p0: { x: number; y: number }) {
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    const baseSel = additive ? editor.get().selection : [];
    if (!additive) select([]);
    editor.set({ selectedLibrary: null });
    let moved = false;
    drag(
      (ev) => {
        const p = local(ev);
        if (!moved && Math.hypot(p.x - p0.x, p.y - p0.y) < 4) return;
        moved = true;
        const m = { x0: Math.min(p0.x, p.x), y0: Math.min(p0.y, p.y), x1: Math.max(p0.x, p.x), y1: Math.max(p0.y, p.y) };
        setMarquee(m);
        const z = editor.get().zoom;
        const hits: string[] = [];
        for (const r of rows) {
          if (r.y + r.h < m.y0 || r.y > m.y1) continue;
          for (const o of r.track.objects) if (o.start * z < m.x1 && end(o) * z > m.x0) hits.push(o.id);
        }
        select([...new Set([...baseSel, ...hits])]);
      },
      (ev) => {
        setMarquee(null);
        if (!moved) {
          // plain click on empty track space: move the playhead there
          const row = rowAtY(p0.y);
          if (row) editor.set({ selectedTrack: row.track.id });
          setPlayhead(snapTime(local(ev).x / editor.get().zoom).t);
        }
      },
    );
  }

  const onHover = (e: RPointerEvent) => {
    const s = editor.get();
    if (s.tool !== 'blade' || e.buttons) return bladeX !== null && setBladeX(null);
    const overClip = (e.target as HTMLElement).closest('[data-clip]');
    if (!overClip) return bladeX !== null && setBladeX(null);
    setBladeX(snapTime(local(e).x / s.zoom, new Set([(overClip as HTMLElement).dataset.clip!])).t * s.zoom);
  };

  // ---------------------------------------------------------------- context menu
  const onContextMenu = (e: React.MouseEvent) => {
    const s = editor.get();
    const clipEl = (e.target as HTMLElement).closest('[data-clip]') as HTMLElement | null;
    const p = local(e);
    const t = p.x / s.zoom;
    if (clipEl) {
      const id = clipEl.dataset.clip!;
      if (!s.selection.includes(id)) select([id]);
      const obj = findObject(s.project, id)?.obj;
      openContextMenu(e, [
        { label: 'Split at playhead', kbd: 'Ctrl+B', onClick: splitAtPlayhead },
        { label: 'Split here', onClick: () => commit((d) => void splitObject(d as Project, id, frameRound(t))) },
        { sep: true },
        { label: 'Cut', kbd: 'Ctrl+X', onClick: cutSelected },
        { label: 'Copy', kbd: 'Ctrl+C', onClick: () => copySelected() },
        { label: 'Paste at playhead', kbd: 'Ctrl+V', onClick: () => paste() },
        { label: 'Duplicate', kbd: 'Ctrl+D', onClick: duplicateSelected },
        { sep: true },
        { label: 'Group', kbd: 'Ctrl+G', onClick: groupSelected, disabled: editor.get().selection.length < 2 },
        { label: 'Ungroup', kbd: 'Ctrl+Shift+G', onClick: ungroupSelected, disabled: obj?.type !== 'group' },
        { sep: true },
        { label: obj?.enabled ? 'Disable' : 'Enable', kbd: 'D', onClick: toggleEnabled },
        { label: 'Delete', kbd: 'Del', onClick: () => deleteSelected(false) },
        { label: 'Ripple delete', kbd: 'Shift+Del', onClick: () => deleteSelected(true) },
      ]);
    } else {
      const row = rowAtY(p.y);
      openContextMenu(e, [
        { label: 'Paste here', onClick: () => paste(frameRound(t)) },
        { label: 'Close gap', disabled: !row, onClick: () => row && closeGapAt(row.track.id, t) },
        { label: 'Add marker here', onClick: () => addMarker(frameRound(t)) },
        { sep: true },
        { label: 'Add text here', onClick: () => addGenerator('text', frameRound(t)) },
        { sep: true },
        { label: 'Add video track', onClick: () => newTrack('video') },
        { label: 'Add audio track', onClick: () => newTrack('audio') },
      ]);
    }
  };

  // ---------------------------------------------------------------- drag & drop from library / OS
  const onDragOver = (e: DragEvent) => {
    const kind = dragKind(e);
    if (!kind) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    const p = local(e);
    const row = rowAtY(p.y);
    if (row && (kind === 'any' || row.track.kind === kind || (kind === 'video' && row.track.kind === 'audio' && e.dataTransfer.types.includes('application/x-bv-has-audio'))) && !row.track.locked)
      setDropRow(row.track.id);
    else if (p.y >= totalH) setDropRow('new');
    else setDropRow(null);
    const sn = snapTime(p.x / editor.get().zoom);
    setSnapLine(sn.snapped);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const target = dropRow ?? undefined;
    setDropRow(null);
    setSnapLine(null);
    const t = snapTime(local(e).x / editor.get().zoom).t;
    const lib = e.dataTransfer.getData('application/x-bv-lib');
    const gen = e.dataTransfer.getData('application/x-bv-gen');
    const asset = e.dataTransfer.getData('application/x-bv-asset');
    if (lib) addLibraryItem(lib, t, target);
    else if (asset) placeAsset(asset, t, target);
    else if (gen) addGenerator(gen as GeneratorKind, t, target);
    else if (e.dataTransfer.files.length) importFiles([...e.dataTransfer.files], { at: t, trackId: target });
  };

  return (
    <div className="timeline">
      <div className="tl-main">
        <TrackHeaders rows={rows} scrollTop={scroll.top} totalH={totalH} />
        <div ref={scrollRef} className={`tl-scroll tool-${tool}`}>
          <div className="tl-content" style={{ width: contentW, minHeight: '100%' }}>
            <Ruler width={contentW} scrollLeft={scroll.left} viewWidth={scroll.width} />
            <div
              ref={tracksRef}
              style={{ position: 'relative', height: totalH + NEW_ZONE_H }}
              onPointerDown={onPointerDown}
              onPointerMove={onHover}
              onPointerLeave={() => setBladeX(null)}
              onContextMenu={onContextMenu}
              onDragOver={onDragOver}
              onDragLeave={() => setDropRow(null)}
              onDrop={onDrop}
            >
              {rows.map((r) => (
                <div
                  key={r.track.id}
                  className={`track-row ${r.track.kind} ${dropRow === r.track.id ? 'drop-ok' : ''} ${r.track.locked ? 'locked' : ''}`}
                  style={{ top: r.y, height: r.h, opacity: r.track.hidden ? 0.45 : 1 }}
                >
                  {r.track.objects.map((o) => (
                    <Clip key={o.id} obj={o} item={'source' in o ? libById.get(o.source) : undefined} zoom={zoom} height={r.h} selected={sel.has(o.id)} />
                  ))}
                </div>
              ))}
              <div className={`new-track-zone ${dropRow === 'new' ? 'drop-ok' : ''}`} style={{ top: totalH, height: NEW_ZONE_H }}>
                {dropRow === 'new' ? 'Drop to create a new track' : ''}
              </div>
              <MarkerLines />
              {marquee && <div className="marquee" style={{ left: marquee.x0, top: marquee.y0, width: marquee.x1 - marquee.x0, height: marquee.y1 - marquee.y0 }} />}
            </div>
            <Playhead scrollRef={scrollRef} />
            {snapLine !== null && <div className="snap-line" style={{ left: snapLine * zoom }} />}
            {bladeX !== null && <div className="blade-line" style={{ left: bladeX }} />}
          </div>
        </div>
      </div>
    </div>
  );
}

function MarkerLines() {
  const markers = useEditor((s) => s.project.markers);
  const zoom = useEditor((s) => s.zoom);
  return (
    <>
      {markers.map((m, i) => (
        <div key={i} className="marker-line" style={{ left: m.time * zoom, background: `var(--m-${m.color}, ${MARKER_CSS[m.color]})`, top: 0 }} />
      ))}
    </>
  );
}

export const MARKER_CSS: Record<string, string> = {
  yellow: '#facc15',
  blue: '#3b82f6',
  red: '#ef4444',
  green: '#22c55e',
  purple: '#a855f7',
  white: '#e5e7eb',
};

function Playhead({ scrollRef }: { scrollRef: React.RefObject<HTMLDivElement> }) {
  const playhead = useEditor((s) => s.playhead);
  const zoom = useEditor((s) => s.zoom);
  const playing = useEditor((s) => s.playing);
  const x = playhead * zoom;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !playing) return;
    if (x > el.scrollLeft + el.clientWidth - 60) el.scrollLeft = x - 120;
    else if (x < el.scrollLeft) el.scrollLeft = Math.max(0, x - 120);
  }, [x, playing, scrollRef]);
  return <div className="playhead" style={{ left: x }} />;
}

function TrackHeaders({ rows, scrollTop, totalH }: { rows: Row[]; scrollTop: number; totalH: number }) {
  const selectedTrack = useEditor((s) => s.selectedTrack);
  const setTrack = (id: string, patch: Partial<Track>, key?: string) =>
    commit(
      (d) => {
        const t = d.tracks.find((x) => x.id === id);
        if (t) Object.assign(t, patch);
      },
      key ? { coalesce: key } : undefined,
    );
  return (
    <div className="tl-headers">
      <div className="tl-corner" style={{ height: RULER_H, gap: 4 }}>
        <button className="icon-btn sm" title="Add video track" onClick={() => newTrack('video')}>
          <Icon name="plus" size={12} />
        </button>
        <span style={{ color: 'var(--muted)', fontSize: 11 }}>Video</span>
        <button className="icon-btn sm" title="Add audio track" onClick={() => newTrack('audio')} style={{ marginLeft: 8 }}>
          <Icon name="plus" size={12} />
        </button>
        <span style={{ color: 'var(--muted)', fontSize: 11 }}>Audio</span>
      </div>
      <div className="tl-headers-inner">
        <div style={{ position: 'absolute', left: 0, right: 0, top: -scrollTop + 0, height: totalH }}>
          {rows.map((r) => {
            const t = r.track;
            return (
              <div
                key={t.id}
                className={`track-head ${t.kind} ${selectedTrack === t.id ? 'sel' : ''}`}
                style={{ top: r.y, height: r.h }}
                onPointerDown={() => editor.set({ selectedTrack: t.id })}
                onContextMenu={(e) =>
                  openContextMenu(e, [
                    { label: `Add ${t.kind} track`, onClick: () => newTrack(t.kind) },
                    { label: `Delete track ${t.id}`, onClick: () => removeTrack(t.id) },
                  ])
                }
              >
                <div className="top-row">
                  <span className="tid">{t.id}</span>
                  <input className="tname" value={t.name} onChange={(e) => setTrack(t.id, { name: e.target.value }, `name:${t.id}`)} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
                </div>
                <div className="top-row">
                  <div className="btns">
                    {t.kind === 'video' ? (
                      <button className={`tbtn ${t.hidden ? 'on-h' : ''}`} title={t.hidden ? 'Show track' : 'Hide track'} onClick={() => setTrack(t.id, { hidden: !t.hidden })}>
                        <Icon name={t.hidden ? 'eyeOff' : 'eye'} size={11} />
                      </button>
                    ) : (
                      <>
                        <button className={`tbtn ${t.muted ? 'on-m' : ''}`} title="Mute" onClick={() => setTrack(t.id, { muted: !t.muted })}>
                          M
                        </button>
                        <button className={`tbtn ${t.solo ? 'on-s' : ''}`} title="Solo" onClick={() => setTrack(t.id, { solo: !t.solo })}>
                          S
                        </button>
                      </>
                    )}
                    <button className={`tbtn ${t.locked ? 'on-l' : ''}`} title={t.locked ? 'Unlock' : 'Lock'} onClick={() => setTrack(t.id, { locked: !t.locked })}>
                      <Icon name={t.locked ? 'lock' : 'unlock'} size={11} />
                    </button>
                  </div>
                  <span className="count">
                    {t.objects.length} {t.objects.length === 1 ? 'object' : 'objects'}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
