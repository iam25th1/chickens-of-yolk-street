// Derives the sprite atlases the game draws from the packed sheets in apps/client/public/assets.
//
// Every asset keeps as much detail as it really has. For each sheet the build tries downscale
// factors and keeps the largest one whose nearest-neighbour round trip (downscale, upscale back,
// compare) reproduces the original almost pixel for pixel (ROUND_TRIP). Sheets drawn on an exact
// pixel grid pass at their grid; painted sheets (soft shading, no grid) pass at no factor and keep
// their original resolution. The hen and its trait layers share one factor, chosen over all of
// them together, so they still stack pixel for pixel.
//
// Exact sheets ship whole at their factor: the screen draws each of their pixels as a whole number
// of device pixels. Painted sheets ship as per-density atlases cut from the original: at density d
// a sprite has d texels per design pixel (a world pixel for the farm, a UI pixel for portraits), so
// a screen at d device pixels per design pixel draws one texel per device pixel, with nothing scaled
// at run time. Frames are cut by connected blobs at full resolution, so art that pokes out of its
// cell (a comb, a flapping wing) stays whole and never brings a neighbour's pixels along.
import { HEN_PX, SIZE_TABLE, type Thing } from '../../apps/client/src/pixi/farm/spec';
import { createHash } from 'node:crypto';
import { alphaCut, recolourBody } from '../../packages/shared/src/pixels';
import type { Rgba } from './png';

/** Screen groups, loaded in this order. */
export const GROUPS = ['boot', 'title', 'farm', 'market', 'cards', 'ui', 'fx'] as const;
export type Group = (typeof GROUPS)[number];

/** Densities (texels per design pixel) the painted atlases are cut at. A screen picks one that divides its zoom. */
export const LEVELS = [2, 3, 4, 6, 8] as const;

/** Near pixel-identical: at most 0.5% of visible pixels may move by more than 24 of 255 in any channel. */
export const ROUND_TRIP = { channel: 24, share: 0.005 } as const;
/** Downscale factors tried, smallest first; a factor is skipped once one of its divisors has failed. */
export const FACTORS = [2, 3, 4, 6, 8, 12, 16] as const;

export interface PaintedSpec {
  group: Group;
  /** Source pixels per design pixel: world pixels for the farm, UI pixels for portraits and signs. */
  ratio: number;
  use: 'world' | 'ui';
}

/**
 * Each painted farm sheet's visible size in source pixels: the tallest opaque frame of the row the
 * size table measures (the trough by width), read once from coys-assets. The art ratio is this
 * over the size the table gives it, so the atlases are cut at exactly the table's sizes.
 */
export const SOURCE_EXTENT: Record<string, number> = {
  '11-egg-white': 160,
  '12-crate': 157,
  '14-trough': 331,
  '13-sack-standard': 230,
  '15-coop-starter': 337,
  '15-coop-red': 353,
  '15-coop-deluxe': 378,
  '16-farmhouse': 361,
  '19-egg-grader': 208,
  '20-delivery-cart': 142,
  '21-feed-hopper': 392,
  '22-sales-clerk': 215,
  '17-sign-farm': 224,
  '17-sign-upstart': 219,
  '17-sign-old-money': 233,
};

/** Source pixels per world pixel that draw `measured` at the size table's size for `thing`. */
export const sizedRatio = (thing: Thing, measured: string): number => {
  const px = SOURCE_EXTENT[measured];
  if (!px) throw new Error(`no source extent for ${measured}`);
  return px / (SIZE_TABLE[thing].rel * HEN_PX);
};

const world = (thing: Thing, measured: string): PaintedSpec => ({ group: 'farm', ratio: sizedRatio(thing, measured), use: 'world' });

/** Painted sheets the game draws, and how big each is drawn (the size table in apps/client/src/pixi/farm/spec.ts). */
export const PAINTED: Record<string, PaintedSpec> = {
  // the hen and her trait layers: 1.0 in the size table
  '02-body': { group: 'farm', ratio: 8, use: 'world' },
  '02-eyes-sleepy': { group: 'farm', ratio: 8, use: 'world' },
  '02-eyes-wild': { group: 'farm', ratio: 8, use: 'world' },
  '02-comb-default': { group: 'farm', ratio: 8, use: 'world' },
  '02-comb-spiky': { group: 'farm', ratio: 8, use: 'world' },
  '02-comb-mohawk': { group: 'farm', ratio: 8, use: 'world' },
  '02-comb-nub': { group: 'farm', ratio: 8, use: 'world' },
  '02-acc-tophat': { group: 'farm', ratio: 8, use: 'world' },
  '02-acc-bowtie': { group: 'farm', ratio: 8, use: 'world' },
  '02-acc-shades': { group: 'farm', ratio: 8, use: 'world' },
  // every egg at the white egg's scale (the brown is a jumbo egg by design)
  '11-egg-white': world('egg', '11-egg-white'),
  '11-egg-cream': world('egg', '11-egg-white'),
  '11-egg-brown': world('egg', '11-egg-white'),
  '11-egg-golden': world('egg', '11-egg-white'),
  '12-crate': world('crate', '12-crate'),
  '13-sack-cheap': world('sack', '13-sack-standard'),
  '13-sack-standard': world('sack', '13-sack-standard'),
  '13-sack-premium': world('sack', '13-sack-standard'),
  '14-trough': world('trough', '14-trough'),
  '15-coop-starter': world('coop-starter', '15-coop-starter'),
  '15-coop-red': world('coop-red', '15-coop-red'),
  '15-coop-deluxe': world('coop-deluxe', '15-coop-deluxe'),
  '16-farmhouse': world('farmhouse', '16-farmhouse'),
  '17-sign-farm': world('sign', '17-sign-farm'),
  '19-egg-grader': world('grader', '19-egg-grader'),
  '20-delivery-cart': world('cart', '20-delivery-cart'),
  // worn and broken looks, drawn at exactly their machine's size (measured on the machine's own sheet)
  '19c-egg-grader-wear': world('grader', '19-egg-grader'),
  '20c-delivery-cart-wear': world('cart', '20-delivery-cart'),
  '21c-feed-hopper-wear': world('hopper', '21-feed-hopper'),
  '22c-sales-clerk-wear': world('clerk', '22-sales-clerk'),
  '21-feed-hopper': world('hopper', '21-feed-hopper'),
  '22-sales-clerk': world('clerk', '22-sales-clerk'),
  // the rival farms' signs at the farm's edge (and on the market board)
  '17-sign-upstart': world('sign', '17-sign-upstart'),
  '17-sign-old-money': world('sign', '17-sign-old-money'),
  '04-upstart': { group: 'cards', ratio: 4, use: 'ui' },
  '05-old-money': { group: 'cards', ratio: 4, use: 'ui' },
  '06-squeezer': { group: 'cards', ratio: 4, use: 'ui' },
  '07-loyalist': { group: 'cards', ratio: 4, use: 'ui' },
  '08-bakery-buyer': { group: 'cards', ratio: 4, use: 'ui' },
  '09-market-trader': { group: 'cards', ratio: 4, use: 'ui' },
  '10-wholesaler': { group: 'cards', ratio: 4, use: 'ui' },
  // the farm's own hen, who walks the player through the tour
  'x-hen-portrait': { group: 'title', ratio: 8, use: 'ui' },
  // the Feather Mint's press (the minting moment), made from the grader, the crate, a feather and the card frame
  'x-mint-press': { group: 'cards', ratio: 3, use: 'ui' },
};

