// npm run derive-assets: builds true-pixel atlases from the packed sheets (see scripts/lib/derive.ts).
//   apps/client/public/assets/derived/<group>-<hash>.png   one atlas per screen group, hashed names
//   apps/client/src/assets/derived.json                     frames, pivots, durations, world scales
// The packed sheets (and coys-assets) are only read. --check fails when the committed output is stale.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { derive, EXACT_GROUP, PAINTED, type SheetJson, type SourceSprite } from './lib/derive';
import { decodePng } from './lib/png';

const root = fileURLToPath(new URL('..', import.meta.url));
const assets = join(root, 'apps/client/public/assets');
const outDir = join(assets, 'derived');
const manifestPath = join(root, 'apps/client/src/assets/derived.json');
const check = process.argv.includes('--check');

interface IndexEntry {
  json: string;
  png: string;
  grid: number;
  rows: Record<string, { mode: 'loop' | 'once' }>;
}
const index = JSON.parse(readFileSync(join(assets, 'index.json'), 'utf8')) as {
  sprites: Record<string, IndexEntry>;
  traits: { bodyRecolour: Record<string, [[number, number, number], [number, number, number]]> };
};

const t0 = Date.now();
const sprites: Record<string, SourceSprite> = {};
for (const id of [...Object.keys(EXACT_GROUP), ...Object.keys(PAINTED)]) {
  const e = index.sprites[id];
  if (!e) throw new Error(`derive-assets: ${id} is not in index.json`);
  sprites[id] = {
    id,
    png: decodePng(readFileSync(join(assets, e.png))),
    json: JSON.parse(readFileSync(join(assets, e.json), 'utf8')) as SheetJson,
    rows: e.rows,
    grid: e.grid,
  };
}
const { manifest, files, report } = derive({ sprites, bodyRecolour: index.traits.bodyRecolour });
const manifestText = `${JSON.stringify(manifest)}\n`;

if (check) {
  const stale: string[] = [];
  if (!existsSync(manifestPath) || readFileSync(manifestPath, 'utf8') !== manifestText) stale.push('derived.json');
  for (const [name, bytes] of files) {
    const p = join(outDir, name);
    if (!existsSync(p) || !Buffer.from(readFileSync(p)).equals(Buffer.from(bytes))) stale.push(name);
  }
  if (stale.length) {
    console.error(`derive-assets --check: stale ${stale.join(', ')}; run npm run derive-assets`);
    process.exit(1);
  }
  console.log(`derive-assets --check: up to date (${files.size} atlases)`);
} else {
  mkdirSync(outDir, { recursive: true });
  for (const f of readdirSync(outDir)) if (!files.has(f)) rmSync(join(outDir, f));
  for (const [name, bytes] of files) writeFileSync(join(outDir, name), bytes);
  writeFileSync(manifestPath, manifestText);
  for (const line of report) console.log(line);
  const total = [...files.values()].reduce((n, b) => n + b.length, 0);
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${files.size} atlases, ${(total / 1024).toFixed(1)} KB`);
}
