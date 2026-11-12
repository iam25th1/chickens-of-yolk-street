// Sprites come from the derived atlases (scripts/derive-assets.ts). Exact sheets (true pixel art)
// ship whole at their own grid: the screen draws each of their pixels as a whole number of device
// pixels. Painted art ships cut at several densities (texels per design pixel); a screen loads the
// density that matches its zoom, so one texel lands on one device pixel, or the half density first
// (two device pixels a texel) while the full one downloads. Atlases load by screen group.
import { ImageSource, Rectangle, Texture } from 'pixi.js';
import { ASSET_BASE, type AssetIndex } from './catalog';
import derivedJson from './derived.json';

export type Group = 'boot' | 'title' | 'farm' | 'market' | 'cards' | 'ui' | 'fx';
type Rect7 = [x: number, y: number, w: number, h: number, px: number, py: number, page: number];
interface DerivedSprite {
  group: Group;
  kind: 'exact' | 'painted';
  factor: number;
  scale: number;
  ratio: number;
  levels: number[];
  sheet?: Rect7;
  rows: Record<string, { mode: 'loop' | 'once'; ms: number[] }>;
  frames: Record<string, Record<string, Rect7[]>>;
}
interface DerivedManifest {
  levels: number[];
  atlases: Record<string, { file: string; w: number; h: number }[]>;
  sprites: Record<string, DerivedSprite>;
}
export const derived = derivedJson as unknown as DerivedManifest;

export interface Frame {
  texture: Texture;
  ms: number;
}

export interface FrameRect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Pivot inside the frame. */
  px: number;
  py: number;
  page: number;
  ms: number;
}

export const atlasUrl = (key: string, page = 0): string => `${ASSET_BASE}derived/${derived.atlases[key]?.[page]?.file ?? ''}`;

/** The density a painted sprite is drawn at for a screen density d: the largest of its levels that divides d. */
export function levelFor(levels: number[], d: number): number | null {
  let best: number | null = null;
  for (const l of levels) if (d % l === 0 && (best === null || l > best)) best = l;
  return best;
}

export class AssetStore {
  private readonly pages = new Map<string, { bitmap: ImageBitmap; texture: Texture }[]>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly frameCache = new Map<string, Frame[]>();
  /** Screen density per group: world k for the farm, UI p for portraits and signs. */
  private readonly density = new Map<Group, number>();
  /** Bumped whenever a sharper painted atlas lands: sprites pick up the new frames. */
  version = 0;
  private readonly listeners = new Set<() => void>();

  constructor(readonly index: AssetIndex) {}

