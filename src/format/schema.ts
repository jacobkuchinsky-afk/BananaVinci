// The single source of truth for the .banana project format.
// Every type, property and default lives here. parse.ts and serialize.ts are built on top of these schemas.
import { z } from 'zod';

export const FORMAT_VERSION = 1;

// ---------------------------------------------------------------------------
// Animatable numbers
// An animatable property is either a plain number or `{ keyframes: [{ t, v, ease }] }`
// (t = seconds from the object's start). Every reader goes through valueAt() in values.ts.
// ---------------------------------------------------------------------------

/** Easing presets that take no parameters. Written in the file as a bare word: `ease: easeOut`. */
export const EASE_PRESETS = ['linear', 'hold', 'easeIn', 'easeOut', 'easeInOut', 'smooth', 'bounce'] as const;
export type EasePreset = (typeof EASE_PRESETS)[number];

const preset = <T extends EasePreset>(t: T) => z.object({ type: z.literal(t) }).strict();
export const EaseObjectSchema = z.discriminatedUnion('type', [
  preset('linear'),
  preset('hold'),
  preset('easeIn'),
  preset('easeOut'),
  preset('easeInOut'),
  preset('smooth'),
  preset('bounce'),
  // arrives past the target and settles back. overshoot ≈ how far (1.7 = classic)
  z.object({ type: z.literal('back'), overshoot: z.number().min(0).max(10).default(1.7) }).strict(),
  // damped spring. damping 0..1 (low = wobbly, 1 = no overshoot), frequency = wobbles per second
  z.object({ type: z.literal('spring'), damping: z.number().min(0.01).max(1).default(0.35), frequency: z.number().min(0.1).max(20).default(3) }).strict(),
  // CSS-style cubic bezier; y1/y2 outside 0..1 give anticipation / overshoot
  z
    .object({ type: z.literal('bezier'), x1: z.number().min(0).max(1), y1: z.number().min(-5).max(5), x2: z.number().min(0).max(1), y2: z.number().min(-5).max(5) })
    .strict(),
]);
/** `ease: easeOut` (bare word; `back` / `spring` get default settings) or `ease: { type: spring, damping: 0.3 }`. */
export const EaseSchema = z.union([z.enum([...EASE_PRESETS, 'back', 'spring']).transform((type) => EaseObjectSchema.parse({ type }) as Ease), EaseObjectSchema]);
export type Ease = z.output<typeof EaseObjectSchema>;
export type EaseType = Ease['type'];

export const KeyframeSchema = z
  .object({
    t: z.number(), // seconds from the object's start
    v: z.number(), // value at that time
    ease: EaseSchema.default('linear'), // how the value travels INTO this keyframe from the previous one
  })
  .strict();
export type Keyframe = { t: number; v: number; ease: Ease };

export const AnimValueSchema = z
  .object({
    keyframes: z.array(KeyframeSchema).min(1),
    recorded: z.boolean().optional(), // true when the keyframes came from a live recording
  })
  .strict()
  .transform((a) => ({ ...a, keyframes: [...a.keyframes].sort((x, y) => x.t - y.t) as Keyframe[] }));
export type AnimValue = { keyframes: Keyframe[]; recorded?: boolean };

export const animNum = (def: number) => z.union([z.number(), AnimValueSchema]).default(def);
export type Animatable = number | AnimValue;

const color = (def: string) =>
  z
    .string()
    .regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, 'expected a hex color like "#ffcc00" or "#ffcc0080"')
    .default(def);

// ---------------------------------------------------------------------------
// Shared building blocks
// ---------------------------------------------------------------------------
export const TransformSchema = z
  .object({
    x: animNum(0), // pixels from canvas center (+ = right)
    y: animNum(0), // pixels from canvas center (+ = down)
    scale: animNum(1),
    // optional stretch on top of `scale` (1 = none): squash & stretch, e.g. scaleX 1.15 + scaleY 0.85 = squished.
    // Left out unless used, so files that don't stretch anything don't change.
    scaleX: z.union([z.number(), AnimValueSchema]).optional(),
    scaleY: z.union([z.number(), AnimValueSchema]).optional(),
    rotation: animNum(0), // degrees, clockwise
    opacity: animNum(1), // 0..1
    flipX: z.boolean().default(false),
    flipY: z.boolean().default(false),
  })
  .strict();

