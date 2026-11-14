// Warnings on the farm: no full-width bar over the farm any more. A warning about something on the farm
// is a small "!" bubble over it (here the crate, filled past 30 eggs); a tap opens its card, the bubble
// hides while the card is up and is gone once the cause is fixed (the crate sold). The bubble keeps clear
// of the top bar and the toast corner. The built client and the real server, in a fresh headless
// browser with nothing kept.
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sizes } from './sizes';
import { startTestServer, type TestServer } from './server';

let server: TestServer;
let browser: Browser;

beforeAll(async () => {
  server = await startTestServer();
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined, args: ['--disable-sync', '--no-first-run', '--disable-extensions'] });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

describe('warnings on the farm', () => {
  for (const [w, h, dpr] of sizes([
    [1280, 720, 1],
    [1920, 1080, 1],
    [390, 844, 3],
    [360, 640, 2],
    [768, 1024, 2],
  ] as const)) {
    it(`at ${w}x${h}: a full crate shows a bubble over the crate, not a bar; a tap opens the crate's card, and selling clears it`, async () => {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, isMobile: w < 600, hasTouch: w < 600 });
      const page = await ctx.newPage();
      const name = `Warn ${w}x${h}`;
      try {
        server.hold(true);
        await page.goto(`${server.url}/`);
        await page.locator('[data-ui="title-sign-in"]').waitFor({ timeout: 60_000 });
        await page.waitForTimeout(800);
        await page.locator('[data-ui="title-sign-in"]').click({ force: true });
        await page.getByPlaceholder('FARMER NAME').fill(name);
        await page.getByPlaceholder('FARMER NAME').press('Enter');
        await page.locator('[data-ui="topbar"]').waitFor({ timeout: 60_000 });
        await page.evaluate(() => (window as unknown as { __coysTour?: { end(): void } }).__coysTour?.end());
        await page.waitForTimeout(600);
        await server.crate(name, { white: 35 });
        const bubble = page.locator('[data-ui="warn-bubble"][data-warn="crate"]');
        await bubble.waitFor({ timeout: 10_000 });
        // no bar across the farm
        expect(await page.locator('.hint').count()).toBe(0);
        // over the crate, clear of the top bar and the toast corner
        const box = await bubble.boundingBox();
        const crate = await page.evaluate(() => (window as unknown as { __coysFarm: { targets(): { kind: string; x: number; y: number; w: number; h: number }[] } }).__coysFarm.targets().find((t) => t.kind === 'crate'));
        expect(box && crate).toBeTruthy();
        if (box && crate) {
          expect(Math.abs(box.x + box.width / 2 - (crate.x + crate.w / 2))).toBeLessThan(12);
          // (the crate pops as eggs land, so its box moves a little between looks)
          expect(box.y).toBeLessThan(crate.y + crate.h / 2);
          for (const sel of ['[data-ui="topbar"]', '[data-ui="toasts"]']) {
            const z = await page.locator(sel).boundingBox();
            if (z) expect(box.x < z.x + z.width && z.x < box.x + box.width && box.y < z.y + z.height && z.y < box.y + box.height, `${sel} overlaps the bubble`).toBe(false);
          }
        }
        // a tap opens the crate's card; the bubble hides while it is up
        await bubble.click({ force: true });
        const sell = page.locator('[data-tour="sell-modal"]:not([disabled])');
        await sell.waitFor({ timeout: 10_000 });
        expect(await page.locator('[data-ui="warn-bubble"]').count()).toBe(0);
        await sell.click();
        await page.waitForTimeout(800);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(800);
        expect(await page.locator('[data-ui="warn-bubble"][data-warn="crate"]').count()).toBe(0);
      } finally {
        server.hold(false);
        await ctx.close();
      }
    }, 300_000);
  }
});