/** Sheets drawn on an exact grid (the packer measured it): shipped whole at their factor. */
export const EXACT_GROUP: Record<string, Group> = {
  '25-loading-plate': 'boot',
  '25-loading-anim': 'boot',
  '26-title-plate': 'title',
  '26-title-anim': 'title',
  '28-logo': 'title',
  '31-ui-pieces': 'ui',
  '32-icons': 'ui',
  '33-split-flap': 'ui',
  '34-cursor': 'boot',
  '35-particles': 'fx',
  '30-stamps': 'fx',
  // the belt without the eggs painted on it (Spawn upload conveyor-clean), so only real eggs ride it
  '18b-conveyor-clean': 'farm',
  '18c-conveyor-wear': 'farm',
  '23-farm-tileset': 'farm',
  '24-farm-props': 'farm',
  '27-town-square-plate': 'market',
  '27-town-square-anim': 'market',
  // the Feathers beta: four feathers and five card frames from Spawn (mint page, reveal)
  'x-feather-fluff': 'cards',
  'x-feather-plume': 'cards',
  'x-feather-quill': 'cards',
  'x-feather-golden-quill': 'cards',
  'x-founders-frame-common': 'cards',
  'x-founders-frame-rare': 'cards',
  'x-founders-frame-epic': 'cards',
  'x-founders-frame-legendary': 'cards',
  'x-founders-frame-unminted': 'cards',
  '29-card-bulk-order': 'cards',
  '29-card-feed-deal': 'cards',
  '29-card-glut-warning': 'cards',
  '29-card-standing-contract': 'cards',
  '29-card-premium-order': 'cards',
  '29-card-credit-terms': 'cards',
  '29-card-undercut': 'cards',
  '29-card-buyout-offer': 'cards',
  '29-card-player-trade': 'cards',
};

/** In the packed set but not drawn by the game (measured for the report only). */
export const UNUSED = ['01-hen-base', '01-hen-anims', '03-chick', '19b-egg-sorter', '18-conveyor'];

/** The grid the previous pass downscaled each painted sheet to (for the report's "detail lost" column). */
export const PREVIOUS_GRID: Record<string, number> = {
  '01-hen-anims': 8,
  '02-body': 8,
  '02-eyes-sleepy': 8,
  '02-eyes-wild': 8,
  '02-comb-default': 8,
  '02-comb-spiky': 8,
  '02-comb-mohawk': 8,
  '02-comb-nub': 8,
  '02-acc-tophat': 8,
  '02-acc-bowtie': 8,
  '02-acc-shades': 8,
  '11-egg-white': 12,
  '11-egg-cream': 12,
  '11-egg-brown': 12,
  '11-egg-golden': 12,
  '12-crate': 8,
  '13-sack-cheap': 8,
  '13-sack-standard': 8,
  '13-sack-premium': 8,
  '14-trough': 8,
  '15-coop-starter': 8,
  '15-coop-red': 8,
  '15-coop-deluxe': 8,
  '16-farmhouse': 4,
  '17-sign-farm': 8,
  '17-sign-upstart': 6,
  '17-sign-old-money': 6,
  '19-egg-grader': 4,
  '19b-egg-sorter': 4,
  '20-delivery-cart': 4,
  '21-feed-hopper': 4,
  '22-sales-clerk': 4,
  '04-upstart': 4,
  '05-old-money': 4,
  '06-squeezer': 4,
  '07-loyalist': 4,
  '08-bakery-buyer': 4,
  '09-market-trader': 4,
  '10-wholesaler': 4,
  'x-hen-portrait': 8,
};

/** The base hen and its trait layers share one cell layout, one factor and one blob labelling. */
export const HEN_LAYERS = [
  '02-body',
  '02-eyes-sleepy',
  '02-eyes-wild',
  '02-comb-default',
  '02-comb-spiky',
  '02-comb-mohawk',
  '02-comb-nub',
  '02-acc-tophat',
  '02-acc-bowtie',
  '02-acc-shades',
];
const HEN_CELL = 256;
/** Largest atlas page side: within every WebGL2 GPU's texture limit. */
const PAGE = 4096;

export interface SheetFrameJson {
  frame: { x: number; y: number; w: number; h: number };
  anchor: { x: number; y: number };
  duration: number;
}
export interface SheetJson {
  frames: Record<string, SheetFrameJson>;
  animations: Record<string, string[]>;
  meta: { size: { w: number; h: number }; grid: number };
}

/** One frame in an atlas page: rect, pivot (from the rect's top left) and page. */
export type DerivedRect = [x: number, y: number, w: number, h: number, px: number, py: number, page: number];

export interface DerivedSprite {
  group: Group;
  kind: 'exact' | 'painted';
  /** Source pixels per stored pixel: the factor the round trip chose. */
  factor: number;
  /** Exact: design pixels per atlas pixel. Painted: 1 (density decides the size). */
  scale: number;
  /** Source pixels per design pixel. */
  ratio: number;
  /** Densities this sprite has frames at ([1] for exact sheets). */
  levels: number[];
  /** Painted: the atlas its frames live in at each density (key `<atlas>@<density>`). */
  atlas?: string;
  /** Exact sheets: the whole sheet's rect, for tile and glyph lookups. */
  sheet?: DerivedRect;
  rows: Record<string, { mode: 'loop' | 'once'; ms: number[] }>;
  /** Frame rects by density, then row. */
  frames: Record<string, Record<string, DerivedRect[]>>;
}