export const CropSchema = z
  .object({
    left: animNum(0), // source pixels
    right: animNum(0),
    top: animNum(0),
    bottom: animNum(0),
  })
  .strict();

export const EFFECT_TYPES = ['brightness', 'contrast', 'saturation', 'hue', 'blur', 'grayscale', 'invert', 'sepia'] as const;
export type EffectType = (typeof EFFECT_TYPES)[number];

/** Default amount for each effect + a hint for UI ranges. */
export const EFFECT_INFO: Record<EffectType, { amount: number; min: number; max: number; step: number; unit: string }> = {
  brightness: { amount: 1.2, min: 0, max: 3, step: 0.01, unit: 'x' },
  contrast: { amount: 1.2, min: 0, max: 3, step: 0.01, unit: 'x' },
  saturation: { amount: 1.5, min: 0, max: 3, step: 0.01, unit: 'x' },
  hue: { amount: 90, min: -180, max: 180, step: 1, unit: '°' },
  blur: { amount: 6, min: 0, max: 100, step: 0.5, unit: 'px' },
  grayscale: { amount: 1, min: 0, max: 1, step: 0.01, unit: '' },
  invert: { amount: 1, min: 0, max: 1, step: 0.01, unit: '' },
  sepia: { amount: 1, min: 0, max: 1, step: 0.01, unit: '' },
};

export const EffectSchema = z
  .object({
    type: z.enum(EFFECT_TYPES),
    amount: z.union([z.number(), AnimValueSchema]).optional(),
    enabled: z.boolean().default(true),
  })
  .strict()
  .transform((e) => ({ type: e.type, amount: (e.amount ?? EFFECT_INFO[e.type].amount) as Animatable, enabled: e.enabled }));
export type Effect = { type: EffectType; amount: Animatable; enabled: boolean };

const FIT = z.enum(['contain', 'cover', 'stretch', 'none']);

// Fields every object has. `id` is optional on read (missing ids get assigned).
const base = {
  id: z.string().min(1).optional(),
  start: z.number().min(0).default(0), // seconds — where the object begins on the timeline
  duration: z.number().positive().default(5), // seconds — how long it stays on the timeline
  enabled: z.boolean().default(true),
  note: z.string().default(''), // free text that survives editor saves (YAML comments don't)
};

/**
 * A recorded motion path (from ● Rec): the object follows these samples exactly.
 * `start` is seconds from the object's start; each channel lists one value per sample, `rate` samples per second.
 * While a path is playing (and after it ends, holding its last value) its channels override transform.x/y/scale/rotation.
 */
export const MotionPathSchema = z
  .object({
    start: z.number().min(0),
    rate: z.number().positive().default(60),
    x: z.array(z.number()).optional(),
    y: z.array(z.number()).optional(),
    scale: z.array(z.number()).optional(),
    rotation: z.array(z.number()).optional(),
  })
  .strict();
export type MotionPath = z.output<typeof MotionPathSchema>;
export const MOTION_CHANNELS = ['x', 'y', 'scale', 'rotation'] as const;
export type MotionChannel = (typeof MOTION_CHANNELS)[number];

const visual = {
  transform: TransformSchema.default({}),
  motion: z.array(MotionPathSchema).optional(), // recorded motion paths (only written when there are some)
  fadeIn: z.number().min(0).default(0), // seconds
  fadeOut: z.number().min(0).default(0), // seconds
  effects: z.array(EffectSchema).default([]),
};

const media = {
  source: z.string().min(1), // id of a library item
};

const timed = {
  in: z.number().min(0).default(0), // seconds into the source file where playback starts
  speed: z.number().min(0.1).max(16).default(1),
};

// ---------------------------------------------------------------------------
// Object types
// ---------------------------------------------------------------------------
export const VideoObjectSchema = z
  .object({
    type: z.literal('video'),
    ...base,
    ...media,
    ...timed,
    volume: animNum(1), // 0..2
    muted: z.boolean().default(false),
    fit: FIT.default('contain'),
    ...visual,
    crop: CropSchema.default({}),
  })
  .strict();

export const ImageObjectSchema = z
  .object({
    type: z.literal('image'),
    ...base,
    ...media,
    fit: FIT.default('contain'),
    ...visual,
    crop: CropSchema.default({}),
  })
  .strict();

