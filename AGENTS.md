# BananaVinci: the AI editing manual

This is the one document to read before editing a video in BananaVinci. **Read it in full at the start of every
session and keep it in context the whole time you work.** `docs/BANANA_FORMAT.md` is the full property-by-property
reference; this manual tells you when and why to use it.

| Part | What it covers |
|---|---|
| 0 | Working with the user |
| 1 | Editing the files |
| 2 | The style guide: default rules for how videos should look and feel |
| 3 | Getting media (asset library, asset requests, music) |
| 4 | Workflow for "animate what I'm saying" |
| 5 | Running and verifying the editor |
| 6 | Environment gotchas |
| 7 | Current project status: what's done and what's open |
| 8 | The briefing prompt for a new agent |

> **Keep this manual alive.** When the user gives a new editing tip or correction, add it to Part 2 (style guide)
> in plain words, with the reason if they gave one. Don't just follow the tip in that one edit. Keep Part 7 up to
> date as projects move along, so the next agent can pick up where you left off.

---

## Part 0: Working with the user

- Expect requests for both **edits** (changing a `.banana` project) and **editor features** (changing BananaVinci
  itself). If the editor gets in the way of an edit, fix the editor, test it, and say what changed.
- If the user **interrupts with a correction mid-task**, treat it as the new priority. Re-read what they said, then
  adjust the plan; don't argue for the old one.
- **Ask when you're genuinely unsure** about intent, but make sensible defaults on small things.
- **Prefer asking the user for images** (asset requests, Part 3) over browsing for them, unless they say to go find
  some.
- Report results plainly: what changed, what you verified and how, and what's still open. Don't claim you checked
  something with sound or in real time if you only rendered still frames.
- **Every correction the user gives goes into Part 2** (style) or Part 0, in your own words with the reason.

---

## Part 1: Editing the files

BananaVinci is a video editor whose whole project lives in one human-readable YAML file per project:
`projects/<name>/<name>.banana`. **To edit a video, edit that file.** If the editor is open in a browser, it reloads
the file live within about 0.2 s of each save.

1. Read `docs/BANANA_FORMAT.md`. It covers every object type, property, default and unit, plus a cookbook of common
   edits (cutting, trimming, adding titles, moving to markers).
2. Units: times are **seconds**, `x/y` are **pixels from the canvas center** (+y is down), rotation is degrees, and
   video tracks are listed **bottom-to-top** (later tracks draw on top).
3. You can leave out properties (defaults apply) and object ids (they're generated). Never invent property names:
   unknown keys are errors.
4. After every edit, validate:
   ```bash
   npm run check -- projects/<name>/<name>.banana
   ```
   It prints `line N  path: message` for each problem and exits non-zero if the file is invalid. The open editor
   shows the same errors and keeps the last good version until the file is fixed.
5. To animate, replace a number with keyframes: `scale: { keyframes: [ { t: 0, v: 0.6 }, { t: 0.4, v: 1, ease: back } ] }`.
   Here `t` is seconds from the **object's start**, and `ease` shapes the motion *into* that keyframe (`easeOut`,
   `back`, `spring`, `bounce`, `smooth`, `hold`, or `{ type: spring, damping, frequency }` /
   `{ type: bezier, x1, y1, x2, y2 }`). The "Animation" section of the format doc lists which properties are
   animatable, plus recipes.
6. **Edit by speech.** Run `npm run transcribe -- <name>`, then read `projects/<name>/<name>.transcript.yaml`. It
   lists every heard word with **timeline** start/end seconds and the object that plays it, and it is regenerated
   after every change to the .banana file, so re-read it after your edits. Time visuals to **words**, not to rough
   seconds. `--captions` creates subtitle text objects (only when asked). If the CLI fails with a sandbox/process
   error, use the running editor instead: `curl -X POST localhost:5173/api/projects/<name>/transcribe`.
7. Put persistent explanations in an object's `note:` field (for example "pops in on 'babies'"). YAML comments are
   dropped the next time the editor saves.
8. To canonicalise a file (write every property explicitly, in a stable order):
   `npm run normalize -- projects/<name>/<name>.banana`.
