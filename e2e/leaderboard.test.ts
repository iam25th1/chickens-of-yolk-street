// The Market's LEADERBOARD tab in a real browser (the built client and the real server, e2e/server.ts;
// a fresh headless browser each time, nothing kept). The test server's clock is before the league's
// first season, so the week on the board is the warm-up week: the AI cast and the new farm are on it.
// The tab shows the rows and a countdown, toggles to SEASON and back, PLAYERS ONLY keeps only player
// farms, your own row is pinned at the foot, and nothing is cut off or scrolls.
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { overflowing } from './overflow';
import { sizes } from './sizes';
import { startTestServer, type TestServer } from './server';

let server: TestServer;
let browser: Browser;

beforeAll(async () => {
  server = await startTestServer();
  server.hold(true);
  // a couple of closed days, so the AI cast has traded and the ranks have a yesterday
  await server.closeDays(2);
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined, args: ['--disable-sync', '--no-first-run', '--disable-extensions'] });
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

/** The visible ones of a part (a paged list also keeps a hidden copy to measure). */
const visAll = (page: Page, sel: string) => page.locator(`${sel} >> visible=true`);

describe('the leaderboard', () => {
  for (const [w, h, dpr] of sizes([
    [1920, 1080, 1],
    [390, 844, 3],
    [1280, 720, 1],
    [360, 640, 2],
    [768, 1024, 2],
  ] as const)) {
    it(`at ${w}x${h}: rows, the countdown, both boards, the players filter and your pinned row, with nothing cut off`, async () => {
      const size = `${w}x${h}`;
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, isMobile: w < 600, hasTouch: w < 600 });
      const page = await ctx.newPage();
      const name = `Lea ${size}`;
      const problems: string[] = [];
      const check = async (what: string) => {
        await page.waitForTimeout(300);
        for (const p of await page.evaluate(overflowing)) problems.push(`${size} ${what}: ${p}`);
      };
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

        await page.locator('[data-ui="market-button"]').click();
        await page.locator('[data-ui="market-page"]').waitFor();
        await page.locator('[data-tour="market-leaderboard"]').click();
        await page.locator('[data-ui="market-leaderboard-tab"]').waitFor();

        // the weekly board: rows (the AI cast and the new farm), a countdown, and your row at the foot
        const rows = visAll(page, '[data-ui="leaderboard-row"]');
        await expect.poll(() => rows.count(), { timeout: 15_000 }).toBeGreaterThan(1);
        const countdown = page.locator('[data-ui="leaderboard-countdown"]');
        await expect.poll(() => countdown.innerText()).toMatch(/WEEK ENDS IN \d+[DHM]/);
        expect(await countdown.innerText()).toMatch(/SEASON( 1)? (STARTS|ENDS) IN \d+[DHM]/);
        const you = page.locator('[data-ui="leaderboard-you"]');
        await you.waitFor();
        expect(await you.isVisible()).toBe(true);
        expect(await you.innerText()).toMatch(/SELL ABOUT \d+ MORE EGGS? TO PASS |YOU LEAD THE BOARD|YOUR FARM JOINS THE BOARD/);
        expect(await page.locator('[data-ui="leaderboard-you-row"]').innerText()).toContain(name.toUpperCase());
        await check('the weekly board');

        // SEASON, and back to WEEKLY
        await page.locator('[data-ui="leaderboard-board-season"]').click();
        await expect.poll(() => page.locator('[data-ui="leaderboard-board-season"]').getAttribute('aria-pressed')).toBe('true');
        await expect.poll(() => countdown.innerText()).toMatch(/SEASON( \d+)? (STARTS|ENDS) IN/);
        await check('the season board');
        await page.locator('[data-ui="leaderboard-board-week"]').click();
        await expect.poll(() => rows.count(), { timeout: 15_000 }).toBeGreaterThan(1);

        // PLAYERS ONLY: only player farms (yours among them); ALL brings the AI farms back
        const before = await rows.count();
        await page.locator('[data-ui="leaderboard-filter-players"]').click();
        await expect.poll(async () => (await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-kind')))).every((k) => k === 'player')).toBe(true);
        expect(await rows.count()).toBeGreaterThan(0);
        await check('players only');
        await page.locator('[data-ui="leaderboard-filter-all"]').click();
        await expect.poll(() => rows.count()).toBe(before);
        expect(problems).toEqual([]);
      } finally {
        await ctx.close();
      }
    }, 600_000);
  }
});
