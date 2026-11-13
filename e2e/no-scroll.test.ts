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
  [1180, 820, 2],
  [412, 915, 2],
];
/** E2E_SIZES=1280x720,360x640 checks only those (a quick run); every size by default. */
const SIZES = process.env.E2E_SIZES ? ALL_SIZES.filter(([w, h]) => process.env.E2E_SIZES?.split(',').includes(`${w}x${h}`)) : ALL_SIZES;
/** The sizes whose screens are saved as screenshots (desktop and phone). */
const SHOTS = new Set(['1280x720', '390x844']);
const shotsDir = fileURLToPath(new URL('../docs/screenshots/', import.meta.url));

/**
 * Run in the page: every element that scrolls (overflow auto or scroll, with more content than room),
 * every element that clips content (overflow hidden, or an ellipsis, with a piece of text, a button
 * or a picture reaching past its edge), and the page itself if it scrolls. A marquee ([data-marquee],
 * the price ticker) runs its text past on purpose and is left out.
 */
function overflowing(): string[] {
  const out: string[] = [];
  const isContent = (e: Element): boolean => {
    if (e.closest('[data-marquee]')) return false;
    if (/^(BUTTON|INPUT|IMG|A)$/.test(e.tagName) || (e.tagName === 'CANVAS' && e.classList.contains('sprite'))) return true;
    for (const n of e.childNodes) if (n.nodeType === 3 && (n.textContent ?? '').trim()) return true;
    return false;
  };
  /** Where a content element really draws: its own box, or for text the text itself (a centred line is narrower than its box). */
  const drawn = (e: Element): DOMRect => {
    if (/^(BUTTON|INPUT|IMG|A|CANVAS)$/.test(e.tagName)) return e.getBoundingClientRect();
    const range = document.createRange();
    let rect: DOMRect | null = null;
    for (const n of e.childNodes) {
      if (n.nodeType !== 3 || !(n.textContent ?? '').trim()) continue;
      range.selectNodeContents(n);
      const r = range.getBoundingClientRect();
      rect = rect ? new DOMRect(Math.min(rect.left, r.left), Math.min(rect.top, r.top), Math.max(rect.right, r.right) - Math.min(rect.left, r.left), Math.max(rect.bottom, r.bottom) - Math.min(rect.top, r.top)) : r;
    }
    return rect ?? e.getBoundingClientRect();
  };
  const shown = (e: Element): boolean => {
    const cs = getComputedStyle(e);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0;
  };
  for (const el of document.querySelectorAll<HTMLElement>('body *')) {
    if (el.tagName === 'CANVAS' || el.closest('[data-marquee]')) continue;
    if (!shown(el)) continue;
    const cs = getComputedStyle(el);
    const sy = el.scrollHeight - el.clientHeight;
    const sx = el.scrollWidth - el.clientWidth;
    if (sy <= 1 && sx <= 1) continue;
    const ov = `${cs.overflowX} ${cs.overflowY}`;
    const name = (el.dataset.ui ?? el.dataset.tour ?? (String(el.className) || el.tagName)).slice(0, 32);
    if (/auto|scroll/.test(ov)) {
      out.push(`SCROLLS ${name}${sx > 1 ? ` x+${sx}` : ''}${sy > 1 ? ` y+${sy}` : ''} "${(el.textContent ?? '').trim().slice(0, 32)}"`);
      continue;
    }
    if (!/hidden|clip/.test(ov) && cs.textOverflow !== 'ellipsis') continue;
    // which content pokes out of this box
    const box = el.getBoundingClientRect();
    if (cs.textOverflow === 'ellipsis' && isContent(el)) {
      out.push(`CUTS ${name} "${(el.textContent ?? '').trim().slice(0, 40)}"`);
      continue;
    }
    for (const c of el.querySelectorAll('*')) {
      if (!isContent(c) || !shown(c)) continue;
      const r = drawn(c);
      if (r.width === 0 || r.height === 0) continue;
      if (r.left < box.left - 1 || r.right > box.right + 1 || r.top < box.top - 1 || r.bottom > box.bottom + 1) {
        out.push(`CLIPS ${name}: "${(c.textContent ?? c.tagName).trim().slice(0, 40)}" at ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)} in ${Math.round(box.left)},${Math.round(box.top)} ${Math.round(box.width)}x${Math.round(box.height)}`);
        break;
      }
    }
  }
  // nothing is cut by the window either
  for (const c of document.querySelectorAll('body *')) {
    if (!isContent(c) || !shown(c)) continue;
    const r = drawn(c);
    if (r.width === 0 || r.height === 0) continue;
    if (r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1) {
      out.push(`OFF SCREEN "${(c.textContent ?? c.tagName).trim().slice(0, 40)}" at ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
  }
  const d = document.scrollingElement;
  if (d && (d.scrollHeight > innerHeight + 1 || d.scrollWidth > innerWidth + 1)) out.push(`PAGE SCROLLS x+${d.scrollWidth - innerWidth} y+${d.scrollHeight - innerHeight}`);
  return out;
}

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
        await tabs('shop', ['shop-hens', 'shop-feed', 'shop-coops', 'shop-machines']);
        await tabs('market', ['market-board', 'market-farms', 'market-orders', 'market-trades']);
        await tabs('ledger', ['ledger-days', 'ledger-contracts', 'ledger-feathers', 'ledger-milestones']);
        await open('settings');
        await walk('settings');
        await open('help');
        await walk('guide', 80);
        // the mint page and its tabs (the grid's pages are all alike: a few are enough)
        await open('feathers');
        await page.locator('[data-ui="mint-page"]').waitFor();
        for (const label of ['YOUR TICKETS', 'ALL 777', 'ODDS', 'ABOUT']) {
          await page.locator('[data-ui="mint-tabs"] button', { hasText: label }).first().click();
          await page.waitForTimeout(500);
          await walk(`mint page ${label.toLowerCase()}`, label === 'ALL 777' ? 3 : 12);
        }
        // the cards the farm's things open, and a waiting offer
        await page.keyboard.press('Escape');
        const targets = await page.evaluate(() => (window as unknown as { __coysFarm?: { targets(): { kind: string; x: number; y: number; w: number; h: number }[] } }).__coysFarm?.targets() ?? []);
        for (const kind of ['hen', 'machine', 'crate', 'feed', 'coop', 'farmhouse']) {
          const t = targets.find((x) => x.kind === kind);
          if (!t) continue;
          await page.keyboard.press('Escape');
          await page.waitForTimeout(200);
          await page.mouse.click((t.x + t.w / 2) / dpr, (t.y + t.h / 2) / dpr);
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
    }, 600_000);
  }

  it('found nothing', () => {
    expect(problems).toEqual([]);
  });
});