export interface AtlasPage {
  /** Named by the hash of the page's pixels, so a check never depends on an encoder's bytes. */
  file: string;
  w: number;
  h: number;
}

/** Painted pages ship as WebP (lossy colour, lossless alpha); exact pages as lossless PNG. */
export const WEBP = { quality: 90, method: 4, use_sharp_yuv: 1, alpha_quality: 100 } as const;

export interface DerivedManifest {
  version: 2;
  levels: number[];
  /** Atlas pages by key: the group for exact sheets, group@density for painted ones. */
  atlases: Record<string, AtlasPage[]>;
  sprites: Record<string, DerivedSprite>;
}

export interface AssetReportRow {
  id: string;
  kind: 'exact' | 'painted' | 'unused';
  size: string;
  /** Round-trip error (share of visible pixels) at each factor tried. */
  tried: Record<string, number>;
  factor: number;
  /** Error at the chosen factor (0 at factor 1: nothing is resampled). */
  error: number;
  previousGrid: number;
  previousError: number | null;
}

// ---- pixels -------------------------------------------------------------------------------------

export function blank(width: number, height: number): Rgba {
  return { width, height, data: new Uint8Array(width * height * 4) };
}

/** Block edges for n output pixels over len source pixels, starting at phase. */
function edges(len: number, n: number, phase: number): number[] {
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(Math.min(len, Math.floor(phase + (i * len) / n)));
  return out;
}

/** One block's colour: transparent unless most of it is opaque, else the mean of its most common colour. */
function blockColour(img: Rgba, x0: number, x1: number, y0: number, y1: number, out: Uint8Array, o: number): void {
  const { width, data } = img;
  const votes = new Map<number, [number, number, number, number]>();
  let opaque = 0;
  const area = Math.max(1, (x1 - x0) * (y1 - y0));
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      if ((data[i + 3] ?? 0) < 128) continue;
      opaque++;
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      const v = votes.get(key);
      if (v) {
        v[0] += r;
        v[1] += g;
        v[2] += b;
        v[3]++;
      } else votes.set(key, [r, g, b, 1]);
    }
  if (opaque * 2 < area) return;
  let best: [number, number, number, number] = [0, 0, 0, 0];
  for (const v of votes.values()) if (v[3] > best[3]) best = v;
  out[o] = Math.round(best[0] / best[3]);
  out[o + 1] = Math.round(best[1] / best[3]);
  out[o + 2] = Math.round(best[2] / best[3]);
  out[o + 3] = 255;
}

/** Downscales a whole exact sheet by an integer factor, one majority colour per block. */
export function downscale(img: Rgba, f: number): Rgba {
  const w = Math.round(img.width / f);
  const h = Math.round(img.height / f);
  const out = blank(w, h);
  const ex = edges(img.width, w, 0);
  const ey = edges(img.height, h, 0);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) blockColour(img, ex[i] ?? 0, ex[i + 1] ?? 0, ey[j] ?? 0, ey[j + 1] ?? 0, out.data, (j * w + i) * 4);
  return out;
}

/**
 * Nearest round trip at factor f: every pixel is compared with the pixel at its block's centre
 * (what a nearest downscale keeps and a nearest upscale puts back). Returns the share of visible
 * pixels that move by more than ROUND_TRIP.channel in any channel. step samples every step-th row.
 */
export function roundTrip(img: Rgba, f: number, phase = { x: 0, y: 0 }, step = 1): number {
  const { width: w, height: h, data: d } = img;
  let diff = 0;
  let seen = 0;
  const half = Math.floor(f / 2);
  const col = new Int32Array(w);
  for (let x = 0; x < w; x++) col[x] = Math.min(w - 1, Math.max(0, Math.floor((x - phase.x) / f) * f + phase.x + half));
  for (let y = 0; y < h; y += step) {
    const sy = Math.min(h - 1, Math.max(0, Math.floor((y - phase.y) / f) * f + phase.y + half));
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const j = (sy * w + (col[x] ?? 0)) * 4;
      const a1 = d[i + 3] ?? 0;
      const a2 = d[j + 3] ?? 0;
      if (a1 < 8 && a2 < 8) continue;
      seen++;
      const m = Math.max(
        Math.abs((d[i] ?? 0) - (d[j] ?? 0)),
        Math.abs((d[i + 1] ?? 0) - (d[j + 1] ?? 0)),
        Math.abs((d[i + 2] ?? 0) - (d[j + 2] ?? 0)),
        Math.abs(a1 - a2),
      );
      if (m > ROUND_TRIP.channel) diff++;
    }
  }
  return seen ? diff / seen : 0;
}

/** The round trip at the block phase that fits the art best (painted art may sit off the origin). */
export function bestRoundTrip(img: Rgba, f: number, anyPhase: boolean): number {
  if (!anyPhase) return roundTrip(img, f);
  const phases = f <= 4 ? [...Array(f).keys()] : [...new Set([0, 1, 2, 3, 4, 5, 6, 7].map((k) => Math.floor((k * f) / 8)))];
  let best = { x: 0, y: 0 };
  let bestErr = Infinity;
  for (const x of phases)
    for (const y of phases) {
      const e = roundTrip(img, f, { x, y }, 4);
      if (e < bestErr) {
        bestErr = e;
        best = { x, y };
      }
    }
  return roundTrip(img, f, best);
}

/**
 * The largest factor whose round trip passes for every image (images that must share one grid are
 * judged together). A factor is only tried when the sheet and its frame rects divide by it, and is
 * skipped once a divisor of it failed. Exact sheets are judged on the grid at the origin.
 */
export function chooseFactor(imgs: Rgba[], opts: { anyPhase: boolean; divides: number[] }): { factor: number; tried: Record<string, number> } {
  const tried: Record<string, number> = {};
  const failed: number[] = [];
  let factor = 1;
  for (const f of FACTORS) {
    if (failed.some((d) => f % d === 0)) continue;
    if (opts.divides.some((n) => n % f !== 0)) continue;
    const err = Math.max(...imgs.map((img) => bestRoundTrip(img, f, opts.anyPhase)));
    tried[f] = round4(err);
    if (err <= ROUND_TRIP.share) factor = Math.max(factor, f);
    else failed.push(f);
  }
  return { factor, tried };
}

