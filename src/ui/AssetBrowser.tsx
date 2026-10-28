// "Assets" tab of the left panel: the shared asset library (assets/assets.yaml), usable from every project.
import { useEffect, useMemo, useRef, useState } from 'react';
import { searchAssets } from '../format/assets';
import { MEDIA_ACCEPT } from '../format/mediaTypes';
import {
  addAssetPaths,
  assetFileUrl,
  ensureAssetInProject,
  placeAsset,
  refreshAssets,
  removeAsset,
  unlinkFolder,
  updateAsset,
  uploadAssets,
  useAssets,
  type LibraryAsset,
} from '../state/assets';
import { toast, useEditor } from '../state/store';
import { openContextMenu } from './ContextMenu';
import { Modal } from './Dialogs';
import { Icon, type IconName } from './icons';
import { durLabel } from './time';

type KindFilter = 'all' | LibraryAsset['kind'];
const KINDS: { kind: KindFilter; label: string }[] = [
  { kind: 'all', label: 'All' },
  { kind: 'image', label: 'Images' },
  { kind: 'video', label: 'Video' },
  { kind: 'audio', label: 'Audio' },
];

// one shared element so only one preview plays at a time
const preview = typeof Audio !== 'undefined' ? new Audio() : null;

export function AssetBrowser() {
  const { assets, folders, loaded, error } = useAssets();
  const hasProject = !!useEditor((s) => s.projectName);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<KindFilter>('all');
  const [tag, setTag] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [pathDialog, setPathDialog] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!loaded) refreshAssets();
    if (!preview) return;
    const stop = () => setPlaying(null);
    preview.addEventListener('ended', stop);
    return () => {
      preview.removeEventListener('ended', stop);
      preview.pause();
    };
  }, []);

  const topTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of assets) for (const t of a.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 16).map(([t]) => t);
  }, [assets]);

  const shown = searchAssets(
    assets.filter((a) => (kind === 'all' || a.kind === kind) && (!tag || a.tags.includes(tag))),
    query,
  );
  const sel = assets.find((a) => a.name === selected) ?? null;

  const togglePreview = (a: LibraryAsset) => {
    if (!preview) return;
    if (playing === a.name) {
      preview.pause();
      setPlaying(null);
    } else {
      preview.src = assetFileUrl(a);
      preview.currentTime = 0;
      preview.play().catch(() => setPlaying(null));
      setPlaying(a.name);
    }
  };

  return (
    <div
      className={`panel-body ${over ? 'drop-over' : ''}`}
      onDragOver={(e) => {
        if (![...e.dataTransfer.types].includes('Files')) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setOver(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setOver(false);
        uploadAssets([...e.dataTransfer.files]);
      }}
    >
      <div className="asset-bar">
        <div className="lib-search" style={{ position: 'relative', margin: 0, flex: 1 }}>
          <input className="input" placeholder="Search name, tag, description…" value={query} onChange={(e) => setQuery(e.target.value)} style={{ paddingLeft: 26 }} />
          <Icon name="search" size={12} style={{ position: 'absolute', left: 8, top: 6, color: 'var(--dim)' }} />
        </div>
        <button className="icon-btn" title="Add files to the asset library (copied in)" onClick={() => fileRef.current?.click()}>
          <Icon name="plus" size={14} />
        </button>
        <button className="icon-btn" title="Add or link a folder / file path from this computer" onClick={() => setPathDialog(true)}>
          <Icon name="folder" size={14} />
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept={MEDIA_ACCEPT}
          style={{ display: 'none' }}
          onChange={(e) => {
            uploadAssets([...(e.target.files ?? [])]);
            e.target.value = '';
          }}
        />
      </div>

      <div className="chip-row">
        {KINDS.map((k) => (
          <button key={k.kind} className={`chip ${kind === k.kind ? 'on' : ''}`} onClick={() => setKind(k.kind)}>
            {k.label}
          </button>
        ))}
      </div>
      {topTags.length > 0 && (
        <div className="chip-row tags">
          {topTags.map((t) => (
            <button key={t} className={`chip tag ${tag === t ? 'on' : ''}`} onClick={() => setTag(tag === t ? null : t)}>
              #{t}
            </button>
          ))}
        </div>
      )}

      <div className="lib-section">
        Asset library · {shown.length === assets.length ? assets.length : `${shown.length} of ${assets.length}`}
      </div>
      {error ? (
        <div className="hint" style={{ padding: '4px 10px', color: 'var(--red)', whiteSpace: 'pre-wrap' }}>
          {error}
        </div>
      ) : assets.length === 0 && loaded ? (
        <div className="lib-drop" onClick={() => fileRef.current?.click()} style={{ cursor: 'pointer' }}>
          <Icon name="upload" size={22} />
          <div style={{ marginTop: 6, color: 'var(--text-2)' }}>Drop files here to start your asset library</div>
          <div style={{ fontSize: 11, marginTop: 2 }}>or use the folder button to link a folder</div>
        </div>
      ) : (
        <div className="lib-grid">
          {shown.map((a) => (
            <AssetItem
              key={a.name}
              asset={a}
              selected={selected === a.name}
              playing={playing === a.name}
              hasProject={hasProject}
              onSelect={() => setSelected(a.name)}
              onPreview={() => togglePreview(a)}
            />
          ))}
        </div>
      )}

      {sel && <AssetDetails key={sel.name} asset={sel} hasProject={hasProject} onRenamed={setSelected} onClose={() => setSelected(null)} />}

      {folders.length > 0 && (
        <>
          <div className="lib-section">Linked folders</div>
          {folders.map((f) => (
            <div key={f.path} className="linked-folder" title={f.path}>
              <Icon name="folder" size={12} />
              <span className="path">{f.path}</span>
              <button className="icon-btn sm" title="Unlink this folder" onClick={() => confirm(`Unlink ${f.path}?\n\nIts files stay where they are.`) && unlinkFolder(f.path)}>
                <Icon name="close" size={11} />
              </button>
            </div>
          ))}
        </>
      )}

      <div className="hint" style={{ padding: '10px 10px 14px' }}>
        Shared by every project. Drag onto the timeline or double-click to use. In a .banana file, write <code>{'{ id: boom, asset: explosion-sfx }'}</code> in{' '}
        <code>library</code>.
      </div>

      {pathDialog && <AddPathDialog onClose={() => setPathDialog(false)} />}
    </div>
  );
}

