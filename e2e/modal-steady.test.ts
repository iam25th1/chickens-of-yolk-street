// Modals open once and then hold still: re-rendering (typing, a server tick) never replays their open
// animation. The naming box gets a 20-character farm name typed one key at a time; the public profile,
// the shop, the ledger, the guide and the minting moment are held open while the server pushes the
// farm's state again and again. After each key or tick the box's opacity, transform and position must
// be what they were once it had opened, and the mean luminance over the box may not jump more than 20
// percent from one sample to the next (a flash). The built client and the real server, in a fresh
// headless browser with nothing kept.
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodePng } from '../scripts/lib/png';
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

interface Pose {
  opacity: string;
  transform: string;
  x: number;
  y: number;
}

/** The open modal's panel: how it is drawn now (opacity, transform, position). */
const pose = (page: Page): Promise<Pose | null> =>
  page.evaluate(() => {
    const el = document.querySelector('[data-ui="modal"]');
    if (!el) return null;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return { opacity: s.opacity, transform: s.transform, x: Math.round(r.x), y: Math.round(r.y) };
  });

/** Mean relative luminance (0 to 1) of the modal's area, from a screenshot. */
async function luminance(page: Page): Promise<number> {
  const box = await page.locator('[data-ui="modal"]').first().boundingBox();
  if (!box) return 0;
  const png = decodePng(await page.screenshot({ clip: box, scale: 'css' }));
  let sum = 0;
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  for (let i = 0; i < png.data.length; i += 4) {
    sum += 0.2126 * lin((png.data[i] ?? 0) / 255) + 0.7152 * lin((png.data[i + 1] ?? 0) / 255) + 0.0722 * lin((png.data[i + 2] ?? 0) / 255);
  }
  return sum / (png.data.length / 4);
}

/**
 * Waits for the modal's open animation to finish, then fires `step` n times; after each one (a short
 * moment later, while a replayed animation would still be running) the modal must be posed exactly as
 * it settled, and (unless told otherwise) its luminance may not jump more than 20 percent. Returns what
 * went wrong.
 */
async function holdsStill(page: Page, what: string, n: number, step: (i: number) => Promise<void>, opts: { luma?: boolean } = {}): Promise<string[]> {
  await page.locator('[data-ui="modal"]').first().waitFor();
  await page.waitForTimeout(900);
  const settled = await pose(page);
  let last = await luminance(page);
  const problems: string[] = [];
  for (let i = 0; i < n; i++) {
    await step(i);
    await page.waitForTimeout(60);
    const now = await pose(page);
    if (JSON.stringify(now) !== JSON.stringify(settled)) problems.push(`${what} step ${i + 1}: the box moved or faded (${JSON.stringify(now)}, settled ${JSON.stringify(settled)})`);
    if (opts.luma === false) continue;
    const l = await luminance(page);
    if (Math.abs(l - last) / Math.max(l, last, 1e-6) > 0.2) problems.push(`${what} step ${i + 1}: luminance jumped from ${last.toFixed(3)} to ${l.toFixed(3)}`);
    last = l;
  }
  return problems;
}

async function signIn(page: Page, name: string): Promise<void> {
  await page.goto(`${server.url}/`);
  await page.getByText('PLAY', { exact: true }).waitFor({ timeout: 60_000 });
  await page.waitForTimeout(800);
  await page.getByText('PLAY', { exact: true }).click({ force: true });
  const field = page.getByPlaceholder('FARMER NAME');
  await field.waitFor({ timeout: 15_000 });
  await field.fill(name);
  await field.press('Enter');
  await page.locator('[data-ui="topbar"]').waitFor({ timeout: 60_000 });
  await page.evaluate(() => (globalThis as unknown as { __coysTour?: { end(): void } }).__coysTour?.end());
  await page.waitForTimeout(800);
}

const open = (page: Page, modal: Record<string, unknown>) => page.evaluate((m) => (globalThis as unknown as { __coysUi: { open(m: unknown): void } }).__coysUi.open(m), modal);

describe('modals hold still', () => {
  for (const [w, h, dpr] of sizes([
    [1280, 720, 1],
    [1920, 1080, 1],
    [390, 844, 3],
  ] as const)) {
    it(`at ${w}x${h}, the naming box does not replay its open animation while a 20-character name is typed`, async () => {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, isMobile: w < 600, hasTouch: w < 600 });
      const page = await ctx.newPage();
      try {
        await signIn(page, `Steady ${w}x${h}`);
        await open(page, { kind: 'name', mode: 'first' });
        const name = 'Golden Feather Acres';
        expect(name).toHaveLength(20);
        await page.locator('[data-ui="name-field"]').waitFor();
        await page.locator('[data-ui="name-field"]').fill('');
        const problems = await holdsStill(page, 'naming', name.length, async (i) => {
          await page.keyboard.type(name[i] ?? '');
        });
        expect(await page.locator('[data-ui="name-field"]').inputValue()).toBe(name);
        expect(problems).toEqual([]);
      } finally {
        await ctx.close();
      }
    }, 180_000);
  }

  it('the public profile, the shop, the ledger, the guide and the minting moment hold still while the server pushes the farm again and again', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const name = 'Steady Ticks';
    try {
      await signIn(page, name);
      await server.seed(name, 2);
      await server.wallet(name, 'steady-check.testnet');
      // a server tick: the farm's state pushed again (each push re-renders the farm screen)
      const tick = async (i: number) => {
        await server.cash(name, 300 + i);
        await page.waitForTimeout(250);
      };
      const problems: string[] = [];
      const farms = await page.evaluate(async () => ((await (await fetch('/api/market')).json()) as { market: { ranking: { farmId: string; kind: string }[] } }).market.ranking);
      const other = farms.find((f) => f.kind !== 'player') ?? farms[0];
      await open(page, { kind: 'publicProfile', farmId: other?.farmId, back: 'market' });
      problems.push(...(await holdsStill(page, 'public profile', 6, tick)));
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await open(page, { kind: 'shop', tab: 'hens' });
      problems.push(...(await holdsStill(page, 'shop', 6, tick)));
      await page.keyboard.press('Escape');
      await open(page, { kind: 'ledger' });
      problems.push(...(await holdsStill(page, 'ledger', 6, tick)));
      await page.keyboard.press('Escape');
      await open(page, { kind: 'guide' });
      problems.push(...(await holdsStill(page, 'guide', 6, tick)));
      await page.keyboard.press('Escape');
      // the minting moment: the farm's state comes in as the mint goes out and is confirmed
      await page.locator('[data-ui="feathers-button"]').click();
      await page.locator('[data-ui="mint-page"]').waitFor();
      await page.locator('[data-ui="mint-button"]:not([disabled]) >> visible=true').first().click();
      await page.locator('[data-ui="mint-moment"]').waitFor();
      // (its own press and card move inside it on purpose: only the box itself must hold still)
      problems.push(...(await holdsStill(page, 'minting moment', 6, tick, { luma: false })));
      expect(problems).toEqual([]);
    } finally {
      await ctx.close();
    }
  }, 240_000);
});
