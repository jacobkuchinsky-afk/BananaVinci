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
| 7 | Project status and local notes |
| 8 | The briefing prompt for a new agent |

> **If `AGENTS.local.md` exists, read it too.** It holds notes that only apply to one machine and one person's own
> projects (setup quirks, personal preferences, project status). It is not committed.

> **Keep this manual alive.** When the user gives a new editing tip or correction, add it to Part 2 (style guide)
> in plain words, with the reason if they gave one. Don't just follow the tip in that one edit. Keep project status
> (Part 7) up to date as projects move along, so the next agent can pick up where you left off.

---

## Part 0: Working with the user

- Expect requests for both **edits** (changing a `.banana` project) and **editor features** (changing BananaVinci
  itself). If the editor gets in the way of an edit, fix the editor, test it, and say what changed.
- If the user **interrupts with a correction mid-task**, treat it as the new priority. Re-read what they said, then
  adjust the plan; don't argue for the old one.
- **Read README.md and this file in full before the first edit**, not just skim them. The user noticed when an
  agent skipped them (it invented sound effects instead of requesting them, and left the project in the wrong aspect).
- **Any media you don't have (sound effects, graphics, photos, fonts) goes through an asset request** (Part 3).
  Don't synthesize, draw or generate a stand-in, even a "clean" one: the user has their own and wants those used.
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
- **Phone takes are usually short-form vertical (1080×1920).** Check the aspect first: if the takes are portrait,
  set the project to 1080×1920. Landscape files with a
  portrait picture inside (old exports) go in with `fit: cover` plus a few pixels of `crop` on the sides to hide
  the bars' edges.
- **Overlay images: use `fit: none`.** The default `fit: contain` first scales an image to fill the canvas, so
  `scale` then isn't relative to the image's real pixels. With `fit: none`, `scale: 1` = the PNG's own size.
- **Audio must be loud and clean.** Phone takes come in very quiet (around −31 to −39 LUFS) and `volume` tops out at
  2 (+6 dB), which isn't enough. Make a cleaned copy of each take instead: video copied, audio through
  `highpass=f=80,afftdn=nr=14:nf=-44:tn=1,acompressor=threshold=-30dB:ratio=3:attack=8:release=120:knee=4`, then
  a gain that brings the used part to −16 LUFS and `alimiter=limit=0.84`. Point the library entry at the copy, keep
  the original next to it, and fine-tune clip-to-clip with `volume` (measure with `ebur128`).
- **Transitions between talking-head clips:** keep hard cuts on silences; for a jump cut within the same take,
  punch in (`scale` ≈ 1.15) on one side so it reads as a zoom cut. A clip from somewhere else (a callback to an old
  video) crossfades in and out over ~0.15 s: put it on the track above and let the clips below run under its fades.
  Close dead air after an insert by rippling the later clips.
- **Cut every pause at a clip boundary.** When one clip's speech ends and the next one's starts, leave only
  ~0.1–0.15 s of silence (trim the tail of one and the head of the next, then ripple). Find the real speech edges
  in the waveform (`astats` RMS in 50 ms steps), not from Whisper: after a pause Whisper starts the first word
  early, sometimes by 0.3–0.5 s, and it can end a word before the sound does (which clips it).
- **Shorts get word-highlight captions for the whole video**, at the bottom (around y = +380 on 1080×1920, above
  the YouTube UI): **DynaPuff**, bold, white with a thick black outline, 2–4 words per phrase broken where you'd
  naturally pause, and the word being said turns yellow (`#FFD23F`) with a tiny scale-up. Fix Whisper's obvious
  mishearings in the caption text. Measure word widths in the editor tab (`measureText`), not offline.
- **Little asides/warnings** ("I also didn't have very good tools") are small text in a corner, in a nice font
  (DynaPuff), **no background box**, a slight tilt at most, with a pop sound. Don't overdo it.
- **Screenshots of comments go in slightly askew, alternating directions** (about −3° then +3°), each with a ding.
- With captions at the bottom, put other overlays (photos, comments) in the empty space above the head.
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
When the library doesn't have something, **don't guess or invent placeholder art (or sounds). Request it:**

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
- **After an export, check its timing**, not just one frame: `ffprobe` the video stream's `duration` and
  `avg_frame_rate` (should match the project). The GPU path pipes raw H.264 to ffmpeg, which has no timestamps, and
  ffmpeg's guesses can collapse after ~1.7 s (players show 2 s, then black). `server/export.ts` now stamps frames
  by count (`setts` bitstream filter). An old broken render can be repaired without re-encoding:
  `ffmpeg -i bad.mp4 -map 0 -bsf:v "setts=ts=N/(30*TB):duration=1/(30*TB)" -c copy fixed.mp4`.
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
- **Bundled fonts:** fonts the canvas can't find on the system go in `public/fonts/` and get a line in
  `BUNDLED_FONTS` (`src/engine/fonts.ts`), which registers them for preview and export. DynaPuff is there (OFL,
  from Google Fonts). Use it as `font: DynaPuff, Inter, Arial, sans-serif`.
- **Fonts in the canvas use the browser's family names, not the file's.** Test a name with `canvas.measureText` in the
  editor tab: if the width equals the fallback's, the font isn't resolving.
- On Windows: **Bash heredocs containing apostrophes** sometimes fail to parse in an agent shell (write scripts to a
  file and run it), and PowerShell variable names are case-insensitive.

- **Python is found automatically.** `server/stt.ts` uses `BANANA_PYTHON` if set, else the project's
  `.venv/bin/python`, else `python3`. To run a worker by hand, call the venv's Python, not the system one.
- **Whisper runs on the CPU without CUDA** (always on a Mac). `base` is fast; `small.en` is more accurate but
  slower and downloads ≈ 500 MB the first time.
- **Port 5173 clash.** Another Vite app on 5173 that binds IPv6 `::1` takes over `localhost:5173`: BananaVinci
  starts without an error, but every `/api/...` call returns HTML. Check with `lsof -nP -iTCP:5173 -sTCP:LISTEN`,
  don't kill the other server, and run `PORT=5174 npm run dev` instead (then use 5174 in every `curl` example).
- **Thumbnails** are only made when media is imported through the editor. Media copied into `media/` by hand has no
  timeline thumbnail until you make one: `ffmpeg -ss 1 -i <file> -frames:v 1 -vf scale=320:-2 media/.thumbs/<file>.jpg`.
- `rembg` downloads its `u2net` model (≈ 170 MB, into `~/.u2net`) the first time background removal runs, so the
  first `--remove-background` fill needs internet and takes longer.

---

## Part 7: Project status and local notes

`projects/demo` is a small sample project, and the only one in the repo: `.gitignore` keeps every other project,
the `assets/` library and `AGENTS.local.md` local.

Keep a section in `AGENTS.local.md` for each real project as you work on it: what's built (with times and which
word each visual belongs to), which scripts generated what, and the open items. Keep it current so the next agent
can continue. Machine-specific setup notes and personal preferences go there too.

---

## Part 8: Briefing prompt for a new agent

Paste this to a new AI agent working on BananaVinci:

> You're helping edit videos in **BananaVinci**, a local video editor. Each project is one readable YAML file
> (`projects/<name>/<name>.banana`) that you edit directly; the open editor reloads it live.
>
> **Before doing anything, read `AGENTS.md` in full and keep it in context the whole session.** It is the editing
> manual: how to edit the files, the style rules, how to get media, the workflow for animating narration, how to run
> and verify the editor. If `AGENTS.local.md` exists, read it too: it says where each project stands. Use
> `docs/BANANA_FORMAT.md` as the reference for properties.
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
