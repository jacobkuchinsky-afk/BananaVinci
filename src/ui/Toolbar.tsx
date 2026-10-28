import { useEditor, editor, undo, redo } from '../state/store';
import { addMarker, splitAtPlayhead, zoomBy, zoomToFit, setIn, setOut, clearInOut } from '../state/actions';
import { Icon } from './icons';
import { closeVoicePanel, openVoicePanel, useVoice } from '../engine/voice';
import { findObject } from '../state/commands';
import { animatedPaths } from '../format/values';

export function Toolbar() {
  const tool = useEditor((s) => s.tool);
  const snapping = useEditor((s) => s.snapping);
  const zoom = useEditor((s) => s.zoom);
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const hasRange = useEditor((s) => s.inPoint !== null || s.outPoint !== null);
  const tab = useEditor((s) => s.bottomTab);
  const voiceOpen = useVoice((s) => s.open);
  const voiceBusy = useVoice((s) => s.status === 'recording' || s.status === 'countdown');
  const animCount = useEditor((s) => {
    if (s.selection.length !== 1) return 0;
    const o = findObject(s.project, s.selection[0])?.obj;
    return o ? animatedPaths(o).length : 0;
  });

  const toolBtn = (id: 'select' | 'blade' | 'slip', icon: 'select' | 'blade' | 'slip', title: string) => (
    <button className={`icon-btn ${tool === id ? 'active' : ''}`} title={title} onClick={() => editor.set({ tool: id })}>
      <Icon name={icon} size={16} />
    </button>
  );

  return (
    <div className="toolbar">
      <div className="tabs">
        <button className={tab === 'timeline' ? 'on' : ''} onClick={() => editor.set({ bottomTab: 'timeline' })} title="Timeline (Shift+1)">
          Timeline
        </button>
        <button className={`anim-tab ${tab === 'graph' ? 'on' : ''}`} onClick={() => editor.set({ bottomTab: 'graph' })} title="Animation: keyframe curves, easing and recording (Shift+2)">
          <span className="kf-glyph">◆</span> Animation{animCount > 0 && <span className="badge">{animCount}</span>}
        </button>
        <button className={tab === 'transcript' ? 'on' : ''} onClick={() => editor.set({ bottomTab: 'transcript' })} title="Transcript: speech-to-text with word timestamps, auto-captions (Shift+3)">
          <Icon name="text" size={11} /> Transcript
        </button>
      </div>
      {toolBtn('select', 'select', 'Selection / trim tool (A)\nDrag clips to move, drag edges to trim. Alt+drag duplicates.')}
      {toolBtn('blade', 'blade', 'Blade / cut tool (B)\nClick a clip to cut it. Shift+click cuts all tracks.')}
      {toolBtn('slip', 'slip', 'Slip tool (Y)\nDrag a clip to change which part of the source is shown.')}
      <span className="sep" />
      <button className="icon-btn" title="Split at playhead (Ctrl+B)" onClick={splitAtPlayhead}>
        <Icon name="split" size={15} />
      </button>
      <button className={`icon-btn ${snapping ? 'active' : ''}`} title="Snapping (N)" onClick={() => editor.set({ snapping: !snapping })}>
        <Icon name="magnet" size={15} />
      </button>
      <button className="icon-btn" title="Add marker (M)" onClick={() => addMarker()}>
        <Icon name="marker" size={14} />
      </button>
      <button className={`icon-btn mic-btn ${voiceOpen ? 'active' : ''} ${voiceBusy ? 'live' : ''}`} title="Record audio from a microphone (voice-over)" onClick={() => (voiceOpen ? closeVoicePanel() : openVoicePanel())}>
        <Icon name="mic" size={15} />
      </button>
      <span className="sep" />
      <button className="btn ghost" style={{ height: 24, padding: '0 6px' }} title="Set In point (I)" onClick={setIn}>
        In
      </button>
      <button className="btn ghost" style={{ height: 24, padding: '0 6px' }} title="Set Out point (O)" onClick={setOut}>
        Out
      </button>
      {hasRange && (
        <button className="icon-btn sm" title="Clear In/Out (Alt+X)" onClick={clearInOut}>
          <Icon name="close" size={11} />
        </button>
      )}
      <span className="sep" />
      <button className="icon-btn" title="Undo (Ctrl+Z)" onClick={undo} disabled={!canUndo}>
        <Icon name="undo" size={15} />
      </button>
      <button className="icon-btn" title="Redo (Ctrl+Shift+Z)" onClick={redo} disabled={!canRedo}>
        <Icon name="redo" size={15} />
      </button>
      <span className="spacer" />
      <button className="icon-btn" title="Zoom to fit (Shift+Z)" onClick={zoomToFit}>
        <Icon name="fit" size={14} />
      </button>
      <button className="icon-btn" title="Zoom out (-)" onClick={() => zoomBy(1 / 1.4)}>
        <Icon name="minus" size={14} />
      </button>
      <input
        className="slider zoom-slider"
        type="range"
        min={0}
        max={1000}
        value={Math.round((Math.log(zoom / 2) / Math.log(300)) * 1000)}
        onChange={(e) => editor.set({ zoom: 2 * Math.pow(300, Number(e.target.value) / 1000) })}
        title="Timeline zoom (Ctrl+scroll)"
      />
      <button className="icon-btn" title="Zoom in (+)" onClick={() => zoomBy(1.4)}>
        <Icon name="plus" size={14} />
      </button>
    </div>
  );
}
