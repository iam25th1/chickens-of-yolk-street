// Where hens may walk, from the layout spec: the straw yard, and the path down from the porch they
// arrive by. Standing objects (the trough, the sack, the hopper, props, signs, machines, coops) are
// keep-out boxes: a hen's feet never stand in one and her walks go round them. Every point is in
// world units; on a resize, positions are carried over relative to the yard, so a hen keeps her
// place in the composition instead of a stale spot. Pure functions, tested in test/movement.test.ts.
//
// Land: each plot of land the farm owns adds its pasture (a field) and a lane, a walk of straight
// legs clear of everything standing, from the home yard to the pasture. Hens spread over the yard and
// the pastures, and a walk from one to another goes by the lanes (travel).
import type { LandId } from '@coys/shared';
import type { Box, FarmLayout, Point } from './layout';

/** Half a hen's width and how far her body reaches above her feet, in world pixels. */
const HEN_HALF = 10;

/** A plot of land's pasture, and the lane hens walk to it from the home yard. */
export interface Field {
  id: LandId;
  box: Box;
  /** The lane: points from the yard (the first) to the pasture (the last), each leg clear of every keep-out. Empty when none is clear. */
  lane: Point[];
  /** Thin walkable strips along the lane's legs. */
  strip: Box[];
}

export interface Areas {
  yard: Box;
  /** The pastures of the farm's land (none for a farm on its home plot only). */
  fields: Field[];
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
  const base = { yard: l.yard, path, keepOut, arrive: { x: l.path.x, y: enterY }, enter: { x: l.yard.right - 4, y: Math.min(l.yard.bottom - 2, enterY) }, fields: [] as Field[] };
  base.fields = l.land.map((p) => {
    const lane = laneTo(p.id, p.pasture, l, base);
    return { id: p.id, box: p.pasture, lane, strip: legs(lane).map(([a, b]) => ({ left: Math.min(a.x, b.x) - 3, top: Math.min(a.y, b.y) - 3, right: Math.max(a.x, b.x) + 3, bottom: Math.max(a.y, b.y) + 3 })) };
  });
  return base;
}

const legs = (pts: Point[]): [Point, Point][] => pts.slice(1).map((q, i) => [pts[i] as Point, q]);

/** The middle of the longest run of consecutive candidates that pass (null when none does). */
function middleOfLongestRun(xs: number[], ok: (x: number) => boolean): number | null {
  let best: number[] = [];
  let run: number[] = [];
  for (const x of xs) {
    if (ok(x)) run.push(x);
    else run = [];
    if (run.length > best.length) best = [...run];
  }
  return best.length ? (best[Math.floor(best.length / 2)] as number) : null;
}

const range = (from: number, to: number, step = 2): number[] => {
  const out: number[] = [];
  for (let v = Math.round(from); v <= to; v += step) out.push(v);
  return out;
};

/**
 * The lane from the home yard to a pasture: straight legs, each clear of every keep-out. The west
 * meadow's runs straight across from the yard's left edge; the east field's goes the way new hens
 * come in (out of the yard by the farm sign, up the path) and across below the porch; the north
 * pasture's and the south orchard's run up or down from the yard where the widest gap is clear.
 */
function laneTo(id: LandId, box: Box, l: FarmLayout, a: Omit<Areas, 'fields'>): Point[] {
  const ok = (pts: Point[]) => legs(pts).every(([p, q]) => clear(p, q, { ...a, fields: [] }));
  const y = l.yard;
  if (id === 'west') {
    const at = middleOfLongestRun(range(Math.max(y.top, box.top) + 4, Math.min(y.bottom, box.bottom) - 4), (v) => ok([{ x: y.left + 4, y: v }, { x: box.right - 4, y: v }]));
    return at === null ? [] : [{ x: y.left + 4, y: at }, { x: box.right - 4, y: at }];
  }
  if (id === 'east') {
    const pts = (v: number): Point[] => [a.enter, a.arrive, { x: a.arrive.x, y: v }, { x: box.left + 4, y: v }];
    const tops = range(Math.max(a.path.top, box.top) + 4, Math.min(a.arrive.y, box.bottom - 4));
    const at = tops.find((v) => ok(pts(v))) ?? null;
    return at === null ? [] : pts(at);
  }
  // north and south: a stub along the yard's edge, then straight up or down to the pasture
  const edge = id === 'north' ? y.top + 2 : y.bottom - 2;
  const end = id === 'north' ? box.bottom - 2 : box.top + 2;
  const pts = (x: number): Point[] => {
    const start = { x: Math.min(Math.max(x, y.left + 2), y.right - 2), y: edge };
    const corner = { x, y: edge };
    return start.x === x ? [start, { x, y: end }] : [start, corner, { x, y: end }];
  };
  const at = middleOfLongestRun(range(Math.max(24, box.left + 4), box.right - 4), (x) => ok(pts(x)));
  return at === null ? [] : pts(at);
}

