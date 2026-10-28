// Draws one frame of the project onto a canvas. Used by BOTH the live preview and the MP4 export,
// so what you see is what you render. All coordinates are in project pixels.
import { isVisual, type Effect, type GroupObject, type LibraryItem, type Project, type ShapeObject, type TextObject, type TimelineObject, type VisualObject } from '../format/schema';
import { fadeFactor, isActiveAt, transformAt, valueAt, type ResolvedTransform } from '../format/values';
import { getOverride } from './overrides';
import { pathValueAt } from '../format/recording';
import { MOTION_CHANNELS } from '../format/schema';

/** Transform at a moment, including any live recording override. */
export function effectiveTransform(o: VisualObject, localT: number): ResolvedTransform {
  const tr = transformAt(o.transform, localT);
  // recorded motion paths take over their channels once they've started (holding the last value afterwards)
  if (o.motion?.length) {
    for (const ch of MOTION_CHANNELS) {
      const v = pathValueAt(o.motion, ch, localT);
      if (v !== undefined) tr[ch] = v;
    }
  }
  const ov = getOverride(o.id);
  if (ov) {
    if (ov['transform.x'] !== undefined) tr.x = ov['transform.x'];
    if (ov['transform.y'] !== undefined) tr.y = ov['transform.y'];
    if (ov['transform.scale'] !== undefined) tr.scale = ov['transform.scale'];
    if (ov['transform.rotation'] !== undefined) tr.rotation = ov['transform.rotation'];
  }
  return tr;
}

export interface FrameSources {
  /** `localT` is seconds into the object, which picks the frame of an animated image. */
  image(item: LibraryItem, localT: number): CanvasImageSource | null;
  video(obj: TimelineObject, item: LibraryItem): HTMLVideoElement | null;
}

export interface Box {
  w: number; // drawn size before transform.scale
  h: number;
  /** Center of the box relative to the object's position, before transform.scale (groups; 0 for everything else). */
  cx?: number;
  cy?: number;
}

/** Where a box's center ends up, relative to the canvas center, once the transform is applied. */
export function boxCenter(tr: ResolvedTransform, box: Box): { x: number; y: number } {
  const r = (tr.rotation * Math.PI) / 180;
  const bx = (box.cx ?? 0) * tr.scale * tr.scaleX * (tr.flipX ? -1 : 1);
  const by = (box.cy ?? 0) * tr.scale * tr.scaleY * (tr.flipY ? -1 : 1);
  return { x: tr.x + bx * Math.cos(r) - by * Math.sin(r), y: tr.y + bx * Math.sin(r) + by * Math.cos(r) };
}

/** Children of a group that draw at group-local time `localT`. */
const visibleChildren = (g: GroupObject, localT: number) =>
  g.objects.filter((c): c is VisualObject => isVisual(c) && isActiveAt(c, localT) && c.start < g.duration);

const measureCtx = (() => {
  const c = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  return c?.getContext('2d') ?? null;
})();

let scratch: HTMLCanvasElement | null = null;

export function effectsToFilter(effects: Effect[], pxScale = 1, localT = 0): string {
  const parts: string[] = [];
  for (const e of effects) {
    if (!e.enabled) continue;
    const a = valueAt(e.amount, localT);
    switch (e.type) {
      case 'brightness': parts.push(`brightness(${a})`); break;
      case 'contrast': parts.push(`contrast(${a})`); break;
      case 'saturation': parts.push(`saturate(${a})`); break;
      case 'hue': parts.push(`hue-rotate(${a}deg)`); break;
      case 'blur': if (a > 0) parts.push(`blur(${a * pxScale}px)`); break;
      case 'grayscale': parts.push(`grayscale(${a})`); break;
      case 'invert': parts.push(`invert(${a})`); break;
      case 'sepia': parts.push(`sepia(${a})`); break;
    }
  }
  return parts.length ? parts.join(' ') : 'none';
}

const lib = (p: Project, id: string) => p.library.find((l) => l.id === id);

