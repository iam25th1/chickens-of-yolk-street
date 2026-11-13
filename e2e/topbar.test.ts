// The top bar with long numbers: a rich farm (coins in the tens of thousands, a full crate) still fits
// its bar at every checked window size, nothing is cut off, the page itself cannot scroll (a page a
// few pixels taller than the window gets scrolled when a click brings a button into view), and no
// part of the bar is squeezed: on the full one-row bar the words COLLECT, SELL and DAY step aside
// when the numbers need their room (and show again when they do not), so day 1000 fits too.
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { overflowing } from './overflow';
import { sizes } from './sizes';
import { startTestServer, type TestServer } from './server';

const SIZES: [number, number, number][] = [
  [1280, 720, 1],
  [1920, 1080, 1],
  [390, 844, 3],
  [360, 640, 2],
  [412, 915, 2],
  [768, 1024, 2],
  [1024, 640, 1],
];
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

describe('the top bar with long numbers', () => {
  for (const [w, h, dpr] of sizes(SIZES)) {
    it(`at ${w}x${h}: fits, nothing cut off, the page cannot scroll`, async () => {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, isMobile: w < 600, hasTouch: w < 600 });
      const page = await ctx.newPage();
      const name = `Rich ${w}x${h}`;
      try {
        await page.goto(`${server.url}/`);
        await page.getByText('PLAY', { exact: true }).waitFor({ timeout: 60_000 });
        await page.waitForTimeout(800);
        await page.getByText('PLAY', { exact: true }).click({ force: true });
        const field = page.getByPlaceholder('FARMER NAME');
        await field.waitFor({ timeout: 15_000 });
        await field.fill(name);
        await field.press('Enter');
        await page.locator('[data-ui="topbar"]').waitFor({ timeout: 60_000 });
        await page.evaluate(() => (window as unknown as { __coysTour?: { end(): void } }).__coysTour?.end());
        await page.waitForTimeout(800);
        // ordinary numbers: the words are there
        expect(await page.locator('[data-ui="topbar"] .stat-label:not(.day-label) >> visible=true').count(), `${w}x${h}: COLLECT and SELL with room`).toBe(2);
        await server.cash(name, 999.99);
        await server.crate(name, { white: 400, cream: 300, brown: 250, golden: 49 });
        await page.waitForTimeout(1200);
        const dims = await page.evaluate(() => {
          const s = document.scrollingElement ?? document.documentElement;
          const bar = document.querySelector('[data-ui="topbar"]')?.getBoundingClientRect();
          return { sh: s.scrollHeight, sw: s.scrollWidth, ih: innerHeight, iw: innerWidth, barTop: bar?.top ?? -1, barBottom: bar?.bottom ?? -1 };
        });
        expect(dims.sh, `${w}x${h}: page height`).toBeLessThanOrEqual(dims.ih);
        expect(dims.sw, `${w}x${h}: page width`).toBeLessThanOrEqual(dims.iw);
        expect(await page.evaluate(overflowing), `${w}x${h}`).toEqual([]);
        const squeezed = await page.evaluate(() =>
          [...(document.querySelector('[data-ui="topbar"]')?.children ?? [])]
            .filter((c) => c.scrollWidth > c.clientWidth + 1)
            .map((c) => (c as HTMLElement).title || (c as HTMLElement).dataset.ui || c.tagName),
        );
        expect(squeezed, `${w}x${h}: squeezed parts of the bar`).toEqual([]);
        // a rich farm: still nothing squeezed or cut off
        await server.cash(name, 12345.67);
        await page.waitForTimeout(1200);
        expect(await page.evaluate(overflowing), `${w}x${h} rich`).toEqual([]);
        if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/topbar-rich-${w}x${h}.png`, clip: { x: 0, y: 0, width: w, height: Math.min(h, 90) } });
        expect(await page.evaluate(() => [...(document.querySelector('[data-ui="topbar"]')?.children ?? [])].filter((c) => c.scrollWidth > c.clientWidth + 1).length), `${w}x${h} rich: squeezed`).toBe(
          0,
        );
      } finally {
        await ctx.close();
      }
    }, 180_000);
  }
});