/** 4-connected blobs of opaque pixels. Returns a label per pixel (-1 when empty) and the blob count. */
export function label(mask: Uint8Array, width: number, height: number): { labels: Int32Array; count: number } {
  const labels = new Int32Array(width * height).fill(-1);
  const stack = new Int32Array(width * height);
  let count = 0;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start] !== -1) continue;
    let top = 0;
    stack[top++] = start;
    labels[start] = count;
    while (top > 0) {
      const p = stack[--top] ?? 0;
      const y = (p / width) | 0;
      const x = p - y * width;
      const near = [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, y > 0 ? p - width : -1, y < height - 1 ? p + width : -1];
      for (const q of near)
        if (q >= 0 && mask[q] && labels[q] === -1) {
          labels[q] = count;
          stack[top++] = q;
        }
    }
    count++;
  }
  return { labels, count };
}

/** Breadth-first spread of owners over all pixels: nearest owned pixel's owner and its distance. */
function spread(owner: Int32Array, width: number, height: number, maxDist = Infinity): { near: Int32Array; dist: Int32Array } {
  const n = width * height;
  const near = new Int32Array(n).fill(-1);
  const dist = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let p = 0; p < n; p++)
    if ((owner[p] ?? -1) >= 0) {
      near[p] = owner[p] ?? -1;
      dist[p] = 0;
      queue[tail++] = p;
    }
  while (head < tail) {
    const p = queue[head++] ?? 0;
    const d = dist[p] ?? 0;
    if (d >= maxDist) continue;
    const y = (p / width) | 0;
    const x = p - y * width;
    for (const q of [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, y > 0 ? p - width : -1, y < height - 1 ? p + width : -1]) {
      if (q < 0 || dist[q] !== -1) continue;
      dist[q] = d + 1;
      near[q] = near[p] ?? -1;
      queue[tail++] = q;
    }
  }
  return { near, dist };
}

/**
 * Which cell owns each opaque pixel. Each cell's biggest blob is its main body. A blob that no cell
 * holds 85% of is two bodies touching: each pixel stays in the cell it sits in. Every other blob (a
 * comb a pixel above the head, a dropped egg, a sweat drop) belongs to the nearest main body, by
 * pixel distance, even when it pokes into the next cell: that is how a comb stays on its own hen and
 * never shows up under the hen in the row above.
 */
export function cellOwners(mask: Uint8Array, width: number, height: number, cw: number, ch: number): Int32Array {
  const { labels, count } = label(mask, width, height);
  const cols = Math.round(width / cw);
  const rowsN = Math.round(height / ch);
  const cellOf = (p: number) => {
    const y = (p / width) | 0;
    const x = p - y * width;
    return Math.min(Math.floor(y / ch), rowsN - 1) * cols + Math.min(Math.floor(x / cw), cols - 1);
  };
  const mass: Map<number, number>[] = Array.from({ length: count }, () => new Map());
  const total = new Array<number>(count).fill(0);
  for (let p = 0; p < labels.length; p++) {
    const l = labels[p] ?? -1;
    if (l < 0) continue;
    const m = mass[l] as Map<number, number>;
    const c = cellOf(p);
    m.set(c, (m.get(c) ?? 0) + 1);
    total[l] = (total[l] ?? 0) + 1;
  }
  const dominant = mass.map((m, l) => {
    let best = -1;
    let bestN = 0;
    for (const [c, n] of m)
      if (n > bestN) {
        bestN = n;
        best = c;
      }
    return bestN >= 0.85 * (total[l] ?? 1) ? best : -1;
  });
  const main = new Map<number, number>();
  for (let l = 0; l < count; l++) {
    const c = dominant[l] ?? -1;
    if (c < 0) continue;
    const cur = main.get(c);
    if (cur === undefined || (total[l] ?? 0) > (total[cur] ?? 0)) main.set(c, l);
  }
  const isMain = new Set(main.values());
  const seed = new Int32Array(labels.length).fill(-1);
  for (let p = 0; p < labels.length; p++) {
    const l = labels[p] ?? -1;
    if (l >= 0 && isMain.has(l)) seed[p] = dominant[l] ?? -1;
  }
  const { near, dist } = spread(seed, width, height);
  const attach = new Array<number>(count).fill(-1);
  const closest = new Array<number>(count).fill(Infinity);
  for (let p = 0; p < labels.length; p++) {
    const l = labels[p] ?? -1;
    if (l < 0 || isMain.has(l) || dominant[l] === -1) continue;
    const d = dist[p] ?? -1;
    if (d >= 0 && d < (closest[l] ?? Infinity)) {
      closest[l] = d;
      attach[l] = near[p] ?? -1;
    }
  }
  const owner = new Int32Array(labels.length).fill(-1);
  for (let p = 0; p < labels.length; p++) {
    const l = labels[p] ?? -1;
    if (l < 0) continue;
    const d = dominant[l] ?? -1;
    if (d < 0) owner[p] = cellOf(p);
    else if (isMain.has(l)) owner[p] = d;
    else owner[p] = (attach[l] ?? -1) >= 0 ? (attach[l] as number) : d;
  }
  return owner;
}

/**
 * Cell ownership for stacked layers: cells are decided on the first layer (the body) alone, so tall
 * trait art (a mohawk, a top hat) can never bridge two hens; every other layer's blobs then join the
 * body they touch along the most pixels (far blobs join the nearest body). Soft edge pixels (below
 * half alpha) join the owner of the nearest solid pixel within three pixels; fainter specks are dropped.
 */
