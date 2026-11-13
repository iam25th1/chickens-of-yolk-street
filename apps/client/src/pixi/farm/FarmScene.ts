// The farm world. It mirrors the server's farm state (sync) and turns server events into motion
// and sound (onEvent). It never decides an outcome: eggs, sales and builds come from the server.
//
// The farm fills the free part of the window (layout.ts) and draws in a fixed layer order
// (layers.ts): ground, ground animation, the conveyor's floor, then every object, hen and egg sorted
// by its feet, machine name plates and particles. Machines stand on their own labelled pads.
import { animate, createTimeline, steps } from 'animejs';
import { ColorMatrixFilter, Container, Graphics, RenderTexture, Sprite, Text, type Renderer } from 'pixi.js';
import { type CoopKind, type FarmState, type HenView, type LaidEgg, type UnlockId } from '@coys/shared';
import type { Viewport } from '../../app/viewport';
import type { AssetStore } from '../../assets/store';
import type { AudioEngine, LoopHandle } from '../../audio/audio';
import { juice } from '../../motion/juice';
import { dayElapsed, isNight, sameDay, type ClientEvent } from '../../state/game';
import { FrameSprite } from '../FrameSprite';
import { Fx } from '../Fx';
import type { Scene } from '../host';
import { HenActor } from './HenActor';
import { WorldLayers } from './layers';
import { MIN_H, MIN_W, connectionGaps, farmLayout, labelSpot, specPoint, troughSpots, type FarmLayout, type Point } from './layout';
import { carry, freeSpot, hatchSpots, movementAreas, nearestFree, route, type Areas } from './movement';

const MAX_VISIBLE_HENS = 40;
/** Several new hens hatch this far apart. */
const HATCH_STAGGER_MS = 420;
const TILE = 16;
/** How long an egg takes from the ground to the crate on the conveyor (the server collects it at 5 s). */
const RIDE_MS = 4200;

/** Something on the farm the player clicked. */
export type WorldTarget =
  | { kind: 'hen'; hen: HenView }
  | { kind: 'crate' }
  | { kind: 'feed' }
  | { kind: 'coop'; coopId: string }
  | { kind: 'farmhouse' }
  | { kind: 'sign' }
  | { kind: 'machine'; unlock: UnlockId };

/** The hover highlight: a little brighter, nothing else changes. */
const HOVER = new ColorMatrixFilter();
HOVER.brightness(1.28, false);

export interface FarmHooks {
  collect(eggId: string): Promise<boolean>;
  /** Opens the card for a clicked world object. */
  open(target: WorldTarget): void;
  /** Coins fly from a world point to the cash counter (drawn in the UI layer). */
  coins(from: Point, count: number): void;
}

interface GroundEgg {
  egg: LaidEgg;
  s: FrameSprite;
  pending: boolean;
}

const MACHINE_ROWS: Record<Exclude<UnlockId, 'conveyor'>, { id: string; idle: string; run: string }> = {
  grader: { id: '19-egg-grader', idle: 'idle', run: 'running' },
  hopper: { id: '21-feed-hopper', idle: 'idle', run: 'refilling' },
  cart: { id: '20-delivery-cart', idle: 'idle', run: 'moving' },
  clerk: { id: '22-sales-clerk', idle: 'idle', run: 'stamping' },
};

/** The worn and broken looks of each machine (made from its own art; see coys-assets 18c to 22c). */
const WEAR_SHEET: Record<Exclude<UnlockId, 'conveyor'>, string> = { grader: '19c-egg-grader-wear', cart: '20c-delivery-cart-wear', hopper: '21c-feed-hopper-wear', clerk: '22c-sales-clerk-wear' };

export const MACHINE_NAME: Record<UnlockId, string> = { conveyor: 'CONVEYOR', grader: 'GRADER', cart: 'DELIVERY CART', hopper: 'FEED HOPPER', clerk: 'SALES CLERK' };

/** The label a world thing shows on hover or tap (the layout object it names), if it has one. */
function labelOf(t: WorldTarget): { name: string; text: string } | null {
  if (t.kind === 'machine') return { name: t.unlock, text: MACHINE_NAME[t.unlock] };
  if (t.kind === 'crate') return { name: 'crate', text: 'CRATE' };
  if (t.kind === 'feed') return { name: 'trough', text: 'TROUGH AND FEED' };
  if (t.kind === 'farmhouse') return { name: 'farmhouse', text: 'FARMHOUSE' };
  return null;
}

/** A rival farm whose sign stands at the farm's edge. */
export interface RivalSign {
  sign: string;
  name: string;
  bust: boolean;
}

export class FarmScene implements Scene {
  readonly root = new Container();
  readonly fit = 'farm' as const;
  private readonly layers = new WorldLayers();
  private readonly fx: Fx;
  private readonly night = new Graphics();
  private readonly animated: FrameSprite[] = [];
  private readonly hens = new Map<string, HenActor>();
  /** Eggs new hens are hatching from, until their shells fade. */
  private readonly hatchEggs = new Set<FrameSprite>();
  private readonly coops = new Map<string, { s: FrameSprite; kind: CoopKind; plot: number; swungAt: number; nextCreak: number }>();
  private readonly machines = new Map<UnlockId, FrameSprite>();
  private belt: FrameSprite[] = [];
  /** Broken machines: their smoke puffs (a timer each); worn ones: their wobble. */
  private readonly smoke = new Map<UnlockId, ReturnType<typeof setInterval>>();
  private readonly wobble = new Map<UnlockId, ReturnType<typeof animate>>();
  /** Each machine's look (as built, worn, broken), and each belt tile's own row. */
  private readonly looks = new Map<UnlockId, 'normal' | 'worn' | 'broken'>();
  private readonly beltRow = new WeakMap<FrameSprite, string>();
  private readonly eggs = new Map<string, GroundEgg>();
  private readonly spawned = new Set<string>();
  private readonly farmhouse: FrameSprite;
  private readonly sign: FrameSprite;
  private readonly trough: FrameSprite;
  private sack: FrameSprite;
  private sackId = '13-sack-standard';
  private readonly crate: FrameSprite;
  private farm: FarmState | null = null;
  private nightOn = false;
  private ambience: { day: LoopHandle | null; night: LoopHandle | null; snore: LoopHandle | null } = { day: null, night: null, snore: null };
  private machineLoops = new Map<string, LoopHandle>();
  private roostIndex = 0;
  private ground: Sprite | null = null;
  private readonly decor: FrameSprite[] = [];
  /** The one name label on screen (hover, tap, or a machine's arrival), and when it goes. */
  private label: Container | null = null;
  private labelTimer: ReturnType<typeof setTimeout> | null = null;
  private plotsKey = '';
  private rivals: { s: FrameSprite; sign: string; bust: boolean }[] = [];
  private layout: FarmLayout = farmLayout(MIN_W, MIN_H, { w: 0, h: 0 });
  private areasCache: { key: string; areas: Areas } | null = null;
  private view = { x: 0, y: 0, w: 640, h: 360 };
  /** What the baked ground shows (coops and machines change its pads and plots). */
  private groundKey = '';
  private k = 2;
  private readonly targetsList = new Map<FrameSprite, () => WorldTarget>();
  /** The layout debug overlay (?debug=layout): anchors, art bounds, footprints and connections. */
  private readonly debugLayer: Graphics | null = typeof location !== 'undefined' && new URLSearchParams(location.search).get('debug') === 'layout' ? new Graphics() : null;
  private readonly loose = new Set<FrameSprite>();

