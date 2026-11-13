// Where hens may walk, from the layout spec: the straw yard, and the path down from the porch they
// arrive by. Standing objects (the trough, the sack, the hopper, props, signs, machines, coops) are
// keep-out boxes: a hen's feet never stand in one and her walks go round them. Every point is in
// world units; on a resize, positions are carried over relative to the yard, so a hen keeps her
// place in the composition instead of a stale spot. Pure functions, tested in test/movement.test.ts.
import type { Box, FarmLayout, Point } from './layout';

/** Half a hen's width and how far her body reaches above her feet, in world pixels. */
const HEN_HALF = 10;

export interface Areas {
  yard: Box;
  /** The path corridor hens arrive by: from the porch steps down to where they turn into the yard. */
  path: Box;
  /** Where hens may not stand. */
  keepOut: Box[];
  /** Where an arriving hen appears (on the path) and the yard edge she walks in by. */
  arrive: Point;
  enter: Point;
}

export const inside = (p: Point, b: Box): boolean => p.x >= b.left && p.x <= b.right && p.y >= b.top && p.y <= b.bottom;

/** Objects hens may walk on (floor) or that are not on the ground they walk. */
const FLOOR = new Set(['conveyor', 'path', 'gate']);

/**
 * Hens' walkable areas and keep-out boxes for a layout. A keep-out covers an object's lower art
 * (where a hen's feet would be inside it) down to just below its footprint, a hen's half width wider.
 * Coops on plots that have none yet, and machines not bought, do not stand there.
 */
export function movementAreas(l: FarmLayout, opts: { builtPlots: number[]; unlocks: string[] }): Areas {
  const keepOut: Box[] = [];
  for (const [name, o] of Object.entries(l.spec.objects)) {
    if (FLOOR.has(name)) continue;
    if (name.startsWith('coop') && !opts.builtPlots.includes(Number(name.slice(4)))) continue;
    if (['grader', 'cart', 'hopper', 'clerk'].includes(name) && !opts.unlocks.includes(name)) continue;
    const h = o.box.bottom - o.box.top;
    keepOut.push({ left: o.box.left - HEN_HALF, top: o.box.top + h * 0.45, right: o.box.right + HEN_HALF, bottom: o.footprint.bottom + 3 });
  }
  const pathLeft = l.path.x - 16;
  const sign = l.spec.objects.sign;
  // hens come down the path from the porch and turn into the yard in the gap below the farm sign
  const enterY = Math.round(Math.min(l.yard.bottom - 4, sign ? sign.footprint.bottom + 10 : (l.yard.top + l.yard.bottom) / 2));
  const path: Box = { left: pathLeft + 2, top: l.path.top + 4, right: l.path.x + 14, bottom: enterY + 4 };
  return { yard: l.yard, path, keepOut, arrive: { x: l.path.x, y: enterY }, enter: { x: l.yard.right - 4, y: Math.min(l.yard.bottom - 2, enterY) } };
}

export const free = (p: Point, a: Areas): boolean => !a.keepOut.some((b) => inside(p, b));
export const walkable = (p: Point, a: Areas): boolean => (inside(p, a.yard) || inside(p, a.path)) && free(p, a);

/** Whether the straight walk from p to q stays out of every keep-out (sampled every 2 world pixels). */
export function clear(p: Point, q: Point, a: Areas): boolean {
  const n = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / 2));
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    if (!free({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t }, a)) return false;
  }
  return true;
}

/**
 * A walk from p to q that goes round keep-outs: straight when clear, else by a corner of the box
 * in the way (each corner a little outside it), up to two detours. Returns the points to walk to,
 * ending at q; when nothing works, the furthest clear point toward q.
 */
