# 🍌 BananaVinci

A video editor that runs in your browser. It has a media pool, viewer, inspector and multi-track timeline, and saves
to a plain, readable YAML project format (`.banana`) that people **and AI** can edit directly. The editor reloads
live when the file changes on disk.

## 🤖 For AI agents: read AGENTS.md first

**If you are an AI agent (Claude Code, Codex, Cursor, etc.), read [AGENTS.md](AGENTS.md) in full before doing
anything else, and keep it in your context for the entire session.** It is the editing manual: how to edit
`.banana` files, the style rules, how to get media, how to run and verify the editor, and where each project stands.
Re-read it if your context gets summarised or reset. When the user gives you a tip or correction, write it into
AGENTS.md so the next agent knows it too.

(Claude Code loads `CLAUDE.md` automatically, and that file pulls in AGENTS.md, so it stays in context there.)

## Run it

Requires Node 18+ and `ffmpeg`/`ffprobe` on your PATH (on Windows: `winget install OpenJS.NodeJS.LTS` and
`winget install Gyan.FFmpeg`, then open a new terminal). Transcription also needs Python with `faster-whisper`
(`pip install faster-whisper`).

```bash
npm install
npm run dev
```

Then open http://localhost:5173. A demo project (`projects/demo/`) opens the first time.

## Setup on macOS (how this copy is set up)

This copy lives in `~/Desktop/Coding/BananaVinci` and was set up from `BananaVinci-Share.zip` on 2026-10-28. The
share zip also contained a nested `BananaVinci.zip`; it was a byte-for-byte duplicate of the same files (zipped on
Windows), so it was not kept.

### What is already installed

| Piece | Where it comes from | Used for |
|---|---|---|
| Node 22 + npm | `/usr/local/bin/node` | the server, the CLI scripts, tests |
| `ffmpeg` / `ffprobe` | Homebrew (`/opt/homebrew/bin`) | probing media, thumbnails, conversion, export |
| `node_modules/` | `npm install` (from `package-lock.json`) | JS dependencies |
| `.venv/` (Python 3.11) | `uv venv` + `uv pip install` | `faster-whisper` (transcription) and `rembg[cpu]` + Pillow (background removal) |
| Whisper `base` model | Hugging Face cache, `~/.cache/huggingface/hub` | default transcription model, already downloaded |

The server picks its Python in this order: the `BANANA_PYTHON` env var, then **this project's `.venv`** (added for
this setup, see `server/stt.ts`), then plain `python3`. So you never need to activate the venv yourself.

### Fresh setup from scratch (another Mac, or after deleting `node_modules`/`.venv`)

```bash
brew install node ffmpeg uv
cd ~/Desktop/Coding/BananaVinci
npm install
uv venv --python 3.11 .venv
uv pip install --python .venv/bin/python faster-whisper "rembg[cpu]" pillow
npm test && npm run typecheck && npm run check -- projects/demo/demo.banana
npm run dev
```

Without `uv`: `python3 -m venv .venv && .venv/bin/pip install faster-whisper "rembg[cpu]" pillow` (needs Python
3.10+; the macOS system Python 3.9 is too old for current `rembg`).

First-use downloads (automatic, one time): Whisper models go to `~/.cache/huggingface/hub` (`base` ≈ 150 MB,
`small.en` ≈ 500 MB); the background-removal model `u2net` (≈ 170 MB) goes to `~/.u2net` the first time an asset
request with `--remove-background` is filled. On a Mac, Whisper runs on the **CPU** (there is no CUDA); the worker
falls back to CPU on its own.

### Environment variables

There is no `.env` file; the server reads these from the shell environment.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `5173` | port for the editor (server + Vite on one port) |
| `BANANA_PYTHON` | `.venv/bin/python`, else `python3` | Python used for transcription and background removal |
| `BANANA_ASSETS_DIR` | `./assets` | where the shared asset library lives |
| `HF_HOME` | `~/.cache/huggingface` | Hugging Face cache (Whisper models) |

### Port 5173 is shared with other projects

Other Vite projects on this machine (for example `~/Desktop/Coding/Portfolio`) also default to port 5173. If one is
already running, BananaVinci still starts and prints "running at http://localhost:5173", but your browser's
`localhost` goes to the *other* app (it listens on IPv6 `::1`, BananaVinci on all interfaces). Symptom: a different
site opens, or `/api/...` returns an HTML page. Check and fix:

```bash
lsof -nP -iTCP:5173 -sTCP:LISTEN
```

```bash
PORT=5174 npm run dev
```

Then open http://localhost:5174. (`.claude/launch.json` has a `bananavinci-5174` config for this.)

### Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Transcript tab says faster-whisper is not installed | `.venv` is missing or broken: rerun the two `uv` lines above, then restart `npm run dev` |
| Background removal fails | same: `rembg` lives in `.venv`. The first run also downloads `u2net`, so it needs internet |
| A video has no thumbnail on the timeline | thumbnails are made on import. For files copied in by hand: `ffmpeg -ss 1 -i media/x.mp4 -frames:v 1 -vf scale=320:-2 media/.thumbs/x.mp4.jpg` |
| New `/api` route returns HTML | the server runs old code: stop and rerun `npm run dev` (server code does not hot-reload) |
| Export stalls | export pauses when the browser tab is hidden; keep the tab visible |
| `npm audit` warnings on install | they come from the pinned versions in `package-lock.json` (e.g. multer 1.x). The editor only listens locally; upgrade deliberately, not with `--force` |
| `leaked semaphore` warning after transcription | harmless Python shutdown noise on macOS |

