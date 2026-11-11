import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig(({ mode }) => {
  // One .env at the repo root serves client and server. No variable reaches the bundle: the
  // client asks the server (/api/config) for the public Privy app id at runtime.
  const env = loadEnv(mode, repoRoot, '');
  const serverPort = env.PORT ?? '8787';
  return {
    envDir: repoRoot,
    envPrefix: 'COYS_PUBLIC_',
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': `http://localhost:${serverPort}`,
        '/ws': { target: `ws://localhost:${serverPort}`, ws: true },
      },
    },
    build: {
      target: 'es2022',
      // public/assets holds the packed game assets; Vite's own chunks go elsewhere
      assetsDir: 'build',
      assetsInlineLimit: 0,
      chunkSizeWarningLimit: 4096,
    },
  };
});
