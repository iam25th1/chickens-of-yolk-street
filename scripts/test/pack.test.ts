import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { frameAnchor, packAssets, type AssetIndex } from '../lib/pack';

const out = fileURLToPath(new URL('../../apps/client/public/assets', import.meta.url));
const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');
const index = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8')) as AssetIndex;

interface ManifestFile {
  path: string;
  sha256: string;
}
const manifest = JSON.parse(readFileSync(join(out, 'source-manifest.json'), 'utf8')) as {
  art: { files: ManifestFile[] }[];
  audio: { files: ManifestFile[] }[];
};
const manifestHashes = new Map<string, string>();
for (const e of [...manifest.art, ...manifest.audio]) for (const f of e.files) manifestHashes.set(f.path, f.sha256);

describe('packed assets trace to the coys-assets manifest', () => {
  it('the bundled manifest is the one the pack was built from', () => {
    expect(sha(join(out, 'source-manifest.json'))).toBe(index.source.manifestSha256);
  });

  it('every packed PNG is byte-identical to its manifest entry', () => {
    const sprites = Object.values(index.sprites);
    expect(sprites.length).toBe(67);
    for (const s of sprites) {
      expect(manifestHashes.get(s.source), s.source).toBe(s.sha256);
      expect(sha(join(out, s.png)), s.png).toBe(s.sha256);
      const json = JSON.parse(readFileSync(join(out, s.json), 'utf8')) as { meta: { source: { sha256: string } } };
      expect(json.meta.source.sha256).toBe(s.sha256);
    }
  });

  it('every packed MP3 and loop OGG is byte-identical to its manifest entry', () => {
    let count = 0;
    for (const [id, s] of Object.entries(index.sounds)) {
      for (const [file, f] of Object.entries(s.files)) {
        expect(manifestHashes.get(f.source)).toBe(f.sha256);
        expect(sha(join(out, 'audio', id, file))).toBe(f.sha256);
        count++;
      }
      if (s.loop) {
        expect(manifestHashes.get(`audio/${id}/${s.loop.file}`)).toBe(s.loop.sha256);
        expect(sha(join(out, 'audio', id, s.loop.file))).toBe(s.loop.sha256);
        expect(s.loop.loopEndSample).toBeGreaterThan(s.loop.loopStartSample);
        count++;
      }
    }
    expect(count).toBe(124 + 12);
  });

  it('the 12 looping sounds carry gapless OGG loop points', () => {
    const loops = Object.entries(index.sounds).filter(([, s]) => s.loop).map(([id]) => id);
    expect(loops).toHaveLength(12);
  });
});

describe('hen trait layers stack pixel-perfect', () => {
  type Frames = Record<string, { frame: unknown; anchor: unknown; duration: number }>;
  const load = (id: string) =>
    JSON.parse(readFileSync(join(out, `sprites/${id}.json`), 'utf8')) as { frames: Frames; animations: Record<string, string[]> };
  const base = load('01-hen-anims');

  it('every trait layer has the base hen frame order, rects, anchors and timing', () => {
    const layers = Object.values(index.traits.layers);
    expect(layers).toHaveLength(10);
    for (const id of layers) {
      const layer = load(id);
      expect(layer.animations, id).toEqual(base.animations);
      expect(layer.frames, id).toEqual(base.frames);
      expect(index.sprites[id]?.width).toBe(index.sprites['01-hen-anims']?.width);
      expect(index.sprites[id]?.height).toBe(index.sprites['01-hen-anims']?.height);
    }
  });

  it('stack order is body, eyes, comb, accessory', () => {
    expect(index.traits.stackOrder).toEqual(['body', 'eyes', 'comb', 'accessory']);
  });
});

describe('pack rules', () => {
  it('19-egg-grader is canonical and 19b-egg-sorter is packed but unused', () => {
    expect(index.canonical['19']).toBe('19-egg-grader');
    expect(index.unused).toContain('19b-egg-sorter');
    expect(index.sprites['19b-egg-sorter']).toBeDefined();
  });

  it('feet anchors land on the cell floor even for frames cut with headroom', () => {
    expect(frameAnchor([0, 160, 256, 360], { w: 256, h: 256 }, 'feet')).toEqual({ x: 0.5, y: 352 / 360 });
    expect(frameAnchor([0, 0, 256, 264], { w: 256, h: 256 }, 'feet')).toEqual({ x: 0.5, y: 256 / 264 });
    expect(frameAnchor([128, 0, 128, 128], { w: 128, h: 128 }, 'center')).toEqual({ x: 0.5, y: 0.5 });
  });

  const assetsDir = process.env.ASSETS_DIR ?? fileURLToPath(new URL('../../../coys-assets', import.meta.url));
  it.runIf(existsSync(join(assetsDir, 'manifest.json')))('re-packing from the asset repo reproduces the committed index', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'coys-pack-'));
    try {
      const result = packAssets({ assetsDir, outDir: tmp });
      expect(result.index.source.manifestSha256).toBe(index.source.manifestSha256);
      expect(JSON.parse(readFileSync(join(tmp, 'index.json'), 'utf8'))).toEqual(index);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
