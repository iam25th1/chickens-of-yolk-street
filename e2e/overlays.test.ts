// Overlays never cover each other. At each sweep size, with the tour on: every tour step with no card,
// with a hen's card open, and with each kind of card and page open; and badges earned during the tour
// while a hen's card is open. No two of the open card (modal or page), the tour bubble, the badge or
// milestone toast and the new-version prompt may overlap; every button on the card and in the bubble
// must take a tap (nothing over it); the toast sits in the toast corner, and three badges at once come
// one at a time. The built client and the real server, in a fresh headless browser with nothing kept.
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

const OVERLAYS = ['[data-ui="modal"]', '[data-ui="market-page"]', '[data-ui="profile-page"]', '[data-ui="tour-place"]', '[data-ui="announce"]', '[data-ui="update-prompt"]'];

/** Run in the page: pairs of overlays that overlap, and buttons on a card or in the bubble that something else covers. */
function overlayProblems(selectors: string[]): string[] {
  const out: string[] = [];
  const boxes: { name: string; r: DOMRect }[] = [];
  for (const sel of selectors) {
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden') boxes.push({ name: sel, r });
    }
  }
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]?.r;
      const b = boxes[j]?.r;
      if (!a || !b) continue;
      // a pixel of shared edge is not an overlap
      if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) out.push(`${boxes[i]?.name} overlaps ${boxes[j]?.name}`);
    }
  }
  for (const host of document.querySelectorAll('[data-ui="modal"], [data-ui="market-page"], [data-ui="profile-page"], [data-ui="tour-place"], [data-ui="announce"]')) {
    const buttons = host.matches('button') ? [host] : [...host.querySelectorAll('button')];
    for (const btn of buttons) {
      const r = btn.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      // a button scrolled away inside a page (another page of a list) is not on screen to tap
      if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
      if (getComputedStyle(btn).visibility === 'hidden' || btn.closest('[aria-hidden="true"]')) continue;
      if (!hit || !(btn === hit || btn.contains(hit))) out.push(`a button "${(btn.textContent ?? '').trim().slice(0, 20)}" in ${host.getAttribute('data-ui')} is covered by ${hit ? `${hit.tagName.toLowerCase()}.${(hit as HTMLElement).className}`.slice(0, 40) : 'nothing'}`);
    }
  }
  return out;
}

async function signIn(page: Page, name: string): Promise<void> {
  await page.goto(`${server.url}/`);
  await page.locator('[data-ui="title-sign-in"]').waitFor({ timeout: 60_000 });
  await page.waitForTimeout(800);
  await page.locator('[data-ui="title-sign-in"]').click({ force: true });
  const field = page.getByPlaceholder('FARMER NAME');
  await field.waitFor({ timeout: 15_000 });
  await field.fill(name);
  await field.press('Enter');
  await page.locator('[data-ui="topbar"]').waitFor({ timeout: 60_000 });
}

type Hooks = { __coysTour: { count: number; show(step: number): void }; __coysUi: { open(m: unknown): void; close(): void }; __coysFarm: { targets(): { kind: string; id?: string }[] } };