export function layerOwners(layers: Rgba[], width: number, height: number, cw: number, ch: number): Int32Array {
  const n = width * height;
  const solid = layers.map((l) => {
    const d = new Uint8Array(l.data);
    alphaCut(d);
    return d;
  });
  const primary = new Uint8Array(n);
  for (let p = 0; p < n; p++) primary[p] = (solid[0]?.[p * 4 + 3] ?? 0) > 0 ? 1 : 0;
  const owner = cellOwners(primary, width, height, cw, ch);
  if (layers.length > 1) {
    const { near, dist } = spread(owner, width, height);
    const rest = new Uint8Array(n);
    for (const l of solid.slice(1)) for (let p = 0; p < n; p++) if ((l[p * 4 + 3] ?? 0) > 0 && !primary[p]) rest[p] = 1;
    const { labels, count } = label(rest, width, height);
    const best = new Array<number>(count).fill(Infinity);
    const cell = new Array<number>(count).fill(-1);
    const contact: Map<number, number>[] = Array.from({ length: count }, () => new Map());
    for (let p = 0; p < n; p++) {
      const l = labels[p] ?? -1;
      if (l < 0) continue;
      const d = dist[p] ?? -1;
      const c = near[p] ?? -1;
      if (d >= 0 && d <= 2 && c >= 0) {
        const m = contact[l] as Map<number, number>;
        m.set(c, (m.get(c) ?? 0) + 1);
      }
      if (d >= 0 && d < (best[l] ?? Infinity)) {
        best[l] = d;
        cell[l] = c;
      }
    }
    contact.forEach((m, l) => {
      let top = -1;
      let topN = 0;
      for (const [c, k] of m)
        if (k > topN) {
          topN = k;
          top = c;
        }
      if (top >= 0) cell[l] = top;
    });
    for (let p = 0; p < n; p++) {
      const l = labels[p] ?? -1;
      if (l >= 0) owner[p] = cell[l] ?? -1;
    }
  }
  // soft edges: anything visible in any layer joins the nearest solid owner, three pixels at most
  const soft = spread(owner, width, height, 3);
  for (let p = 0; p < n; p++) {
    if ((owner[p] ?? -1) >= 0) continue;
    if (!layers.some((l) => (l.data[p * 4 + 3] ?? 0) >= 8)) continue;
    owner[p] = soft.near[p] ?? -1;
  }
  return owner;
}

// ---- slicing ------------------------------------------------------------------------------------

export interface Cut {
  /** Which source cell (col, row) a frame comes from, and its anchor point in source pixels. */
  col: number;
  row: number;
  ax: number;
  ay: number;
  ms: number;
}

/** Source cell and anchor point for each frame name of a painted sheet with uniform cells. */
export function cutsFor(json: SheetJson, cw: number, ch: number): Record<string, Cut> {
  const out: Record<string, Cut> = {};
  for (const [name, f] of Object.entries(json.frames)) {
    const ax = f.frame.x + f.anchor.x * f.frame.w;
    const ay = f.frame.y + f.anchor.y * f.frame.h;
    // frames with headroom (the hen) are placed by their anchor; plain cells by their own rect
    const row = f.frame.h === ch ? Math.floor(f.frame.y / ch) : Math.floor((ay - 1) / ch);
    out[name] = { col: Math.floor(f.frame.x / cw), row, ax, ay, ms: f.duration || 100 };
  }
  return out;
}

/** A frame at full resolution: the owned pixels of one layer in one cell, with its anchor. */
export interface Piece {
  img: Rgba;
  /** Where the piece's top left sits in the sheet, and the anchor in sheet pixels. */
  x: number;
  y: number;
  ax: number;
  ay: number;
}

/** Pixel indices owned by each cell, in scan order. */
export function pixelsByCell(owner: Int32Array): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (let p = 0; p < owner.length; p++) {
    const c = owner[p] ?? -1;
    if (c < 0) continue;
    const list = out.get(c);
    if (list) list.push(p);
    else out.set(c, [p]);
  }
  return out;
}

/** Cuts every layer's own pixels for one cell (each layer its own box; one shared anchor). */
export function cutCell(layers: Rgba[], pixels: number[], anchor: { ax: number; ay: number }): Piece[] {
  const width = (layers[0] as Rgba).width;
  return layers.map((layer) => {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const p of pixels) {
      if ((layer.data[p * 4 + 3] ?? 0) === 0) continue;
      const y = (p / width) | 0;
      const x = p - y * width;
      if (x < x0) x0 = x;
      if (x >= x1) x1 = x + 1;
      if (y < y0) y0 = y;
      if (y >= y1) y1 = y + 1;
    }
    if (x0 === Infinity) return { img: blank(0, 0), x: Math.round(anchor.ax), y: Math.round(anchor.ay), ax: anchor.ax, ay: anchor.ay };
    const img = blank(x1 - x0, y1 - y0);
    for (const p of pixels) {
      const s = p * 4;
      if ((layer.data[s + 3] ?? 0) === 0) continue;
      const y = (p / width) | 0;
      const x = p - y * width;
      img.data.set(layer.data.subarray(s, s + 4), ((y - y0) * img.width + (x - x0)) * 4);
    }
    return { img, x: x0, y: y0, ax: anchor.ax, ay: anchor.ay };
  });
}

/** Overlap weights of destination texels over source pixels along one axis (texel grid starts at origin). */
function weights(srcStart: number, srcLen: number, origin: number, s: number, i0: number, n: number): { first: number; w: number[] }[] {
  const out: { first: number; w: number[] }[] = [];
  for (let i = 0; i < n; i++) {
    const a = origin + (i0 + i) / s - srcStart;
    const b = origin + (i0 + i + 1) / s - srcStart;
    const first = Math.max(0, Math.floor(a));
    const last = Math.min(srcLen - 1, Math.ceil(b) - 1);
    const w: number[] = [];
    for (let k = first; k <= last; k++) w.push(Math.max(0, Math.min(b, k + 1) - Math.max(a, k)));
    out.push({ first, w });
  }
  return out;
}

/**
 * Resamples a piece to s texels per source pixel by exact area coverage (premultiplied alpha), on a
 * texel grid that starts at the anchor: the pivot lands on a whole texel, so stacked layers resampled
 * on their own still line up, and a mirrored sprite stays in place. Integer scale-ups replicate pixels.
 */
