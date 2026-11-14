// No purple in the game's art: the Spawn badge frames, badge icons and hatching egg used three PICO-8
// purples (plum, lavender, pink). This swaps each, pixel for pixel on the sheet's own grid, for a
// colour the game's art already has (scripts/lib/purple.ts RECOLOUR): no new colour, no gradient,
// nothing moved. The bronze, silver and gold frames stay distinct (bronze: deep red, brown, peach;
// silver: greys and white; gold: brown, orange, yellow). Writes the sheets back into the coys-assets
// clone and records each file's new SHA-256 and size in its manifest, with the SHA-256 it was derived
// from. The painted Upstart sheet had dark plum shadows: their hue turns to a warm brown, keeping
// saturation and value (lib/purple.ts warmPurple). Deterministic; running it again changes nothing.
//
//   ASSETS_DIR=~/.coys/coys-assets npx tsx scripts/derive-art/recolour-purple.ts [--check]
//
// --check writes nothing and fails if any sheet in the coys-assets art folder still has purple.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { decodePng, encodePng } from '../lib/png';
import { WARM_HUE, purplePixels, recolour, warmPurple } from '../lib/purple';

const ASSETS = process.env.ASSETS_DIR ?? join(homedir(), '.coys/coys-assets');
const SHEETS = ['x-badge-frames', 'x-badge-icons', 'x-hatch-egg'];
/** Painted sheets with purple shading (the Upstart's dark plum shadows, a few on the market trader): turned to warm brown. */
const PAINTED = ['04-upstart', '09-market-trader'];
const check = process.argv.includes('--check');
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

if (check) {
  let bad = 0;
  for (const dir of readdirSync(join(ASSETS, 'art'))) {
    const folder = join(ASSETS, 'art', dir);
    if (!statSync(folder).isDirectory()) continue;
    for (const f of readdirSync(folder).filter((x) => x.endsWith('.png'))) {
      const left = purplePixels(decodePng(readFileSync(join(folder, f))).data);
      if (left.size) {
        bad++;
        console.log(`purple left in art/${dir}/${f}: ${[...left].map(([k, n]) => `${k} x${n}`).join(', ')}`);
      }
    }
  }
  console.log(bad ? `recolour-purple: ${bad} sheet(s) with purple` : 'recolour-purple: no purple in any sheet');
  process.exit(bad ? 1 : 0);
}

type ManifestFile = { path: string; sha256: string; bytes: number; derivedFrom?: string; derivedBy?: string };
const manifestPath = join(ASSETS, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { art: { tracker: string; files: ManifestFile[] }[] };
for (const id of [...SHEETS, ...PAINTED]) {
  const path = `art/${id}/${id}.png`;
  const before = readFileSync(join(ASSETS, path));
  const img = decodePng(before);
  const counts = PAINTED.includes(id) ? { [`warm hue ${WARM_HUE}`]: warmPurple(img.data) } : recolour(img.data);
  const changed = Object.values(counts).reduce((s, n) => s + n, 0);
  const left = purplePixels(img.data);
  if (left.size) throw new Error(`${path}: purple the map does not cover: ${[...left.keys()].join(', ')}`);
  if (!changed) {
    console.log(`${path}: no purple, unchanged`);
    continue;
  }
  const out = encodePng(img);
  writeFileSync(join(ASSETS, path), out);
  const entry = manifest.art.find((a) => a.tracker === id)?.files.find((f) => f.path === path);
  if (!entry) throw new Error(`${path}: no manifest entry`);
  entry.derivedFrom ??= entry.sha256;
  entry.derivedBy = 'iam25th1/chickens-of-yolk-street scripts/derive-art/recolour-purple.ts';
  entry.sha256 = sha(out);
  entry.bytes = out.length;
  console.log(`${path}: ${Object.entries(counts).map(([c, n]) => `${c} x${n}`).join(', ')}; sha256 ${entry.sha256.slice(0, 12)}, ${entry.bytes} bytes`);
}
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