  constructor(
    private readonly assets: AssetStore,
    private readonly audio: AudioEngine,
    private readonly renderer: Renderer,
    private readonly hooks: FarmHooks,
  ) {
    this.fx = new Fx(assets);
    this.layers.by.fx.addChild(this.fx.layer);
    this.night.alpha = 0;
    this.root.addChild(this.layers.root, this.night);

    this.farmhouse = this.clickable(this.place(new FrameSprite(assets, ['16-farmhouse'], 'day')), () => ({ kind: 'farmhouse' }));
    this.sign = this.clickable(this.place(new FrameSprite(assets, ['17-sign-farm'], 'sway').desync()), () => ({ kind: 'sign' }));
    this.trough = this.clickable(this.place(new FrameSprite(assets, ['14-trough'], 'full')), () => ({ kind: 'feed' }));
    this.sack = this.clickable(this.place(new FrameSprite(assets, [this.sackId], 'idle')), () => ({ kind: 'feed' }));
    this.crate = this.clickable(this.place(new FrameSprite(assets, ['12-crate'], 'empty')), () => ({ kind: 'crate' }));

    this.ambience.day = audio.loop('39-day', { volume: 0.45, fadeMs: 1200 });
  }

  /** Adds a sprite to the depth layer (sorted by its feet) and to the animation list. */
  private place<T extends FrameSprite>(s: T, at?: Point): T {
    if (at) s.position.set(at.x, at.y);
    this.layers.add('depth', s);
    this.animated.push(s);
    return s;
  }

  private moveTo(s: Container, at: Point): void {
    s.position.set(Math.round(at.x), Math.round(at.y));
    WorldLayers.resort(s);
  }

  /**
   * Makes a world object answer the pointer: brighter on hover, the pointer cursor, a click sound
   * and its card on click. The hit box is the art's own box, a pixel larger all round.
   */
  private clickable<T extends FrameSprite>(s: T, target: () => WorldTarget): T {
    s.eventMode = 'static';
    s.cursor = 'pointer';
    s.hitBox(1);
    s.on('pointerover', () => {
      s.filters = [HOVER];
      const l = labelOf(target());
      if (l) this.showLabel(l.name, l.text);
    });
    s.on('pointerout', () => {
      s.filters = [];
      this.hideLabel();
    });
    s.on('pointertap', () => {
      this.audio.play('35-click', { volume: 0.6 });
      const l = labelOf(target());
      if (l) this.showLabel(l.name, l.text, 1500);
      this.hooks.open(target());
    });
    this.targetsList.set(s, target);
    s.once('destroyed', () => this.targetsList.delete(s));
    return s;
  }

  /**
   * Every clickable thing on screen with its box in CSS pixels, and the ground eggs. Read only; the
   * automated checks use it to find what to click (the world is drawn, not in the DOM).
   */
  targets(): { kind: string; id?: string; x: number; y: number; w: number; h: number }[] {
    const box = (s: Container) => {
      const b = s.getBounds();
      return { x: Math.round(b.minX), y: Math.round(b.minY), w: Math.round(b.maxX - b.minX), h: Math.round(b.maxY - b.minY) };
    };
    const out: { kind: string; id?: string; x: number; y: number; w: number; h: number }[] = [];
    for (const [s, t] of this.targetsList) {
      if (s.destroyed || !s.visible) continue;
      const v = t();
      out.push({ kind: v.kind, id: v.kind === 'hen' ? v.hen.id : v.kind === 'machine' ? v.unlock : v.kind === 'coop' ? v.coopId : undefined, ...box(s) });
    }
    for (const [id, g] of this.eggs) if (!g.pending && !g.s.destroyed) out.push({ kind: 'egg', id, ...box(g.s) });
    return out;
  }

  /** Eggs hatching now, with their feet in CSS pixels (for checks). */
  hatching(): { x: number; y: number }[] {
    return [...this.hatchEggs].filter((s) => !s.destroyed).map((s) => {
      const p = this.layers.root.toGlobal({ x: s.x, y: s.y });
      return { x: Math.round(p.x), y: Math.round(p.y) };
    });
  }

  /** The draw order, for checks: layer, kind and foot position of everything in the world. */
  drawOrder(): { layer: string; label: string; y: number }[] {
    return this.layers.drawOrder().map((e) => ({ layer: e.layer, label: e.obj.label ?? '', y: Math.round(e.obj.y) }));
  }

  /** The straw yard's box in CSS pixels (where hens lay), for the tour's spotlight. */
  yardBox(): { x: number; y: number; w: number; h: number } {
    const y = this.layout.yard;
    const a = this.layers.root.toGlobal({ x: y.left, y: y.top });
    const b = this.layers.root.toGlobal({ x: y.right, y: y.bottom });
    return { x: Math.round(a.x), y: Math.round(a.y), w: Math.round(b.x - a.x), h: Math.round(b.y - a.y) };
  }

  private unplace(s: FrameSprite): void {
    const i = this.animated.indexOf(s);
    if (i >= 0) this.animated.splice(i, 1);
    s.destroy();
  }

  /** A farm point in world coordinates (the farm is drawn at the world origin). */
  toStage(p: Point): Point {
    return { x: p.x, y: p.y };
  }

  // ---- layout ---------------------------------------------------------------------------------

  /** Where hens may walk now (movement.ts): the layout's yard and path, round what stands there. */
  private get areas(): Areas {
    const built = (this.farm?.coops ?? []).map((c) => c.plot);
    const unlocks = this.farm?.unlocks ?? [];
    const key = `${this.layout.w}x${this.layout.h}|${built.join()}|${unlocks.join()}`;
    if (this.areasCache?.key !== key) this.areasCache = { key, areas: movementAreas(this.layout, { builtPlots: built, unlocks }) };
    return this.areasCache.areas;
  }

  /**
   * The window shows this part of the world. The farm fills the free area (v.farm.w x v.farm.h);
   * grass runs on under the HUD to the window's edges, so there is no border.
   */
  resize(view: { x: number; y: number; w: number; h: number }, v: Viewport): void {
    this.view = view;
    this.k = v.farm.k;
    // hens and eggs on the ground keep their place in the composition, in world units, as it re-flows
    const before = this.areas;
    this.layout = farmLayout(v.farm.w, v.farm.h, v.farm.guide);
    const after = this.areas;
    if (before !== after) {
      for (const a of this.hens.values()) a.carry((p) => carry(p, before, after));
      for (const g of this.eggs.values()) {
        if (g.pending || g.s.destroyed) continue;
        const to = carry({ x: g.s.x, y: g.s.y }, before, after);
        g.s.position.set(to.x, to.y);
      }
    }
    this.night.clear().rect(view.x, view.y, view.w, view.h).fill({ color: 0x3b4f7a, alpha: 0.24 });
    this.groundKey = '';
    this.rebake();
    this.arrange();
  }

