// Where the tour's step box goes: beside the highlighted target with a pointer at it, never over
// the target, inside the area the box may use (the world zone), and clear of the UI
// zones it must not cover (the goal tracker and the toasts; the top bar and the side panel are
// outside the world zone). A step without a target centres the box. Pure, tested at many window
// sizes in test/tourPlace.test.ts.
import type { Rect } from '../app/viewport';

export type Side = 'right' | 'left' | 'below' | 'above' | 'center';

export interface Placement {
  x: number;
  y: number;
  w: number;
  h: number;
  side: Side;
  /** Where along the edge facing the target the pointer sits (from the box's left or top). */
  pointer: number;
}

/** Room between the box and its target (the pointer lives here). */
export const GAP = 10;

export const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
export const insideRect = (a: Rect, b: Rect): boolean => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;

/**
 * The box's place. `sizes` are the box's measured heights at the widths it can take, widest first.
 * `target` is the highlighted thing (null: none); `area` is where the box may be; `avoid` are the
 * zones it must not cover.
 */
export function placeTourBox(target: Rect | null, sizes: { w: number; h: number }[], area: Rect, avoid: Rect[]): Placement | null {
  const ok = (r: Rect, keepClear: Rect | null) => insideRect(r, area) && !avoid.some((z) => overlaps(r, z)) && !(keepClear && overlaps(r, keepClear));
  const fits = sizes.filter((s) => s.w <= area.w && s.h <= area.h);
  if (!fits.length) return null;

  if (!target) {
    for (const s of fits) {
      // the middle of the area, then slid up or down to clear the zones
      const x = Math.round(area.x + (area.w - s.w) / 2);
      const ideal = Math.round(area.y + (area.h - s.h) / 2);
      const y = slide(ideal, area.y, area.y + area.h - s.h, (yy) => ok({ x, y: yy, w: s.w, h: s.h }, null));
      if (y !== null) return { x, y, w: s.w, h: s.h, side: 'center', pointer: 0 };
    }
    return null;
  }

  // keep the target clear, with a little room round it (what to do is said in the box itself)
  const clear: Rect = { x: target.x - 3, y: target.y - 3, w: target.w + 6, h: target.h + 6 };
  const cx = target.x + target.w / 2;
  const cy = target.y + target.h / 2;
  const room = {
    right: area.x + area.w - (target.x + target.w),
    left: target.x - area.x,
    below: area.y + area.h - (target.y + target.h),
    above: target.y - area.y,
  };
  const order = (['right', 'left', 'below', 'above'] as const).slice().sort((a, b) => room[b] - room[a]);
  for (const s of fits) {
    for (const side of order) {
      if (side === 'right' || side === 'left') {
        const x = side === 'right' ? Math.round(target.x + target.w + GAP) : Math.round(target.x - GAP - s.w);
        const y = slide(Math.round(cy - s.h / 2), area.y, area.y + area.h - s.h, (yy) => ok({ x, y: yy, w: s.w, h: s.h }, clear));
        if (y !== null) return { x, y, w: s.w, h: s.h, side, pointer: clampPointer(cy - y, s.h) };
      } else {
        const y = side === 'below' ? Math.round(clear.y + clear.h + GAP / 2) : Math.round(clear.y - GAP / 2 - s.h);
        const x = slide(Math.round(cx - s.w / 2), area.x, area.x + area.w - s.w, (xx) => ok({ x: xx, y, w: s.w, h: s.h }, clear));
        if (x !== null) return { x, y, w: s.w, h: s.h, side, pointer: clampPointer(cx - x, s.w) };
        // straight above or below may be taken by a zone (the toasts): further away on that side
        const far = slide(y, area.y, area.y + area.h - s.h, (yy) => (side === 'below' ? yy >= y : yy <= y) && ok({ x: clampX(cx, s.w, area), y: yy, w: s.w, h: s.h }, clear));
        if (far !== null) {
          const xx = clampX(cx, s.w, area);
          return { x: xx, y: far, w: s.w, h: s.h, side, pointer: clampPointer(cx - xx, s.w) };
        }
      }
    }
  }
  return null;
}

const clampX = (cx: number, w: number, area: Rect) => Math.round(Math.min(Math.max(cx - w / 2, area.x), area.x + area.w - w));
const clampPointer = (at: number, len: number) => Math.round(Math.min(Math.max(at, 10), len - 10));

/** The valid position nearest `ideal` between lo and hi, trying every whole step outward. */
function slide(ideal: number, lo: number, hi: number, valid: (p: number) => boolean): number | null {
  if (hi < lo) return null;
  const start = Math.min(Math.max(ideal, lo), hi);
  for (let d = 0; d <= hi - lo; d += 2) {
    if (start - d >= lo && valid(start - d)) return start - d;
    if (start + d <= hi && valid(start + d)) return start + d;
  }
  return null;
}
