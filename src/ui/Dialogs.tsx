import { useEffect, useState, type ReactNode } from 'react';
import { editor, replaceFromDisk, useEditor } from '../state/store';
import { api, openProject, save, type ProjectInfo } from '../state/sync';
import { projectDuration } from '../state/commands';
import { cancelExport, runExport } from '../engine/exporter';
import { serializeProject } from '../format/serialize';
import { Icon } from './icons';
import { SHORTCUTS } from './shortcuts';
import { timecode } from './time';

export function Modal({ title, children, foot, wide, onClose }: { title: string; children: ReactNode; foot?: ReactNode; wide?: boolean; onClose?: () => void }) {
  const close = onClose ?? (() => editor.set({ dialog: null }));
  return (
    <div className="modal-bg" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className={`modal ${wide ? 'wide' : ''}`}>
        <div className="modal-head">
          {title}
          <span className="spacer" />
          <button className="icon-btn sm" onClick={close}>
            <Icon name="close" size={13} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {foot && <div className="modal-foot">{foot}</div>}
      </div>
    </div>
  );
}

const timeLeft = (s: number) => (s < 60 ? `${Math.ceil(s)} s` : `${Math.ceil(s / 60)} min`);

export function Dialogs() {
  const dialog = useEditor((s) => s.dialog);
  const conflict = useEditor((s) => s.conflict);
  return (
    <>
      {dialog === 'export' && <ExportDialog />}
      {dialog === 'projects' && <ProjectsDialog />}
      {dialog === 'new' && <NameDialog mode="new" />}
      {dialog === 'saveAs' && <NameDialog mode="saveAs" />}
      {dialog === 'shortcuts' && <ShortcutsDialog />}
      {conflict && <ConflictDialog />}
    </>
  );
}

function ExportDialog() {
  const project = useEditor((s) => s.project);
  const inPoint = useEditor((s) => s.inPoint);
  const outPoint = useEditor((s) => s.outPoint);
  const progress = useEditor((s) => s.exportProgress);
  const projectName = useEditor((s) => s.projectName);
  const dur = projectDuration(project);
  const hasRange = inPoint !== null || outPoint !== null;
  const [range, setRange] = useState<'all' | 'inout'>(hasRange ? 'inout' : 'all');
  const [scale, setScale] = useState(1);
  const [crf, setCrf] = useState(18);
  const [fileName, setFileName] = useState(project.project.name);
  const start = range === 'inout' ? inPoint ?? 0 : 0;
  const end = range === 'inout' ? outPoint ?? dur : dur;
  const busy = progress && (progress.status === 'preparing' || progress.status === 'rendering' || progress.status === 'encoding');
  const fps = project.project.fps;
  const W = Math.round((project.project.width * scale) / 2) * 2;
  const H = Math.round((project.project.height * scale) / 2) * 2;

  useEffect(() => () => void (!busy && editor.set({ exportProgress: null })), []);

  return (
    <Modal
      title="Export MP4"
      onClose={() => !busy && editor.set({ dialog: null, exportProgress: null })}
      foot={
        busy ? (
          <button className="btn" onClick={cancelExport}>
            Cancel
          </button>
        ) : (
          <>
            <button className="btn" onClick={() => editor.set({ dialog: null, exportProgress: null })}>
              Close
            </button>
            <button className="btn primary" disabled={end - start <= 0} onClick={() => runExport(editor.get().project, { start, end, scale, crf, fileName })}>
              <Icon name="export" size={13} /> Render
            </button>
          </>
        )
      }
    >
      <div className="form-row">
        <label>File name</label>
        <input className="input" value={fileName} onChange={(e) => setFileName(e.target.value)} disabled={!!busy} />
      </div>
      <div className="form-row">
        <label>Range</label>
        <div className="seg">
          <button className={range === 'all' ? 'on' : ''} onClick={() => setRange('all')}>
            Whole timeline
          </button>
          <button className={range === 'inout' ? 'on' : ''} onClick={() => setRange('inout')} disabled={!hasRange}>
            In / Out
          </button>
        </div>
      </div>
      <div className="form-row">
        <label />
        <span className="hint">
          {timecode(start, fps)} → {timecode(end, fps)} · {(end - start).toFixed(2)}s · {Math.round((end - start) * fps)} frames
        </span>
      </div>
      <div className="form-row">
        <label>Resolution</label>
        <select className="input" value={scale} onChange={(e) => setScale(Number(e.target.value))}>
          <option value={1}>Full — {project.project.width}×{project.project.height}</option>
          <option value={0.75}>75%</option>
          <option value={0.5}>Half</option>
          <option value={0.25}>Quarter (fast preview)</option>
        </select>
      </div>
      <div className="form-row">
        <label>Quality</label>
        <select className="input" value={crf} onChange={(e) => setCrf(Number(e.target.value))}>
          <option value={14}>Very high (larger file)</option>
          <option value={18}>High</option>
          <option value={23}>Medium</option>
          <option value={28}>Low (small file)</option>
        </select>
      </div>
      <div className="form-row">
        <label>Output</label>
        <span className="code">
          projects/{projectName}/renders/ · H.264 + AAC · {W}×{H} @ {fps}fps
        </span>
      </div>
      {progress && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
          <div className="progress">
            <div style={{ width: `${(progress.frame / progress.total) * 100}%` }} />
          </div>
          <div className="hint">
            {progress.status === 'rendering' && (progress.message ? <span style={{ color: 'var(--yellow)' }}>{progress.message}</span> : `Rendering frame ${progress.frame} / ${progress.total}…${progress.speed ? ` ${progress.speed.toFixed(0)} fps, about ${timeLeft((progress.total - progress.frame) / progress.speed)} left` : ''}`)}
            {progress.status === 'preparing' && 'Preparing videos for fast seeking (once per video file)…'}
            {progress.status === 'encoding' && 'Finishing encode and mixing audio…'}
            {progress.status === 'done' && (
              <>
                Done →{' '}
                <a href={`/files/${encodeURIComponent(projectName ?? '')}/${progress.file}`} target="_blank" style={{ color: 'var(--yellow)' }}>
                  {progress.file}
                </a>
              </>
            )}
            {progress.status === 'cancelled' && 'Cancelled.'}
            {progress.status === 'error' && <span style={{ color: '#fca5a5', whiteSpace: 'pre-wrap', userSelect: 'text' }}>{progress.message}</span>}
          </div>
        </div>
      )}
    </Modal>
  );
}