9. **Object ids are global across the whole project, including inside groups.** Prefix ids per scene
   (`intro-title`, not `title`), or the check renames duplicates (`shape-9`) and warns.

---

## Part 2: Style guide

These are sensible defaults for explainer-style videos. The user's own preferences always win: when they tell you
how they like things, write it down here.

### Show, don't tell
- **Depict what is said; don't caption it.** If the narration says a baby is "snotty", put snot on the baby and make
  it wiggle, rather than a text label saying "snotty". Text on screen is for things that can't be shown, and even
  then use it sparingly.
- Every visual should **come in on the word it illustrates** (use the transcript's word times). A visual that shows
  up half a second late feels wrong.
- Prefer one clear picture that acts (moves, reacts, changes) over several static pictures.

### Keep it clean
- **Nothing too crazy.** No glow effects, no emoji, no flashy transitions for their own sake.
- **No bars, charts or "stat" graphics unless they show real numbers.** Show "fast" or "a lot" with motion instead.
- **No shake effects unless the moment really calls for it** (an impact, a crash).
- Simple, readable motion: pop-ins with a little overshoot (`back`) and gentle settles (`easeOut`). Keep durations
  short (0.2–0.5 s for entrances).
- Intros and title cards can be livelier. Keep them fast and short, and time the motion to the music's beats.
- Sound effects are welcome but **light**: they sit under the voice and never compete with it (volume around
  0.2–0.5). Use a sound cue once, as a moment, not on every repeat.
- **Listen to (or at least analyse) a supplied sound before using it.** Check its length, envelope and pitch with
  ffmpeg first.

### Recorded motion is the user's performance
- Motion recorded with ● Rec is stored as a `motion` path (dense samples) and played back exactly. **Never simplify,
  smooth or "clean up" a recorded path, and never convert it to keyframes** unless asked. To move it, shift every
  value. To remove it, delete the path entry.
- If the user has an on-screen character or avatar they animate themselves, don't move, resize or cover it unless
  they ask. Keep it on the top track and keep new visuals out of its area.

### Composition
- 1920×1080 unless told otherwise. Keep important things inside the middle ~80%.
- One idea on screen at a time. When the topic changes, clear the old visuals (quick fade or slide out) before or as
  the new ones arrive.
- Reuse the same visual language for parallel ideas. Callbacks read as intentional.
- Screen-like inserts (screen recordings, chat windows) usually look best filling the whole screen (`fit: cover`).

### Techniques that work
- **Keep edits easy to adjust by hand.** Dragging an object in the viewer moves its whole animation, so use few
  keyframes per property. A property that doesn't need to move should be a plain number.
- **Things that must stick to a moving object** (a hat on a head): give them the *same* position keyframes as the
  object, plus a constant offset. Work the offset out from pixel positions in the source image:
  `offset = (feature_px − image_center_px) × scale`.
- **Scaling and rotation pivot on the image's center.** To pop in one part of a sprite sheet, first cut that part into
  its own PNG in `projects/<name>/media/` rather than using `crop`. Otherwise it grows from the wrong point.
- **Growing out of an edge** (a drip): key `scale` and `y` together with the same times and eases, using
  `y = edge_y + (image_height / 2) × scale`. The top stays pinned while it grows.
- **Squash & stretch:** `transform.scaleX` / `scaleY` (default 1). For a hit, key scaleX up and scaleY down for
  ~0.06 s and spring back, moving `y` down with it so the feet stay planted.
- **Rainbow text: give each letter its own colour** (one text object per letter, spaced with `measureText`). A `hue`
  effect left cycling on coloured text turns some colours muddy.
- **When something goes *into* a character**, shrink it and fade it out as it enters.
- **Use a `group` whenever an effect needs many objects** (a screen filling up with blocks, words flying out of a
  pipe). It's one clip on the timeline and holds the sounds too. Generate big groups with a script (seeded random
  positions, staggered starts) and say in the group's `note:` that it was generated. See `group` in the format doc.
