// The farm's layout spec: where every world object stands, in world pixels, for a farm area of any
// size, with each object's anchor (its feet: the pivot it is drawn from), its art bounds, its
// footprint on the ground, and the connection points that must meet. Sizes come from the size
// table (spec.ts), applied when the atlases are cut; bounds and footprints are read from the
// derived atlases, and connection points from the art itself (ART below, measured in source
// pixels on coys-assets' sheets).
//
// The farm in zones, each with room around it (tests keep a hen's width between every two things
// that stand on the ground, and zones apart): the coops along the top and the straw yard where the
// hens live below them; the feed corner at the yard's far end (the trough, the feed hopper behind
// it with its spout over the feed, the sack beside it); the farmhouse top right with the path
// running from its porch steps straight down through a gate in a fence that runs the whole width;
// the production line along the yard's foot (the belt runs from the field, through the grader
// partway along it, and ends at the crate, which stands clear of everything); the market stall
// (the sales clerk's desk) by the path near the gate, facing the path; and the cart bay on the path
// by the gate, from where the cart drives out. The farm's own sign stands by the path under the
// porch; the rivals' signs across the path. In landscape the goal tracker and toasts sit over the
// bottom-left corner: only ground goes there.
import derivedJson from '../../assets/derived.json';

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

/** One hen's width (world pixels): the least room between two things standing on the ground. */
export const HEN_W = 20;

export type ZoneName = 'coops' | 'yard' | 'feed' | 'production' | 'farmhouse' | 'stall' | 'cartBay';

/** One world object in the spec: its sheet, its anchor (feet), art bounds, footprint and connection points. */
export interface SpecObject {
  sprite: string;
  row: string;
  /** The anchor: the feet pivot the sprite is drawn from. */
  at: Point;
  /** Where the art's pixels are. */
  box: Box;
  /** Its ground: the bottom 3 world pixels of its art, as wide as the art. Footprints never overlap. */
  footprint: Box;
  points: Record<string, Point>;
}

/** Two points that must meet (within one world pixel), or a point that must land inside a span. */
export type Connection =
  | { kind: 'meet'; a: string; b: string; what: string }
  | { kind: 'over'; point: string; span: [string, string]; what: string };

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
  /** The belt: tile centres along y, from the field (from) to the crate's side (to, its end). */
  conveyor: { y: number; from: number; to: number };
  /** The path's centre column, from the farmhouse steps down to the gate. */
  path: { x: number; top: number };
  fence: { y: number; gate: number };
  /** Where new hens arrive, and where the cart turns round. */
  gate: Point;
  props: { row: 'hay-bale' | 'flowers' | 'puddle'; x: number; y: number }[];
  /** Rival farms' signs at the farm's edge. */
  rivals: Point[];
  /** The farm's zones (the boxes around what stands in each). */
  zones: Record<ZoneName, Box>;
  /** Every object with its anchor, bounds, footprint and connection points, and what must line up. */
  spec: { objects: Record<string, SpecObject>; connections: Connection[] };
}

const TILE = 16;

// ---- the art ------------------------------------------------------------------------------------

type DerivedSprite = { kind: string; scale: number; ratio: number; levels: number[]; frames: Record<string, Record<string, number[][]>> };
const SPRITES = (derivedJson as unknown as { sprites: Record<string, DerivedSprite> }).sprites;

/** Where a sheet's pixels are around its pivot, in world pixels: every frame of a row, at the sharpest density. */
export function artBox(id: string, row: string): Box {
  const s = SPRITES[id];
  if (!s) throw new Error(`no derived sprite ${id}`);
  const level = s.kind === 'painted' ? Math.max(...s.levels) : 1;
  const scale = s.kind === 'painted' ? 1 / level : s.scale;
  const frames = s.frames[String(level)]?.[row] ?? [];
  const b: Box = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
  for (const [, , w = 0, h = 0, px = 0, py = 0] of frames) {
    b.left = Math.min(b.left, -px * scale);
    b.top = Math.min(b.top, -py * scale);
    b.right = Math.max(b.right, (w - px) * scale);
    b.bottom = Math.max(b.bottom, (h - py) * scale);
  }
  return b;
}

