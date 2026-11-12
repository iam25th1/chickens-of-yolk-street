// The layout: at every supported window size the UI zones never overlap, the modal and the guide
// stay clear of the HUD, the farm fills the world zone, and the goal tracker and toasts sit only
// over ground. Zooms are whole: nothing is ever drawn at a fractional scale.
import { describe, expect, it } from 'vitest';
import { measure, type Rect } from '../src/app/viewport';
import { MIN_H, MIN_W, farmLayout } from '../src/pixi/farm/layout';

const SIZES: [number, number, number][] = [
  [1280, 720, 1],
  [1440, 900, 1],
  [1920, 1080, 1],
  [2560, 1440, 1],
  [2560, 1440, 2],
  [1280, 642, 2],
  [1440, 900, 2],
  [390, 844, 3],
];

const overlap = (a: Rect, b: Rect): boolean => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.01 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0.01;

describe.each(SIZES)('layout at %ix%i, %i device pixels per CSS pixel', (w, h, dpr) => {
  const v = measure(w, h, dpr);
  const z = v.zones;

  it('uses whole zooms for the UI and the world, at a readable size', () => {
    expect(Number.isInteger(v.p)).toBe(true);
    expect(Number.isInteger(v.farm.k)).toBe(true);
    expect(Number.isInteger(v.farm.offX) && Number.isInteger(v.farm.offY)).toBe(true);
    expect(v.p).toBeGreaterThanOrEqual(2);
    expect(v.farm.k).toBeGreaterThanOrEqual(2);
    // body text (8 UI pixels) is at least 16 device pixels
    expect(8 * v.p).toBeGreaterThanOrEqual(16);
  });

  it('keeps the top bar, side panel, tracker and toast area apart', () => {
    const zones = [z.top, z.side, z.tracker, z.toasts];
    for (let i = 0; i < zones.length; i++) for (let j = i + 1; j < zones.length; j++) expect(overlap(zones[i] as Rect, zones[j] as Rect), `${i} x ${j}`).toBe(false);
    expect(z.toasts.h).toBeGreaterThanOrEqual(14);
    expect(z.toasts.y + z.toasts.h).toBeLessThanOrEqual(z.tracker.y);
  });

  it('opens the modal clear of the top bar, the guide zone and (in landscape) the side panel', () => {
    for (const other of [z.top, z.tracker, z.toasts, ...(v.portrait ? [] : [z.side])]) expect(overlap(z.modal, other)).toBe(false);
    expect(z.modal.w).toBeGreaterThanOrEqual(340);
    expect(z.modal.h).toBeGreaterThanOrEqual(200);
  });

  it('fills the world zone with the farm, with only ground under the guide', () => {
    const f = v.farm;
    const toUi = (x: number, y: number) => ({ x: (f.offX + x * f.k) / v.p, y: (f.offY + y * f.k) / v.p });
    // the farm area is the free zone (to within a world pixel)
    const o = toUi(0, 0);
    const end = toUi(f.w, f.h);
    expect(o.x).toBeCloseTo(v.portrait ? 0 : z.world.x, 5);
    expect(o.y).toBeCloseTo(z.top.h, 5);
    expect(end.x).toBeLessThanOrEqual((v.portrait ? v.uiW : z.side.x) + 0.01);
    expect(end.x).toBeGreaterThan((v.portrait ? v.uiW : z.side.x) - f.k / v.p - 0.01);
    expect(f.w).toBeGreaterThanOrEqual(MIN_W);
    expect(f.h).toBeGreaterThanOrEqual(MIN_H);
    // the guide band covers the tracker and the toasts (landscape); in portrait they sit below the farm
    const l = farmLayout(f.w, f.h, f.guide);
    if (v.portrait) expect(z.toasts.y).toBeGreaterThanOrEqual(end.y);
    else {
      const band = { ...toUi(0, l.guide.top), r: toUi(l.guide.right, 0).x };
      expect(band.r).toBeGreaterThanOrEqual(z.tracker.x + z.tracker.w);
      expect(band.y).toBeLessThanOrEqual(z.toasts.y + 0.01);
    }
    // nothing the farm stands up sits in the guide band
    for (const p of [...l.plots, l.farmhouse, l.sign, l.trough, l.sack, l.crate, ...Object.values(l.machines)]) {
      const at = toUi(p.x, p.y);
      for (const g of v.portrait ? [] : [z.tracker, z.toasts]) expect(at.x > g.x + g.w || at.y < g.y, JSON.stringify(p)).toBe(true);
    }
  });
});
