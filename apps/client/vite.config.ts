import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig(({ mode }) => {
  // One .env at the repo root serves client and server. Only the public Privy app id
  // reaches the bundle; every other variable stays on the server.
  const env = loadEnv(mode, repoRoot, '');
  const serverPort = env.PORT ?? '8787';
  return {
    envDir: repoRoot,
    plugins: [react()],
    define: {
      __PRIVY_APP_ID__: JSON.stringify(env.PRIVY_APP_ID ?? ''),
    },
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
      assetsInlineLimit: 0,
      chunkSizeWarningLimit: 4096,
    },
  };
});