export function route(p: Point, q: Point, a: Areas, depth = 2): Point[] {
  if (clear(p, q, a)) return [q];
  if (depth > 0) {
    let best: Point[] | null = null;
    let bestLen = Infinity;
    for (const b of a.keepOut) {
      for (const c of [
        { x: b.left - 2, y: b.top - 2 },
        { x: b.right + 2, y: b.top - 2 },
        { x: b.left - 2, y: b.bottom + 2 },
        { x: b.right + 2, y: b.bottom + 2 },
      ]) {
        if (!walkable(c, a) || !clear(p, c, a)) continue;
        const rest = route(c, q, a, depth - 1);
        const end = rest[rest.length - 1];
        if (!end || end.x !== q.x || end.y !== q.y) continue;
        let len = Math.hypot(c.x - p.x, c.y - p.y);
        let prev = c;
        for (const r of rest) {
          len += Math.hypot(r.x - prev.x, r.y - prev.y);
          prev = r;
        }
        if (len < bestLen) {
          bestLen = len;
          best = [c, ...rest];
        }
      }
    }
    if (best) return best;
  }
  // nothing round it: stop at the last free point on the way
  let last = p;
  const n = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / 2));
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const s = { x: Math.round(p.x + (q.x - p.x) * t), y: Math.round(p.y + (q.y - p.y) * t) };
    if (!free(s, a)) break;
    last = s;
  }
  return [last];
}

/** The nearest free, walkable point to p (searching outward), or p itself if it already is one. */
export function nearestFree(p: Point, a: Areas): Point {
  const start = { x: Math.round(Math.min(Math.max(p.x, a.yard.left), a.yard.right)), y: Math.round(Math.min(Math.max(p.y, a.yard.top), a.yard.bottom)) };
  if (walkable(p, a)) return p;
  if (walkable(start, a)) return start;
  for (let r = 2; r < 200; r += 2) {
    for (let k = 0; k < 16; k++) {
      const ang = (k / 16) * Math.PI * 2;
      const c = { x: Math.round(start.x + Math.cos(ang) * r), y: Math.round(start.y + Math.sin(ang) * r) };
      if (inside(c, a.yard) && free(c, a)) return c;
    }
  }
  return { x: Math.round((a.yard.left + a.yard.right) / 2), y: Math.round((a.yard.top + a.yard.bottom) / 2) };
}

/**
 * A free spot in the yard away from the other hens: a few random candidates outside every
 * keep-out, the one whose nearest hen is furthest away (so the flock spreads over the yard).
 */
export function freeSpot(a: Areas, others: Point[], rnd: () => number = Math.random, tries = 8): Point {
  const y = a.yard;
  let best: Point | null = null;
  let bestD = -1;
  for (let i = 0; i < tries * 4 && i < 64; i++) {
    const c = { x: Math.round(y.left + rnd() * (y.right - y.left)), y: Math.round(y.top + rnd() * (y.bottom - y.top)) };
    if (!free(c, a)) continue;
    let near = Infinity;
    for (const o of others) near = Math.min(near, Math.hypot(o.x - c.x, (o.y - c.y) * 1.6));
    if (near > bestD) {
      bestD = near;
      best = c;
    }
    if (i >= tries && best) break;
  }
  return best ?? nearestFree({ x: (y.left + y.right) / 2, y: (y.top + y.bottom) / 2 }, a);
}

/** A point carried from one layout to another: relative to the yard (or the path), then made free. */
export function carry(p: Point, from: Areas, to: Areas): Point {
  if (inside(p, from.path) && !inside(p, from.yard)) {
    const v = (p.y - from.path.top) / Math.max(1, from.path.bottom - from.path.top);
    const q = { x: Math.round((to.path.left + to.path.right) / 2), y: Math.round(to.path.top + v * (to.path.bottom - to.path.top)) };
    return walkable(q, to) ? q : nearestFree(q, to);
  }
  const u = (p.x - from.yard.left) / Math.max(1, from.yard.right - from.yard.left);
  const v = (p.y - from.yard.top) / Math.max(1, from.yard.bottom - from.yard.top);
  const q = {
    x: Math.round(to.yard.left + Math.min(1, Math.max(0, u)) * (to.yard.right - to.yard.left)),
    y: Math.round(to.yard.top + Math.min(1, Math.max(0, v)) * (to.yard.bottom - to.yard.top)),
  };
  return nearestFree(q, to);
}