  static async load(): Promise<AssetStore> {
    const res = await fetch(`${ASSET_BASE}index.json`);
    if (!res.ok) throw new Error(`asset index: HTTP ${res.status}`);
    return new AssetStore((await res.json()) as AssetIndex);
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private sprite(id: string): DerivedSprite {
    const s = derived.sprites[id];
    if (!s) throw new Error(`unknown sprite ${id}`);
    return s;
  }

  private loadAtlas(key: string): Promise<void> {
    let p = this.pending.get(key);
    if (!p) {
      const list = derived.atlases[key] ?? [];
      p = Promise.all(
        list.map(async (page, i) => {
          const res = await fetch(atlasUrl(key, i));
          if (!res.ok) throw new Error(`atlas ${key}: HTTP ${res.status}`);
          // premultiplied once here: WebP keeps colour under fully clear pixels, which must never show
          const bitmap = await createImageBitmap(await res.blob(), { premultiplyAlpha: 'premultiply', colorSpaceConversion: 'none' });
          return { bitmap, texture: new Texture({ source: new ImageSource({ resource: bitmap, scaleMode: 'nearest', alphaMode: 'premultiplied-alpha' }) }), w: page.w };
        }),
      ).then((loaded) => {
        this.pages.set(key, loaded);
        this.frameCache.clear();
        this.version++;
        for (const l of this.listeners) l();
      });
      this.pending.set(key, p);
      p.catch(() => this.pending.delete(key));
    }
    return p;
  }

  /** Painted atlas keys a group needs at density d (each sprite takes its own best level). */
  private paintedKeys(group: Group, d: number): string[] {
    const keys = new Set<string>();
    for (const s of Object.values(derived.sprites)) {
      if (s.group !== group || s.kind !== 'painted') continue;
      const l = levelFor(s.levels, d);
      if (l !== null) keys.add(`${group}@${l}`);
    }
    return [...keys];
  }

  /**
   * Loads screen groups at a density: the exact atlas of each group and the painted atlases cut
   * for that density. With quick, a group whose density is 4, 6 or 8 first loads the half density
   * (drawn two device pixels a texel) and resolves; the full density follows in the background.
   * onEach fires once per finished group (progress bars).
   */
  async loadGroups(groups: Group[], d: number, opts: { quick?: boolean; onEach?: () => void } = {}): Promise<void> {
    await Promise.all(
      groups.map(async (g) => {
        this.density.set(g, d);
        const exact = derived.atlases[g] ? [this.loadAtlas(g)] : [];
        const full = this.paintedKeys(g, d);
        const half = opts.quick && d >= 4 && d % 2 === 0 ? this.paintedKeys(g, d / 2) : null;
        if (half && !full.every((k) => this.pages.has(k))) {
          await Promise.all([...exact, ...half.map((k) => this.loadAtlas(k))]);
          void Promise.all(full.map((k) => this.loadAtlas(k))).catch(() => undefined);
        } else await Promise.all([...exact, ...full.map((k) => this.loadAtlas(k))]);
        opts.onEach?.();
      }),
    );
  }

  /** Every group a set of sprites lives in. */
  groupsOf(ids: string[]): Group[] {
    return [...new Set(ids.map((id) => this.sprite(id).group))];
  }

  /** The density this sprite is drawn at now (texels per design pixel), or null when nothing is loaded. */
  private level(id: string): number | null {
    const s = this.sprite(id);
    if (s.kind === 'exact') return this.pages.has(s.group) ? 1 : null;
    const d = this.density.get(s.group) ?? 2;
    // the sharpest loaded level that divides the screen's density
    let best: number | null = null;
    for (const l of s.levels) if (d % l === 0 && this.pages.has(`${s.group}@${l}`) && (best === null || l > best)) best = l;
    if (best !== null) return best;
    // the window changed density and its atlas is still on its way: draw what is here meanwhile
    for (const l of s.levels) if (this.pages.has(`${s.group}@${l}`) && (best === null || l > best)) best = l;
    return best;
  }

  /** The screen density a group is loaded for. */
  densityOf(group: Group): number {
    return this.density.get(group) ?? 2;
  }

  has(id: string): boolean {
    return derived.sprites[id] !== undefined && this.level(id) !== null;
  }

  /** Design pixels (world or UI) per texel of what is drawn now. */
  texelScale(id: string): number {
    const s = this.sprite(id);
    if (s.kind === 'exact') return s.scale;
    return 1 / (this.level(id) ?? 1);
  }

  /** Source pixels per design pixel (the art's own grid for exact sheets). */
  grid(id: string): number {
    return this.sprite(id).ratio;
  }

  isPainted(id: string): boolean {
    return this.sprite(id).kind === 'painted';
  }

  private key(id: string): string | null {
    const s = this.sprite(id);
    if (s.kind === 'exact') return s.group;
    const l = this.level(id);
    return l === null ? null : `${s.group}@${l}`;
  }

  /** CSS url of an exact sprite's atlas page (DOM backgrounds). */
  url(id: string, page = 0): string {
    return atlasUrl(this.sprite(id).group, page);
  }

  atlasSize(id: string, page = 0): { w: number; h: number } {
    const a = derived.atlases[this.key(id) ?? this.sprite(id).group]?.[page];
    return { w: a?.w ?? 1, h: a?.h ?? 1 };
  }

  rows(id: string): string[] {
    return Object.keys(this.sprite(id).rows);
  }

  /** Frame rects of a row at the level drawn now (texels of that level's atlas). */
  frameRects(id: string, row: string): FrameRect[] {
    const s = this.sprite(id);
    const r = s.rows[row];
    if (!r) throw new Error(`sprite ${id} has no row ${row}`);
    const level = s.kind === 'exact' ? 1 : (this.level(id) ?? s.levels[0] ?? 2);
    const rects = s.frames[String(level)]?.[row] ?? [];
    return rects.map(([x, y, w, h, px, py, page], i) => ({ x, y, w, h, px, py, page, ms: r.ms[i] || 100 }));
  }

  private bitmapFor(id: string, page: number): ImageBitmap | null {
    const k = this.key(id);
    return k ? (this.pages.get(k)?.[page]?.bitmap ?? null) : null;
  }

  /** Frames of a row, with per-frame pivot and duration, at the level drawn now. */
  frames(id: string, row: string): Frame[] {
    const key = `${id}/${row}/${this.version}`;
    const hit = this.frameCache.get(key);
    if (hit) return hit;
    const k = this.key(id);
    const pages = k ? this.pages.get(k) : undefined;
    if (!pages) throw new Error(`sprite ${id} not loaded`);
    const out = this.frameRects(id, row).map((f) => {
      const base = pages[f.page]?.texture ?? Texture.EMPTY;
      const w = Math.max(1, f.w);
      const h = Math.max(1, f.h);
      return {
        texture: new Texture({ source: base.source, frame: new Rectangle(f.x, f.y, w, h), defaultAnchor: { x: f.px / w, y: f.py / h } }),
        ms: f.ms,
      };
    });
    this.frameCache.set(key, out);
    return out;
  }

  /** A rectangle of an exact sheet, given in the packed sheet's own pixels (tiles, flaps). */
  region(id: string, x: number, y: number, w: number, h: number): Texture {
    const s = this.sprite(id);
    if (!s.sheet) throw new Error(`sprite ${id} has no whole sheet`);
    const f = s.factor;
    const base = this.pages.get(s.group)?.[s.sheet[6]]?.texture;
    if (!base) throw new Error(`sprite ${id} not loaded`);
    return new Texture({ source: base.source, frame: new Rectangle(s.sheet[0] + x / f, s.sheet[1] + y / f, w / f, h / f) });
  }

  /** Where a source-pixel rectangle of an exact sheet sits in its atlas (for DOM backgrounds). */
  regionRect(id: string, x: number, y: number, w: number, h: number): { x: number; y: number; w: number; h: number } {
    const s = this.sprite(id);
    const f = s.factor;
    return { x: (s.sheet?.[0] ?? 0) + x / f, y: (s.sheet?.[1] ?? 0) + y / f, w: w / f, h: h / f };
  }

  rowMode(id: string, row: string): 'loop' | 'once' {
    return this.sprite(id).rows[row]?.mode ?? 'loop';
  }

  /**
   * Paints frames into a canvas at whole device pixels: each texel of the level drawn now becomes
   * m x m device pixels (m a whole number), nearest neighbour. Layers stack on one pivot. Returns
   * the canvas size in device pixels and the pivot, or null when the art is not loaded.
   */
  paint(
    canvas: HTMLCanvasElement,
    layers: string[],
    row: string,
    frame: number,
    m: number,
    box?: { w: number; h: number; px: number; py: number },
  ): { w: number; h: number; px: number; py: number } | null {
    const rects = layers.map((id) => ({ id, r: this.frameRects(id, row)[frame] ?? this.frameRects(id, row)[0] }));
    if (rects.some((x) => !x.r || !this.bitmapFor(x.id, x.r.page))) return null;
    // the union of the layers around the shared pivot (or the caller's fixed box)
    let left = 0;
    let top = 0;
    let right = 0;
    let bottom = 0;
    for (const { r } of rects) {
      if (!r) continue;
      left = Math.max(left, r.px);
      top = Math.max(top, r.py);
      right = Math.max(right, r.w - r.px);
      bottom = Math.max(bottom, r.h - r.py);
    }
    const out = box ?? { w: Math.ceil(left + right) * m, h: Math.ceil(top + bottom) * m, px: Math.ceil(left) * m, py: Math.ceil(top) * m };
    if (canvas.width !== out.w) canvas.width = out.w;
    if (canvas.height !== out.h) canvas.height = out.h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.clearRect(0, 0, out.w, out.h);
    ctx.imageSmoothingEnabled = false;
    for (const { id, r } of rects) {
      if (!r || r.w <= 0 || r.h <= 0) continue;
      const bmp = this.bitmapFor(id, r.page);
      if (bmp) ctx.drawImage(bmp, r.x, r.y, r.w, r.h, Math.round(out.px - r.px * m), Math.round(out.py - r.py * m), r.w * m, r.h * m);
    }
    return out;
  }

  /** Average colour of each edge of a plate's first frame, for filling the window around it. */
  edgeColours(id: string): { left: number; right: number; top: number; bottom: number } {
    const f = this.frameRects(id, this.rows(id)[0] ?? '')[0];
    const img = f ? this.bitmapFor(id, f.page) : null;
    const fallback = { left: 0x2a160c, right: 0x2a160c, top: 0x2a160c, bottom: 0x2a160c };
    if (!img || !f) return fallback;
    const canvas = document.createElement('canvas');
    canvas.width = f.w;
    canvas.height = f.h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return fallback;
    ctx.drawImage(img, f.x, f.y, f.w, f.h, 0, 0, f.w, f.h);
    const d = ctx.getImageData(0, 0, f.w, f.h).data;
    const avg = (pts: [number, number][]) => {
      let r = 0;
      let g = 0;
      let b = 0;
      for (const [x, y] of pts) {
        const o = (y * f.w + x) * 4;
        r += d[o] ?? 0;
        g += d[o + 1] ?? 0;
        b += d[o + 2] ?? 0;
      }
      const n = Math.max(1, pts.length);
      return (Math.round(r / n) << 16) | (Math.round(g / n) << 8) | Math.round(b / n);
    };
    const col = (x: number) => Array.from({ length: f.h }, (_, y) => [x, y] as [number, number]);
    const row = (y: number) => Array.from({ length: f.w }, (_, x) => [x, y] as [number, number]);
    return { left: avg(col(0)), right: avg(col(f.w - 1)), top: avg(row(0)), bottom: avg(row(f.h - 1)) };
  }
}
