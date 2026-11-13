// Land on the farm: for every combination of owned plots (none to all four), at the checked screens
// and a sweep of farm areas, the layout spec holds as it does for the home plot alone (connections
// line up, no footprints overlap, standing things keep a hen's width apart, zones apart, everything
// on the farm, the home plot exactly as without land), the plots sit on their sides, the fence and
// gate follow the outline, and hens can walk to every pasture and back round everything standing.
import { describe, expect, it } from 'vitest';
import { ECONOMY, LAND_IDS, landCoopPlots, type LandId } from '@coys/shared';
import { measure } from '../src/app/viewport';
import { DESIGNED_PAIRS, FLOOR_OBJECTS, HEN_W, boxGap, connectionGaps, coopAt, coopSlots, depthOf, farmLayout, type Box, type Point } from '../src/pixi/farm/layout';
import { carry, clear, eggClear, free, freeSpot, inside, movementAreas, nearestFree, travel, walkable, type Areas } from '../src/pixi/farm/movement';

/** Every subset of the four plots. */
const SUBSETS: LandId[][] = Array.from({ length: 1 << LAND_IDS.length }, (_, m) => LAND_IDS.filter((_, i) => m & (1 << i)));

const SCREENS: [number, number, number][] = [
  [1280, 720, 1],
  [1920, 1080, 1],
  [2560, 1440, 1],
  [390, 844, 3],
  [360, 640, 2],
  [3440, 1000, 1],
  [800, 1400, 1],
];

const areas = (): { name: string; w: number; h: number; guide: { w: number; h: number } }[] => {
  const out = SCREENS.map(([w, h, dpr]) => {
    const v = measure(w, h, dpr);
    return { name: `${w}x${h}`, w: v.farm.w, h: v.farm.h, guide: v.farm.guide };
  });
  for (let w = 500; w <= 900; w += 100) for (let h = 274; h <= 620; h += 86) out.push({ name: `${w}x${h}`, w, h: h + 66, guide: { w: 310, h: 66 } });
  return out;
};

