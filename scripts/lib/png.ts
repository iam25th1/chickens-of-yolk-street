// Minimal PNG decoder (8-bit, non-interlaced; greyscale, RGB, palette, grey+alpha, RGBA) to RGBA.
// Used by the asset packer to measure each sheet's pixel grid. Built on node:zlib only.
import { inflateSync } from 'node:zlib';

export interface Rgba {
  width: number;
  height: number;
  data: Uint8Array;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export function decodePng(buf: Uint8Array): Rgba {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let off = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colourType = 0;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (off < buf.length) {
    const len = view.getUint32(off);
    const type = String.fromCharCode(...buf.subarray(off + 4, off + 8));
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      const d = new DataView(data.buffer, data.byteOffset, data.byteLength);
      width = d.getUint32(0);
      height = d.getUint32(4);
      depth = data[8] ?? 0;
      colourType = data[9] ?? 0;
      interlace = data[12] ?? 0;
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  const ch = CHANNELS[colourType];
  if (depth !== 8 || interlace !== 0 || ch === undefined) {
    throw new Error(`unsupported PNG: depth ${depth}, colour type ${colourType}, interlace ${interlace}`);
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * ch;
  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++] ?? 0;
    const line = Uint8Array.from(raw.subarray(p, p + stride));
    p += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? (line[x - ch] ?? 0) : 0;
      const b = prev[x] ?? 0;
      const c = x >= ch ? (prev[x - ch] ?? 0) : 0;
      let v = line[x] ?? 0;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a);
        const pb = Math.abs(pp - b);
        const pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[x] = v & 255;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (colourType === 6) out.set(line.subarray(x * 4, x * 4 + 4), o);
      else if (colourType === 2) {
        out.set(line.subarray(x * 3, x * 3 + 3), o);
        out[o + 3] = 255;
      } else if (colourType === 0 || colourType === 4) {
        const g = line[x * (ch as number)] ?? 0;
        out[o] = g;
        out[o + 1] = g;
        out[o + 2] = g;
        out[o + 3] = colourType === 4 ? (line[x * 2 + 1] ?? 255) : 255;
      } else {
        const i = line[x] ?? 0;
        out[o] = palette?.[i * 3] ?? 0;
        out[o + 1] = palette?.[i * 3 + 1] ?? 0;
        out[o + 2] = palette?.[i * 3 + 2] ?? 0;
        out[o + 3] = trns && i < trns.length ? (trns[i] ?? 255) : 255;
      }
    }
    prev = line;
  }
  return { width, height, data: out };
}

/**
 * Detects the art's pixel grid: the largest k in (8, 4, 2) such that at least 98% of colour edges,
 * both horizontal and vertical, fall on one phase of a k-pixel grid. Returns 1 for art with no grid
 * (soft, anti-aliased sprites).
 */
export function detectPixelGrid(img: Rgba): number {
  const share = (k: number, axis: 'x' | 'y'): number => {
    const counts = new Array<number>(k).fill(0);
    let total = 0;
    const { width, height, data } = img;
    const step = 3;
    if (axis === 'x') {
      for (let y = 0; y < height; y += step)
        for (let x = 1; x < width; x++) {
          const o = (y * width + x) * 4;
          if (differs(data, o, o - 4)) {
            counts[x % k] = (counts[x % k] ?? 0) + 1;
            total++;
          }
        }
    } else {
      for (let x = 0; x < width; x += step)
        for (let y = 1; y < height; y++) {
          const o = (y * width + x) * 4;
          if (differs(data, o, o - width * 4)) {
            counts[y % k] = (counts[y % k] ?? 0) + 1;
            total++;
          }
        }
    }
    return total === 0 ? 1 : Math.max(...counts) / total;
  };
  for (const k of [8, 4, 2]) if (share(k, 'x') >= 0.98 && share(k, 'y') >= 0.98) return k;
  return 1;
}

function differs(d: Uint8Array, a: number, b: number): boolean {
  return d[a] !== d[b] || d[a + 1] !== d[b + 1] || d[a + 2] !== d[b + 2] || d[a + 3] !== d[b + 3];
}