export function resample(piece: Piece, s: number): { img: Rgba; px: number; py: number } {
  const { img, x, y, ax, ay } = piece;
  if (!img.width || !img.height) return { img: blank(0, 0), px: 0, py: 0 };
  const i0 = Math.floor((x - ax) * s + 1e-9);
  const i1 = Math.ceil((x + img.width - ax) * s - 1e-9);
  const j0 = Math.floor((y - ay) * s + 1e-9);
  const j1 = Math.ceil((y + img.height - ay) * s - 1e-9);
  const w = i1 - i0;
  const h = j1 - j0;
  const wx = weights(x, img.width, ax, s, i0, w);
  const wy = weights(y, img.height, ay, s, j0, h);
  // horizontal pass, premultiplied
  const tmp = new Float64Array(w * img.height * 4);
  const src = img.data;
  for (let r = 0; r < img.height; r++)
    for (let i = 0; i < w; i++) {
      const { first, w: ws } = wx[i] as { first: number; w: number[] };
      let R = 0;
      let G = 0;
      let B = 0;
      let A = 0;
      for (let k = 0; k < ws.length; k++) {
        const o = (r * img.width + first + k) * 4;
        const a = ((src[o + 3] ?? 0) / 255) * (ws[k] ?? 0);
        R += (src[o] ?? 0) * a;
        G += (src[o + 1] ?? 0) * a;
        B += (src[o + 2] ?? 0) * a;
        A += a;
      }
      const t = (r * w + i) * 4;
      tmp[t] = R;
      tmp[t + 1] = G;
      tmp[t + 2] = B;
      tmp[t + 3] = A;
    }
  const out = blank(w, h);
  const area = 1 / (s * s);
  for (let j = 0; j < h; j++) {
    const { first, w: ws } = wy[j] as { first: number; w: number[] };
    for (let i = 0; i < w; i++) {
      let R = 0;
      let G = 0;
      let B = 0;
      let A = 0;
      for (let k = 0; k < ws.length; k++) {
        const t = ((first + k) * w + i) * 4;
        const wk = ws[k] ?? 0;
        R += (tmp[t] ?? 0) * wk;
        G += (tmp[t + 1] ?? 0) * wk;
        B += (tmp[t + 2] ?? 0) * wk;
        A += (tmp[t + 3] ?? 0) * wk;
      }
      const alpha = Math.min(1, A / area);
      const o = (j * w + i) * 4;
      const a8 = Math.round(alpha * 255);
      if (a8 === 0) continue;
      out.data[o] = Math.min(255, Math.round(R / A));
      out.data[o + 1] = Math.min(255, Math.round(G / A));
      out.data[o + 2] = Math.min(255, Math.round(B / A));
      out.data[o + 3] = a8;
    }
  }
  return { img: out, px: -i0, py: -j0 };
}

// ---- atlas --------------------------------------------------------------------------------------

export interface Placed {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
  page: number;
}

/** Shelf packing, tallest first, 1 px gutters, into pages of at most PAGE x PAGE; identical images share one rect. */
export function pack(items: { key: string; img: Rgba }[], maxWidth = 1024): { placed: Map<string, Placed>; pages: Rgba[] } {
  const unique = new Map<string, { img: Rgba; keys: string[] }>();
  for (const it of items) {
    const h = createHash('sha1').update(it.img.data).update(`${it.img.width}x${it.img.height}`).digest('hex');
    const u = unique.get(h);
    if (u) u.keys.push(it.key);
    else unique.set(h, { img: it.img, keys: [it.key] });
  }
  const list = [...unique.values()].sort((a, b) => b.img.height - a.img.height || b.img.width - a.img.width || (a.keys[0] ?? '').localeCompare(b.keys[0] ?? ''));
  const widest = Math.max(1, ...list.map((u) => u.img.width + 2));
  const width = Math.min(PAGE, Math.max(maxWidth, widest));
  const spots: { u: (typeof list)[number]; x: number; y: number; page: number }[] = [];
  let page = 0;
  let x = 1;
  let y = 1;
  let shelf = 0;
  for (const u of list) {
    if (x + u.img.width + 1 > width) {
      x = 1;
      y += shelf + 1;
      shelf = 0;
    }
    if (y + u.img.height + 1 > PAGE) {
      page++;
      x = 1;
      y = 1;
      shelf = 0;
    }
    spots.push({ u, x, y, page });
    x += u.img.width + 1;
    shelf = Math.max(shelf, u.img.height);
  }
  const pages: Rgba[] = [];
  for (let p = 0; p <= page; p++) {
    const mine = spots.filter((s) => s.page === p);
    const w = Math.max(2, ...mine.map((s) => s.x + s.u.img.width + 1));
    const h = Math.max(2, ...mine.map((s) => s.y + s.u.img.height + 1));
    pages.push(blank(w, h));
  }
  const placed = new Map<string, Placed>();
  for (const s of spots) {
    const image = pages[s.page] as Rgba;
    for (let r = 0; r < s.u.img.height; r++) {
      const src = s.u.img.data.subarray(r * s.u.img.width * 4, (r + 1) * s.u.img.width * 4);
      image.data.set(src, ((s.y + r) * image.width + s.x) * 4);
    }
    for (const key of s.u.keys) placed.set(key, { key, x: s.x, y: s.y, w: s.u.img.width, h: s.u.img.height, page: s.page });
  }
  return { placed, pages };
}

// ---- the whole step -----------------------------------------------------------------------------

export interface SourceSprite {
  id: string;
  png: Rgba;
  json: SheetJson;
  rows: Record<string, { mode: 'loop' | 'once' }>;
  grid: number;
}

export interface DeriveInput {
  sprites: Record<string, SourceSprite>;
  bodyRecolour: Record<string, [[number, number, number], [number, number, number]]>;
}

export interface DeriveOutput {
  manifest: DerivedManifest;
  /** Atlas pages by file name, still as pixels (derive-assets encodes them). */
  pages: Map<string, { image: Rgba; format: 'png' | 'webp' }>;
  /** One row per asset: factors tried, the one chosen and its round-trip error. */
  assets: AssetReportRow[];
  log: string[];
}

interface PendingFrame {
  key: string;
  px: number;
  py: number;
  sub?: { x: number; y: number; w: number; h: number };
}

