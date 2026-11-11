// Minimal PNG decoder (8-bit, non-interlaced; greyscale, RGB, palette, grey+alpha, RGBA) to RGBA.
// Used by the asset packer to measure each sheet's pixel grid. Built on node:zlib only.
import { deflateSync, inflateSync } from 'node:zlib';

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

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * Lossless PNG encoder. Images with 256 colours or fewer (counting alpha) are written as indexed
 * colour with a tRNS chunk, the rest as RGBA; each row takes the filter that compresses best.
 * Deterministic: the same pixels always give the same bytes.
 */
export function encodePng(img: Rgba): Uint8Array {
  const { width, height, data } = img;
  const colours = new Map<number, number>();
  for (let i = 0; i < width * height && colours.size <= 256; i++) {
    const a = data[i * 4 + 3] ?? 0;
    const key = a === 0 ? 0 : (((data[i * 4] ?? 0) << 24) | ((data[i * 4 + 1] ?? 0) << 16) | ((data[i * 4 + 2] ?? 0) << 8) | a) >>> 0;
    if (!colours.has(key)) colours.set(key, colours.size);
  }
  const indexed = colours.size <= 256;
  const bpp = indexed ? 1 : 4;
  const stride = width * bpp;
  const rows: Uint8Array[] = [];
  for (let y = 0; y < height; y++) {
    const row = new Uint8Array(stride);
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (indexed) {
        const a = data[o + 3] ?? 0;
        const key = a === 0 ? 0 : (((data[o] ?? 0) << 24) | ((data[o + 1] ?? 0) << 16) | ((data[o + 2] ?? 0) << 8) | a) >>> 0;
        row[x] = colours.get(key) ?? 0;
      } else {
        const a = data[o + 3] ?? 0;
        row[x * 4] = a ? (data[o] ?? 0) : 0;
        row[x * 4 + 1] = a ? (data[o + 1] ?? 0) : 0;
        row[x * 4 + 2] = a ? (data[o + 2] ?? 0) : 0;
        row[x * 4 + 3] = a;
      }
    }
    rows.push(row);
  }
  const raw = new Uint8Array((stride + 1) * height);
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const cur = rows[y] as Uint8Array;
    const prev = y > 0 ? (rows[y - 1] as Uint8Array) : new Uint8Array(stride);
    let best: Uint8Array | null = null;
    let bestType = 0;
    let bestScore = Infinity;
    for (let type = 0; type < 5; type++) {
      const f = new Uint8Array(stride);
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? (cur[i - bpp] ?? 0) : 0;
        const b = prev[i] ?? 0;
        const c = i >= bpp ? (prev[i - bpp] ?? 0) : 0;
        const x = cur[i] ?? 0;
        const v = type === 0 ? x : type === 1 ? x - a : type === 2 ? x - b : type === 3 ? x - ((a + b) >> 1) : x - paeth(a, b, c);
        f[i] = v & 0xff;
        score += Math.min(f[i] ?? 0, 256 - (f[i] ?? 0));
      }
      if (score < bestScore) {
        bestScore = score;
        best = f;
        bestType = type;
      }
    }
    raw[y * (stride + 1)] = bestType;
    raw.set(best as Uint8Array, y * (stride + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const hv = new DataView(ihdr.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = indexed ? 3 : 6;
  const parts: Uint8Array[] = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr)];
  if (indexed) {
    const plte = new Uint8Array(colours.size * 3);
    const trns = new Uint8Array(colours.size);
    for (const [key, i] of colours) {
      plte[i * 3] = (key >>> 24) & 0xff;
      plte[i * 3 + 1] = (key >>> 16) & 0xff;
      plte[i * 3 + 2] = (key >>> 8) & 0xff;
      trns[i] = key & 0xff;
    }
    parts.push(chunk('PLTE', plte), chunk('tRNS', trns));
  }
  parts.push(chunk('IDAT', new Uint8Array(deflateSync(raw, { level: 9 }))), chunk('IEND', new Uint8Array(0)));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
