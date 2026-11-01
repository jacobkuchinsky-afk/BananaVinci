import { createRoot } from 'react-dom/client';
import './ui/theme.css';
import { App } from './ui/App';
import { api, connect, openProject } from './state/sync';
import { editor } from './state/store';
import * as playback from './engine/playback';
import * as recorder from './engine/recorder';
import * as store from './state/store';
import './state/transcripts';
import { loadBundledFonts } from './engine/fonts';

connect();
loadBundledFonts();

// Debug handle for the browser console: bv.editor.get().project, etc.
if (import.meta.env.DEV) (window as any).bv = { editor, recorder, playback, store };

async function boot() {
  const list = await api.list().catch(() => []);
  let last: string | null = null;
  try {
    last = localStorage.getItem('bv.lastProject');
  } catch {}
  const pick = list.find((p) => p.name === last) ?? list.find((p) => p.name === 'demo') ?? list[0];
  if (pick) await openProject(pick.name);
  else editor.set({ dialog: 'new' });
}

createRoot(document.getElementById('root')!).render(<App />);
boot();

// Flush unsaved edits when the tab closes.
window.addEventListener('beforeunload', (e) => {
  if (editor.get().dirty && !editor.get().autosave) e.preventDefault();
});
