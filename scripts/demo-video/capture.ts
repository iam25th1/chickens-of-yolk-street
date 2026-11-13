// Records the demo video's gameplay from the game itself, on the LOCAL copy (local.ts): Playwright
// Chromium, a 1920x1080 viewport at device scale 1, a fresh profile that is never signed in, the demo
// session instead of any login screen. Each scene is its own clip: the page's frames as Chrome paints
// them (CDP screencast, JPEG quality 95, each with its timestamp) and a log of when each key action
// happened, both written to <out>/<scene>/. build.py turns them into 30 fps footage.
//
//   npx tsx scripts/demo-video/capture.ts [--out ~/Documents/coys-demo/capture] [--only title,market,...] [--day-seconds 600]
// (the haggle scene runs with a long local day, so the day's cards have all arrived and the day does
// not close, expiring them, in the middle of a haggle)
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium, type CDPSession, type Page } from 'playwright-core';
import { startLocal, type LocalServer } from './local';
import { FRESH_FARM, LATE_FARM } from './names';

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => (args.includes(name) ? (args[args.indexOf(name) + 1] ?? fallback) : fallback);
const OUT = opt('--out', join(homedir(), 'Documents/coys-demo/capture'));
const DAY_SECONDS = Number(opt('--day-seconds', '0')) || undefined;
const ONLY = opt('--only', '').split(',').filter(Boolean);
const W = 1920;
const H = 1080;

interface Frame {
  file: string;
  t: number;
}
interface Action {
  t: number;
  kind: string;
  label: string;
}

/** One scene's clip: frames while it is open, and its actions, timed from its first frame. */
class Recorder {
  private scene: string | null = null;
  private frames: Frame[] = [];
  private actions: Action[] = [];
  private t0 = 0;
  private n = 0;
  constructor(private readonly cdp: CDPSession) {
    cdp.on('Page.screencastFrame', (f: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
      void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined);
      if (!this.scene) return;
      const t = (f.metadata.timestamp ?? Date.now() / 1000) * 1000;
      if (!this.frames.length) this.t0 = t;
      const file = `f-${String(++this.n).padStart(5, '0')}.jpg`;
      writeFileSync(join(OUT, this.scene, file), Buffer.from(f.data, 'base64'));
      this.frames.push({ file, t: (t - this.t0) / 1000 });
    });
  }
  async start(): Promise<void> {
    await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 95, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
  }
  begin(scene: string): void {
    const dir = join(OUT, scene);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    this.scene = scene;
    this.frames = [];
    this.actions = [];
    this.n = 0;
    this.t0 = 0;
  }
  /** Logs a key action at this moment (seconds from the clip's first frame). */
  act(kind: string, label = ''): void {
    if (!this.scene) return;
    const now = Date.now() / 1000;
    const t = this.frames.length ? now - this.t0 / 1000 : 0;
    this.actions.push({ t: Math.max(0, Math.round(t * 1000) / 1000), kind, label });
    console.log(`  ${this.scene} ${t.toFixed(2)}s ${kind} ${label}`);
  }
  end(): void {
    if (!this.scene) return;
    const last = this.frames.at(-1)?.t ?? 0;
    writeFileSync(join(OUT, this.scene, 'clip.json'), JSON.stringify({ scene: this.scene, duration: last + 0.05, frames: this.frames, actions: this.actions }, null, 1));
    console.log(`scene ${this.scene}: ${this.frames.length} frames, ${last.toFixed(1)} s, ${this.actions.length} actions`);
    this.scene = null;
  }
}

