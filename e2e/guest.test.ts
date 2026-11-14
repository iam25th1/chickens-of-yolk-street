// Guest play in the browser: PLAY reaches a working farm in one click with no sign-in screen (the
// session is an HttpOnly cookie the page cannot read); a guest collects and sells; a Feather ticket
// won brings the card that says it is saved and minting needs signing in; about ten minutes of play
// brings one offer to save the farm, which LATER dismisses for the session; SAVE THIS FARM is in
// Settings and on the profile, and the mint asks a guest to sign in. Nothing is cut off at any size.
// The built client and the real server, in a fresh headless browser with nothing kept.
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { overflowing } from './overflow';
import { sizes } from './sizes';
import { startTestServer, type TestServer } from './server';

let server: TestServer;
let browser: Browser;
const shotsDir = process.env.SHOTS_DIR;

beforeAll(async () => {
  server = await startTestServer();
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined, args: ['--disable-sync', '--no-first-run', '--disable-extensions'] });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

type Target = { kind: string; id?: string; x: number; y: number; w: number; h: number };
const targets = (page: Page): Promise<Target[]> =>
  page.evaluate(() => (window as unknown as { __coysFarm?: { targets(): Target[] } }).__coysFarm?.targets() ?? []);

const shot = async (page: Page, what: string, size: string) => {
  if (shotsDir) await page.screenshot({ path: `${shotsDir}/guest-${size}-${what}.png`, scale: 'css' });
};

