// Sprites come from the derived atlases (scripts/derive-assets.ts): every frame is already at its
// true pixel size, cut cleanly and with its pivot, so nothing is resampled or masked at load. Atlases
// load by screen group: boot, title, farm, market, cards, ui, fx.
import { ImageSource, Rectangle, Texture } from 'pixi.js';
import { ASSET_BASE, type AssetIndex } from './catalog';
import derivedJson from './derived.json';

export type Group = 'boot' | 'title' | 'farm' | 'market' | 'cards' | 'ui' | 'fx';
type DerivedFrame = [x: number, y: number, w: number, h: number, px: number, py: number, ms: number];
interface DerivedSprite {
  group: Group;
  scale: number;
  grid: number;
  sheet?: { x: number; y: number; w: number; h: number };
  rows: Record<string, { mode: 'loop' | 'once'; frames: DerivedFrame[] }>;
}
interface DerivedManifest {
  atlases: Record<string, { file: string; w: number; h: number; bytes: number }>;
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
  ms: number;
}

export const atlasUrl = (group: Group): string => `${ASSET_BASE}derived/${derived.atlases[group]?.file ?? ''}`;

export class AssetStore {
  private readonly atlases = new Map<Group, Texture>();
  private readonly images = new Map<Group, ImageBitmap>();
  private readonly pending = new Map<Group, Promise<void>>();
  private readonly frameCache = new Map<string, Frame[]>();

  constructor(readonly index: AssetIndex) {}

  static async load(): Promise<AssetStore> {
    const res = await fetch(`${ASSET_BASE}index.json`);
    if (!res.ok) throw new Error(`asset index: HTTP ${res.status}`);
    return new AssetStore((await res.json()) as AssetIndex);
  }

  private sprite(id: string): DerivedSprite {
    const s = derived.sprites[id];
    if (!s) throw new Error(`unknown sprite ${id}`);
    return s;
  }

  /** Loads atlas pages for screen groups; onEach fires once per finished group (progress bars). */
  loadGroups(groups: Group[], onEach: () => void = () => undefined): Promise<void> {
    return Promise.all(
      groups.map((g) => {
        let p = this.pending.get(g);
        if (!p) {
          p = (async () => {
            const res = await fetch(atlasUrl(g));
            if (!res.ok) throw new Error(`atlas ${g}: HTTP ${res.status}`);
            const bitmap = await createImageBitmap(await res.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
            this.images.set(g, bitmap);
            this.atlases.set(g, new Texture({ source: new ImageSource({ resource: bitmap, scaleMode: 'nearest' }) }));
          })();
          this.pending.set(g, p);
          p.catch(() => this.pending.delete(g));
        }
        return p.then(onEach);
      }),
    ).then(() => undefined);
  }

  /** Every group a set of sprites lives in. */
  groupsOf(ids: string[]): Group[] {
    return [...new Set(ids.map((id) => this.sprite(id).group))];
  }

  has(id: string): boolean {
    const s = derived.sprites[id];
    return Boolean(s && this.atlases.has(s.group));
  }

  /** World pixels per atlas pixel for this sprite (1 at true size). */
  scale(id: string): number {
    return this.sprite(id).scale;
  }

  /** Source pixels per atlas pixel (the art's true grid). */
  grid(id: string): number {
    return this.sprite(id).grid;
  }

  url(id: string): string {
    return atlasUrl(this.sprite(id).group);
  }

  atlasSize(id: string): { w: number; h: number } {
    const a = derived.atlases[this.sprite(id).group];
    return { w: a?.w ?? 1, h: a?.h ?? 1 };
  }

  rows(id: string): string[] {
    return Object.keys(this.sprite(id).rows);
  }

  frameRects(id: string, row: string): FrameRect[] {
    const r = this.sprite(id).rows[row];
    if (!r) throw new Error(`sprite ${id} has no row ${row}`);
    return r.frames.map(([x, y, w, h, px, py, ms]) => ({ x, y, w, h, px, py, ms }));
  }

  private base(id: string): Texture {
    const t = this.atlases.get(this.sprite(id).group);
    if (!t) throw new Error(`sprite ${id} not loaded`);
    return t;
  }

  /** Frames of a row, with per-frame pivot and duration. */
  frames(id: string, row: string): Frame[] {
    const key = `${id}/${row}`;
    const hit = this.frameCache.get(key);
    if (hit) return hit;
    const base = this.base(id);
    const out = this.frameRects(id, row).map((f) => ({
      texture: new Texture({ source: base.source, frame: new Rectangle(f.x, f.y, f.w, f.h), defaultAnchor: { x: f.px / f.w, y: f.py / f.h } }),
      ms: f.ms || 100,
    }));
    this.frameCache.set(key, out);
    return out;
  }

  /** A rectangle of an exact-grid sheet, given in the packed sheet's own pixels (tiles, flaps). */
  region(id: string, x: number, y: number, w: number, h: number): Texture {
    const s = this.sprite(id);
    if (!s.sheet) throw new Error(`sprite ${id} has no whole sheet`);
    const g = s.grid;
    return new Texture({ source: this.base(id).source, frame: new Rectangle(s.sheet.x + x / g, s.sheet.y + y / g, w / g, h / g) });
  }

  /** Where a source-pixel rectangle of an exact sheet sits in its atlas (for DOM backgrounds). */
  regionRect(id: string, x: number, y: number, w: number, h: number): { x: number; y: number; w: number; h: number } {
    const s = this.sprite(id);
    const g = s.grid;
    return { x: (s.sheet?.x ?? 0) + x / g, y: (s.sheet?.y ?? 0) + y / g, w: w / g, h: h / g };
  }

  rowMode(id: string, row: string): 'loop' | 'once' {
    return this.sprite(id).rows[row]?.mode ?? 'loop';
  }

  private readonly thumbs = new Map<string, string>();

  /** A frame as a data URL at a whole-number zoom, for the DOM. */
  thumbnail(id: string, row: string, frame = 0, zoom = 1): string {
    const key = `${id}/${row}/${frame}/${zoom}`;
    const hit = this.thumbs.get(key);
    if (hit) return hit;
    const img = this.images.get(this.sprite(id).group);
    const f = this.frameRects(id, row)[frame];
    if (!img || !f) return '';
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(f.w * zoom));
    canvas.height = Math.max(1, Math.round(f.h * zoom));
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, f.x, f.y, f.w, f.h, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL();
    this.thumbs.set(key, url);
    return url;
  }

  private readonly portraits = new Map<string, string>();

  /** A hen's stacked trait layers (first idle frame) as a data URL, at a whole-number zoom. */
  henPortrait(layers: string[], zoom = 1): string {
    const key = `${layers.join('+')}@${zoom}`;
    const hit = this.portraits.get(key);
    if (hit) return hit;
    const first = layers[0];
    const img = first ? this.images.get(this.sprite(first).group) : undefined;
    const rects = layers.map((id) => this.frameRects(id, 'idle')[0]).filter((r): r is FrameRect => Boolean(r));
    const r0 = rects[0];
    if (!img || !r0) return '';
    const canvas = document.createElement('canvas');
    canvas.width = r0.w * zoom;
    canvas.height = r0.h * zoom;
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';
    ctx.imageSmoothingEnabled = false;
    for (const r of rects) ctx.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, r.w * zoom, r.h * zoom);
    const url = canvas.toDataURL();
    this.portraits.set(key, url);
    return url;
  }
}
