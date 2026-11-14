// The tour box beside its target: at the four checked window sizes (and a few more), for targets
// across the farm, the side panel, the top bar and an open modal, the box always finds a place,
// never covers the target, stays in the world zone and clear of the tracker and toasts.
import { describe, expect, it } from 'vitest';
import { measure, type Rect } from '../src/app/viewport';
import { TOUR_BAND } from '../src/state/overlays';
import { insideRect, overlaps, pageBand, placeBesideCard, placeForTour, placeTourBox } from '../src/ui/tourPlace';

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

  // the live box with its controls is taller; on a small phone a target near the middle can leave no
  // room in the farm: the box then goes anywhere clear, or below the farm over the side panel's zone
  // (pointing up), and never over its target
  for (const [w, h, dpr] of [
    [360, 640, 2],
    [390, 844, 3],
  ] as const) {
    it(`keeps a tall box off its target at ${w}x${h}`, () => {
      const v = measure(w, h, dpr);
      const z = v.zones;
      const tall = [
        { w: 264, h: 150 },
        { w: 220, h: 170 },
        { w: 180, h: 200 },
        { w: 150, h: 230 },
      ];
      const avoid = [z.tracker, z.toasts];
      const rnd = rng(w + h * 3);
      for (let i = 0; i < 300; i++) {
        const t = { x: Math.round(z.world.x + 4 + rnd() * (z.world.w - 20)), y: Math.round(z.world.y + 4 + rnd() * (z.world.h - 20)), w: 12, h: 12 };
        if (avoid.some((a) => overlaps(t, a))) continue;
        const p = placeForTour(t, tall, z, v.portrait);
        expect(p, `no place for a target at ${t.x},${t.y}`).not.toBeNull();
        if (!p) continue;
        const box = { x: p.x, y: p.y, w: p.w, h: p.h };
        expect(overlaps(box, t), `box over its target at ${t.x},${t.y}`).toBe(false);
        expect(insideRect(box, { x: 0, y: z.world.y, w: v.uiW, h: v.uiH - z.world.y }), 'box off the screen or over the top bar').toBe(true);
        for (const a of avoid) expect(overlaps(box, a), 'box over the tracker or toasts').toBe(false);
      }
    });
  }
});

describe('the tour box beside an open card', () => {
  for (const [w, h, dpr] of [
    [1280, 720, 1],
    [1920, 1080, 1],
    [390, 844, 3],
    [360, 640, 2],
    [768, 1024, 2],
  ] as const) {
    it(`always finds a place beside a modal card, never over it, the tracker or the toast corner, at ${w}x${h}`, () => {
      const v = measure(w, h, dpr);
      const z = v.zones;
      const ui = { w: v.uiW, h: v.uiH };
      // the step box's widths as the tour measures them, with the narrow one for the column beside a card
      const sizes = [...SIZES, { w: 128, h: 200 }];
      for (const cw of [300, 340, 420, 444, 520]) {
        for (const ch of [120, 200, 268, 400]) {
          // a modal centred in its zone, as Modal.tsx places it
          const width = Math.min(cw, Math.floor(z.modal.w));
          const height = Math.min(ch, Math.floor(z.modal.h));
          const card: Rect = { x: Math.round(z.modal.x + (z.modal.w - width) / 2), y: Math.round(z.modal.y + (z.modal.h - height) / 2), w: width, h: height };
          const target: Rect = { x: card.x + card.w - 40, y: card.y + 4, w: 30, h: 14 };
          const p = placeBesideCard(target, sizes, z, ui, card);
          expect(p, `${cw}x${ch}: no place`).not.toBeNull();
          if (!p) continue;
          const box = { x: p.x, y: p.y, w: p.w, h: p.h };
          expect(overlaps(box, card), `${cw}x${ch}: over the card`).toBe(false);
          expect(overlaps(box, z.toasts), `${cw}x${ch}: over the toasts`).toBe(false);
          expect(overlaps(box, z.tracker), `${cw}x${ch}: over the tracker`).toBe(false);
          expect(insideRect(box, { x: 0, y: z.top.h, w: v.uiW, h: v.uiH - z.top.h }), `${cw}x${ch}: off the window`).toBe(true);
        }
      }
    });

    it(`puts the strip under a full page clear of the tracker and the toast corner at ${w}x${h}`, () => {
      const v = measure(w, h, dpr);
      const z = v.zones;
      const page: Rect = { x: 4, y: z.top.h + 4, w: v.uiW - 8, h: v.uiH - z.top.h - 8 - TOUR_BAND };
      const b = pageBand(page, z, v.uiW, v.portrait);
      expect(b.w).toBeGreaterThanOrEqual(200);
      expect(overlaps(b, page)).toBe(false);
      if (!v.portrait) {
        expect(overlaps(b, z.toasts)).toBe(false);
        expect(overlaps(b, z.tracker)).toBe(false);
      }
      expect(b.y + b.h).toBeLessThanOrEqual(v.uiH);
    });
  }
});