### Folder layout

```
BananaVinci/
├─ AGENTS.md            AI editing manual (read first); CLAUDE.md just imports it
├─ docs/BANANA_FORMAT.md  full .banana property reference + cookbook
├─ projects/<name>/     one folder per video
│  ├─ <name>.banana     the whole edit, as YAML
│  ├─ media/            project media (+ .thumbs/, .export-proxies/ caches)
│  ├─ renders/          exported MP4s
│  └─ transcripts/, <name>.transcript.yaml, .srt   (after transcribing)
├─ assets/              shared asset library (created on first use)
├─ server/              Express + Vite server, ffmpeg export, STT, asset library
├─ src/                 editor (format/, state/, engine/, ui/)
├─ scripts/             CLI tools (check, normalize, asset, transcribe) + Python workers
├─ tests/               vitest unit tests
└─ .venv/               Python env for whisper/rembg (not shared, not committed)
```

The folder is a git repository (branch `main`, no remote yet). `.gitignore` skips `node_modules/`, `.venv/`, the
editor's caches (`.thumbs/`, `.export-proxies/`, …) and `renders/`, so only source, docs and project files are
tracked.

## What's in it

- **Media Pool:** drag images, video or audio onto it (or click Import). Files are copied into the project's
  `media/` folder. **Generators:** Text, Rectangle, Ellipse, Solid Color, Adjustment Layer.
- **Asset library:** the **Assets** tab holds reusable media shared by every project (`assets/assets.yaml`). Every
  asset has a name, tags and a description, so you (or an AI) can search for it and drop it in. Add files by
  dropping them on the tab, link whole folders so new files show up on their own, or right-click project media →
  *Save to asset library*. Using an asset copies it into the project, so projects stay self-contained.
- **Viewer:** live canvas preview. Drag objects to move them, use the corner handles to scale, and the top knob to
  rotate. It has transport controls and loop.
- **Inspector:** per-object properties grouped by type: Timing, Transform, Cropping, Audio, Text, Text Style, Shape,
  Fades, Effects and Note. Drag a label to scrub its value. Each field has a reset arrow.
- **Timeline:** video and audio tracks with hide, mute, solo and lock. Thumbnails and waveforms are drawn on the
  clips. Markers, in/out range, snapping and zoom.
- **Tools:** Select/Trim (A), Blade/Cut (B), Slip (Y), split at playhead (Ctrl+B), ripple delete (Shift+Del), close
  gap, copy/cut/paste/duplicate, Alt+drag to duplicate, nudge (, .), enable/disable (D), undo/redo. Dropping a clip
  onto another overwrites it, like DaVinci. Press **?** in the app for every shortcut.
- **Animation:**
  - **Keyframes:** click ◆ next to any Inspector property to animate it. The **Graph Editor** tab lets you drag
    keyframes on value curves and shape each move with an ease: overshoot, spring (damping + frequency), bounce,
    smooth, hold, or a custom bezier. A live preview ball shows how it feels.
  - **Recording:** select an object, press **● Rec** (`R`), and drag it in the viewer while the video plays (½× and
    ¼× speeds are available for precision). The motion becomes smoothed, editable keyframes that play back in the
    preview and the export.
- **Voice-over recording:** click 🎙 above the timeline, pick a microphone, check the live level meter, then hit the
  red button. After a 3-2-1 countdown it records while the video plays from the playhead. When you stop (Space), the
  take is saved as `media/voice*.wav` and placed on a free audio track exactly where you started.
- **Transcript and auto-captions:** the Transcript tab, or `npm run transcribe -- <project>`, runs local
  speech-to-text (Whisper, on the GPU when available) with **per-word timestamps**. Click a word to jump to it; the
  current word is highlighted as it plays. **Add captions** makes subtitle text objects. The project gets an
  always-current `<name>.transcript.yaml` (every word in timeline seconds) so an AI editing the file can line its
  cuts up with the real audio, plus an `.srt`.
- **Asset requests:** an AI asks for media it needs (`npm run asset -- request …`). Each request becomes a drop box
  under **Assets → Requests**; drop or paste the file and it joins the asset library, optionally with its background
  removed automatically.
- **Export:** File → Export (Ctrl+E) renders an H.264/AAC MP4 into `projects/<name>/renders/`. Every frame is drawn
  by the same renderer as the preview, so the export matches what you see.
- **Live sync and autosave:** edits save about 1 s after you stop. External edits to the `.banana` file reload
  instantly. If the file is broken, the editor shows the line and error and won't overwrite it.

## The file format

See [docs/BANANA_FORMAT.md](docs/BANANA_FORMAT.md). A short taste:

```yaml
tracks:
  - id: V1
    kind: video
    objects:
      - { id: banana-1, type: image, source: banana, start: 0, duration: 5 }
  - id: V2
    kind: video
    objects:
      - type: text
        text: BANANA TIME
        start: 1
        duration: 3
        color: "#FACC15"
```

## Commands

| command | |
|---|---|
| `npm run dev` | start the editor |
| `npm run check -- <file.banana>` | validate a project file (for AI or CI) |
| `npm run normalize -- <file.banana>` | rewrite a file in canonical form |
| `npm run asset -- list [words]` | search the asset library (also `add`, `link`, `use`, `rename`, `tag`…; run with no args for help) |
| `npm test` | unit tests (format round-trip, edit commands) |
| `npm run typecheck` | TypeScript check |