  /** Bakes the ground again when the window, the coops or the machines changed. */
  private rebake(): void {
    const key = `${this.view.x},${this.view.y},${this.view.w},${this.view.h}|${(this.farm?.unlocks ?? []).join()}|${(this.farm?.coops ?? []).map((c) => c.plot).join()}`;
    if (key === this.groundKey) return;
    this.groundKey = key;
    const v = this.view;
    const gx = Math.floor(v.x);
    const gy = Math.floor(v.y);
    this.ground?.destroy(true);
    this.ground = this.bakeGround(gx, gy, Math.ceil(v.x + v.w) - gx, Math.ceil(v.y + v.h) - gy);
    this.layers.by.ground.addChild(this.ground);
  }

  /** Puts every fixed thing on its spot for the current layout. */
  private arrange(): void {
    const l = this.layout;
    this.moveTo(this.farmhouse, l.farmhouse);
    this.moveTo(this.sign, l.sign);
    this.moveTo(this.trough, l.trough);
    this.moveTo(this.sack, l.sack);
    this.moveTo(this.crate, l.crate);
    for (const c of this.coops.values()) {
      const plot = l.plots[c.plot];
      if (plot) this.moveTo(c.s, plot);
    }
    for (const [u, s] of this.machines) if (u !== 'conveyor') this.moveTo(s, l.machines[u]);
    if (this.belt.length) this.layBelt(false);
    // grass and straw that move, props, the rivals' signs
    for (const s of this.decor.splice(0)) {
      this.layers.by.groundAnim.removeChild(s);
      this.unplace(s);
    }
    const anim: [string, number, number][] = [
      ['grass-sway', 8, 64],
      ['grass-sway', l.w - 40, 96],
      ['grass-sway', Math.round(l.w / 2), 88],
      ['straw-flutter', l.yard.left + 40, l.yard.top + 30],
      ['straw-flutter', l.yard.right - 60, l.yard.top + 70],
      ['straw-flutter', Math.round((l.yard.left + l.yard.right) / 2) - 70, l.yard.bottom - 30],
    ];
    for (const [row, x, y] of anim) {
      const s = new FrameSprite(this.assets, ['23-farm-tileset'], row).desync();
      s.position.set(Math.round(x / TILE) * TILE + TILE / 2, Math.round(y / TILE) * TILE + TILE / 2);
      this.layers.add('groundAnim', s);
      this.animated.push(s);
      this.decor.push(s);
    }
    for (const p of l.props) this.decor.push(this.place(new FrameSprite(this.assets, ['24-farm-props'], p.row).desync(), p));
    const built = new Set((this.farm?.coops ?? []).map((c) => c.plot));
    l.plots.forEach((p, i) => {
      if (!built.has(i)) this.decor.push(this.place(new FrameSprite(this.assets, ['24-farm-props'], 'signpost').desync(), { x: p.x - 20, y: p.y - 6 }));
    });
    this.rivals.forEach((r, i) => {
      const at = l.rivals[i];
      if (at) this.moveTo(r.s, at);
    });
    this.drawLayoutDebug();
  }

  /**
   * The layout debug overlay: each object's art bounds (thin box), footprint (filled strip) and
   * anchor (white cross), its connection points (cyan), and every connection as a line, green when
   * it lines up within one world pixel and red when it does not. Shown only with ?debug=layout.
   */
  private drawLayoutDebug(): void {
    const g = this.debugLayer;
    if (!g) return;
    if (!g.parent) this.layers.by.fx.addChild(g);
    const l = this.layout;
    g.clear();
    g.rect(l.yard.left, l.yard.top, l.yard.right - l.yard.left, l.yard.bottom - l.yard.top).stroke({ color: 0xffe066, width: 0.5, alpha: 0.8 });
    if (l.guide.right > 0) g.rect(l.guide.left, l.guide.top, l.guide.right - l.guide.left, l.guide.bottom - l.guide.top).fill({ color: 0x000000, alpha: 0.12 });
    for (const o of Object.values(l.spec.objects)) {
      g.rect(o.box.left, o.box.top, o.box.right - o.box.left, o.box.bottom - o.box.top).stroke({ color: 0xff7ad9, width: 0.5, alpha: 0.9 });
      g.rect(o.footprint.left, o.footprint.top, o.footprint.right - o.footprint.left, o.footprint.bottom - o.footprint.top).fill({ color: 0xff7ad9, alpha: 0.45 });
      g.moveTo(o.at.x - 2, o.at.y).lineTo(o.at.x + 2, o.at.y).moveTo(o.at.x, o.at.y - 2).lineTo(o.at.x, o.at.y + 2).stroke({ color: 0xffffff, width: 1 });
      for (const p of Object.values(o.points)) g.rect(p.x - 1, p.y - 1, 2, 2).fill({ color: 0x3ff0ff });
    }
    for (const { c, gap } of connectionGaps(l)) {
      const color = gap <= 1 ? 0x37d65b : 0xff3030;
      const a = specPoint(l, c.kind === 'meet' ? c.a : c.point);
      const b = c.kind === 'meet' ? specPoint(l, c.b) : specPoint(l, c.span[0]);
      const b2 = c.kind === 'over' ? specPoint(l, c.span[1]) : null;
      if (!a || !b) continue;
      if (b2) g.moveTo(b.x, b.y).lineTo(b2.x, b2.y).stroke({ color, width: 1, alpha: 0.9 });
      g.moveTo(a.x, a.y).lineTo(b2 ? Math.max(Math.min(a.x, Math.max(b.x, b2.x)), Math.min(b.x, b2.x)) : b.x, b.y).stroke({ color, width: 1 });
      g.circle(a.x, a.y, 2.5).stroke({ color, width: 1 });
    }
  }

  /**
   * A thing's name label: shown while the pointer is over it, for a moment after a tap, and once
   * when a machine arrives; never more than one at a time, placed where it covers nothing else.
   */
  private showLabel(name: string, text: string, ms = 0): void {
    this.hideLabel();
    const plate = new Container();
    const tx = new Text({ text, style: { fontFamily: 'Silkscreen', fontSize: 8, fill: 0xf6e7c1 }, resolution: this.k });
    tx.roundPixels = true;
    const w = Math.ceil(tx.width) + 6;
    const spot = labelSpot(this.layout, name, w);
    if (!spot) return;
    const bg = new Graphics().rect(0, 0, w, 11).fill({ color: 0x2a160c, alpha: 0.85 });
    tx.position.set(3, 1);
    plate.addChild(bg, tx);
    plate.position.set(spot.left, spot.top);
    plate.label = `label:${name}`;
    this.layers.by.labels.addChild(plate);
    this.label = plate;
    if (ms) this.labelTimer = setTimeout(() => this.hideLabel(), ms);
  }

  private hideLabel(): void {
    if (this.labelTimer) clearTimeout(this.labelTimer);
    this.labelTimer = null;
    if (this.label && !this.label.destroyed) this.label.destroy({ children: true });
    this.label = null;
  }

