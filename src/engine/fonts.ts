import { notify } from './mediaCache';

/**
 * Fonts shipped with the editor (files in `public/fonts/`). Text objects use them by family name, e.g.
 * `font: DynaPuff`. They're registered up front so the canvas has them in the preview and the export.
 */
const BUNDLED_FONTS = [{ family: 'DynaPuff', url: '/fonts/DynaPuff.ttf', weight: '400 700', stretch: '75% 100%' }];

let ready: Promise<void> | null = null;

/** Load every bundled font once; resolves when they're usable (failures are logged, not thrown). */
export function loadBundledFonts(): Promise<void> {
  if (ready) return ready;
  ready = Promise.all(
    BUNDLED_FONTS.map(async (f) => {
      try {
        const face = new FontFace(f.family, `url(${f.url})`, { weight: f.weight, stretch: f.stretch });
        document.fonts.add(await face.load());
      } catch (e) {
        console.warn(`font ${f.family} failed to load`, e);
      }
    }),
  ).then(() => notify());
  return ready;
}