/** The game's own pixel cursor, mirrored in the page (a headless browser draws no cursor). */
const CURSOR = `
(() => {
  const make = () => {
    if (document.getElementById('demo-cursor')) return;
    const c = document.createElement('div');
    c.id = 'demo-cursor';
    c.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;image-rendering:pixelated;background-repeat:no-repeat;display:none';
    document.body.appendChild(c);
    let img = null;
    document.addEventListener('mousemove', (e) => {
      const v = document.querySelector('.viewport');
      const style = v ? getComputedStyle(v).cursor : '';
      const m = /url\\("?([^")]+)"?\\)\\s*(\\d+)?\\s*(\\d+)?/.exec(style);
      if (m && m[1] !== img) {
        img = m[1];
        const probe = new Image();
        probe.onload = () => { c.style.width = probe.width + 'px'; c.style.height = probe.height + 'px'; };
        probe.src = img;
        c.style.backgroundImage = 'url(' + img + ')';
        c.dataset.hx = m[2] || '0';
        c.dataset.hy = m[3] || '0';
      }
      if (!img) return;
      c.style.display = 'block';
      c.style.transform = 'translate(' + (e.clientX - Number(c.dataset.hx)) + 'px,' + (e.clientY - Number(c.dataset.hy)) + 'px)';
    }, true);
  };
  if (document.body) make(); else document.addEventListener('DOMContentLoaded', make);
})();
`;

interface Ctx {
  page: Page;
  rec: Recorder;
  hold(ms: number): Promise<void>;
  moveTo(x: number, y: number): Promise<void>;
  moveToSel(sel: string): Promise<{ x: number; y: number }>;
  click(sel: string, kind?: string, label?: string): Promise<void>;
  clickAt(x: number, y: number, kind?: string, label?: string): Promise<void>;
  farm(): Promise<{ kind: string; id?: string; x: number; y: number; w: number; h: number }[]>;
}

const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function makeCtx(page: Page, rec: Recorder): Ctx {
  let at = { x: W / 2, y: H / 2 };
  const moveTo = async (x: number, y: number) => {
    // human speed: about 900 px a second, eased
    const d = Math.hypot(x - at.x, y - at.y);
    const steps = Math.max(8, Math.round(d / 15));
    for (let i = 1; i <= steps; i++) {
      const k = i / steps;
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      await page.mouse.move(at.x + (x - at.x) * e, at.y + (y - at.y) * e);
      await pause(16);
    }
    at = { x, y };
  };
  const centre = async (sel: string) => {
    const box = await page.locator(`${sel} >> visible=true`).first().boundingBox();
    if (!box) throw new Error(`not on screen: ${sel}`);
    return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  };
  return {
    page,
    rec,
    hold: (ms) => pause(ms),
    moveTo,
    async moveToSel(sel) {
      const p = await centre(sel);
      await moveTo(p.x, p.y);
      return p;
    },
    async click(sel, kind = 'click', label = '') {
      const p = await centre(sel);
      await moveTo(p.x, p.y);
      await pause(180);
      rec.act(kind, label || sel);
      await page.mouse.click(p.x, p.y);
    },
    async clickAt(x, y, kind = 'click', label = '') {
      await moveTo(x, y);
      await pause(180);
      rec.act(kind, label);
      await page.mouse.click(x, y);
    },
    farm: () => page.evaluate(() => (globalThis as unknown as { __coysFarm?: { targets(): { kind: string; id?: string; x: number; y: number; w: number; h: number }[] } }).__coysFarm?.targets() ?? []),
  };
}

/** Opens the game as a demo farm: the title, PLAY (the demo session signs in), the farm. Not recorded unless asked. */
async function openFarm(c: Ctx, server: LocalServer, farm: string, opts: { record?: string; beforePlay?: () => Promise<void> } = {}): Promise<void> {
  await c.page.goto(`${server.url}/?demo=${encodeURIComponent(farm)}`);
  await c.page.getByText('PLAY', { exact: true }).waitFor({ timeout: 90_000 });
  await pause(1500);
  if (opts.record) c.rec.begin(opts.record);
  await opts.beforePlay?.();
  await c.click('text=PLAY >> nth=0', 'play', 'PLAY');
  await c.page.locator('[data-ui="topbar"]').waitFor({ timeout: 90_000 });
}

const endTour = (c: Ctx) => c.page.evaluate(() => (globalThis as unknown as { __coysTour?: { end(): void } }).__coysTour?.end());

async function waitEggs(c: Ctx, n: number, ms: number): Promise<void> {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if ((await c.farm()).filter((x) => x.kind === 'egg').length >= n) return;
    await pause(1000);
  }
}

