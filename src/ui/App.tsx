import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { MenuBar } from './MenuBar';
import { LibraryPanel } from './LibraryPanel';
import { Viewer } from './Viewer';
import { Inspector } from './Inspector/Inspector';
import { Toolbar } from './Toolbar';
import { Timeline } from './Timeline/Timeline';
import { ContextMenuHost } from './ContextMenu';
import { Dialogs, DiskErrorBanner, Toasts } from './Dialogs';
import { installShortcuts } from './shortcuts';
import { GraphEditor } from './Graph/GraphEditor';
import { VoicePanel } from './VoicePanel';
import { TranscriptPanel } from './TranscriptPanel';
import { useEditor } from '../state/store';

interface Sizes {
  lib: number;
  insp: number;
  timeline: number;
}

const DEFAULT_SIZES: Sizes = { lib: 300, insp: 330, timeline: 360 };

function loadSizes(): Sizes {
  try {
    return { ...DEFAULT_SIZES, ...JSON.parse(localStorage.getItem('bv.sizes') ?? '{}') };
  } catch {
    return DEFAULT_SIZES;
  }
}

export function App() {
  const [sizes, setSizes] = useState(loadSizes);
  const [active, setActive] = useState<keyof Sizes | null>(null);
  const sizesRef = useRef(sizes);
  sizesRef.current = sizes;

  useEffect(() => installShortcuts(), []);
  const bottomTab = useEditor((s) => s.bottomTab);

  const startResize = (key: keyof Sizes, e: React.PointerEvent) => {
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, v: sizesRef.current[key] };
    setActive(key);
    const move = (ev: PointerEvent) => {
      const d = key === 'lib' ? ev.clientX - start.x : key === 'insp' ? start.x - ev.clientX : start.y - ev.clientY;
      const limits = key === 'timeline' ? [140, innerHeight - 220] : [200, innerWidth / 2.5];
      setSizes((s) => ({ ...s, [key]: Math.round(Math.min(limits[1], Math.max(limits[0], start.v + d))) }));
    };
    const up = () => {
      setActive(null);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      try {
        localStorage.setItem('bv.sizes', JSON.stringify(sizesRef.current));
      } catch {}
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const style = { '--lib-w': `${sizes.lib}px`, '--insp-w': `${sizes.insp}px`, '--timeline-h': `${sizes.timeline}px` } as CSSProperties;

  return (
    <div className="app" style={style}>
      <MenuBar />
      <div className="top">
        <LibraryPanel />
        <div className={`splitter v ${active === 'lib' ? 'active' : ''}`} onPointerDown={(e) => startResize('lib', e)} />
        <Viewer />
        <div className={`splitter v ${active === 'insp' ? 'active' : ''}`} onPointerDown={(e) => startResize('insp', e)} />
        <Inspector />
      </div>
      <div className={`splitter h ${active === 'timeline' ? 'active' : ''}`} onPointerDown={(e) => startResize('timeline', e)} />
      <div className="panel" style={{ minHeight: 0 }}>
        <Toolbar />
        {bottomTab === 'graph' ? <GraphEditor /> : bottomTab === 'transcript' ? <TranscriptPanel /> : <Timeline />}
      </div>
      <VoicePanel />
      <ContextMenuHost />
      <Dialogs />
      <DiskErrorBanner />
      <Toasts />
    </div>
  );
}
