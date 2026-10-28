// BananaVinci dev server: Vite (frontend) + project/media API + live file sync + export, on one port.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { WebSocketServer, type WebSocket } from 'ws';
import { createServer as createVite } from 'vite';
import { PROJECTS_DIR, ROOT, createProject, listProjects, projectChangeHooks, projectDir, readProject, saveProjectAs, watchProjectMedia, watchProjects, writeProject } from './projects';
import { cachedModels, checkEngine, defaultModel, loadSourceTranscripts, scheduleTranscriptRefresh, transcribeProject, transcriptFiles } from './stt';
import { parseProject } from '../src/format/parse';
import { SUPPORTED, describeMedia, kindOf, safeFileName, saveRecording } from './media';
import { ExportJob, exportProxies } from './export';
import {
  ASSETS_DIR,
  CatalogError,
  addAssets,
  assetPath,
  assetThumbPath,
  copyAssetIntoProject,
  findAsset,
  listAssets,
  loadCatalog,
  removeAsset,
  resolveAssetRefs,
  saveProjectMediaAsAsset,
  unlinkFolder,
  updateAsset,
  watchAssets,
  watchRequests,
  loadRequests,
  addRequest,
  updateRequest,
  removeRequest,
  fulfilRequest,
  fulfilRequestFromUrl,
} from './assets';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT ?? 5173);
const app = express();
const server = http.createServer(app);

// ---------------------------------------------------------------- API
const api = express.Router();
api.use(express.json({ limit: '50mb' }));

api.get('/projects', (_req, res) => res.json(listProjects()));

api.post('/projects', (req, res) => {
  const name = createProject(String(req.body?.name || 'Untitled'));
  res.json({ name });
});

api.get('/projects/:name', (req, res) => {
  const p = readProject(req.params.name);
  if (!p) return res.status(404).json({ error: 'project not found' });
  res.json(p);
});

api.put('/projects/:name', express.text({ type: '*/*', limit: '50mb' }), (req, res) => {
  const file = writeProject(req.params.name, String(req.body));
  res.json({ ok: true, file });
});

api.post('/projects/:name/save-as', (req, res) => {
  const name = saveProjectAs(req.params.name, String(req.body?.name || 'Copy'), String(req.body?.text || ''));
  res.json({ name });
});

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = path.join(projectDir(req.params.name), 'media');
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      // browsers send latin1-decoded names; recover UTF-8
      const original = Buffer.from(file.originalname, 'latin1').toString('utf8');
      cb(null, safeFileName(path.join(projectDir(req.params.name), 'media'), original));
    },
  }),
  fileFilter: (_req, file, cb) => cb(null, !!kindOf(file.originalname)),
  limits: { fileSize: 4 * 1024 * 1024 * 1024 },
});

api.post('/projects/:name/media', upload.array('files'), async (req, res) => {
  const files = (req.files as Express.Multer.File[]) ?? [];
  const results = await Promise.allSettled(files.map((f) => describeMedia(projectDir(req.params.name), f.filename)));
  const items = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  const errors = results.flatMap((r) => (r.status === 'rejected' ? [String(r.reason?.message ?? r.reason)] : []));
  res.json({ items, errors, supported: SUPPORTED });
});

api.post('/projects/:name/record', express.raw({ type: () => true, limit: '2gb' }), async (req, res) => {
  try {
    const item = await saveRecording(projectDir(req.params.name), req.body as Buffer);
    res.json({ item });
  } catch (e) {
    res.status(500).send(`Could not save the recording: ${e}`);
  }
});

// ---- speech to text
api.get('/stt/status', async (_req, res) => {
  res.json({ engine: await checkEngine(), models: cachedModels(), defaultModel: defaultModel() });
});

api.get('/projects/:name/transcripts', (req, res) => {
  const p = readProject(req.params.name);
  const parsed = p ? parseProject(p.text) : null;
  if (!parsed || !parsed.ok) return res.json({ sources: {} });
  res.json({ sources: loadSourceTranscripts(req.params.name, parsed.project), files: transcriptFiles(req.params.name) });
});

