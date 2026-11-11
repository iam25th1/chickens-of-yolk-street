// Every animation of every derived sprite: the right rows, frame counts and durations from the
// packed sheet's anim JSON, never a blank frame, and never a neighbouring row's pixels (a frame that
// picked up the hen above or below would be too tall, off centre or about twice as heavy).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { derive, EXACT_GROUP, PAINTED, type DerivedManifest, type SheetJson, type SourceSprite } from '../lib/derive';
import { decodePng, type Rgba } from '../lib/png';

const root = fileURLToPath(new URL('../..', import.meta.url));
const assets = join(root, 'apps/client/public/assets');
const manifest = JSON.parse(readFileSync(join(root, 'apps/client/src/assets/derived.json'), 'utf8')) as DerivedManifest;
const index = JSON.parse(readFileSync(join(assets, 'index.json'), 'utf8')) as {
  sprites: Record<string, { json: string; png: string; grid: number; rows: Record<string, { mode: 'loop' | 'once' }> }>;
  traits: { bodyRecolour: Record<string, [[number, number, number], [number, number, number]]> };
};
const atlases = new Map<string, Rgba>();
const atlas = (group: string): Rgba => {
  const a = manifest.atlases[group];
  if (!a) throw new Error(`no atlas ${group}`);
  let img = atlases.get(group);
  if (!img) {
    img = decodePng(readFileSync(join(assets, 'derived', a.file)));
    atlases.set(group, img);
  }
  return img;
};
const sourceJson = (id: string): SheetJson => JSON.parse(readFileSync(join(assets, index.sprites[id.split('@')[0] as string]?.json ?? ''), 'utf8')) as SheetJson;

describe('derived sprites', () => {
  const ids = Object.keys(manifest.sprites);

  it('covers every sheet the game draws, hen body colours included', () => {
    for (const id of [...Object.keys(PAINTED), ...Object.keys(EXACT_GROUP), '02-body@brown', '02-body@black']) expect(ids).toContain(id);
  });

  it.each(ids)('%s plays only its named rows, with their frame counts and durations', (id) => {
    const json = sourceJson(id);
    const s = manifest.sprites[id];
    expect(Object.keys(s?.rows ?? {})).toEqual(Object.keys(json.animations));
    for (const [row, names] of Object.entries(json.animations)) {
      const frames = s?.rows[row]?.frames ?? [];
      expect(frames.length, `${id}/${row}`).toBe(names.length);
      names.forEach((n, i) => expect(frames[i]?.[6], `${id}/${row}/${i}`).toBe(json.frames[n]?.duration || 100));
      expect(s?.rows[row]?.mode).toBe(index.sprites[id.split('@')[0] as string]?.rows[row]?.mode ?? 'loop');
    }
  });

  it.each(ids)('%s: every frame is drawn and holds only its own cell', (id) => {
    const s = manifest.sprites[id];
    if (!s) throw new Error(id);
    const img = atlas(s.group);
    const painted = Boolean(PAINTED[id.split('@')[0] as string]);
    const json = sourceJson(id);
    const first = Object.values(json.frames)[0];
    const cellW = (first?.frame.w ?? 0) / s.grid;
    const cellH = (id.startsWith('02-') || id === '01-hen-anims' ? 256 : (first?.frame.h ?? 0)) / s.grid;
    const masses: number[] = [];
    const checks: { key: string; mass: number; h: number; cx: number; cy: number }[] = [];
    for (const [row, r] of Object.entries(s.rows))
      r.frames.forEach(([x, y, w, h, px, py], i) => {
        let mass = 0;
        let sx = 0;
        let sy = 0;
        let top = Infinity;
        let bottom = -Infinity;
        for (let yy = 0; yy < h; yy++)
          for (let xx = 0; xx < w; xx++)
            if ((img.data[((y + yy) * img.width + x + xx) * 4 + 3] ?? 0) > 0) {
              mass++;
              sx += xx - px;
              sy += yy - py;
              top = Math.min(top, yy);
              bottom = Math.max(bottom, yy);
            }
        const key = `${id}/${row}/${i}`;
        // trait layers (eyes, hats) are small or blank where a pose hides them; the body never is
        const layer = /^02-(eyes|acc|comb)/.test(id);
        if (!layer) expect(mass, `${key} is blank`).toBeGreaterThan(3);
        if (mass) {
          masses.push(mass);
          checks.push({ key, mass, h: bottom - top + 1, cx: sx / mass, cy: sy / mass });
        }
      });
    if (!painted) return;
    const median = [...masses].sort((a, b) => a - b)[Math.floor(masses.length / 2)] ?? 1;
    for (const c of checks) {
      expect(c.h, `${c.key} is taller than its cell`).toBeLessThanOrEqual(Math.ceil(cellH * 1.45));
      expect(Math.abs(c.cx), `${c.key} is off its cell sideways`).toBeLessThanOrEqual(cellW / 2);
      expect(c.cy, `${c.key} hangs below its feet`).toBeLessThanOrEqual(cellH * 0.25);
      // a comb or hat sits on top of the hen, about a cell above her feet; the row above is two
      expect(c.cy, `${c.key} sits in the row above`).toBeGreaterThanOrEqual(-cellH * (/^02-(comb|acc)/.test(id) ? 1.3 : 1.05));
      expect(c.mass, `${c.key} holds a neighbour's pixels`).toBeLessThanOrEqual(Math.max(median * 1.8, 40));
    }
  });

  it('matches what derive-assets builds from the packed sheets (no stale atlases)', () => {
    const sprites: Record<string, SourceSprite> = {};
    for (const id of [...Object.keys(EXACT_GROUP), ...Object.keys(PAINTED)]) {
      const e = index.sprites[id];
      if (!e) throw new Error(id);
      sprites[id] = { id, png: decodePng(readFileSync(join(assets, e.png))), json: JSON.parse(readFileSync(join(assets, e.json), 'utf8')) as SheetJson, rows: e.rows, grid: e.grid };
    }
    const out = derive({ sprites, bodyRecolour: index.traits.bodyRecolour });
    expect(JSON.stringify(out.manifest)).toBe(JSON.stringify(manifest));
    for (const [name, bytes] of out.files) {
      const p = join(assets, 'derived', name);
      expect(existsSync(p), name).toBe(true);
      expect(Buffer.from(readFileSync(p)).equals(Buffer.from(bytes)), name).toBe(true);
    }
  }, 180_000);
});