/**
 * Connection points measured on the art, in source pixels of the measured row's first cell (x from
 * the cell's left, y from its top); the sheet's pivot is the cell's bottom centre. ground is the
 * art's lowest row.
 */
export const ART = {
  grader: { sprite: '19-egg-grader', row: 'idle', cell: [256, 256], ground: 225, x: { in: 31, out: 211 } },
  crate: { sprite: '12-crate', row: 'empty', cell: [256, 256], ground: 205, top: 49, x: { in: 42, side: 221 } },
  hopper: { sprite: '21-feed-hopper', row: 'idle', cell: [256, 384], ground: 351, spout: [167, 287] },
  trough: { sprite: '14-trough', row: 'full', cell: [384, 256], ground: 226, rim: 140, x: { rimLeft: 60, rimRight: 330 } },
  cart: { sprite: '20-delivery-cart', row: 'idle', cell: [256, 256], ground: 228, x: { back: 16, wheel: 75 } },
  clerk: { sprite: '22-sales-clerk', row: 'idle', cell: [256, 256], ground: 238, x: { left: 44, right: 213 } },
  farmhouse: { sprite: '16-farmhouse', row: 'day', cell: [384, 384], ground: 370, x: { steps: 122 } },
} as const;

type ArtKey = keyof typeof ART;
const ratioOf = (k: ArtKey): number => SPRITES[ART[k].sprite]?.ratio ?? 1;
/** Source x (in the cell) to world x from the pivot. */
const dx = (k: ArtKey, sx: number): number => (sx - ART[k].cell[0] / 2) / ratioOf(k);
/** Source y (in the cell) to world y from the pivot. */
const dy = (k: ArtKey, sy: number): number => (sy - ART[k].cell[1]) / ratioOf(k);

/** The pivot that puts a measured source point of the art on a world point (whole pixels). */
const pivotFor = (k: ArtKey, src: [number, number], world: Point): Point => ({ x: Math.round(world.x - dx(k, src[0])), y: Math.round(world.y - dy(k, src[1])) });

const add = (p: Point, q: Point): Point => ({ x: p.x + q.x, y: p.y + q.y });

/**
 * A spec object. Its footprint is the bottom 3 pixels of its solid art: from the measured ground
 * line when the art table has one (painted frames keep a faint halo below the solid pixels), inset
 * a pixel at each side so two things standing side by side may touch.
 */
function object(sprite: string, row: string, at: Point, points: Record<string, Point> = {}, ground?: number): SpecObject {
  const a = artBox(sprite, row);
  const box = { left: at.x + a.left, top: at.y + a.top, right: at.x + a.right, bottom: at.y + a.bottom };
  const g = ground ?? box.bottom;
  return { sprite, row, at, box, footprint: { left: box.left + 1, top: g - 3, right: box.right - 1, bottom: g }, points };
}

/** A spec object for an art-table entry, its footprint on its measured ground line. */
const artObject = (k: ArtKey, at: Point, points: Record<string, Point> = {}): SpecObject => object(ART[k].sprite, ART[k].row, at, points, at.y + dy(k, ART[k].ground));

// ---- the layout ---------------------------------------------------------------------------------

/**
 * The farm laid out for a w x h area. guide is the bottom-left band the UI covers (0 x 0 when it
 * covers none, as in portrait). Extra width widens the yard and spreads the coops; extra height
 * deepens the yard. Every anchor is a whole world pixel.
 */