- **Lots of sounds at once add up.** Use the group's `volume` to keep a flurry under the voice. Measure instead of
  guessing: mix a stretch with the exporter's `buildAudioGraph` (`server/export.ts`) and compare `volumedetect`
  levels.
- **Watch for stock-photo watermarks** ("dreamstime", "alamy") in supplied images, and tell the user.
- **Background removal can wreck an image.** Look at every cut-out before using it. Diagrams and pictures with a
  plain white background are often better with removal **off**.
- **Verify by rendering frames** at each beat (and close-ups of small details) before reporting done.

---

## Part 3: Getting media

### The asset library (reuse first)
Reusable media (sound effects, logos, memes, overlays) lives in the shared library `assets/assets.yaml` (created the
first time you add something). Find one with `npm run asset -- list <words>`. Then add
`- { id: boom, asset: explosion-sfx }` to the project's `library:` and run `npm run check`, which copies the file into
`media/` and fills in `file`/`kind`/`duration`. See "Asset library" in the format doc.

### Asking the user for media (asset requests)
When the library doesn't have something, **don't guess or invent placeholder art. Request it:**

```bash
npm run asset -- request cartoon-baby --project <name> --remove-background \
  --tags baby,cartoon,cutout --description "Cute cartoon baby, full body, facing the viewer" \
  --note "Pops in when they say 'babies' (0.9 s)" --links https://example.org/a-good-candidate
npm run asset -- request baby-crying-sfx --kind audio --project <name> --description "Short light baby cry (1-2 s)"
npm run asset -- requests          # see what's open / done
npm run asset -- wait --project <name>   # block until they're filled (see below)
```

- **Get told when the user fills a request:** after making requests, run `npm run asset -- wait` **in the
  background** (Claude Code: Bash with `run_in_background`). It prints a line per fill and exits when all are filled
  (`--any`: on the first one), which wakes you up. `--timeout <s>` gives up with exit 3. Don't make throwaway "test"
  requests: they show up as real drop boxes in the editor.
- Each open request appears as a **drop box** in the editor (Assets tab → **Requests**). The user drops, pastes or
  picks a file, and it is added to the library under the requested name.
- `--remove-background` cuts the subject out to a transparent PNG when the image arrives (needs Python with `rembg`).
- Write the `description` so a human can find the right picture fast, and the `note` to say exactly where and how it
  will be used.
- **Don't reference a requested asset in the .banana file until it's done.** Then add `- { id: x, asset: <name> }` to
  `library:` and run `npm run check`.
- Filling a request copies the file into the project too, so the check may copy it again as `<name>_2.*`. Point the
  library entry back at the original file and delete the identical `_2` copy.
- You may also edit `assets/requests.yaml` directly; the editor picks the changes up live.

### Music
- **Don't download copyrighted music from unofficial uploads.** Point the user to an official or royalty-free source.
- Music sits **under** the voice: start around volume 0.15–0.3, with fades in and out.

### Media of your own
To add a file directly, copy it into `projects/<name>/media/` and add a `library:` entry (`id`, `file`, `kind`, plus
`duration` for video/audio, which is needed for trim limits). `ffprobe` gives you the duration. New reusable media
belongs in the asset library: `npm run asset -- add <file> --tags a,b --description "…"`.

---

## Part 4: Workflow for "animate what I'm saying"

1. **Transcribe** (Part 1, step 6) and read the transcript. Write down each beat: the word, its time, and what it
   means.
2. **Plan visuals per beat** following Part 2: a picture or prop that *shows* the idea, entering on its word.
3. **Check the asset library**, then **request** what's missing (Part 3). Tell the user what you requested and why,
   and stop there until the requests are filled, unless they say to go ahead with what exists.
4. **Build** the edit in the .banana file:
   - A video track per layer of visuals.
   - Objects timed to word starts, with `note:` saying which word they belong to.
   - Entrances: scale or position keyframes with `back`/`easeOut`, plus `fadeIn` of about 0.1–0.2 s.
   - Exits: a short fade or slide when the idea ends.
