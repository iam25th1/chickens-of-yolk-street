// Writes .br and .gz next to every compressible file in the client build, so the server can send
// them as is (no compression on the request path). Run by npm run build after the client build.
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../apps/client/dist', import.meta.url));
const TYPES = new Set(['.js', '.css', '.json', '.html', '.svg', '.txt', '.map']);
let files = 0;
let before = 0;
let after = 0;
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (TYPES.has(extname(p)) && statSync(p).size >= 1024) {
      const raw = readFileSync(p);
      const br = brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: raw.length } });
      writeFileSync(`${p}.br`, br);
      writeFileSync(`${p}.gz`, gzipSync(raw, { level: 9 }));
      files++;
      before += raw.length;
      after += br.length;
    }
  }
};
walk(dist);
console.log(`compress-dist: ${files} files, ${(before / 1024).toFixed(0)} KB to ${(after / 1024).toFixed(0)} KB brotli`);