export const free = (p: Point, a: Areas): boolean => !a.keepOut.some((b) => inside(p, b));
const inField = (p: Point, a: Areas): boolean => a.fields.some((f) => inside(p, f.box) || f.strip.some((s) => inside(p, s)));
export const walkable = (p: Point, a: Areas): boolean => (inside(p, a.yard) || inside(p, a.path) || inField(p, a)) && free(p, a);

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
    // the walk to it must be clear too (a rounded point can sit just past a box's corner)
    if (!free(s, a) || !clear(p, s, a)) break;
    last = s;
  }
  return [last];
}

/** The yard and the pastures hens can reach (a pasture with a lane). */
const regions = (a: Areas): Box[] => [a.yard, ...a.fields.filter((f) => f.lane.length).map((f) => f.box)];

/** How far a point is from a box (0 inside it). */
const distTo = (p: Point, b: Box): number => Math.hypot(Math.max(0, b.left - p.x, p.x - b.right), Math.max(0, b.top - p.y, p.y - b.bottom));

/** The nearest free, walkable point to p (searching outward), or p itself if it already is one. */
export function nearestFree(p: Point, a: Areas): Point {
  // the yard, or the pasture nearer to p (the yard when there is no land)
  const r0 = regions(a).reduce((best, b) => (distTo(p, b) < distTo(p, best) ? b : best), a.yard);
  const start = { x: Math.round(Math.min(Math.max(p.x, r0.left), r0.right)), y: Math.round(Math.min(Math.max(p.y, r0.top), r0.bottom)) };
  if (walkable(p, a)) return p;
  if (walkable(start, a)) return start;
  for (let r = 2; r < 200; r += 2) {
    for (let k = 0; k < 16; k++) {
      const ang = (k / 16) * Math.PI * 2;
      const c = { x: Math.round(start.x + Math.cos(ang) * r), y: Math.round(start.y + Math.sin(ang) * r) };
      if (inside(c, r0) && free(c, a)) return c;
    }
  }
  return { x: Math.round((r0.left + r0.right) / 2), y: Math.round((r0.top + r0.bottom) / 2) };
}

/**
 * Where a hen goes next to wander: mostly somewhere in the region she is in (the yard or a
 * pasture), now and then to another, picked by its size. The yard alone with no land.
 */
export function pickRegion(a: Areas, from: Point, rnd: () => number = Math.random, stay = 0.7): Box {
  const rs = regions(a);
  if (rs.length === 1) return a.yard;
  const here = placeOf(from, a);
  if (rnd() < stay) return here.field < 0 ? a.yard : (a.fields[here.field]?.box ?? a.yard);
  const area = (b: Box) => Math.max(1, (b.right - b.left) * (b.bottom - b.top));
  let roll = rnd() * rs.reduce((n, b) => n + area(b), 0);
  for (const b of rs) {
    roll -= area(b);
    if (roll <= 0) return b;
  }
  return a.yard;
}

/** Where a point is: in a pasture (field index, leg null), on a lane's leg, or home (field -1). */
function placeOf(p: Point, a: Areas): { field: number; leg: number | null } {
  const f = a.fields.findIndex((x) => inside(p, x.box));
  if (f >= 0) return { field: f, leg: null };
  if (inside(p, a.yard) || inside(p, a.path)) return { field: -1, leg: null };
  for (const [i, x] of a.fields.entries()) {
    const k = x.strip.findIndex((s) => inside(p, s));
    if (k >= 0) return { field: i, leg: k };
  }
  // off every area (a stale spot): the nearest region
  let best = { field: -1, d: distTo(p, a.yard) };
  for (const [i, x] of a.fields.entries()) if (x.lane.length && distTo(p, x.box) < best.d) best = { field: i, d: distTo(p, x.box) };
  return { field: best.field, leg: null };
}

/**
 * A walk from p to q anywhere on the farm: within the yard (or one pasture) a route round what
 * stands there; between the yard and a pasture, or two pastures, along their lanes. Returns the
 * points to walk to, ending at q; when q cannot be reached, as far as the walk got.
 */