  /** Grass, straw yard, path, machine pads and the fence with its gate, drawn once per window size. */
  private bakeGround(x0: number, y0: number, w: number, h: number): Sprite {
    const l = this.layout;
    const g = new Container();
    const tile = (cx: number, cy: number, x: number, y: number) => {
      const t = new Sprite(this.assets.region('23-farm-tileset', cx * 128, cy * 128, 128, 128));
      t.position.set(x - x0, y - y0);
      g.addChild(t);
    };
    const left = Math.floor(x0 / TILE) * TILE;
    const top = Math.floor(y0 / TILE) * TILE;
    // grass varies by position, not by chance, so a resize does not reshuffle the field
    for (let y = top; y < y0 + h; y += TILE) for (let x = left; x < x0 + w; x += TILE) tile(Math.abs((x * 7 + y * 13) / TILE) % 4, 0, x, y);
    const yl = Math.floor((l.yard.left - 8) / TILE) * TILE;
    const yt = Math.floor((l.yard.top - 8) / TILE) * TILE;
    for (let y = yt; y < l.yard.bottom + 12; y += TILE) for (let x = yl; x < l.yard.right + 12; x += TILE) tile(Math.abs((x * 3 + y * 5) / TILE) % 2, 3, x, y);
    // pads of packed dirt under the machines on the farm (the belt is its own station)
    for (const u of this.farm?.unlocks ?? []) {
      if (u === 'conveyor') continue;
      const pad = l.pads[u];
      const y = Math.floor(pad.top / TILE) * TILE;
      for (let x = Math.floor(pad.left / TILE) * TILE; x < pad.right; x += TILE) tile(Math.abs(x / TILE) % 2, 2, x, y);
    }
    // empty coop plots: a square of dirt waiting for a coop
    const built = new Set((this.farm?.coops ?? []).map((c) => c.plot));
    l.plots.forEach((p, i) => {
      if (built.has(i)) return;
      const y0 = Math.round((p.y - 32) / TILE) * TILE;
      const x0 = Math.round((p.x - 32) / TILE) * TILE;
      for (const y of [y0, y0 + TILE]) for (let x = x0; x < x0 + 4 * TILE; x += TILE) tile(1, 2, x, y);
    });
    // the path from the farmhouse door down through the gate
    for (let y = Math.floor(l.path.top / TILE) * TILE; y < y0 + h; y += TILE) for (const x of [l.path.x - TILE, l.path.x]) tile(0, 2, x, y);
    // the fence across the whole width, a gate where the path crosses it
    for (let x = left; x < x0 + w; x += TILE) {
      const onPath = x === l.path.x - TILE || x === l.path.x;
      tile(onPath ? 3 : 0, 6, x, l.fence.y);
    }
    const rt = RenderTexture.create({ width: Math.ceil(w), height: Math.ceil(h), scaleMode: 'nearest' });
    this.renderer.render({ container: g, target: rt });
    g.destroy({ children: true });
    const s = new Sprite(rt);
    s.position.set(x0, y0);
    s.label = 'ground';
    return s;
  }

  // ---- rivals ---------------------------------------------------------------------------------

  /** The rival farms' signs at the farm's edge: swaying while they trade, tipped over once bust. */
  setRivals(list: RivalSign[]): void {
    const want = list.slice(0, this.layout.rivals.length);
    if (want.length === this.rivals.length && want.every((r, i) => this.rivals[i]?.sign === r.sign && this.rivals[i]?.bust === r.bust)) return;
    for (const r of this.rivals) this.unplace(r.s);
    this.rivals = want.map((r, i) => {
      const s = this.place(new FrameSprite(this.assets, [r.sign], r.bust ? 'tip-over' : 'sway').desync(), this.layout.rivals[i]);
      if (r.bust) s.still('tip-over', 3);
      s.label = `rival:${r.name}`;
      return { s, sign: r.sign, bust: r.bust };
    });
  }

  // ---- state ----------------------------------------------------------------------------------

  sync(farm: FarmState): void {
    const first = this.farm === null;
    this.farm = farm;
    const l = this.layout;

    // hens: show up to MAX_VISIBLE_HENS, keeping the ones already on screen (they persist by id);
    // new ones (bought, from the auction or turned up) hatch from an egg in the yard
    const present = new Set(farm.hens.map((h) => h.id));
    const keep = [...this.hens.keys()].filter((id) => present.has(id)).slice(0, MAX_VISIBLE_HENS);
    const shown = [...farm.hens.filter((h) => keep.includes(h.id)), ...farm.hens.filter((h) => !keep.includes(h.id))].slice(0, MAX_VISIBLE_HENS);
    const ids = new Set(shown.map((h) => h.id));
    for (const [id, actor] of this.hens) {
      if (!ids.has(id)) {
        actor.sprite.destroy();
        this.hens.delete(id);
      }
    }
    const fresh: HenActor[] = [];
    for (const h of shown) {
      if (this.hens.has(h.id)) continue;
      const others = [...this.hens.values()].map((a) => a.position);
      const areas = this.areas;
      const actor = new HenActor(this.assets, h, first ? freeSpot(areas, others) : areas.arrive);
      this.clickable(actor.sprite, () => ({ kind: 'hen', hen: this.farm?.hens.find((x) => x.id === h.id) ?? h }));
      actor.sprite.label = `hen:${h.id}`;
      this.hens.set(h.id, actor);
      this.layers.add('depth', actor.sprite);
      if (!first) fresh.push(actor);
    }
    if (fresh.length) this.hatch(fresh);

    // coops: at rest the door is shut and nothing moves
    for (const c of farm.coops) {
      const have = this.coops.get(c.id);
      const plot = l.plots[c.plot] ?? l.plots[0];
      if (!plot) continue;
      if (!have) {
        const s = this.clickable(this.place(new FrameSprite(this.assets, [`15-coop-${c.kind}`], 'idle').still('idle', 0), plot), () => ({ kind: 'coop', coopId: c.id }));
        s.label = `coop:${c.id}`;
        this.coops.set(c.id, { s, kind: c.kind, plot: c.plot, swungAt: 0, nextCreak: performance.now() + 20_000 + Math.random() * 40_000 });
      } else if (have.kind !== c.kind) {
        have.kind = c.kind;
        have.s.setSheets([`15-coop-${c.kind}`]);
        have.s.still('idle', 0);
      }
    }

    // machines bought with unlocks
    for (const u of farm.unlocks) this.ensureMachine(u, false);
    for (const u of farm.unlocks) this.machineCondition(u);
    const plotsKey = farm.coops.map((c) => c.plot).join();
    if (plotsKey !== this.plotsKey) {
      this.plotsKey = plotsKey;
      this.rebake();
      this.arrange();
    } else this.rebake();

    this.trough.rest(this.troughRow());
    const sackId = `13-sack-${farm.feedTier}`;
    if (sackId !== this.sackId) {
      this.sackId = sackId;
      this.unplace(this.sack);
      this.sack = this.clickable(this.place(new FrameSprite(this.assets, [sackId], 'idle'), l.sack), () => ({ kind: 'feed' }));
    }
    this.crate.rest(this.crateRow());

    // eggs collected elsewhere (or already, after a reconnect) leave the ground
    for (const e of farm.layPlan) {
      const g = this.eggs.get(e.id);
      if (g && e.collected && !g.pending) {
        this.eggs.delete(e.id);
        this.flyToCrate(g.s, 0, () => undefined);
      }
    }
    // a new day's plan: yesterday's eggs still on the ground went into the crate at the close
    const plan = new Set(farm.layPlan.map((e) => e.id));
    let i = 0;
    for (const [id, g] of this.eggs) {
      if (plan.has(id) || g.pending) continue;
      this.eggs.delete(id);
      this.flyToCrate(g.s, 40 * i++, () => undefined);
    }
    for (const id of this.spawned) if (!plan.has(id)) this.spawned.delete(id);
  }

  /** Full while there is feed for the active tier (hens eat it at dawn), empty when it has run out. */
  private troughRow(): string {
    const f = this.farm;
    if (!f) return 'empty';
    return (f.feedGrams[f.feedTier] ?? 0) > 0 || f.fedToday > 0 ? 'full' : 'empty';
  }