5. **Validate** with `npm run check`, then look at it in the editor (scrub to each beat) or export a draft.
6. **Report** what you did beat by beat, and anything you weren't sure about.

---

## Part 5: Running and verifying the editor

- **Start the server with `npm run dev`** (http://localhost:5173), in a terminal that stays open. Run `npm install`
  first on a fresh copy.
- **Client code** (`src/ui`, `src/engine`, `src/state`) hot-reloads. **Server code** (`server/`), **and anything the
  server imports from `src/format/`**, needs a server restart. If a new API route returns the HTML page instead of
  JSON, the server is running old code. If port 5173 is held by an old server, stop that process first.
- Saving the .banana file live-reloads the open editor. If the user has unsaved edits, they get a conflict dialog,
  so keep your file edits atomic and tell them you made them.
- **The open editor can save over your file edits** (for example while the user records). Build multi-step edits on
  a copy, check it, then swap it in with one write, only if the file hasn't changed in the meantime.
- **Verify visually before reporting.**
  - **Render frames with the editor's own compositor** (the exact renderer used for preview and export). In the
    browser console of an open editor tab: `import('/src/engine/compositor.ts')` and
    `import('/src/engine/mediaCache.ts')`, then call `renderFrame(ctx, project, t, { image: getImage, video: () => null })`
    for each beat.
  - Zoom in on small details.
- **Export** (File → Export) streams frames from the browser tab to ffmpeg. It **pauses when the tab is hidden**,
  because browsers stop decoding video in background tabs. Run it from a visible tab. The browser encodes H.264 with
  the GPU when it can (WebCodecs) and falls back to raw frames + x264 otherwise. Videos are seeked in all-keyframe
  copies in `media/.export-proxies/`; deleting that folder is safe.
- Dev handle in the browser console: `bv.editor` (the store: `bv.editor.get().project`, `.set({...})`),
  `bv.store` (`commit`, `undo`), `bv.playback` and `bv.recorder`.
- `npm test` (vitest) and `npm run typecheck` must stay green after editor changes.

---

## Part 6: Environment gotchas

- Needs **Node 18+** and **ffmpeg/ffprobe** on the PATH. Transcription needs Python with `faster-whisper` (GPU if
  CUDA is available, otherwise CPU). Background removal needs Python with `rembg`.
- In an agent sandbox, `npm run transcribe` can fail when it spawns Python. Use the running server instead:
  `curl -X POST -H "content-type: application/json" -d "{}" localhost:5173/api/projects/<name>/transcribe`,
  then poll `GET /api/projects/<name>/transcripts`.
- If transcription fails, the editor's error is sent over the websocket (`ws://localhost:5173/ws`, message
  `stt-error`). To debug, run the worker by hand: `python scripts/stt_worker.py x.wav x.json --model small.en`,
  using a 16 kHz mono wav made with ffmpeg.
- **Fonts in the canvas use the browser's family names, not the file's.** Test a name with `canvas.measureText` in the
  editor tab: if the width equals the fallback's, the font isn't resolving.
- On Windows: **Bash heredocs containing apostrophes** sometimes fail to parse in an agent shell (write scripts to a
  file and run it), and PowerShell variable names are case-insensitive.

### On this Mac (`~/Desktop/Coding/BananaVinci`)

The README section "Setup on macOS" has the full install steps, env vars and troubleshooting table. What an agent
needs to know:

- **Already set up** (2026-10-28): `node_modules/` installed, `ffmpeg`/`ffprobe` from Homebrew, and a Python 3.11
  venv in `.venv/` with `faster-whisper`, `rembg[cpu]` and Pillow. The Whisper `base` model is already cached.
  Baseline: `npm test` (51 tests) and `npm run typecheck` pass, `npm run check -- projects/demo/demo.banana` is valid.
- **Python is found automatically.** `server/stt.ts` uses `BANANA_PYTHON` if set, else `.venv/bin/python`, else
  `python3`. Don't use the macOS system `python3` (3.9, no whisper/rembg). To run a worker by hand, call
  `.venv/bin/python scripts/stt_worker.py …`, not `python`.
