// No scrollbars, nothing cut off: at every checked window size (and some in between), with every
// screen, modal, tab, page and tour step open, no element scrolls or clips its content and the page
// itself never scrolls. Runs the real server (e2e/server.ts) and the built client in a fresh headless
// browser per size (no profile, nothing kept). SCREENSHOTS=1 saves each screen to docs/screenshots.
//
//   npm run build && npm run test:e2e
//   CHROME_PATH=/usr/bin/google-chrome npm run test:e2e      (CI: the runner's own Chrome)
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { overflowing } from './overflow';
import { sizes } from './sizes';
import { startTestServer, type TestServer } from './server';

const ALL_SIZES: [number, number, number][] = [
  [1280, 720, 1],
  [1440, 900, 1],
  [1920, 1080, 1],
  [2560, 1440, 1],
  [390, 844, 3],
  [360, 640, 2],
  // in between: a small laptop, a wide monitor, a tablet each way, a tall phone
  [1024, 640, 1],
  [1680, 1050, 1],
  [768, 1024, 2],
  [1024, 768, 1],
  [1180, 820, 2],
  [412, 915, 2],
];
/** E2E_SIZES=1280x720,360x640 checks only those (e2e/sizes.ts); every size by default. */
const SIZES = sizes(ALL_SIZES);
/** The sizes whose screens are saved as screenshots (desktop and phone). */
const SHOTS = new Set(['1280x720', '390x844']);
const shotsDir = fileURLToPath(new URL('../docs/screenshots/', import.meta.url));

let server: TestServer;
let browser: Browser;
const problems: string[] = [];

beforeAll(async () => {
  server = await startTestServer();
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined, args: ['--disable-sync', '--no-first-run', '--disable-extensions'] });
  if (process.env.SCREENSHOTS) mkdirSync(shotsDir, { recursive: true });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

