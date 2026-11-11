// Derives true-pixel sprite atlases from the packed sheets in apps/client/public/assets.
//
// The packed sheets are big: painted pixel art drawn several screen pixels per art pixel, with soft
// halos. Each sheet is brought down to its true pixel grid (the size of one art pixel, measured from
// outline thickness and listed in GRIDS), one majority colour per block, so the game ships and draws
// the art at its real size. Frames are cut by connected blobs, so art that pokes out of its cell (a
// comb, a flapping wing) stays whole and never brings a neighbour's pixels along. The hen and its
// trait layers are labelled together so they still stack pixel for pixel.
import { createHash } from 'node:crypto';
import { alphaCut, recolourBody } from '../../packages/shared/src/pixels';
import { encodePng, type Rgba } from './png';

/** Screen groups, loaded in this order: each is one atlas page (or a few, when large). */
export const GROUPS = ['boot', 'title', 'farm', 'market', 'cards', 'ui', 'fx'] as const;
export type Group = (typeof GROUPS)[number];

export interface GridSpec {
  /** Source pixels per art pixel. */
  grid: number;
  /** World pixels per derived pixel: 1 for true size; other values are reported (see README). */
  scale: number;
  group: Group;
}

/** Painted sheets (soft edges, no exact grid): their true grid, measured from outline thickness. */
export const PAINTED: Record<string, GridSpec> = {
  '01-hen-anims': { grid: 8, scale: 1, group: 'farm' },
  '02-body': { grid: 8, scale: 1, group: 'farm' },
  '02-eyes-sleepy': { grid: 8, scale: 1, group: 'farm' },
  '02-eyes-wild': { grid: 8, scale: 1, group: 'farm' },
  '02-comb-default': { grid: 8, scale: 1, group: 'farm' },
  '02-comb-spiky': { grid: 8, scale: 1, group: 'farm' },
  '02-comb-mohawk': { grid: 8, scale: 1, group: 'farm' },
  '02-comb-nub': { grid: 8, scale: 1, group: 'farm' },
  '02-acc-tophat': { grid: 8, scale: 1, group: 'farm' },
  '02-acc-bowtie': { grid: 8, scale: 1, group: 'farm' },
  '02-acc-shades': { grid: 8, scale: 1, group: 'farm' },
  '11-egg-white': { grid: 12, scale: 1, group: 'farm' },
  '11-egg-cream': { grid: 12, scale: 1, group: 'farm' },
  '11-egg-brown': { grid: 12, scale: 1, group: 'farm' },
  '11-egg-golden': { grid: 12, scale: 1, group: 'farm' },
  '12-crate': { grid: 8, scale: 1, group: 'farm' },
  '13-sack-cheap': { grid: 8, scale: 1, group: 'farm' },
  '13-sack-standard': { grid: 8, scale: 1, group: 'farm' },
  '13-sack-premium': { grid: 8, scale: 1, group: 'farm' },
  '14-trough': { grid: 8, scale: 1, group: 'farm' },
  // coops are drawn coarser (8) than the composition wants (4): shown at 2 world pixels per art pixel
  '15-coop-starter': { grid: 8, scale: 2, group: 'farm' },
  '15-coop-red': { grid: 8, scale: 2, group: 'farm' },
  '15-coop-deluxe': { grid: 8, scale: 2, group: 'farm' },
  '16-farmhouse': { grid: 4, scale: 1, group: 'farm' },
  '17-sign-farm': { grid: 8, scale: 1, group: 'farm' },
  '17-sign-upstart': { grid: 6, scale: 1, group: 'market' },
  '17-sign-old-money': { grid: 6, scale: 1, group: 'market' },
  // machines are drawn finer (4) than the hen's grid: kept fine, shown at half a world pixel each
  '19-egg-grader': { grid: 4, scale: 0.5, group: 'farm' },
  '19b-egg-sorter': { grid: 4, scale: 0.5, group: 'farm' },
  '20-delivery-cart': { grid: 4, scale: 0.5, group: 'farm' },
  '21-feed-hopper': { grid: 4, scale: 0.5, group: 'farm' },
  '22-sales-clerk': { grid: 4, scale: 0.5, group: 'farm' },
  '04-upstart': { grid: 4, scale: 1, group: 'cards' },
  '05-old-money': { grid: 4, scale: 1, group: 'cards' },
  '06-squeezer': { grid: 4, scale: 1, group: 'cards' },
  '07-loyalist': { grid: 4, scale: 1, group: 'cards' },
  '08-bakery-buyer': { grid: 4, scale: 1, group: 'cards' },
  '09-market-trader': { grid: 4, scale: 1, group: 'cards' },
  '10-wholesaler': { grid: 4, scale: 1, group: 'cards' },
  'x-hen-portrait': { grid: 8, scale: 1, group: 'title' },
};

