// Renders a Feather's card once, at mint: the grade's Spawn card frame (Fluff common, Plume rare,
// Quill epic, Golden Quill legendary) with the grade's feather (its first float frame) in the
// window, on the frame's own paper colour, and the Feather's number in the nameplate. Both sheets
// are true pixel art drawn at 8x; they are read back at their own 1x grid (one pixel per 8x8
// block), composed, and doubled for wallets. The PNG travels in the NFT metadata as a data URI
// with its SHA-256, so the token shows its card without any image host.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FeatherGrade } from '@coys/shared';
import { decodePng, encodePng, type Rgba } from './png';

/** The source sheets are drawn at 8x nearest-neighbour. */
const GRID = 8;
/** Card frame at 1x: 48x68, its window at (8,8) 32x48, the nameplate at (10,58) 28x7. */
const CARD = { w: 48, h: 68 };
const WINDOW = { x: 8, y: 8, w: 32, h: 48 };
const PLATE = { x: 10, y: 58, w: 28, h: 7 };
/** Pixels per card pixel in the stored image. */
const SCALE = 2;

export const FRAME_OF: Record<FeatherGrade, 'common' | 'rare' | 'epic' | 'legendary'> = {
  fluff: 'common',
  plume: 'rare',
  quill: 'epic',
  'golden-quill': 'legendary',
};

/** 3x5 digits for the nameplate number. */
const DIGITS: Record<string, string[]> = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '011', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
  '#': ['101', '111', '101', '111', '101'],
};

export interface FeatherImage {
  dataUri: string;
  sha256Base64: string;
  sha256Hex: string;
  bytes: number;
  width: number;
  height: number;
}

/** One pixel per grid block (the block's centre), from a sub-rectangle of an 8x sheet. */
function at1x(img: Rgba, x0: number, y0: number, w: number, h: number): Rgba {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = x0 + x * GRID + GRID / 2;
      const sy = y0 + y * GRID + GRID / 2;
      const s = (sy * img.width + sx) * 4;
      const o = (y * w + x) * 4;
      out[o] = img.data[s] ?? 0;
      out[o + 1] = img.data[s + 1] ?? 0;
      out[o + 2] = img.data[s + 2] ?? 0;
      out[o + 3] = (img.data[s + 3] ?? 0) >= 128 ? 255 : 0;
    }
  }
  return { width: w, height: h, data: out };
}

const lum = (d: Uint8Array, i: number): number => 0.299 * (d[i] ?? 0) + 0.587 * (d[i + 1] ?? 0) + 0.114 * (d[i + 2] ?? 0);

export class FeatherRenderer {
  private readonly cache = new Map<string, FeatherImage>();
  private readonly sheets = new Map<string, Rgba>();

  constructor(private readonly assetsDir: string) {}

  private sheet(id: string): Rgba {
    const hit = this.sheets.get(id);
    if (hit) return hit;
    const img = decodePng(readFileSync(join(this.assetsDir, 'sprites', `${id}.png`)));
    this.sheets.set(id, img);
    return img;
  }

  /** The card at 1x (48x68): frame, paper, feather and number. */
  card(grade: FeatherGrade, number: number): Rgba {
    const frame = at1x(this.sheet(`x-founders-frame-${FRAME_OF[grade]}`), 0, 0, CARD.w, CARD.h);
    const feather = at1x(this.sheet(`x-feather-${grade}`), 0, 0, WINDOW.w, WINDOW.h);
    // the frame's lightest and darkest colours: the paper behind the feather and the number's ink
    let light = -1;
    let dark = -1;
    for (let i = 0; i < frame.data.length; i += 4) {
      if ((frame.data[i + 3] ?? 0) === 0) continue;
      if (light < 0 || lum(frame.data, i) > lum(frame.data, light)) light = i;
      if (dark < 0 || lum(frame.data, i) < lum(frame.data, dark)) dark = i;
    }
    const out = Uint8Array.from(frame.data);
    const put = (x: number, y: number, src: Uint8Array, si: number) => {
      const o = (y * CARD.w + x) * 4;
      out[o] = src[si] ?? 0;
      out[o + 1] = src[si + 1] ?? 0;
      out[o + 2] = src[si + 2] ?? 0;
      out[o + 3] = 255;
    };
    for (let y = 0; y < WINDOW.h; y++) {
      for (let x = 0; x < WINDOW.w; x++) {
        const cx = WINDOW.x + x;
        const cy = WINDOW.y + y;
        if ((frame.data[(cy * CARD.w + cx) * 4 + 3] ?? 0) !== 0) continue;
        const fi = (y * WINDOW.w + x) * 4;
        if ((feather.data[fi + 3] ?? 0) !== 0) put(cx, cy, feather.data, fi);
        else if (light >= 0) put(cx, cy, frame.data, light);
      }
    }
    const text = `#${String(number).padStart(3, '0')}`;
    const tw = text.length * 4 - 1;
    const tx = PLATE.x + Math.floor((PLATE.w - tw) / 2);
    const ty = PLATE.y + 1;
    [...text].forEach((ch, k) => {
      const rows = DIGITS[ch];
      if (!rows || dark < 0) return;
      rows.forEach((row, ry) => {
        [...row].forEach((bit, rx) => {
          if (bit === '1') put(tx + k * 4 + rx, ty + ry, frame.data, dark);
        });
      });
    });
    return { width: CARD.w, height: CARD.h, data: out };
  }

  render(grade: FeatherGrade, number: number): FeatherImage {
    const key = `${grade}/${number}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const card = this.card(grade, number);
    const w = card.width * SCALE;
    const h = card.height * SCALE;
    const big = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const s = (Math.floor(y / SCALE) * card.width + Math.floor(x / SCALE)) * 4;
        big.set(card.data.subarray(s, s + 4), (y * w + x) * 4);
      }
    }
    const png = encodePng({ width: w, height: h, data: big });
    const sha = createHash('sha256').update(png);
    const out: FeatherImage = {
      dataUri: `data:image/png;base64,${png.toString('base64')}`,
      sha256Base64: createHash('sha256').update(png).digest('base64'),
      sha256Hex: sha.digest('hex'),
      bytes: png.length,
      width: w,
      height: h,
    };
    this.cache.set(key, out);
    return out;
  }
}
