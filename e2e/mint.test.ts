// The Feather Mint in a real browser (the built client and the real server, whose mints are a
// stand-in that answers like NEAR after a short wait; a fresh headless browser each time, nothing
// kept). /mint opens straight away without signing in, with its parts in order and nothing cut off
// or scrolled at four window sizes; the title's MINT opens it too. Signed in, MINT plays the minting
// moment: the press, the card out face down, SENT TO NEAR, then CONFIRMED and the flip. When the
// mint fails the ticket and the coins come back, and RETRY mints it.
// SCREENSHOTS=1 saves the mint and the moment at 1920x1080 and 390x844 to docs/screenshots.
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { overflowing } from './overflow';
import { startTestServer, type TestServer } from './server';

const shotsDir = process.env.SHOTS_DIR ?? fileURLToPath(new URL('../docs/screenshots/', import.meta.url));
const HERO = 'EARN TICKETS ON YOUR FARM. MINT A FEATHER. EACH FEATHER IS PLANNED TO HATCH INTO ONE OF 777 FOUNDING HENS AT MAINNET LAUNCH.';
const ORDER = ['mint-hero', 'mint-tickets', 'mint-supply', 'mint-odds', 'mint-recent', 'mint-all', 'mint-provenance'];
let server: TestServer;
let browser: Browser;

beforeAll(async () => {
  server = await startTestServer();
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined, args: ['--disable-sync', '--no-first-run', '--disable-extensions'] });
  if (process.env.SCREENSHOTS) mkdirSync(shotsDir, { recursive: true });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const shot = async (page: Page, name: string, size: string) => {
  if (process.env.SCREENSHOTS && (size === '1920x1080' || size === '390x844')) await page.screenshot({ path: `${shotsDir}${name}-${size}.png`, scale: 'css' });
};

/**
 * The parts in document order, each where it first appears (a paged list draws its current page and
 * then, hidden, every item in order to measure them, so first appearances follow the items' order).
 */
async function partsInOrder(page: Page): Promise<string[]> {
  return page.evaluate((ids) => {
    const seen: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('[data-ui]')) {
      const id = el.dataset.ui ?? '';
      if (ids.includes(id) && !seen.includes(id)) seen.push(id);
    }
    return seen;
  }, ORDER);
}

/** The visible one of a part (a paged list also keeps a hidden copy to measure). */
const vis = (page: Page, sel: string) => page.locator(`${sel} >> visible=true`).first();