export function farmLayout(w: number, h: number, guide: { w: number; h: number }): FarmLayout {
  w = Math.max(MIN_W, Math.floor(w));
  h = Math.max(MIN_H, Math.floor(h));
  const guideTop = h - guide.h;
  const objects: Record<string, SpecObject> = {};

  // the path: two tiles wide down the right side, from the porch steps to the gate in the fence
  // (as far right as leaves the farmhouse, which stands right of its steps, inside the farm)
  const houseRight = artBox(ART.farmhouse.sprite, ART.farmhouse.row).right - dx('farmhouse', ART.farmhouse.x.steps);
  const pathX = Math.floor(Math.min(w - 64, w - 2 - houseRight) / TILE) * TILE;
  const pathLeft = pathX - TILE;
  const pathRight = pathX + TILE;
  const fenceY = h - TILE;
  const houseGround = 112;
  const farmhouseAt = pivotFor('farmhouse', [ART.farmhouse.x.steps, ART.farmhouse.ground], { x: pathX, y: houseGround });
  objects.farmhouse = artObject('farmhouse', farmhouseAt, { steps: add(farmhouseAt, { x: dx('farmhouse', ART.farmhouse.x.steps), y: dy('farmhouse', ART.farmhouse.ground) }) });

  // the belt row along the yard's foot (above the guide band, and above the stall by the gate with
  // room between), its ground shared by belt, grader and crate
  const clerkH = Math.ceil(artBox(ART.clerk.sprite, ART.clerk.row).bottom - artBox(ART.clerk.sprite, ART.clerk.row).top);
  // a tall enough farm has the stall below the line by the gate; a short one, at the line's end by the path
  const lowLine = Math.min(h - 38, guideTop - 8, fenceY - 10 - clerkH - 18);
  const lowStall = lowLine - 48 - (houseGround + 6) >= 90;
  const beltGround = lowStall ? lowLine : Math.min(h - 38, guideTop - 8);
  const beltY = beltGround - 8;

  // the cart bay: on the path by the gate, its back at the path's middle (inside the farm)
  const stallGround = fenceY - 10;
  const cartArt = artBox(ART.cart.sprite, ART.cart.row);
  // (placed by its wheel: on the path, as far right as keeps the whole cart inside the farm)
  const wheelMax = Math.floor(w - 1 - (cartArt.right - dx('cart', ART.cart.x.wheel)));
  const wheelX = Math.max(pathLeft + 2, Math.min(pathX + 8, pathRight - 2, wheelMax));
  const cartAt = pivotFor('cart', [ART.cart.x.wheel, ART.cart.ground], { x: wheelX, y: stallGround });
  const cartBoxLeft = cartAt.x + cartArt.left;
  // the market stall: the clerk's desk left of the path near the gate, facing the path, a hen's
  // width and more from the cart
  const clerkArt = artBox(ART.clerk.sprite, ART.clerk.row);
  const clerkOverhang = clerkArt.right - dx('clerk', ART.clerk.x.right);
  const stallPoint = { x: Math.floor(Math.min(pathLeft - 6, cartBoxLeft - HEN_W - clerkOverhang - 1)), y: lowStall ? stallGround : beltGround };
  objects.cart = artObject('cart', cartAt, {
    back: add(cartAt, { x: dx('cart', ART.cart.x.back), y: dy('cart', ART.cart.ground) }),
    wheel: add(cartAt, { x: dx('cart', ART.cart.x.wheel), y: dy('cart', ART.cart.ground) }),
  });

  const clerkAt = pivotFor('clerk', [ART.clerk.x.right, ART.clerk.ground], stallPoint);
  objects.clerk = artObject('clerk', clerkAt, {
    deskRight: add(clerkAt, { x: dx('clerk', ART.clerk.x.right), y: dy('clerk', ART.clerk.ground) }),
    deskLeft: add(clerkAt, { x: dx('clerk', ART.clerk.x.left), y: dy('clerk', ART.clerk.ground) }),
  });

  // the crate at the belt's end, set back from the path so it stands clear (the stall and the cart bay are by the gate)
  const crateArt = artBox(ART.crate.sprite, ART.crate.row);
  // (on a short farm the stall stands at the line's end: the crate keeps a hen's width and more from it)
  const crateRight = lowStall ? pathLeft - 28 : Math.floor((objects.clerk?.box.left ?? pathLeft) - HEN_W - 3);
  const crateAt = { x: Math.floor(crateRight - crateArt.right), y: Math.round(beltGround - dy('crate', ART.crate.ground)) };
  const crateIn = add(crateAt, { x: dx('crate', ART.crate.x.in), y: dy('crate', ART.crate.ground) - 8 });
  const crateSide = { x: crateAt.x + crateArt.right, y: crateAt.y + dy('crate', ART.crate.ground) };
  const crateTop = crateAt.y + dy('crate', ART.crate.top);
  const crateTopSide = { x: crateAt.x + dx('crate', ART.crate.x.side), y: crateTop };
  objects.crate = artObject('crate', crateAt, { in: crateIn, side: crateSide, topSide: crateTopSide });

  // the belt: whole tiles from the field to the crate's side
  const yardLeft = 20;
  const beltTo = Math.round(crateIn.x);
  const beltFrom = beltTo - TILE * Math.floor((beltTo - (yardLeft + TILE)) / TILE);
  objects.conveyor = {
    sprite: '18b-conveyor-clean',
    row: 'horizontal',
    at: { x: Math.round((beltFrom + beltTo) / 2), y: beltY },
    box: { left: beltFrom, top: beltY - 8, right: beltTo, bottom: beltY + 8 },
    footprint: { left: beltFrom, top: beltY + 5, right: beltTo, bottom: beltY + 8 },
    points: { start: { x: beltFrom, y: beltY }, end: { x: beltTo, y: beltY }, groundStart: { x: beltFrom, y: beltGround }, groundEnd: { x: beltTo, y: beltGround } },
  };

  // the grader stands partway along the belt (the belt runs in under it and on to the crate), a
  // hen's width and more clear of the crate
  const graderOutWorld = dx('grader', ART.grader.x.out) - artBox(ART.grader.sprite, ART.grader.row).right;
  const graderOutX = Math.min(beltFrom + Math.round((beltTo - beltFrom) * 0.55), Math.round(objects.crate.box.left - 2 * HEN_W + graderOutWorld));
  const graderAt = pivotFor('grader', [ART.grader.x.out, ART.grader.ground], { x: graderOutX, y: beltGround });
  objects.grader = artObject('grader', graderAt, {
    in: add(graderAt, { x: dx('grader', ART.grader.x.in), y: dy('grader', ART.grader.ground) }),
    out: add(graderAt, { x: dx('grader', ART.grader.x.out), y: dy('grader', ART.grader.ground) }),
  });

  // the yard: below the coops, left of the farm sign, above the production line
  const lineTop = Math.min(objects.grader.box.top, objects.crate.box.top, beltY - 8);
  const signBox = artBox('17-sign-farm', 'sway');
  const sign = { x: Math.round(pathLeft - 3 - signBox.right), y: houseGround + 48 };
  const yard: Box = { left: yardLeft, top: houseGround + 6, right: Math.round(Math.min(pathLeft - 22, sign.x + signBox.left - 6)), bottom: Math.round(lineTop) - 4 };

  // the feed corner at the yard's far end: the trough, the hopper behind it with its spout over the feed
  const troughX = Math.round(Math.max((yard.left + yard.right) / 2, yard.right - 64));
  // (64 px down a shallow yard, the middle of a deep one: a phone's yard runs far down the screen)
  const troughGround = Math.min(Math.max(yard.top + 64, Math.round((yard.top + yard.bottom) / 2)), yard.bottom - 14);
  const troughAt = pivotFor('trough', [192, ART.trough.ground], { x: troughX, y: troughGround });
  const rimY = troughAt.y + dy('trough', ART.trough.rim);
  objects.trough = artObject('trough', troughAt, {
    rimLeft: { x: troughAt.x + dx('trough', ART.trough.x.rimLeft), y: rimY },
    rimRight: { x: troughAt.x + dx('trough', ART.trough.x.rimRight), y: rimY },
    rim: { x: troughAt.x, y: rimY },
  });
  const spoutTarget = { x: troughAt.x + 4, y: Math.round(rimY) - 5 };
  const hopperAt = pivotFor('hopper', [ART.hopper.spout[0], ART.hopper.spout[1]], spoutTarget);
  objects.hopper = artObject('hopper', hopperAt, { spout: add(hopperAt, { x: dx('hopper', ART.hopper.spout[0]), y: dy('hopper', ART.hopper.spout[1]) }) });

  // the feed sack beside the trough, a hen's width away (hens eat between them)
  const sackBox = artBox('13-sack-standard', 'idle');
  const sack = { x: Math.round(objects.trough.box.left - HEN_W - 1 - sackBox.right), y: troughAt.y };
  objects.sack = object('13-sack-standard', 'idle', sack);

  // coops along the top, spread between the yard's left and the farmhouse
  const coopBox = artBox('15-coop-deluxe', 'idle');
  const half = Math.ceil(Math.max(-coopBox.left, coopBox.right));
  const plotsFrom = yardLeft + half;
  const plotsTo = Math.max(plotsFrom + 3 * (2 * half + HEN_W), Math.floor(objects.farmhouse.box.left) - HEN_W - half);
  const plots = [0, 1, 2, 3].map((i) => ({ x: Math.round(plotsFrom + ((plotsTo - plotsFrom) * i) / 3), y: houseGround }));
  plots.forEach((p, i) => {
    objects[`coop${i}`] = object('15-coop-deluxe', 'idle', p);
  });

  // the farm's own sign by the path under the porch; the rivals' signs across the path
  objects.sign = object('17-sign-farm', 'sway', sign);
  const rivalBox = artBox('17-sign-old-money', 'sway');
  const stripX = Math.round(pathRight + 3 - rivalBox.left);
  const cartTop = objects.cart.box.top;
  const rivals: Point[] = [{ x: stripX, y: houseGround + 48 }];
  const second = { x: stripX, y: houseGround + 48 + Math.ceil(rivalBox.bottom - rivalBox.top) + 6 };
  rivals.push(second.y + 2 <= cartTop ? second : { x: Math.round(objects.sign.box.left - 4 - rivalBox.right), y: sign.y });
  rivals.forEach((r, i) => {
    objects[`rival${i}`] = object('17-sign-old-money', 'sway', r);
  });
  yard.right = Math.min(yard.right, Math.floor(Math.min(objects.sign.box.left, objects.rival1?.box.left ?? Infinity)) - 6);

  // props on open ground
  const props: FarmLayout['props'] = [
    { row: 'hay-bale', x: yardLeft + 2, y: troughGround + 40 > yard.bottom ? yard.top + 30 : troughGround + 40 },
    { row: 'flowers', x: Math.round((plots[3]?.x ?? 0) + (objects.farmhouse.box.left - (plots[3]?.x ?? 0)) / 2), y: houseGround + 30 },
  ];
  // flowers and a puddle in the grass by the fence (ground only, as the guide band allows), clear of the stall
  const stallLeft = Math.round(objects.clerk.box.left);
  if (guide.w < stallLeft - 100) props.push({ row: 'flowers', x: Math.round((guide.w + stallLeft) / 2), y: fenceY - 4 });
  props.push({ row: 'puddle', x: Math.max(30, Math.round(Math.min(guide.w, stallLeft - HEN_W) / 2)), y: fenceY - 4 });
  props.forEach((p, i) => {
    objects[`prop${i}`] = object('24-farm-props', p.row, p);
  });

  // pads: packed dirt under the machines that stand on the ground
  const padUnder = (o: SpecObject): Box => ({ left: o.box.left, top: o.footprint.bottom - 6, right: o.box.right, bottom: o.footprint.bottom + 6 });
  const machines: Record<MachineSpot, Point> = { conveyor: objects.conveyor.at, grader: graderAt, cart: cartAt, hopper: hopperAt, clerk: clerkAt };
  const pads: Record<MachineSpot, Box> = {
    conveyor: { left: beltFrom - 8, top: beltY - 8, right: Math.round(objects.grader.box.left) - 2, bottom: beltY + 8 },
    grader: padUnder(objects.grader),
    cart: padUnder(objects.cart),
    hopper: padUnder(objects.hopper),
    clerk: padUnder(objects.clerk),
  };

  const gateAt = { x: pathX, y: fenceY - 2 };
  objects.gate = {
    sprite: '23-farm-tileset',
    row: 'gate',
    at: gateAt,
    box: { left: pathLeft, top: fenceY, right: pathRight, bottom: fenceY + TILE },
    footprint: { left: pathLeft, top: fenceY + TILE - 3, right: pathRight, bottom: fenceY + TILE },
    points: { centre: { x: pathX, y: fenceY } },
  };
  objects.path = {
    sprite: '23-farm-tileset',
    row: 'path',
    at: { x: pathX, y: houseGround },
    box: { left: pathLeft, top: houseGround, right: pathRight, bottom: fenceY },
    footprint: { left: pathLeft, top: houseGround, right: pathRight, bottom: houseGround },
    points: {
      top: { x: pathX, y: houseGround },
      bottom: { x: pathX, y: fenceY },
      // the cart bay's span across the path, on the cart's ground
      left: { x: pathLeft, y: objects.cart.points.wheel?.y ?? stallGround },
      right: { x: pathRight, y: objects.cart.points.wheel?.y ?? stallGround },
      stall: stallPoint,
    },
  };

  const connections: Connection[] = [
    { kind: 'meet', a: 'conveyor.end', b: 'crate.in', what: 'the belt runs into the crate' },
    { kind: 'over', point: 'grader.in', span: ['conveyor.groundStart', 'conveyor.groundEnd'], what: 'the belt runs in under the grader' },
    { kind: 'over', point: 'grader.out', span: ['conveyor.groundStart', 'conveyor.groundEnd'], what: 'the belt runs out of the grader' },
    { kind: 'over', point: 'hopper.spout', span: ['trough.rimLeft', 'trough.rimRight'], what: 'the hopper spout is over the trough' },
    { kind: 'over', point: 'cart.wheel', span: ['path.left', 'path.right'], what: 'the cart stands in its bay on the path' },
    { kind: 'meet', a: 'clerk.deskRight', b: 'path.stall', what: 'the clerk stall stands by the path, facing it' },
    { kind: 'meet', a: 'farmhouse.steps', b: 'path.top', what: 'the path starts at the porch steps' },
    { kind: 'meet', a: 'path.bottom', b: 'gate.centre', what: 'the path runs through the gate' },
  ];

  const around = (...names: string[]): Box => {
    const bs = names.map((n) => objects[n]?.box).filter((b): b is Box => !!b);
    return { left: Math.min(...bs.map((b) => b.left)), top: Math.min(...bs.map((b) => b.top)), right: Math.max(...bs.map((b) => b.right)), bottom: Math.max(...bs.map((b) => b.bottom)) };
  };
  const zones: Record<ZoneName, Box> = {
    coops: around('coop0', 'coop1', 'coop2', 'coop3'),
    yard,
    feed: around('trough', 'hopper', 'sack'),
    production: around('conveyor', 'grader', 'crate'),
    farmhouse: around('farmhouse'),
    stall: around('clerk'),
    cartBay: around('cart'),
  };

  return {
    w,
    h,
    zones,
    guide: { left: 0, top: guideTop, right: guide.w, bottom: h },
    yard,
    plots,
    farmhouse: farmhouseAt,
    sign,
    trough: troughAt,
    sack,
    crate: crateAt,
    machines,
    pads,
    conveyor: { y: beltY, from: beltFrom, to: beltTo },
    path: { x: pathX, top: houseGround },
    fence: { y: fenceY, gate: pathX },
    gate: gateAt,
    props,
    rivals,
    spec: { objects, connections },
  };
}