const sttJobs = new Set<string>();
api.post('/projects/:name/transcribe', (req, res) => {
  const name = req.params.name;
  if (sttJobs.has(name)) return res.status(409).send('A transcription is already running for this project');
  sttJobs.add(name);
  res.json({ started: true });
  transcribeProject(name, { model: req.body?.model, force: !!req.body?.force }, (p) => broadcast({ type: 'stt-progress', project: name, ...p }))
    .then((ids) => broadcast({ type: 'stt-done', project: name, transcribed: ids }))
    .catch((e) => broadcast({ type: 'stt-error', project: name, message: String(e?.message ?? e) }))
    .finally(() => sttJobs.delete(name));
});

api.get('/projects/:name/renders', (req, res) => {
  const dir = path.join(projectDir(req.params.name), 'renders');
  if (!fs.existsSync(dir)) return res.json([]);
  res.json(fs.readdirSync(dir).filter((f) => f.endsWith('.mp4')));
});

// all-keyframe copies of the given video files, so the export can seek them fast
api.post('/projects/:name/export-proxies', async (req, res) => {
  const files: string[] = Array.isArray(req.body?.files) ? req.body.files.map(String) : [];
  res.json({ proxies: await exportProxies(req.params.name, files) });
});

// ---- shared asset library (assets/assets.yaml)
/** Run an async handler; errors become a 400 with a readable message. */
const handle =
  (fn: (req: express.Request, res: express.Response) => Promise<unknown>) =>
  (req: express.Request, res: express.Response) =>
    fn(req, res).catch((e) => res.status(e instanceof CatalogError ? 500 : 400).send(String(e?.message ?? e)));

api.get('/assets', (_req, res) => {
  try {
    res.json(listAssets());
  } catch (e) {
    res.status(500).send(String((e as Error).message));
  }
});

const assetUpload = multer({
  storage: multer.diskStorage({
    // one folder per file so the original name (which becomes the asset name) is kept
    destination: (_req, _file, cb) => {
      const dir = path.join(ASSETS_DIR, '.incoming', crypto.randomUUID());
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => cb(null, path.basename(Buffer.from(file.originalname, 'latin1').toString('utf8'))),
  }),
  fileFilter: (_req, file, cb) => cb(null, !!kindOf(file.originalname)),
  limits: { fileSize: 4 * 1024 * 1024 * 1024 },
});

api.post(
  '/assets/upload',
  assetUpload.array('files'),
  handle(async (req, res) => {
    const files = (req.files as Express.Multer.File[]) ?? [];
    try {
      const tags = String(req.body?.tags ?? '').split(',');
      res.json(await addAssets(files.map((f) => f.path), { move: true, tags }));
    } finally {
      for (const f of files) fs.rmSync(path.dirname(f.path), { recursive: true, force: true });
    }
  }),
);

// add files or folders from anywhere on disk; `link: true` keeps them in place and watches folders for new files
api.post(
  '/assets/add-paths',
  handle(async (req, res) => {
    const paths: string[] = (Array.isArray(req.body?.paths) ? req.body.paths : [req.body?.path]).filter(Boolean).map(String);
    if (!paths.length) throw new Error('give a file or folder path');
    res.json(await addAssets(paths, { link: !!req.body?.link, tags: req.body?.tags ?? [], name: req.body?.name, description: req.body?.description }));
  }),
);

api.post(
  '/assets/unlink',
  handle(async (req, res) => res.json({ removed: await unlinkFolder(String(req.body?.path ?? '')) })),
);

api.patch(
  '/assets/:name',
  handle(async (req, res) => res.json({ asset: await updateAsset(req.params.name, req.body ?? {}) })),
);

api.delete(
  '/assets/:name',
  handle(async (req, res) => res.json({ asset: await removeAsset(req.params.name) })),
);

// ---- asset requests (assets/requests.yaml): wanted media, filled in by dropping a file on its box
api.get('/asset-requests', (_req, res) => {
  try {
    res.json({ requests: loadRequests() });
  } catch (e) {
    res.status(500).send(String((e as Error).message));
  }
});
api.post('/asset-requests', handle(async (req, res) => res.json({ request: await addRequest(req.body ?? {}) })));
api.patch('/asset-requests/:name', handle(async (req, res) => res.json({ request: await updateRequest(req.params.name, req.body ?? {}) })));
api.delete('/asset-requests/:name', handle(async (req, res) => res.json({ left: await removeRequest(req.params.name) })));
api.post(
  '/asset-requests/:name/fulfil',
  assetUpload.single('file'),
  handle(async (req, res) => {
    const file = req.file as Express.Multer.File | undefined;
    try {
      if (file) return res.json(await fulfilRequest(req.params.name, file.path, { move: true }));
      const url = String(req.body?.url ?? '');
      if (!url) throw new Error('drop or paste a file (or an image link)');
      res.json(await fulfilRequestFromUrl(req.params.name, url));
    } finally {
      if (file) fs.rmSync(path.dirname(file.path), { recursive: true, force: true });
    }
  }),
);

// copy an asset into a project's media/ folder; the client adds the library entry
api.post(
  '/projects/:name/use-asset',
  handle(async (req, res) => res.json({ item: await copyAssetIntoProject(projectDir(req.params.name), String(req.body?.asset ?? '')) })),
);

// the other way: put one of a project's media files into the asset library
api.post(
  '/projects/:name/save-asset',
  handle(async (req, res) =>
    res.json({ asset: await saveProjectMediaAsAsset(projectDir(req.params.name), String(req.body?.file ?? ''), { name: req.body?.name, tags: req.body?.tags, description: req.body?.description }) }),
  ),
);

app.use('/api', api);

// asset files and thumbnails, by asset name (linked assets can live anywhere on disk)
app.get('/asset-files/:name', (req, res) => {
  try {
    const a = findAsset(loadCatalog(), req.params.name);
    if (!a) return res.status(404).end();
    const thumb = req.query.thumb !== undefined && a.kind === 'video' ? assetThumbPath(a) : null;
    res.sendFile(thumb && fs.existsSync(thumb) ? thumb : assetPath(a), { dotfiles: 'allow' }, (e) => e && !res.headersSent && res.status(404).end());
  } catch {
    res.status(500).end();
  }
});
app.use('/files', express.static(PROJECTS_DIR, { dotfiles: 'allow', fallthrough: false }));
app.use('/docs', express.static(path.join(ROOT, 'docs')));

// ---------------------------------------------------------------- Live sync + export over WebSocket
const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024 });
const clients = new Set<WebSocket>();

