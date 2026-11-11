// Cuts the favicon and the 1200x630 Open Graph share image from the packed sprites, so they always
// match the game's own art. Writes into apps/client/public; run again after the art changes.
//
//   npx tsx scripts/make-share-images.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encodePng } from '../apps/server/src/chain/png';
import { decodePng, type Rgba } from './lib/png';

const root = fileURLToPath(new URL('../', import.meta.url));
const sprites = `${root}apps/client/public/assets/sprites/`;
const out = `${root}apps/client/public/`;

interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
}

function frame(sheet: string, name: string): Rgba {
  const atlas = JSON.parse(readFileSync(`${sprites}${sheet}.json`, 'utf8')) as { frames: Record<string, { frame: Frame }> };
  const f = atlas.frames[name]?.frame;
  if (!f) throw new Error(`${sheet} has no frame ${name}`);
  const img = decodePng(readFileSync(`${sprites}${sheet}.png`));
  const data = new Uint8Array(f.w * f.h * 4);
  for (let y = 0; y < f.h; y++) data.set(img.data.subarray(((f.y + y) * img.width + f.x) * 4, ((f.y + y) * img.width + f.x + f.w) * 4), y * f.w * 4);
  return { width: f.w, height: f.h, data };
}

function canvas(width: number, height: number): Rgba {
  return { width, height, data: new Uint8Array(width * height * 4) };
}

/** Source-over blend of src onto dst at (dx, dy), clipped to dst. */
function draw(dst: Rgba, src: Rgba, dx: number, dy: number): void {
  for (let y = 0; y < src.height; y++) {
    const ty = dy + y;
    if (ty < 0 || ty >= dst.height) continue;
    for (let x = 0; x < src.width; x++) {
      const tx = dx + x;
      if (tx < 0 || tx >= dst.width) continue;
      const s = (y * src.width + x) * 4;
      const d = (ty * dst.width + tx) * 4;
      const a = (src.data[s + 3] ?? 0) / 255;
      if (a === 0) continue;
      for (let c = 0; c < 3; c++) dst.data[d + c] = Math.round((src.data[s + c] ?? 0) * a + (dst.data[d + c] ?? 0) * (1 - a));
      dst.data[d + 3] = Math.round(255 * (a + ((dst.data[d + 3] ?? 0) / 255) * (1 - a)));
    }
  }
}

/** Area-average downscale (alpha weighted), for icons from a large portrait. */
function scaleDown(src: Rgba, size: number): Rgba {
  const dst = canvas(size, size);
  const k = src.width / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = Math.floor(y * k); sy < Math.floor((y + 1) * k); sy++) {
        for (let sx = Math.floor(x * k); sx < Math.floor((x + 1) * k); sx++) {
          const i = (sy * src.width + sx) * 4;
          const al = src.data[i + 3] ?? 0;
          r += (src.data[i] ?? 0) * al;
          g += (src.data[i + 1] ?? 0) * al;
          b += (src.data[i + 2] ?? 0) * al;
          a += al;
          n++;
        }
      }
      const d = (y * size + x) * 4;
      if (a > 0) dst.data.set([Math.round(r / a), Math.round(g / a), Math.round(b / a), Math.round(a / n)], d);
    }
  }
  return dst;
}

function crop(src: Rgba, x0: number, y0: number, w: number, h: number): Rgba {
  const dst = canvas(w, h);
  for (let y = 0; y < h; y++) dst.data.set(src.data.subarray(((y0 + y) * src.width + x0) * 4, ((y0 + y) * src.width + x0 + w) * 4), y * w * 4);
  return dst;
}

// share image: the title plate cut to 1200x630, the logo across the top, a hen and two rivals below
const og = crop(frame('26-title-plate', 'plate/0'), 40, 45, 1200, 630);
const logo = frame('28-logo', 'idle/0');
draw(og, logo, Math.round((og.width - logo.width) / 2), 18);
draw(og, frame('x-hen-portrait', 'delighted/0'), 472, 374);
draw(og, frame('04-upstart', 'idle/0'), 150, 374);
draw(og, frame('05-old-money', 'idle/0'), 794, 374);
writeFileSync(`${out}og-image.png`, encodePng(og));

// favicons from the hen portrait
const hen = frame('x-hen-portrait', 'idle/0');
for (const size of [32, 192]) writeFileSync(`${out}favicon-${size}.png`, encodePng(scaleDown(hen, size)));
console.log('wrote og-image.png (1200x630), favicon-32.png, favicon-192.png');
