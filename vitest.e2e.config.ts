import { defineConfig } from 'vitest/config';

// The browser checks (e2e/): the real server and the built client in a headless browser. Run after a build.
export default defineConfig({
  test: {
    include: ['e2e/**/*.test.ts'],
    environment: 'node',
    testTimeout: 1_200_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