export function derive(input: DeriveInput): DeriveOutput {
  const log: string[] = [];
  const assets: AssetReportRow[] = [];
  const atlasItems = new Map<string, { key: string; img: Rgba }[]>();
  const add = (atlas: string, key: string, img: Rgba) => {
    const list = atlasItems.get(atlas) ?? [];
    list.push({ key, img });
    atlasItems.set(atlas, list);
  };
  const pending: Record<
    string,
    Omit<DerivedSprite, 'frames' | 'sheet'> & { sheetKey?: string; sheetAtlas?: string; frames: Record<string, { atlas: string; rows: Record<string, PendingFrame[]> }> }
  > = {};
  const src = (id: string): SourceSprite => {
    const s = input.sprites[id];
    if (!s) throw new Error(`derive: missing sheet ${id}`);
    return s;
  };
  const rowsOf = (s: SourceSprite) =>
    Object.fromEntries(Object.entries(s.json.animations).map(([row, names]) => [row, { mode: s.rows[row]?.mode ?? 'loop', ms: names.map((n) => s.json.frames[n]?.duration || 100) }]));

  // exact sheets: the whole sheet at its factor, frames are sub-rects
  for (const [id, group] of Object.entries(EXACT_GROUP)) {
    const s = src(id);
    const rects = Object.values(s.json.frames).flatMap((f) => [f.frame.x, f.frame.y, f.frame.w, f.frame.h]);
    const { factor, tried } = chooseFactor([s.png], { anyPhase: false, divides: [s.png.width, s.png.height, ...rects] });
    if (factor < 2) throw new Error(`derive: ${id} has no exact grid`);
    const img = downscale(s.png, factor);
    const sheetKey = `${id}#sheet`;
    add(group, sheetKey, img);
    const rows: Record<string, PendingFrame[]> = {};
    for (const [row, names] of Object.entries(s.json.animations))
      rows[row] = names.map((n) => {
        const f = s.json.frames[n] as SheetFrameJson;
        const sub = { x: f.frame.x / factor, y: f.frame.y / factor, w: f.frame.w / factor, h: f.frame.h / factor };
        return { key: sheetKey, sub, px: f.anchor.x * sub.w, py: f.anchor.y * sub.h };
      });
    pending[id] = { group, kind: 'exact', factor, scale: factor / s.grid, ratio: s.grid, levels: [1], rows: rowsOf(s), sheetKey, sheetAtlas: group, frames: { '1': { atlas: group, rows } } };
    assets.push({ id, kind: 'exact', size: `${s.png.width}x${s.png.height}`, tried, factor, error: tried[factor] ?? 0, previousGrid: s.grid, previousError: tried[s.grid] ?? null });
    log.push(`${id}: exact, factor ${factor}, ${img.width}x${img.height}`);
  }

  // painted sheets: the hen layers together, the rest one by one
  const henSet = new Set(HEN_LAYERS);
  const sets: string[][] = [HEN_LAYERS, ...Object.keys(PAINTED).filter((id) => !henSet.has(id)).map((id) => [id])];
  for (const ids of sets) {
    const first = src(ids[0] as string);
    const spec = PAINTED[ids[0] as string] as PaintedSpec;
    const fr = Object.values(first.json.frames)[0] as SheetFrameJson;
    const cw = fr.frame.w;
    const ch = henSet.has(ids[0] as string) ? HEN_CELL : fr.frame.h;
    const sheets = ids.map((id) => src(id).png);
    // each sheet is judged on its own; a set that must stack takes the largest factor all of them pass
    const own = ids.map((id) => chooseFactor([src(id).png], { anyPhase: true, divides: [cw, ch] }));
    const factor = Math.max(1, ...FACTORS.filter((f) => own.every((o) => (o.tried[f] ?? 1) <= ROUND_TRIP.share)));
    ids.forEach((id, i) => {
      const mine = own[i] as { factor: number; tried: Record<string, number> };
      const prev = PREVIOUS_GRID[id] ?? 1;
      assets.push({
        id,
        kind: 'painted',
        size: `${src(id).png.width}x${src(id).png.height}`,
        tried: mine.tried,
        factor,
        error: factor === 1 ? 0 : (mine.tried[factor] ?? 0),
        previousGrid: prev,
        previousError: mine.tried[prev] ?? round4(bestRoundTrip(src(id).png, prev, true)),
      });
    });
    if (factor !== 1) throw new Error(`derive: ${ids.join(', ')} passes at factor ${factor}; painted sheets are expected to keep their resolution`);
    const cols = Math.round(first.png.width / cw);
    const owner = layerOwners(sheets, first.png.width, first.png.height, cw, ch);
    const cuts = cutsFor(first.json, cw, ch);
    // the body's palette swaps come from the full-resolution body, so they share its cut
    const layers = [...sheets];
    const layerIds = [...ids];
    if (ids[0] === '02-body')
      for (const [colour, ramp] of Object.entries(input.bodyRecolour)) {
        const copy = { ...first.png, data: new Uint8Array(first.png.data) };
        recolourBody(copy.data, ramp);
        layers.push(copy);
        layerIds.push(`02-body@${colour}`);
      }
    const byCell = pixelsByCell(owner);
    const cells = new Map<number, Piece[]>();
    for (const c of Object.values(cuts)) {
      const cell = c.row * cols + c.col;
      if (!cells.has(cell)) cells.set(cell, cutCell(layers, byCell.get(cell) ?? [], { ax: c.ax, ay: c.ay }));
    }
    const levels = LEVELS.filter((d) => d <= spec.ratio / factor);
    // art drawn at fewer source pixels per design pixel (coops, the farmhouse, portraits) has fewer
    // densities: it gets its own atlases, so a screen never loads a whole density for two sprites
    const atlasName = spec.ratio < 8 ? `${spec.group}.wide` : spec.group;
    layerIds.forEach((id, li) => {
      const base = src(id.split('@')[0] as string);
      const frames: Record<string, { atlas: string; rows: Record<string, PendingFrame[]> }> = {};
      for (const d of levels) {
        const atlas = `${atlasName}@${d}`;
        const s = d / spec.ratio;
        const rows: Record<string, PendingFrame[]> = {};
        const done = new Map<number, PendingFrame>();
        for (const [row, names] of Object.entries(first.json.animations))
          rows[row] = names.map((n) => {
            const c = cuts[n] as Cut;
            const cell = c.row * cols + c.col;
            const hit = done.get(cell);
            if (hit) return hit;
            const r = resample((cells.get(cell) as Piece[])[li] as Piece, s);
            const key = `${id}#${cell}@${d}`;
            add(atlas, key, r.img);
            const f = { key, px: r.px, py: r.py };
            done.set(cell, f);
            return f;
          });
        frames[String(d)] = { atlas, rows };
      }
      pending[id] = { group: spec.group, kind: 'painted', factor, scale: 1, ratio: spec.ratio, levels: [...levels], atlas: atlasName, rows: rowsOf(base), frames };
    });
    log.push(`${ids.join(', ')}: painted, factor ${factor}, ratio ${spec.ratio}, levels ${levels.join('/')}`);
  }

  for (const id of UNUSED) {
    const s = input.sprites[id];
    if (!s) continue;
    const { factor, tried } = chooseFactor([s.png], { anyPhase: true, divides: [s.png.width, s.png.height] });
    const prev = PREVIOUS_GRID[id] ?? s.grid;
    assets.push({ id, kind: 'unused', size: `${s.png.width}x${s.png.height}`, tried, factor, error: factor === 1 ? 0 : (tried[factor] ?? 0), previousGrid: prev, previousError: tried[prev] ?? null });
  }

  // atlases
  const files: DeriveOutput['pages'] = new Map();
  const atlases: DerivedManifest['atlases'] = {};
  const rects = new Map<string, Placed>();
  const keys = [...atlasItems.keys()].sort((a, b) => {
    const [ga = '', la] = a.split('@');
    const [gb = '', lb] = b.split('@');
    return GROUPS.indexOf(ga.split('.')[0] as Group) - GROUPS.indexOf(gb.split('.')[0] as Group) || ga.localeCompare(gb) || Number(la ?? 0) - Number(lb ?? 0);
  });
  for (const atlas of keys) {
    const items = atlasItems.get(atlas) ?? [];
    const { placed, pages } = pack(items, atlas.includes('@') ? PAGE : 1024);
    const format = atlas.includes('@') ? 'webp' : 'png';
    atlases[atlas] = pages.map((image, i) => {
      const hash = createHash('sha256').update(`${image.width}x${image.height}`).update(image.data).digest('hex').slice(0, 12);
      const file = `${atlas.replace('@', '-at')}${pages.length > 1 ? `-p${i}` : ''}-${hash}.${format}`;
      files.set(file, { image, format });
      log.push(`atlas ${file}: ${image.width}x${image.height}`);
      return { file, w: image.width, h: image.height };
    });
    for (const [key, p] of placed) rects.set(`${atlas}|${key}`, p);
  }

  const sprites: DerivedManifest['sprites'] = {};
  for (const [id, s] of Object.entries(pending).sort(([a], [b]) => a.localeCompare(b))) {
    const frames: DerivedSprite['frames'] = {};
    for (const [level, f] of Object.entries(s.frames)) {
      const rows: Record<string, DerivedRect[]> = {};
      for (const [row, list] of Object.entries(f.rows))
        rows[row] = list.map((p) => {
          const at = rects.get(`${f.atlas}|${p.key}`) as Placed;
          return [at.x + (p.sub?.x ?? 0), at.y + (p.sub?.y ?? 0), p.sub?.w ?? at.w, p.sub?.h ?? at.h, round2(p.px), round2(p.py), at.page];
        });
      frames[level] = rows;
    }
    const sheet = s.sheetKey ? rects.get(`${s.sheetAtlas}|${s.sheetKey}`) : undefined;
    sprites[id] = {
      group: s.group,
      kind: s.kind,
      factor: s.factor,
      scale: s.scale,
      ratio: s.ratio,
      levels: s.levels,
      ...(s.atlas ? { atlas: s.atlas } : {}),
      ...(sheet ? { sheet: [sheet.x, sheet.y, sheet.w, sheet.h, 0, 0, sheet.page] as DerivedRect } : {}),
      rows: s.rows,
      frames,
    };
  }
  return { manifest: { version: 2, levels: [...LEVELS], atlases, sprites }, pages: files, assets: assets.sort((a, b) => a.id.localeCompare(b.id)), log };
}