function AssetItem({
  asset: a,
  selected,
  playing,
  hasProject,
  onSelect,
  onPreview,
}: {
  asset: LibraryAsset;
  selected: boolean;
  playing: boolean;
  hasProject: boolean;
  onSelect: () => void;
  onPreview: () => void;
}) {
  const [broken, setBroken] = useState(false);
  const kindIcon: IconName = a.kind === 'image' ? 'image' : a.kind === 'video' ? 'video' : 'audio';
  return (
    <div
      className={`lib-item ${selected ? 'selected' : ''} ${a.missing ? 'missing' : ''}`}
      draggable={hasProject && !a.missing}
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-bv-asset', a.name);
        e.dataTransfer.setData(`application/x-bv-kind-${a.kind === 'audio' ? 'audio' : 'video'}`, '1');
        if (a.kind === 'video' && a.hasAudio) e.dataTransfer.setData('application/x-bv-has-audio', '1');
        e.dataTransfer.effectAllowed = 'copy';
      }}
      onClick={onSelect}
      onDoubleClick={() => hasProject && placeAsset(a.name)}
      onContextMenu={(e) =>
        openContextMenu(e, [
          { label: 'Add at playhead', disabled: !hasProject || a.missing, onClick: () => placeAsset(a.name) },
          {
            label: 'Add to Media Pool only',
            disabled: !hasProject || a.missing,
            onClick: async () => {
              const id = await ensureAssetInProject(a.name);
              if (id) toast(`"${a.name}" is in the Media Pool as ${id}`, 'success');
            },
          },
          { sep: true },
          { label: 'Copy name', onClick: () => navigator.clipboard?.writeText(a.name).then(() => toast(`Copied "${a.name}"`)) },
          { label: 'Remove from asset library', onClick: () => removeAsset(a.name) },
        ])
      }
      title={`${a.name}${a.description ? `\n${a.description}` : ''}${a.tags.length ? `\n#${a.tags.join(' #')}` : ''}${a.missing ? '\n(file missing)' : ''}`}
    >
      <div className="lib-thumb">
        {a.kind === 'audio' ? (
          <button
            className={`asset-play ${playing ? 'on' : ''}`}
            title={playing ? 'Stop preview' : 'Preview'}
            onClick={(e) => {
              e.stopPropagation();
              onPreview();
            }}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <Icon name={playing ? 'stop' : 'play'} size={14} />
          </button>
        ) : broken || a.missing ? (
          <Icon name={kindIcon} size={24} style={{ color: 'var(--dim)' }} />
        ) : (
          <img src={assetFileUrl(a, true)} onError={() => setBroken(true)} loading="lazy" />
        )}
        <span className="badge">
          <Icon name={kindIcon} size={9} />
        </span>
        {a.duration !== undefined && <span className="dur">{durLabel(a.duration)}</span>}
      </div>
      <div className="lib-name">{a.name}</div>
    </div>
  );
}

