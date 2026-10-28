# The `.banana` project format (version 1)

> AI agents: read **`AGENTS.md`** first. It is the editing manual and style guide. This file is the reference.

A BananaVinci project is one **YAML** file with the `.banana` extension, inside a project folder:

```
projects/<name>/
  <name>.banana      ← the whole edit: settings, media list, timeline
  media/             ← imported files (referenced by relative path)
  renders/           ← exported MP4s
```

The file is meant to be edited by hand or by an AI. While the editor is open it **watches the file**: save it and the
editor reloads within about 0.2 s. You can undo that reload with Ctrl+Z inside the editor.

Validate a file without opening the editor:

```bash
npm run check -- projects/demo/demo.banana
```

---

## Units and conventions

| Thing | Unit |
|---|---|
| `start`, `duration`, `in`, `fadeIn`, `fadeOut`, marker `time` | **seconds** (decimals fine: `2.5`) |
| `transform.x`, `transform.y` | **pixels from the canvas center**, `+x` = right, `+y` = down |
| `transform.rotation` | degrees, clockwise |
| `transform.scale` | multiplier (`1` = fitted size, `2` = twice as big) |
| `transform.scaleX`, `transform.scaleY` | optional extra stretch on top of `scale` (default `1`, left out of the file unless used). `scaleX: 1.15, scaleY: 0.85` squashes |
| `transform.opacity` | `0`..`1` |
| `volume` | `0`..`2` (`1` = original loudness) |
| colors | hex strings in quotes: `"#ffcc00"` or with alpha `"#ffcc0080"` |
| `speed` | multiplier (`2` = twice as fast) |