describe('no scrollbars and nothing cut off', () => {
  for (const [w, h, dpr] of SIZES) {
    it(`at ${w}x${h}`, async () => {
      const size = `${w}x${h}`;
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, isMobile: w < 600, hasTouch: w < 600 });
      const page = await ctx.newPage();
      const seen = new Set<string>();
      const started = Date.now();
      const check = async (screen: string) => {
        await page.waitForTimeout(350);
        if (process.env.E2E_PROGRESS) process.stdout.write(`${size} ${((Date.now() - started) / 1000).toFixed(0)}s ${screen}\n`);
        for (const p of await page.evaluate(overflowing)) problems.push(`${size} ${screen}: ${p}`);
        // one picture per screen, tab and tour step (not every further page), at CSS pixels
        const key = screen.replace(/ page \d+$/, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
        if (process.env.SCREENSHOTS && SHOTS.has(size) && !seen.has(key)) {
          seen.add(key);
          await page.screenshot({ path: `${shotsDir}${key}-${size}.png`, scale: 'css' });
        }
      };
      try {
        await page.goto(`${server.url}/`);
        await page.getByText('PLAY', { exact: true }).waitFor({ timeout: 60_000 });
        await page.waitForTimeout(800);
        await check('title');
        const settings = page.getByText('SETTINGS', { exact: true }).first();
        if (await settings.isVisible().catch(() => false)) {
          await settings.click();
          await check('title settings');
          await page.keyboard.press('Escape');
        }
        await page.getByText('PLAY', { exact: true }).click({ force: true });
        const field = page.getByPlaceholder('FARMER NAME');
        await field.waitFor({ timeout: 15_000 });
        const name = `Ada Check ${size}`;
        await field.fill(name);
        await field.press('Enter');
        await page.locator('[data-ui="topbar"]').waitFor({ timeout: 60_000 });
        await server.seed(name, 6);
        // hens at auction (as after a bust), so the shop shows its AUCTION tags and the line about them
        await server.auction(3);
        await server.closeDays(9);
        await page.waitForTimeout(1500);

        // every tour step's box over the farm
        const steps = await page.evaluate(() => (window as unknown as { __coysTour?: { count: number } }).__coysTour?.count ?? 0);
        expect(steps).toBeGreaterThan(0);
        for (let i = 0; i < steps; i++) {
          await page.evaluate((n) => (window as unknown as { __coysTour: { show(n: number): void } }).__coysTour.show(n), i);
          await check(`tour step ${i + 1}`);
        }
        await page.evaluate(() => (window as unknown as { __coysTour: { end(): void } }).__coysTour.end());
        await check('farm');

        /** Checks every page of the open view: next until the last page (at most `max` steps). */
        const walk = async (screen: string, max = 12) => {
          await check(screen);
          for (let i = 0; i < max; i++) {
            const next = page.locator('[data-ui="modal"] [data-ui="page-next"]:not([disabled])').first();
            if (!(await next.count())) return;
            await next.click();
            await check(`${screen} page ${i + 2}`);
          }
        };
        const open = async (target: string) => {
          await page.keyboard.press('Escape');
          await page.waitForTimeout(200);
          await page.locator(`[data-tour="${target}"]`).first().click();
          await page.waitForTimeout(400);
        };
        const tabs = async (modal: string, ids: string[], max?: number) => {
          for (const id of ids) {
            await open(modal);
            const tab = page.locator(`[data-tour="${id}"]`).first();
            if (await tab.count()) await tab.click();
            await walk(`${modal} ${id}`, max);
          }
        };
        await tabs('shop', ['shop-hens', 'shop-feed', 'shop-coops', 'shop-machines', 'shop-land']);
        // the Market (a page of its own): every tab, and every page of every list on it
        await open('market');
        await page.locator('[data-ui="market-page"]').waitFor();
        for (const id of ['prices', 'sell', 'buyers', 'mine', 'trade', 'auction', 'farms']) {
          await page.locator(`[data-tour="market-${id}"]`).click();
          await check(`market ${id}`);
          const pagers = page.locator('[data-ui="market-page"] [data-ui="pager"] >> visible=true');
          const lists = await pagers.count();
          for (let l = 0; l < lists; l++) {
            for (let i = 0; i < 12; i++) {
              const next = pagers.nth(l).locator('[data-ui="page-next"]:not([disabled])');
              if (!(await next.count())) break;
              await next.click();
              await check(`market ${id} list ${l + 1} page ${i + 2}`);
            }
          }
        }
        await tabs('ledger', ['ledger-days', 'ledger-contracts', 'ledger-feathers', 'ledger-milestones']);
        await open('settings');
        await walk('settings');
        await open('help');
        await walk('guide', 80);
        // the Feather Mint: its sections' pages, and a few of the grid's (they are all alike)
        await open('feathers');
        await page.locator('[data-ui="mint-page"]').waitFor();
        await page.waitForTimeout(500);
        await check('mint');
        for (const [part, max] of [
          ['mint-info', 5],
          ['mint-grid', 3],
        ] as const) {
          for (let i = 0; i < max; i++) {
            const next = page.locator(`[data-ui="${part}"] [data-ui="page-next"]:not([disabled])`).first();
            if (!(await next.count())) break;
            await next.click();
            await check(`mint ${part} page ${i + 2}`);
          }
        }
        for (const label of ['NOT MINTED', 'GOLDEN QUILL']) {
          await page.locator('[data-ui="mint-filters"] button', { hasText: label }).first().click();
          await check(`mint filter ${label.toLowerCase()}`);
        }
        // the profile: every tab, and a few pages of each
        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);
        await page.locator('[data-tour="profile"]').first().click();
        await page.locator('[data-ui="profile-page"]').waitFor();
        await page.locator('[data-ui="profile-loading"]').waitFor({ state: 'detached', timeout: 15_000 });
        for (const tab of ['overview', 'eggs', 'money', 'flock', 'machines', 'market', 'mint', 'badges']) {
          await page.locator(`[data-tour="profile-${tab}"]`).click();
          await check(`profile ${tab}`);
          for (let i = 0; i < 3; i++) {
            const next = page.locator('[data-ui="profile-page"] [data-ui="page-next"]:not([disabled]) >> visible=true').first();
            if (!(await next.count())) break;
            await next.click();
            await check(`profile ${tab} page ${i + 2}`);
          }
        }
        // the cards the farm's things open, and a waiting offer
        await page.keyboard.press('Escape');
        const targets = await page.evaluate(() => (window as unknown as { __coysFarm?: { targets(): { kind: string; x: number; y: number; w: number; h: number }[] } }).__coysFarm?.targets() ?? []);
        for (const kind of ['hen', 'machine', 'crate', 'feed', 'coop', 'farmhouse']) {
          const t = targets.find((x) => x.kind === kind);
          if (!t) continue;
          await page.keyboard.press('Escape');
          await page.waitForTimeout(200);
          // targets() boxes are CSS pixels already (the canvas uses autoDensity)
          await page.mouse.click(t.x + t.w / 2, t.y + t.h / 2);
          await walk(`card ${kind}`);
        }
        await page.keyboard.press('Escape');
        const offer = page.locator('[data-tour="card-queue"]').first();
        if (await offer.count()) {
          await offer.click();
          await check('offer card');
        }
      } finally {
        await ctx.close();
      }
    }, 1_200_000);
  }

  it('found nothing', () => {
    expect(problems).toEqual([]);
  });
});