/** The asset report (docs/asset-report.md): every packed sheet, its factor and its round-trip error. */
export function assetReport(rows: AssetReportRow[], manifest: DerivedManifest, bytesOf: (file: string) => number): string {
  const pct = (v: number | null | undefined) => (v === null || v === undefined ? 'n/a' : `${(v * 100).toFixed(2)}%`);
  const kb = (key: string) => (manifest.atlases[key] ?? []).reduce((n, p) => n + bytesOf(p.file), 0) / 1024;
  const lines = [
    '# Asset report',
    '',
    'Generated by `npm run derive-assets` from the packed sheets (byte copies of iam25th1/coys-assets). Do not edit.',
    '',
    `Rule: each sheet keeps the largest downscale factor whose nearest-neighbour round trip (downscale, upscale back, compare) changes at most ${ROUND_TRIP.share * 100}% of visible pixels by more than ${ROUND_TRIP.channel} of 255 in any channel. Factors tried: ${FACTORS.join(', ')} (a factor is skipped once one of its divisors failed). The hen and its trait layers are judged together and share one factor.`,
    '',
    'Factor 1 means no downscale passes: the art keeps its original resolution, and the per-screen atlases are cut from it at exactly the density each screen draws (see the atlas table).',
    '',
    '| asset | kind | size | factors tried (error) | chosen factor | error at chosen | previous grid | error at previous grid |',
    '|---|---|---|---|---|---|---|---|',
    ...rows.map(
      (r) =>
        `| ${r.id} | ${r.kind} | ${r.size} | ${Object.entries(r.tried)
          .map(([f, e]) => `${f}: ${pct(e)}`)
          .join(', ')} | ${r.factor} | ${pct(r.error)} | ${r.previousGrid} | ${pct(r.previousError)} |`,
    ),
    '',
    '## Atlases',
    '',
    `Painted pages are WebP (quality ${WEBP.quality}, alpha lossless); exact pages are lossless PNG. A screen loads the exact pages of a group and one density of its painted pages.`,
    '',
    '| atlas | pages | size |',
    '|---|---|---|',
    ...Object.entries(manifest.atlases).map(([k, pages]) => `| ${k} | ${pages.map((p) => `${p.w}x${p.h}`).join(', ')} | ${kb(k).toFixed(1)} KB |`),
    '',
  ];
  return lines.join('\n');
}

const round2 = (v: number) => Math.round(v * 100) / 100;
const round4 = (v: number) => Math.round(v * 10000) / 10000;