function naturalSize(el: CanvasImageSource, item: LibraryItem): { w: number; h: number } {
  if (el instanceof HTMLVideoElement) return { w: el.videoWidth || item.width || 1, h: el.videoHeight || item.height || 1 };
  if (el instanceof HTMLImageElement) return { w: el.naturalWidth || item.width || 1, h: el.naturalHeight || item.height || 1 };
  if (typeof ImageBitmap !== 'undefined' && el instanceof ImageBitmap) return { w: el.width || item.width || 1, h: el.height || item.height || 1 };
  // rasterized SVGs are stored at 2× — report their original size
  if (el instanceof HTMLCanvasElement) return { w: item.width ?? el.width / 2, h: item.height ?? el.height / 2 };
  return { w: item.width ?? 1, h: item.height ?? 1 };
}

/**
 * Filtered copies of still images, so a blurred/darkened background isn't re-filtered on every frame (a 5 px blur over
 * a full-screen image costs ~30 ms a frame even on the GPU). The filter is applied once at the image's own resolution,
 * with the blur radius converted to source pixels (rounded to 0.05 px so a slow push-in keeps reusing it) and enough
 * transparent margin that the edges fade exactly like a live blur. Only for uncropped images whose source is a plain
 * image or rasterized SVG; videos and animated frames change every frame. A copy is only made once the same filter
 * comes up twice in a row, so animated effects (a hue spin) keep drawing live instead of making a copy per frame.
 */
const filteredCache = new WeakMap<object, Map<string, HTMLCanvasElement>>();
const lastFilter = new WeakMap<object, string>();
const BLUR = /blur\(([\d.]+)px\)/g;

function filteredImage(el: HTMLImageElement | HTMLCanvasElement, filter: string, srcPxPerDevicePx: number) {
  let pad = 0;
  const srcFilter = filter.replace(BLUR, (_, r) => {
    const sr = Math.round(Number(r) * srcPxPerDevicePx * 20) / 20;
    pad = Math.max(pad, Math.ceil(sr * 3));
    return `blur(${sr}px)`;
  });
  let byFilter = filteredCache.get(el);
  if (!byFilter) filteredCache.set(el, (byFilter = new Map()));
  let c = byFilter.get(srcFilter);
  if (!c && lastFilter.get(el) !== srcFilter) {
    lastFilter.set(el, srcFilter);
    return null;
  }
  if (!c) {
    const w = el instanceof HTMLImageElement ? el.naturalWidth : el.width;
    const h = el instanceof HTMLImageElement ? el.naturalHeight : el.height;
    c = document.createElement('canvas');
    c.width = w + pad * 2;
    c.height = h + pad * 2;
    const cx = c.getContext('2d')!;
    cx.filter = srcFilter;
    cx.drawImage(el, pad, pad);
    if (byFilter.size >= 4) byFilter.delete(byFilter.keys().next().value!); // keep the newest few per image
    byFilter.set(srcFilter, c);
  }
  return { canvas: c, pad };
}

function fitSize(fit: string, nw: number, nh: number, W: number, H: number) {
  switch (fit) {
    case 'cover': {
      const k = Math.max(W / nw, H / nh);
      return { w: nw * k, h: nh * k };
    }
    case 'stretch':
      return { w: W, h: H };
    case 'none':
      return { w: nw, h: nh };
    default: {
      const k = Math.min(W / nw, H / nh);
      return { w: nw * k, h: nh * k };
    }
  }
}

function textFont(o: TextObject, size: number) {
  return `${o.italic ? 'italic ' : ''}${o.bold ? '700 ' : '400 '}${size}px ${o.font}`;
}

function textLayout(ctx: CanvasRenderingContext2D, o: TextObject, localT: number) {
  const size = valueAt(o.size, localT);
  ctx.font = textFont(o, size);
  (ctx as any).letterSpacing = `${valueAt(o.letterSpacing, localT)}px`;
  const lines = o.text.split('\n');
  const widths = lines.map((l) => ctx.measureText(l).width);
  const lh = size * o.lineHeight;
  const w = Math.max(1, ...widths);
  const h = Math.max(lh * lines.length, size);
  const hasBg = alphaOf(o.background.color) > 0;
  const pad = hasBg ? o.background.padding : 0;
  return { size, lines, widths, lh, w, h, pad, boxW: w + pad * 2, boxH: h + pad * 2 };
}

