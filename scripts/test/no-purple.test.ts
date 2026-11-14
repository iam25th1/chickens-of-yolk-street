// No purple anywhere in the game's art: every packed sprite sheet, every derived atlas page (PNG and
// WebP), the README's hatching egg, and every colour written in the client's styles and code. Purple
// is scripts/lib/purple.ts isPurple (hue 250 to 340; see there for the saturation and value); on
// the lossy WebP pages only purple patches count (purplePatches), not single pixels of compression noise.
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import decodeWebp, { init as initWebpDecoder } from '@jsquash/webp/decode.js';
import { describe, expect, it } from 'vitest';
import { decodePng } from '../lib/png';
import { RECOLOUR, isPurple, purplePatches, purplePixels } from '../lib/purple';

const root = fileURLToPath(new URL('../../', import.meta.url));
const assets = join(root, 'apps/client/public/assets');
const list = (m: Map<string, number>) => [...m].map(([k, n]) => `${k} x${n}`).join(', ');

describe('no purple in the art', () => {
  it('the purple test: the three PICO-8 purples are purple, their replacements and the game palette are not', () => {
    for (const s of RECOLOUR) {
      const h = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)) as [number, number, number];
      expect(isPurple(...h(s.from)), s.from).toBe(true);
      expect(isPurple(...h(s.to)), s.to).toBe(false);
    }
    // PICO-8 red and a hen's comb are red, not magenta; near-black outlines are not counted
    expect(isPurple(0xff, 0x00, 0x4d)).toBe(false);
    expect(isPurple(0x20, 0x1a, 0x1e)).toBe(false);
  });

  it('every packed sprite sheet and derived PNG page', () => {
    const found: string[] = [];
    for (const dir of ['sprites', 'derived']) {
      for (const f of readdirSync(join(assets, dir)).filter((x) => x.endsWith('.png'))) {
        const left = purplePixels(decodePng(readFileSync(join(assets, dir, f))).data);
        if (left.size) found.push(`${dir}/${f}: ${list(left)}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('every derived WebP page (no purple patch)', async () => {
    const require = createRequire(import.meta.url);
    // the WebAssembly decoder, loaded from node_modules (no fetch in Node), as derive-assets loads its encoder
    const wasmApi = (globalThis as unknown as { WebAssembly: { compile(bytes: Uint8Array): Promise<unknown> } }).WebAssembly;
    await initWebpDecoder((await wasmApi.compile(readFileSync(join(require.resolve('@jsquash/webp/decode.js'), '..', 'codec', 'dec', 'webp_dec.wasm')))) as never);
    const found: string[] = [];
    for (const f of readdirSync(join(assets, 'derived')).filter((x) => x.endsWith('.webp'))) {
      const file = readFileSync(join(assets, 'derived', f));
      const img = await decodeWebp(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer);
      const patches = purplePatches(new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.length), img.width);
      if (patches) found.push(`derived/${f}: ${patches} purple 2x2 patches`);
    }
    expect(found).toEqual([]);
  }, 120_000);

  it("the README's hatching egg", () => {
    const svg = readFileSync(join(root, 'docs/readme/hatch.svg'), 'utf8');
    const found: string[] = [];
    for (const m of svg.matchAll(/data:image\/png;base64,([A-Za-z0-9+/=]+)/g)) {
      const left = purplePixels(decodePng(Buffer.from(m[1] ?? '', 'base64')).data);
      if (left.size) found.push(list(left));
    }
    expect(found).toEqual([]);
  });

  it('every colour written in the client and shared code and styles', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx|css|html)$/.test(e.name)) files.push(p);
      }
    };
    for (const d of ['apps/client/src', 'packages/shared/src', 'apps/server/src/chain']) walk(join(root, d));
    files.push(join(root, 'apps/client/index.html'), join(root, '.github/header.svg'));
    const found: string[] = [];
    for (const f of files) {
      for (const m of readFileSync(f, 'utf8').matchAll(/(?:#|0x)([0-9a-fA-F]{6})\b/g)) {
        const v = m[1] ?? '';
        const [r, g, b] = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16)) as [number, number, number];
        if (isPurple(r, g, b)) found.push(`${f.slice(root.length)}: ${m[0]}`);
      }
    }
    expect(found).toEqual([]);
  });
});
