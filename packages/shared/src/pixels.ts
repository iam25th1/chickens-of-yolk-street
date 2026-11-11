// Pixel passes run once at load on RGBA data. Pure functions, unit-tested in test/pixels.test.ts.

/** Hard alpha: soft halo pixels go fully transparent, the rest fully opaque. */
export function alphaCut(data: Uint8ClampedArray | Uint8Array, threshold = 128): void {
  for (let i = 3; i < data.length; i += 4) data[i] = (data[i] ?? 0) < threshold ? 0 : 255;
}

type Rgb = readonly [number, number, number];

function hsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max / 255 };
}

/** Feathers are warm, light and gently saturated: not the dark outline, white eye, or orange beak and legs. */
export function isFeather(r: number, g: number, b: number): boolean {
  const { h, s, v } = hsv(r, g, b);
  if (v > 0.9 && s < 0.14) return false; // eye whites and glints keep their colour
  return v > 0.4 && s >= 0.08 && s < 0.5 && (h <= 60 || h >= 340);
}

const luma = (r: number, g: number, b: number): number => 0.299 * r + 0.587 * g + 0.114 * b;

/**
 * Hen frames are cut with headroom above each row (so tall combs and hats stay whole), which means
 * a frame also holds the bottom of the row above and the top of the row below. This labels every
 * opaque blob in the union of the hen sheets and gives it to the row its lowest pixel sits in;
 * a frame then keeps only its own row's blobs. Returns the owning row per pixel (-1 when empty).
 */
export function ownerRows(masks: (Uint8ClampedArray | Uint8Array)[], width: number, height: number, rowHeight: number): Int8Array {
  const n = width * height;
  const solid = new Uint8Array(n);
  for (const m of masks) for (let i = 0; i < n; i++) if ((m[i * 4 + 3] ?? 0) > 0) solid[i] = 1;
  const owner = new Int8Array(n).fill(-1);
  const label = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  const members: number[] = [];
  for (let start = 0; start < n; start++) {
    if (!solid[start] || label[start] !== -1) continue;
    let top = 0;
    stack[top++] = start;
    label[start] = start;
    members.length = 0;
    let maxY = 0;
    while (top > 0) {
      const p = stack[--top] ?? 0;
      members.push(p);
      const y = (p / width) | 0;
      const x = p - y * width;
      if (y > maxY) maxY = y;
      const near = [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, y > 0 ? p - width : -1, y < height - 1 ? p + width : -1];
      for (const q of near) {
        if (q >= 0 && solid[q] && label[q] === -1) {
          label[q] = start;
          stack[top++] = q;
        }
      }
    }
    const row = Math.floor(maxY / rowHeight);
    for (const p of members) owner[p] = row;
  }
  return owner;
}

/**
 * Palette swap for the body layer: feather pixels map by brightness onto a [dark, light] ramp
 * (from art/02-traits.json bodyRecolour). Everything else keeps its colour.
 */
export function recolourBody(data: Uint8ClampedArray | Uint8Array, ramp: readonly [Rgb, Rgb]): number {
  const lumas: number[] = [];
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    if ((data[i + 3] ?? 0) > 0 && isFeather(r, g, b)) lumas.push(luma(r, g, b));
  }
  if (!lumas.length) return 0;
  lumas.sort((a, b) => a - b);
  const lo = lumas[Math.floor(lumas.length * 0.03)] ?? 0;
  const hi = lumas[Math.floor(lumas.length * 0.98)] ?? 255;
  const span = Math.max(1, hi - lo);
  const [dark, light] = ramp;
  let changed = 0;
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    if ((data[i + 3] ?? 0) === 0 || !isFeather(r, g, b)) continue;
    const t = Math.min(1, Math.max(0, (luma(r, g, b) - lo) / span));
    data[i] = Math.round(dark[0] + (light[0] - dark[0]) * t);
    data[i + 1] = Math.round(dark[1] + (light[1] - dark[1]) * t);
    data[i + 2] = Math.round(dark[2] + (light[2] - dark[2]) * t);
    changed++;
  }
  return changed;
}
