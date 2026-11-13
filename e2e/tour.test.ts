// The naming screen and the tour in a real browser (the built client and the real server, a fresh
// headless browser each time, nothing kept). Naming: a new player is asked to name the farm (a
// suggestion filled in, SHUFFLE, a refused email-like name, CONFIRM), or keeps the generated name;
// Settings renames. Tour, at 1280x720, 1920x1080, 390x844 and 360x640: it shows on first entry with
// no click; on every step its box sits beside the spotlight, never over it, inside the window and
// clear of the top bar, the side panel, the goal tracker and the toasts; BACK, NEXT (after a few
// seconds), SKIP STEP and END TOUR (asked once more) work, and Settings replays it.
// SCREENSHOTS=1 saves three steps at 1920x1080 and 390x844 to docs/screenshots.
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestServer, type TestServer } from './server';

const shotsDir = fileURLToPath(new URL('../docs/screenshots/', import.meta.url));
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

/** Opens the game and signs in with the local dev login; a blank name gets a generated one. */
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

type Box = { x: number; y: number; w: number; h: number };
const rectOf = (page: Page, sel: string): Promise<Box | null> =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width && r.height ? { x: r.x, y: r.y, w: r.width, h: r.height } : null;
  }, sel);
const overlap = (a: Box, b: Box) => a.x < b.x + b.w - 1 && b.x < a.x + a.w - 1 && a.y < b.y + b.h - 1 && b.y < a.y + a.h - 1;

describe('naming the farm', () => {
  it('a new player names the farm: a suggestion, shuffle, a refused email name, confirm; another keeps the generated name; Settings renames', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();
    try {
      await enter(page, '');
      const field = page.locator('[data-ui="name-field"]');
      await field.waitFor({ timeout: 15_000 });
      const first = await field.inputValue();
      expect(first.length).toBeGreaterThanOrEqual(3);
      // the tour waits for the name
      expect(await page.locator('[data-ui="tour"]').count()).toBe(0);
      let shuffled = first;
      for (let i = 0; i < 5 && shuffled === first; i++) {
        await page.locator('[data-ui="name-shuffle"]').click();
        shuffled = await field.inputValue();
      }
      expect(shuffled).not.toBe(first);
      if (process.env.SCREENSHOTS) await page.screenshot({ path: `${shotsDir}name-your-farm-1280x720.png`, scale: 'css' });
      await field.fill('me@example.com');
      expect(await page.locator('[data-ui="name-problem"]').innerText()).toMatch(/LETTERS, NUMBERS/);
      expect(await page.locator('[data-ui="name-confirm"]').isDisabled()).toBe(true);
      await field.fill('Old Money Farms');
      await page.locator('[data-ui="name-confirm"]').click();
      await page.waitForTimeout(500);
      expect(await page.locator('[data-ui="name-problem"]').innerText()).toMatch(/ANOTHER FARM/);
      await field.fill('Clucky Sunday Acres');
      await page.locator('[data-ui="name-confirm"]').click();
      await page.locator('[data-ui="name-farm"]').waitFor({ state: 'detached', timeout: 10_000 });
      // the tour starts on its own once the farm is named
      await page.locator('[data-ui="tour"]').waitFor({ timeout: 15_000 });
      await page.evaluate(() => (window as unknown as { __coysTour: { end(): void } }).__coysTour.end());
      await page.locator('[data-tour="settings"]').first().click();
      const row = page.locator('[data-ui="farm-name-setting"]');
      expect(await row.innerText()).toContain('CLUCKY SUNDAY ACRES');
      // a rename now (the first choice was free), then the weekly wait
      await page.locator('[data-tour="rename-farm"]').click();
      await field.fill('Yolkshire Nook');
      await page.locator('[data-ui="name-confirm"]').click();
      await page.locator('[data-ui="name-farm"]').waitFor({ state: 'detached', timeout: 10_000 });
      await page.locator('[data-tour="settings"]').first().click();
      expect(await row.innerText()).toContain('YOLKSHIRE NOOK');
      expect(await page.locator('[data-tour="rename-farm"]').innerText()).toMatch(/RENAME FROM DAY/);
    } finally {
      await ctx.close();
    }
    // another player closes the screen: the generated name stays, and the question is not asked again
    const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page2 = await ctx2.newPage();
    try {
      await enter(page2, '');
      const field = page2.locator('[data-ui="name-field"]');
      await field.waitFor({ timeout: 15_000 });
      const generated = await field.inputValue();
      await page2.locator('[data-ui="name-keep"]').click();
      await page2.locator('[data-ui="tour"]').waitFor({ timeout: 15_000 });
      await page2.evaluate(() => (window as unknown as { __coysTour: { end(): void } }).__coysTour.end());
      await page2.locator('[data-tour="settings"]').first().click();
      expect(await page2.locator('[data-ui="farm-name-setting"]').innerText()).toContain(generated.toUpperCase());
      await page2.reload();
      await page2.getByText('PLAY', { exact: true }).waitFor({ timeout: 60_000 });
      await page2.waitForTimeout(800);
      await page2.getByText('PLAY', { exact: true }).click({ force: true });
      await page2.locator('[data-ui="topbar"]').waitFor({ timeout: 60_000 });
      await page2.waitForTimeout(1500);
      expect(await page2.locator('[data-ui="name-farm"]').count()).toBe(0);
    } finally {
      await ctx2.close();
    }
  }, 600_000);
});