  private crateRow(): string {
    const c = this.farm?.crate;
    const n = c ? c.white + c.cream + c.brown + c.golden : 0;
    return n === 0 ? 'empty' : n < 20 ? 'half' : n < 60 ? 'full' : 'overflow';
  }

  private get hasConveyor(): boolean {
    return this.farm?.unlocks.includes('conveyor') ?? false;
  }

  /** The belt: one continuous run of whole tiles from the field, under the grader, to the crate's side. */
  private layBelt(boot: boolean): void {
    for (const s of this.belt) s.destroy();
    this.belt = [];
    const c = this.layout.conveyor;
    for (let x = c.from; x < c.to; x += TILE) {
      const row = x === c.from ? 'start' : x + TILE >= c.to ? 'end' : 'horizontal';
      const s = new FrameSprite(this.assets, ['18b-conveyor-clean'], row);
      this.beltRow.set(s, row);
      s.position.set(x + TILE / 2, c.y);
      s.label = 'conveyor';
      this.clickable(s, () => ({ kind: 'machine', unlock: 'conveyor' }));
      this.layers.add('floor', s);
      this.belt.push(s);
      if (boot) {
        s.alpha = 0;
        animate(s, { alpha: 1, duration: 120, delay: (x - c.from) * 2, ease: steps(2) });
      }
    }
  }

  private ensureMachine(u: UnlockId, boot: boolean): void {
    if (u === 'conveyor') {
      if (this.belt.length) return;
      this.layBelt(boot);
      this.machines.set('conveyor', this.belt[0] as FrameSprite);
      this.machineLoops.set('conveyor', this.audio.loop('25-conveyor', { volume: 0.18, fadeMs: 800 }) as LoopHandle);
      if (boot) this.arrival('conveyor');
      return;
    }
    if (this.machines.has(u)) return;
    const m = MACHINE_ROWS[u];
    const at = this.layout.machines[u];
    const s = this.clickable(this.place(new FrameSprite(this.assets, [m.id], m.idle).desync(), at), () => ({ kind: 'machine', unlock: u }));
    s.label = `machine:${u}`;
    this.machines.set(u, s);
    if (u === 'grader') this.machineLoops.set('grader', this.audio.loop('26-sorter', { volume: 0.14, fadeMs: 800 }) as LoopHandle);
    if (!boot) return;
    // arrival: pop into place on its pad, puff steam, run one cycle, settle, and the pad glows
    const k = { s: 0.2 };
    animate(k, { s: [0.2, 1.2, 1], duration: 520, ease: 'outBack(2)', onUpdate: () => s.squash(k.s, k.s) });
    s.play(m.run, { restart: true });
    setTimeout(() => s.play(m.idle), 1600);
    this.fx.burst('steam-puff', at.x, at.y - 18, { count: 3, spread: 8, rise: 0.02 });
    this.arrival(u);
  }

  /** The machine's pad flashes a few times and its name shows, so the player sees where it went. */
  private arrival(u: UnlockId): void {
    this.showLabel(u, MACHINE_NAME[u], 3000);
    const pad = this.layout.pads[u];
    const ring = new Graphics().rect(pad.left - 2, pad.top - 2, pad.right - pad.left + 4, pad.bottom - pad.top + 4).stroke({ color: 0xf2c94c, width: 2 });
    this.layers.by.labels.addChild(ring);
    animate(ring, { alpha: [1, 0, 1, 0, 1, 0], duration: 1800, ease: steps(6), onComplete: () => ring.destroy() });
  }

  // ---- events ---------------------------------------------------------------------------------

  onEvent(e: ClientEvent): void {
    const l = this.layout;
    switch (e.kind) {
      case 'hensBought':
        // the new hens hatch in the yard (sync, which runs first, starts their eggs)
        break;
      case 'feedBought': {
        const hopper = this.machines.get('hopper');
        if (e.auto && hopper) {
          // the hopper pours grain into the trough
          hopper.play('refilling', { loop: false, restart: true, onDone: () => hopper.play('idle') });
          this.fx.burst('dust-puff', l.trough.x + 20, l.trough.y - 8, { count: 2, spread: 6 });
        } else {
          this.sack.play('tip', {
            loop: false,
            restart: true,
            onDone: () => {
              this.sack.play('pour');
              setTimeout(() => this.sack.play('idle'), 1300);
            },
          });
        }
        this.audio.play('28-grain');
        this.trough.play('spill', { loop: false, restart: true });
        break;
      }
      case 'coopBuilt': {
        const plot = l.plots[e.plot];
        const coop = this.coops.get(e.coopId);
        if (!plot || !coop) break;
        coop.s.play('build', { loop: false, restart: true, onDone: () => coop.s.still('idle', 0) });
        const k = { y: 0.1 };
        createTimeline()
          .add(k, { y: [0.1, 1.25], duration: 380, ease: 'outQuad', onUpdate: () => coop.s.squash(1 + (1 - k.y) * 0.4, k.y) })
          .add(k, {
            y: [1.25, 0.85, 1],
            duration: 420,
            ease: 'outElastic(1, .5)',
            onUpdate: () => coop.s.squash(1 + (1 - k.y) * 0.4, k.y),
            onBegin: () => {
              juice.shake(2, 220);
              this.fx.burst('dust-puff', plot.x, plot.y, { count: 4, spread: 18 });
            },
          });
        this.audio.play('21-build');
        this.audio.play('07-chorus', { delayMs: 900, volume: 0.8 });
        let n = 0;
        for (const actor of this.hens.values()) {
          if (n++ > 6) break;
          actor.walkTo({ x: plot.x + (Math.random() * 40 - 20), y: plot.y + 14 + Math.random() * 10 });
        }
        break;
      }
      case 'coopUpgraded': {
        const coop = this.coops.get(e.coopId);
        if (!coop) break;
        coop.s.play('upgrade', { loop: false, restart: true, onDone: () => coop.s.still('idle', 0) });
        const plot = l.plots[coop.plot];
        if (plot) this.fx.burst('dust-puff', plot.x, plot.y, { count: 4, spread: 18 });
        juice.shake(2, 200);
        this.audio.play('21-build');
        break;
      }
      case 'unlockBought':
        this.ensureMachine(e.unlock, true);
        this.audio.play('24-machine');
        juice.shake(1, 160);
        break;
      case 'machineBroke': {
        // the breakdown: a last sputter, a clunk, smoke, and it stops
        const at = this.machineSpot(e.unlock);
        const s = this.machineSprites(e.unlock);
        for (const x of s) x.play(e.unlock === 'conveyor' ? 'horizontal' : MACHINE_ROWS[e.unlock].run, { restart: true });
        this.audio.play('22-boing', { volume: 0.7 });
        this.audio.play('32-collapse', { delayMs: 380, volume: 0.6 });
        setTimeout(() => {
          this.fx.burst('dust-puff', at.x, at.y - 10, { count: 4, spread: 12, rise: 0.03 });
          this.fx.burst('steam-puff', at.x, at.y - 22, { count: 3, spread: 8, rise: 0.04 });
          juice.shake(2, 220);
          this.machineCondition(e.unlock);
        }, 400);
        break;
      }
      case 'machineRepaired': {
        // the repair: hammer taps, a shine, and it starts up again
        const at = this.machineSpot(e.unlock);
        for (const ms of [0, 220, 440]) this.audio.play('21-build', { delayMs: ms, volume: 0.5 });
        setTimeout(() => {
          this.fx.burst('sparkle', at.x, at.y - 20, { count: 6, spread: 14, rise: 0.02 });
          this.audio.play('24-machine', { volume: 0.7 });
          this.machineCondition(e.unlock);
          for (const x of this.machineSprites(e.unlock)) {
            const k = { s: 1 };
            animate(k, { s: [1, 1.12, 1], duration: 360, ease: 'outBack(2)', onUpdate: () => x.squash(k.s, k.s) });
          }
        }, 620);
        break;
      }
      case 'collected': {
        const g = this.eggs.get(e.eggId);
        if (!g) break;
        this.eggs.delete(e.eggId);
        if (!e.auto) {
          juice.hitstop(45);
          this.fx.burst('sparkle', g.s.x, g.s.y - 6);
          this.audio.play('08-egg-pop');
        }
        this.flyToCrate(g.s, 0, () => this.audio.play('12-crate', { volume: 0.5, minGapMs: 60 }));
        break;
      }
      case 'sold': {
        this.fx.burst('cash-burst', l.crate.x, l.crate.y - 16);
        this.crate.play('egg-drop', { loop: false, restart: true });
        this.hooks.coins(this.toStage({ x: l.crate.x, y: l.crate.y - 20 }), Math.min(12, 3 + Math.round(e.totalMilli / 4000)));
        this.machines.get('grader')?.play('sort-flash', { loop: false, restart: true, onDone: () => this.machines.get('grader')?.play('idle') });
        this.machines.get('clerk')?.play('celebrate', { loop: false, restart: true, onDone: () => this.machines.get('clerk')?.play('idle') });
        let n = 0;
        for (const a of this.hens.values()) if (n++ < 8 && Math.random() < 0.6) a.cheer();
        break;
      }
      case 'cardResolved':
        if (e.auto) this.machines.get('clerk')?.play('stamping', { loop: false, restart: true, onDone: () => this.machines.get('clerk')?.play('idle') });
        break;
      case 'contractDelivered':
        this.cartTrip();
        break;
      case 'dayEnded':
        this.haul(e.summary.autoCollected);
        break;
      case 'newDay':
        this.audio.play('37-crow');
        this.audio.play('45-new-day', { delayMs: 700 });
        break;
      case 'crash':
        if (e.on) {
          juice.shake(4, 520);
          this.audio.play('33-siren');
          this.audio.play('45-market-crash', { delayMs: 300 });
        }
        break;
      case 'rivalBust': {
        const r = this.rivals.find((x) => x.sign && !x.bust && x.s.label === `rival:${e.name}`);
        if (r) {
          r.bust = true;
          r.s.play('tip-over', { loop: false, restart: true, onDone: () => r.s.still('tip-over', 3) });
        }
        for (let i = 0; i < 8; i++) this.fx.burst('falling-feather', 40 + i * 58, 40 + (i % 3) * 14, { count: 1, gravity: 0.00002 });
        this.audio.play('32-collapse');
        this.audio.play('23-sign-fall', { delayMs: 250 });
        this.audio.play('45-rival-bust', { delayMs: 600 });
        juice.shake(3, 360);
        break;
      }
      default:
        break;
    }
  }

