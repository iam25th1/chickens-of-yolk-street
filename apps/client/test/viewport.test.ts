// The layout: at every supported window size the UI zones never overlap, the modal and the guide
// stay clear of the HUD, the farm's composition fits whole in the world zone, and the goal tracker
// and toasts sit only over ground. Zooms are whole: nothing is ever drawn at a fractional scale.
import { describe, expect, it } from 'vitest';
import { measure, type Rect } from '../src/app/viewport';
import { COMP, SAFE_X, SAFE_Y } from '../src/pixi/farm/layout';

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
const inside = (a: Rect, b: Rect): boolean => a.x >= b.x - 0.01 && a.y >= b.y - 0.01 && a.x + a.w <= b.x + b.w + 0.01 && a.y + a.h <= b.y + b.h + 0.01;

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

  it('shows the whole farm in the world zone, with only ground under the guide', () => {
    const farm = {
      x: (v.farm.offX + COMP.left * v.farm.k) / v.p,
      y: (v.farm.offY + COMP.top * v.farm.k) / v.p,
      w: ((COMP.right - COMP.left) * v.farm.k) / v.p,
      h: ((COMP.bottom - COMP.top) * v.farm.k) / v.p,
    };
    expect(inside(farm, { x: 0, y: z.top.h, w: v.portrait ? v.uiW : z.side.x, h: v.uiH - z.top.h })).toBe(true);
    expect(overlap(farm, z.top)).toBe(false);
    if (!v.portrait) expect(overlap(farm, z.side)).toBe(false);
    // everything the farm draws above its safe line, and right of SAFE_X, stays clear of the guide
    const busy = { x: farm.x, y: farm.y, w: farm.w, h: ((SAFE_Y - COMP.top) * v.farm.k) / v.p };
    const right = { x: (v.farm.offX + SAFE_X * v.farm.k) / v.p, y: farm.y, w: ((COMP.right - SAFE_X) * v.farm.k) / v.p, h: farm.h };
    for (const g of [z.tracker, z.toasts]) {
      expect(overlap(busy, g)).toBe(false);
      expect(overlap(v.portrait ? farm : right, g)).toBe(false);
    }
  });
});
