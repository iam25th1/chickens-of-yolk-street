// npm run pack-assets: packs the coys-assets clone at ASSETS_DIR into apps/client/public/assets.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { packAssets } from './lib/pack';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
if (existsSync(`${repoRoot}.env`)) process.loadEnvFile(`${repoRoot}.env`);

const assetsDir = process.env.ASSETS_DIR;
if (!assetsDir) {
  console.error('ASSETS_DIR is not set. Point it at a clone of iam25th1/coys-assets (see .env.example).');
  process.exit(1);
}

const outDir = fileURLToPath(new URL('../apps/client/public/assets', import.meta.url));
const result = packAssets({ assetsDir, outDir, log: (line) => console.log(line) });
console.log(
  `done: ${result.spritesPacked} sprites, ${result.soundsPacked} sounds, ` +
    `${(result.bytesCopied / 1048576).toFixed(1)} MB copied byte for byte, source commit ${result.index.source.commit ?? 'unknown'}`,
);
