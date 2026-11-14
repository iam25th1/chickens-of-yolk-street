// The Market in a real browser (the built client and the real server, e2e/server.ts; a fresh headless
// browser each time, nothing kept). At five window sizes: the top bar's MARKET and the farm's own sign
// open the page; every tab, and every page of every list on it, fits the window with nothing cut off
// or scrolled; and the Market trades in the test server: posting an order at your own price and
// cancelling it, selling from the crate, filling an AI buyer's order, buying another player's offer
// and buying a hen at auction. Days close only when the check says, so nothing expires or fills on
// its own in the middle of one.
// SCREENSHOTS=1 saves every tab at 1920x1080 and 390x844 to SHOTS_DIR (by default a folder in the
// system's temporary directory, never docs/).
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { overflowing } from './overflow';
import { sizes } from './sizes';
import { startTestServer, type TestServer } from './server';

const TABS = ['prices', 'sell', 'buyers', 'mine', 'trade', 'auction', 'farms'] as const;
const shotsDir = join(process.env.SHOTS_DIR ?? join(tmpdir(), 'coys-market-screenshots'), '/');
let server: TestServer;
let browser: Browser;

beforeAll(async () => {
  server = await startTestServer();
  server.hold(true);
  // ten closed days for the price chart, and an AI cast that has traded and spoken
  await server.closeDays(10);
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined, args: ['--disable-sync', '--no-first-run', '--disable-extensions'] });
  if (process.env.SCREENSHOTS) mkdirSync(shotsDir, { recursive: true });
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

/** The visible one of a part (a paged list also keeps a hidden copy to measure). */
const vis = (page: Page, sel: string) => page.locator(`${sel} >> visible=true`).first();

