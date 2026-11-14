// Two badge icons for the leaderboard, made by code from the badge icon sheet itself (coys-assets
// art/x-badge-icons, the pico #6 sheet the badges draw from), on its 16 pixel grid and in its own
// colours: 'season' (a season's badge) is the coin medal with a small glint at its top right, and
// 'comeback' (back from a bust into a week's top 10) is the standing farm sign with an arrow pointing
// up beside it. Each is appended to the sheet as a new row (or replaced, so running it again changes
// nothing), and the sheet's anim.json rows and its manifest entry (SHA-256, size, height) follow.
//
//   ASSETS_DIR=~/.coys/coys-assets npx tsx scripts/derive-art/league-icons.ts
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { decodePng, encodePng, type Rgba } from '../lib/png';
import { purplePixels } from '../lib/purple';

const ASSETS = process.env.ASSETS_DIR ?? join(homedir(), '.coys/coys-assets');
const DIR = join(ASSETS, 'art/x-badge-icons');
const SHEET = join(DIR, 'x-badge-icons.png');
const ANIM = join(DIR, 'anim.json');
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

interface Row {
  name: string;
  mode: string;
  vanish: boolean;
  frameCount: number;
  msPerFrame: number[];
  baseMs: number;
  holds: unknown[];
  totalMs: number;
  frames: { rect: [number, number, number, number]; ms: number }[];
}
const anim = JSON.parse(readFileSync(ANIM, 'utf8')) as { grid: number; cell: { w: number; h: number }; sheet: { width: number; height: number; bytes: number; sha256: string }; rows: Row[] };
const G = anim.grid; // sheet pixels per art pixel
const N = anim.cell.w / G; // art pixels per cell side (16)
const sheet = decodePng(readFileSync(SHEET));

type Px = [number, number, number, number];
type Art = Px[][];
const hex = (c: string): Px => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16), 255];
const CLEAR: Px = [0, 0, 0, 0];
const INK = hex('#000000');
const YELLOW = hex('#ffec27');
const CREAM = hex('#fff1e8');

/** A row's cell as art pixels (the centre of each G x G block). */
function cellOf(name: string): Art {
  const row = anim.rows.find((r) => r.name === name);
  if (!row) throw new Error(`no row ${name}`);
  const [x0, y0] = row.frames[0]?.rect ?? [0, 0];
  const art: Art = [];
  for (let y = 0; y < N; y++) {
    const line: Px[] = [];
    for (let x = 0; x < N; x++) {
      const i = ((y0 + y * G + (G >> 1)) * sheet.width + (x0 + x * G + (G >> 1))) * 4;
      line.push([sheet.data[i] ?? 0, sheet.data[i + 1] ?? 0, sheet.data[i + 2] ?? 0, sheet.data[i + 3] ?? 0]);
    }
    art.push(line);
  }
  return art;
}

const blank = (): Art => Array.from({ length: N }, () => Array.from({ length: N }, () => [...CLEAR] as Px));
const put = (a: Art, x: number, y: number, c: Px) => {
  const row = a[y];
  if (row && x >= 0 && x < N) row[x] = c;
};
/** Copies b onto a shifted by (dx, dy), opaque pixels only. */
function stamp(a: Art, b: Art, dx: number, dy: number): void {
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const p = b[y]?.[x];
      if (p && p[3] > 0) put(a, x + dx, y + dy, p);
    }
  }
}
/** Pixels drawn from a picture of characters: '#' ink, 'y' yellow, 'w' cream, '.' nothing. */
function draw(a: Art, x0: number, y0: number, rows: string[]): void {
  rows.forEach((line, y) => [...line].forEach((ch, x) => ch !== '.' && put(a, x0 + x, y0 + y, ch === '#' ? INK : ch === 'y' ? YELLOW : CREAM)));
}

// season: the coin medal, with a glint at its top right
const season = blank();
stamp(season, cellOf('coin'), 0, 0);
draw(season, 11, 0, ['.#...', '#w#..', '.#...']);
// comeback: the standing farm sign moved left, an arrow pointing up beside it
const comeback = blank();
stamp(comeback, cellOf('rank'), -2, 0);
draw(comeback, 11, 3, ['..#..', '.#y#.', '#yyy#', '.#y#.', '.#y#.', '.#y#.', '.###.']);

/** Writes art pixels into the sheet cell at (0, y0), G x G sheet pixels each. */
function paint(img: Rgba, art: Art, y0: number): void {
  for (let y = 0; y < N * G; y++) {
    for (let x = 0; x < N * G; x++) {
      const p = art[Math.floor(y / G)]?.[Math.floor(x / G)] ?? CLEAR;
      img.data.set(p, ((y0 + y) * img.width + x) * 4);
    }
  }
}

const made: Record<string, Art> = { season, comeback };
const keep = anim.rows.filter((r) => !(r.name in made));
const height = (keep.length + Object.keys(made).length) * anim.cell.h;
const out: Rgba = { width: sheet.width, height, data: new Uint8Array(sheet.width * height * 4) };
// the existing rows, as they were (rows this script made before are made again below)
keep.forEach((r, i) => {
  const [, ry] = r.frames[0]?.rect ?? [0, 0];
  for (let y = 0; y < anim.cell.h; y++) {
    const from = ((ry + y) * sheet.width) * 4;
    out.data.set(sheet.data.subarray(from, from + sheet.width * 4), ((i * anim.cell.h + y) * sheet.width) * 4);
  }
  r.frames = [{ rect: [0, i * anim.cell.h, anim.cell.w, anim.cell.h], ms: r.frames[0]?.ms ?? 1000 }];
});
const rows: Row[] = [...keep];
Object.entries(made).forEach(([name, art], k) => {
  const y = (keep.length + k) * anim.cell.h;
  paint(out, art, y);
  rows.push({ name, mode: 'loop', vanish: false, frameCount: 1, msPerFrame: [1000], baseMs: 1000, holds: [], totalMs: 1000, frames: [{ rect: [0, y, anim.cell.w, anim.cell.h], ms: 1000 }] });
});
if (purplePixels(out.data).size) throw new Error('purple in the new icons');
const png = encodePng(out);
writeFileSync(SHEET, png);
anim.rows = rows;
anim.sheet = { ...anim.sheet, height, bytes: png.length, sha256: sha(png) };
const animText = `${JSON.stringify(anim, null, 2)}\n`;
writeFileSync(ANIM, animText);

// the manifest: the sheet's new SHA-256, size and height, and anim.json's
const manifestPath = join(ASSETS, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { art: { tracker: string; files: Record<string, unknown>[] }[] };
const entry = manifest.art.find((a) => a.tracker === 'x-badge-icons');
if (!entry) throw new Error('no manifest entry for x-badge-icons');
for (const f of entry.files) {
  if (f.path === 'art/x-badge-icons/x-badge-icons.png') {
    f.sha256 = sha(png);
    f.bytes = png.length;
    f.height = height;
    f.derivedBy = 'iam25th1/chickens-of-yolk-street scripts/derive-art/recolour-purple.ts, scripts/derive-art/league-icons.ts';
  } else if (f.path === 'art/x-badge-icons/anim.json') {
    f.sha256 = sha(Buffer.from(animText));
    f.bytes = Buffer.byteLength(animText);
  }
}
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`x-badge-icons: ${rows.length} rows (season, comeback made by code), ${png.length} bytes, sha256 ${sha(png).slice(0, 12)}`);
