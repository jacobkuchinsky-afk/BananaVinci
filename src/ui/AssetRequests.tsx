// Assets → Requests: media an AI (or you) asked for. Each open request is a drop box; drop, paste or pick a file
// and it joins the asset library under the requested name.
import { useEffect, useRef, useState } from 'react';
import type { AssetRequest } from '../format/assets';
import { MEDIA_ACCEPT } from '../format/mediaTypes';
import { assetFileUrl, deleteRequest, fulfilRequest, refreshRequests, setRequestOption, useAssets, useRequests } from '../state/assets';
import { Icon, type IconName } from './icons';
import { Modal } from './Dialogs';
import { toast } from '../state/store';

const KIND_ICON: Record<AssetRequest['kind'], IconName> = { image: 'image', audio: 'audio', video: 'video' };

/** Pull a usable file or URL out of a drop / paste. */
function extract(dt: DataTransfer): File | string | null {
  const file = [...dt.files][0] ?? [...dt.items].find((i) => i.kind === 'file')?.getAsFile();
  if (file) return file;
  const uri = dt
    .getData('text/uri-list')
    .split(/\r?\n/)
    .find((l) => l && !l.startsWith('#'));
  const html = dt.getData('text/html');
  const img = html && /<img[^>]+src=["']([^"']+)["']/i.exec(html)?.[1];
  const text = dt.getData('text/plain').trim();
  return img || uri || (/^(https?:|data:)/i.test(text) ? text : null);
}

// ----------------------------------------------------------------------------- pasting
// Ctrl+V goes to the box under the mouse (or the one clicked last), so you can copy an image anywhere
// ("Copy image" in a browser, a screenshot, a file in Explorer) and paste it without downloading it first.
let pasteTarget: string | null = null;
const targetListeners = new Set<() => void>();
const setPasteTarget = (name: string | null) => {
  pasteTarget = name;
  targetListeners.forEach((l) => l());
};
/** True while a request box is ready to receive a paste (the timeline's Ctrl+V steps aside). */
export const hasPasteTarget = () => pasteTarget !== null && !!document.querySelector('.req-box');

if (typeof document !== 'undefined') {
  document.addEventListener('paste', (e) => {
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
    if (!pasteTarget || !e.clipboardData) return;
    const x = extract(e.clipboardData);
    if (!x) return;
    e.preventDefault();
    fulfilRequest(pasteTarget, x);
  });
}

/** Read the clipboard directly (the Paste button). */
async function pasteFromClipboard(name: string) {
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const type = item.types.find((t) => /^(image|audio|video)\//.test(t));
      if (type) {
        const blob = await item.getType(type);
        return fulfilRequest(name, new File([blob], `${name}.${type.split('/')[1].replace('jpeg', 'jpg').replace('svg+xml', 'svg')}`, { type }));
      }
    }
    const text = (await navigator.clipboard.readText()).trim();
    if (/^(https?:|data:)/i.test(text)) return fulfilRequest(name, text);
    toast('The clipboard has no image. Right-click an image and choose "Copy image", then try again.', 'error');
  } catch {
    toast('The browser blocked clipboard access. Hover the box and press Ctrl+V instead.', 'error');
  }
}