  /** The delivery cart: loaded, down the path to the gate, and back to its spot by the crate. */
  private cartTrip(): void {
    const cart = this.machines.get('cart');
    if (!cart || cart.busy) return;
    const home = this.layout.machines.cart;
    const gate = { x: this.layout.gate.x, y: this.layout.fence.y + 12 };
    const box = { y: home.y };
    cart.play('moving');
    this.audio.play('27-cart', { volume: 0.4 });
    createTimeline()
      .add(box, { y: gate.y, duration: 1600, ease: 'inOutSine', onUpdate: () => this.moveTo(cart, { x: home.x, y: box.y }) })
      .add(box, { y: home.y, duration: 1600, delay: 400, ease: 'inOutSine', onUpdate: () => this.moveTo(cart, { x: home.x, y: box.y }), onBegin: () => cart.face(-1) })
      .then(() => {
        cart.face(1);
        cart.play('unload', { loop: false, restart: true, onDone: () => cart.play('idle') });
      });
  }

  /** Day close: every egg on the ground streams into the crate; a big one shakes the farm. */
  private haul(count: number): void {
    const l = this.layout;
    const onGround = [...this.eggs.values()].filter((g) => !g.egg.broken);
    onGround.forEach((g, i) => {
      this.eggs.delete(g.egg.id);
      this.flyToCrate(g.s, i * 40, () => {
        if (i % 3 === 0) this.audio.play('12-crate', { volume: 0.5, minGapMs: 50 });
      });
    });
    const big = count >= 8;
    setTimeout(() => {
      this.crate.play(big ? 'overflow' : this.crateRow(), { restart: true });
      if (!big) return;
      juice.hitstop(90);
      juice.shake(3, 300);
      this.fx.burst('confetti', l.crate.x, l.crate.y - 24, { count: 3, spread: 12 });
      this.hooks.coins(this.toStage({ x: l.crate.x, y: l.crate.y - 20 }), 6);
      this.audio.play('14-coins-large');
      setTimeout(() => this.crate.play(this.crateRow()), 1400);
    }, onGround.length * 40 + 420);
  }

  private flyToCrate(s: FrameSprite, delay: number, onLand: () => void): void {
    const l = this.layout;
    const from = { x: s.x, y: s.y };
    const to = { x: l.crate.x + (Math.random() * 10 - 5), y: l.crate.y - 14 };
    const box = { p: 0 };
    s.zIndex = 1_000_000;
    animate(box, {
      p: 1,
      delay,
      duration: 420,
      ease: 'inQuad',
      onUpdate: () => {
        if (s.destroyed) return;
        const p = box.p;
        s.position.set(Math.round(from.x + (to.x - from.x) * p), Math.round(from.y + (to.y - from.y) * p - 36 * 4 * p * (1 - p)));
      },
      onComplete: () => {
        if (!s.destroyed) s.destroy();
        onLand();
      },
    });
  }

  /**
   * An egg on a farm with a conveyor: it rolls down to the belt, rides it past the grader (which
   * flashes as it sorts) and drops into the crate. The server collects it as it lands.
   */
  private ride(g: GroundEgg): void {
    const l = this.layout;
    const s = g.s;
    g.pending = true;
    this.eggs.delete(g.egg.id);
    s.eventMode = 'none';
    const beltY = l.conveyor.y - 2;
    const startX = Math.max(l.conveyor.from + 8, Math.min(l.conveyor.to, s.x));
    const box = { x: s.x, y: s.y };
    const beltMs = Math.max(600, ((l.conveyor.to - startX) / 120) * 1000);
    const grader = this.machines.get('grader');
    createTimeline({ delay: 500 })
      .add(box, { x: startX, y: beltY, duration: 700, ease: 'inQuad', onUpdate: () => !s.destroyed && this.moveTo(s, box) })
      .add(box, { x: l.conveyor.to - 3, duration: Math.min(RIDE_MS - 1800, beltMs), ease: 'linear', onUpdate: () => !s.destroyed && this.moveTo(s, box) })
      .then(() => {
        if (grader) grader.play('sort-flash', { loop: false, restart: true, onDone: () => grader.play('idle') });
        this.audio.play('13-tray', { volume: 0.3, minGapMs: 200 });
        if (!s.destroyed) this.flyToCrate(s, 120, () => this.audio.play('12-crate', { volume: 0.4, minGapMs: 80 }));
      });
  }

