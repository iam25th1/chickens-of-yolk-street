// Where things stand on the farm, in world pixels, for a farm area of any size. The farm fills the
// whole free part of the window (app/viewport.ts): the coops along the top, the farmhouse top right
// with the path running from its door to a gate in the fence, the straw yard filling the middle,
// the conveyor along the yard's foot carrying eggs past the grader into the crate, the delivery cart
// parked on the path, the feed station in the yard and the sales clerk's desk by the sign. In
// landscape the goal tracker and toasts sit over the bottom-left corner: only ground goes there.

export interface Point {
  x: number;
  y: number;
}

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The smallest farm area the layout is drawn for (above the guide band): the world zoom is chosen so it fits. */
export const MIN_W = 500;
export const MIN_H = 274;

export type MachineSpot = 'conveyor' | 'grader' | 'cart' | 'hopper' | 'clerk';

export interface FarmLayout {
  w: number;
  h: number;
  /** The bottom-left corner the guide covers (ground only). */
  guide: Box;
  yard: Box;
  /** Feet positions of the four coop plots. */
  plots: Point[];
  farmhouse: Point;
  sign: Point;
  trough: Point;
  sack: Point;
  crate: Point;
  /** Where each machine stands (feet), and the pad under it. */
  machines: Record<MachineSpot, Point>;
  pads: Record<MachineSpot, Box>;
  conveyor: { y: number; from: number; to: number };
  /** The path's centre column, from the farmhouse door down to the gate. */
  path: { x: number; top: number };
  fence: { y: number; gate: number };
  /** Where new hens arrive, and where the cart turns round. */
  gate: Point;
  props: { row: 'hay-bale' | 'flowers' | 'puddle'; x: number; y: number }[];
  /** Rival farms' signs along the far edge. */
  rivals: Point[];
}

const TILE = 16;
const snap = (v: number) => Math.round(v / TILE) * TILE;

/**
 * The farm laid out for a w x h area. guide is the bottom-left band the UI covers (0 x 0 when it
 * covers none, as in portrait). Extra width widens the yard and spreads the coops; extra height
 * deepens the yard. Every spot is a whole world pixel.
 */
export function farmLayout(w: number, h: number, guide: { w: number; h: number }): FarmLayout {
  w = Math.max(MIN_W, Math.floor(w));
  h = Math.max(MIN_H, Math.floor(h));
  const guideTop = h - guide.h;
  // the path runs down the right side, two tiles wide
  const pathX = snap(w - 64);
  const farmhouse = { x: w - 58, y: 128 };
  // the conveyor runs along the yard's foot, above the guide band
  const conveyorY = Math.min(h - 46, guideTop - 16);
  const crate = { x: pathX - 40, y: conveyorY + 10 };
  const grader = { x: crate.x - 38, y: conveyorY + 12 };
  const yard: Box = { left: 20, top: 146, right: pathX - 70, bottom: conveyorY - 14 };
  const plotsFrom = 58;
  const plotsTo = Math.max(plotsFrom + 3 * 84, farmhouse.x - 116);
  const plots = [0, 1, 2, 3].map((i) => ({ x: Math.round(plotsFrom + ((plotsTo - plotsFrom) * i) / 3), y: 132 }));
  const trough = { x: Math.round((yard.left + yard.right) / 2), y: Math.min(yard.top + 64, yard.bottom - 16) };
  const sack = { x: trough.x - 50, y: trough.y + 4 };
  const hopper = { x: trough.x + 52, y: trough.y + 6 };
  const sign = { x: pathX - 34, y: 186 };
  // the strip right of the path: the clerk's desk at the top, the rivals' signs below it
  const strip = Math.min(w - 24, pathX + 40);
  const clerk = { x: strip, y: 206 };
  const fenceY = h - TILE;
  const cart = { x: pathX, y: Math.min(fenceY - 8, crate.y + 40) };
  // a pad is one row of packed dirt under the machine's feet, as wide as the machine
  const pad = (p: Point, half: number): Box => ({ left: p.x - half, top: p.y - 6, right: p.x + half, bottom: p.y + 6 });
  const machines: Record<MachineSpot, Point> = {
    conveyor: { x: Math.round((yard.left + 16 + grader.x - 30) / 2), y: conveyorY },
    grader,
    cart,
    hopper,
    clerk,
  };
  const pads: Record<MachineSpot, Box> = {
    conveyor: { left: yard.left + 8, top: conveyorY - 8, right: grader.x - 26, bottom: conveyorY + 8 },
    grader: pad(grader, 24),
    cart: pad(cart, 24),
    hopper: pad(hopper, 16),
    clerk: pad(clerk, 16),
  };
  const props: FarmLayout['props'] = [
    { row: 'hay-bale', x: 18, y: 160 },
    { row: 'flowers', x: Math.round(((plots[3]?.x ?? 0) + farmhouse.x - 48) / 2), y: 150 },
    { row: 'puddle', x: Math.round((yard.right + pathX - 16) / 2) + 6, y: Math.round((sign.y + crate.y) / 2) + 8 },
  ];
  // in the guide band only flowers in the grass (the band is ground only)
  if (guide.w < pathX - 120) props.push({ row: 'flowers', x: Math.round((guide.w + pathX - 60) / 2), y: fenceY - 4 });
  const rivals = [
    { x: strip, y: clerk.y + 52 },
    { x: strip, y: Math.min(fenceY - 6, clerk.y + 104) },
  ];
  return {
    w,
    h,
    guide: { left: 0, top: guideTop, right: guide.w, bottom: h },
    yard,
    plots,
    farmhouse,
    sign,
    trough,
    sack,
    crate,
    machines,
    pads,
    conveyor: { y: conveyorY, from: snap(yard.left + 16), to: snap(grader.x - 34) },
    path: { x: pathX, top: farmhouse.y + 4 },
    fence: { y: fenceY, gate: pathX },
    gate: { x: pathX, y: fenceY - 2 },
    props,
    rivals,
  };
}

/** Trough-side places for hens eating. */
export const troughSpots = (l: FarmLayout): Point[] => [-26, -14, 0, 14, 26].map((dx, i) => ({ x: l.trough.x + dx, y: l.trough.y + (i % 2 ? 8 : 10) }));

export const randomIn = (r: Box): Point => ({
  x: Math.round(r.left + Math.random() * (r.right - r.left)),
  y: Math.round(r.top + Math.random() * (r.bottom - r.top)),
});

/**
 * A spot in the yard away from the other hens: a few random candidates, the one whose nearest hen
 * is furthest away (so the flock spreads over the whole yard instead of bunching).
 */
export function spreadSpot(r: Box, others: Point[], tries = 6): Point {
  let best = randomIn(r);
  let bestD = -1;
  for (let i = 0; i < tries; i++) {
    const c = randomIn(r);
    let near = Infinity;
    for (const o of others) near = Math.min(near, Math.hypot(o.x - c.x, (o.y - c.y) * 1.6));
    if (near > bestD) {
      bestD = near;
      best = c;
    }
  }
  return best;
}