describe('overlays never cover each other', () => {
  for (const [w, h, dpr] of sizes([
    [1280, 720, 1],
    [1920, 1080, 1],
    [390, 844, 3],
    [360, 640, 2],
    [768, 1024, 2],
  ] as const)) {
    it(`at ${w}x${h}: every tour step beside every card, and badge toasts during the tour with a hen's card open`, async () => {
      const size = `${w}x${h}`;
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr, isMobile: w < 600, hasTouch: w < 600 });
      const page = await ctx.newPage();
      const problems: string[] = [];
      const check = async (what: string) => {
        for (const p of await page.evaluate(overlayProblems, OVERLAYS)) problems.push(`${size} ${what}: ${p}`);
      };
      const shot = async (what: string) => {
        if (shotsDir) await page.screenshot({ path: `${shotsDir}/overlays-${size}-${what}.png`, scale: 'css' });
      };
      const name = `Overlay ${w}x${h}`;
      try {
        server.hold(true);
        await signIn(page, name);
        await server.seed(name, 3);
        await page.locator('[data-ui="tour"]').waitFor({ timeout: 15_000 });
        await page.waitForFunction(() => (window as unknown as Hooks).__coysFarm?.targets().some((t) => t.kind === 'hen'), undefined, { timeout: 30_000 });
        const henId = await page.evaluate(() => (window as unknown as Hooks).__coysFarm.targets().find((t) => t.kind === 'hen')?.id ?? '');
        const count = await page.evaluate(() => (window as unknown as Hooks).__coysTour.count);
        const cards: { label: string; modal: unknown }[] = [
          { label: 'hen', modal: { kind: 'hen', henId } },
          { label: 'shop', modal: { kind: 'shop', tab: 'machines' } },
          { label: 'ledger', modal: { kind: 'ledger' } },
          { label: 'feathers', modal: { kind: 'feathers' } },
          { label: 'guide', modal: { kind: 'guide' } },
          { label: 'market', modal: { kind: 'market', tab: 'prices' } },
          { label: 'profile', modal: { kind: 'profile', tab: 'badges' } },
        ];
        const show = async (step: number, modal: unknown) => {
          await page.evaluate(
            ([s, m]) => {
              const hooks = window as unknown as Hooks;
              hooks.__coysUi.close();
              hooks.__coysTour.show(s as number);
              if (m) hooks.__coysUi.open(m);
            },
            [step, modal] as const,
          );
          // the bubble's drop-in and the card's open (and a dock, when the card makes room) settle
          await page.waitForTimeout(900);
        };
        // every step with no card and with a hen's card open
        for (let s = 0; s < count; s++) {
          await show(s, null);
          await check(`step ${s + 1}, no card`);
          await show(s, cards[0]?.modal);
          await check(`step ${s + 1}, hen card`);
        }
        // each kind of card and page, at the first, a middle and the last step
        for (const c of cards) {
          for (const s of [0, Math.floor(count / 2), count - 1]) {
            await show(s, c.modal);
            await check(`step ${s + 1}, ${c.label}`);
            if (s === 0) await shot(`${c.label}`);
          }
        }

        // badges earned during the tour while a hen's card is open: a toast in the toast corner, the
        // card and the bubble untouched and still tappable; three at once come one at a time
        await show(2, cards[0]?.modal);
        await server.badge(name, 'first-haggle', 'plain');
        await server.badge(name, 'number-one', 'gold');
        await server.badge(name, 'big-flock', 'bronze');
        const seen: string[] = [];
        const t0 = Date.now();
        while (seen.length < 3 && Date.now() - t0 < 30_000) {
          const now = await page.locator('[data-ui="announce"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-badge') ?? ''));
          expect(now.length, `${size}: one toast at a time`).toBeLessThanOrEqual(1);
          const b = now[0];
          if (b && !seen.includes(b)) {
            seen.push(b);
            await page.waitForTimeout(350);
            await check(`badge toast ${b}`);
            // the toast is in the toast corner, clear of the card and the bubble
            const inCorner = await page.evaluate(() => {
              const a = document.querySelector('[data-ui="announce"]')?.getBoundingClientRect();
              const z = document.querySelector('[data-ui="toasts"]')?.getBoundingClientRect();
              return !!a && !!z && a.left >= z.left - 1 && a.right <= z.right + 1 && a.top >= z.top - 1 && a.bottom <= z.bottom + 1;
            });
            expect(inCorner, `${size}: the toast ${b} is in the toast corner`).toBe(true);
            expect(await page.locator('[data-ui="modal"]').count(), `${size}: the hen's card stays open`).toBe(1);
            expect(await page.locator('[data-ui="tour-place"]').count(), `${size}: the tour bubble stays`).toBe(1);
            if (seen.length === 1) await shot('badge-toast');
          }
          await page.waitForTimeout(150);
        }
        expect(seen.sort(), `${size}: the three badges each came as a toast`).toEqual(['big-flock', 'first-haggle', 'number-one']);
        // the hen's card and the bubble still take taps: the bubble's BACK and the card's close button
        await page.locator('[data-ui="tour-back"]').click({ trial: true });
        await page.locator('[data-ui="modal"] button').first().click({ trial: true });
        if (problems.length && process.env.OVERLAY_DEBUG) console.log([...new Set(problems.map((p) => p.replace(/step \d+/, 'step N')))].join('\n'));
        expect(problems).toEqual([]);
      } finally {
        server.hold(false);
        await ctx.close();
      }
    }, 900_000);
  }
});
