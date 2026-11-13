// The derived atlases: every sheet keeps the detail its round trip allows (never coarser than its
// passing factor), every animation has the right rows, frame counts and durations, no frame is
// blank or carries a neighbouring row's pixels, painted frames pivot on whole texels at every
// density, and the committed manifest and files are what derive-assets builds.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { derive, EXACT_GROUP, FACTORS, HEN_LAYERS, PAINTED, ROUND_TRIP, UNUSED, type DeriveOutput, type DerivedManifest, type SheetJson, type SourceSprite } from '../lib/derive';
import { decodePng, type Rgba } from '../lib/png';

const root = fileURLToPath(new URL('../..', import.meta.url));
const assets = join(root, 'apps/client/public/assets');
const manifest = JSON.parse(readFileSync(join(root, 'apps/client/src/assets/derived.json'), 'utf8')) as DerivedManifest;
const index = JSON.parse(readFileSync(join(assets, 'index.json'), 'utf8')) as {
  sprites: Record<string, { json: string; png: string; grid: number; rows: Record<string, { mode: 'loop' | 'once' }> }>;
  traits: { bodyRecolour: Record<string, [[number, number, number], [number, number, number]]> };
};
const sourceJson = (id: string): SheetJson => JSON.parse(readFileSync(join(assets, index.sprites[id.split('@')[0] as string]?.json ?? ''), 'utf8')) as SheetJson;

let built: DeriveOutput;
const page = (atlas: string, n: number): Rgba => {
  const file = manifest.atlases[atlas]?.[n]?.file ?? '';
  const p = built.pages.get(file);
  if (!p) throw new Error(`no page ${atlas}/${n}`);
  return p.image;
};

beforeAll(() => {
  const sprites: Record<string, SourceSprite> = {};
  for (const id of [...Object.keys(EXACT_GROUP), ...Object.keys(PAINTED), ...UNUSED.filter((u) => index.sprites[u])]) {
    const e = index.sprites[id];
    if (!e) throw new Error(id);
    sprites[id] = { id, png: decodePng(readFileSync(join(assets, e.png))), json: JSON.parse(readFileSync(join(assets, e.json), 'utf8')) as SheetJson, rows: e.rows, grid: e.grid };
  }
  built = derive({ sprites, bodyRecolour: index.traits.bodyRecolour });
}, 180_000);

