// The world's layer order: every ground sprite draws below every object and hen, and objects in
// the depth layer draw in order of where their feet touch the ground.
import { describe, expect, it } from 'vitest';
import { Container } from 'pixi.js';
import { LAYERS, WorldLayers, depthOf } from '../src/pixi/farm/layers';
import { MIN_H, MIN_W, farmLayout } from '../src/pixi/farm/layout';

describe('world layers', () => {
  it('draws the ground under everything and sorts objects by their feet', () => {
    const w = new WorldLayers();
    const tile = w.add('groundAnim', new Container());
    tile.position.set(184, 296);
    const belt = w.add('floor', new Container());
    belt.position.set(200, 304);
    const hen = w.add('depth', new Container(), { x: 190, y: 290 });
    const coop = w.add('depth', new Container(), { x: 100, y: 132 });
    const crate = w.add('depth', new Container(), { x: 420, y: 314 });
    const order = w.drawOrder();
    const at = (o: Container) => order.findIndex((e) => e.obj === o);
    // ground and floor below every depth object, whatever their y
    for (const g of [tile, belt]) for (const o of [hen, coop, crate]) expect(at(g)).toBeLessThan(at(o));
    // depth by foot position
    expect(at(coop)).toBeLessThan(at(hen));
    expect(at(hen)).toBeLessThan(at(crate));
    expect(w.root.children.map((c) => w.drawOrder().find((e) => e.obj.parent === c)?.layer ?? LAYERS[w.root.children.indexOf(c)])).toEqual([...LAYERS]);
  });

  it('breaks ties left to right and never lets a lower foot draw first', () => {
    expect(depthOf(200, 10)).toBeLessThan(depthOf(200, 300));
    expect(depthOf(200, 1000)).toBeLessThan(depthOf(201, 0));
  });
});

describe('farm layout', () => {
  const sizes: [number, number, number, number][] = [
    [MIN_W, MIN_H + 66, 306, 66],
    [584, 430, 306, 66],
    [713, 408, 142, 22],
    [585, 318, 0, 0],
  ];
  it.each(sizes)('fills a %ix%i area and keeps the guide band ground only', (w, h, gw, gh) => {
    const l = farmLayout(w, h, { w: gw, h: gh });
    const objects = [...l.plots, l.farmhouse, l.sign, l.trough, l.sack, l.crate, ...Object.values(l.machines)];
    for (const o of objects) {
      expect(o.x, JSON.stringify(o)).toBeGreaterThan(0);
      expect(o.x).toBeLessThan(w);
      expect(o.y).toBeLessThan(l.fence.y);
      // nothing stands in the guide band
      expect(o.x > l.guide.right || o.y <= l.guide.top, `${JSON.stringify(o)} in the guide band`).toBe(true);
    }
    // the yard spreads across the area: at least half its width and a third of its height
    expect(l.yard.right - l.yard.left).toBeGreaterThan(w * 0.5);
    expect(l.yard.bottom - l.yard.top).toBeGreaterThan(Math.min(90, h / 3));
    // the conveyor runs on whole tiles up to the grader, and the fence's gate is on the path
    expect(l.conveyor.from % 16).toBe(0);
    expect(l.conveyor.to % 16).toBe(0);
    expect(l.conveyor.to).toBeLessThan(l.machines.grader.x);
    expect(l.fence.gate).toBe(l.path.x);
  });
});
