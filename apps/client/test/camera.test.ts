// The farm's camera: with the home plot alone it never moves (the farm is exactly the farm area);
// with land it reaches every plot and no further, and a plot's camera shows that plot.
import { describe, expect, it } from 'vitest';
import { LAND_IDS, type LandId } from '@coys/shared';
import { measure } from '../src/app/viewport';
import { cameraOn, cameraRoom, canLook, clampCamera, inView } from '../src/pixi/farm/camera';
import { farmLayout } from '../src/pixi/farm/layout';

const SUBSETS: LandId[][] = Array.from({ length: 1 << LAND_IDS.length }, (_, m) => LAND_IDS.filter((_, i) => m & (1 << i)));

describe('the farm camera', () => {
  for (const [w, h, dpr] of [
    [1280, 720, 1],
    [1920, 1080, 1],
    [390, 844, 3],
  ] as const) {
    it(`at ${w}x${h}: still on the home plot alone, free across the land, never off the farm`, () => {
      const v = measure(w, h, dpr);
      for (const land of SUBSETS) {
        const l = farmLayout(v.farm.w, v.farm.h, v.farm.guide, land);
        const room = cameraRoom(l);
        if (!land.length) {
          expect(canLook(l)).toBe(false);
          expect(room).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
          expect(clampCamera({ x: 300, y: -200 }, l)).toEqual({ x: 0, y: 0 });
          continue;
        }
        expect(canLook(l)).toBe(true);
        // the view stays on the farm wherever it is pushed
        for (const p of [
          { x: -9999, y: -9999 },
          { x: 9999, y: 9999 },
          { x: 0, y: 0 },
        ]) {
          const c = clampCamera(p, l);
          expect(c.x).toBeGreaterThanOrEqual(l.world.left);
          expect(c.y).toBeGreaterThanOrEqual(l.world.top);
          expect(c.x + l.w).toBeLessThanOrEqual(l.world.right);
          expect(c.y + l.h).toBeLessThanOrEqual(l.world.bottom);
        }
        // the home plot is always one place it can be, and each plot's camera shows that plot's middle
        expect(clampCamera({ x: 0, y: 0 }, l)).toEqual({ x: 0, y: 0 });
        for (const p of l.land) {
          const c = cameraOn(p.box, l);
          expect(inView({ x: (p.box.left + p.box.right) / 2, y: (p.box.top + p.box.bottom) / 2 }, c, l, 0), `${land.join('+')}: ${p.id}`).toBe(true);
        }
      }
    });
  }
});