describe('derived sprites', () => {
  const ids = Object.keys(manifest.sprites);

  it('is what derive-assets builds from the packed sheets, and every page is committed', () => {
    expect(JSON.stringify(built.manifest)).toBe(JSON.stringify(manifest));
    for (const name of built.pages.keys()) expect(existsSync(join(assets, 'derived', name)), name).toBe(true);
  });

  it('covers every sheet the game draws, hen body colours included', () => {
    for (const id of [...Object.keys(PAINTED), ...Object.keys(EXACT_GROUP), '02-body@brown', '02-body@black']) expect(ids).toContain(id);
  });

  it('keeps every sheet at the largest factor that passes its round trip, and never coarser', () => {
    for (const r of built.assets) {
      if (r.factor > 1) expect(r.error, r.id).toBeLessThanOrEqual(ROUND_TRIP.share);
      // every larger factor that was tried failed (or a divisor of it did)
      for (const f of FACTORS.filter((f) => f > r.factor)) {
        const e = r.tried[f];
        if (e !== undefined && !(HEN_LAYERS.includes(r.id) && e <= ROUND_TRIP.share)) expect(e, `${r.id} at ${f}`).toBeGreaterThan(ROUND_TRIP.share);
      }
    }
    // exact sheets keep their measured grid; painted ones have no grid at all and keep full resolution
    for (const [id, s] of Object.entries(manifest.sprites)) {
      if (s.kind === 'exact') expect(s.factor, id).toBe(index.sprites[id]?.grid);
      else expect(s.factor, id).toBe(1);
    }
  });

  it.each(ids)('%s plays only its named rows, with their frame counts and durations', (id) => {
    const json = sourceJson(id);
    const s = manifest.sprites[id];
    expect(Object.keys(s?.rows ?? {})).toEqual(Object.keys(json.animations));
    for (const [row, names] of Object.entries(json.animations)) {
      expect(s?.rows[row]?.ms, `${id}/${row}`).toEqual(names.map((n) => json.frames[n]?.duration || 100));
      expect(s?.rows[row]?.mode).toBe(index.sprites[id.split('@')[0] as string]?.rows[row]?.mode ?? 'loop');
      for (const level of s?.levels ?? []) expect(s?.frames[String(level)]?.[row]?.length, `${id}/${row}@${level}`).toBe(names.length);
    }
  });

  it.each(ids)('%s: every frame is drawn, pivots on a whole texel and holds only its own cell', (id) => {
    const s = manifest.sprites[id];
    if (!s) throw new Error(id);
    const json = sourceJson(id);
    const first = Object.values(json.frames)[0];
    for (const level of s.levels) {
      const perSource = s.kind === 'painted' ? level / s.ratio : 1 / s.factor;
      const cellW = (first?.frame.w ?? 0) * perSource;
      const cellH = (id.startsWith('02-') ? 256 : (first?.frame.h ?? 0)) * perSource;
      const masses: number[] = [];
      const checks: { key: string; mass: number; h: number; cx: number; cy: number }[] = [];
      for (const [row, frames] of Object.entries(s.frames[String(level)] ?? {}))
        frames.forEach(([x, y, w, h, px, py, n], i) => {
          const key = `${id}/${row}/${i}@${level}`;
          if (s.kind === 'painted') {
            expect(Number.isInteger(px) && Number.isInteger(py), `${key} pivots between texels`).toBe(true);
          }
          const img = page(s.kind === 'painted' ? `${s.atlas ?? s.group}@${level}` : s.group, n);
          let mass = 0;
          let sx = 0;
          let sy = 0;
          let top = Infinity;
          let bottom = -Infinity;
          for (let yy = 0; yy < h; yy++)
            for (let xx = 0; xx < w; xx++)
              if ((img.data[((y + yy) * img.width + x + xx) * 4 + 3] ?? 0) >= 128) {
                mass++;
                sx += xx - px;
                sy += yy - py;
                top = Math.min(top, yy);
                bottom = Math.max(bottom, yy);
              }
          // trait layers (eyes, hats) are small or blank where a pose hides them; the body never is
          if (!/^02-(eyes|acc|comb)/.test(id)) expect(mass, `${key} is blank`).toBeGreaterThan(3);
          if (mass) {
            masses.push(mass);
            checks.push({ key, mass, h: bottom - top + 1, cx: sx / mass, cy: sy / mass });
          }
        });
      if (s.kind !== 'painted') continue;
      const median = [...masses].sort((a, b) => a - b)[Math.floor(masses.length / 2)] ?? 1;
      for (const c of checks) {
        expect(c.h, `${c.key} is taller than its cell`).toBeLessThanOrEqual(Math.ceil(cellH * 1.45));
        expect(Math.abs(c.cx), `${c.key} is off its cell sideways`).toBeLessThanOrEqual(cellW / 2);
        expect(c.cy, `${c.key} hangs below its feet`).toBeLessThanOrEqual(cellH * 0.25);
        // a comb or hat sits on top of the hen, about a cell above her feet; the row above is two
        expect(c.cy, `${c.key} sits in the row above`).toBeGreaterThanOrEqual(-cellH * (/^02-(comb|acc)/.test(id) ? 1.3 : 1.05));
        // trait layers are small and vary more with the pose (eyes wide open while eating)
        expect(c.mass, `${c.key} holds a neighbour's pixels`).toBeLessThanOrEqual(Math.max(median * (/^02-(eyes|acc|comb)/.test(id) ? 2.2 : 1.8), 40));
      }
    }
  });

  it('the conveyor carries no painted eggs: no egg colour on any frame of the sheet the farm draws', () => {
    // the old belt (18-conveyor) had eggs painted on it; the clean one is the same sheet without them
    const EGG = ['248,230,200', '222,184,140'];
    const isEgg = (img: Rgba, x: number, y: number): boolean => {
      const i = (y * img.width + x) * 4;
      return (img.data[i + 3] ?? 0) > 0 && EGG.includes(`${img.data[i]},${img.data[i + 1]},${img.data[i + 2]}`);
    };
    const s = manifest.sprites['18b-conveyor-clean'];
    expect(s).toBeDefined();
    expect(ids).not.toContain('18-conveyor');
    let checked = 0;
    for (const [level, rows] of Object.entries(s?.frames ?? {})) {
      for (const [row, frames] of Object.entries(rows)) {
        expect(frames.length, `${row} at ${level}`).toBe(4);
        for (const [x, y, w, h, , , n] of frames) {
          const img = page(s?.group ?? '', n ?? 0);
          for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) expect(isEgg(img, x + i, y + j), `${row} at ${level}: egg pixel at (${x + i}, ${y + j})`).toBe(false);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(20);
    // the packed source sheet too, and it keeps the old belt's size, rows and timing
    const src = decodePng(readFileSync(join(assets, index.sprites['18b-conveyor-clean']?.png ?? '')));
    const old = decodePng(readFileSync(join(assets, index.sprites['18-conveyor']?.png ?? '')));
    expect([src.width, src.height]).toEqual([old.width, old.height]);
    let eggs = 0;
    let oldEggs = 0;
    for (let y = 0; y < src.height; y++) for (let x = 0; x < src.width; x++) {
      if (isEgg(src, x, y)) eggs++;
      if (isEgg(old, x, y)) oldEggs++;
    }
    expect(eggs).toBe(0);
    expect(oldEggs).toBeGreaterThan(0);
    const shape = (j: SheetJson) => ({ grid: j.meta.grid, size: j.meta.size, rows: Object.values(j.animations).map((a) => a.length), frames: Object.values(j.frames) });
    expect(shape(sourceJson('18b-conveyor-clean'))).toEqual(shape(sourceJson('18-conveyor')));
  });

  it('the crate carries no stray egg: no full-crate frame reaches below its feet, the pile stays whole, and only the egg-drop row has a falling egg', () => {
    // the egg-drop row's falling egg sits mostly in the overflow cell of the sheet; it once became that
    // cell's main body and showed up bobbing under every full crate, while the pile's top was cut off
    const s = manifest.sprites['12-crate'];
    expect(s).toBeDefined();
    for (const [level, rows] of Object.entries(s?.frames ?? {})) {
      for (const row of ['empty', 'half', 'full', 'overflow']) {
        for (const [, , , h, , py] of rows[row] ?? []) expect(h, `${row} at ${level}: reaches ${h - (py ?? 0)} texels below the feet`).toBeLessThanOrEqual(py ?? 0);
      }
      const tallest = (row: string) => Math.max(...(rows[row] ?? []).map((f) => f[3]));
      // the overflowing pile is taller than a full crate, and the falling egg makes egg-drop taller than an empty crate
      expect(tallest('overflow'), `overflow at ${level}`).toBeGreaterThan(tallest('full') * 1.3);
      expect(tallest('egg-drop'), `egg-drop at ${level}`).toBeGreaterThan(tallest('empty') * 1.3);
    }
  });

  it('draws the world at the design sizes: a hen 32 world pixels, a coop and the farmhouse 96', () => {
    const tallest = (id: string, row: string) => Math.max(...(manifest.sprites[id]?.frames['4']?.[row] ?? []).map((f) => f[3])) / 4;
    expect(tallest('02-body', 'idle')).toBeGreaterThan(20);
    expect(tallest('02-body', 'idle')).toBeLessThanOrEqual(33);
    expect(tallest('15-coop-red', 'idle')).toBeGreaterThan(70);
    expect(tallest('15-coop-red', 'idle')).toBeLessThanOrEqual(96);
    expect(tallest('16-farmhouse', 'day')).toBeLessThanOrEqual(96);
  });
});