/** A connection point by name ("crate.in"). */
export function specPoint(l: FarmLayout, name: string): Point | null {
  const [o, p] = name.split('.');
  return (o && p && l.spec.objects[o]?.points[p]) || null;
}

/**
 * How far each connection is from lining up, in world pixels (0 when it does): a meet is the
 * distance between its points; an over is how far the point lies outside its span (by x) or off
 * its line (by y, for a belt) or below the span (for a spout, which must be above the rim).
 */
export function connectionGaps(l: FarmLayout): { c: Connection; gap: number }[] {
  return l.spec.connections.map((c) => {
    if (c.kind === 'meet') {
      const a = specPoint(l, c.a);
      const b = specPoint(l, c.b);
      return { c, gap: a && b ? Math.hypot(a.x - b.x, a.y - b.y) : Infinity };
    }
    const p = specPoint(l, c.point);
    const s0 = specPoint(l, c.span[0]);
    const s1 = specPoint(l, c.span[1]);
    if (!p || !s0 || !s1) return { c, gap: Infinity };
    const lo = Math.min(s0.x, s1.x);
    const hi = Math.max(s0.x, s1.x);
    const offX = Math.max(0, lo - p.x, p.x - hi);
    // a spout must hang above the rim (no more than 6 px); a belt point must sit on the belt's ground
    const offY = c.point.endsWith('spout') ? Math.max(0, p.y - s0.y, s0.y - 6 - p.y) : Math.abs(p.y - s0.y);
    return { c, gap: Math.max(offX, offY) };
  });
}

