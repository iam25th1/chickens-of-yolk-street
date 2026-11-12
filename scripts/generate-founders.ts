// npm run generate-founders: writes the 777 Founding Hens to apps/server/data/founders.json (server
// side only: it never enters the client bundle) and its SHA-256 to founders.json.sha256. Only the
// hash is public: the contract stores it once (commit_provenance) before the first Feather mints.
// Seeded, so `--check` regenerates and confirms the committed file is exactly what the seed makes.
//
//   npx tsx scripts/generate-founders.ts [--seed <text>] [--check]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { foundersJson, generateFounders, sha256Hex } from './lib/founders';

export const DEFAULT_SEED = 'coys-founders-2026-11-12';

const { values } = parseArgs({ options: { seed: { type: 'string', default: DEFAULT_SEED }, check: { type: 'boolean', default: false } } });
const dir = fileURLToPath(new URL('../apps/server/data/', import.meta.url));
const file = `${dir}founders.json`;
const text = foundersJson(generateFounders(values.seed ?? DEFAULT_SEED));
const sha = sha256Hex(text);
if (values.check) {
  if (!existsSync(file) || readFileSync(file, 'utf8') !== text) {
    console.error('founders.json does not match what its seed makes');
    process.exit(1);
  }
  console.log(`founders.json matches seed ${values.seed}: sha256 ${sha}`);
} else {
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, text);
  writeFileSync(`${file}.sha256`, `${sha}  founders.json\n`);
  console.log(`wrote ${file} (${text.length} bytes): sha256 ${sha}`);
}
