import { useEffect, useRef, useState } from 'react';
import type { LibraryItem } from '../format/schema';
import { MEDIA_ACCEPT } from '../format/mediaTypes';
import { editor, useEditor } from '../state/store';
import { addGenerator, addLibraryItem, generatorTypes, importFiles, removeLibraryItem, type GeneratorKind } from '../state/actions';
import { thumbUrl } from '../state/sync';
import { refreshRequests, saveLibraryItemAsAsset, useRequests } from '../state/assets';
import { AssetRequests } from './AssetRequests';
import { AssetBrowser } from './AssetBrowser';
import { openContextMenu } from './ContextMenu';
import { Icon, type IconName } from './icons';
import { durLabel } from './time';

const GEN_ICON: Record<GeneratorKind, { icon: IconName; color: string }> = {
  text: { icon: 'text', color: '#facc15' },
  shape: { icon: 'shape', color: '#3b82f6' },
  ellipse: { icon: 'shape', color: '#facc15' },
  solid: { icon: 'solid', color: '#8a8a92' },
  adjustment: { icon: 'adjust', color: '#a78bfa' },
};

type LibTab = 'media' | 'assets';

function loadTab(): LibTab {
  try {
    return localStorage.getItem('bv.libTab') === 'assets' ? 'assets' : 'media';
  } catch {
    return 'media';
  }
}

export function LibraryPanel() {
  const [tab, setTabState] = useState<LibTab>(loadTab);
  const [sub, setSub] = useState<'library' | 'requests'>('library');
  const openRequests = useRequests((s) => s.requests.filter((r) => r.status === 'open').length);
  useEffect(() => {
    refreshRequests();
  }, []);
  const setTab = (t: LibTab) => {
    setTabState(t);
    try {
      localStorage.setItem('bv.libTab', t);
    } catch {}
  };
  return (
    <div className="panel">
      <div className="panel-head">
        <div className="tabs lib-tabs">
          <button className={tab === 'media' ? 'on' : ''} onClick={() => setTab('media')} title="This project's media">
            <Icon name="folder" size={12} /> Media Pool
          </button>
          <button className={tab === 'assets' ? 'on' : ''} onClick={() => setTab('assets')} title="Shared asset library, usable in every project">
            <Icon name="image" size={12} /> Assets{openRequests > 0 && <span className="badge req-badge">{openRequests}</span>}
          </button>
        </div>
      </div>
      {tab === 'media' ? (
        <MediaPool />
      ) : (
        <>
          <div className="seg asset-sub">
            <button className={sub === 'library' ? 'on' : ''} onClick={() => setSub('library')}>
              Library
            </button>
            <button className={sub === 'requests' ? 'on' : ''} onClick={() => setSub('requests')} title="Media an AI asked you for">
              Requests{openRequests > 0 && <span className="badge req-badge">{openRequests}</span>}
            </button>
          </div>
          {sub === 'library' ? <AssetBrowser /> : <div className="panel-body"><AssetRequests /></div>}
        </>
      )}
    </div>
  );
}

