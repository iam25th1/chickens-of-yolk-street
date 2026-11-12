// The 777 Founding Hens (founders.json) and the reveal they are planned for.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RARITIES } from '@coys/shared';
import { BODY_PALETTES, COMB_PALETTES, foundersJson, generateFounders, lookKey, sha256Hex } from '../lib/founders';
import { Stream, assignHens, drawRarities } from '../lib/reveal';

const dataDir = fileURLToPath(new URL('../../apps/server/data/', import.meta.url));
const SEED = 'coys-founders-2026-11-12';

describe('founders.json', () => {
  const file = generateFounders(SEED);

  it('holds 777 hens: exactly 7 Legendary, 70 Epic, 200 Rare and 500 Common, numbered 1 to 777', () => {
    expect(file.founders).toHaveLength(777);
    expect(file.founders.map((f) => f.number)).toEqual(Array.from({ length: 777 }, (_, i) => i + 1));
    const count = (r: string) => file.founders.filter((f) => f.rarity === r).length;
    expect(RARITIES.map(count)).toEqual([7, 70, 200, 500]);
  });

  it('no two hens share a look or a name', () => {
    expect(new Set(file.founders.map((f) => lookKey(f.traits))).size).toBe(777);
    expect(new Set(file.founders.map((f) => f.name)).size).toBe(777);
  });

  it('Legendary and Epic palettes are used by no lower rarity; only Legendaries sparkle', () => {
    for (const top of ['legendary', 'epic'] as const) {
      const bodies = new Set(Object.keys(BODY_PALETTES[top]));
      const combs = new Set(Object.keys(COMB_PALETTES[top]));
      const lower = file.founders.filter((f) => RARITIES.indexOf(f.rarity) > RARITIES.indexOf(top));
      expect(lower.some((f) => bodies.has(f.traits.body) || combs.has(f.traits.combColour))).toBe(false);
    }
    expect(file.founders.filter((f) => f.fx === 'sparkle').every((f) => f.rarity === 'legendary')).toBe(true);
    expect(file.founders.filter((f) => f.rarity === 'legendary').every((f) => f.fx === 'sparkle')).toBe(true);
  });

  it('the committed file is exactly what the seed makes, and its hash is the provenance', () => {
    const text = readFileSync(`${dataDir}founders.json`, 'utf8');
    expect(text).toBe(foundersJson(generateFounders(SEED)));
    expect(readFileSync(`${dataDir}founders.json.sha256`, 'utf8').split(/\s+/)[0]).toBe(sha256Hex(text));
    expect(generateFounders('another seed').founders[0]).not.toEqual(file.founders[0]);
  });
});

describe('the planned reveal (TypeScript, same as the contract)', () => {
  const grades = Array.from({ length: 777 }, (_, i) => i % 4);

  it('reproduces the contract crate\'s pinned vector', () => {
    const r = drawRarities(new Stream('coys-reveal-test'), grades);
    expect(r.flatMap((x, i) => (x === 0 ? [i + 1] : []))).toEqual([200, 239, 332, 339, 367, 455, 665]);
  });

  it('always ends at exactly 7/70/200/500 and gives every hen to one Feather of her rarity', () => {
    const founders = generateFounders(SEED).founders.map((f) => RARITIES.indexOf(f.rarity));
    for (const seed of ['a', 'b', 'near-mainnet:150000000:x']) {
      const s = new Stream(seed);
      const r = drawRarities(s, grades);
      expect([0, 1, 2, 3].map((k) => r.filter((x) => x === k).length)).toEqual([7, 70, 200, 500]);
      const hens = assignHens(s, r, founders);
      expect(new Set(hens).size).toBe(777);
      hens.forEach((h, i) => expect(founders[h]).toBe(r[i]));
    }
  });
});

describe('palettes are recolours of the existing layers', () => {
  it('recolourComb turns the red comb layer to the ramp, and leaves its outline alone', async () => {
    const { decodePng } = await import('../../apps/server/src/chain/png');
    const { recolourComb, isComb } = await import('@coys/shared');
    const sprites = fileURLToPath(new URL('../../apps/client/public/assets/sprites/', import.meta.url));
    const img = decodePng(readFileSync(`${sprites}02-comb-default.png`));
    const data = Uint8Array.from(img.data);
    const before = data.reduce((n, _, i) => (i % 4 === 0 && (data[i + 3] ?? 0) > 0 && isComb(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0) ? n + 1 : n), 0);
    const violet = COMB_PALETTES.epic.violet;
    if (!violet) throw new Error('no violet');
    const changed = recolourComb(data, violet);
    expect(before).toBeGreaterThan(100);
    expect(changed).toBe(before);
    const after = data.reduce((n, _, i) => (i % 4 === 0 && (data[i + 3] ?? 0) > 0 && isComb(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0) ? n + 1 : n), 0);
    expect(after).toBe(0);
    const opaque = (d: Uint8Array) => d.reduce((n, _, i) => (i % 4 === 3 && (d[i] ?? 0) > 0 ? n + 1 : n), 0);
    expect(opaque(data)).toBe(opaque(img.data));
  });
});
