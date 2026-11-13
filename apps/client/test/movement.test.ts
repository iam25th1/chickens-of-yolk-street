// Hens stay in their areas and off what stands there, at any window size and through resizes.
import { describe, expect, it } from 'vitest';
import { measure } from '../src/app/viewport';
import { farmLayout, MIN_H, MIN_W, troughSpots, type Box, type FarmLayout, type Point } from '../src/pixi/farm/layout';
import { carry, clear, free, freeSpot, inside, movementAreas, nearestFree, route, walkable, type Areas } from '../src/pixi/farm/movement';

/** A seeded stream, so failures repeat. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const ALL = { builtPlots: [0, 1, 2, 3], unlocks: ['conveyor', 'grader', 'cart', 'hopper', 'clerk'] };
const NONE = { builtPlots: [0], unlocks: [] as string[] };

/** Window sizes and ratios: the checked screens, very wide, very tall, and a sweep. */
function windows(): [number, number, number][] {
  const out: [number, number, number][] = [
    [1280, 720, 1],
    [1440, 900, 1],
    [1920, 1080, 1],
    [2560, 1440, 1],
    [390, 844, 3],
    [360, 640, 2],
    [3440, 1000, 1],
    [2560, 600, 1],
    [800, 1400, 1],
    [600, 1900, 2],
    [1024, 1366, 2],
  ];
  for (let w = 700; w <= 2600; w += 380) for (let h = 520; h <= 1500; h += 245) out.push([w, h, 1]);
  return out;
}

const layoutFor = ([w, h, dpr]: [number, number, number]): FarmLayout => {
  const v = measure(w, h, dpr);
  return farmLayout(v.farm.w, v.farm.h, v.farm.guide);
};

/** A hen's footprint around her feet (what she covers on the ground). */
const henFoot = (p: Point): Box => ({ left: p.x - 9, top: p.y - 3, right: p.x + 9, bottom: p.y });
const overlap = (a: Box, b: Box): boolean => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

function standingFootprints(l: FarmLayout, opts: typeof ALL): Box[] {
  return Object.entries(l.spec.objects)
    .filter(([k]) => !['conveyor', 'path', 'gate'].includes(k))
    .filter(([k]) => !(k.startsWith('coop') && !opts.builtPlots.includes(Number(k.slice(4)))))
    .filter(([k]) => !(['grader', 'cart', 'hopper', 'clerk'].includes(k) && !opts.unlocks.includes(k)))
    .map(([, o]) => o.footprint);
}

function checkHenAt(p: Point, l: FarmLayout, a: Areas, opts: typeof ALL, what: string): void {
  expect(walkable(p, a), `${what}: (${p.x}, ${p.y}) outside the yard and path, or in a keep-out`).toBe(true);
  for (const f of standingFootprints(l, opts)) expect(overlap(henFoot(p), f), `${what}: hen at (${p.x}, ${p.y}) on a footprint`).toBe(false);
}

describe('where hens walk', () => {
  for (const opts of [ALL, NONE]) {
    it(`spots, trough places, roosts and every walk stay clear (${opts.unlocks.length} machines)`, () => {
      const rnd = rng(7);
      for (const win of windows()) {
        const l = layoutFor(win);
        const a = movementAreas(l, opts);
        const name = `${win[0]}x${win[1]}`;
        checkHenAt(a.arrive, l, a, opts, `${name} arrival`);
        checkHenAt(a.enter, l, a, opts, `${name} entry`);
        expect(clear(a.arrive, a.enter, a), `${name}: the turn into the yard`).toBe(true);
        for (const p of troughSpots(l).map((q) => nearestFree(q, a))) checkHenAt(p, l, a, opts, `${name} trough place`);
        const hens: Point[] = [];
        for (let i = 0; i < 40; i++) {
          const p = freeSpot(a, hens, rnd);
          checkHenAt(p, l, a, opts, `${name} spot`);
          expect(inside(p, a.yard)).toBe(true);
          hens.push(p);
        }
        // walks between them, and to the trough, go round everything standing
        for (let i = 0; i < 40; i++) {
          const from = hens[i] as Point;
          const to = i % 3 === 0 ? nearestFree(troughSpots(l)[i % 5] as Point, a) : (hens[(i * 7 + 3) % hens.length] as Point);
          const walk = route(from, to, a);
          let at = from;
          for (const step of walk) {
            expect(clear(at, step, a), `${name}: walk (${at.x},${at.y}) to (${step.x},${step.y}) crosses a keep-out`).toBe(true);
            at = step;
          }
        }
      }
    });
  }

  it('a resize sequence (wide, narrow, tall, wide) carries every hen to a free place in her area', () => {
    const seq: [number, number, number][] = [
      [2560, 1000, 1],
      [1280, 720, 1],
      [700, 720, 1],
      [390, 844, 3],
      [800, 1400, 1],
      [360, 640, 2],
      [1920, 1080, 1],
      [3440, 1000, 1],
      [1440, 900, 1],
    ];
    const rnd = rng(11);
    let l = layoutFor(seq[0] as [number, number, number]);
    let a = movementAreas(l, ALL);
    let hens: Point[] = [];
    for (let i = 0; i < 30; i++) hens.push(freeSpot(a, hens, rnd));
    hens.push(a.arrive);
    for (const win of seq.slice(1)) {
      const next = layoutFor(win);
      const b = movementAreas(next, ALL);
      hens = hens.map((p) => carry(p, a, b));
      for (const p of hens) checkHenAt(p, next, b, ALL, `after resizing to ${win[0]}x${win[1]}`);
      l = next;
      a = b;
    }
    expect(l.w).toBeGreaterThanOrEqual(MIN_W);
    expect(l.h).toBeGreaterThanOrEqual(MIN_H);
  });

  it('a hen carried across a resize keeps her place in the yard, not her old world position', () => {
    const wide = farmLayout(900, 500, { w: 0, h: 0 });
    const narrow = farmLayout(520, 320, { w: 0, h: 0 });
    const a = movementAreas(wide, NONE);
    const b = movementAreas(narrow, NONE);
    // the yard's far right, wide: after the resize she is near the new yard's far right
    const p = nearestFree({ x: wide.yard.right - 8, y: Math.round((wide.yard.top + wide.yard.bottom) / 2) }, a);
    const q = carry(p, a, b);
    expect(q.x).toBeGreaterThan(narrow.yard.right - 60);
    expect(free(q, b)).toBe(true);
  });
});