- **Animation:** most numeric properties can be keyframed. Instead of a number, write
  `{ keyframes: [ { t, v, ease } ] }`. See [Animation](#animation-keyframes).
- **Layering:** video tracks are listed **bottom to top**. The first video track (`V1`) is the background and later
  tracks draw on top of it. Inside one track, objects that overlap in time draw in list order.
- **Lenient reading:** any property you leave out gets its default. A missing object `id` gets generated
  (`<source>-<n>` or `<type>-<n>`). A duplicate `id` is renamed and a warning is shown.
- **Strict checking:** unknown property names (typos like `fontsize`), wrong types, a `source` that isn't in the
  library, and objects on the wrong kind of track are **errors**. The editor shows them with a line number and keeps
  the last good version. It never overwrites a broken file.
- **Saving from the editor** writes every property explicitly in a fixed order (`id, type, source, start, duration, …`)
  and rounds numbers to 4 decimals. **YAML comments you add are not preserved** when the editor saves. Use the `note:`
  property on any object for text that must survive.

---

## Top-level structure

```yaml
format: 1               # format version (always 1 for now)

project:                # canvas / output settings
  name: My Video
  width: 1920           # pixels
  height: 1080
  fps: 30
  background: "#000000" # color behind everything

library: []             # media files (see below)
markers: []             # named points in time
tracks: []              # the timeline
```

### `library` items

```yaml
library:
  - id: banana            # what objects use in `source:`
    file: media/banana.png
    kind: image           # image | video | audio
    width: 1080           # optional (filled in on import)
    height: 1080
  - id: interview
    file: media/interview.mp4
    kind: video
    width: 1920
    height: 1080
    duration: 42.5        # seconds, video/audio
    hasAudio: true        # video files only
    asset: interview-raw  # optional: the asset library entry this file was copied from
```

To add media by hand, copy the file into the project's `media/` folder and add an entry. Importing through the
editor (drag files onto the Media Pool) does both steps and fills in `width`/`height`/`duration` automatically.

**File formats.** Preview and export both decode media in the browser, so a library file must be one it can play:
images `png jpg gif webp avif bmp svg ico`, audio `mp3 wav ogg m4a aac flac opus`, video `mp4 mov m4v webm mkv`
with H.264, HEVC, VP8/VP9 or AV1 inside. Importing through the editor or the asset library also accepts
other formats and converts them with ffmpeg: `avi wmv flv mpg ts mts ogv mxf…`, ProRes or 10-bit H.264 video, or PCM
audio inside a `.mov` all become an H.264/AAC `.mp4`; `tif heic psd…` become `.png`; `aiff wma amr…` become `.m4a`.
When adding a file by hand, convert it yourself first, e.g. `ffmpeg -i in.avi -c:v libx264 -pix_fmt yuv420p -c:a aac out.mp4`.

**From the shared asset library** (see [Asset library](#asset-library)) you only need the id and the asset name:

```yaml
library:
  - { id: boom, asset: explosion-sfx }
```

The running editor (or `npm run check`) copies the file into `media/` and fills in `file`, `kind` and size.

### `markers`

```yaml
markers:
  - { time: 4, name: drop, color: yellow }   # color: yellow | blue | red | green | purple | white
```

### `tracks`

```yaml
tracks:
  - id: V1           # unique; convention V1, V2… for video and A1, A2… for audio
    kind: video      # video | audio
    name: Background
    hidden: false    # video only: hide from the picture
    locked: false    # can't be edited in the timeline UI
    objects: []
  - id: A1
    kind: audio
    name: Music
    muted: false     # audio only
    solo: false      # audio only: if any track is solo'd, only solo'd tracks play
    locked: false
    objects: []
```

`video`, `image`, `text`, `shape` and `adjustment` objects go on **video** tracks. `audio` objects go on **audio**
tracks.

---

## Objects

Every object has these fields:

| property | default | meaning |
|---|---|---|
| `id` | generated | unique name, used to refer to the object |
| `type` | *required* | `video`, `image`, `audio`, `text`, `shape`, `adjustment`, `group` |
| `start` | `0` | when it appears on the timeline (s) |
| `duration` | `5` | how long it stays on the timeline (s). It ends at `start + duration` |
| `enabled` | `true` | `false` keeps it on the timeline but hidden/silent |
| `note` | `""` | free text, kept when the editor saves |

The **visual** types (`video`, `image`, `text`, `shape`) also have:

| property | default | meaning |
|---|---|---|
| `transform` | `{ x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, flipX: false, flipY: false }` | position / size / rotation |
| `fadeIn` / `fadeOut` | `0` | seconds of fade from/to transparent |
| `effects` | `[]` | list of effects (see Effects) |

### `video`

| property | default | meaning |
|---|---|---|
| `source` | *required* | library id |
| `in` | `0` | seconds into the file where this clip starts playing |
| `speed` | `1` | playback speed (0.1–16). The clip shows `duration × speed` seconds of source |
| `volume` | `1` | 0..2 |
| `muted` | `false` | silence the clip's own audio |
| `fit` | `contain` | `contain` (fit inside canvas) · `cover` (fill canvas, crop overflow) · `stretch` · `none` (original pixels) |
| `crop` | `{ left: 0, right: 0, top: 0, bottom: 0 }` | crop in **source pixels** |

A clip that shows source seconds 10–15, starting 2 s into the timeline:

```yaml
- id: interview-1
  type: video
  source: interview
  start: 2
  duration: 5
  in: 10
```

### `image`

`source`, `fit`, `crop`, plus the visual fields.

Animated GIF, WebP and APNG files play their animation from the object's `start` and loop for its whole `duration`.
The animation follows the playhead, so scrubbing and export are frame-exact.

### `audio`

| property | default |
|---|---|
| `source` | *required*. An audio item, or a video item to use only its sound |
| `in` | `0` |
| `speed` | `1` |
| `volume` | `1` |
| `fadeIn` / `fadeOut` | `0` |

### `text`

| property | default | meaning |
|---|---|---|
| `text` | `Title` | use `\n` (or a YAML block `|`) for multiple lines |
| `font` | `Inter, Segoe UI, Arial, sans-serif` | any CSS font-family list |
| `size` | `96` | pixels |
| `color` | `"#ffffff"` | |
| `bold` / `italic` | `true` / `false` | |
| `align` | `center` | `left` · `center` · `right` |
| `lineHeight` | `1.2` | multiple of `size` |
| `letterSpacing` | `0` | pixels |
| `outline` | `{ color: "#000000", width: 0 }` | stroke around the letters |
| `background` | `{ color: "#00000000", padding: 16, radius: 8 }` | box behind the text (transparent by default) |
| `shadow` | `{ color: "#000000aa", blur: 0, x: 0, y: 0 }` | drop shadow |

```yaml
- type: text
  text: |-
    BIG TITLE
    second line
  start: 1
  duration: 3
  size: 140
  color: "#FACC15"
  outline: { color: "#000000", width: 8 }
  transform: { y: -200 }
  fadeIn: 0.3
  fadeOut: 0.3
```

### `shape`

| property | default | meaning |
|---|---|---|
| `shape` | `rect` | `rect` · `ellipse` · `solid` (fills the whole canvas, ignores width/height) |
| `width` / `height` | `400` / `240` | pixels |
| `fill` | `"#3b82f6"` | |
| `stroke` | `"#ffffff"` | |
| `strokeWidth` | `0` | |
| `cornerRadius` | `0` | `rect` only |

### `adjustment`

An adjustment layer applies its `effects` to **everything on the tracks below it** while it is active.

| property | default | meaning |
|---|---|---|
| `opacity` | `1` | how strongly to mix in the effect (0..1) |
| `fadeIn` / `fadeOut` | `0` | |
| `effects` | `[]` | |

```yaml
- type: adjustment
  start: 0
  duration: 10
  effects:
    - { type: saturation, amount: 0 }   # black & white for 10 s
```

### `group`

A group packs many objects (pictures, text, **and sounds**) into **one clip** on a video track. Use it whenever an
effect needs lots of objects (a screen filling up with blocks, words flying out of a pipe, a prop riding on a
character) so the timeline stays clean and the whole thing moves, trims and drags as one.

| property | default | meaning |
|---|---|---|
| `objects` | `[]` | the objects inside. Any type except `adjustment` (groups can nest) |
| `volume` | `1` | multiplies the volume of every sound inside (0..2) |
| `transform`, `motion`, `fadeIn`/`fadeOut`, `effects` | | as for any visual object, applied to everything inside |

- Children's `start` is **seconds from the group's start**, and their `x`/`y` are **relative to the group's
  position** (at the default group position 0, 0 they're the same as normal canvas coordinates). Anything that
  runs past the group's `duration` is cut off.
- List order is drawing order: later children draw on top.
- Sounds inside a group play and export like any audio clip (sound on a video track; `volume` scales them). Each
  sound file is opened once in the export however many times it's used, so hundreds of pops are fine.
- Children are written **one per line with defaults left out**, e.g.
  `- { id: b2, type: image, source: block, start: 1, duration: 2, transform: { x: 50, scale: 0.5 } }`.
- In the editor: select objects → **Ctrl+G** (Edit → Group) to group, **Ctrl+Shift+G** to ungroup (the group's
  position, size, rotation, opacity, volume and effects get baked into the children). Moving, trimming, splitting
  and copying a group keeps everything inside in place on the timeline. The timeline shows a tick per child.

```yaml
- id: lots-of-data
  type: group
  start: 40.42
  duration: 1.43
  volume: 0.13          # 135 pops at once: keep each one quiet
  objects:
    - { id: lot-block-1, type: image, source: block-a, start: 0, duration: 1.43, fit: none, transform: { x: -400, y: 120, scale: { keyframes: [ { t: 0, v: 0 }, { t: 0.16, v: 0.4, ease: back } ] } } }
    - { id: lot-pop-1, type: audio, source: pop-sfx, start: 0, duration: 0.27 }
    # … one picture + one pop per block, generated by a script
```

Generate big groups with a small script (positions, staggered starts) instead of writing them by hand.

### Effects

```yaml
effects:
  - { type: brightness, amount: 1.2, enabled: true }
```

| type | amount | neutral value |
|---|---|---|
| `brightness` | multiplier 0–3 | `1` |
| `contrast` | multiplier 0–3 | `1` |
| `saturation` | multiplier 0–3 (0 = grey) | `1` |
| `hue` | degrees −180..180 | `0` |
| `blur` | pixels | `0` |
| `grayscale` | 0..1 | `0` |
| `invert` | 0..1 | `0` |
| `sepia` | 0..1 | `0` |

Effects apply in list order.

---

## Cookbook (common AI edits)

**Add a title at 3 s for 2 seconds.** Append to the `objects` of a video track above the footage (e.g. `V2`):
```yaml
      - type: text
        text: Hello world
        start: 3
        duration: 2
```

**Cut clip `interview-1` at timeline time 6 s.** Split it into two objects. The second one starts at the cut, and its
`in` moves forward by `(cut − start) × speed`:
```yaml
      - { id: interview-1, type: video, source: interview, start: 2, duration: 4, in: 10 }   # was duration 9
      - { id: interview-2, type: video, source: interview, start: 6, duration: 5, in: 14 }
```

**Shorten a clip from the end.** Reduce `duration`. **Shorten from the front:** add *d* to `start`, subtract *d* from
`duration`, and add `d × speed` to `in`.

**Move something to a marker.** Look up the marker's `time` and set the object's `start` to it.

**Make an image fill the frame and slowly zoom in.** Set `fit: cover` and keyframe the scale:
`scale: { keyframes: [ { t: 0, v: 1 }, { t: 5, v: 1.15, ease: easeInOut } ] }`. See "Animation" below.

**Fade music out at the end.** `fadeOut: 2` on the audio object.

**Lower a video's own sound under music.** `volume: 0.3` on the video object.

**Delete something.** Remove its object entry. To close the gap ("ripple"), subtract its `duration` from the `start`
of every later object on the same track.

After editing, run `npm run check -- <file>` (exit code 0 = valid), or just look at the editor. It shows any error
with a line number.

---

## Animation (keyframes)

Any **animatable** property can be a plain number (static) **or** a keyframe list:

```yaml
transform:
  x:
    keyframes:
      - { t: 0, v: -800 }                                                  # t = seconds from the object's start
      - { t: 0.8, v: 0, ease: { type: spring, damping: 0.35, frequency: 3 } }
  y: 0
  scale:
    keyframes:
      - { t: 0, v: 0.6 }
      - { t: 0.5, v: 1, ease: back }                                       # overshoots, then settles
  rotation: 0
  opacity: 1
```

- `t` is **seconds from the object's `start`**, not timeline time. Keyframes move with the object when you move it.
  Trimming the front edge or splitting the object keeps them in place on the timeline.
- `v` is the value at that moment, in the property's normal unit.
- Before the first keyframe the value holds at the first `v`. After the last keyframe it holds at the last `v`.
- `ease` describes **how the value travels INTO this keyframe** from the previous one. The first keyframe's ease is
  unused. If you leave `ease` out, it is `linear`.

### Animatable properties

| object types | properties |
|---|---|
| video, image, text, shape, group | `transform.x`, `transform.y`, `transform.scale`, `transform.rotation`, `transform.opacity`, and the optional `transform.scaleX` / `transform.scaleY` |
| video, image | `crop.left`, `crop.right`, `crop.top`, `crop.bottom` (animated crop = wipes and reveals) |
| video, audio | `volume` |
| text | `size`, `letterSpacing` |
| shape | `width`, `height` |
| adjustment | `opacity` (the effect mix) |
| any type with effects | `effects[N].amount`, e.g. `effects: [{ type: blur, amount: { keyframes: [...] } }]` |

### Eases

| ease | written as | feel |
|---|---|---|
| linear | `linear` | constant speed |
| ease in / out / in-out | `easeIn`, `easeOut`, `easeInOut` | accelerate, decelerate, or both |
| overshoot | `back` or `{ type: back, overshoot: 1.7 }` | goes past the target and settles back. Bigger number = further |
| spring | `spring` or `{ type: spring, damping: 0.35, frequency: 3 }` | damped spring. `damping` 0..1 (low = wobbly, 1 = no overshoot); `frequency` = wobbles per second. The spring runs over the real time between the two keyframes and always lands exactly on the target |
| bounce | `bounce` | drops onto the value and bounces |
| smooth | `smooth` | a smooth curve through the neighbouring keyframes (recordings use this) |
| hold | `hold` | no motion, then jumps at the keyframe |
| custom bezier | `{ type: bezier, x1: 0.34, y1: 1.56, x2: 0.64, y2: 1 }` | CSS-style cubic bezier. `y` values outside 0..1 give anticipation or overshoot |

### Recorded motion paths (`motion`)

Select an object, press **● Rec** above the viewer (or `R`), and perform while the video plays: **left-drag** moves
it, the **scroll wheel** rotates it, and **right-drag** scales it (anywhere in the viewer). You can also record at
½× or ¼× speed. Every frame of the performance is stored as a **motion path** that the object follows exactly. It is
not turned into keyframes, so nothing is simplified away.

```yaml
- id: banana-1
  type: image
  # …
  transform: { x: -790, y: 160, scale: 0.285, rotation: 0, opacity: 1, flipX: false, flipY: false }
  motion:
    - start: 2.5          # seconds from the object's start
      rate: 60            # samples per second
      x: [ -790, -788.4, -785.1, … ]
      y: [ 160, 158.7, 156.2, … ]
```

- Each channel (`x`, `y`, `scale`, `rotation`) is optional. A take records only what you touched: drag = x/y,
  wheel = rotation, right-drag = scale.
- **While a path plays it overrides that transform channel. After it ends the object holds the path's last value**
  (it stays where you left it). Before the first path starts, the normal `transform` value applies.
- Several takes are fine. Recording over part of an earlier take replaces only that time range (and only the
  channels you used).
- **Dragging the object in the viewer moves its whole path**, and so does nudging with Alt + arrows. Delete a path
  in the Inspector → Animation.
- For AI edits: don't hand-write long paths sample by sample. To shift a recorded motion, add the same amount to
  every value of `x` (or `y`). A path can also be generated programmatically, for smooth organic motion like a
  wobble or an orbit, at `rate` samples per second.

### Animation recipes

**Slide in from the left with a springy landing (0.8 s):**
```yaml
transform:
  x: { keyframes: [ { t: 0, v: -1100 }, { t: 0.8, v: 0, ease: spring } ] }
```
**Squash on a hit (squash & stretch):** key `scaleX` up and `scaleY` down together for a moment, then spring back: `scaleX: { keyframes: [ { t: 0, v: 1 }, { t: 0.06, v: 1.18 }, { t: 0.5, v: 1, ease: spring } ] }` with `scaleY` going 1 → 0.8 → 1. Stretch pivots on the image's centre, so move `y` down by `(h / 2) × scale × (1 − scaleY)` at the same time to keep the feet on the floor.
**Pop in:** `scale` keyframes `{ t: 0, v: 0.6 }` → `{ t: 0.4, v: 1, ease: back }`, plus `fadeIn: 0.15`.
**Slow push-in for the whole clip:** `scale` `{ t: 0, v: 1 }` → `{ t: <duration>, v: 1.1, ease: easeInOut }`.
**Wipe reveal of an image:** `crop.right` from the image's width down to `0`.
**Letters pull together:** `letterSpacing` `{ t: 0, v: 40 }` → `{ t: 1, v: 0, ease: easeOut }`.
**Duck music under a voice:** `volume` keyframes on the music, e.g. `0.8` → `0.25` → `0.8`.

---

## Transcripts (speech-to-text) — editing by what is said

Run speech-to-text on a project (local Whisper via faster-whisper; uses the GPU if available):

```bash
npm run transcribe -- <project>                 # transcribe media that has no transcript yet
npm run transcribe -- <project> --force         # redo everything
npm run transcribe -- <project> --model base.en # pick a model (tiny.en / base.en / small.en …)
npm run transcribe -- <project> --captions      # also add/refresh caption text objects in the .banana file
npm run transcribe -- <project> --remove-captions
```

Or use the **Transcript** tab in the editor. Files produced, next to the `.banana` file:

| file | contents |
|---|---|
| `<name>.transcript.yaml` | **Read this to edit.** Every heard word in **timeline seconds**, regenerated automatically whenever the project changes |
| `<name>.srt` | subtitles from the same words |
| `transcripts/<library-id>.json` | per-file cache in the file's own time (re-used until the file changes) |

```yaml
segments:
  - start: 8.14                  # timeline seconds
    end: 13.06
    object: part-2               # the timeline object that plays this speech
    track: A1
    source: speech               # its library id
    sourceTime: [ 7.14, 12.06 ]  # same span in the source file's time
    text: It makes a guess, measures how wrong it was, and nudges its weights a tiny bit.
    words: [ [ 8.14, 8.32, It ], [ 8.32, 8.54, makes ], … ]   # [start, end, word]
```

Words that the edit cuts out are not listed. Muted, disabled and zero-volume clips are skipped.

**Recipes**
- **Title exactly when a word is said:** set the text object's `start` to that word's start.
- **Cut out a sentence spoken in object `X`** (timeline `a`..`b`): split `X` into a part ending at `a` and a part
  starting at `b` (the second part's `in` = `X.in + (b − X.start) × X.speed`). Then move everything later on that
  track left by `b − a`.
- **Cut on a pause:** gaps between one word's `end` and the next word's `start` are silence, the safest places to cut.
- **B-roll over a phrase:** put the image/video on a higher video track from the first word's start to the last
  word's end.
- **Captions:** the `--captions` flag (or **Add captions**) creates text objects with `note: auto-caption` on a
  "Captions" track. Re-running replaces only those, and you can restyle them like any text object.

## Asset library

`assets/` (next to `projects/`) holds reusable media that every project can use: sound effects, logos, memes,
overlays. Each asset has a stable **name** so people and AI can ask for it ("add `crowd-cheering` at 12 s").

```
assets/
  assets.yaml          ← the catalog: name, kind, file, description, tags
  images/ audio/ video/  ← files copied into the library
```

```yaml
format: 1
folders:                       # linked folders: files stay where they are, new files are added automatically
  - C:/Users/me/Sound Effects
  - { path: D:/Memes, tags: [meme] }   # tags given to everything found there
assets:
  - name: explosion-sfx        # unique, lowercase-with-dashes: this is what you refer to
    kind: audio                # image | video | audio
    file: audio/explosion-sfx.mp3   # relative to assets/, or absolute for files in a linked folder
    description: Big explosion boom sound effect (5.5 s)
    tags: [sfx, explosion, boom]
    duration: 5.496            # filled in automatically, like width / height / hasAudio
```

**Using an asset** copies it into the project's `media/` folder, so projects never break when the library changes.
The project's library entry keeps `asset: <name>` to show where it came from.

- **In a .banana file:** add `- { id: boom, asset: explosion-sfx }` to `library`, then use `source: boom` on objects.
  The open editor fills in the rest within a moment, and so does `npm run check`.
- **In the editor:** the **Assets** tab next to the Media Pool. Search by name, tag or description, filter by kind or
  tag, preview sounds, then drag onto the timeline or double-click to add at the playhead.
- **Command line:** `npm run asset -- use explosion-sfx my-video` adds it to `projects/my-video`.

**Finding assets:** `npm run asset -- list` (everything) or `npm run asset -- list sfx boom` (every word must match
the name, a tag, the kind or the description). `npm run asset -- show <name>` prints one entry.

**Adding assets:**

| how | what happens |
|---|---|
| Drop files onto the Assets tab, or its **+** button | copied into `assets/` |
| Assets tab → folder button → paste a path, choose **Link** | folder stays where it is; anything you put in it later shows up on its own |
| Assets tab → folder button → paste a path, choose **Copy in** | one-time copy of a file or a whole folder (searched recursively) |
| Media Pool → right-click an item → **Save to asset library** | a project's file becomes a reusable asset |
| `npm run asset -- add <file-or-folder>… [--name n] [--tags a,b] [--description "…"]` | copied in |
| `npm run asset -- link <folder> [--tags a,b]` | linked |
| editing `assets/assets.yaml` directly | names, tags and descriptions; the editor reloads it live |

Adding the same file twice (same contents) is detected and reuses the existing asset. Rename with
`npm run asset -- rename <old> <new>`, retag with `npm run asset -- tag <name> a,b`, and describe with
`npm run asset -- describe <name> "…"` (or edit the fields in the Assets tab). Removing an asset moves its copied file to
`assets/.trash/`; a linked file is left alone and skipped by future scans.

**Good names and tags** are what make the library useful: name what the thing *is* (`red-arrow`, `crowd-cheering`), and
use tags for what it's *for* (`sfx`, `callout`, `meme`, `music`, `cutout` for transparent PNGs). Put useful details in
`description` (length, background, mood).

---

### Asset requests

When the library lacks something, request it instead of inventing placeholder art:
`npm run asset -- request <name> --description "…" [--kind image|audio|video] [--project p] [--note "…"]
[--links url,url] [--remove-background]`. Requests live in `assets/requests.yaml` (safe to edit by hand) and show up
in the editor under **Assets → Requests** as drop boxes. Dropping or pasting a file adds it to the library under the
requested name, and cuts out the background first if `removeBackground` is set. Check progress with
`npm run asset -- requests`, and only reference the asset (`- { id: x, asset: <name> }`) once it shows ✓.

## Reserved for later (don't use yet)

These names are reserved so future versions stay compatible. Version 1 rejects them:

- **`animations:`** a list of animation presets on an object (e.g. `- { preset: popIn, duration: 0.3 }`).
- **`transitions:`** cross-fades and wipes between neighbouring clips.
- Keyframes on colors and other non-number properties.

When the format changes, `format:` goes up and older files are migrated automatically.
