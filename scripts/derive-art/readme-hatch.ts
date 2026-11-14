// The README's animated egg: the game's own hatching egg (coys-assets art/x-hatch-egg, the pico #6
// sheet the farm draws), its wobble, crack, burst and shell bits played in a loop as an SVG with SMIL
// (it plays in a README image). Each 32x32 art-pixel cell is taken from the 8x sheet by sampling one
// pixel per art pixel, kept as a tiny PNG, and drawn 4x with nearest-neighbour scaling. Deterministic.
//
//   ASSETS_DIR=~/.coys/coys-assets npx tsx scripts/derive-art/readme-hatch.ts   (writes docs/readme/hatch.svg)
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng } from '../lib/png';

const ASSETS = process.env.ASSETS_DIR ?? join(homedir(), '.coys/coys-assets');
const OUT = fileURLToPath(new URL('../../docs/readme/hatch.svg', import.meta.url));
const sheet = decodePng(readFileSync(join(ASSETS, 'art/x-hatch-egg/x-hatch-egg.png')));
const anim = JSON.parse(readFileSync(join(ASSETS, 'art/x-hatch-egg/anim.json'), 'utf8')) as { grid: number; cell: { w: number; h: number }; rows: { name: string; frameCount: number; msPerFrame: number[] }[] };
const G = anim.grid;
const CELL = anim.cell.w / G; // 32 art pixels
const SCALE = 4;

function frame(row: number, col: number): string {
  const data = new Uint8Array(CELL * CELL * 4);
  for (let y = 0; y < CELL; y++) {
    for (let x = 0; x < CELL; x++) {
      const sx = col * anim.cell.w + x * G + Math.floor(G / 2);
      const sy = row * anim.cell.h + y * G + Math.floor(G / 2);
      const s = (sy * sheet.width + sx) * 4;
      data.set(sheet.data.subarray(s, s + 4), (y * CELL + x) * 4);
    }
  }
  return Buffer.from(encodePng({ width: CELL, height: CELL, data })).toString('base64');
}

const rowIndex = (name: string) => anim.rows.findIndex((r) => r.name === name);
// the beats: wobble three times, crack, burst, the shell bits fall, then a pause
const beats: { row: string; repeat: number }[] = [
  { row: 'wobble', repeat: 3 },
  { row: 'crack', repeat: 1 },
  { row: 'burst', repeat: 1 },
  { row: 'shell-bits', repeat: 1 },
];
const frames: { png: string; ms: number }[] = [];
for (const b of beats) {
  const r = rowIndex(b.row);
  const def = anim.rows[r];
  if (!def) throw new Error(`no row ${b.row}`);
  for (let k = 0; k < b.repeat; k++) for (let c = 0; c < def.frameCount; c++) frames.push({ png: frame(r, c), ms: def.msPerFrame[c] ?? 100 });
}
// hold the last frame (the empty shell) a moment, then start again
const last = frames[frames.length - 1];
if (last) last.ms += 700;
const total = frames.reduce((n, f) => n + f.ms, 0);

const W = 160;
const H = 152;
const size = CELL * SCALE;
const x = (W - size) / 2;
const y = H - size - 8;
let t = 0;
const images = frames.map((f, i) => {
  const a = (t / total).toFixed(5);
  const b = ((t + f.ms) / total).toFixed(5);
  t += f.ms;
  const values = i === 0 ? 'visible;hidden;hidden' : 'hidden;visible;hidden;hidden';
  const keyTimes = i === 0 ? `0;${b};1` : `0;${a};${b};1`;
  return (
    `<image x="${x}" y="${y}" width="${size}" height="${size}" style="image-rendering:pixelated;image-rendering:crisp-edges" visibility="${i === 0 ? 'visible' : 'hidden'}" href="data:image/png;base64,${f.png}">` +
    `<animate attributeName="visibility" values="${values}" keyTimes="${keyTimes}" calcMode="discrete" dur="${total}ms" repeatCount="indefinite"/></image>`
  );
});
const svg = [
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="A pixel egg from the game wobbles, cracks and bursts open, over and over">`,
  `<rect width="${W}" height="${H}" rx="10" fill="#1E1410"/>`,
  `<rect x="16" y="${y + size - 5}" width="${W - 32}" height="6" rx="3" fill="#7A2318"/>`,
  ...images,
  '</svg>',
].join('\n');
writeFileSync(OUT, svg + '\n');
console.log(`docs/readme/hatch.svg: ${frames.length} frames, ${total} ms a loop, ${svg.length} bytes`);
