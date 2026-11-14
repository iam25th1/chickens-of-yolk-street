// The profile in a real browser (the built client and the real server, a fresh headless browser each
// time, nothing kept), at 1920x1080, 390x844, 1280x720 and 360x640: PROFILE in the top bar opens the
// player's profile; every tab, and every page of every tab, fits the window with nothing scrolled or
// cut off; a badge is picked in the badges tab; PUBLIC VIEW opens the farm's public profile, and a farm
// on the street opens its own (an AI farm's too); the farm's name in Settings opens the profile; and
// badges earned while playing pop in one at a time (the unlock moment), queued, never overlapping.
// SCREENSHOTS=1 saves every tab, the public profile and the moment at 1920x1080 and 390x844 to
// SHOTS_DIR (default .data/screenshots/profile/, which git ignores).
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { overflowing } from './overflow';
import { sizes } from './sizes';
import { startTestServer, type TestServer } from './server';

const shotsDir = `${resolve(process.env.SHOTS_DIR ?? fileURLToPath(new URL('../.data/screenshots/profile/', import.meta.url)))}/`;
const TABS = ['overview', 'eggs', 'money', 'flock', 'machines', 'market', 'mint', 'badges'];
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

/** The visible one of a part (a paged list also keeps a hidden copy to measure). */
const vis = (page: Page, sel: string) => page.locator(`${sel} >> visible=true`).first();

/** Opens the game and signs in with the local dev login under a typed name (no naming screen). */
async function enter(page: Page, name: string): Promise<void> {
  await page.goto(`${server.url}/`);
  await page.getByText('PLAY', { exact: true }).waitFor({ timeout: 60_000 });
  await page.waitForTimeout(800);
  await page.getByText('PLAY', { exact: true }).click({ force: true });
  const field = page.getByPlaceholder('FARMER NAME');
  await field.waitFor({ timeout: 15_000 });
  await field.fill(name);
  await field.press('Enter');
  await page.locator('[data-ui="topbar"]').waitFor({ timeout: 60_000 });
}

/** Waits out every badge moment still queued (badges the day closes earned): they show one at a time, never more. */
async function drainMoments(page: Page): Promise<void> {
  for (let i = 0; i < 240; i++) {
    await page.waitForTimeout(250);
    const n = await page.locator('[data-ui="badge-moment"]').count();
    expect(n).toBeLessThanOrEqual(1);
    if (n === 0) {
      await page.waitForTimeout(600);
      if (!(await page.locator('[data-ui="badge-moment"]').count())) return;
    }
  }
}