function alphaOf(hex: string) {
  if (hex.length === 9) return parseInt(hex.slice(7, 9), 16) / 255;
  if (hex.length === 5) return parseInt(hex[4] + hex[4], 16) / 255;
  return 1;
}

/** Size of an object's content before transform.scale (centered on its position). */
export function objectBox(o: VisualObject, project: Project, src: FrameSources, localT = 0): Box | null {
  const W = project.project.width;
  const H = project.project.height;
  if (o.type === 'text') {
    if (!measureCtx) return null;
    const l = textLayout(measureCtx, o, localT);
    return { w: l.boxW, h: l.boxH };
  }
  if (o.type === 'shape') {
    if (o.shape === 'solid') return { w: W, h: H };
    return { w: valueAt(o.width, localT), h: valueAt(o.height, localT) };
  }
  if (o.type === 'group') return groupBox(o, project, src, localT);
  const item = lib(project, o.source);
  if (!item) return null;
  const el = o.type === 'video' ? src.video(o, item) : src.image(item, localT);
  const n = el ? naturalSize(el, item) : { w: item.width ?? W, h: item.height ?? H };
  return fitSize(o.fit, n.w, n.h, W, H);
}

/** Bounds of everything a group shows at `localT`, in the group's own (unscaled) coordinates. */
function groupBox(g: GroupObject, project: Project, src: FrameSources, localT: number): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const c of visibleChildren(g, localT)) {
    const ct = localT - c.start;
    const b = objectBox(c, project, src, ct);
    if (!b) continue;
    const tr = effectiveTransform(c, ct);
    const r = (tr.rotation * Math.PI) / 180;
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    for (const [px, py] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const lx = ((b.cx ?? 0) + (px * b.w) / 2) * tr.scale * tr.scaleX;
      const ly = ((b.cy ?? 0) + (py * b.h) / 2) * tr.scale * tr.scaleY;
      const x = tr.x + lx * cos - ly * sin;
      const y = tr.y + lx * sin + ly * cos;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
  if (!Number.isFinite(x0)) return { w: 80, h: 80 }; // nothing showing right now: a small handle to grab
  return { w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}

export function renderFrame(ctx: CanvasRenderingContext2D, project: Project, t: number, src: FrameSources) {
  const W = project.project.width;
  const H = project.project.height;
  const k = ctx.canvas.width / W; // canvas pixels per project pixel
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.filter = 'none';
  ctx.fillStyle = project.project.background;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  for (const track of project.tracks) {
    if (track.kind !== 'video' || track.hidden) continue;
    for (const o of track.objects) {
      if (!isActiveAt(o, t)) continue;
      const localT = t - o.start;
      if (o.type === 'adjustment') {
        drawAdjustment(ctx, o.effects, valueAt(o.opacity, localT) * fadeFactor(localT, o.duration, o.fadeIn, o.fadeOut), k, localT);
        continue;
      }
      if (o.type === 'audio') continue;
      ctx.setTransform(k, 0, 0, k, 0, 0);
      drawVisual(ctx, project, o, localT, src, k);
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.filter = 'none';
}

function drawAdjustment(ctx: CanvasRenderingContext2D, effects: Effect[], mix: number, k: number, localT: number) {
  const filter = effectsToFilter(effects, k, localT);
  if (filter === 'none' || mix <= 0) return;
  const c = ctx.canvas;
  if (!scratch) scratch = document.createElement('canvas');
  if (scratch.width !== c.width || scratch.height !== c.height) {
    scratch.width = c.width;
    scratch.height = c.height;
  }
  const s = scratch.getContext('2d')!;
  s.clearRect(0, 0, c.width, c.height);
  s.drawImage(c, 0, 0);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = Math.min(1, mix);
  ctx.filter = filter;
  ctx.drawImage(scratch, 0, 0);
  ctx.restore();
}

/**
 * Draw one visual object in the current canvas transform (project pixels; a group's children are drawn inside the
 * group's transform). `parentAlpha` / `parentFilter` carry a group's opacity, fades and effects down to its children.
 */
function drawVisual(ctx: CanvasRenderingContext2D, project: Project, o: VisualObject, localT: number, src: FrameSources, k: number, parentAlpha = 1, parentFilter = 'none') {
  const W = project.project.width;
  const H = project.project.height;
  const tr = effectiveTransform(o, localT);
  const alpha = tr.opacity * fadeFactor(localT, o.duration, o.fadeIn, o.fadeOut) * parentAlpha;
  if (alpha <= 0) return;
  const own = effectsToFilter(o.effects, k, localT);
  const filter = own === 'none' ? parentFilter : parentFilter === 'none' ? own : `${parentFilter} ${own}`;

  ctx.save();
  ctx.globalAlpha = Math.min(1, alpha);
  ctx.filter = filter;
  ctx.translate(W / 2 + tr.x, H / 2 + tr.y);
  ctx.rotate((tr.rotation * Math.PI) / 180);
  ctx.scale(tr.scale * tr.scaleX * (tr.flipX ? -1 : 1), tr.scale * tr.scaleY * (tr.flipY ? -1 : 1));

  if (o.type === 'group') {
    // children are positioned relative to the group's position, like top-level objects are to the canvas center
    ctx.translate(-W / 2, -H / 2);
    for (const c of visibleChildren(o, localT)) drawVisual(ctx, project, c, localT - c.start, src, k, alpha, filter);
  } else if (o.type === 'image' || o.type === 'video') {
    const item = lib(project, o.source);
    const el = item ? (o.type === 'video' ? src.video(o, item) : src.image(item, localT)) : null;
    if (item && el) {
      const n = naturalSize(el, item);
      const { w, h } = fitSize(o.fit, n.w, n.h, W, H);
      const kx = w / n.w;
      const ky = h / n.h;
      const cl = Math.max(0, valueAt(o.crop.left, localT));
      const cr = Math.max(0, valueAt(o.crop.right, localT));
      const ct = Math.max(0, valueAt(o.crop.top, localT));
      const cb = Math.max(0, valueAt(o.crop.bottom, localT));
      const sw = n.w - cl - cr;
      const sh = n.h - ct - cb;
      // source pixels may be denser than "natural" pixels (2× rasterized SVGs)
      const dens = el instanceof HTMLCanvasElement ? el.width / n.w : 1;
      const cached = filter !== 'none' && !cl && !cr && !ct && !cb && (el instanceof HTMLImageElement || el instanceof HTMLCanvasElement);
      if (cached) {
        const m = ctx.getTransform();
        const devicePerSrc = (Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) * Math.sqrt(kx * ky)) / dens;
        const f = filteredImage(el, filter, devicePerSrc > 0 ? 1 / devicePerSrc : 1);
        if (f) {
          const px = (f.pad / dens) * kx;
          const py = (f.pad / dens) * ky;
          ctx.filter = 'none';
          ctx.drawImage(f.canvas, -w / 2 - px, -h / 2 - py, w + px * 2, h + py * 2);
        } else ctx.drawImage(el, 0, 0, n.w * dens, n.h * dens, -w / 2, -h / 2, w, h);
      } else if (sw > 0 && sh > 0) ctx.drawImage(el, cl * dens, ct * dens, sw * dens, sh * dens, -w / 2 + cl * kx, -h / 2 + ct * ky, sw * kx, sh * ky);
    }
  } else if (o.type === 'text') {
    drawText(ctx, o, localT);
  } else if (o.type === 'shape') {
    drawShape(ctx, o, localT, W, H);
  }
  ctx.restore();
}

function drawText(ctx: CanvasRenderingContext2D, o: TextObject, localT: number) {
  const l = textLayout(ctx, o, localT);
  if (alphaOf(o.background.color) > 0) {
    ctx.fillStyle = o.background.color;
    ctx.beginPath();
    ctx.roundRect(-l.boxW / 2, -l.boxH / 2, l.boxW, l.boxH, o.background.radius);
    ctx.fill();
  }
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  const top = -l.h / 2 + l.lh / 2;
  if (o.shadow.blur > 0 || o.shadow.x || o.shadow.y) {
    ctx.shadowColor = o.shadow.color;
    ctx.shadowBlur = o.shadow.blur;
    ctx.shadowOffsetX = o.shadow.x;
    ctx.shadowOffsetY = o.shadow.y;
  }
  l.lines.forEach((line, i) => {
    const lw = l.widths[i];
    const x = o.align === 'left' ? -l.w / 2 : o.align === 'right' ? l.w / 2 - lw : -lw / 2;
    const y = top + i * l.lh;
    if (o.outline.width > 0) {
      ctx.strokeStyle = o.outline.color;
      ctx.lineWidth = o.outline.width * 2;
      ctx.strokeText(line, x, y);
      ctx.shadowColor = 'transparent';
    }
    ctx.fillStyle = o.color;
    ctx.fillText(line, x, y);
  });
}

function drawShape(ctx: CanvasRenderingContext2D, o: ShapeObject, localT: number, W: number, H: number) {
  const w = o.shape === 'solid' ? W : valueAt(o.width, localT);
  const h = o.shape === 'solid' ? H : valueAt(o.height, localT);
  ctx.beginPath();
  if (o.shape === 'ellipse') ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
  else if (o.cornerRadius > 0 && o.shape === 'rect') ctx.roundRect(-w / 2, -h / 2, w, h, o.cornerRadius);
  else ctx.rect(-w / 2, -h / 2, w, h);
  ctx.fillStyle = o.fill;
  ctx.fill();
  if (o.strokeWidth > 0) {
    ctx.strokeStyle = o.stroke;
    ctx.lineWidth = o.strokeWidth;
    ctx.stroke();
  }
}

/** Topmost visual object under project point (x, y) at time t. */
export function hitTest(project: Project, t: number, x: number, y: number, src: FrameSources): string | null {
  const W = project.project.width;
  const H = project.project.height;
  const tracks = project.tracks.filter((tr) => tr.kind === 'video' && !tr.hidden && !tr.locked);
  for (let ti = tracks.length - 1; ti >= 0; ti--) {
    const objs = tracks[ti].objects;
    for (let oi = objs.length - 1; oi >= 0; oi--) {
      const o = objs[oi];
      if (!isActiveAt(o, t) || o.type === 'audio' || o.type === 'adjustment') continue;
      if (hits(o, project, t - o.start, x - W / 2, y - H / 2, src)) return o.id;
    }
  }
  return null;
}

/** Is point (x, y) (relative to the canvas center, or to the parent group's position) on object `o`? */
function hits(o: VisualObject, project: Project, localT: number, x: number, y: number, src: FrameSources): boolean {
  const tr = effectiveTransform(o, localT);
  if (!tr.scale || !tr.scaleX || !tr.scaleY) return false;
  const dx = x - tr.x;
  const dy = y - tr.y;
  const r = (-tr.rotation * Math.PI) / 180;
  const lx = ((dx * Math.cos(r) - dy * Math.sin(r)) / (tr.scale * tr.scaleX)) * (tr.flipX ? -1 : 1);
  const ly = ((dx * Math.sin(r) + dy * Math.cos(r)) / (tr.scale * tr.scaleY)) * (tr.flipY ? -1 : 1);
  // a group is hit where one of its children is (not in the empty space between them)
  if (o.type === 'group') return visibleChildren(o, localT).some((c) => hits(c, project, localT - c.start, lx, ly, src));
  const box = objectBox(o, project, src, localT);
  if (!box) return false;
  return Math.abs(lx - (box.cx ?? 0)) <= box.w / 2 && Math.abs(ly - (box.cy ?? 0)) <= box.h / 2;
}
