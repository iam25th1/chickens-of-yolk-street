// New hens hatch in a real browser (the built client and the real server, a fresh headless browser
// each time, nothing kept). Buying one hen, then five at once: each drops an egg into the yard, the
// hens stay hidden until their eggs burst, the eggs land apart, and every new hen ends up visible
// and inside the yard. SCREENSHOTS=1 saves a frame strip of the five-hen hatch to SHOTS_DIR.
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

const farm = (page: Page) => page.evaluate(() => {
  const f = (window as unknown as { __coysFarm: FarmHook }).__coysFarm;
  return { hens: f.targets().filter((t) => t.kind === 'hen'), yard: f.yard(), eggs: f.hatching() };
});

/** Buys hens (one from the list, or `count` random ones) and follows the hatch to the end. */
async function buyAndHatch(page: Page, count: number, size: string): Promise<void> {
  const before = await farm(page);
  await page.locator('[data-tour="shop"]').first().click();
  await page.locator('[data-tour="shop-hens"]').first().click();
  if (count === 1) {
    await page.locator('[data-tour="buy-hen"] >> visible=true').first().click();
  } else {
    for (let i = 1; i < count; i++) await page.getByLabel('More hens').click();
    await page.getByText(`BUY UP TO ${count * 8}`, { exact: true }).click();
  }
  await page.keyboard.press('Escape');

  // the eggs come down: one per new hen, apart, inside the yard, while the hens are still in them
  await page.waitForFunction((n) => (window as unknown as { __coysFarm: FarmHook }).__coysFarm.hatching().length >= Math.min(n, 2), count, { timeout: 10_000 });
  let most = 0;
  const seen: { x: number; y: number }[] = [];
  const started = Date.now();
  let frame = 0;
  while (Date.now() - started < 9_000) {
    const f = await farm(page);
    most = Math.max(most, f.eggs.length);
    for (const e of f.eggs) if (!seen.some((s) => Math.abs(s.x - e.x) < 2 && Math.abs(s.y - e.y) < 2)) seen.push(e);
    if (process.env.SCREENSHOTS && shotsDir && count > 1 && frame < 12 && Date.now() - started > frame * 350) {
      await page.screenshot({ path: `${shotsDir}/hatch-${size}-${String(frame).padStart(2, '0')}.png`, scale: 'css' });
      frame++;
    }
    if (f.eggs.length === 0 && f.hens.length >= before.hens.length + count) break;
    await page.waitForTimeout(120);
  }
  const after = await farm(page);
  expect(after.eggs, `${size}: eggs left behind`).toHaveLength(0);
  expect(after.hens.length, `${size}: new hens shown`).toBe(before.hens.length + count);
  expect(most, `${size}: eggs at once`).toBeGreaterThanOrEqual(Math.min(count, 2));
  // where each egg landed (its feet), inside the yard
  const y = after.yard;
  const landed = seen.filter((e) => e.y >= y.y && e.y <= y.y + y.h + 2);
  expect(landed.length, `${size}: landed eggs`).toBeGreaterThanOrEqual(count);
  for (const e of landed) expect(e.x >= y.x && e.x <= y.x + y.w, `${size}: egg at (${e.x}, ${e.y}) outside the yard`).toBe(true);
  // every hen is in the yard (by her feet: the bottom of her box), new ones included
  await page.waitForTimeout(1500);
  for (const h of (await farm(page)).hens) {
    const foot = { x: h.x + h.w / 2, y: h.y + h.h };
    expect(foot.x >= y.x - 4 && foot.x <= y.x + y.w + 4 && foot.y >= y.y - 4 && foot.y <= y.y + y.h + 4, `${size}: hen ${h.id} at (${foot.x}, ${foot.y}) outside the yard`).toBe(true);
  }
}

describe('new hens hatch', () => {
  for (const [w, h, dpr] of [
    [1280, 720, 1],
    [390, 844, 3],
  ] as const) {
    it(`at ${w}x${h}, one hen and then five hatch in the yard and wander there`, async () => {
      const size = `${w}x${h}`;
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, isMobile: w < 600, hasTouch: w < 600 });
      const page = await ctx.newPage();
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
        await page.waitForTimeout(800);
        await buyAndHatch(page, 1, size);
        await buyAndHatch(page, 5, size);
      } finally {
        await ctx.close();
      }
    }, 180_000);
  }
});
