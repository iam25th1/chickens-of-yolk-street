// Land in a real browser (the built client and the real server, a fresh headless browser each
// time): the shop's LAND tab shows the map of plots; buying the east field closes the shop and plays
// its moment (the camera goes to the new plot, fence posts pop up, then stand in the ground); a
// second plot, the south orchard, follows. Then the player looks round: dragging the farm moves the
// world and not the page (and does not open what the drag started on), the arrow keys move it, the
// small map shows the view, and HOME brings the home plot back. Nothing scrolls or overflows at any
// step. SCREENSHOTS=1 saves frames to SHOTS_DIR (default: a folder in the system's temp folder).
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ECONOMY } from '@coys/shared';
import { overflowing } from './overflow';
import { sizes } from './sizes';
import { startTestServer, type TestServer } from './server';

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface FarmHook {
  targets(): ({ kind: string; id?: string } & Box)[];
  camera(): { x: number; y: number };
  land(): { posts: number; waiting: number };
}

let server: TestServer;
let browser: Browser;
const shotsDir = process.env.SHOTS_DIR || join(tmpdir(), 'coys-land-shots');
const shots = Boolean(process.env.SCREENSHOTS);

beforeAll(async () => {
  server = await startTestServer();
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined, args: ['--disable-sync', '--no-first-run', '--disable-extensions'] });
  if (shots) mkdirSync(shotsDir, { recursive: true });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const camera = (page: Page) => page.evaluate(() => (window as unknown as { __coysFarm: FarmHook }).__coysFarm.camera());
const farmhouse = (page: Page) => page.evaluate(() => (window as unknown as { __coysFarm: FarmHook }).__coysFarm.targets().find((t) => t.kind === 'farmhouse'));

