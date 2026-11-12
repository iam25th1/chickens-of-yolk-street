import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The loading screen in the page itself: the boot atlas is preloaded and a few lines of inline
 * script draw the loading plate at a whole zoom (as the game does), so something is on screen before the bundle
 * has even downloaded. The game's own loading scene replaces it (App removes #boot).
 */
function bootScreen(): Plugin {
  return {
    name: 'coys-boot-screen',
    transformIndexHtml(html) {
      const derived = JSON.parse(readFileSync(new URL('./src/assets/derived.json', import.meta.url), 'utf8')) as {
        atlases: Record<string, { file: string; w: number; h: number }[]>;
        sprites: Record<string, { frames: Record<string, Record<string, number[][]>> }>;
      };
      const atlas = derived.atlases.boot?.[0];
      const plate = derived.sprites['25-loading-plate']?.frames['1']?.plate?.[0];
      if (!atlas || !plate) return html;
      const url = `/assets/derived/${atlas.file}`;
      const [x = 0, y = 0, w = 640, h = 360] = plate;
      const tags = `<link rel="preload" as="image" href="${url}" fetchpriority="high" />
    <style>
      html, body { margin: 0; height: 100%; background: #2a160c; overflow: hidden; }
      #boot { position: fixed; left: 50%; top: 50%; width: ${w}px; height: ${h}px; transform-origin: 50% 50%;
        background: url(${url}) no-repeat ${-x}px ${-y}px / ${atlas.w}px ${atlas.h}px; image-rendering: pixelated; }
      #boot span { position: absolute; left: 0; right: 0; top: 268px; text-align: center; font: bold 10px monospace; color: #f6e7c1; letter-spacing: 1px; }
    </style>`;
      const body = `<div id="boot" aria-hidden="true"><span>WAKING THE HENS</span></div>
    <script>
      (function () { var b = document.getElementById('boot'); var fit = function () { var d = devicePixelRatio || 1, W = innerWidth * d, H = innerHeight * d, z = 1; [8, 6, 4, 3, 2].some(function (s) { if (640 * s <= W && 360 * s <= H) { z = s; return true; } return false; }); b.style.transform = 'translate(-50%, -50%) scale(' + z / d + ')'; }; fit(); addEventListener('resize', fit); })();
    </script>`;
      return html.replace('</head>', `  ${tags}\n  </head>`).replace('<div id="root"></div>', `${body}\n    <div id="root"></div>`);
    },
  };
}

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig(({ mode }) => {
  // One .env at the repo root serves client and server. No variable reaches the bundle: the
  // client asks the server (/api/config) for the public Privy app id at runtime.
  const env = loadEnv(mode, repoRoot, '');
  const serverPort = env.PORT ?? '8787';
  return {
    envDir: repoRoot,
    envPrefix: 'COYS_PUBLIC_',
    plugins: [react(), bootScreen()],
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