describe('guest play', () => {
  for (const [w, h, dpr] of sizes([
    [1280, 720, 1],
    [1920, 1080, 1],
    [390, 844, 3],
    [360, 640, 2],
    [768, 1024, 2],
  ] as const)) {
    it(`at ${w}x${h}: PLAY to a working guest farm in one click, collect and sell, the ticket card, the ten-minute offer and LATER`, async () => {
      const size = `${w}x${h}`;
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, isMobile: w < 600, hasTouch: w < 600 });
      const page = await ctx.newPage();
      const problems: string[] = [];
      const check = async (what: string) => {
        for (const p of await page.evaluate(overflowing)) problems.push(`${what}: ${p}`);
      };
      try {
        await page.goto(`${server.url}/`);
        const play = page.locator('[data-ui="title-play"]');
        await play.waitFor({ timeout: 60_000 });
        await page.locator('[data-ui="title-sign-in"]').waitFor();
        await page.waitForTimeout(800);
        await check('title');
        await shot(page, '1-title', size);

        // one click: no sign-in screen, the farm and its top bar
        const started = page.waitForResponse((r) => r.url().endsWith('/api/login/guest'));
        await play.click({ force: true });
        const name = ((await (await started).json()) as { name: string }).name;
        await page.locator('[data-ui="topbar"]').waitFor({ timeout: 60_000 });
        expect(await page.getByPlaceholder('FARMER NAME').count()).toBe(0);
        expect(await page.locator('[data-ui="name-farm"]').count()).toBe(0);
        expect((await server.farmNow(name)).guest).toBe(true);
        // the session is an HttpOnly, Secure, SameSite=Lax cookie; the page holds no token
        const cookie = (await ctx.cookies()).find((c) => c.name === 'coys_guest');
        expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax' });
        expect(await page.evaluate(() => document.cookie)).not.toContain('coys_guest');
        expect(await page.evaluate(() => localStorage.getItem('coys.session'))).toBeNull();
        // the tour starts on its own for a new farm; it is ended here
        await page.locator('[data-ui="tour"]').waitFor({ timeout: 15_000 });
        await page.evaluate(() => (window as unknown as { __coysTour?: { end(): void } }).__coysTour?.end());
        await page.waitForTimeout(500);
        await check('guest farm');
        await shot(page, '2-farm', size);

        // collect: an egg a hen laid (one in plain view, not under a panel) goes into the crate
        const before = await server.farmNow(name);
        await expect
          .poll(
            async () => {
              const open = (await targets(page)).filter((t) => t.kind === 'egg');
              for (const egg of open) {
                const x = egg.x + egg.w / 2;
                const y = egg.y + egg.h / 2;
                if (!(await page.evaluate(([px, py]) => document.elementFromPoint(px ?? 0, py ?? 0)?.tagName === 'CANVAS', [x, y]))) continue;
                await page.mouse.click(x, y);
                await page.waitForTimeout(400);
                if ((await server.farmNow(name)).crate > before.crate) return true;
              }
              return (await server.farmNow(name)).crate > before.crate;
            },
            { timeout: 90_000, interval: 1000 },
          )
          .toBe(true);

        // sell: the crate's SELL button (on the side panel, or on the crate's card where the panel is folded away)
        const cashBefore = (await server.farmNow(name)).cashMilli;
        const desk = page.locator('[data-tour="sell"]:not([disabled]) >> visible=true');
        await page.waitForTimeout(500);
        // (a tap meant for an egg can land on a hen that walked onto it, or a card may have come: close what opened)
        for (let i = 0; i < 4 && (await page.locator('[data-ui="backdrop"]').count()); i++) {
          await page.keyboard.press('Escape');
          await page.waitForTimeout(400);
        }
        if (await desk.count()) await desk.first().click();
        else {
          await page.evaluate(() => (window as unknown as { __coysUi: { open(m: unknown): void } }).__coysUi.open({ kind: 'sell' }));
          await page.locator('[data-tour="sell-modal"]:not([disabled])').click();
        }
        await expect.poll(async () => (await server.farmNow(name)).crate, { timeout: 10_000 }).toBe(0);
        expect((await server.farmNow(name)).cashMilli).toBeGreaterThan(cashBefore);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(600);

        // a Feather ticket won: the card says it is saved and that minting needs signing in
        await server.ticketWon(name);
        const card = page.locator('[data-ui="save-farm"][data-reason="ticket"]');
        await card.waitFor({ timeout: 15_000 });
        const text = await card.innerText();
        expect(text).toContain('IT IS SAVED ON THIS FARM');
        expect(text).toContain('SIGN IN TO MINT IT. FEATHERS NEED A NEAR WALLET, MADE FOR YOU WITH NO SEED PHRASE.');
        await page.waitForTimeout(700);
        await check('ticket card');
        await shot(page, '3-ticket-card', size);
        await page.locator('[data-ui="save-later"]').click();
        await card.waitFor({ state: 'detached' });

        // the mint: a guest's MINT asks to sign in (the mint itself is the one thing that waits)
        await page.locator('[data-ui="feathers-button"]').click();
        await page.locator('[data-ui="mint-page"]').waitFor();
        await page.locator('[data-ui="mint-guest"] >> visible=true').first().waitFor();
        await page.locator('[data-ui="mint-button"]:not([disabled]) >> visible=true').first().click();
        await page.locator('[data-ui="save-farm"][data-reason="mint"]').waitFor();
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);

        // about ten minutes of play (a simulated clock): one offer to save the farm, and LATER is final for the session.
        // The real time already played counts too, so the clock goes to a minute short of ten, then past it.
        // (a real milestone roll at a day close may bring a ticket card meanwhile: only the offer is looked at)
        const nudge = page.locator('[data-ui="save-farm"][data-reason="nudge"]');
        expect(await nudge.count()).toBe(0);
        const played = await page.evaluate(() => (window as unknown as { __coysGuest: { played(): number } }).__coysGuest.played());
        expect(played).toBeLessThan(9 * 60 * 1000);
        await page.evaluate((ms) => (window as unknown as { __coysGuest: { play(ms: number): void } }).__coysGuest.play(ms), 9 * 60 * 1000 - played);
        await page.waitForTimeout(600);
        expect(await nudge.count()).toBe(0);
        for (let i = 0; i < 4 && (await page.locator('[data-ui="save-farm"]').count()); i++) {
          await page.keyboard.press('Escape');
          await page.waitForTimeout(400);
        }
        await page.evaluate(() => (window as unknown as { __coysGuest: { play(ms: number): void } }).__coysGuest.play(2 * 60 * 1000));
        await nudge.waitFor({ timeout: 5000 });
        await page.waitForTimeout(700);
        await check('ten-minute offer');
        await shot(page, '4-nudge', size);
        await page.locator('[data-ui="save-later"]').click();
        await nudge.waitFor({ state: 'detached' });
        await page.evaluate(() => (window as unknown as { __coysGuest: { play(ms: number): void } }).__coysGuest.play(30 * 60 * 1000));
        await page.waitForTimeout(1500);
        expect(await nudge.count()).toBe(0);
        // a reload in the same session: the same guest farm with PLAY, and no second offer
        await page.reload();
        await play.waitFor({ timeout: 60_000 });
        await page.waitForTimeout(800);
        const again = page.waitForResponse((r) => r.url().endsWith('/api/login/guest'));
        await play.click({ force: true });
        expect(((await (await again).json()) as { name: string }).name).toBe(name);
        await page.locator('[data-ui="topbar"]').waitFor({ timeout: 60_000 });
        await page.evaluate(() => (window as unknown as { __coysGuest: { play(ms: number): void } }).__coysGuest.play(30 * 60 * 1000));
        await page.waitForTimeout(1500);
        expect(await page.locator('[data-ui="save-farm"][data-reason="nudge"]').count()).toBe(0);

        // SAVE THIS FARM in Settings opens the sign-in that carries the farm; BACK returns to the farm
        await page.locator('[data-tour="settings"]').first().click();
        await page.locator('[data-ui="save-farm-setting"]').waitFor();
        await check('settings');
        await page.locator('[data-ui="save-farm-settings"]').click();
        await page.locator('[data-ui="save-farm"][data-reason="settings"]').waitFor();
        await page.locator('[data-ui="save-sign-in"]').click();
        await page.getByText('SAVE YOUR FARM', { exact: true }).waitFor({ timeout: 15_000 });
        await page.waitForTimeout(600);
        await check('save your farm');
        await shot(page, '5-sign-in', size);
        await page.getByRole('button', { name: 'BACK' }).click();
        await page.locator('[data-ui="topbar"]').waitFor({ timeout: 60_000 });
        expect((await server.farmNow(name)).guest).toBe(true);
        // and on the profile, with the GUEST tag on the farms ranking
        await page.locator('[data-tour="profile"]').first().click();
        await page.locator('[data-ui="profile-save"]').waitFor();
        await page.waitForTimeout(600);
        await check('profile');
        await page.locator('[data-ui="profile-close"]').click();
        await page.locator('[data-ui="market-button"]').click();
        await page.locator('[data-tour="market-farms"]').click();
        const mine = page.locator('[data-ui="ranking-row"]', { hasText: name.toUpperCase() });
        await mine.first().waitFor({ timeout: 10_000 });
        expect(await mine.first().locator('.guest-tag').count()).toBe(1);
        expect(problems).toEqual([]);
      } finally {
        await ctx.close();
      }
    }, 600_000);

    it(`at ${w}x${h}: signing in from a guest farm to an account that has a farm asks which to keep, and keeping the guest farm carries it over`, async () => {
      const size = `${w}x${h}`;
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, isMobile: w < 600, hasTouch: w < 600 });
      const page = await ctx.newPage();
      const problems: string[] = [];
      const check = async (what: string) => {
        for (const p of await page.evaluate(overflowing)) problems.push(`${what}: ${p}`);
      };
      const endTour = () => page.evaluate(() => (window as unknown as { __coysTour?: { end(): void } }).__coysTour?.end());
      try {
        // an account with a farm (the local dev login stands in for email sign-in)
        await page.goto(`${server.url}/`);
        await page.locator('[data-ui="title-sign-in"]').waitFor({ timeout: 60_000 });
        await page.waitForTimeout(800);
        await page.locator('[data-ui="title-sign-in"]').click({ force: true });
        const field = page.getByPlaceholder('FARMER NAME');
        await field.waitFor({ timeout: 15_000 });
        const account = `Keeper ${w}x${h}`;
        await field.fill(account);
        await field.press('Enter');
        await page.locator('[data-ui="topbar"]').waitFor({ timeout: 60_000 });
        await endTour();
        // the same browser, signed out (its device stays the same), plays as a guest
        await page.evaluate(() => localStorage.removeItem('coys.session'));
        await page.reload();
        await page.locator('[data-ui="title-play"]').waitFor({ timeout: 60_000 });
        await page.waitForTimeout(800);
        const started = page.waitForResponse((r) => r.url().endsWith('/api/login/guest'));
        await page.locator('[data-ui="title-play"]').click({ force: true });
        const guestName = ((await (await started).json()) as { name: string }).name;
        await page.locator('[data-ui="topbar"]').waitFor({ timeout: 60_000 });
        await page.locator('[data-ui="tour"]').waitFor({ timeout: 15_000 });
        await endTour();
        await page.waitForTimeout(400);
        // SAVE THIS FARM, then sign in to the account that has a farm: choose
        await page.locator('[data-tour="settings"]').first().click();
        await page.locator('[data-ui="save-farm-settings"]').click();
        await page.locator('[data-ui="save-sign-in"]').click();
        const again = page.getByPlaceholder('FARMER NAME');
        await again.waitFor({ timeout: 15_000 });
        await page.locator('button', { hasText: 'START FARMING' }).click();
        const choose = page.locator('[data-ui="choose-farm"]');
        await choose.waitFor({ timeout: 15_000 });
        expect(await page.locator('[data-ui="choose-guest"]').innerText()).toContain(guestName.toUpperCase());
        expect(await page.locator('[data-ui="choose-account"]').innerText()).toContain(account.toUpperCase());
        await page.waitForTimeout(700);
        await check('choose a farm');
        await shot(page, '6-choose', size);
        await page.locator('[data-ui="keep-guest"]').click();
        // the guest farm is the account's now: offered a free rename (KEEP keeps the name), and no longer a guest
        await page.locator('[data-ui="topbar"]').waitFor({ timeout: 60_000 });
        await page.locator('[data-ui="name-keep"]').waitFor({ timeout: 15_000 });
        // (the farm screen slides in: checked once it has settled)
        await page.waitForTimeout(1200);
        await check('rename after sign-in');
        await shot(page, '7-rename', size);
        await page.locator('[data-ui="name-keep"]').click();
        await expect.poll(async () => (await server.farmNow(guestName)).guest, { timeout: 10_000 }).toBe(false);
        expect(await page.evaluate(() => localStorage.getItem('coys.session'))).not.toBeNull();
        expect((await ctx.cookies()).find((c) => c.name === 'coys_guest')).toBeUndefined();
        await page.waitForTimeout(600);
        await page.locator('[data-tour="settings"]').first().click();
        await page.locator('[data-ui="farm-name-setting"]').waitFor();
        expect(await page.locator('[data-ui="farm-name-setting"]').innerText()).toContain(guestName.toUpperCase());
        expect(await page.locator('[data-ui="save-farm-setting"]').count()).toBe(0);
        expect(problems).toEqual([]);
      } finally {
        await ctx.close();
      }
    }, 600_000);
  }
});
