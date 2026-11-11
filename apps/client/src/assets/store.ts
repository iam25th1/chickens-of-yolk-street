// Loads packed sprite sheets into PixiJS textures. Soft art gets a hard alpha cut first; the hen
// body layer also gets brown and black palette swaps. The packed PNGs on disk stay untouched.
import { ImageSource, Rectangle, Texture } from 'pixi.js';
import { ASSET_BASE, divisorFor, needsAlphaCut, type AssetIndex, type SheetJson, type SpriteEntry } from './catalog';
import { alphaCut, ownerRows, recolourBody } from './pixels';

/** The base hen and its trait layers share one frame layout with headroom (see prepareHens). */
const HEN_SHEET = /^(01-hen-anims|02-.+)$/;

export interface Frame {
  texture: Texture;
  ms: number;
}

export class AssetStore {
  private readonly sources = new Map<string, Texture>();
  private readonly json = new Map<string, SheetJson>();
  private readonly frameCache = new Map<string, Frame[]>();
  private readonly henPixels = new Map<string, Uint8ClampedArray>();
  private readonly prescaled = new Set<string>();

  constructor(readonly index: AssetIndex) {}

  static async load(): Promise<AssetStore> {
    const res = await fetch(`${ASSET_BASE}index.json`);
    if (!res.ok) throw new Error(`asset index: HTTP ${res.status}`);
    return new AssetStore((await res.json()) as AssetIndex);
  }

  entry(id: string): SpriteEntry {
    const e = this.index.sprites[id];
    if (!e) throw new Error(`unknown sprite ${id}`);
    return e;
  }

  url(id: string): string {
    return `${ASSET_BASE}${this.entry(id).png}`;
  }

  divisor(id: string): number {
    if (this.prescaled.has(id)) return 1;
    return divisorFor(id.split('@')[0] ?? id, this.entry(id.split('@')[0] ?? id));
  }

  has(id: string): boolean {
    return this.sources.has(id);
  }

  sheet(id: string): SheetJson {
    const j = this.json.get(id.split('@')[0] ?? id);
    if (!j) throw new Error(`sprite ${id} not loaded`);
    return j;
  }

