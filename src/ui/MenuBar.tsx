import { useEffect, useRef, useState } from 'react';
import { editor, redo, undo, useEditor } from '../state/store';
import {
  addGenerator,
  addMarker,
  copySelected,
  cutSelected,
  deleteSelected,
  duplicateSelected,
  groupSelected,
  ungroupSelected,
  newTrack,
  paste,
  saveNow,
  selectAll,
  splitAtPlayhead,
  zoomToFit,
} from '../state/actions';
import type { MenuEntry } from './ContextMenu';
import { Icon, Logo } from './icons';

export function MenuBar() {
  const [open, setOpen] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const name = useEditor((s) => s.project.project.name);
  const file = useEditor((s) => s.projectFile);
  const dirty = useEditor((s) => s.dirty);
  const saving = useEditor((s) => s.saving);
  const autosave = useEditor((s) => s.autosave);
  const diskErrors = useEditor((s) => s.diskErrors);
  const snapping = useEditor((s) => s.snapping);
  const hasSel = useEditor((s) => s.selection.length > 0);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(null);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);

  const menus: Record<string, MenuEntry[]> = {
    File: [
      { label: 'New Project…', onClick: () => editor.set({ dialog: 'new' }) },
      { label: 'Open Project…', kbd: 'Ctrl+O', onClick: () => editor.set({ dialog: 'projects' }) },
      { sep: true },
      { label: 'Save', kbd: 'Ctrl+S', onClick: saveNow },
      { label: 'Save As…', kbd: 'Ctrl+Shift+S', onClick: () => editor.set({ dialog: 'saveAs' }) },
      { label: `Autosave: ${autosave ? 'On' : 'Off'}`, onClick: toggleAutosave },
      { sep: true },
      { label: 'Export MP4…', kbd: 'Ctrl+E', onClick: () => editor.set({ dialog: 'export' }) },
      { sep: true },
      { label: 'View project file (YAML)', onClick: () => window.open(`/files/${encodeURIComponent(editor.get().projectName ?? '')}/${file.split('/').pop()}`, '_blank') },
    ],
    Edit: [
      { label: 'Undo', kbd: 'Ctrl+Z', onClick: undo },
      { label: 'Redo', kbd: 'Ctrl+Shift+Z', onClick: redo },
      { sep: true },
      { label: 'Cut', kbd: 'Ctrl+X', onClick: cutSelected, disabled: !hasSel },
      { label: 'Copy', kbd: 'Ctrl+C', onClick: () => copySelected(), disabled: !hasSel },
      { label: 'Paste', kbd: 'Ctrl+V', onClick: () => paste() },
      { label: 'Duplicate', kbd: 'Ctrl+D', onClick: duplicateSelected, disabled: !hasSel },
      { label: 'Group', kbd: 'Ctrl+G', onClick: groupSelected, disabled: !hasSel },
      { label: 'Ungroup', kbd: 'Ctrl+Shift+G', onClick: ungroupSelected, disabled: !hasSel },
      { sep: true },
      { label: 'Delete', kbd: 'Del', onClick: () => deleteSelected(false), disabled: !hasSel },
      { label: 'Ripple Delete', kbd: 'Shift+Del', onClick: () => deleteSelected(true), disabled: !hasSel },
      { sep: true },
      { label: 'Select All', kbd: 'Ctrl+A', onClick: selectAll },
    ],
    Timeline: [
      { label: 'Split at Playhead', kbd: 'Ctrl+B', onClick: splitAtPlayhead },
      { label: 'Add Marker', kbd: 'M', onClick: () => addMarker() },
      { label: `Snapping: ${snapping ? 'On' : 'Off'}`, kbd: 'N', onClick: () => editor.set({ snapping: !snapping }) },
      { sep: true },
      { label: 'Add Video Track', onClick: () => newTrack('video') },
      { label: 'Add Audio Track', onClick: () => newTrack('audio') },
      { sep: true },
      { label: 'Zoom to Fit', kbd: 'Shift+Z', onClick: zoomToFit },
    ],
    Insert: [
      { label: 'Text', kbd: 'T', onClick: () => addGenerator('text') },
      { label: 'Rectangle', onClick: () => addGenerator('shape') },
      { label: 'Ellipse', onClick: () => addGenerator('ellipse') },
      { label: 'Solid Color', onClick: () => addGenerator('solid') },
      { label: 'Adjustment Layer', onClick: () => addGenerator('adjustment') },
    ],
    Help: [
      { label: 'Keyboard Shortcuts', kbd: '?', onClick: () => editor.set({ dialog: 'shortcuts' }) },
      { label: 'File Format Reference', onClick: () => window.open('/docs/BANANA_FORMAT.md', '_blank') },
    ],
  };

  const status = diskErrors ? (
    <>
      <span className="dot err" /> File has errors
    </>
  ) : saving ? (
    <>
      <span className="dot dirty" /> Saving…
    </>
  ) : dirty ? (
    <>
      <span className="dot dirty" /> Unsaved{autosave ? '' : ' (Ctrl+S)'}
    </>
  ) : (
    <>
      <span className="dot ok" /> Saved · live-synced
    </>
  );

  return (
    <div className="menubar" ref={ref}>
      <div className="brand">
        <Logo />
        <span>
          Banana<b>Vinci</b>
        </span>
      </div>
      {Object.entries(menus).map(([title, items]) => (
        <div key={title} style={{ position: 'relative' }}>
          <button className={`menu-btn ${open === title ? 'open' : ''}`} onClick={() => setOpen(open === title ? null : title)} onPointerEnter={() => open && setOpen(title)}>
            {title}
          </button>
          {open === title && (
            <div className="menu" style={{ left: 0 }}>
              {items.map((it, i) =>
                it.sep ? (
                  <div key={i} className="menu-sep" />
                ) : (
                  <button
                    key={i}
                    className="menu-item"
                    disabled={it.disabled}
                    onClick={() => {
                      setOpen(null);
                      it.onClick?.();
                    }}
                  >
                    <span>{it.label}</span>
                    {it.kbd && <kbd>{it.kbd}</kbd>}
                  </button>
                ),
              )}
            </div>
          )}
        </div>
      ))}
      <div className="title">
        {name}
        <span className="file">{file}</span>
      </div>
      <span style={{ flex: 1 }} />
      <span className="save-state" title={autosave ? 'Autosave is on. Edits to the file from outside (e.g. by an AI) reload automatically.' : 'Autosave is off'}>
        {status}
      </span>
      <button className="icon-btn" title="Keyboard shortcuts (?)" onClick={() => editor.set({ dialog: 'shortcuts' })} style={{ marginLeft: 8 }}>
        <Icon name="keyboard" size={15} />
      </button>
      <button className="btn primary" style={{ marginLeft: 6, height: 24 }} onClick={() => editor.set({ dialog: 'export' })}>
        <Icon name="export" size={13} /> Export
      </button>
    </div>
  );
}

function toggleAutosave() {
  const v = !editor.get().autosave;
  editor.set({ autosave: v });
  try {
    localStorage.setItem('bv.autosave', v ? 'on' : 'off');
  } catch {}
}
