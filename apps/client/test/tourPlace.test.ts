// The tour box beside its target: at the four checked window sizes (and a few more), for targets
// across the farm, the side panel, the top bar and an open modal, the box always finds a place,
// never covers the target, stays in the world zone and clear of the tracker and toasts.
import { describe, expect, it } from 'vitest';
import { measure, type Rect } from '../src/app/viewport';
import { insideRect, overlaps, placeTourBox } from '../src/ui/tourPlace';

const SIZES = [
  { w: 264, h: 96 },
  { w: 216, h: 112 },
  { w: 176, h: 132 },
  { w: 140, h: 164 },
];

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

describe('the tour box', () => {
  for (const [w, h, dpr] of [
    [1280, 720, 1],
    [1920, 1080, 1],
    [390, 844, 3],
    [360, 640, 2],
    [1440, 900, 1],
    [412, 915, 2],
  ] as const) {
    it(`finds a place beside every target at ${w}x${h}`, () => {
      const v = measure(w, h, dpr);
      const z = v.zones;
      const area = { x: z.world.x + 4, y: z.world.y + 4, w: z.world.w - 8, h: z.world.h - 8 };
      const avoid = [z.tracker, z.toasts].map((r) => ({ x: r.x - 2, y: r.y - 2, w: r.w + 4, h: r.h + 4 }));
      const rnd = rng(w * 7 + h);
      const targets: Rect[] = [];
      // small things on the farm (eggs, the trough, a machine), clear of the tracker and toasts
      for (let i = 0; i < 300; i++) {
        const tw = 8 + Math.round(rnd() * 40);
        const th = 8 + Math.round(rnd() * 40);
        const t = { x: Math.round(z.world.x + rnd() * (z.world.w - tw)), y: Math.round(z.world.y + rnd() * (z.world.h - th)), w: tw, h: th };
        if (!avoid.some((a) => overlaps(t, a))) targets.push(t);
      }
      // the side panel (sell button, waiting cards), the top bar's buttons, a tab in an open modal
      targets.push({ x: z.side.x + 4, y: z.side.y + 150, w: 128, h: 14 }, { x: z.side.x + 10, y: z.side.y + 4, w: 100, h: 24 });
      targets.push({ x: z.top.x + z.top.w - 60, y: z.top.y + 2, w: 18, h: 16 }, { x: z.top.x + 4, y: z.top.y + 2, w: 18, h: 16 });
      targets.push({ x: z.modal.x + 10, y: z.modal.y + 20, w: 50, h: 14 }, { x: z.modal.x + z.modal.w - 70, y: z.modal.y + z.modal.h - 30, w: 60, h: 14 });
      for (const t of targets) {
        const p = placeTourBox(t, SIZES, area, avoid);
        expect(p, `no place for a target at ${t.x},${t.y} ${t.w}x${t.h}`).not.toBeNull();
        if (!p) continue;
        const box = { x: p.x, y: p.y, w: p.w, h: p.h };
        expect(insideRect(box, area), `box ${JSON.stringify(box)} outside the world zone`).toBe(true);
        expect(overlaps(box, t), `box over the target ${JSON.stringify(t)}`).toBe(false);
        for (const a of avoid) expect(overlaps(box, a), 'box over the tracker or toasts').toBe(false);
      }
      // and without a target: centred
      const c = placeTourBox(null, SIZES, area, avoid);
      expect(c?.side).toBe('center');
    });
  }
});