describe('the Market', () => {
  for (const [w, h, dpr] of sizes([
    [1920, 1080, 1],
    [390, 844, 3],
    [1280, 720, 1],
    [360, 640, 2],
    [768, 1024, 2],
  ] as const)) {
    it(`at ${w}x${h}: the top bar and the farm sign open it, every tab fits with nothing cut off, and its sales, fills and buys work`, async () => {
      const size = `${w}x${h}`;
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, isMobile: w < 600, hasTouch: w < 600 });
      const page = await ctx.newPage();
      const name = `Cleo ${size}`;
      const problems: string[] = [];
      const check = async (what: string) => {
        await page.waitForTimeout(300);
        for (const p of await page.evaluate(overflowing)) problems.push(`${size} ${what}: ${p}`);
      };
      const shot = async (what: string) => {
        if (process.env.SCREENSHOTS && (size === '1920x1080' || size === '390x844')) await page.screenshot({ path: `${shotsDir}market-${what}-${size}.png`, scale: 'css' });
      };
      const tab = async (id: (typeof TABS)[number]) => {
        await page.locator(`[data-tour="market-${id}"]`).click();
        await page.locator(`[data-ui="market-${id}-tab"]`).waitFor();
        await page.waitForTimeout(250);
      };
      const news = () => page.locator('[data-ui="market-news"]').innerText();
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

        // something on every tab: every machine, eggs in the crate, an AI buyer's order, another
        // player's offer and hens at auction
        await server.seed(name, 0);
        // (no AI buyer bids for brown or golden, so offers over today's price rest in the book)
        await server.pullBids(['brown', 'golden']);
        const buyId = await server.buyOrder('white', 4, 1.2);
        await server.auction(3);
        const trader = await server.trader(`Bo Eggs ${size}`, 'brown', 6, 2);
        await server.crate(name, { white: 12, cream: 6, brown: 0, golden: 2 });
        await page.waitForTimeout(1000);

        // the top bar's MARKET opens it on PRICES, with the last ten closed days on the chart
        await page.locator('[data-ui="market-button"]').click();
        const market = page.locator('[data-ui="market-page"]');
        await market.waitFor();
        expect(await market.getAttribute('data-tab')).toBe('prices');
        expect(await page.locator('[data-ui="chart-bars"] [data-day] >> visible=true').count()).toBe(10);
        expect(await page.locator('[data-ui="cast-agent"] >> visible=true').count()).toBeGreaterThan(0);

        // SELL: an order at your own price (well over today's, so no AI buyer takes it at once)
        await tab('sell');
        await vis(page, '[data-ui="post-grade"]:has-text("GOLDEN")').click();
        for (let i = 0; i < 6; i++) await vis(page, '[aria-label="Higher price"]').click();
        const post = vis(page, '[data-ui="post-order"]');
        expect(await post.innerText()).toMatch(/^POST 2 GOLDEN AT \d+\.\d\d$/);
        await post.click();
        await expect.poll(() => vis(page, '[data-ui="sell-golden"]').innerText()).toBe('SELL 0');

        // every tab, and every page of every list on it, fits the window
        for (const id of TABS) {
          await tab(id);
          expect((await page.locator('[data-ui="market-line"]').innerText()).length).toBeGreaterThan(20);
          await check(id);
          await shot(id);
          const pagers = page.locator('[data-ui="market-page"] [data-ui="pager"] >> visible=true');
          const lists = await pagers.count();
          for (let l = 0; l < lists; l++) {
            for (let i = 0; i < 8; i++) {
              const next = pagers.nth(l).locator('[data-ui="page-next"]:not([disabled])');
              if (!(await next.count())) break;
              await next.click();
              await check(`${id} list ${l + 1} page ${i + 2}`);
            }
          }
        }

        // YOUR ORDERS and TRADE show the order; CANCEL puts its eggs back in the crate
        await tab('mine');
        const mine = page.locator('[data-ui="your-order"] >> visible=true');
        expect(await mine.count()).toBe(1);
        expect(await mine.first().innerText()).toMatch(/^YOU SELL 2 GOLDEN AT \d+\.\d\d EACH/);
        await tab('trade');
        expect(await vis(page, '[data-ui="trade-mine"]').innerText()).toMatch(/SELLS 2 GOLDEN AT/);
        await tab('mine');
        await vis(page, '[data-ui="cancel-order"]').click();
        await vis(page, '[data-ui="to-sell"]').waitFor();
        await tab('sell');
        expect(await vis(page, '[data-ui="sell-golden"]').innerText()).toBe('SELL 2');

        // SELL: the cream goes at today's price
        await vis(page, '[data-ui="sell-cream"]').click();
        await expect.poll(() => vis(page, '[data-ui="sell-cream"]').innerText()).toBe('SELL 0');

        // BUY ORDERS: the AI buyer's order fills from the crate in one tap
        await tab('buyers');
        const fill = vis(page, `[data-order="${buyId}"] [data-ui="fill-buy"]`);
        expect(await fill.innerText()).toMatch(/^SELL 4 FOR \d+\.\d\d$/);
        await fill.click();
        await page.locator(`[data-order="${buyId}"]`).first().waitFor({ state: 'detached' });
        await expect.poll(news).toMatch(/^SOLD 4 TO /);
        await tab('sell');
        expect(await vis(page, '[data-ui="sell-white"]').innerText()).toBe('SELL 8');

        // TRADE: the other player's offer comes into the crate
        await tab('trade');
        const offer = vis(page, `[data-order="${trader.orderId}"]`);
        expect(await offer.innerText()).toContain(`${trader.name.toUpperCase()} SELLS 6 BROWN AT`);
        const buy = offer.locator('[data-ui="buy-offer"]');
        const bought = Number((await buy.innerText()).match(/^BUY (\d+) FOR/)?.[1]);
        expect(bought).toBeGreaterThan(0);
        await buy.click();
        await expect.poll(news).toMatch(new RegExp(`^BOUGHT ${bought} FROM ${trader.name.toUpperCase()}`));
        await tab('sell');
        expect(await vis(page, '[data-ui="sell-brown"]').innerText()).toBe(`SELL ${bought}`);

        // HEN AUCTION: a bust farm's hen comes to the farm
        await tab('auction');
        const taken = async () => Number((await vis(page, '[data-ui="auction-head"] h3').innerText()).match(/YOUR COOPS: (\d+) OF/)?.[1]);
        const before = await taken();
        expect(await page.locator('[data-ui="auction-hen"] >> visible=true').count()).toBeGreaterThan(0);
        await vis(page, '[data-ui="auction-buy"]:not([disabled])').click();
        await expect.poll(taken).toBe(before + 1);

        // FARMS: a farm in the ranking opens its public profile, and closing it comes back to the farms
        await tab('farms');
        const row = page.locator('[data-ui="ranking-row"] >> visible=true').first();
        const farmId = await row.getAttribute('data-farm');
        expect(farmId).toBeTruthy();
        await row.click();
        await page.locator('[data-ui="public-profile"][data-loaded="1"]').waitFor({ timeout: 10_000 });
        expect(await page.locator('[data-ui="public-profile"]').getAttribute('data-farm')).toBe(farmId);
        await check('a public profile from the farms');
        await shot('public-profile');
        await page.keyboard.press('Escape');
        await page.locator('[data-ui="market-farms-tab"]').waitFor({ timeout: 5000 });

        // BACK TO THE FARM, and the farm's own sign opens it again
        await page.locator('[data-ui="market-close"]').click();
        await market.waitFor({ state: 'detached' });
        await page.waitForTimeout(500);
        const sign = (
          await page.evaluate(() => (window as unknown as { __coysFarm?: { targets(): { kind: string; x: number; y: number; w: number; h: number }[] } }).__coysFarm?.targets() ?? [])
        ).find((t) => t.kind === 'sign');
        expect(sign).toBeDefined();
        if (!sign) return;
        // (the farm's targets are in CSS pixels)
        await page.mouse.click(sign.x + sign.w / 2, sign.y + sign.h / 2);
        await market.waitFor({ timeout: 5000 });
        expect(await market.getAttribute('data-tab')).toBe('prices');
        await check('opened from the sign');
        expect(problems).toEqual([]);
      } finally {
        await ctx.close();
      }
    }, 600_000);
  }
});