server.on('upgrade', (req, socket, head) => {
  if (req.url?.startsWith('/ws')) wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  clients.add(ws);
  let job: ExportJob | null = null;
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      job?.frame(data as Buffer);
      return;
    }
    const msg = JSON.parse(String(data));
    if (msg.type === 'export-start') {
      job?.cancel();
      try {
        job = new ExportJob(msg.projectName, msg.project, msg.settings, ws);
        ws.send(JSON.stringify({ type: 'export-ready' }));
      } catch (e) {
        ws.send(JSON.stringify({ type: 'export-error', message: String(e) }));
      }
    } else if (msg.type === 'export-end') {
      job?.finish();
      job = null;
    } else if (msg.type === 'export-cancel') {
      job?.cancel();
      job = null;
    }
  });
  ws.on('close', () => {
    clients.delete(ws);
    job?.cancel();
  });
});

function broadcast(msg: object) {
  const data = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === c.OPEN) c.send(data);
}

// keep <name>.transcript.yaml in step with the edit
projectChangeHooks.add(scheduleTranscriptRefresh);

watchProjectMedia((name, file) => broadcast({ type: 'media-changed', project: name, file }));

watchProjects(
  (name, text) => {
    console.log(`[sync] ${name}.banana changed on disk → pushing to editor`);
    const msg = JSON.stringify({ type: 'file-changed', project: name, text });
    for (const c of clients) if (c.readyState === c.OPEN) c.send(msg);
  },
  // `- { id: boom, asset: explosion-sfx }` written by hand or by AI: copy the asset in before the editor sees it
  async (file) => {
    const r = await resolveAssetRefs(file);
    for (const x of r.resolved) console.log(`[assets] ${path.basename(file)}: copied asset "${x.asset}" → ${x.file}`);
    for (const e of r.errors) console.log(`[assets] ${path.basename(file)}: ${e}`);
    return r.resolved.length > 0;
  },
);

watchAssets(() => broadcast({ type: 'assets-changed' }));
watchRequests(() => broadcast({ type: 'asset-requests-changed' }));

// ---------------------------------------------------------------- Frontend
const vite = await createVite({ server: { middlewareMode: true, hmr: { server } }, appType: 'spa' });
app.use(vite.middlewares);

server.listen(PORT, () => {
  console.log(`\n  🍌 BananaVinci running at http://localhost:${PORT}\n  Projects folder: ${PROJECTS_DIR}\n  Asset library:   ${ASSETS_DIR}\n`);
});
