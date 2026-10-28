import { commit, editor, redo, select, setPlayhead, undo } from '../state/store';
import { findObject } from '../state/commands';
import { shiftValue } from '../format/values';
import { isVisual, type Project } from '../format/schema';
import { pause, shuttle, togglePlay } from '../engine/playback';
import { toggleRecording } from '../engine/recorder';
import { cancelVoice, stopVoice, useVoice } from '../engine/voice';
import { deleteGraphKeys } from './Graph/GraphEditor';
import { hasPasteTarget } from './AssetRequests';
import { projectDuration } from '../state/commands';
import {
  addGenerator,
  addMarker,
  clearInOut,
  copySelected,
  cutSelected,
  deleteSelected,
  duplicateSelected,
  jumpMarker,
  nudge,
  paste,
  saveNow,
  selectAll,
  setIn,
  setOut,
  splitAtPlayhead,
  toggleEnabled,
  zoomBy,
  zoomToFit,
  groupSelected,
  ungroupSelected,
} from '../state/actions';

export const SHORTCUTS: { group: string; items: [string, string][] }[] = [
  {
    group: 'Playback',
    items: [
      ['Space', 'Play / pause'],
      ['J / K / L', 'Reverse / stop / forward (press again = faster)'],
      ['← / →', 'Step one frame'],
      ['Shift + ← / →', 'Step one second'],
      ['↑ / ↓', 'Previous / next edit point or marker'],
      ['Home / End', 'Go to start / end'],
      ['Ctrl + L', 'Toggle loop'],
    ],
  },
  {
    group: 'Tools',
    items: [
      ['A', 'Selection / trim tool'],
      ['B', 'Blade (cut) tool'],
      ['Y', 'Slip tool'],
      ['N', 'Toggle snapping'],
      ['Alt + drag', 'Duplicate while dragging'],
      ['Ctrl + scroll', 'Zoom timeline'],
    ],
  },
  {
    group: 'Editing',
    items: [
      ['Ctrl + B', 'Split at playhead (selected, or all)'],
      ['Delete', 'Delete (leave gap)'],
      ['Shift + Delete', 'Ripple delete (close gap)'],
      ['Ctrl + C / X / V', 'Copy / cut / paste at playhead'],
      ['Ctrl + D', 'Duplicate'],
      ['D', 'Enable / disable object'],
      [', / .', 'Nudge selection 1 frame (Shift = 10)'],
      ['Alt + arrows', 'Nudge selected objects on screen 1 px (Shift = 10 px), whole animation'],
      ['Drag in viewer', 'Move the object; animated objects move as a whole'],
      ['Alt + drag in viewer', 'Change only the playhead moment (keyframe)'],
      ['Ctrl + A', 'Select all'],
      ['Esc', 'Deselect'],
      ['Ctrl + Z', 'Undo'],
      ['Ctrl + Shift + Z', 'Redo'],
    ],
  },
  {
    group: 'Animation',
    items: [
      ['◆ (Inspector)', 'Add / remove a keyframe at the playhead'],
      ['R', 'Record motion: drag the selected object while it plays'],
      ['Shift + 1 / 2 / 3', 'Timeline / Animation / Transcript'],
      ['Del (Graph Editor)', 'Delete selected keyframes'],
      ['Double-click graph', 'Add a keyframe'],
    ],
  },
  {
    group: 'Timeline',
    items: [
      ['M', 'Add marker'],
      ['I / O', 'Set in / out point'],
      ['Alt + X', 'Clear in / out'],
      ['T', 'Add text at playhead'],
      ['+ / −', 'Zoom in / out'],
      ['Shift + Z', 'Zoom to fit'],
    ],
  },
  {
    group: 'Project',
    items: [
      ['Ctrl + S', 'Save'],
      ['Ctrl + Shift + S', 'Save as'],
      ['Ctrl + O', 'Open project'],
      ['Ctrl + E', 'Export MP4'],
      ['?', 'Show shortcuts'],
    ],
  },
];