describe('land', () => {
  for (const [w, h, dpr] of sizes([
    [1280, 720, 1],
    [1920, 1080, 1],
    [390, 844, 3],
  ] as const)) {
    it(`at ${w}x${h}: buy plots from the LAND tab, see the moment, look round by drag, keys and the map, and come HOME`, async () => {
      const size = `${w}x${h}`;
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, isMobile: w < 600, hasTouch: w < 600 });
      const page = await ctx.newPage();
      const problems: string[] = [];
      let shot = 0;
      const check = async (what: string) => {
        await page.waitForTimeout(300);
        for (const p of await page.evaluate(overflowing)) problems.push(`${size} ${what}: ${p}`);
        // the page itself never scrolls
        const scrolled = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY, top: document.scrollingElement?.scrollTop ?? 0, left: document.scrollingElement?.scrollLeft ?? 0 }));
        expect(scrolled, `${size} ${what}: the page scrolled`).toEqual({ x: 0, y: 0, top: 0, left: 0 });
        if (shots) await page.screenshot({ path: join(shotsDir, `land-${size}-${String(shot++).padStart(2, '0')}-${what.replace(/[^a-z0-9]+/gi, '-')}.png`), scale: 'css' });
      };
      const name = `Land Check ${size}`;
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
        // a farm on its home plot alone: no map, no HOME, and the camera never moves
        expect(await page.locator('[data-ui="farm-map"]').count()).toBe(0);
        expect(await camera(page)).toEqual({ x: 0, y: 0 });
        await check('home plot');

        // the shop's LAND tab: the map of plots, the next price on every plot for sale
        await server.cash(name, 5000);
        await page.waitForTimeout(500);
        await page.locator('[data-tour="shop"]').first().click();
        await page.locator('[data-tour="shop-land"]').first().click();
        await page.locator('[data-ui="land-map"]').waitFor();
        for (const id of ['east', 'west', 'north', 'south']) await expect(page.locator(`[data-ui="buy-land-${id}"]`).innerText()).resolves.toBe(`BUY ${ECONOMY.land.prices[0]}`);
        await check('land tab');

        // buy the east field: the shop closes and the moment plays (the camera goes there, posts pop up)
        await page.locator('[data-ui="buy-land-east"]').click();
        await page.locator('[data-ui="modal"]').waitFor({ state: 'detached', timeout: 10_000 });
        await page.waitForFunction(() => (window as unknown as { __coysFarm: FarmHook }).__coysFarm.land().posts > 0, undefined, { timeout: 10_000 });
        await check('east field going up');
        await page.waitForFunction(() => (window as unknown as { __coysFarm: FarmHook }).__coysFarm.land().waiting === 0, undefined, { timeout: 20_000 });
        await page.waitForTimeout(700);
        expect((await camera(page)).x, `${size}: the camera went east`).toBeGreaterThan(0);
        await page.getByText('THE EAST FIELD IS YOURS', { exact: false }).first().waitFor({ timeout: 5000 });
        await page.locator('[data-ui="farm-map"]').waitFor();
        await check('east field');

        // the south orchard next, at the second price
        await page.locator('[data-tour="shop"]').first().click();
        await page.locator('[data-tour="shop-land"]').first().click();
        await expect(page.locator('[data-ui="land-east"]').innerText()).resolves.toContain('OWNED');
        await expect(page.locator('[data-ui="buy-land-south"]').innerText()).resolves.toBe(`BUY ${ECONOMY.land.prices[1]}`);
        await check('land tab with the east field');
        await page.locator('[data-ui="buy-land-south"]').click();
        await page.locator('[data-ui="modal"]').waitFor({ state: 'detached', timeout: 10_000 });
        await page.waitForFunction(() => (window as unknown as { __coysFarm: FarmHook }).__coysFarm.land().posts > 0, undefined, { timeout: 10_000 });
        await page.waitForFunction(() => (window as unknown as { __coysFarm: FarmHook }).__coysFarm.land().waiting === 0, undefined, { timeout: 20_000 });
        await page.waitForTimeout(700);
        expect((await camera(page)).y, `${size}: the camera went south`).toBeGreaterThan(0);
        await check('south orchard');

        // HOME brings the home plot back
        await page.locator('[data-ui="farm-home"]').click();
        await page.waitForFunction(() => {
          const c = (window as unknown as { __coysFarm: FarmHook }).__coysFarm.camera();
          return c.x === 0 && c.y === 0;
        });
        await check('home again');

        // drag the farm from the farmhouse: the world moves with the pointer, the page does not, and
        // letting go does not open the farmhouse
        const before = await farmhouse(page);
        if (!before) throw new Error('no farmhouse');
        const from = { x: before.x + before.w / 2, y: before.y + before.h / 2 };
        await page.mouse.move(from.x, from.y);
        await page.mouse.down();
        for (let i = 1; i <= 10; i++) await page.mouse.move(from.x - 12 * i, from.y - 10 * i);
        await page.mouse.up();
        await page.waitForTimeout(400);
        const cam = await camera(page);
        expect(cam.x, `${size}: dragged east`).toBeGreaterThan(0);
        expect(cam.y, `${size}: dragged south`).toBeGreaterThan(0);
        expect(await page.locator('[data-ui="modal"]').count(), `${size}: the drag opened something`).toBe(0);
        // the farmhouse moved on screen by the camera's move (in CSS pixels)
        const after = await farmhouse(page);
        expect(after && after.x < before.x && after.y < before.y, `${size}: the farmhouse moved with the farm`).toBe(true);
        // the small map's frame shows where the view is
        const frame = await page.locator('[data-ui="farm-map-view"]').boundingBox();
        const map = await page.locator('[data-ui="farm-map"]').boundingBox();
        expect(frame && map && frame.x > map.x && frame.y > map.y, `${size}: the map's frame moved off the home plot`).toBe(true);
        await check('dragged');

        // with the camera moved, a click on a thing still hits it: the first farm object whose middle
        // is on the canvas (not under the UI) opens its card
        const thing = await page.evaluate(() => {
          const all = (window as unknown as { __coysFarm: FarmHook }).__coysFarm.targets().filter((t) => ['farmhouse', 'crate', 'feed', 'coop'].includes(t.kind));
          for (const t of all) {
            const x = t.x + t.w / 2;
            const y = t.y + t.h / 2;
            if (x > 0 && y > 0 && x < innerWidth && y < innerHeight && document.elementFromPoint(x, y)?.tagName === 'CANVAS') return { kind: t.kind, x, y };
          }
          return null;
        });
        expect(thing, `${size}: something to click on screen`).not.toBeNull();
        if (thing) {
          await page.mouse.click(thing.x, thing.y);
          await page.locator('[data-ui="modal"]').waitFor({ timeout: 5000 });
          await check(`clicked the ${thing.kind} after the drag`);
          await page.keyboard.press('Escape');
          await page.waitForTimeout(300);
          expect(await camera(page), `${size}: a click does not move the camera`).toEqual(cam);
        }

        // the arrow keys move the camera back
        await page.keyboard.down('ArrowLeft');
        await page.keyboard.down('ArrowUp');
        await page.waitForTimeout(500);
        await page.keyboard.up('ArrowLeft');
        await page.keyboard.up('ArrowUp');
        const keyed = await camera(page);
        expect(keyed.x, `${size}: the arrow keys moved it`).toBeLessThan(cam.x);
        expect(keyed.y).toBeLessThan(cam.y);
        await check('keys');

        // a tap on the small map looks there; HOME comes back
        if (map) await page.mouse.click(map.x + map.width - 2, map.y + map.height - 2);
        await page.waitForTimeout(800);
        const looked = await camera(page);
        expect(looked.x > 0 || looked.y > 0, `${size}: the map moved the view`).toBe(true);
        await page.locator('[data-ui="farm-home"]').click();
        await page.waitForFunction(() => {
          const c = (window as unknown as { __coysFarm: FarmHook }).__coysFarm.camera();
          return c.x === 0 && c.y === 0;
        });
        // a click on the farmhouse at home still opens it (targets are where they are drawn)
        const house = await farmhouse(page);
        if (house) await page.mouse.click(house.x + house.w / 2, house.y + house.h / 2);
        await page.locator('[data-ui="modal"]').waitFor({ timeout: 5000 });
        await page.keyboard.press('Escape');
        await check('home at last');
      } finally {
        await ctx.close();
      }
      expect(problems).toEqual([]);
    }, 300_000);
  }
});
