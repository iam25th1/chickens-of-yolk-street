// The top bar with long numbers: a rich farm (coins in the tens of thousands, a full crate) still fits
// its bar at every checked window size, nothing is cut off, the page itself cannot scroll (a page a
// few pixels taller than the window gets scrolled when a click brings a button into view), and no
// part of the bar is squeezed: on the full one-row bar the words COLLECT, SELL and DAY step aside
// when the numbers need their room (and show again when they do not), so day 1000 fits too. On the
// two-row bar (a phone, a tablet held upright) nothing ever wraps to a third row, even on day 10000:
// the words COLLECT and SELL step aside instead, the day, the coins and the clock stay in view, and a
// tap on a number shows its label inside the window. The UI layer itself can never be scrolled (a
// scrolled layer slid the whole UI sideways on a phone).
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

/** Every part of the bar inside the bar (a part on a third row pokes out of its top and bottom). */
const outsideBar = (): string[] => {
  const bar = document.querySelector('[data-ui="topbar"]');
  if (!bar) return ['no top bar'];
  const b = bar.getBoundingClientRect();
  return [...bar.children]
    .filter((c) => {
      const r = c.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && (r.top < b.top - 1 || r.bottom > b.bottom + 1 || r.left < b.left - 1 || r.right > b.right + 1);
    })
    .map((c) => (c as HTMLElement).title || (c as HTMLElement).dataset.ui || c.tagName);
};

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
        await page.locator('[data-ui="title-sign-in"]').click({ force: true });
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
        expect(await page.evaluate(outsideBar), `${w}x${h} rich: outside the bar`).toEqual([]);
        // a long season: four and five-digit days, with the rich farm's numbers
        const twoRows = await page.evaluate(() => !document.querySelector('[data-ui="topbar"]')?.classList.contains('one-row'));
        for (const day of [1052, 10000]) {
          server.day(day);
          await expect.poll(() => page.locator(`[data-ui="topbar"] [aria-label="${day}"]`).count(), { message: `${w}x${h}: day ${day} on the flaps` }).toBe(1);
          await page.waitForTimeout(600);
          expect(await page.evaluate(overflowing), `${w}x${h} day ${day}`).toEqual([]);
          expect(await page.evaluate(outsideBar), `${w}x${h} day ${day}: outside the bar`).toEqual([]);
          // on two rows the word DAY stays, next to the day and the clock
          if (twoRows) expect(await page.locator('[data-ui="topbar"] .day-label >> visible=true').count(), `${w}x${h} day ${day}: the word DAY`).toBe(1);
        }
        server.day(1);
        // the UI layer is clipped, never scrolled
        expect(
          await page.evaluate(() => {
            const ui = document.querySelector<HTMLElement>('.ui');
            if (!ui) return 'no ui';
            ui.scrollLeft = 200;
            ui.scrollTop = 200;
            return `${ui.scrollLeft},${ui.scrollTop}`;
          }),
          `${w}x${h}: the UI layer scrolled`,
        ).toBe('0,0');
        // on a touch screen a tap on a number shows its label, inside the window
        if (w < 600) {
          for (const stat of await page.locator('[data-ui="topbar"] .stat').all()) {
            await stat.tap();
            const tip = await stat.evaluate((el) => {
              const after = getComputedStyle(el, '::after');
              const zoom = Number(document.querySelector<HTMLElement>('.ui')?.dataset.p ?? 1) / devicePixelRatio;
              const r = el.getBoundingClientRect();
              const width = parseFloat(after.width) * zoom;
              // (a positioned box's left is read back in pixels, from the stat's own left edge)
              const left = r.left + parseFloat(after.left) * zoom;
              return { content: after.content, left: Math.round(left), right: Math.round(left + width), title: (el as HTMLElement).title };
            });
            expect(tip.content, `${w}x${h}: ${tip.title}: a label on tap`).not.toBe('none');
            expect(tip.left >= 0 && tip.right <= w, `${w}x${h}: ${tip.title}: its label (${tip.left} to ${tip.right}) inside the window`).toBe(true);
          }
        }
      } finally {
        await ctx.close();
      }
    }, 180_000);
  }
});