export function installShortcuts() {
  const onKey = (e: KeyboardEvent) => {
    const el = e.target as HTMLElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
    const s = editor.get();
    if (s.dialog && e.key !== 'Escape') return;
    const ctrl = e.ctrlKey || e.metaKey;
    // while recording a voice-over, Space / Esc end the take instead of their usual jobs
    const voice = useVoice.getState().status;
    if ((voice === 'recording' || voice === 'countdown') && (e.key === ' ' || e.key === 'Escape')) {
      e.preventDefault();
      if (e.key === 'Escape' || voice === 'countdown') cancelVoice();
      else stopVoice();
      return;
    }
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const fps = s.project.project.fps;
    let handled = true;

    // Alt + arrows: nudge the selected objects on screen (1 px, Shift = 10 px). Animated objects move as a whole.
    if (e.altKey && !ctrl && k.startsWith('Arrow') && s.selection.length) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const dx = k === 'ArrowLeft' ? -step : k === 'ArrowRight' ? step : 0;
      const dy = k === 'ArrowUp' ? -step : k === 'ArrowDown' ? step : 0;
      commit(
        (d) => {
          for (const id of s.selection) {
            const f = findObject(d as Project, id);
            if (!f || f.track.locked || !isVisual(f.obj)) continue;
            if (dx) shiftValue(f.obj, 'transform.x', { add: dx });
            if (dy) shiftValue(f.obj, 'transform.y', { add: dy });
          }
        },
        { coalesce: 'nudge-pos' },
      );
      return;
    }

    // a hovered / selected asset-request box takes Ctrl+V (let the browser deliver the paste to it)
    if (ctrl && k === 'v' && hasPasteTarget()) return;

    if (ctrl) {
      if (k === 'z' && !e.shiftKey) undo();
      else if ((k === 'z' && e.shiftKey) || k === 'y') redo();
      else if (k === 'c') copySelected();
      else if (k === 'x') cutSelected();
      else if (k === 'v') paste();
      else if (k === 'd') duplicateSelected();
      else if (k === 'a') selectAll();
      else if (k === 'b') splitAtPlayhead();
      else if (k === 'g' && e.shiftKey) ungroupSelected();
      else if (k === 'g') groupSelected();
      else if (k === 's' && e.shiftKey) editor.set({ dialog: 'saveAs' });
      else if (k === 's') saveNow();
      else if (k === 'o') editor.set({ dialog: 'projects' });
      else if (k === 'e') editor.set({ dialog: 'export' });
      else if (k === 'l') editor.set({ loop: !s.loop });
      else handled = false;
    } else {
      switch (k) {
        case ' ':
          togglePlay();
          break;
        case 'j':
          shuttle(-1);
          break;
        case 'k':
          shuttle(0);
          break;
        case 'l':
          shuttle(1);
          break;
        case 'ArrowLeft':
          if (s.playing) pause();
          setPlayhead(editor.get().playhead - (e.shiftKey ? 1 : 1 / fps));
          break;
        case 'ArrowRight':
          if (s.playing) pause();
          setPlayhead(editor.get().playhead + (e.shiftKey ? 1 : 1 / fps));
          break;
        case 'ArrowUp':
          jumpMarker(-1);
          break;
        case 'ArrowDown':
          jumpMarker(1);
          break;
        case 'Home':
          setPlayhead(0);
          break;
        case 'End':
          setPlayhead(projectDuration(s.project));
          break;
        case 'a':
          editor.set({ tool: 'select' });
          break;
        case 'b':
          editor.set({ tool: 'blade' });
          break;
        case 'y':
          editor.set({ tool: 'slip' });
          break;
        case 'n':
          editor.set({ snapping: !s.snapping });
          break;
        case 'm':
          addMarker();
          break;
        case 'i':
          setIn();
          break;
        case 'o':
          setOut();
          break;
        case 'x':
          if (e.altKey) clearInOut();
          else handled = false;
          break;
        case 't':
          addGenerator('text');
          break;
        case 'd':
          toggleEnabled();
          break;
        case ',':
        case '<':
          nudge(e.shiftKey ? -10 : -1);
          break;
        case '.':
        case '>':
          nudge(e.shiftKey ? 10 : 1);
          break;
        case 'Delete':
        case 'Backspace':
          if (s.bottomTab === 'graph' && deleteGraphKeys()) break;
          deleteSelected(e.shiftKey);
          break;
        case 'r':
          toggleRecording();
          break;
        case '!':
          editor.set({ bottomTab: 'timeline' });
          break;
        case '@':
          editor.set({ bottomTab: 'graph' });
          break;
        case '#':
          editor.set({ bottomTab: 'transcript' });
          break;
        case 'Escape':
          if (s.dialog) editor.set({ dialog: null });
          else select([]);
          break;
        case '=':
        case '+':
          zoomBy(1.4);
          break;
        case '-':
        case '_':
          zoomBy(1 / 1.4);
          break;
        case 'z':
          if (e.shiftKey) zoomToFit();
          else handled = false;
          break;
        case '?':
          editor.set({ dialog: 'shortcuts' });
          break;
        default:
          handled = false;
      }
    }
    if (handled) e.preventDefault();
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}