- **Whisper runs on the CPU here** (no CUDA on a Mac). `base` is fast; `small.en` is more accurate but slower and
  downloads ≈ 500 MB the first time.
- **Port 5173 clash.** The user's other Vite projects (e.g. `~/Desktop/Coding/Portfolio`) also use 5173 and bind
  IPv6 `::1`. BananaVinci then still starts without an error, but `localhost:5173` reaches the other app and every
  `/api/...` call returns HTML. Check with `lsof -nP -iTCP:5173 -sTCP:LISTEN`. Don't kill the user's other servers;
  run `PORT=5174 npm run dev` (launch config `bananavinci-5174`) and use `localhost:5174` in every `curl` example in
  this manual instead of 5173.
- **Thumbnails** are only made when media is imported through the editor. Media copied into `media/` by hand has no
  timeline thumbnail until you make one: `ffmpeg -ss 1 -i <file> -frames:v 1 -vf scale=320:-2 media/.thumbs/<file>.jpg`.
- `rembg` downloads its `u2net` model (≈ 170 MB, into `~/.u2net`) the first time background removal runs, so the
  first `--remove-background` fill needs internet and takes longer.
- The folder is a **git repo** (branch `main`, no remote). `.gitignore` skips `node_modules/`, `.venv/`, editor
  caches and `renders/`. Ask before committing, and never push without being asked.

---

## Part 7: Current project status

`projects/demo` is a small sample project. Add a section here for each real project as you work on it: what's built
(with times and which word each visual belongs to), which scripts generated what, and the open items. Keep it
current so the next agent can continue.

---

## Part 8: Briefing prompt for a new agent

Paste this to a new AI agent working on BananaVinci:

> You're helping edit videos in **BananaVinci**, a local video editor. Each project is one readable YAML file
> (`projects/<name>/<name>.banana`) that you edit directly; the open editor reloads it live.
>
> **Before doing anything, read `AGENTS.md` in full and keep it in context the whole session.** It is the editing
> manual: how to edit the files, the style rules, how to get media, the workflow for animating narration, how to run
> and verify the editor, and where each project stands (Part 7). Use `docs/BANANA_FORMAT.md` as the reference for
> properties.
>
> Key rules, in short:
> - Show, don't tell. Visuals enter on the exact word (use the transcript's word times).
> - Request images with `npm run asset -- request …` instead of downloading them, and wait for the user to fill them.
> - Run `npm run check -- <file>` after every edit, and verify by rendering frames before saying it's done.
> - Keep keyframes few, so things can be dragged to adjust them. Never simplify recorded motion paths.
> - When the user corrects you or gives a tip, add it to `AGENTS.md` (Part 2 or Part 0).
>
> Start by making sure the editor is running (`npm install` once, then `npm run dev`, http://localhost:5173), then
> ask what they'd like to do.

---

## Code map (if you change the editor itself)

- `src/format/`:
  - schema (zod, single source of truth), parse and serialize
  - `assets.ts`: asset catalog and **request** schemas, plus search
  - `values.ts`: `valueAt`, easing math and keyframe helpers
  - `recording.ts`: recorded motion paths (sampling, merging takes, reading a path at a time)
  - `transcript.ts`: maps speech-to-text onto the timeline, and builds captions
  - `groups.ts`: walking nested objects, and `playedMedia()`, which flattens the sounds/videos inside groups for
    playback and export
- `src/state/`: zustand store with undo history, pure edit commands (`commands.ts`, unit-tested), and server sync
- `src/engine/`: the canvas compositor (shared by preview and export), playback sync, the exporter, the motion
  recorder and voice recording
- `src/ui/`: React panels (Media Pool, Assets + Requests, Viewer, Inspector, Timeline, Animation, Transcript, menus,
  dialogs)
- `server/`: Express + Vite on one port
  - project files, media import (ffprobe), file watching and ffmpeg export
  - `stt.ts`: speech-to-text
  - `assets.ts`: the shared asset library and asset requests, including background removal via
    `scripts/remove_bg.py`

Tests: `npm test`. Typecheck: `npm run typecheck`.