export const AudioObjectSchema = z
  .object({
    type: z.literal('audio'),
    ...base,
    ...media,
    ...timed,
    volume: animNum(1), // 0..2
    fadeIn: z.number().min(0).default(0),
    fadeOut: z.number().min(0).default(0),
  })
  .strict();

export const TextObjectSchema = z
  .object({
    type: z.literal('text'),
    ...base,
    text: z.string().default('Title'),
    font: z.string().default('Inter, Segoe UI, Arial, sans-serif'),
    size: animNum(96), // px
    color: color('#ffffff'),
    bold: z.boolean().default(true),
    italic: z.boolean().default(false),
    align: z.enum(['left', 'center', 'right']).default('center'),
    lineHeight: z.number().positive().default(1.2), // multiple of size
    letterSpacing: animNum(0), // px
    outline: z.object({ color: color('#000000'), width: z.number().min(0).default(0) }).strict().default({}),
    background: z.object({ color: color('#00000000'), padding: z.number().min(0).default(16), radius: z.number().min(0).default(8) }).strict().default({}),
    shadow: z
      .object({ color: color('#000000aa'), blur: z.number().min(0).default(0), x: z.number().default(0), y: z.number().default(0) })
      .strict()
      .default({}),
    ...visual,
  })
  .strict();

export const ShapeObjectSchema = z
  .object({
    type: z.literal('shape'),
    ...base,
    shape: z.enum(['rect', 'ellipse', 'solid']).default('rect'), // solid = fills the whole canvas
    width: animNum(400),
    height: animNum(240),
    fill: color('#3b82f6'),
    stroke: color('#ffffff'),
    strokeWidth: z.number().min(0).default(0),
    cornerRadius: z.number().min(0).default(0),
    ...visual,
  })
  .strict();

export const AdjustmentObjectSchema = z
  .object({
    type: z.literal('adjustment'),
    ...base,
    opacity: animNum(1), // how strongly the effects are mixed in, 0..1
    fadeIn: z.number().min(0).default(0),
    fadeOut: z.number().min(0).default(0),
    effects: z.array(EffectSchema).default([]),
  })
  .strict();

/**
 * A group: many objects (pictures, text, sounds) packed into ONE clip on a video track.
 * Children are timed from the group's start and positioned relative to the group's position, so moving, trimming
 * or dragging the group moves everything inside it. `volume` scales every sound inside.
 */
export const GroupObjectSchema = z
  .object({
    type: z.literal('group'),
    ...base,
    volume: z.number().min(0).max(2).default(1), // multiplies the volume of every sound inside
    ...visual,
    objects: z.array(z.lazy((): z.ZodTypeAny => ObjectSchema)).default([]),
  })
  .strict();

export const ObjectSchema: z.ZodDiscriminatedUnion<
  'type',
  [
    typeof VideoObjectSchema,
    typeof ImageObjectSchema,
    typeof AudioObjectSchema,
    typeof TextObjectSchema,
    typeof ShapeObjectSchema,
    typeof AdjustmentObjectSchema,
    typeof GroupObjectSchema,
  ]
> = z.discriminatedUnion('type', [
  VideoObjectSchema,
  ImageObjectSchema,
  AudioObjectSchema,
  TextObjectSchema,
  ShapeObjectSchema,
  AdjustmentObjectSchema,
  GroupObjectSchema,
]);

export const OBJECT_TYPES = ['video', 'image', 'audio', 'text', 'shape', 'adjustment', 'group'] as const;
export type ObjectType = (typeof OBJECT_TYPES)[number];

// ---------------------------------------------------------------------------
// Tracks, library, markers, project
// ---------------------------------------------------------------------------
export const TrackSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(['video', 'audio']),
    name: z.string().optional(),
    hidden: z.boolean().default(false), // video tracks: hide from the picture
    muted: z.boolean().default(false), // audio: silence this track
    solo: z.boolean().default(false), // audio: only play solo'd tracks
    locked: z.boolean().default(false), // can't be edited in the timeline
    objects: z.array(ObjectSchema).default([]),
  })
  .strict()
  .transform((t) => ({ ...t, name: t.name ?? (t.kind === 'video' ? 'Video ' : 'Audio ') + t.id.replace(/^\D+/, '') }));

