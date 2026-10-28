import { memo, useEffect, useRef, useState } from 'react';
import type { GroupObject, LibraryItem, TimelineObject } from '../../format/schema';
import { getPeaks, onPeaks } from '../../engine/mediaCache';
import { thumbUrl } from '../../state/sync';
import { keyframeTimes } from '../../format/values';
import { pathEnd } from '../../format/recording';
import { countDeep } from '../../format/groups';
import { Icon } from '../icons';

const ICON = { video: 'video', image: 'image', audio: 'audio', text: 'text', shape: 'shape', adjustment: 'adjust', group: 'group' } as const;

export function clipLabel(o: TimelineObject): string {
  if (o.type === 'text') return o.text.replace(/\n/g, ' ') || 'Text';
  if (o.type === 'shape') return o.shape === 'solid' ? 'Solid Color' : o.shape === 'ellipse' ? 'Ellipse' : 'Rectangle';
  if (o.type === 'adjustment') return 'Adjustment';
  if (o.type === 'group') return `Group · ${countDeep(o)} objects`;
  return o.source;
}

interface Props {
  obj: TimelineObject;
  item?: LibraryItem;
  zoom: number;
  height: number;
  selected: boolean;
}

export const Clip = memo(function Clip({ obj, item, zoom, height, selected }: Props) {
  const left = obj.start * zoom;
  const width = Math.max(2, obj.duration * zoom);
  const fadeIn = 'fadeIn' in obj ? obj.fadeIn * zoom : 0;
  const fadeOut = 'fadeOut' in obj ? obj.fadeOut * zoom : 0;
  return (
    <div
      className={`clip ${obj.type} ${selected ? 'selected' : ''} ${obj.enabled ? '' : 'disabled'}`}
      data-clip={obj.id}
      style={{ left, width }}
      title={`${clipLabel(obj)}  ·  ${obj.id}\nstart ${obj.start.toFixed(2)}s · duration ${obj.duration.toFixed(2)}s${obj.note ? `\n${obj.note}` : ''}`}
    >
      <div className="clip-label">
        <Icon name={ICON[obj.type]} size={11} className="ic" />
        <span>{clipLabel(obj)}</span>
        {'speed' in obj && obj.speed !== 1 && <span style={{ color: 'var(--yellow)' }}>{obj.speed}×</span>}
        {obj.type !== 'audio' && 'effects' in obj && obj.effects.length > 0 && <span style={{ color: '#c4b5fd' }}>fx</span>}
      </div>
      <div className="clip-body">
        {(obj.type === 'video' || obj.type === 'image') && item && width > 24 && (
          <div className="film" style={{ backgroundImage: `url("${thumbUrl(item)}")`, backgroundSize: `auto 100%` }} />
        )}
        {(obj.type === 'audio' || (obj.type === 'video' && item?.hasAudio && height > 50)) && item && (
          <Waveform obj={obj as any} item={item} width={width} onVideo={obj.type === 'video'} />
        )}
        {obj.type === 'text' && <div className="gen-text">{obj.text}</div>}
        {obj.type === 'shape' && (
          <div className="gen-text">
            <span style={{ width: 12, height: 12, borderRadius: obj.shape === 'ellipse' ? 6 : 2, background: obj.fill, display: 'inline-block', marginRight: 6, border: '1px solid #0006' }} />
            {obj.fill}
          </div>
        )}
        {obj.type === 'adjustment' && (
          <div className="gen-text" style={{ color: '#ddd6fe' }}>
            {obj.effects.map((e) => e.type).join(' · ') || 'no effects'}
          </div>
        )}
        {obj.type === 'group' && <GroupTicks obj={obj} zoom={zoom} />}
        {fadeIn > 1 && <div className="fade in" style={{ width: Math.min(fadeIn, width) }} />}
        {fadeOut > 1 && <div className="fade out" style={{ width: Math.min(fadeOut, width) }} />}
      </div>
      {'motion' in obj &&
        obj.motion?.map((m, i) => (
          <span key={`mp${i}`} className="clip-path" style={{ left: m.start * zoom, width: Math.max(2, (pathEnd(m) - m.start) * zoom) }} title={`recorded motion path ${(obj.start + m.start).toFixed(2)}–${(obj.start + pathEnd(m)).toFixed(2)}s`} />
        ))}
      {zoom * obj.duration > 30 &&
        keyframeTimes(obj)
          .filter((k) => k.t >= -1e-6 && k.t <= obj.duration + 1e-6)
          .map((k) => <span key={k.t} className={`clip-kf ${k.recorded ? 'rec' : ''}`} data-keyt={k.t} style={{ left: k.t * zoom }} title={`keyframe at ${(obj.start + k.t).toFixed(2)}s`} />)}
      <div className="edge l" data-edge="l" />
      <div className="edge r" data-edge="r" />
    </div>
  );
});

/** One tick per object inside a group, where it starts: pictures on top, sounds along the bottom. */
function GroupTicks({ obj, zoom }: { obj: GroupObject; zoom: number }) {
  return (
    <>
      {obj.note && <div className="gen-text">{obj.note}</div>}
      {obj.objects
        .filter((c) => c.start < obj.duration)
        .map((c) => (
          <span key={c.id} className={`group-tick ${c.type === 'audio' ? 'snd' : ''}`} style={{ left: c.start * zoom, width: Math.max(2, Math.min(c.duration, obj.duration - c.start) * zoom) }} />
        ))}
    </>
  );
}

function Waveform({ obj, item, width, onVideo }: { obj: { in: number; speed: number; duration: number; volume: number }; item: LibraryItem; width: number; onVideo: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [, bump] = useState(0);
  useEffect(() => onPeaks(() => bump((n) => n + 1)), []);
  const peaks = getPeaks(item);
  const w = Math.min(Math.ceil(width), 6000);
  useEffect(() => {
    const c = ref.current;
    if (!c || !peaks) return;
    const h = c.clientHeight || 30;
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = onVideo ? 'rgba(160,200,255,0.35)' : 'rgba(110, 231, 210, 0.75)';
    const secPerPx = (obj.duration * obj.speed) / w;
    const gain = Math.min(2, typeof obj.volume === 'number' ? obj.volume : 1);
    for (let x = 0; x < w; x++) {
      const s0 = Math.floor((obj.in + x * secPerPx) * peaks.perSec);
      const s1 = Math.max(s0 + 1, Math.floor((obj.in + (x + 1) * secPerPx) * peaks.perSec));
      let m = 0;
      for (let i = s0; i < s1 && i < peaks.data.length; i++) m = Math.max(m, peaks.data[i]);
      const ph = Math.min(1, m * gain) * (h - 2);
      ctx.fillRect(x, onVideo ? h - ph : (h - ph) / 2, 1, Math.max(1, ph));
    }
  }, [peaks, w, obj.in, obj.speed, obj.duration, obj.volume, onVideo]);
  return <canvas ref={ref} className="wave" style={onVideo ? { top: '55%', height: '45%' } : undefined} />;
}