export function AssetRequests({ big = false }: { big?: boolean }) {
  const { requests, loaded, error, busy } = useRequests();
  const [showDone, setShowDone] = useState(false);
  const [bigView, setBigView] = useState(false);
  useEffect(() => {
    if (!loaded) refreshRequests();
  }, []);
  const open = requests.filter((r) => r.status === 'open');
  const done = requests.filter((r) => r.status === 'done');

  return (
    <div className={`requests ${big ? 'big' : ''}`}>
      <div className="req-head">
        <div className="hint">
          Media an AI asked for. <b>Copy</b> any image (right-click → Copy image, or a screenshot), <b>hover</b> a box and press <b>Ctrl+V</b>. Or drop a file or an image from another tab onto it.
        </div>
        {!big && open.length > 0 && (
          <button className="btn" onClick={() => setBigView(true)} title="Show all requests as a large grid">
            <Icon name="fit" size={12} /> Open big view
          </button>
        )}
      </div>
      {bigView && (
        <Modal title={`Asset requests · ${open.length} open`} wide onClose={() => setBigView(false)}>
          <AssetRequests big />
        </Modal>
      )}
      {error && <div className="voice-error" style={{ margin: 10, whiteSpace: 'pre-wrap' }}>{error}</div>}
      {loaded && !open.length && !error && (
        <div className="lib-drop" style={{ cursor: 'default' }}>
          <Icon name="image" size={22} />
          <div style={{ marginTop: 6, color: 'var(--text-2)' }}>No open requests</div>
          <div style={{ fontSize: 11, marginTop: 2 }}>
            An AI adds them with <code>npm run asset -- request &lt;name&gt;</code> or in <code>assets/requests.yaml</code>
          </div>
        </div>
      )}
      <div className="req-grid">
        {open.map((r) => (
          <RequestBox key={r.name} r={r} busy={!!busy[r.name]} />
        ))}
      </div>
      {done.length > 0 && (
        <>
          <button className="lib-section req-done-toggle" onClick={() => setShowDone(!showDone)}>
            <Icon name="chevron" size={11} style={{ transform: showDone ? '' : 'rotate(-90deg)' }} /> Fulfilled · {done.length}
          </button>
          {showDone && (
            <div className="req-grid">
              {done.map((r) => (
                <DoneBox key={r.name} r={r} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function RequestBox({ r, busy }: { r: AssetRequest; busy: boolean }) {
  const [over, setOver] = useState(false);
  const [target, setTarget] = useState(pasteTarget === r.name);
  const hovered = useRef(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const l = () => setTarget(pasteTarget === r.name);
    targetListeners.add(l);
    return () => {
      targetListeners.delete(l);
      if (pasteTarget === r.name) setPasteTarget(null);
    };
  }, [r.name]);
  const take = (x: File | string | null) => {
    if (!x) return;
    fulfilRequest(r.name, x);
  };
  return (
    <div
      ref={boxRef}
      className={`req-box ${over ? 'over' : ''} ${busy ? 'busy' : ''} ${target ? 'target' : ''}`}
      tabIndex={0}
      title="Drop a file here, or hover and paste (Ctrl+V)"
      onPointerEnter={() => {
        hovered.current = true;
        setPasteTarget(r.name);
      }}
      onPointerLeave={() => {
        hovered.current = false;
        if (pasteTarget === r.name && document.activeElement !== boxRef.current) setPasteTarget(null);
      }}
      onFocus={() => setPasteTarget(r.name)}
      onBlur={() => {
        if (pasteTarget === r.name && !hovered.current) setPasteTarget(null);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        take(extract(e.dataTransfer));
      }}
    >
      <div className="req-drop">
        {busy ? (
          <>
            <div className="spinner" />
            <span>{r.removeBackground ? 'Removing background…' : 'Adding…'}</span>
          </>
        ) : (
          <>
            <Icon name={KIND_ICON[r.kind]} size={22} />
            <span>{over ? 'Drop it!' : target ? 'Ctrl+V to paste here' : `Drop or paste ${r.kind === 'image' ? 'an image' : r.kind === 'audio' ? 'an audio file' : 'a video file'}`}</span>
          </>
        )}
      </div>
      <div className="req-name">{r.name}</div>
      {r.description && <div className="req-desc">{r.description}</div>}
      {r.note && <div className="req-note">{r.note}</div>}
      <div className="req-meta">
        {r.project && <span className="req-chip">{r.project}</span>}
        {r.links.map((l, i) => (
          <a key={i} href={l} target="_blank" rel="noreferrer" className="req-link" onClick={(e) => e.stopPropagation()} title={l}>
            link {r.links.length > 1 ? i + 1 : ''}
          </a>
        ))}
      </div>
      <div className="req-actions" onClick={(e) => e.stopPropagation()}>
        {r.kind === 'image' && (
          <label className="req-check" title="Cut the subject out to a transparent PNG when the image arrives">
            <input type="checkbox" checked={r.removeBackground} onChange={(e) => setRequestOption(r.name, { removeBackground: e.target.checked })} /> Remove background
          </label>
        )}
        <span className="spacer" />
        <button className="icon-btn sm req-paste" title="Paste from the clipboard" onClick={() => pasteFromClipboard(r.name)}>
          Paste
        </button>
        <button className="icon-btn sm" title="Choose a file" onClick={() => fileRef.current?.click()}>
          <Icon name="folder" size={12} />
        </button>
        <button className="icon-btn sm" title="Remove this request" onClick={() => confirm(`Remove the request "${r.name}"?`) && deleteRequest(r.name)}>
          <Icon name="trash" size={12} />
        </button>
        <input
          ref={fileRef}
          type="file"
          accept={MEDIA_ACCEPT}
          style={{ display: 'none' }}
          onChange={(e) => {
            take(e.target.files?.[0] ?? null);
            e.target.value = '';
          }}
        />
      </div>
    </div>
  );
}

function DoneBox({ r }: { r: AssetRequest }) {
  const asset = useAssets((s) => s.assets.find((a) => a.name === r.asset));
  return (
    <div className="req-box done">
      <div className="req-drop">
        {asset && asset.kind !== 'audio' ? <img src={assetFileUrl(asset, true)} /> : <Icon name={KIND_ICON[r.kind]} size={22} />}
      </div>
      <div className="req-name">✓ {r.asset ?? r.name}</div>
      <div className="req-desc">{r.description}</div>
      <div className="req-actions">
        <span className="spacer" />
        <button className="icon-btn sm" title="Remove this request (the asset stays in the library)" onClick={() => deleteRequest(r.name)}>
          <Icon name="close" size={12} />
        </button>
      </div>
    </div>
  );
}
