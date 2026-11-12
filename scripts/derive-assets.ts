// npm run derive-assets: builds the sprite atlases from the packed sheets (see scripts/lib/derive.ts).
//   apps/client/public/assets/derived/<atlas>-<hash>.png   exact sheets per group, painted art per density
//   apps/client/src/assets/derived.json                     frames, pivots, durations, densities
//   docs/asset-report.md                                    every sheet's factor and round-trip error
// The packed sheets (and coys-assets) are only read. --check fails when the committed output is stale.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import encodeWebp, { init as initWebp } from '@jsquash/webp/encode.js';
import { assetReport, derive, EXACT_GROUP, PAINTED, UNUSED, WEBP, type SheetJson, type SourceSprite } from './lib/derive';
import { decodePng, encodePng, type Rgba } from './lib/png';

const root = fileURLToPath(new URL('..', import.meta.url));
const assets = join(root, 'apps/client/public/assets');
const outDir = join(assets, 'derived');
const manifestPath = join(root, 'apps/client/src/assets/derived.json');
const reportPath = join(root, 'docs/asset-report.md');
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

function loadSources(ids: string[]): Record<string, SourceSprite> {
  const sprites: Record<string, SourceSprite> = {};
  for (const id of ids) {
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
  return sprites;
}

const t0 = Date.now();
const sprites = loadSources([...Object.keys(EXACT_GROUP), ...Object.keys(PAINTED), ...UNUSED.filter((id) => index.sprites[id])]);
const { manifest, pages, assets: rows, log } = derive({ sprites, bodyRecolour: index.traits.bodyRecolour });
const manifestText = `${JSON.stringify(manifest)}\n`;
const sizeOnDisk = (file: string) => (existsSync(join(outDir, file)) ? statSync(join(outDir, file)).size : 0);

/** The WebAssembly WebP encoder, loaded from node_modules (no fetch in Node). */
async function webpEncoder(): Promise<(img: Rgba) => Promise<Uint8Array>> {
  const require = createRequire(import.meta.url);
  const dir = join(require.resolve('@jsquash/webp/encode.js'), '..', 'codec', 'enc');
  // the encoder picks its SIMD build when the runtime has SIMD (every current Node does): match it
  const wasmApi = (globalThis as unknown as { WebAssembly: { compile(bytes: Uint8Array): Promise<unknown> } }).WebAssembly;
  const wasm = await wasmApi.compile(readFileSync(join(dir, 'webp_enc_simd.wasm'))).catch(() => wasmApi.compile(readFileSync(join(dir, 'webp_enc.wasm'))));
  await initWebp(wasm as never);
  return async (img) => new Uint8Array(await encodeWebp({ data: new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.length), width: img.width, height: img.height, colorSpace: 'srgb' }, { ...WEBP }));
}

if (check) {
  // files are named by their pixels: the manifest pins every page, so no encoder runs here
  const stale: string[] = [];
  if (!existsSync(manifestPath) || readFileSync(manifestPath, 'utf8') !== manifestText) stale.push('derived.json');
  for (const name of pages.keys()) if (!existsSync(join(outDir, name))) stale.push(name);
  if (!existsSync(reportPath) || readFileSync(reportPath, 'utf8') !== assetReport(rows, manifest, sizeOnDisk)) stale.push('asset-report.md');
  if (stale.length) {
    console.error(`derive-assets --check: stale ${stale.join(', ')}; run npm run derive-assets`);
    process.exit(1);
  }
  console.log(`derive-assets --check: up to date (${pages.size} atlas pages)`);
} else {
  mkdirSync(outDir, { recursive: true });
  for (const f of readdirSync(outDir)) if (!pages.has(f)) rmSync(join(outDir, f));
  const webp = await webpEncoder();
  for (const [name, { image, format }] of pages) {
    if (existsSync(join(outDir, name))) continue;
    writeFileSync(join(outDir, name), format === 'png' ? encodePng(image) : await webp(image));
  }
  writeFileSync(manifestPath, manifestText);
  writeFileSync(reportPath, assetReport(rows, manifest, sizeOnDisk));
  for (const line of log) console.log(line);
  console.log(`derive-assets: ${pages.size} atlas pages, ${(manifestText.length / 1024).toFixed(1)} KB manifest, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