export const LibraryItemSchema = z
  .object({
    id: z.string().min(1),
    file: z.string().min(1), // path relative to the .banana file
    kind: z.enum(['image', 'video', 'audio']),
    width: z.number().optional(),
    height: z.number().optional(),
    duration: z.number().optional(), // seconds (video/audio)
    hasAudio: z.boolean().optional(), // video files with a sound track
    asset: z.string().optional(), // name in the shared asset library this file was copied from (assets/assets.yaml)
  })
  .strict();

export const MARKER_COLORS = ['yellow', 'blue', 'red', 'green', 'purple', 'white'] as const;
export const MarkerSchema = z
  .object({
    time: z.number().min(0),
    name: z.string().default(''),
    color: z.enum(MARKER_COLORS).default('yellow'),
  })
  .strict();

export const ProjectSchema = z
  .object({
    format: z.literal(FORMAT_VERSION).default(FORMAT_VERSION),
    project: z
      .object({
        name: z.string().default('Untitled'),
        width: z.number().int().positive().default(1920),
        height: z.number().int().positive().default(1080),
        fps: z.number().positive().max(120).default(30),
        background: color('#000000'),
      })
      .strict()
      .default({}),
    library: z.array(LibraryItemSchema).default([]),
    markers: z.array(MarkerSchema).default([]),
    tracks: z.array(TrackSchema).default([]),
  })
  .strict();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type WithId<T> = Omit<T, 'id'> & { id: string };
export type VideoObject = WithId<z.output<typeof VideoObjectSchema>>;
export type ImageObject = WithId<z.output<typeof ImageObjectSchema>>;
export type AudioObject = WithId<z.output<typeof AudioObjectSchema>>;
export type TextObject = WithId<z.output<typeof TextObjectSchema>>;
export type ShapeObject = WithId<z.output<typeof ShapeObjectSchema>>;
export type AdjustmentObject = WithId<z.output<typeof AdjustmentObjectSchema>>;
export type GroupObject = WithId<Omit<z.output<typeof GroupObjectSchema>, 'objects'>> & { objects: TimelineObject[] };
export type TimelineObject = VideoObject | ImageObject | AudioObject | TextObject | ShapeObject | AdjustmentObject | GroupObject;
export type VisualObject = VideoObject | ImageObject | TextObject | ShapeObject | GroupObject;
export type MediaObject = VideoObject | ImageObject | AudioObject;
export type Transform = z.output<typeof TransformSchema>;
export type Crop = z.output<typeof CropSchema>;
export type Track = Omit<z.output<typeof TrackSchema>, 'objects'> & { objects: TimelineObject[] };
export type LibraryItem = z.output<typeof LibraryItemSchema>;
export type Marker = z.output<typeof MarkerSchema>;
export type Project = Omit<z.output<typeof ProjectSchema>, 'tracks'> & { tracks: Track[] };
export type ProjectSettings = Project['project'];

export const isVisual = (o: TimelineObject): o is VisualObject =>
  o.type === 'video' || o.type === 'image' || o.type === 'text' || o.type === 'shape' || o.type === 'group';
export const isGroup = (o: TimelineObject): o is GroupObject => o.type === 'group';
export const isMedia = (o: TimelineObject): o is MediaObject => o.type === 'video' || o.type === 'image' || o.type === 'audio';
export const hasSourceTime = (o: TimelineObject): o is VideoObject | AudioObject => o.type === 'video' || o.type === 'audio';
export const trackKindFor = (type: ObjectType): 'video' | 'audio' => (type === 'audio' ? 'audio' : 'video');

const objectSchemas: Record<ObjectType, z.ZodTypeAny> = {
  video: VideoObjectSchema,
  image: ImageObjectSchema,
  audio: AudioObjectSchema,
  text: TextObjectSchema,
  shape: ShapeObjectSchema,
  adjustment: AdjustmentObjectSchema,
  group: GroupObjectSchema,
};

/** Fully defaulted object of a type — used by the inspector's reset buttons and generators. */
export function defaultsFor<T extends TimelineObject>(type: T['type'], extra: Record<string, unknown> = {}): T {
  const needsSource = type === 'video' || type === 'image' || type === 'audio';
  return objectSchemas[type].parse({ type, ...(needsSource ? { source: 'x' } : {}), ...extra }) as T;
}

export function emptyProject(name = 'Untitled'): Project {
  return ProjectSchema.parse({
    project: { name },
    tracks: [
      { id: 'V1', kind: 'video' },
      { id: 'A1', kind: 'audio' },
    ],
  }) as Project;
}
