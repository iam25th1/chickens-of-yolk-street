// The farm's layout spec: every connection lines up within one world pixel, no two footprints
// overlap, every object stays on the farm and out of the guide band, and every size matches the
// size table, at the five screens the game is checked at and across a sweep of farm areas.
import { describe, expect, it } from 'vitest';
import derived from '../src/assets/derived.json';
import { measure } from '../src/app/viewport';
import { HEN_PX, SIZE_TABLE } from '../src/pixi/farm/spec';
import { connectionGaps, farmLayout, MIN_H, MIN_W, type Box, type FarmLayout } from '../src/pixi/farm/layout';

const SCREENS: [number, number, number][] = [
  [1280, 720, 1],
  [1920, 1080, 1],
  [2560, 1440, 1],
  [390, 844, 3],
  [360, 640, 2],
];

const layouts = (): { name: string; l: FarmLayout }[] => {
  const out = SCREENS.map(([w, h, dpr]) => {
    const v = measure(w, h, dpr);
    return { name: `${w}x${h}`, l: farmLayout(v.farm.w, v.farm.h, v.farm.guide) };
  });
  // the viewport gives the farm MIN_H above the guide band, whatever the band
  for (let w = MIN_W; w <= 900; w += 37) for (let h = MIN_H; h <= 620; h += 41) for (const g of [{ w: 0, h: 0 }, { w: 310, h: 66 }]) out.push({ name: `${w}x${h} guide ${g.w}`, l: farmLayout(w, h + g.h, g) });
  return out;
};

const overlap = (a: Box, b: Box): boolean => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
/** Objects that are floor (the belt, the path, the gate): things stand on them by design. */
const FLOOR = new Set(['conveyor', 'path', 'gate']);

describe('the layout spec', () => {
  it('every connection lines up within one world pixel', () => {
    for (const { name, l } of layouts()) {
      for (const { c, gap } of connectionGaps(l)) expect(gap, `${name}: ${c.what}`).toBeLessThanOrEqual(1);
    }
  });

  it('no two footprints overlap', () => {
    for (const { name, l } of layouts()) {
      const solid = Object.entries(l.spec.objects).filter(([k]) => !FLOOR.has(k));
      for (let i = 0; i < solid.length; i++) {
        for (let j = i + 1; j < solid.length; j++) {
          const [a, oa] = solid[i] as [string, (typeof solid)[number][1]];
          const [b, ob] = solid[j] as [string, (typeof solid)[number][1]];
          expect(overlap(oa.footprint, ob.footprint), `${name}: ${a} and ${b}`).toBe(false);
        }
      }
    }
  });

  it('every object stands on the farm, anchors are whole pixels, and only ground sits in the guide band', () => {
    for (const { name, l } of layouts()) {
      for (const [k, o] of Object.entries(l.spec.objects)) {
        expect(Number.isInteger(o.at.x) && Number.isInteger(o.at.y), `${name}: ${k} anchor`).toBe(true);
        expect(o.box.left >= 0 && o.box.right <= l.w && o.box.top >= 0 && o.box.bottom <= l.h, `${name}: ${k} inside the farm`).toBe(true);
        if (k.startsWith('prop') || FLOOR.has(k)) continue;
        expect(overlap(o.box, l.guide), `${name}: ${k} under the guide`).toBe(false);
      }
      expect(l.yard.bottom - l.yard.top, `${name}: yard depth`).toBeGreaterThanOrEqual(56);
      expect(l.yard.right - l.yard.left, `${name}: yard width`).toBeGreaterThan(200);
    }
  });

  it('the fence runs the whole width with the gate where the path crosses it', () => {
    for (const { l } of layouts()) {
      expect(l.fence.gate).toBe(l.path.x);
      expect(l.gate.x).toBe(l.path.x);
      expect(l.spec.objects.path?.box.bottom).toBe(l.fence.y);
    }
  });
});

type D = { sprites: Record<string, { kind: string; levels: number[]; frames: Record<string, Record<string, number[][]>> }> };

describe('the size table', () => {
  it('every painted farm sheet is drawn at its size relative to the hen (within 3%)', () => {
    const sprites = (derived as unknown as D).sprites;
    for (const [thing, spec] of Object.entries(SIZE_TABLE)) {
      if ('note' in spec) continue;
      for (const id of spec.sprites) {
        // the golden and jumbo brown eggs, and the cheap and premium sacks, share their kind's scale
        if (['11-egg-golden', '11-egg-brown', '11-egg-cream', '13-sack-cheap', '13-sack-premium'].includes(id)) continue;
        const s = sprites[id];
        if (!s) throw new Error(id);
        const level = Math.max(...s.levels);
        const frames = s.frames[String(level)]?.[spec.row] ?? [];
        const px = Math.max(...frames.map((f) => (spec.by === 'height' ? (f[3] ?? 0) : (f[2] ?? 0)))) / level;
        if (thing === 'hen') continue;
        const rel = px / HEN_PX;
        expect(Math.abs(rel - spec.rel) / spec.rel, `${thing} (${id}): ${rel.toFixed(3)} vs ${spec.rel}`).toBeLessThan(0.035);
      }
    }
  });

  it('the hen, body and default comb together, is HEN_PX tall', () => {
    const sprites = (derived as unknown as D).sprites;
    let up = 0;
    let down = -Infinity;
    for (const id of ['02-body', '02-comb-default']) {
      const s = sprites[id];
      if (!s) throw new Error(id);
      const level = Math.max(...s.levels);
      for (const f of s.frames[String(level)]?.idle ?? []) {
        up = Math.max(up, (f[5] ?? 0) / level);
        down = Math.max(down, ((f[3] ?? 0) - (f[5] ?? 0)) / level);
      }
    }
    expect(Math.abs(up + down - HEN_PX)).toBeLessThan(0.6);
  });

  it('each size that differs from the brief says why', () => {
    for (const [thing, spec] of Object.entries(SIZE_TABLE)) {
      if (Math.abs(spec.rel - spec.brief) > 0.01) expect('note' in spec && spec.note.length > 20, thing).toBe(true);
    }
  });
});
