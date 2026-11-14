// Purple and magenta, as the art checks see them: a hue from 250 to 340 degrees and a value of at least
// 0.43 (darker reads as shadow; PICO-8 plum, the darkest purple the art had, is 0.49), with a saturation
// of at least 0.3, or at least 0.2 when the value is at least 0.45 (a faint tint reads as a colour only
// when it is light: PICO-8 lavender counts; near-black outlines, dark shading and the black hen's
// charcoal, with a faint cool tint, do not).
// The game uses no purple: the recolour (scripts/derive-art/recolour-purple.ts) swaps the three PICO-8
// purples the Spawn badge and egg sheets used for colours the game's own art already has.

export function isPurple(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const s = d === 0 ? 0 : d / max;
  if (max < 110 || s < 0.2 || (s < 0.3 && max < 115)) return false;
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  return h >= 250 && h <= 340;
}

const hex = (c: string): [number, number, number] => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];

/**
 * Each purple the sheets used, and its replacement from the game's own art: PICO-8 plum (the bronze
 * frame's outline and the icons' dark shade) becomes the Quill feather's deep red, lavender (the
 * locked frame's light, the icons' and the hatching egg's mid shade) the unminted frame's grey, and
 * pink (the quill icon's light) the Quill's salmon.
 */
export const RECOLOUR: readonly { from: string; to: string; what: string }[] = [
  { from: '#7e2553', to: '#7a1e1c', what: 'plum to the Quill feather deep red' },
  { from: '#83769c', to: '#969692', what: 'lavender to the unminted frame grey' },
  { from: '#ff77a8', to: '#e86854', what: 'pink to the Quill feather salmon' },
];

/** Replaces every pixel of a RECOLOUR colour in place; returns how many changed per colour. */
export function recolour(data: Uint8Array): Record<string, number> {
  const swaps = RECOLOUR.map((s) => ({ ...s, f: hex(s.from), t: hex(s.to) }));
  const counts: Record<string, number> = Object.fromEntries(RECOLOUR.map((s) => [s.from, 0]));
  for (let i = 0; i < data.length; i += 4) {
    if (!data[i + 3]) continue;
    for (const s of swaps) {
      if (data[i] === s.f[0] && data[i + 1] === s.f[1] && data[i + 2] === s.f[2]) {
        data[i] = s.t[0];
        data[i + 1] = s.t[1];
        data[i + 2] = s.t[2];
        counts[s.from] = (counts[s.from] ?? 0) + 1;
        break;
      }
    }
  }
  return counts;
}

/**
 * Painted art (many colours, soft shading): every purple pixel's hue turns to WARM_HUE, a warm brown,
 * keeping its saturation and value, so the shading reads the same. Returns how many changed.
 */
export const WARM_HUE = 20;
export function warmPurple(data: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (!data[i + 3]) continue;
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    if (!isPurple(r, g, b)) continue;
    const max = Math.max(r, g, b);
    const s = (max - Math.min(r, g, b)) / max;
    // HSV to RGB at WARM_HUE (between red and yellow: red is the max, blue the min)
    const f = WARM_HUE / 60;
    const lo = Math.round(max * (1 - s));
    data[i] = max;
    data[i + 1] = Math.round(max * (1 - s * (1 - f)));
    data[i + 2] = lo;
    n++;
  }
  return n;
}

/**
 * Purple patches in a lossy page (WebP): purple pixels with a purple neighbour to the right and below
 * (a 2x2 block), so single pixels of compression or downscaling noise between two colours do not count.
 */
export function purplePatches(data: Uint8Array, width: number): number {
  const height = data.length / 4 / width;
  const p = (x: number, y: number): boolean => {
    const i = (y * width + x) * 4;
    return Boolean(data[i + 3]) && isPurple(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0);
  };
  let n = 0;
  for (let y = 0; y + 1 < height; y++) for (let x = 0; x + 1 < width; x++) if (p(x, y) && p(x + 1, y) && p(x, y + 1) && p(x + 1, y + 1)) n++;
  return n;
}

/** Purple pixels left in an RGBA buffer, by colour. */
export function purplePixels(data: Uint8Array): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < data.length; i += 4) {
    if (!data[i + 3]) continue;
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    if (!isPurple(r, g, b)) continue;
    const k = `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
    out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
}