/** Sheets already drawn on an exact grid (the packer measured it): downscaled whole. */
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
  '18-conveyor': 'farm',
  '23-farm-tileset': 'farm',
  '24-farm-props': 'farm',
  '27-town-square-plate': 'market',
  '27-town-square-anim': 'market',
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

/** The base hen and its trait layers share one cell layout and one blob labelling. */
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

/** One frame in an atlas: rect, pivot (anchor point, from the rect's top left) and duration. */
export type DerivedFrame = [x: number, y: number, w: number, h: number, px: number, py: number, ms: number];

export interface DerivedSprite {
  group: Group;
  /** World pixels per atlas pixel. */
  scale: number;
  /** Source pixels per atlas pixel (the art's true grid). */
  grid: number;
  /** Exact sheets: where the whole downscaled sheet sits in its atlas, for tile lookups. */
  sheet?: { x: number; y: number; w: number; h: number };
  rows: Record<string, { mode: 'loop' | 'once'; frames: DerivedFrame[] }>;
}

export interface DerivedManifest {
  version: 1;
  atlases: Record<string, { file: string; w: number; h: number; bytes: number }>;
  sprites: Record<string, DerivedSprite>;
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
function blockColour(img: Rgba, x0: number, x1: number, y0: number, y1: number, out: Uint8Array, o: number): number {
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
  if (opaque * 2 < area) return area - opaque;
  let best: [number, number, number, number] = [0, 0, 0, 0];
  for (const v of votes.values()) if (v[3] > best[3]) best = v;
  out[o] = Math.round(best[0] / best[3]);
  out[o + 1] = Math.round(best[1] / best[3]);
  out[o + 2] = Math.round(best[2] / best[3]);
  out[o + 3] = 255;
  return opaque - best[3] + (area - opaque);
}

/**
 * Downscales a sheet to n x m pixels per cell (cells of cw x ch source pixels), one majority colour
 * per block. Returns the image and its disagreement (pixels that differ from their block's colour).
 */
export function downscale(img: Rgba, cw: number, ch: number, nx: number, ny: number, phase = { x: 0, y: 0 }): { img: Rgba; cost: number } {
  const cols = Math.round(img.width / cw);
  const rows = Math.round(img.height / ch);
  const out = blank(cols * nx, rows * ny);
  let cost = 0;
  for (let cy = 0; cy < rows; cy++)
    for (let cx = 0; cx < cols; cx++) {
      const ex = edges(cw, nx, phase.x).map((e) => Math.min(img.width, cx * cw + e));
      const ey = edges(ch, ny, phase.y).map((e) => Math.min(img.height, cy * ch + e));
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          const o = ((cy * ny + j) * out.width + cx * nx + i) * 4;
          cost += blockColour(img, ex[i] ?? 0, ex[i + 1] ?? 0, ey[j] ?? 0, ey[j + 1] ?? 0, out.data, o);
        }
    }
  return { img: out, cost };
}