  /** Loads sheets in parallel; onEach fires once per finished sheet for progress bars. */
  async loadSprites(ids: string[], onEach: () => void = () => undefined): Promise<void> {
    await Promise.all(
      ids.map(async (id) => {
        if (this.sources.has(id)) return onEach();
        const entry = this.entry(id);
        const [jsonRes, imgRes] = await Promise.all([fetch(`${ASSET_BASE}${entry.json}`), fetch(`${ASSET_BASE}${entry.png}`)]);
        if (!jsonRes.ok || !imgRes.ok) throw new Error(`sprite ${id}: HTTP ${jsonRes.status}/${imgRes.status}`);
        this.json.set(id, (await jsonRes.json()) as SheetJson);
        const bitmap = await createImageBitmap(await imgRes.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
        if (!needsAlphaCut(entry)) {
          this.sources.set(id, new Texture({ source: new ImageSource({ resource: bitmap, scaleMode: 'nearest' }) }));
          return onEach();
        }
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new Error('2d canvas unavailable');
        ctx.drawImage(bitmap, 0, 0);
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
        alphaCut(pixels.data);
        ctx.putImageData(pixels, 0, 0);
        this.sources.set(id, Texture.from(canvas));
        if (HEN_SHEET.test(id)) this.henPixels.set(id, pixels.data);
        if (id === '02-body') {
          for (const [colour, ramp] of Object.entries(this.index.traits.bodyRecolour)) {
            const swap = document.createElement('canvas');
            swap.width = canvas.width;
            swap.height = canvas.height;
            const sctx = swap.getContext('2d');
            if (!sctx) continue;
            const copy = new ImageData(new Uint8ClampedArray(pixels.data), pixels.width, pixels.height);
            recolourBody(copy.data, ramp);
            sctx.putImageData(copy, 0, 0);
            this.sources.set(`${id}@${colour}`, Texture.from(swap));
            this.henPixels.set(`${id}@${colour}`, copy.data);
          }
        }
        bitmap.close();
        onEach();
      }),
    );
  }

  /**
   * Builds the hen layers' frames once all hen sheets are loaded: each frame keeps only the pixels
   * of its own row (see ownerRows) and is sampled nearest-neighbour at the hen divisor, exactly the
   * texels the GPU would pick, into a small atlas per layer.
   */
  prepareHens(): void {
    const ids = [...this.henPixels.keys()];
    if (!ids.length || this.prescaled.size) return;
    const base = this.entry('01-hen-anims');
    const W = base.width;
    const H = base.height;
    const masks = ids.filter((id) => !id.includes('@')).map((id) => this.henPixels.get(id) as Uint8ClampedArray);
    const owner = ownerRows(masks, W, H, 256);
    const sheet = this.sheet('01-hen-anims');
    const rows = Object.keys(sheet.animations);
    const d = divisorFor('01-hen-anims', base);
    const cellW = Math.round(256 / d);
    const cellH = Math.round(360 / d);
    for (const id of ids) {
      const src = this.henPixels.get(id) as Uint8ClampedArray;
      const canvas = document.createElement('canvas');
      canvas.width = cellW * 4;
      canvas.height = cellH * rows.length;
      const ctx = canvas.getContext('2d');
      if (!ctx) continue;
      const img = ctx.createImageData(canvas.width, canvas.height);
      const placed: { row: string; i: number; x: number; y: number; w: number; h: number; f: SheetJson['frames'][string] }[] = [];
      rows.forEach((row, r) => {
        (sheet.animations[row] ?? []).forEach((name, i) => {
          const f = sheet.frames[name];
          if (!f) return;
          const w = Math.round(f.frame.w / d);
          const h = Math.round(f.frame.h / d);
          const ox = i * cellW;
          const oy = r * cellH;
          for (let y = 0; y < h; y++) {
            const sy = f.frame.y + Math.floor(((y + 0.5) * f.frame.h) / h);
            for (let x = 0; x < w; x++) {
              const sx = f.frame.x + Math.floor(((x + 0.5) * f.frame.w) / w);
              const s = sy * W + sx;
              if (owner[s] !== r) continue;
              const o = ((oy + y) * canvas.width + ox + x) * 4;
              img.data[o] = src[s * 4] ?? 0;
              img.data[o + 1] = src[s * 4 + 1] ?? 0;
              img.data[o + 2] = src[s * 4 + 2] ?? 0;
              img.data[o + 3] = src[s * 4 + 3] ?? 0;
            }
          }
          placed.push({ row, i, x: ox, y: oy, w, h, f });
        });
      });
      ctx.putImageData(img, 0, 0);
      const atlas = Texture.from(canvas);
      for (const row of rows) {
        const frames = placed
          .filter((p) => p.row === row)
          .sort((a, b) => a.i - b.i)
          .map((p) => ({
            texture: new Texture({ source: atlas.source, frame: new Rectangle(p.x, p.y, p.w, p.h), defaultAnchor: p.f.anchor }),
            ms: p.f.duration || 100,
          }));
        this.frameCache.set(`${id}/${row}`, frames);
      }
      this.prescaled.add(id);
    }
    this.henPixels.clear();
  }

  /** Frames of a row, as textures cut from the sheet with per-frame anchor and duration. */
  frames(id: string, row: string): Frame[] {
    const key = `${id}/${row}`;
    const hit = this.frameCache.get(key);
    if (hit) return hit;
    const base = this.sources.get(id);
    if (!base) throw new Error(`sprite ${id} not loaded`);
    const sheet = this.sheet(id);
    const names = sheet.animations[row];
    if (!names) throw new Error(`sprite ${id} has no row ${row}`);
    const out = names.map((name) => {
      const f = sheet.frames[name];
      if (!f) throw new Error(`missing frame ${name}`);
      const texture = new Texture({
        source: base.source,
        frame: new Rectangle(f.frame.x, f.frame.y, f.frame.w, f.frame.h),
        defaultAnchor: f.anchor,
      });
      return { texture, ms: f.duration || 100 };
    });
    this.frameCache.set(key, out);
    return out;
  }

  /** An arbitrary rectangle of a sheet (static tiles that have no row of their own). */
  region(id: string, x: number, y: number, w: number, h: number): Texture {
    const base = this.sources.get(id);
    if (!base) throw new Error(`sprite ${id} not loaded`);
    return new Texture({ source: base.source, frame: new Rectangle(x, y, w, h) });
  }

  private readonly thumbs = new Map<string, string>();

  /** A frame drawn small for the DOM (soft art keeps its alpha cut), as a data URL. */
  thumbnail(id: string, row: string, frame = 0, divisor = this.divisor(id)): string {
    const key = `${id}/${row}/${frame}/${divisor}`;
    const hit = this.thumbs.get(key);
    if (hit) return hit;
    const tex = this.frames(id, row)[frame]?.texture;
    if (!tex) return '';
    const f = tex.frame;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(f.width / divisor);
    canvas.height = Math.round(f.height / divisor);
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tex.source.resource as CanvasImageSource, f.x, f.y, f.width, f.height, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL();
    this.thumbs.set(key, url);
    return url;
  }

  private readonly portraits = new Map<string, string>();

  /** A hen's stacked trait layers (first idle frame) as a data URL, for the shop and cards. */
  henPortrait(layers: string[]): string {
    const key = layers.join('+');
    const hit = this.portraits.get(key);
    if (hit) return hit;
    const frames = layers.map((id) => this.frames(id, 'idle')[0]?.texture).filter((t): t is Texture => Boolean(t));
    const first = frames[0];
    if (!first) return '';
    const canvas = document.createElement('canvas');
    canvas.width = first.frame.width;
    canvas.height = first.frame.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';
    ctx.imageSmoothingEnabled = false;
    for (const t of frames) ctx.drawImage(t.source.resource as CanvasImageSource, t.frame.x, t.frame.y, t.frame.width, t.frame.height, 0, 0, t.frame.width, t.frame.height);
    const url = canvas.toDataURL();
    this.portraits.set(key, url);
    return url;
  }

  rowMode(id: string, row: string): 'loop' | 'once' {
    return this.entry(id.split('@')[0] ?? id).rows[row]?.mode ?? 'loop';
  }
}