describe('the Feather Mint', () => {
  for (const [w, h, dpr] of [
    [1920, 1080, 1],
    [390, 844, 3],
    [1280, 720, 1],
    [360, 640, 2],
  ] as const) {
    it(`/mint opens without signing in at ${w}x${h}: every part in order, nothing cut off`, async () => {
      const size = `${w}x${h}`;
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, isMobile: w < 600, hasTouch: w < 600 });
      const page = await ctx.newPage();
      try {
        await page.goto(`${server.url}/mint`);
        await page.locator('[data-ui="mint-page"]').waitFor({ timeout: 60_000 });
        await vis(page, '[data-ui="mint-left"]').waitFor({ timeout: 15_000 });
        await page.waitForTimeout(800);
        expect(await page.locator('[data-ui="mint-hero"]').innerText()).toBe(HERO);
        expect(await page.locator('h2', { hasText: 'FEATHER MINT' }).count()).toBe(1);
        expect(await vis(page, '[data-ui="mint-sign-in"]').count()).toBe(1);
        expect(await page.locator('[data-ui="mint-left"]').first().innerText()).toMatch(/^\d+ LEFT OF 777$/);
        expect(await page.locator('[data-ui="mint-grid"] [data-slot]').count()).toBeGreaterThan(3);
        expect(await page.locator('[data-ui="mint-provenance"]').innerText()).toContain('FOUNDERS PROVENANCE (SHA-256)');
        expect(await page.evaluate(overflowing)).toEqual([]);
        await shot(page, 'mint-open', size);
        // the parts come in the brief's order, and every page of the info column fits
        expect(await partsInOrder(page)).toEqual(ORDER);
        for (let i = 0; i < 5; i++) {
          const next = page.locator('[data-ui="mint-info"] [data-ui="page-next"]:not([disabled])').first();
          if (!(await next.count())) break;
          await next.click();
          await page.waitForTimeout(250);
          expect(await page.evaluate(overflowing)).toEqual([]);
        }
        // the grid pages and filters
        await page.locator('[data-ui="mint-grid"] [data-ui="page-next"]').first().click();
        expect(await page.evaluate(overflowing)).toEqual([]);
        await page.locator('[data-ui="mint-filters"] button', { hasText: 'MINTED' }).first().click();
        expect(await page.evaluate(overflowing)).toEqual([]);
        // TITLE leaves for the title, whose MINT comes back here
        await page.locator('[data-ui="mint-close"]').click();
        await page.locator('[data-ui="title-mint"]').waitFor({ timeout: 15_000 });
        expect(new URL(page.url()).pathname).toBe('/');
        await page.waitForTimeout(800);
        await page.locator('[data-ui="title-mint"]').click({ force: true });
        await page.locator('[data-ui="mint-page"]').waitFor({ timeout: 15_000 });
        expect(new URL(page.url()).pathname).toBe('/mint');
      } finally {
        await ctx.close();
      }
    }, 300_000);
  }

  for (const [w, h, dpr] of [
    [1920, 1080, 1],
    [390, 844, 3],
  ] as const) {
    it(`at ${w}x${h}, MINT plays the minting moment to a confirmed Feather; a failed mint gives the ticket and coins back, and RETRY mints it`, async () => {
      const size = `${w}x${h}`;
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, isMobile: w < 600, hasTouch: w < 600 });
      const page = await ctx.newPage();
      const name = `Mint Check ${size}`;
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
        await server.seed(name, 2);
        await server.wallet(name, 'mint-check.testnet');
        await page.evaluate(() => (window as unknown as { __coysTour?: { end(): void } }).__coysTour?.end());
        await server.closeDays(1);
        await page.waitForTimeout(1500);

        // the top bar's MINT opens the Feather Mint over the farm
        await page.locator('[data-ui="feathers-button"]').click();
        await page.locator('[data-ui="mint-page"]').waitFor();
        await vis(page, '[data-ui="mint-button"]:not([disabled])').waitFor({ timeout: 15_000 });
        // (a day close may have won one more at a milestone)
        const before = Number((await vis(page, '[data-ui="mint-held"]').innerText()).match(/^(\d+) TICKETS? TO MINT\./)?.[1]);
        expect(before).toBeGreaterThanOrEqual(2);
        await shot(page, 'mint-farm', size);

        // a mint that NEAR refuses: the ticket and the coins come back, RETRY mints it
        server.failMints(1);
        await vis(page, '[data-ui="mint-button"]').click();
        await page.locator('[data-ui="mint-moment"]').waitFor();
        await page.locator('[data-ui="mint-failed"]').waitFor({ timeout: 20_000 });
        expect(await page.locator('[data-ui="mint-failed"]').innerText()).toMatch(/YOUR TICKET IS SAFE AND YOUR 25 COINS ARE BACK/);
        await shot(page, 'mint-failed', size);
        await page.locator('[data-ui="mint-retry"]').click();

        // the moment: press, card out face down, sent, confirmed, flip and stamp
        await page.locator('[data-ui="mint-moment"][data-chain="redeeming"], [data-ui="mint-moment"][data-chain="sent"]').first().waitFor({ timeout: 10_000 });
        await page.locator('[data-ui="mint-stage-sent"][data-lit="1"]').waitFor({ timeout: 15_000 });
        await shot(page, 'mint-moment-sent', size);
        await page.locator('[data-ui="mint-moment"][data-face="stamped"]').waitFor({ timeout: 20_000 });
        expect(await page.locator('[data-ui="mint-stage-confirmed"]').getAttribute('data-lit')).toBe('1');
        const result = await page.locator('[data-ui="mint-result"]').innerText();
        expect(result).toMatch(/^FEATHER #\d{3} OF 777: (FLUFF|PLUME|QUILL|GOLDEN QUILL)$/);
        expect(await page.locator('[data-ui="mint-receipt"]').getAttribute('href')).toMatch(/^https:\/\/testnet\.nearblocks\.io\/txns\/browser-check-\d{3}$/);
        expect(await page.evaluate(overflowing)).toEqual([]);
        await shot(page, 'mint-moment-confirmed', size);

        // back on the mint: one ticket left, the Feather is the player's
        await page.locator('[data-ui="mint-moment-close"]').click();
        await page.locator('[data-ui="mint-page"]').waitFor();
        await page.waitForTimeout(600);
        expect(await vis(page, '[data-ui="mint-held"]').innerText()).toMatch(new RegExp(`^${before - 1} TICKETS? TO MINT\\.`));
        const number = result.match(/#(\d{3})/)?.[1];
        expect(await vis(page, '[data-ui="mint-tickets"]').innerText()).toContain(`YOU HAVE MINTED 1 FEATHER: #${number}`);
        await page.locator('[data-ui="mint-filters"] button', { hasText: 'MINE' }).first().click();
        await page.waitForTimeout(400);
        expect(await page.locator('[data-ui="mint-grid"] [data-slot]').evaluateAll((els) => els.map((e) => e.getAttribute('data-slot')))).toEqual([String(Number(number))]);
      } finally {
        await ctx.close();
      }
    }, 300_000);
  }
});