function ProjectsDialog() {
  const [list, setList] = useState<ProjectInfo[] | null>(null);
  const current = useEditor((s) => s.projectName);
  useEffect(() => {
    api.list().then(setList);
  }, []);
  const open = async (name: string) => {
    if (editor.get().dirty) await save();
    await openProject(name);
    editor.set({ dialog: null });
  };
  return (
    <Modal
      title="Open Project"
      foot={
        <button className="btn blue" onClick={() => editor.set({ dialog: 'new' })}>
          <Icon name="plus" size={13} /> New Project
        </button>
      }
    >
      {!list && <div className="hint">Loading…</div>}
      {list && !list.length && <div className="hint">No projects yet.</div>}
      <div className="project-list">
        {list?.map((p) => (
          <div key={p.name} className="project-row" onClick={() => open(p.name)} style={p.name === current ? { borderColor: 'var(--yellow)' } : undefined}>
            <Icon name="file" size={16} />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>{p.name}</div>
              <div className="meta">{p.file}</div>
            </div>
            <div className="meta">{new Date(p.modified).toLocaleString()}</div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

function NameDialog({ mode }: { mode: 'new' | 'saveAs' }) {
  const [name, setName] = useState(mode === 'saveAs' ? `${editor.get().project.project.name} copy` : 'My Video');
  const go = async () => {
    if (!name.trim()) return;
    if (mode === 'new') {
      if (editor.get().dirty) await save();
      const r = await api.create(name.trim());
      await openProject(r.name);
    } else {
      const s = editor.get();
      const text = serializeProject({ ...s.project, project: { ...s.project.project, name: name.trim() } });
      const r = await api.saveAs(s.projectName!, name.trim(), text);
      await openProject(r.name);
    }
    editor.set({ dialog: null });
  };
  return (
    <Modal
      title={mode === 'new' ? 'New Project' : 'Save Project As'}
      foot={
        <>
          <button className="btn" onClick={() => editor.set({ dialog: null })}>
            Cancel
          </button>
          <button className="btn primary" onClick={go}>
            {mode === 'new' ? 'Create' : 'Save copy'}
          </button>
        </>
      }
    >
      <div className="form-row">
        <label>Project name</label>
        <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && go()} />
      </div>
      <div className="hint">
        Creates <code>projects/{name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project'}/</code> with a <code>.banana</code> file, a <code>media/</code> folder
        {mode === 'saveAs' ? ' (media is copied)' : ''} and a <code>renders/</code> folder.
      </div>
    </Modal>
  );
}

function ShortcutsDialog() {
  return (
    <Modal title="Keyboard Shortcuts" wide>
      <div className="shortcuts">
        {SHORTCUTS.map((g) => (
          <div key={g.group} style={{ display: 'contents' }}>
            <h5>{g.group}</h5>
            {g.items.map(([k, v]) => (
              <div className="k" key={k + v}>
                <span>{v}</span>
                <kbd>{k}</kbd>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Modal>
  );
}

function ConflictDialog() {
  const conflict = useEditor((s) => s.conflict)!;
  return (
    <Modal
      title="Project file changed on disk"
      onClose={() => editor.set({ conflict: null })}
      foot={
        <>
          <button
            className="btn"
            onClick={async () => {
              editor.set({ conflict: null });
              await save();
            }}
          >
            Keep mine (overwrite file)
          </button>
          <button className="btn primary" onClick={() => replaceFromDisk(conflict)}>
            Load disk version
          </button>
        </>
      }
    >
      <div>
        The <code>.banana</code> file was changed outside the editor (for example by an AI) while you had unsaved edits.
      </div>
      <div className="hint">Loading the disk version is undoable (Ctrl+Z brings your edits back).</div>
    </Modal>
  );
}

export function Toasts() {
  const toasts = useEditor((s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function DiskErrorBanner() {
  const errors = useEditor((s) => s.diskErrors);
  const file = useEditor((s) => s.projectFile);
  const [dismissed, setDismissed] = useState<typeof errors>(null);
  if (!errors || dismissed === errors) return null;
  return (
    <div className="banner">
      <button className="icon-btn sm" style={{ float: 'right', color: '#fecaca' }} title="Hide (the status dot stays red until the file is fixed)" onClick={() => setDismissed(errors)}>
        <Icon name="close" size={12} />
      </button>
      <h4>⚠ {file} can't be loaded — the editor is keeping the last good version</h4>
      <ul>
        {errors.slice(0, 8).map((e, i) => (
          <li key={i}>
            {e.line ? `line ${e.line}` : ''} {e.path && <b>{e.path}</b>}: {e.message}
          </li>
        ))}
        {errors.length > 8 && <li>…and {errors.length - 8} more</li>}
      </ul>
      <div className="hint">Fix the file and save — it will reload automatically. Autosave is paused so the broken file isn't overwritten.</div>
    </div>
  );
}