/** Trough-side places for hens eating. */
export const troughSpots = (l: FarmLayout): Point[] => [-26, -14, 0, 14, 26].map((dx, i) => ({ x: l.trough.x + dx, y: l.trough.y + (i % 2 ? 6 : 8) }));

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

/** Things that lie on the ground (walked over, never standing in the way): no room needed round them. */
export const FLOOR_OBJECTS = (name: string, o: SpecObject): boolean => ['conveyor', 'path', 'gate'].includes(name) || (o.sprite === '24-farm-props' && o.row !== 'hay-bale');

/** Pairs that are built to touch (a connection), so the room rule does not apply to them. */
export const DESIGNED_PAIRS: [string, string][] = [
  ['conveyor', 'grader'],
  ['conveyor', 'crate'],
  ['trough', 'hopper'],
];

/** The room between two boxes (0 when they overlap or touch). */
export function boxGap(a: Box, b: Box): number {
  const gx = Math.max(0, a.left - b.right, b.left - a.right);
  const gy = Math.max(0, a.top - b.bottom, b.top - a.bottom);
  return Math.hypot(gx, gy);
}

const hit = (a: Box, b: Box): boolean => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/**
 * Where an object's name label goes (shown on hover or tap, and once when the thing arrives): above
 * it, else below, left or right, the first place inside the farm that covers no other object.
 */