  /**
   * New hens hatch: each egg drops into a free spot in the yard (clear of every object, the path
   * and the other hens), lands with a squash, wobbles, cracks and bursts, and the hen pops out,
   * shakes herself off and wanders. Several hatch a beat apart; three or more get the chorus.
   */
  private hatch(actors: HenActor[]): void {
    const others = [...this.hens.values()].filter((a) => !actors.includes(a)).map((a) => a.position);
    const spots = hatchSpots(this.areas, others, actors.length);
    actors.forEach((actor, i) => {
      const at = spots[i] ?? freeSpot(this.areas, others);
      actor.awaitHatch(at);
      setTimeout(() => this.hatchOne(actor, at), 120 + i * HATCH_STAGGER_MS);
    });
    if (actors.length >= 3) this.audio.play('07-chorus', { delayMs: 120 + actors.length * HATCH_STAGGER_MS + 1400, volume: 0.8 });
  }

  private hatchOne(actor: HenActor, at: Point): void {
    if (actor.sprite.destroyed) return;
    const egg = this.place(new FrameSprite(this.assets, ['x-hatch-egg'], 'land').still('land', 0));
    egg.label = 'hatch-egg';
    this.hatchEggs.add(egg);
    // one pixel lower than the hen, so the shell halves sit in front of her as she pops out
    const ground = { x: Math.round(at.x), y: Math.round(at.y) + 1 };
    const drop = { y: ground.y - 46 };
    this.moveTo(egg, { x: ground.x, y: drop.y });
    const gone = () => egg.destroyed || actor.sprite.destroyed;
    const done = () => {
      this.hatchEggs.delete(egg);
      if (!egg.destroyed) this.unplace(egg);
    };
    animate(drop, {
      y: ground.y,
      duration: 280,
      ease: 'inQuad',
      onUpdate: () => !egg.destroyed && egg.position.set(ground.x, Math.round(drop.y)),
      onComplete: () => {
        if (gone()) return done();
        this.moveTo(egg, ground);
        juice.shake(1, 140);
        this.fx.burst('dust-puff', ground.x, ground.y - 2, { count: 2, spread: 8 });
        egg.play('land', {
          loop: false,
          restart: true,
          onDone: () => {
            if (gone()) return done();
            egg.play('wobble');
            setTimeout(() => {
              if (gone()) return done();
              this.audio.play('09-crack', { volume: 0.8 });
              egg.play('crack', {
                loop: false,
                restart: true,
                onDone: () => {
                  if (gone()) return done();
                  this.audio.play(Math.random() < 0.5 ? '08-egg-pop' : '10-splat', { volume: 0.8 });
                  juice.hitstop(40);
                  egg.play('burst', {
                    loop: false,
                    restart: true,
                    onDone: () => {
                      if (egg.destroyed) return;
                      egg.play('shell-bits', {
                        loop: false,
                        restart: true,
                        onDone: () => animate(egg, { alpha: 0, duration: 300, delay: 250, onComplete: done }),
                      });
                    },
                  });
                  setTimeout(() => {
                    if (actor.sprite.destroyed) return;
                    actor.popOut();
                    this.fx.burst('feather-puff', ground.x, ground.y - 12, { count: 4, spread: 12, rise: 10 });
                    this.audio.play('01-cluck', { delayMs: 160, volume: 0.8 });
                  }, 130);
                },
              });
            }, 700 + Math.random() * 400);
          },
        });
      },
    });
  }

  private spawnEgg(egg: LaidEgg, at: Point, animated: boolean): void {
    const s = new FrameSprite(this.assets, [`11-egg-${egg.grade}`], egg.grade === 'golden' ? 'shimmer' : 'wobble').desync();
    s.label = `egg:${egg.id}`;
    s.position.set(Math.round(at.x), Math.round(at.y));
    this.layers.add('depth', s);
    if (egg.broken) {
      s.play('crack', {
        loop: false,
        onDone: () => s.play('splat', { loop: false, onDone: () => animate(s, { alpha: 0, duration: 600, delay: 900, onComplete: () => s.destroy() }) }),
      });
      if (animated) this.audio.play('09-crack', { delayMs: 200, volume: 0.8 });
      this.trackSprite(s);
      return;
    }
    const g: GroundEgg = { egg, s, pending: false };
    this.eggs.set(egg.id, g);
    s.eventMode = 'static';
    s.cursor = 'pointer';
    // eggs are small: a generous hit box so a tap on a phone finds them
    s.hitBox(3);
    s.on('pointerover', () => {
      s.filters = [HOVER];
    });
    s.on('pointerout', () => {
      s.filters = [];
    });
    s.on('pointertap', () => {
      if (g.pending) return;
      g.pending = true;
      void this.hooks.collect(egg.id).then((ok) => {
        if (ok) return;
        g.pending = false;
        animate(s, { x: [s.x - 2, s.x + 2, s.x], duration: 200, ease: 'linear' });
      });
    });
    this.trackSprite(s);
    if (animated) {
      // drop with squash and stretch
      const k = { y: -10 };
      animate(k, {
        y: 0,
        duration: 260,
        ease: 'inQuad',
        onUpdate: () => {
          if (!s.destroyed) s.y = Math.round(at.y + k.y);
        },
        onComplete: () => {
          const b = { sx: 1.35, sy: 0.65 };
          animate(b, { sx: 1, sy: 1, duration: 360, ease: 'outElastic(1, .45)', onUpdate: () => s.squash(b.sx, b.sy) });
        },
      });
      this.fx.burst('feather-puff', at.x, at.y - 10);
      this.audio.play('02-lay', { volume: 0.8 });
      this.audio.play('01-cluck', { delayMs: 180, volume: 0.6, minGapMs: 400 });
      if (egg.grade === 'golden') {
        this.audio.play('11-golden', { delayMs: 300 });
        this.fx.burst('sparkle', at.x, at.y - 8, { count: 3, spread: 6 });
      }
    }
    // with a conveyor, a fresh egg rides to the crate on its own
    if (this.hasConveyor && dayElapsed() - egg.atMs < 4000) this.ride(g);
  }

  private trackSprite(s: FrameSprite): void {
    this.loose.add(s);
    s.once('destroyed', () => this.loose.delete(s));
  }

  /** Lay events whose time has come: animate them on a hen (or drop them in place on load). */
  private processLays(): void {
    const farm = this.farm;
    if (!farm || !sameDay(farm)) return;
    const now = dayElapsed();
    const actors = [...this.hens.values()];
    for (const egg of farm.layPlan) {
      if (this.spawned.has(egg.id) || egg.atMs > now) continue;
      this.spawned.add(egg.id);
      if (egg.collected) continue;
      const fresh = now - egg.atMs < 4000;
      const actor = this.hens.get(egg.henId) ?? actors[Math.floor(Math.random() * actors.length)];
      if (fresh && actor && !actor.busy && !isNight()) {
        actor.lay((at) => this.spawnEgg(egg, at, true));
      } else {
        const at = actor ? actor.position : freeSpot(this.areas, []);
        this.spawnEgg(egg, { x: at.x + (Math.random() * 12 - 6), y: at.y + (Math.random() * 6 - 3) }, false);
      }
    }
  }