function AssetDetails({ asset: a, hasProject, onRenamed, onClose }: { asset: LibraryAsset; hasProject: boolean; onRenamed: (name: string) => void; onClose: () => void }) {
  const [name, setName] = useState(a.name);
  const [tags, setTags] = useState(a.tags.join(', '));
  const [description, setDescription] = useState(a.description);

  const commitName = async () => {
    if (name.trim() === a.name || !name.trim()) return setName(a.name);
    const r = await updateAsset(a.name, { name });
    if (r) onRenamed(r.name);
    else setName(a.name);
  };
  const commitTags = () => tags !== a.tags.join(', ') && updateAsset(a.name, { tags });
  const commitDescription = () => description !== a.description && updateAsset(a.name, { description });
  const enter = (e: React.KeyboardEvent<HTMLInputElement>) => e.key === 'Enter' && (e.target as HTMLInputElement).blur();

  return (
    <div className="asset-details">
      <div className="row" style={{ marginBottom: 6 }}>
        <span className="type-chip">{a.kind}</span>
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>
          {a.width ? `${a.width}×${a.height}` : ''} {a.duration !== undefined ? durLabel(a.duration) : ''}
        </span>
        <span className="spacer" style={{ flex: 1 }} />
        <button className="icon-btn sm" onClick={onClose} title="Close">
          <Icon name="close" size={11} />
        </button>
      </div>
      <label>Name</label>
      <input className="input mono" value={name} onChange={(e) => setName(e.target.value)} onBlur={commitName} onKeyDown={enter} spellCheck={false} />
      <label>Tags</label>
      <input className="input" value={tags} placeholder="sfx, boom, meme" onChange={(e) => setTags(e.target.value)} onBlur={commitTags} onKeyDown={enter} />
      <label>Description</label>
      <textarea className="input" rows={2} value={description} placeholder="What is it? When is it useful?" onChange={(e) => setDescription(e.target.value)} onBlur={commitDescription} />
      <div className="file" title={a.file}>
        {a.missing && <b style={{ color: 'var(--red)' }}>missing · </b>}
        {a.file}
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', gap: 6, marginTop: 6 }}>
        <button className="btn" onClick={() => removeAsset(a.name)} title="Remove from the asset library">
          <Icon name="trash" size={13} />
        </button>
        <button className="btn primary" disabled={!hasProject || a.missing} onClick={() => placeAsset(a.name)}>
          <Icon name="plus" size={13} /> Add at playhead
        </button>
      </div>
    </div>
  );
}

function AddPathDialog({ onClose }: { onClose: () => void }) {
  const [path, setPath] = useState('');
  const [mode, setMode] = useState<'copy' | 'link'>('link');
  const [tags, setTags] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const paths = path
      .split('\n')
      .map((p) => p.trim().replace(/^"(.*)"$/, '$1'))
      .filter(Boolean);
    if (!paths.length) return;
    setBusy(true);
    const r = await addAssetPaths(paths, { link: mode === 'link', tags: tags.split(',') });
    setBusy(false);
    if (r) onClose();
  };
  return (
    <Modal
      title="Add to the asset library"
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !path.trim()} onClick={submit}>
            {busy ? 'Adding…' : mode === 'link' ? 'Link' : 'Copy in'}
          </button>
        </>
      }
    >
      <div className="form-col">
        <label>File or folder path (one per line)</label>
        <textarea
          className="input mono"
          rows={3}
          autoFocus
          placeholder={'C:\\Users\\you\\Downloads\\Editing Assets'}
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && submit()}
        />
        <div className="hint">Tip: in File Explorer, Shift + right-click a folder → "Copy as path", then paste here.</div>
        <label className="radio">
          <input type="radio" checked={mode === 'link'} onChange={() => setMode('link')} />
          <span>
            <b>Link</b>: files stay where they are. New files you drop into a linked folder join the library automatically.
          </span>
        </label>
        <label className="radio">
          <input type="radio" checked={mode === 'copy'} onChange={() => setMode('copy')} />
          <span>
            <b>Copy in</b>: copy the files into BananaVinci's <code>assets/</code> folder (a one-time import).
          </span>
        </label>
        <label>Tags for everything added (optional)</label>
        <input className="input" placeholder="sfx, memes" value={tags} onChange={(e) => setTags(e.target.value)} />
      </div>
    </Modal>
  );
}