export function labelSpot(l: FarmLayout, name: string, w: number, h = 11): Box | null {
  const o = l.spec.objects[name];
  if (!o) return null;
  const others = Object.entries(l.spec.objects)
    .filter(([k]) => k !== name && !(k === 'path' || k === 'gate'))
    .map(([, x]) => x.box);
  const cy = (o.box.top + o.box.bottom) / 2;
  const tries: Box[] = [];
  // above or below, at the middle first, then along the thing (a long belt has a grader at its middle)
  const along = [0.5, 0.25, 0.75, 0.12, 0.88].map((f) => o.box.left + (o.box.right - o.box.left) * f);
  for (const d of [2, 6, 10]) {
    for (const x of along) {
      tries.push({ left: x - w / 2, top: o.box.top - d - h, right: x + w / 2, bottom: o.box.top - d });
      tries.push({ left: x - w / 2, top: o.box.bottom + d, right: x + w / 2, bottom: o.box.bottom + d + h });
    }
    tries.push({ left: o.box.left - d - w, top: cy - h / 2, right: o.box.left - d, bottom: cy + h / 2 });
    tries.push({ left: o.box.right + d, top: cy - h / 2, right: o.box.right + d + w, bottom: cy + h / 2 });
  }
  for (const r of tries) {
    const b = { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) };
    if (b.left < 0 || b.top < 0 || b.right > l.w || b.bottom > l.h) continue;
    if (!others.some((x) => hit(b, x))) return b;
  }
  return null;
}
