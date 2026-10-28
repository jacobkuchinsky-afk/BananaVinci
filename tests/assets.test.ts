import { describe, expect, it } from 'vitest';
import { assetName, cleanTags, parseCatalog, searchAssets, serializeCatalog, uniqueAssetName } from '../src/format/assets';
import { parseProject } from '../src/format/parse';

const catalog = `
folders:
  - C:/Users/me/Sounds
  - { path: D:/Memes, tags: [meme] }
assets:
  - name: explosion-sfx
    kind: audio
    file: audio/explosion-sfx.mp3
    tags: [sfx, explosion, boom]
    description: Big explosion boom
    duration: 5.5
  - name: red-arrow
    kind: image
    file: images/red-arrow.png
    tags: [arrow, callout]
  - name: crowd-cheering
    kind: audio
    file: audio/crowd-cheering.mp3
    tags: [sfx, crowd]
    description: People cheering after a boom
`;

describe('asset catalog', () => {
  it('parses with defaults and normalises folders', () => {
    const r = parseCatalog(catalog);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(r.catalog.assets).toHaveLength(3);
    expect(r.catalog.assets[1].description).toBe('');
    expect(r.catalog.folders[0]).toEqual({ path: 'C:/Users/me/Sounds', tags: [], exclude: [] });
    expect(r.catalog.folders[1].tags).toEqual(['meme']);
  });

  it('round-trips through serialize', () => {
    const a = parseCatalog(catalog);
    if (!a.ok) throw new Error();
    const text = serializeCatalog(a.catalog);
    const b = parseCatalog(text);
    if (!b.ok) throw new Error(JSON.stringify(b.errors));
    expect(serializeCatalog(b.catalog)).toBe(text);
    expect(text).toContain('tags: [sfx, explosion, boom]');
    expect(text.startsWith('# BananaVinci asset library')).toBe(true);
  });

  it('rejects bad names, unknown keys and duplicates with line numbers', () => {
    const bad = parseCatalog(catalog.replace('name: red-arrow', 'name: Red Arrow'));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors[0].path).toBe('assets[1].name');

    const typo = parseCatalog(catalog.replace('    tags: [arrow, callout]', '    tag: [arrow]'));
    expect(typo.ok).toBe(false);
    if (!typo.ok) expect(typo.errors[0].message).toContain('"tag"');

    const dup = parseCatalog(catalog.replace('name: crowd-cheering', 'name: red-arrow'));
    expect(dup.ok).toBe(false);
    if (!dup.ok) {
      expect(dup.errors[0].message).toContain('duplicate');
      expect(dup.errors[0].line).toBe(16);
    }
  });

  it('makes readable, unique names', () => {
    expect(assetName('explosion-fx-343683 (1).mp3')).toBe('explosion-fx-343683-1');
    expect(assetName('Screen Recording 2025-06-07.mp4')).toBe('screen-recording-2025-06-07');
    expect(assetName('!!!', 'image')).toBe('image');
    expect(uniqueAssetName('boom', ['boom', 'boom-2'])).toBe('boom-3');
    expect(cleanTags(' SFX, boom,,sfx ')).toEqual(['sfx', 'boom']);
  });

  it('searches every word across name, tags, kind and description', () => {
    const r = parseCatalog(catalog);
    if (!r.ok) throw new Error();
    const names = (q: string) => searchAssets(r.catalog.assets, q).map((a) => a.name);
    expect(names('boom')).toEqual(['explosion-sfx', 'crowd-cheering']); // tag beats description
    expect(names('sfx crowd')).toEqual(['crowd-cheering']);
    expect(names('image')).toEqual(['red-arrow']);
    expect(names('nothing-like-this')).toEqual([]);
    expect(names('')).toEqual(['crowd-cheering', 'explosion-sfx', 'red-arrow']);
  });
});

describe('asset references in projects', () => {
  it('explains an asset entry that has not been copied in yet', () => {
    const r = parseProject('library:\n  - { id: boom, asset: explosion-sfx }\n');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0].message).toContain('explosion-sfx');
      expect(r.errors[0].line).toBe(2);
    }
  });

  it('keeps the asset name on resolved library items', () => {
    const r = parseProject('library:\n  - { id: boom, asset: explosion-sfx, file: media/explosion-sfx.mp3, kind: audio }\n');
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(r.project.library[0].asset).toBe('explosion-sfx');
  });
});