  private syncDayNight(): void {
    const night = isNight();
    if (night === this.nightOn) return;
    this.nightOn = night;
    animate(this.night, { alpha: night ? 1 : 0, duration: 2400, ease: steps(6) });
    this.farmhouse.play(night ? 'night' : 'day');
    if (night) {
      this.ambience.day?.stop(1500);
      this.ambience.night = this.audio.loop('38-night', { volume: 0.5, fadeMs: 1500 });
      this.ambience.snore = this.audio.loop('05-snore', { volume: 0.22, fadeMs: 3000 });
    } else {
      this.ambience.night?.stop(1500);
      this.ambience.snore?.stop(800);
      this.ambience.day = this.audio.loop('39-day', { volume: 0.45, fadeMs: 1500 });
    }
  }

  /** The coop nearest a point swings its door once (a hen going in or coming out). */
  private door(at: Point): void {
    let best: { s: FrameSprite; swungAt: number } | null = null;
    let bestD = Infinity;
    for (const c of this.coops.values()) {
      const d = Math.abs(c.s.x - at.x) + Math.abs(c.s.y - at.y);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    if (!best || bestD > 90) return;
    const now = performance.now();
    if (now - best.swungAt < 1500 || best.s.busy) return;
    best.swungAt = now;
    const s = best.s;
    s.play('idle', { loop: false, restart: true, onDone: () => s.still('idle', 0) });
  }

  update(dtMs: number): void {
    this.processLays();
    this.syncDayNight();
    const l = this.layout;
    const fed = (this.farm?.fedToday ?? 0) > 0;
    const coopSpots = [...this.coops.values()].map((c) => l.plots[c.plot]).filter((p): p is Point => Boolean(p));
    const areas = this.areas;
    const spots = troughSpots(l).map((p) => nearestFree(p, areas));
    const positions = () => [...this.hens.values()].map((a) => a.position);
    const world = {
      night: this.nightOn,
      fed,
      troughSpot: (from: Point) => route(from, spots[Math.floor(Math.random() * spots.length)] ?? nearestFree(l.trough, areas), areas),
      roost: (from: Point) => {
        const c = coopSpots[this.roostIndex++ % Math.max(1, coopSpots.length)] ?? { x: 100, y: 160 };
        return route(from, nearestFree({ x: Math.round(c.x + (Math.random() * 44 - 22)), y: Math.round(c.y + 12 + Math.random() * 14) }, areas), areas);
      },
      spot: (from: Point) => route(from, freeSpot(areas, positions()), areas),
      door: (at: Point) => this.door(at),
    };
    for (const a of this.hens.values()) {
      a.update(dtMs, world);
      WorldLayers.resort(a.sprite);
    }
    // a coop at rest creaks now and then: one swing of the door, then still again
    const now = performance.now();
    for (const c of this.coops.values()) {
      if (now < c.nextCreak || c.s.busy) continue;
      c.nextCreak = now + 25_000 + Math.random() * 50_000;
      c.s.play('idle', { loop: false, restart: true, onDone: () => c.s.still('idle', 0) });
    }
    for (const s of this.animated) s.update(dtMs);
    for (const s of this.belt) s.update(dtMs);
    for (const s of this.loose) if (!s.destroyed) s.update(dtMs);
    this.fx.update(dtMs);
  }

  /** Where a machine stands (its feet), for its smoke and sparkles. */
  private machineSpot(u: UnlockId): Point {
    return u === 'conveyor' ? { x: Math.round((this.layout.conveyor.from + this.layout.conveyor.to) / 2), y: this.layout.conveyor.y + 6 } : this.layout.machines[u];
  }

  private machineSprites(u: UnlockId): FrameSprite[] {
    if (u === 'conveyor') return this.belt;
    const s = this.machines.get(u);
    return s ? [s] : [];
  }

  /**
   * A machine as its condition shows it: broken, its broken look (stopped, a puff of smoke rising),
   * its sound stopped, and now and then a puff from the effects; worn under half, its worn look
   * (rust and dents) with a wobble as it works; otherwise as built. Any work animation asked of a
   * worn or broken machine plays its worn or broken row.
   */
  private machineCondition(u: UnlockId): void {
    const st = this.farm?.machineState?.[u];
    const sprites = this.machineSprites(u);
    if (!st || !sprites.length) return;
    const look = st.broken ? 'broken' : st.condition < 0.5 ? 'worn' : 'normal';
    if (this.looks.get(u) !== look) {
      this.looks.set(u, look);
      for (const s of sprites) {
        // (the alias is set before the sheet changes: changing it replays the current row)
        if (u === 'conveyor') {
          const base = this.beltRow.get(s) ?? 'horizontal';
          const row = look === 'normal' ? base : `${look}-${base}`;
          s.alias = () => row;
          s.setSheets([look === 'normal' ? '18b-conveyor-clean' : '18c-conveyor-wear']);
          if (look === 'normal') s.alias = null;
        } else {
          const m = MACHINE_ROWS[u];
          const row = look === 'normal' ? m.idle : look;
          s.alias = () => row;
          s.setSheets([look === 'normal' ? m.id : WEAR_SHEET[u]]);
          if (look === 'normal') s.alias = null;
        }
      }
    }
    const smoking = this.smoke.has(u);
    if (st.broken && !smoking) {
      this.machineLoops.get(u)?.stop(400);
      this.machineLoops.delete(u);
      const at = this.machineSpot(u);
      this.smoke.set(
        u,
        setInterval(() => this.fx.burst('steam-puff', at.x + (Math.random() - 0.5) * 8, at.y - 22, { count: 1, spread: 4, rise: 0.03 }), 2600),
      );
    } else if (!st.broken && smoking) {
      clearInterval(this.smoke.get(u));
      this.smoke.delete(u);
      if (u === 'conveyor' && !this.machineLoops.has(u)) this.machineLoops.set('conveyor', this.audio.loop('25-conveyor', { volume: 0.18, fadeMs: 800 }) as LoopHandle);
      if (u === 'grader' && !this.machineLoops.has(u)) this.machineLoops.set('grader', this.audio.loop('26-sorter', { volume: 0.14, fadeMs: 800 }) as LoopHandle);
    }
    // worn: a wobble while it works (not the belt, not when broken)
    const worn = look === 'worn' && u !== 'conveyor';
    if (worn && !this.wobble.has(u)) {
      const s = sprites[0] as FrameSprite;
      const k = { r: 0 };
      this.wobble.set(u, animate(k, { r: [-0.025, 0.025], duration: 260, alternate: true, loop: true, ease: 'inOutSine', onUpdate: () => (s.rotation = k.r) }));
    } else if (!worn && this.wobble.has(u)) {
      this.wobble.get(u)?.pause();
      this.wobble.delete(u);
      for (const s of sprites) s.rotation = 0;
    }
  }

  destroy(): void {
    for (const id of this.smoke.values()) clearInterval(id);
    for (const w of this.wobble.values()) w.pause();
    this.ambience.day?.stop(600);
    this.ambience.night?.stop(600);
    this.ambience.snore?.stop(600);
    for (const l of this.machineLoops.values()) l?.stop(600);
    this.root.destroy({ children: true });
  }
}