function MediaPool() {
  const library = useEditor((s) => s.project.library);
  const selectedLibrary = useEditor((s) => s.selectedLibrary);
  const projectName = useEditor((s) => s.projectName);
  const [query, setQuery] = useState('');
  const [over, setOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const q = query.toLowerCase();
  const items = library.filter((l) => !q || l.id.toLowerCase().includes(q) || l.file.toLowerCase().includes(q) || !!l.asset?.includes(q));

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
        e.preventDefault();
        setOver(false);
        importFiles([...e.dataTransfer.files]);
      }}
    >
      <div className="asset-bar">
        <div className="lib-search" style={{ position: 'relative', margin: 0, flex: 1 }}>
          <input className="input" placeholder="Search media…" value={query} onChange={(e) => setQuery(e.target.value)} style={{ paddingLeft: 26 }} />
          <Icon name="search" size={12} style={{ position: 'absolute', left: 8, top: 6, color: 'var(--dim)' }} />
        </div>
        <button className="btn ghost" style={{ height: 26 }} onClick={() => fileRef.current?.click()} disabled={!projectName} title="Import media files">
          <Icon name="upload" size={13} /> Import
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept={MEDIA_ACCEPT}
          style={{ display: 'none' }}
          onChange={(e) => {
            importFiles([...(e.target.files ?? [])]);
            e.target.value = '';
          }}
        />
      </div>
      <div>
        <div className="lib-section">Media · {library.length}</div>
        {library.length === 0 ? (
          <div className="lib-drop" onClick={() => fileRef.current?.click()} style={{ cursor: 'pointer' }}>
            <Icon name="upload" size={22} />
            <div style={{ marginTop: 6, color: 'var(--text-2)' }}>Drop images, video or audio here</div>
            <div style={{ fontSize: 11, marginTop: 2 }}>or click to browse</div>
          </div>
        ) : (
          <div className="lib-grid">
            {items.map((item) => (
              <LibItem key={item.id} item={item} selected={selectedLibrary === item.id} />
            ))}
          </div>
        )}

        <div className="lib-section">Generators</div>
        <div className="gen-grid">
          {generatorTypes.map((g) => (
            <div
              key={g.kind}
              className="gen-item"
              draggable
              title="Drag onto the timeline, or double-click to add at the playhead"
              onDragStart={(e) => {
                e.dataTransfer.setData('application/x-bv-gen', g.kind);
                e.dataTransfer.setData('application/x-bv-kind-video', '1');
                e.dataTransfer.effectAllowed = 'copy';
              }}
              onDoubleClick={() => addGenerator(g.kind)}
            >
              <span className="sw" style={{ color: GEN_ICON[g.kind].color, background: 'var(--bg)' }}>
                <Icon name={GEN_ICON[g.kind].icon} size={13} />
              </span>
              {g.label}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function LibItem({ item, selected }: { item: LibraryItem; selected: boolean }) {
  const [broken, setBroken] = useState(false);
  const kindIcon: IconName = item.kind === 'image' ? 'image' : item.kind === 'video' ? 'video' : 'audio';
  return (
    <div
      className={`lib-item ${selected ? 'selected' : ''}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-bv-lib', item.id);
        e.dataTransfer.setData(`application/x-bv-kind-${item.kind === 'audio' ? 'audio' : 'video'}`, '1');
        if (item.kind === 'video' && item.hasAudio) e.dataTransfer.setData('application/x-bv-has-audio', '1');
        e.dataTransfer.effectAllowed = 'copy';
      }}
      onClick={() => editor.set({ selectedLibrary: item.id, selection: [] })}
      onDoubleClick={() => addLibraryItem(item.id)}
      onContextMenu={(e) =>
        openContextMenu(e, [
          { label: 'Add at playhead', onClick: () => addLibraryItem(item.id) },
          item.asset
            ? { label: `From asset library: ${item.asset}`, disabled: true }
            : { label: 'Save to asset library', onClick: () => saveLibraryItemAsAsset(item.id) },
          { sep: true },
          { label: 'Remove from library', onClick: () => removeLibraryItem(item.id) },
        ])
      }
      title={`${item.id}\n${item.file}${item.asset ? `\nfrom asset: ${item.asset}` : ''}`}
    >
      <div className="lib-thumb">
        {item.kind === 'audio' ? (
          <Icon name="audio" size={26} style={{ color: '#6ee7d2' }} />
        ) : broken ? (
          <Icon name={kindIcon} size={24} style={{ color: 'var(--dim)' }} />
        ) : (
          <img src={thumbUrl(item)} onError={() => setBroken(true)} loading="lazy" />
        )}
        <span className="badge">
          <Icon name={kindIcon} size={9} />
        </span>
        {item.duration !== undefined && <span className="dur">{durLabel(item.duration)}</span>}
      </div>
      <div className="lib-name">{item.id}</div>
    </div>
  );
}
