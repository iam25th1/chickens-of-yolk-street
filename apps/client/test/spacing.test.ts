// Room on the farm: across a sweep of window sizes, every two things standing on the ground keep
// at least a hen's width between their footprints (except the pairs built to touch, which meet
// only at their connection points), the zones keep apart, and each machine's label has a place
// that covers nothing else.
import { describe, expect, it } from 'vitest';
import { measure } from '../src/app/viewport';
import { DESIGNED_PAIRS, FLOOR_OBJECTS, HEN_W, boxGap, connectionGaps, farmLayout, labelSpot, type FarmLayout, type ZoneName } from '../src/pixi/farm/layout';

function windows(): [number, number, number][] {
  const out: [number, number, number][] = [
    [1280, 720, 1],
    [1440, 900, 1],
    [1920, 1080, 1],
    [2560, 1440, 1],
    [390, 844, 3],
    [360, 640, 2],
    [412, 915, 2],
    [768, 1024, 2],
    [1180, 820, 2],
    [1680, 1050, 1],
    [3440, 1000, 1],
    [2560, 600, 1],
    [800, 1400, 1],
  ];
  for (let w = 700; w <= 2600; w += 380) for (let h = 520; h <= 1500; h += 245) out.push([w, h, 1]);
  return out;
}

const layoutFor = ([w, h, dpr]: [number, number, number]): FarmLayout => {
  const v = measure(w, h, dpr);
  return farmLayout(v.farm.w, v.farm.h, v.farm.guide);
};

const designed = (a: string, b: string) => DESIGNED_PAIRS.some(([x, y]) => (x === a && y === b) || (x === b && y === a));

describe('room on the farm', () => {
  it('every two things standing on the ground keep a hen width apart, except the pairs built to touch', () => {
    const problems: string[] = [];
    for (const win of windows()) {
      const l = layoutFor(win);
      const standing = Object.entries(l.spec.objects).filter(([k, o]) => !FLOOR_OBJECTS(k, o) || k === 'conveyor');
      for (let i = 0; i < standing.length; i++) {
        for (let j = i + 1; j < standing.length; j++) {
          const [a, oa] = standing[i] as [string, (typeof standing)[0][1]];
          const [b, ob] = standing[j] as [string, (typeof standing)[0][1]];
          if (designed(a, b)) continue;
          const gap = boxGap(oa.footprint, ob.footprint);
          if (gap < HEN_W) problems.push(`${win[0]}x${win[1]}: ${a} and ${b} ${gap.toFixed(1)} apart`);
        }
      }
      // the pairs built to touch meet at their connection points
      for (const g of connectionGaps(l)) if (g.gap > 1) problems.push(`${win[0]}x${win[1]}: ${g.c.what} off by ${g.gap.toFixed(1)}`);
    }
    expect(problems).toEqual([]);
  });

  it('the zones keep apart, and the stations are where they belong', () => {
    const problems: string[] = [];
    const apart: ZoneName[] = ['coops', 'feed', 'production', 'farmhouse', 'stall', 'cartBay'];
    for (const win of windows()) {
      const l = layoutFor(win);
      const z = l.zones;
      for (let i = 0; i < apart.length; i++) {
        for (let j = i + 1; j < apart.length; j++) {
          const a = apart[i] as ZoneName;
          const b = apart[j] as ZoneName;
          const gap = boxGap(z[a], z[b]);
          if (gap < 8) problems.push(`${win[0]}x${win[1]}: zones ${a} and ${b} ${gap.toFixed(1)} apart`);
        }
      }
      const o = l.spec.objects;
      const name = `${win[0]}x${win[1]}`;
      // the grader partway along the belt; the crate at its end; the feed corner in the yard
      const beltLen = l.conveyor.to - l.conveyor.from;
      const graderMid = ((o.grader?.box.left ?? 0) + (o.grader?.box.right ?? 0)) / 2;
      if (graderMid < l.conveyor.from + beltLen * 0.25 || graderMid > l.conveyor.to - beltLen * 0.1) problems.push(`${name}: grader not partway along the belt`);
      if ((o.trough?.box.left ?? 0) < l.yard.left || (o.trough?.box.right ?? 0) > l.yard.right) problems.push(`${name}: trough outside the yard`);
      // the stall by the path (below the line by the gate on a tall farm, at the line's end on a short
      // one), apart from the crate; the cart bay on the path
      if ((o.clerk?.box.right ?? 0) < l.path.x - 32) problems.push(`${name}: stall not by the path`);
      if ((o.cart?.box.right ?? 0) < l.path.x || (o.cart?.box.left ?? 0) > l.path.x + 16) problems.push(`${name}: cart not on the path`);
    }
    expect(problems).toEqual([]);
  });

  it("each machine's label has a place that covers nothing else", () => {
    const problems: string[] = [];
    for (const win of windows()) {
      const l = layoutFor(win);
      for (const [m, w] of [
        ['conveyor', 52],
        ['grader', 40],
        ['cart', 76],
        ['hopper', 64],
        ['clerk', 64],
        ['crate', 36],
      ] as const) {
        if (!labelSpot(l, m, w)) problems.push(`${win[0]}x${win[1]}: no label place for ${m}`);
      }
    }
    expect(problems).toEqual([]);
  });
});
