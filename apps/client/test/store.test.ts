// Which painted atlas a screen loads: one level per sprite for the screen's density.
import { describe, expect, it } from 'vitest';
import { paintedLevel } from '../src/assets/store';

describe('painted levels', () => {
  it('takes the sharpest level that divides the density, or the smallest for the quick first look', () => {
    expect(paintedLevel([2, 3, 4, 6, 8], 6)).toBe(6);
    expect(paintedLevel([2, 3, 4, 6, 8], 6, true)).toBe(2);
    expect(paintedLevel([2, 4, 8], 3)).toBe(2);
  });

  it('still loads something on a density-1 screen (a small phone), so no sprite is ever missing', () => {
    expect(paintedLevel([2, 3, 4, 6, 8], 1)).toBe(2);
    expect(paintedLevel([3, 6], 1, true)).toBe(3);
    expect(paintedLevel([], 1)).toBeNull();
  });
});

describe('one size at every density', () => {
  it('a sprite drawn after the window changes density is the size it was before, whichever atlases are already here', async () => {
    const { AssetStore } = await import('../src/assets/store');
    const { Texture, TextureSource } = await import('pixi.js');
    const store = new AssetStore({ version: 1, source: { repo: '', commit: null, manifestSha256: '' }, sprites: {}, sounds: {}, traits: {} } as never);
    // every farm atlas page already loaded (as after a window has been at both densities)
    const internals = store as unknown as { pages: Map<string, { bitmap: null; texture: InstanceType<typeof Texture>; w: number }[]>; pending: Map<string, Promise<void>> };
    for (const key of ['farm', 'farm@2', 'farm@3', 'farm@4', 'farm@6', 'farm@8', 'farm.wide@2', 'farm.wide@3', 'farm.wide@4', 'farm.wide@6']) {
      internals.pages.set(key, [{ bitmap: null, texture: new Texture({ source: new TextureSource({ width: 8192, height: 8192 }) }), w: 8192 }]);
      internals.pending.set(key, Promise.resolve());
    }
    const height = (id: string, row: string) => {
      const f = store.frames(id, row)[0];
      return (f?.texture.frame.height ?? 0) * store.texelScale(id);
    };
    const seen: Record<string, number[]> = {};
    for (const d of [4, 2, 3, 6, 2, 8, 4]) {
      await store.loadGroups(['farm'], d);
      for (const [id, row] of [
        ['02-body', 'idle'],
        ['02-body', 'waddle'],
        ['02-comb-spiky', 'idle'],
        ['15-coop-red', 'idle'],
        ['19-egg-grader', 'idle'],
      ] as const) {
        (seen[`${id}/${row}`] ??= []).push(height(id, row));
      }
    }
    // a hen's body is the size table's hen (27.1 world px with her comb; the body alone 26.1)
    expect(seen['02-body/idle']?.every((h) => Math.abs(h - 26.1) < 0.6)).toBe(true);
    for (const [k, hs] of Object.entries(seen)) {
      // the same world size at every density, within one texel of the coarsest level
      expect(Math.max(...hs) - Math.min(...hs), `${k}: ${hs.map((h) => h.toFixed(2)).join(' ')}`).toBeLessThanOrEqual(0.5);
    }
  });
});