export function travel(p: Point, q: Point, a: Areas): Point[] {
  if (!a.fields.length) return route(p, q, a);
  const from = placeOf(p, a);
  const to = placeOf(q, a);
  const lane = (i: number) => a.fields[i]?.lane ?? [];
  // how far along its lane a place is: the pasture is past the last point
  const pos = (pl: { field: number; leg: number | null }) => (pl.leg === null ? lane(pl.field).length : pl.leg + 0.5);
  let via: Point[] = [];
  if (from.field === to.field) {
    if (from.field < 0 || (from.leg === null && to.leg === null)) return route(p, q, a);
    const pts = lane(from.field);
    const s = pos(from);
    const e = pos(to);
    via = s < e ? pts.slice(Math.ceil(s), Math.ceil(e)) : pts.slice(Math.ceil(e), Math.ceil(s)).reverse();
  } else {
    // out along this lane to the yard, then in along the other
    if (from.field >= 0) via.push(...lane(from.field).slice(0, Math.ceil(pos(from))).reverse());
    if (to.field >= 0) via.push(...lane(to.field).slice(0, Math.ceil(pos(to))));
    if ((from.field >= 0 && !lane(from.field).length) || (to.field >= 0 && !lane(to.field).length)) return route(p, nearestFree(p, a), a);
  }
  const out: Point[] = [];
  let at = p;
  for (const w of [...via, q]) {
    const r = route(at, w, a);
    out.push(...r);
    const end = r[r.length - 1] ?? at;
    if (end.x !== w.x || end.y !== w.y) return out;
    at = w;
  }
  return out;
}

/**
 * A free spot in the yard away from the other hens: a few random candidates outside every
 * keep-out, the one whose nearest hen is furthest away (so the flock spreads over the yard).
 */
export function freeSpot(a: Areas, others: Point[], rnd: () => number = Math.random, tries = 8, region: Box = a.yard): Point {
  const y = region;
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

/** A point carried from one layout to another: relative to the yard (or the path, or its pasture), then made free. */
export function carry(p: Point, from: Areas, to: Areas): Point {
  const field = from.fields.find((f) => inside(p, f.box));
  const there = field && to.fields.find((f) => f.id === field.id);
  if (field && there) {
    const u = (p.x - field.box.left) / Math.max(1, field.box.right - field.box.left);
    const v = (p.y - field.box.top) / Math.max(1, field.box.bottom - field.box.top);
    const q = { x: Math.round(there.box.left + u * (there.box.right - there.box.left)), y: Math.round(there.box.top + v * (there.box.bottom - there.box.top)) };
    return walkable(q, to) ? q : nearestFree(q, to);
  }
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

/** The hatching egg's footprint around its feet point (world px): 24 tall, about as wide as a hen. */
export const EGG_HALF_W = 10;
export const EGG_H = 24;

/** Whether an egg standing at p (its feet) is wholly in the yard (or wholly in one pasture) and clear of every keep-out. */
export function eggClear(p: Point, a: Areas): boolean {
  const pts = [p, { x: p.x - EGG_HALF_W, y: p.y }, { x: p.x + EGG_HALF_W, y: p.y }, { x: p.x, y: p.y - EGG_H / 2 }, { x: p.x - EGG_HALF_W, y: p.y - EGG_H / 2 }, { x: p.x + EGG_HALF_W, y: p.y - EGG_H / 2 }];
  return regions(a).some((r) => pts.every((q) => inside(q, r) && free(q, a)));
}

/**
 * Spots for the eggs new hens hatch from: n spots in the yard, each egg wholly clear of every
 * keep-out (never on an object, the path or a hen), at least `gap` from each other and from the
 * hens already there, spread across the yard (of many random candidates, the one farthest from
 * everything taken). Pure: tested in test/hatch.test.ts.
 */
export function hatchSpots(a: Areas, others: Point[], n: number, rnd: () => number = Math.random, gap = 2 * HEN_HALF + 4): Point[] {
  const y = a.yard;
  const out: Point[] = [];
  for (let k = 0; k < n; k++) {
    const taken = [...others, ...out];
    let best: Point | null = null;
    let bestD = -1;
    for (let i = 0; i < 400; i++) {
      const c = { x: Math.round(y.left + EGG_HALF_W + rnd() * (y.right - y.left - 2 * EGG_HALF_W)), y: Math.round(y.top + EGG_H / 2 + rnd() * (y.bottom - y.top - EGG_H / 2)) };
      if (!eggClear(c, a)) continue;
      let near = Infinity;
      for (const o of taken) near = Math.min(near, Math.hypot(o.x - c.x, (o.y - c.y) * 1.6));
      if (near > bestD) {
        bestD = near;
        best = c;
      }
      if (i >= 40 && best && bestD >= gap) break;
    }
    out.push(best ?? freeSpot(a, taken, rnd));
  }
  return out;
}
