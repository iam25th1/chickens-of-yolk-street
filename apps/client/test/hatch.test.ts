// New hens hatch from eggs dropped in the yard: every egg lands in a free yard spot, clear of every
// object, the path and the other hens and eggs, at any window size.
import { describe, expect, it } from 'vitest';
import { measure } from '../src/app/viewport';
import { farmLayout, type Box, type FarmLayout, type Point } from '../src/pixi/farm/layout';
import { EGG_H, EGG_HALF_W, freeSpot, hatchSpots, inside, movementAreas, walkable } from '../src/pixi/farm/movement';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const SCREENS: [number, number, number][] = [
  [1280, 720, 1],
  [1920, 1080, 1],
  [2560, 1440, 1],
  [390, 844, 3],
  [360, 640, 2],
  [800, 1400, 1],
  [3440, 1000, 1],
];
const OPTS = [
  { builtPlots: [0], unlocks: [] as string[] },
  { builtPlots: [0, 1, 2, 3], unlocks: ['conveyor', 'grader', 'cart', 'hopper', 'clerk'] },
];

const layoutFor = ([w, h, dpr]: [number, number, number]): FarmLayout => {
  const v = measure(w, h, dpr);
  return farmLayout(v.farm.w, v.farm.h, v.farm.guide);
};
/** The egg's box on the ground (its feet at p). */
const eggBox = (p: Point): Box => ({ left: p.x - EGG_HALF_W, top: p.y - EGG_H / 2, right: p.x + EGG_HALF_W, bottom: p.y });
const henBox = (p: Point): Box => ({ left: p.x - 9, top: p.y - 3, right: p.x + 9, bottom: p.y });
const overlap = (a: Box, b: Box): boolean => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

function objectBoxes(l: FarmLayout, opts: (typeof OPTS)[number]): [string, Box][] {
  return Object.entries(l.spec.objects)
    .filter(([k]) => !(k.startsWith('coop') && !opts.builtPlots.includes(Number(k.slice(4)))))
    .filter(([k]) => !(['conveyor', 'grader', 'cart', 'hopper', 'clerk'].includes(k) && !opts.unlocks.includes(k)))
    .map(([k, o]) => [k, o.footprint] as [string, Box]);
}

describe('hatching', () => {
  for (const n of [1, 5]) {
    it(`${n} new hen${n > 1 ? 's' : ''}: each egg lands in a free yard spot, apart, and she wanders inside the yard`, () => {
      const rnd = rng(7 + n);
      for (const s of SCREENS) {
        const l = layoutFor(s);
        for (const opts of OPTS) {
          const a = movementAreas(l, opts);
          const flock: Point[] = [];
          for (let i = 0; i < 6; i++) flock.push(freeSpot(a, flock, rnd));
          const spots = hatchSpots(a, flock, n, rnd);
          const what = `${s[0]}x${s[1]} plots ${opts.builtPlots.length}`;
          expect(spots).toHaveLength(n);
          spots.forEach((p, i) => {
            const box = eggBox(p);
            for (const c of [p, { x: box.left, y: box.top }, { x: box.right, y: box.top }, { x: box.left, y: box.bottom }, { x: box.right, y: box.bottom }]) {
              expect(inside(c, a.yard), `${what}: egg ${i} at (${p.x}, ${p.y}) leaves the yard`).toBe(true);
            }
            expect(overlap(box, a.path), `${what}: egg ${i} on the path`).toBe(false);
            for (const [k, f] of objectBoxes(l, opts)) expect(overlap(box, f), `${what}: egg ${i} on ${k}`).toBe(false);
            for (const h of flock) expect(overlap(box, henBox(h)), `${what}: egg ${i} on a hen`).toBe(false);
            spots.forEach((q, j) => {
              if (j > i) expect(overlap(box, eggBox(q)), `${what}: eggs ${i} and ${j} overlap`).toBe(false);
            });
            // the hen pops out where her egg was and wanders from there: a walkable yard spot
            expect(walkable(p, a) && inside(p, a.yard), `${what}: hen ${i} hatches outside the yard`).toBe(true);
          });
        }
      }
    });
  }
});