/** The block phase that best fits the art's own grid (least disagreement), searched on a few offsets. */
export function bestPhase(img: Rgba, cw: number, ch: number, nx: number, ny: number): { x: number; y: number } {
  const bx = cw / nx;
  const by = ch / ny;
  const steps = (b: number) => [...new Set([0, 0.25, 0.5, 0.75].map((f) => Math.floor(b * f)))];
  let best = { x: 0, y: 0 };
  let bestCost = Infinity;
  for (const x of steps(bx))
    for (const y of steps(by)) {
      const { cost } = downscale(img, cw, ch, nx, ny, { x, y });
      if (cost < bestCost) {
        bestCost = cost;
        best = { x, y };
      }
    }
  return best;
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

/**
 * Which cell owns each opaque pixel. A blob goes whole to the cell holding most of it (so art that
 * pokes into the next cell stays with its frame), unless no cell holds 85% of it: then it is two
 * things touching, and each pixel stays in the cell it sits in.
 */
export function cellOwners(mask: Uint8Array, width: number, height: number, cw: number, ch: number): Int32Array {
  const { labels, count } = label(mask, width, height);
  const cols = Math.round(width / cw);
  const mass: Map<number, number>[] = Array.from({ length: count }, () => new Map());
  const cellOf = (p: number) => {
    const y = (p / width) | 0;
    const x = p - y * width;
    return Math.min(Math.floor(y / ch), Math.round(height / ch) - 1) * cols + Math.min(Math.floor(x / cw), cols - 1);
  };
  for (let p = 0; p < labels.length; p++) {
    const l = labels[p] ?? -1;
    if (l < 0) continue;
    const m = mass[l] as Map<number, number>;
    const c = cellOf(p);
    m.set(c, (m.get(c) ?? 0) + 1);
  }
  const winner = mass.map((m) => {
    let total = 0;
    let best = -1;
    let bestN = 0;
    for (const [c, n] of m) {
      total += n;
      if (n > bestN) {
        bestN = n;
        best = c;
      }
    }
    return bestN >= 0.85 * total ? best : -1;
  });
  const owner = new Int32Array(labels.length).fill(-1);
  for (let p = 0; p < labels.length; p++) {
    const l = labels[p] ?? -1;
    if (l < 0) continue;
    const w = winner[l] ?? -1;
    owner[p] = w >= 0 ? w : cellOf(p);
  }
  return owner;
}

export function opaqueMask(img: Rgba): Uint8Array {
  const m = new Uint8Array(img.width * img.height);
  for (let i = 0; i < m.length; i++) m[i] = (img.data[i * 4 + 3] ?? 0) > 0 ? 1 : 0;
  return m;
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

export interface Piece {
  img: Rgba;
  /** Pivot in the piece, in derived pixels. */
  px: number;
  py: number;
  /** The cell this piece came from. */
  cell: number;
}

/**
 * Cuts one piece per cell from downscaled layers that share a cell layout: each piece is the
 * union bounding box of the cell's own pixels across layers, so stacked layers line up exactly.
 */
export function cutCells(
  layers: Rgba[],
  cols: number,
  rows: number,
  nx: number,
  ny: number,
  anchors: Map<number, { ax: number; ay: number }>,
): Map<number, Piece[]> {
  const first = layers[0] as Rgba;
  const { width, height } = first;
  const union = new Uint8Array(width * height);
  for (const l of layers) for (let i = 0; i < union.length; i++) if ((l.data[i * 4 + 3] ?? 0) > 0) union[i] = 1;
  const owner = cellOwners(union, width, height, nx, ny);
  const boxes = new Map<number, { x0: number; y0: number; x1: number; y1: number }>();
  for (let p = 0; p < owner.length; p++) {
    const c = owner[p] ?? -1;
    if (c < 0) continue;
    const y = (p / width) | 0;
    const x = p - y * width;
    const b = boxes.get(c);
    if (!b) boxes.set(c, { x0: x, y0: y, x1: x + 1, y1: y + 1 });
    else {
      b.x0 = Math.min(b.x0, x);
      b.y0 = Math.min(b.y0, y);
      b.x1 = Math.max(b.x1, x + 1);
      b.y1 = Math.max(b.y1, y + 1);
    }
  }
  const out = new Map<number, Piece[]>();
  for (let cell = 0; cell < cols * rows; cell++) {
    const box = boxes.get(cell);
    const a = anchors.get(cell);
    const cx = (cell % cols) * nx;
    const cy = Math.floor(cell / cols) * ny;
    const pieces = layers.map((layer): Piece => {
      if (!box) return { img: blank(1, 1), px: a ? a.ax - cx : 0, py: a ? a.ay - cy : 0, cell };
      const img = blank(box.x1 - box.x0, box.y1 - box.y0);
      for (let y = box.y0; y < box.y1; y++)
        for (let x = box.x0; x < box.x1; x++) {
          const p = y * width + x;
          if (owner[p] !== cell) continue;
          const s = p * 4;
          if ((layer.data[s + 3] ?? 0) === 0) continue;
          const o = ((y - box.y0) * img.width + (x - box.x0)) * 4;
          img.data.set(layer.data.subarray(s, s + 4), o);
        }
      return { img, px: (a ? a.ax : cx + nx / 2) - box.x0, py: (a ? a.ay : cy + ny) - box.y0, cell };
    });
    out.set(cell, pieces);
  }
  return out;
}

// ---- atlas --------------------------------------------------------------------------------------

export interface Placed {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Shelf packing, tallest first, 1 px gutters; identical images share one rect. */
export function pack(items: { key: string; img: Rgba }[], maxWidth = 1024): { placed: Map<string, Placed>; width: number; height: number; image: Rgba } {
  const unique = new Map<string, { img: Rgba; keys: string[] }>();
  for (const it of items) {
    const h = createHash('sha1').update(it.img.data).update(`${it.img.width}x${it.img.height}`).digest('hex');
    const u = unique.get(h);
    if (u) u.keys.push(it.key);
    else unique.set(h, { img: it.img, keys: [it.key] });
  }
  const list = [...unique.values()].sort((a, b) => b.img.height - a.img.height || b.img.width - a.img.width || (a.keys[0] ?? '').localeCompare(b.keys[0] ?? ''));
  const widest = Math.max(1, ...list.map((u) => u.img.width + 2));
  const width = Math.max(maxWidth, widest);
  let x = 1;
  let y = 1;
  let shelf = 0;
  const spots: { u: (typeof list)[number]; x: number; y: number }[] = [];
  for (const u of list) {
    if (x + u.img.width + 1 > width) {
      x = 1;
      y += shelf + 1;
      shelf = 0;
    }
    spots.push({ u, x, y });
    x += u.img.width + 1;
    shelf = Math.max(shelf, u.img.height);
  }
  const height = y + shelf + 1;
  const used = Math.max(...spots.map((s) => s.x + s.u.img.width + 1), 2);
  const image = blank(used, height);
  const placed = new Map<string, Placed>();
  for (const s of spots) {
    for (let r = 0; r < s.u.img.height; r++) {
      const src = s.u.img.data.subarray(r * s.u.img.width * 4, (r + 1) * s.u.img.width * 4);
      image.data.set(src, ((s.y + r) * image.width + s.x) * 4);
    }
    for (const key of s.u.keys) placed.set(key, { key, x: s.x, y: s.y, w: s.u.img.width, h: s.u.img.height });
  }
  return { placed, width: used, height, image };
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
  /** Atlas files by name (content-hashed). */
  files: Map<string, Uint8Array>;
  report: string[];
}

function cutsByCell(json: SheetJson, cw: number, ch: number, cols: number, block: { x: number; y: number }, phase: { x: number; y: number }) {
  const cuts = cutsFor(json, cw, ch);
  const anchors = new Map<number, { ax: number; ay: number }>();
  for (const c of Object.values(cuts)) anchors.set(c.row * cols + c.col, { ax: (c.ax - phase.x) / block.x, ay: (c.ay - phase.y) / block.y });
  return { cuts, anchors };
}

export function derive(input: DeriveInput): DeriveOutput {
  const report: string[] = [];
  const byGroup = new Map<Group, { key: string; img: Rgba }[]>();
  const add = (g: Group, key: string, img: Rgba) => {
    const list = byGroup.get(g) ?? [];
    list.push({ key, img });
    byGroup.set(g, list);
  };
  // sprite id -> row -> frames with a piece key (resolved to atlas rects at the end)
  const pending: Record<string, { group: Group; scale: number; grid: number; sheetKey?: string; rows: Record<string, { mode: 'loop' | 'once'; frames: { key: string; px: number; py: number; ms: number; sub?: { x: number; y: number; w: number; h: number } }[] }> }> = {};

  // exact sheets: the whole sheet at its grid, frames are sub-rects
  for (const [id, group] of Object.entries(EXACT_GROUP)) {
    const s = input.sprites[id];
    if (!s) throw new Error(`derive: missing exact sheet ${id}`);
    const g = s.grid;
    if (g < 2) throw new Error(`derive: ${id} has no exact grid`);
    const { img } = downscale(s.png, s.png.width, s.png.height, s.png.width / g, s.png.height / g);
    const sheetKey = `${id}#sheet`;
    add(group, sheetKey, img);
    const rows: (typeof pending)[string]['rows'] = {};
    for (const [row, names] of Object.entries(s.json.animations)) {
      rows[row] = {
        mode: s.rows[row]?.mode ?? 'loop',
        frames: names.map((n) => {
          const f = s.json.frames[n] as SheetFrameJson;
          const sub = { x: f.frame.x / g, y: f.frame.y / g, w: f.frame.w / g, h: f.frame.h / g };
          return { key: sheetKey, sub, px: f.anchor.x * sub.w, py: f.anchor.y * sub.h, ms: f.duration || 100 };
        }),
      };
    }
    pending[id] = { group, scale: 1, grid: g, sheetKey, rows };
    report.push(`${id}: exact grid ${g}, ${img.width}x${img.height}`);
  }

  // painted sheets: hen layers together, the rest one by one
  const henIds = ['01-hen-anims', ...HEN_LAYERS];
  const painted = Object.keys(PAINTED).filter((id) => !henIds.includes(id));
  const groupsToCut: string[][] = [HEN_LAYERS, ['01-hen-anims'], ...painted.map((id) => [id])];
  for (const ids of groupsToCut) {
    const first = input.sprites[ids[0] as string];
    if (!first) throw new Error(`derive: missing sheet ${ids[0]}`);
    const spec = PAINTED[ids[0] as string] as GridSpec;
    const fr = Object.values(first.json.frames)[0] as SheetFrameJson;
    const cw = fr.frame.w;
    const ch = ids[0]?.startsWith('02-') || ids[0] === '01-hen-anims' ? HEN_CELL : fr.frame.h;
    const nx = Math.round(cw / spec.grid);
    const ny = Math.round(ch / spec.grid);
    const cols = Math.round(first.png.width / cw);
    const rowsN = Math.round(first.png.height / ch);
    const cut = (png: Rgba) => {
      const d = new Uint8Array(png.data);
      alphaCut(d);
      return { width: png.width, height: png.height, data: d };
    };
    const sources = ids.map((id) => cut((input.sprites[id] as SourceSprite).png));
    const phase = bestPhase(sources[0] as Rgba, cw, ch, nx, ny);
    let layers = sources.map((src) => downscale(src, cw, ch, nx, ny, phase).img);
    const block = { x: cw / nx, y: ch / ny };
    const { cuts, anchors } = cutsByCell(first.json, cw, ch, cols, block, phase);
    const layerIds = [...ids];
    // the body's palette swaps are derived from the same downscaled body, so they share its cut
    if (ids[0] === '02-body') {
      for (const [colour, ramp] of Object.entries(input.bodyRecolour)) {
        const copy = { ...layers[0], data: new Uint8Array((layers[0] as Rgba).data) } as Rgba;
        recolourBody(copy.data, ramp);
        layers = [...layers, copy];
        layerIds.push(`02-body@${colour}`);
      }
    }
    const pieces = cutCells(layers, cols, rowsN, nx, ny, anchors);
    layerIds.forEach((id, li) => {
      const base = id.split('@')[0] as string;
      const src = input.sprites[base] as SourceSprite;
      const rows: (typeof pending)[string]['rows'] = {};
      for (const [row, names] of Object.entries(first.json.animations)) {
        rows[row] = {
          mode: src.rows[row]?.mode ?? 'loop',
          frames: names.map((n) => {
            const c = cuts[n] as Cut;
            const cell = c.row * cols + c.col;
            const piece = (pieces.get(cell) as Piece[])[li] as Piece;
            const key = `${id}#${cell}`;
            add(spec.group, key, piece.img);
            return { key, px: piece.px, py: piece.py, ms: c.ms };
          }),
        };
      }
      pending[id] = { group: spec.group, scale: spec.scale, grid: spec.grid, rows };
    });
    report.push(`${ids.join(', ')}: grid ${spec.grid}, cell ${cw}x${ch} -> ${nx}x${ny}, world scale ${spec.scale}, phase ${phase.x},${phase.y}`);
  }

  // atlases
  const files = new Map<string, Uint8Array>();
  const atlases: DerivedManifest['atlases'] = {};
  const rects = new Map<string, { group: Group; p: Placed }>();
  for (const group of GROUPS) {
    const items = byGroup.get(group);
    if (!items?.length) continue;
    const { placed, image } = pack(items);
    const bytes = encodePng(image);
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 12);
    const file = `${group}-${hash}.png`;
    files.set(file, bytes);
    atlases[group] = { file, w: image.width, h: image.height, bytes: bytes.length };
    for (const [key, p] of placed) rects.set(key, { group, p });
    report.push(`atlas ${file}: ${image.width}x${image.height}, ${(bytes.length / 1024).toFixed(1)} KB`);
  }

  const sprites: DerivedManifest['sprites'] = {};
  for (const [id, s] of Object.entries(pending).sort(([a], [b]) => a.localeCompare(b))) {
    const rows: DerivedSprite['rows'] = {};
    for (const [row, r] of Object.entries(s.rows)) {
      rows[row] = {
        mode: r.mode,
        frames: r.frames.map((f) => {
          const at = rects.get(f.key)?.p as Placed;
          const x = at.x + (f.sub?.x ?? 0);
          const y = at.y + (f.sub?.y ?? 0);
          return [x, y, f.sub?.w ?? at.w, f.sub?.h ?? at.h, round2(f.px), round2(f.py), f.ms];
        }),
      };
    }
    const sheet = s.sheetKey ? rects.get(s.sheetKey)?.p : undefined;
    sprites[id] = { group: s.group, scale: s.scale, grid: s.grid, ...(sheet ? { sheet: { x: sheet.x, y: sheet.y, w: sheet.w, h: sheet.h } } : {}), rows };
  }
  return { manifest: { version: 1, atlases, sprites }, files, report };
}

const round2 = (v: number) => Math.round(v * 100) / 100;