describe('the tour', () => {
  for (const [w, h, dpr] of [
    [1280, 720, 1],
    [1920, 1080, 1],
    [390, 844, 3],
    [360, 640, 2],
  ] as const) {
    it(`at ${w}x${h}: beside its target on every step, clear of the UI, every control working`, async () => {
      const size = `${w}x${h}`;
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, isMobile: w < 600, hasTouch: w < 600 });
      const page = await ctx.newPage();
      const problems: string[] = [];
      try {
        // a typed name: no naming screen, so the tour is the first thing
        await enter(page, `Tour Check ${size}`);
        await page.locator('[data-ui="tour"]').waitFor({ timeout: 15_000 });
        expect(await page.locator('[data-ui="tour-progress"]').innerText()).toBe('STEP 1 OF 11');
        const steps = await page.evaluate(() => (window as unknown as { __coysTour: { count: number } }).__coysTour.count);
        for (let i = 0; i < steps; i++) {
          await page.evaluate((n) => (window as unknown as { __coysTour: { show(n: number): void } }).__coysTour.show(n), i);
          await page.waitForTimeout(700);
          const box = await rectOf(page, '[data-ui="tour-place"]');
          if (!box) {
            problems.push(`${size} step ${i + 1}: no box`);
            continue;
          }
          if (box.x < 0 || box.y < 0 || box.x + box.w > w + 0.5 || box.y + box.h > h + 0.5) problems.push(`${size} step ${i + 1}: box off screen ${JSON.stringify(box)}`);
          const ring = await rectOf(page, '.spot-ring');
          if (ring && overlap(box, ring)) problems.push(`${size} step ${i + 1}: box over its target`);
          for (const [zone, sel] of [
            ['top bar', '[data-ui="topbar"]'],
            ['side panel', '[data-ui="side"]'],
            ['tracker', '[data-ui="tracker"]'],
            ['toasts', '[data-ui="toasts"]'],
          ] as const) {
            const z = await rectOf(page, sel);
            if (z && overlap(box, z)) problems.push(`${size} step ${i + 1}: box over the ${zone}`);
          }
          if (process.env.SCREENSHOTS && (w === 1920 || w === 390) && [0, 3, 9].includes(i)) {
            await page.screenshot({ path: `${shotsDir}tour-new-step-${i + 1}-${size}.png`, scale: 'css' });
          }
        }
        // the controls: back to step 1, NEXT appears after a few seconds, BACK, SKIP STEP, END TOUR
        await page.evaluate(() => (window as unknown as { __coysTour: { show(n: number): void } }).__coysTour.show(0));
        await page.waitForTimeout(300);
        expect(await page.locator('[data-ui="tour-next"]').count()).toBe(0);
        await page.locator('[data-ui="tour-next"]').waitFor({ timeout: 10_000 });
        await page.locator('[data-ui="tour-next"]').click();
        expect(await page.locator('[data-ui="tour-progress"]').innerText()).toBe('STEP 2 OF 11');
        await page.locator('[data-ui="tour-back"]').click();
        expect(await page.locator('[data-ui="tour-progress"]').innerText()).toBe('STEP 1 OF 11');
        await page.locator('[data-ui="tour-skip-step"]').click();
        expect(await page.locator('[data-ui="tour-progress"]').innerText()).toBe('STEP 2 OF 11');
        await page.locator('[data-ui="tour-end"]').click();
        await page.locator('[data-ui="tour-end-no"]').click();
        expect(await page.locator('[data-ui="tour-progress"]').innerText()).toBe('STEP 2 OF 11');
        await page.locator('[data-ui="tour-end"]').click();
        await page.locator('[data-ui="tour-end-yes"]').click();
        await page.locator('[data-ui="tour"]').waitFor({ state: 'detached', timeout: 5000 });
        // replayable from Settings
        await page.locator('[data-tour="settings"]').first().click();
        await page.locator('[data-tour="replay-tour"]').click();
        await page.locator('[data-ui="tour"]').waitFor({ timeout: 5000 });
        expect(await page.locator('[data-ui="tour-progress"]').innerText()).toBe('STEP 1 OF 11');
      } finally {
        await ctx.close();
      }
      expect(problems).toEqual([]);
    }, 600_000);
  }
});