/** Clicks an egg on the ground that no hen stands over. */
async function collectEgg(c: Ctx): Promise<boolean> {
  const t = await c.farm();
  const hens = t.filter((x) => x.kind === 'hen');
  const clear = (e: { x: number; y: number; w: number; h: number }) => !hens.some((h) => e.x < h.x + h.w && h.x < e.x + e.w && e.y < h.y + h.h && h.y < e.y + e.h);
  const egg = t.filter((x) => x.kind === 'egg').find(clear);
  if (!egg) return false;
  await c.clickAt(egg.x + egg.w / 2, egg.y + egg.h / 2, 'egg', 'collect');
  await pause(700);
  return true;
}

/** Opens the waiting card from the agent whose name holds this word. */
async function openCard(c: Ctx, who: RegExp): Promise<boolean> {
  const items = c.page.locator('[data-ui="side"] button');
  const n = await items.count();
  for (let i = 0; i < n; i++) {
    const it = items.nth(i);
    const text = (await it.innerText().catch(() => '')).replace(/\s+/g, ' ');
    if (who.test(text) && (await it.isVisible())) {
      const box = await it.boundingBox();
      if (!box) continue;
      await c.clickAt(box.x + box.width / 2, box.y + box.height / 2, 'card', text.slice(0, 40));
      await c.page.locator('[data-ui="card-art"]').first().waitFor({ timeout: 10_000 });
      return true;
    }
  }
  return false;
}

/** Counters on the open card (price steps up or down), then waits for the agent's answer. */
async function counter(c: Ctx, dir: 'Higher' | 'Lower', steps: number, kind = 'counter'): Promise<void> {
  for (let i = 0; i < steps; i++) {
    await c.click(`[aria-label="${dir}"]`, 'step', dir);
    await pause(250);
  }
  await pause(500);
  await c.click('[data-tour="counter"]', kind, 'COUNTER');
  await pause(2600);
}

