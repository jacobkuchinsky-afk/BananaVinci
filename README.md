# BananaVinci

A video editor that runs in your browser and is built so an AI agent can edit alongside you.

Most editors keep the edit locked inside the app, so an AI can only help through screenshots or plugins.
BananaVinci saves the whole edit as one readable YAML file (`.banana`). An agent like Claude Code or Codex edits
that file directly, and the open editor reloads it within about 0.2 s, so you see every change as it happens and
can keep editing by hand. A validator, a word-timed transcript and an asset-request system give the agent what it
needs to make edits that line up with what's being said.

<!-- TODO: screenshot of the editor -->

## How an AI edits a video

1. **It reads the edit.** `projects/<name>/<name>.banana` describes every track, clip, keyframe and effect in plain
   YAML ([format reference](docs/BANANA_FORMAT.md)).
2. **It reads what's said.** `npm run transcribe` runs Whisper locally and writes `<name>.transcript.yaml`: every
   word with its timeline time and the clip it comes from, regenerated after each edit. Visuals get timed to words,
   not to rough seconds.
3. **It asks for media instead of inventing it.** `npm run asset -- request …` puts a drop box in the editor. You
   drop in the right picture or sound (background removal is optional), and it lands in the asset library.
4. **It checks its work.** `npm run check` validates the file and reports `line N  path: message` for every problem.
   The open editor shows the same errors and keeps the last good version until the file is fixed.

[AGENTS.md](AGENTS.md) is the manual agents read first: how to edit the files, a style guide, the workflow for
"animate what I'm saying", and how to verify a result by rendering frames.

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
  - **Recording:** select an object, press **Rec** (`R`), and drag it in the viewer while the video plays (½× and
    ¼× speeds are available for precision). The motion is stored as a path that plays back exactly in the preview
    and the export.
- **Voice-over recording:** click the microphone button above the timeline, pick a microphone, check the live level
  meter, then hit record. After a 3-2-1 countdown it records while the video plays from the playhead. When you stop
  (Space), the take is saved as `media/voice*.wav` and placed on a free audio track exactly where you started.
- **Transcript and auto-captions:** the Transcript tab, or `npm run transcribe -- <project>`, runs local
  speech-to-text (Whisper, on the GPU when available) with **per-word timestamps**. Click a word to jump to it; the
  current word is highlighted as it plays. **Add captions** makes subtitle text objects. The project also gets an
  `.srt`.
- **Export:** File → Export (Ctrl+E) renders an H.264/AAC MP4 into `projects/<name>/renders/`. Every frame is drawn
  by the same renderer as the preview, so the export matches what you see. The browser encodes with the GPU
  (WebCodecs) when it can and falls back to x264.
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
        transform: { scale: { keyframes: [ { t: 0, v: 0.6 }, { t: 0.4, v: 1, ease: back } ] } }
```

## Run it

Requires Node 18+ and `ffmpeg`/`ffprobe` on your PATH. Transcription needs Python 3.10+ with `faster-whisper`, and
background removal needs `rembg`.

```bash
npm install
npm run dev
```

Then open http://localhost:5173. A demo project (`projects/demo/`) opens the first time.

For transcription and background removal, make a virtual environment in the project folder. The server finds
`.venv` on its own:

```bash
python3 -m venv .venv
.venv/bin/pip install faster-whisper "rembg[cpu]" pillow
```

Models download on first use: Whisper into `~/.cache/huggingface/hub` (`base` ≈ 150 MB, `small.en` ≈ 500 MB), and
`rembg`'s `u2net` (≈ 170 MB) into `~/.u2net`. Without CUDA, Whisper runs on the CPU.

### Environment variables

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `5173` | port for the editor (server + Vite on one port) |
| `BANANA_PYTHON` | `.venv/bin/python`, else `python3` | Python used for transcription and background removal |
| `BANANA_ASSETS_DIR` | `./assets` | where the shared asset library lives |
| `HF_HOME` | `~/.cache/huggingface` | Hugging Face cache (Whisper models) |

### Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Transcript tab says faster-whisper is not installed | `.venv` is missing or broken: rerun the `pip install` line, then restart `npm run dev` |
| Background removal fails | `rembg` is missing from `.venv`. The first run also downloads `u2net`, so it needs internet |
| `localhost:5173` opens a different app, or `/api/...` returns HTML | another server holds the port: `lsof -nP -iTCP:5173 -sTCP:LISTEN`, then run `PORT=5174 npm run dev` |
| A video has no thumbnail on the timeline | thumbnails are made on import. For files copied in by hand: `ffmpeg -ss 1 -i media/x.mp4 -frames:v 1 -vf scale=320:-2 media/.thumbs/x.mp4.jpg` |
| New `/api` route returns HTML | the server runs old code: stop and rerun `npm run dev` (server code does not hot-reload) |
| Export stalls | export pauses when the browser tab is hidden; keep the tab visible |

## Commands

| command | |
|---|---|
| `npm run dev` | start the editor |
| `npm run check -- <file.banana>` | validate a project file (for AI or CI) |
| `npm run normalize -- <file.banana>` | rewrite a file in canonical form |
| `npm run transcribe -- <project>` | word-timed transcript of a project's audio |
| `npm run asset -- list [words]` | search the asset library (also `add`, `link`, `request`, `wait`, `rename`, `tag`…; run with no args for help) |
| `npm test` | unit tests (format round-trip, edit commands, animation, transcripts, assets) |
| `npm run typecheck` | TypeScript check |

## Layout

```
BananaVinci/
├─ AGENTS.md              AI editing manual (read first); CLAUDE.md imports it
├─ docs/BANANA_FORMAT.md  full .banana property reference + cookbook
├─ projects/<name>/       one folder per video (only demo/ is in the repo)
│  ├─ <name>.banana       the whole edit, as YAML
│  ├─ media/              project media (+ .thumbs/, .export-proxies/ caches)
│  └─ renders/            exported MP4s
├─ assets/                shared asset library (created on first use)
├─ server/                Express + Vite on one port: project files, media import, ffmpeg export, STT, assets
├─ src/                   editor: format/ (zod schema), state/ (store + undo), engine/ (compositor, export), ui/
├─ scripts/               CLI tools (check, normalize, asset, transcribe) + Python workers
└─ tests/                 vitest unit tests
```
