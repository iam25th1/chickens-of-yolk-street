// Bundles the server into dist/main.js. Workspace code (@coys/shared) is bundled in;
// npm dependencies stay external so PGlite can find its WASM files at runtime.
// The build's version and commit are baked in for /healthz.
import { execSync } from 'node:child_process';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const root = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies).filter((name) => !name.startsWith('@coys/'));

// hosts expose the commit they build (Render: RENDER_GIT_COMMIT); otherwise ask git
let commit = process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || null;
if (!commit) {
  try {
    commit = execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    commit = null;
  }
}

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  external,
  define: { __COYS_BUILD__: JSON.stringify({ version: root.version, commit: commit ? commit.slice(0, 12) : null }) },
  logLevel: 'info',
});