const SCENES: Record<string, (c: Ctx, server: LocalServer) => Promise<void>> = {
  // the title, PLAY, and the farm appearing; then naming it
  async title(c, server) {
    await openFarm(c, server, 'new', { record: 'title', beforePlay: () => c.hold(2600) });
    await c.page.locator('[data-ui="name-farm"]').waitFor({ timeout: 60_000 });
    await c.hold(1600);
    c.rec.end();
    c.rec.begin('name');
    await c.hold(800);
    await c.click('[data-ui="name-field"]', 'click', 'name field');
    await c.page.keyboard.press('Meta+A');
    await c.page.keyboard.press('Backspace');
    c.rec.act('type', FRESH_FARM);
    await c.page.keyboard.type(FRESH_FARM, { delay: 110 });
    await c.hold(1400);
    await c.click('[data-ui="name-confirm"]', 'confirm', 'name');
    await c.page.locator('[data-ui="name-farm"]').waitFor({ state: 'detached', timeout: 15_000 });
    await c.hold(1800);
    c.rec.end();
    await endTour(c);
    // eggs on the ground for the next scene (a new farm's hens lay through the day)
    await waitEggs(c, 3, 120_000);
    c.rec.begin('collect');
    await c.hold(1500);
    for (let i = 0; i < 3; i++) if (!(await collectEgg(c))) break;
    await c.hold(1200);
    const sell = c.page.locator('button >> text=/^SELL \\d+ EGGS?$/ >> visible=true').first();
    if (await sell.count()) {
      const box = await sell.boundingBox();
      if (box) await c.clickAt(box.x + box.width / 2, box.y + box.height / 2, 'sale', 'SELL THE CRATE');
    }
    await c.hold(2600);
    c.rec.end();
  },

  // the Market: prices, the chart, the AI traders' lines
  async market(c, server) {
    await openFarm(c, server, LATE_FARM);
    await endTour(c);
    await c.hold(1500);
    c.rec.begin('market');
    await c.hold(1200);
    await c.click('[data-ui="market-button"]', 'click', 'MARKET');
    await c.page.locator('[data-ui="market-page"]').waitFor();
    await c.hold(2200);
    await c.moveToSel('[data-ui="market-supply"]');
    await c.hold(2200);
    await c.moveToSel('[data-ui="market-chart"]');
    await c.hold(2200);
    await c.moveToSel('[data-ui="cast-reason"]');
    await c.hold(2600);
    c.rec.end();
    // a buyer's order filled from BUY ORDERS
    c.rec.begin('orders');
    await c.click('[data-tour="market-buyers"]', 'click', 'BUY ORDERS');
    await c.hold(2200);
    const fill = c.page.locator('[data-ui="fill-buy"]:not([disabled]) >> visible=true').first();
    if (await fill.count()) {
      const box = await fill.boundingBox();
      if (box) await c.clickAt(box.x + box.width / 2, box.y + box.height / 2, 'coins', 'fill buy order');
    }
    await c.hold(2600);
    c.rec.end();
    // the Farms: rivals that went bust
    c.rec.begin('farms');
    await c.click('[data-tour="market-farms"]', 'click', 'FARMS');
    await c.hold(2000);
    await c.moveToSel('[data-ui="rival-signs"]');
    await c.hold(2400);
    c.rec.end();
    // the hen auction, and the hen hatching at the coop once the Market is closed
    c.rec.begin('auction');
    await c.click('[data-tour="market-auction"]', 'click', 'HEN AUCTION');
    await c.hold(2000);
    await c.click('[data-ui="auction-buy"]:not([disabled])', 'buy-hen', 'auction hen');
    await c.hold(1200);
    await c.click('[data-ui="market-close"]', 'click', 'BACK TO THE FARM');
    await c.page
      .waitForFunction(() => ((globalThis as unknown as { __coysFarm?: { hatching(): unknown[] } }).__coysFarm?.hatching().length ?? 0) > 0, undefined, { timeout: 15_000 })
      .catch(() => undefined);
    c.rec.act('hatch', 'egg lands at the coop');
    await c.hold(5200);
    c.rec.end();
  },

  // three random hens: the chorus hatch
  async chorus(c, server) {
    await openFarm(c, server, LATE_FARM);
    await endTour(c);
    await c.hold(1500);
    c.rec.begin('chorus');
    await c.hold(800);
    await c.click('[data-tour="shop"]', 'click', 'SHOP');
    await c.click('[data-tour="shop-hens"]', 'click', 'HENS');
    await c.hold(1500);
    await c.click('[aria-label="More hens"]', 'step', '+');
    await c.click('[aria-label="More hens"]', 'step', '+');
    await c.hold(600);
    await c.click('button >> text=/^BUY UP TO \\d+$/', 'buy-hens', '3 random hens');
    await c.hold(900);
    await c.page.keyboard.press('Escape');
    await c.page
      .waitForFunction(() => ((globalThis as unknown as { __coysFarm?: { hatching(): unknown[] } }).__coysFarm?.hatching().length ?? 0) > 0, undefined, { timeout: 15_000 })
      .catch(() => undefined);
    c.rec.act('hatch3', 'three eggs at the coop');
    await c.hold(6500);
    c.rec.end();
  },

  // haggling on the offer cards
  async haggle(c, server) {
    await openFarm(c, server, LATE_FARM);
    await endTour(c);
    // today's cards from the Wholesaler, the Loyalist and the Squeezer, arrived, with time left in the day
    const t = Date.now();
    while (Date.now() - t < 900_000) {
      const side = (
        await c.page
          .locator('[data-ui="side"]')
          .first()
          .innerText()
          .catch(() => '')
      ).toUpperCase();
      const { clock } = (await (await fetch(`${server.url}/api/market`)).json()) as { clock: { dayStartedAt: number; dayLengthMs: number; serverNow: number } };
      const left = clock.dayStartedAt + clock.dayLengthMs - clock.serverNow;
      if (['WHOLESALER', 'LOYALIST', 'SQUEEZER'].every((w) => side.includes(w)) && left > 90_000) break;
      await pause(2000);
    }
    await c.hold(1500);
    c.rec.begin('wholesaler');
    await c.hold(800);
    if (await openCard(c, /WHOLESALER/i)) {
      await c.hold(2400);
      await counter(c, 'Higher', 3, 'counter');
      await c.hold(2200);
      await c.page.keyboard.press('Escape');
    }
    c.rec.end();
    c.rec.begin('loyalist');
    await c.hold(600);
    if (await openCard(c, /LOYALIST/i)) {
      await c.hold(2200);
      // a counter a little under the price; the Loyalist counters back, and we meet its price: it takes
      // our counter (a haggle won, the SOLD stamp)
      await counter(c, 'Lower', 1, 'counter');
      if (await c.page.locator('[data-tour="counter"] >> visible=true').count()) {
        const line = await c.page
          .locator('text=/^ACCEPT: .* AT \\$?[0-9.]+/ >> visible=true')
          .first()
          .innerText()
          .catch(() => '');
        const theirs = Number(/AT \$?([0-9.]+)/.exec(line)?.[1] ?? 'NaN');
        for (let i = 0; i < 12; i++) {
          const ask = Number(
            (
              await c.page
                .locator('.chip.on >> visible=true')
                .first()
                .innerText()
                .catch(() => '0')
            ).replace(/[^0-9.]/g, ''),
          );
          if (!Number.isFinite(theirs) || ask >= theirs) break;
          await c.click('[aria-label="Higher"]', 'step', 'Higher');
          await pause(200);
        }
        await pause(500);
        await c.click('[data-tour="counter"]', 'counter', 'COUNTER at their price');
        await pause(2600);
      }
      c.rec.act('stamp', 'deal stamped');
      await c.hold(2600);
      await c.page.keyboard.press('Escape');
    }
    c.rec.end();
    c.rec.begin('squeezer');
    await c.hold(600);
    if (await openCard(c, /SQUEEZER/i)) {
      await c.hold(2600);
      if (await c.page.locator('[data-tour="choice-switchSupplier"] >> visible=true').count()) await c.click('[data-tour="choice-switchSupplier"]', 'switch', 'switch supplier');
      await c.hold(2800);
      await c.page.keyboard.press('Escape');
    }
    await c.hold(800);
    c.rec.end();
  },

  // machines: buying one (the fresh farm), repairing a worn one (the late farm)
  async machines(c, server) {
    await openFarm(c, server, FRESH_FARM);
    await endTour(c);
    await c.hold(1500);
    c.rec.begin('machine-buy');
    await c.hold(600);
    await c.click('[data-tour="shop"]', 'click', 'SHOP');
    await c.click('[data-tour="shop-machines"]', 'click', 'MACHINES');
    await c.hold(1800);
    await c.click('[data-tour="machine-conveyor"]', 'buy-machine', 'conveyor');
    await c.hold(1200);
    await c.page.keyboard.press('Escape');
    await c.hold(2600);
    c.rec.end();
  },

  async repair(c, server) {
    await openFarm(c, server, LATE_FARM);
    await endTour(c);
    await c.hold(1500);
    c.rec.begin('repair');
    await c.hold(600);
    const conveyor = (await c.farm()).find((x) => x.kind === 'machine' && x.id === 'conveyor');
    if (conveyor) await c.clickAt(conveyor.x + conveyor.w / 2, conveyor.y + conveyor.h / 2, 'click', 'conveyor');
    await c.hold(2400);
    await c.click('[data-ui="repair"]', 'repair', 'REPAIR');
    await c.hold(2600);
    await c.page.keyboard.press('Escape');
    c.rec.end();
  },

  // land: a plot bought, then looking round the bigger farm by dragging, the small map, HOME
  async land(c, server) {
    await openFarm(c, server, LATE_FARM);
    await endTour(c);
    await c.hold(1500);
    c.rec.begin('land');
    await c.hold(600);
    await c.click('[data-tour="shop"]', 'click', 'SHOP');
    await c.click('[data-tour="shop-land"]', 'click', 'LAND');
    await c.hold(2400);
    const buy = c.page.locator('[data-ui="land-tab"] button >> text=/^BUY \\d+$/ >> visible=true').first();
    if (await buy.count()) {
      const box = await buy.boundingBox();
      if (box) await c.clickAt(box.x + box.width / 2, box.y + box.height / 2, 'land', 'buy a plot');
    }
    await c.hold(5200);
    c.rec.end();
    c.rec.begin('drag');
    await c.hold(800);
    const map = await c.page.locator('[data-ui="farm-map"] >> visible=true').first().boundingBox();
    if (map) await c.moveTo(map.x + map.width / 2, map.y + map.height / 2);
    await c.hold(1500);
    const sx = 700;
    const sy = 600;
    await c.moveTo(sx, sy);
    c.rec.act('drag', 'look round');
    await c.page.mouse.down();
    for (let i = 1; i <= 60; i++) {
      await c.page.mouse.move(sx + i * 9, sy - i * 2);
      await pause(25);
    }
    await c.page.mouse.up();
    await c.hold(1600);
    await c.moveTo(sx, sy);
    await c.page.mouse.down();
    for (let i = 1; i <= 60; i++) {
      await c.page.mouse.move(sx - i * 10, sy + i * 1);
      await pause(25);
    }
    await c.page.mouse.up();
    await c.hold(1600);
    await c.click('[data-ui="farm-home"]', 'click', 'HOME');
    await c.hold(2400);
    c.rec.end();
  },

  // the late-game farm, wide
  async wide(c, server) {
    await openFarm(c, server, LATE_FARM);
    await endTour(c);
    await c.hold(2500);
    c.rec.begin('wide');
    await c.moveTo(960, 520);
    await c.hold(5000);
    c.rec.end();
  },

  // the ledger's days with their testnet receipts, a batched range among them
  async ledger(c, server) {
    await openFarm(c, server, LATE_FARM);
    await endTour(c);
    await c.hold(1500);
    c.rec.begin('ledger');
    await c.hold(600);
    await c.click('[data-tour="ledger"]', 'click', 'LEDGER');
    await c.hold(1200);
    const days = c.page.locator('[data-tour="ledger-days"]').first();
    if (await days.count()) await c.click('[data-tour="ledger-days"]', 'click', 'DAYS');
    await c.hold(1800);
    // to the page of days with ranges on it
    for (let i = 0; i < 4; i++) {
      if (await c.page.locator('a >> text=/^DAYS \\d+-\\d+$/ >> visible=true').count()) break;
      const next = c.page.locator('[data-ui="page-next"]:not([disabled]) >> visible=true').first();
      if (!(await next.count())) break;
      const box = await next.boundingBox();
      if (box) await c.clickAt(box.x + box.width / 2, box.y + box.height / 2, 'click', 'NEXT');
      await c.hold(900);
    }
    const range = c.page.locator('a >> text=/^DAYS \\d+-\\d+$/ >> visible=true').first();
    if (await range.count()) {
      const box = await range.boundingBox();
      if (box) {
        c.rec.act('receipt', (await range.innerText()).trim());
        await c.moveTo(box.x + box.width / 2, box.y + box.height / 2);
      }
    }
    await c.hold(3600);
    c.rec.end();
  },

  // the Feather Mint: grades, the odds, the 777
  async mint(c, server) {
    await openFarm(c, server, LATE_FARM);
    await endTour(c);
    await c.hold(1500);
    c.rec.begin('mint');
    await c.hold(600);
    await c.click('[data-ui="feathers-button"]', 'click', 'MINT');
    await c.page.locator('[data-ui="mint-page"]').waitFor();
    await c.hold(2400);
    await c.moveToSel('[data-ui="mint-odds"]');
    await c.hold(2600);
    await c.moveToSel('[data-ui="mint-supply"]');
    await c.hold(2400);
    c.rec.end();
  },
};

const order = ONLY.length ? ONLY : Object.keys(SCENES);
mkdirSync(OUT, { recursive: true });
const server = await startLocal({ daySeconds: DAY_SECONDS, log: (l) => /\[(chain|day)\]/.test(l) && process.env.DEMO_VERBOSE && console.log(l) });
const browser = await chromium.launch({ headless: true, args: ['--disable-sync', '--no-first-run', '--disable-extensions', '--hide-scrollbars'] });
try {
  for (const name of order) {
    const scene = SCENES[name];
    if (!scene) throw new Error(`no scene ${name}`);
    console.log(`scene ${name}...`);
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    await ctx.addInitScript(CURSOR);
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    const rec = new Recorder(cdp);
    await rec.start();
    try {
      await scene(makeCtx(page, rec), server);
    } catch (err) {
      console.log(`scene ${name} stopped: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
      rec.end();
    }
    await cdp.send('Page.stopScreencast').catch(() => undefined);
    await ctx.close();
  }
} finally {
  await browser.close();
  await server.stop();
}
process.exit(0);
