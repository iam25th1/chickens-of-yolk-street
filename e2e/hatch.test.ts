// New hens hatch in a real browser (the built client and the real server, a fresh headless browser
// each time, nothing kept), from every way a player gets them: one from the shop's list, three at
// random, and one from the Market's hen auction. Each new hen waits in her egg while the shop or the
// Market covers the farm, then hatches at a coop's door: the eggs land apart in the yard, the hens
// stay hidden until their eggs burst, and every new hen ends up in the yard. A farm with more hens
// than the screen shows still sees its new ones hatch. SCREENSHOTS=1 with SHOTS_DIR saves frames.
import { mkdirSync } from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, type TestServer } from './server';

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface FarmHook {
  targets(): ({ kind: string; id?: string } & Box)[];
  yard(): Box;
  hatching(): { x: number; y: number }[];
}
type How = 'list' | 'random' | 'auction';

let server: TestServer;
let browser: Browser;
const shotsDir = process.env.SHOTS_DIR;

beforeAll(async () => {
  server = await startTestServer();
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined, args: ['--disable-sync', '--no-first-run', '--disable-extensions'] });
  if (process.env.SCREENSHOTS && shotsDir) mkdirSync(shotsDir, { recursive: true });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const farm = (page: Page) =>
  page.evaluate(() => {
    const f = (window as unknown as { __coysFarm: FarmHook }).__coysFarm;
    return { hens: f.targets().filter((t) => t.kind === 'hen'), yard: f.yard(), eggs: f.hatching() };
  });

/** Buys hens one way, with the shop or the Market still open; returns how to close it. */
async function buy(page: Page, how: How, count: number): Promise<() => Promise<void>> {
  if (how === 'auction') {
    await page.locator('[data-ui="market-button"]').click();
    await page.locator('[data-tour="market-auction"]').click();
    for (let i = 0; i < count; i++) await page.locator('[data-ui="auction-buy"]:not([disabled]) >> visible=true').first().click();
    return async () => {
      await page.locator('[data-ui="market-close"]').click();
    };
  }
  await page.locator('[data-tour="shop"]').first().click();
  await page.locator('[data-tour="shop-hens"]').first().click();
  if (how === 'list') {
    for (let i = 0; i < count; i++) await page.locator('[data-tour="buy-hen"] >> visible=true').first().click();
  } else {
    for (let i = 1; i < count; i++) await page.getByLabel('More hens').click();
    await page.getByText(`BUY UP TO ${count * 8}`, { exact: true }).click();
  }
  return async () => {
    await page.keyboard.press('Escape');
  };
}

/** Buys hens one way and follows the hatch to the end. */
async function buyAndHatch(page: Page, how: How, count: number, size: string): Promise<void> {
  const before = await farm(page);
  const close = await buy(page, how, count);
  // while the shop or the Market covers the farm, the new hens wait in their eggs
  await page.waitForTimeout(1200);
  expect((await farm(page)).eggs, `${size} ${how}: no hatch behind the open page`).toHaveLength(0);
  await close();

  // the eggs come down: one per new hen, apart, inside the yard, while the hens are still in them
  await page.waitForFunction((n) => (window as unknown as { __coysFarm: FarmHook }).__coysFarm.hatching().length >= Math.min(n, 2), count, { timeout: 15_000 });
  let most = 0;
  const seen: { x: number; y: number }[] = [];
  const started = Date.now();
  let frame = 0;
  // (a slow machine draws few frames, and each frame moves the art at most 100 ms, so allow time)
  while (Date.now() - started < 40_000) {
    const f = await farm(page);
    most = Math.max(most, f.eggs.length);
    for (const e of f.eggs) if (!seen.some((s) => Math.abs(s.x - e.x) < 2 && Math.abs(s.y - e.y) < 2)) seen.push(e);
    if (process.env.SCREENSHOTS && shotsDir && frame < 14 && Date.now() - started > frame * 300) {
      await page.screenshot({ path: `${shotsDir}/hatch-${size}-${how}${count}-${String(frame).padStart(2, '0')}.png`, scale: 'css' });
      frame++;
    }
    if (f.eggs.length === 0 && f.hens.length >= Math.min(40, before.hens.length + count)) break;
    await page.waitForTimeout(120);
  }
  const after = await farm(page);
  expect(after.eggs, `${size} ${how}: eggs left behind`).toHaveLength(0);
  expect(most, `${size} ${how}: eggs at once`).toBeGreaterThanOrEqual(Math.min(count, 2));
  // where each egg landed (its feet), inside the yard
  const y = after.yard;
  const landed = seen.filter((e) => e.y >= y.y && e.y <= y.y + y.h + 2);
  expect(landed.length, `${size} ${how}: landed eggs`).toBeGreaterThanOrEqual(count);
  for (const e of landed) expect(e.x >= y.x && e.x <= y.x + y.w, `${size} ${how}: egg at (${e.x}, ${e.y}) outside the yard`).toBe(true);
  // every new hen is shown, and in the yard (by her feet) as she comes out of her egg; the older hens
  // may be anywhere they walk, a coop's door at night included
  const old = new Set(before.hens.map((h) => h.id));
  const fresh = after.hens.filter((x) => !old.has(x.id));
  expect(fresh.length, `${size} ${how}: new hens shown`).toBe(count);
  for (const h of fresh) {
    const foot = { x: h.x + h.w / 2, y: h.y + h.h };
    expect(foot.x >= y.x - 4 && foot.x <= y.x + y.w + 4 && foot.y >= y.y - 4 && foot.y <= y.y + y.h + 4, `${size} ${how}: hen ${h.id} at (${foot.x}, ${foot.y}) outside the yard`).toBe(true);
  }
}

describe('new hens hatch', () => {
  for (const [w, h, dpr] of [
    [1280, 720, 1],
    [390, 844, 3],
  ] as const) {
    it(`at ${w}x${h}: from the shop's list, at random and from the hen auction, and on a farm bigger than the screen shows`, async () => {
      const size = `${w}x${h}`;
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, isMobile: w < 600, hasTouch: w < 600 });
      const page = await ctx.newPage();
      // CPU_THROTTLE=6 runs the check as a slow CI machine would
      if (process.env.CPU_THROTTLE) await (await ctx.newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.CPU_THROTTLE) });
      const name = `Hatch Check ${size}`;
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
        await page.waitForFunction(() => (window as unknown as { __coysFarm?: FarmHook }).__coysFarm?.targets().some((t) => t.kind === 'hen'), undefined, { timeout: 30_000 });
        await server.cash(name, 400);
        await page.waitForTimeout(800);
        await buyAndHatch(page, 'list', 1, size);
        await buyAndHatch(page, 'random', 3, size);
        await server.auction(3);
        await server.cash(name, 400);
        await page.waitForTimeout(500);
        await buyAndHatch(page, 'auction', 1, size);
        // a big flock (more hens than the screen shows): a new hen still hatches and is shown
        // (they are new to the farm too, so they hatch first: forty eggs, a beat apart)
        await server.flock(name, 45);
        await page.waitForFunction(() => (window as unknown as { __coysFarm: FarmHook }).__coysFarm.hatching().length > 0, undefined, { timeout: 15_000 });
        await page.waitForFunction(() => {
          const f = (window as unknown as { __coysFarm: FarmHook }).__coysFarm;
          return f.hatching().length === 0 && f.targets().filter((t) => t.kind === 'hen').length >= 40;
        }, undefined, { timeout: 120_000 });
        await buyAndHatch(page, 'random', 1, size);
      } finally {
        await ctx.close();
      }
    }, 300_000);
  }
});