describe('the profile', () => {
  for (const [w, h, dpr] of sizes([
    [1920, 1080, 1],
    [390, 844, 3],
    [1280, 720, 1],
    [360, 640, 2],
    [768, 1024, 2],
  ] as const)) {
    it(`at ${w}x${h}: every tab and page fits, the public profiles open, and badge moments queue`, async () => {
      const size = `${w}x${h}`;
      const name = `Profile ${size}`;
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, isMobile: w < 600, hasTouch: w < 600 });
      const page = await ctx.newPage();
      const problems: string[] = [];
      const check = async (what: string) => {
        await page.waitForTimeout(300);
        for (const p of await page.evaluate(overflowing)) problems.push(`${size} ${what}: ${p}`);
      };
      try {
        await enter(page, name);
        await page.evaluate(() => (window as unknown as { __coysTour?: { end(): void } }).__coysTour?.end());
        await server.seed(name, 3);
        await server.closeDays(4);
        await page.waitForTimeout(1500);
        await drainMoments(page);

        // PROFILE in the top bar opens the page on its overview, once its data is in
        await page.locator('[data-ui="profile-button"]').click();
        await page.locator('[data-ui="profile-page"]').waitFor();
        await page.locator('[data-ui="profile-loading"]').waitFor({ state: 'detached', timeout: 15_000 });
        expect(await page.locator('[data-ui="profile-name"]').innerText()).toBe(name.toUpperCase());
        expect(await vis(page, '[data-ui="profile-rank"]').innerText()).toMatch(/RANK ON THE STREET\s+\d+ OF \d+/);

        // every tab, and every page of it
        for (const tab of TABS) {
          await page.locator(`[data-tour="profile-${tab}"]`).click();
          await page.locator(`[data-ui="profile-tab-${tab}"]`).waitFor();
          await check(`profile ${tab}`);
          await shot(page, `profile-${tab}`, size);
          for (let i = 0; i < 8; i++) {
            const next = page.locator('[data-ui="profile-page"] [data-ui="page-next"]:not([disabled]) >> visible=true').first();
            if (!(await next.count())) break;
            await next.click();
            await check(`profile ${tab} page ${i + 2}`);
          }
        }
        // the eggs tab has its table by grade; the money tab its costs by kind; the flock its hens
        await page.locator('[data-tour="profile-eggs"]').click();
        expect(await vis(page, '[data-ui="profile-egg-table"]').innerText()).toMatch(/WHITE[\s\S]*GOLDEN/);
        await page.locator('[data-tour="profile-money"]').click();
        expect(await vis(page, '[data-ui="profile-costs"]').innerText()).toMatch(/FEED[\s\S]*HENS[\s\S]*COOPS[\s\S]*MACHINES[\s\S]*REPAIRS[\s\S]*MINT FEES/);

        // the badges tab: earned ones (the seeded machines and tickets earned some), a badge picked, filters
        await page.locator('[data-tour="profile-badges"]').click();
        const earned = Number((await vis(page, '[data-ui="badge-summary"]').innerText()).match(/^(\d+) OF \d+ EARNED/)?.[1]);
        expect(earned).toBeGreaterThanOrEqual(6);
        await page.locator('[data-ui="badge-filter"]', { hasText: 'EARNED' }).first().click();
        const levels = await page.locator('[data-ui="badge-grid"] [data-ui="badge-cell"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-level')));
        expect(levels.length).toBeGreaterThan(0);
        expect(levels).not.toContain('locked');
        await check('profile badges earned');
        await page.locator('[data-ui="badge-filter"]', { hasText: 'ALL' }).first().click();
        await vis(page, '[data-ui="badge-cell"][data-badge="first-egg"]').click();
        expect(await vis(page, '[data-ui="badge-detail-name"]').innerText()).toBe('FIRST EGG');
        // a secret badge not yet earned keeps its name hidden
        await page.locator('[data-ui="badge-filter"]', { hasText: 'FUN' }).first().click();
        await vis(page, '[data-ui="badge-cell"][data-badge="omelette"]').click();
        expect(await vis(page, '[data-ui="badge-detail-name"]').innerText()).toBe('A SECRET BADGE');
        await check('profile badges fun');

        // PUBLIC VIEW: the farm's public profile, and back to the profile
        await page.locator('[data-ui="profile-public"]').click();
        await page.locator('[data-ui="public-profile"][data-loaded="1"]').waitFor({ timeout: 15_000 });
        expect(await vis(page, '[data-ui="public-name"]').innerText()).toBe(name.toUpperCase());
        const stats = await vis(page, '[data-ui="public-stats"]').innerText();
        expect(stats).toMatch(/PLACE ON THE STREET[\s\S]*BADGES\s+\d+ OF \d+/);
        expect(stats).not.toMatch(/COIN|CASH|WALLET/);
        await check('public profile (own)');
        await shot(page, 'profile-public', size);
        await page.locator('[data-ui="modal"] [aria-label="Close"]').click();
        await page.locator('[data-ui="profile-page"]').waitFor();

        // a farm on the street (an AI farm) opens its public profile
        await page.locator('[data-tour="profile-overview"]').click();
        let row = page.locator('[data-ui="street-farm"]:has(.ai-badge) >> visible=true').first();
        for (let i = 0; i < 8 && !(await row.count()); i++) {
          const next = page.locator('[data-ui="profile-page"] [data-ui="page-next"]:not([disabled]) >> visible=true').last();
          if (!(await next.count())) break;
          await next.click();
          await page.waitForTimeout(250);
          row = page.locator('[data-ui="street-farm"]:has(.ai-badge) >> visible=true').first();
        }
        await row.click();
        await page.locator('[data-ui="public-profile"][data-loaded="1"]').waitFor({ timeout: 15_000 });
        expect(await vis(page, '[data-ui="public-name"]').locator('.ai-badge').count()).toBe(1);
        expect(await vis(page, '[data-ui="public-badges"]').innerText()).toContain('AI FARMS DO NOT EARN BADGES');
        await check('public profile (AI farm)');
        await shot(page, 'profile-public-ai', size);
        await page.keyboard.press('Escape');
        await page.locator('[data-ui="profile-page"]').waitFor();

        // the farm's name in Settings opens the profile too
        await page.locator('[data-ui="profile-close"]').click();
        await page.locator('[data-ui="profile-page"]').waitFor({ state: 'detached' });
        await page.locator('[data-tour="settings"]').first().click();
        await page.locator('[data-ui="farm-name-profile"]').click();
        await page.locator('[data-ui="profile-page"]').waitFor();
        await page.locator('[data-ui="profile-close"]').click();
        await page.locator('[data-ui="profile-page"]').waitFor({ state: 'detached' });

        // two badges at once: the moments come one after the other, never together
        await server.badge(name, 'first-haggle', 'plain');
        await server.badge(name, 'number-one', 'gold');
        // moments play one at a time, a few seconds each; a slow machine draws them slower still
        await page.locator('[data-ui="badge-moment"][data-badge="first-haggle"]').waitFor({ timeout: 45_000 });
        expect(await page.locator('[data-ui="badge-moment"]').count()).toBe(1);
        expect(await page.locator('[data-ui="badge-moment-name"]').innerText()).toBe('FIRST HAGGLE: EARNED');
        await page.waitForTimeout(500);
        await check('badge moment');
        await shot(page, 'badge-moment', size);
        await page.locator('[data-ui="badge-moment"][data-badge="number-one"]').waitFor({ timeout: 45_000 });
        expect(await page.locator('[data-ui="badge-moment"]').count()).toBe(1);
        expect(await page.locator('[data-ui="badge-moment-name"]').innerText()).toBe('NUMBER ONE: GOLD');
        await page.locator('[data-ui="badge-moment"]').waitFor({ state: 'detached', timeout: 45_000 });
      } finally {
        await ctx.close();
      }
      expect(problems).toEqual([]);
    }, 600_000);
  }
});