const overlap = (a: Box, b: Box): boolean => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
const designed = (a: string, b: string) => DESIGNED_PAIRS.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
const ALL_MACHINES = ['conveyor', 'grader', 'cart', 'hopper', 'clerk'];

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('the layout with land', () => {
  it('the home plot is laid out exactly as without land; each plot sits on its side, as deep as the economy says', () => {
    for (const a of areas()) {
      const home = farmLayout(a.w, a.h, a.guide);
      expect(home.land).toEqual([]);
      expect(home.world).toEqual({ left: 0, top: 0, right: home.w, bottom: home.h });
      for (const land of SUBSETS) {
        const l = farmLayout(a.w, a.h, a.guide, land);
        const name = `${a.name} ${land.join('+') || 'home'}`;
        // every home object stands where it does without land (the path and the gate run on to the south orchard's fence)
        for (const [k, o] of Object.entries(home.spec.objects)) {
          if (k === 'path' || k === 'gate') continue;
          expect(l.spec.objects[k], `${name}: ${k}`).toEqual(o);
        }
        expect(l.yard).toEqual(home.yard);
        expect(l.plots).toEqual(home.plots);
        expect(l.land.map((p) => p.id)).toEqual(LAND_IDS.filter((id) => land.includes(id)));
        for (const p of l.land) {
          const d = depthOf(p.id);
          const want: Record<LandId, Box> = {
            east: { left: l.w, top: 0, right: l.w + d, bottom: l.h },
            west: { left: -d, top: 0, right: 0, bottom: l.h },
            north: { left: 0, top: -d, right: l.w, bottom: 0 },
            south: { left: 0, top: l.h, right: l.w, bottom: l.h + d },
          };
          expect(p.box, `${name}: ${p.id}`).toEqual(want[p.id]);
          expect(p.coops.map((c) => c.plot)).toEqual(landCoopPlots(p.id));
          for (const c of p.coops) expect(coopAt(l, c.plot)).toEqual(c.at);
          expect(inside({ x: p.pasture.left, y: p.pasture.top }, p.box) && inside({ x: p.pasture.right, y: p.pasture.bottom }, p.box), `${name}: ${p.id} pasture on its plot`).toBe(true);
          expect(p.pasture.right - p.pasture.left, `${name}: ${p.id} pasture width`).toBeGreaterThanOrEqual(80);
          expect(p.pasture.bottom - p.pasture.top, `${name}: ${p.id} pasture depth`).toBeGreaterThanOrEqual(56);
        }
        expect(coopSlots(l)).toHaveLength(ECONOMY.coops.plots + l.land.reduce((n, p) => n + ECONOMY.land.plots[p.id].coopSlots, 0));
      }
    }
  });

  it('connections line up, no footprints overlap, standing things keep a hen width apart, everything is on the farm', () => {
    const problems: string[] = [];
    for (const a of areas()) {
      for (const land of SUBSETS) {
        const l = farmLayout(a.w, a.h, a.guide, land);
        const name = `${a.name} ${land.join('+') || 'home'}`;
        for (const { c, gap } of connectionGaps(l)) if (gap > 1) problems.push(`${name}: ${c.what} off by ${gap.toFixed(1)}`);
        const objs = Object.entries(l.spec.objects);
        for (const [k, o] of objs) {
          if (!Number.isInteger(o.at.x) || !Number.isInteger(o.at.y)) problems.push(`${name}: ${k} anchor not whole`);
          if (o.box.left < l.world.left || o.box.right > l.world.right || o.box.top < l.world.top || o.box.bottom > l.world.bottom) problems.push(`${name}: ${k} off the farm`);
        }
        const solid = objs.filter(([k]) => !['conveyor', 'path', 'gate'].includes(k));
        const standing = objs.filter(([k, o]) => !FLOOR_OBJECTS(k, o) || k === 'conveyor');
        for (let i = 0; i < solid.length; i++) {
          for (let j = i + 1; j < solid.length; j++) {
            const [ka, oa] = solid[i] as (typeof solid)[number];
            const [kb, ob] = solid[j] as (typeof solid)[number];
            if (overlap(oa.footprint, ob.footprint)) problems.push(`${name}: ${ka} and ${kb} overlap`);
          }
        }
        for (let i = 0; i < standing.length; i++) {
          for (let j = i + 1; j < standing.length; j++) {
            const [ka, oa] = standing[i] as (typeof standing)[number];
            const [kb, ob] = standing[j] as (typeof standing)[number];
            if (designed(ka, kb)) continue;
            const gap = boxGap(oa.footprint, ob.footprint);
            if (gap < HEN_W) problems.push(`${name}: ${ka} and ${kb} ${gap.toFixed(1)} apart`);
          }
        }
        // each plot's zones keep apart from the home plot's and from each other's
        const zones: [string, Box][] = [
          ...(['coops', 'feed', 'production', 'farmhouse', 'stall', 'cartBay'] as const).map((z) => [z, l.zones[z]] as [string, Box]),
          ...l.land.flatMap((p) => [[`${p.id} coops`, p.zones.coops] as [string, Box], [`${p.id} props`, p.zones.props] as [string, Box]]),
        ];
        for (let i = 0; i < zones.length; i++) {
          for (let j = i + 1; j < zones.length; j++) {
            const [za, ba] = zones[i] as [string, Box];
            const [zb, bb] = zones[j] as [string, Box];
            if (!za.includes(' ') && !zb.includes(' ')) continue;
            if (za.split(' ')[0] === zb.split(' ')[0] && za.includes(' ')) continue;
            if (boxGap(ba, bb) < 8) problems.push(`${name}: zones ${za} and ${zb} ${boxGap(ba, bb).toFixed(1)} apart`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('the fence follows the outline: the gate where the path meets the outer fence, the south orchard inside it', () => {
    for (const a of areas()) {
      for (const land of SUBSETS) {
        const l = farmLayout(a.w, a.h, a.guide, land);
        const south = l.land.find((p) => p.id === 'south');
        expect(l.fence.gate).toBe(l.path.x);
        expect(l.spec.objects.path?.box.bottom).toBe(l.fence.y);
        expect(l.fence.y).toBe(south ? south.box.bottom - 16 : l.h - 16);
        // a rail runs under the path's column at the gate's row (the gate goes in it)
        expect(l.fences.rails.some((r) => r.y === l.fence.y && r.left <= l.path.x - 16 && r.right >= l.path.x + 16)).toBe(true);
        // with the orchard, nothing on the home plot's old fence row is left across the path
        if (south) expect(l.fences.rails.some((r) => r.y === l.h - 16 && r.left < l.path.x && r.right > l.path.x)).toBe(false);
        for (const p of l.land) {
          // every plot has fence on its far side
          const far =
            p.id === 'east'
              ? l.fences.posts.some((f) => f.x >= p.box.right - 32)
              : p.id === 'west'
                ? l.fences.posts.some((f) => f.x === p.box.left)
                : p.id === 'north'
                  ? l.fences.rails.some((r) => r.y === p.box.top)
                  : l.fences.rails.some((r) => r.y === l.fence.y);
          expect(far, `${a.name}: fence beyond the ${p.id}`).toBe(true);
        }
      }
    }
  });
});

describe('hens on the land', () => {
  const check = (p: Point, a: Areas, what: string) => expect(walkable(p, a), `${what}: (${p.x}, ${p.y}) not walkable`).toBe(true);

  for (const built of ['none', 'all'] as const) {
    it(`every pasture has a clear lane from the yard; spots, walks there and back, and carries stay clear (${built} built)`, () => {
      const rnd = rng(17);
      for (const a of areas()) {
        for (const land of SUBSETS.filter((s) => s.length)) {
          const l = farmLayout(a.w, a.h, a.guide, land);
          const name = `${a.name} ${land.join('+')}`;
          const plots = built === 'all' ? [0, 1, 2, 3, ...land.flatMap(landCoopPlots)] : [0];
          const ar = movementAreas(l, { builtPlots: plots, unlocks: built === 'all' ? ALL_MACHINES : [] });
          expect(ar.fields.map((f) => f.id)).toEqual(l.land.map((p) => p.id));
          for (const f of ar.fields) {
            expect(f.lane.length, `${name}: a lane to the ${f.id}`).toBeGreaterThanOrEqual(2);
            const first = f.lane[0] as Point;
            const last = f.lane[f.lane.length - 1] as Point;
            expect(inside(first, ar.yard), `${name}: the ${f.id} lane starts in the yard`).toBe(true);
            expect(inside(last, f.box), `${name}: the ${f.id} lane ends in its pasture`).toBe(true);
            for (let i = 1; i < f.lane.length; i++) {
              const p = f.lane[i - 1] as Point;
              const q = f.lane[i] as Point;
              expect(clear(p, q, ar), `${name}: the ${f.id} lane leg ${i}`).toBe(true);
              check(q, ar, `${name} ${f.id} lane`);
            }
          }
          // hens spread over the yard and the pastures; walks between any two go round everything
          const spots: Point[] = [];
          for (const region of [ar.yard, ...ar.fields.map((f) => f.box)]) for (let i = 0; i < 4; i++) spots.push(freeSpot(ar, spots, rnd, 8, region));
          for (const p of spots) check(p, ar, `${name} spot`);
          for (let i = 0; i < spots.length; i++) {
            const from = spots[i] as Point;
            const to = spots[(i * 5 + 3) % spots.length] as Point;
            const walk = travel(from, to, ar);
            let at = from;
            for (const step of walk) {
              expect(clear(at, step, ar), `${name}: walk (${at.x},${at.y}) to (${step.x},${step.y}) crosses a keep-out`).toBe(true);
              at = step;
            }
            expect(at, `${name}: the walk from (${from.x},${from.y}) reaches (${to.x},${to.y})`).toEqual(to);
          }
          // an egg can hatch at the door of a coop on new land, in its pasture
          for (const p of l.land) {
            const door = p.coops[0]?.at as Point;
            let found = false;
            for (let dy = 14; dy < 80 && !found; dy += 4) found = eggClear({ x: door.x, y: door.y + dy }, ar);
            expect(found, `${name}: an egg by the ${p.id} coop's door`).toBe(true);
          }
          // a roost by any coop finds free ground near it
          for (const c of l.land.flatMap((p) => p.coops)) {
            const q = nearestFree({ x: c.at.x, y: c.at.y + 16 }, ar);
            check(q, ar, `${name} roost by coop ${c.plot}`);
            expect(Math.hypot(q.x - c.at.x, q.y - c.at.y), `${name}: roost by coop ${c.plot}`).toBeLessThan(80);
          }
        }
      }
    });
  }

  it('a resize carries a hen in a pasture to her place in the same pasture', () => {
    const land: LandId[] = ['east', 'west', 'north', 'south'];
    const wide = farmLayout(900, 500, { w: 0, h: 0 }, land);
    const narrow = farmLayout(520, 320, { w: 0, h: 0 }, land);
    const a = movementAreas(wide, { builtPlots: [0], unlocks: [] });
    const b = movementAreas(narrow, { builtPlots: [0], unlocks: [] });
    for (const f of a.fields) {
      const p = nearestFree({ x: f.box.right - 10, y: f.box.bottom - 10 }, a);
      const q = carry(p, a, b);
      const there = b.fields.find((x) => x.id === f.id) as (typeof b.fields)[number];
      expect(inside(q, there.box), f.id).toBe(true);
      expect(free(q, b)).toBe(true);
      expect(q.x).toBeGreaterThan(there.box.right - 60);
    }
  });
});
