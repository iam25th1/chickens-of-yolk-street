// Where the tour's step box goes: beside the highlighted target with a pointer at it, never over
// the target, inside the area the box may use (the world zone), and clear of the UI
// zones it must not cover (the goal tracker and the toasts; the top bar and the side panel are
// outside the world zone). A step without a target centres the box. Pure, tested at many window
// sizes in test/tourPlace.test.ts.
import type { Rect } from '../app/viewport';
import { TOUR_BAND } from '../state/overlays';

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
  // no room beside it (a small window, the target in a corner): anywhere in the area that keeps the
  // target and the zones clear, the nearest to the target first; the box says what to do, unpointed
  for (const s of fits) {
    let best: { x: number; y: number; d: number } | null = null;
    for (let y = area.y; y + s.h <= area.y + area.h; y += 2) {
      for (let x = area.x; x + s.w <= area.x + area.w; x += 2) {
        if (!ok({ x, y, w: s.w, h: s.h }, clear)) continue;
        const d = Math.hypot(x + s.w / 2 - cx, y + s.h / 2 - cy);
        if (!best || d < best.d) best = { x, y, d };
      }
    }
    if (best) return { x: best.x, y: best.y, w: s.w, h: s.h, side: 'center', pointer: 0 };
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

/**
 * The tour's placement: beside the target in the world zone (or anywhere there that keeps it clear);
 * on a tall window whose farm has no such room, in the side panel's zone below the farm, pointing up
 * at it; with no target (or no room at all), centred in the world zone.
 */
export function placeForTour(
  target: Rect | null,
  sizes: { w: number; h: number }[],
  zones: { world: Rect; side: Rect; tracker: Rect; toasts: Rect },
  portrait: boolean,
): Placement | null {
  const area = { x: zones.world.x + 4, y: zones.world.y + 4, w: zones.world.w - 8, h: zones.world.h - 8 };
  const avoid = [zones.tracker, zones.toasts].map((r) => ({ x: r.x - 2, y: r.y - 2, w: r.w + 4, h: r.h + 4 }));
  const fit = (s: { w: number; h: number }, a: Rect) => ({ w: Math.min(s.w, a.w), h: s.h });
  const inWorld = placeTourBox(target, sizes.map((s) => fit(s, area)), area, avoid);
  if (inWorld || !target) return inWorld ?? placeTourBox(null, sizes.map((s) => fit(s, area)), area, avoid);
  if (portrait) {
    const below = { x: zones.side.x + 4, y: zones.side.y + 4, w: zones.side.w - 8, h: zones.side.h - 8 };
    const there = placeTourBox(target, sizes.map((s) => fit(s, below)), below, []);
    if (there) return there;
  }
  return placeTourBox(null, sizes.map((s) => fit(s, area)), area, avoid);
}

/**
 * The tour's placement while a card (a modal or a full page) is open: the card always wins, so the
 * bubble is never over it. It goes beside the card (on whichever side has room; the whole window
 * below the top bar may be used, as the card's backdrop covers it), with its pointer aimed at the
 * target inside the card; a target outside the card is kept clear too. The goal tracker and the toast
 * corner stay clear. Null when there is no room: the card then gives up room at its foot (dock).
 */
export function placeBesideCard(
  target: Rect | null,
  sizes: { w: number; h: number }[],
  zones: { top: Rect; tracker: Rect; toasts: Rect },
  ui: { w: number; h: number },
  card: Rect,
): Placement | null {
  const area = { x: 4, y: zones.top.h + 2, w: ui.w - 8, h: ui.h - zones.top.h - 6 };
  const pad = (r: Rect, n: number): Rect => ({ x: r.x - n, y: r.y - n, w: r.w + 2 * n, h: r.h + 2 * n });
  const avoid = [pad(zones.tracker, 2), pad(zones.toasts, 2), pad(card, 2)];
  const inCard = target !== null && overlaps(target, card);
  const toward = inCard || !target ? card : target;
  const fit = sizes.map((s) => ({ w: Math.min(s.w, area.w), h: s.h }));
  const p = placeTourBox(toward, fit, area, avoid);
  if (!p) return null;
  // the pointer: at the target itself when it is inside the card, along the edge that faces it
  if (inCard && target && p.side !== 'center') {
    const at = p.side === 'left' || p.side === 'right' ? target.y + target.h / 2 - p.y : target.x + target.w / 2 - p.x;
    return { ...p, pointer: clampPointer(at, p.side === 'left' || p.side === 'right' ? p.h : p.w) };
  }
  return p;
}

/**
 * The band under a full page where the tour's strip sits (the page keeps TOUR_BAND free at its foot
 * while the tour is on): the page's width, clear of the goal tracker and the toast corner (in
 * landscape they sit at the bottom left, so the strip starts right of them).
 */
export function pageBand(page: Rect, zones: { tracker: Rect; toasts: Rect }, uiW: number, portrait: boolean): Rect {
  const y = page.y + page.h + 3;
  const left = portrait ? page.x : Math.max(page.x, zones.tracker.x + zones.tracker.w + 6, zones.toasts.x + zones.toasts.w + 6);
  return { x: left, y, w: Math.min(uiW - 4, page.x + page.w) - left, h: TOUR_BAND - 6 };
}
