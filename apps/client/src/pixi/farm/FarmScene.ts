// The farm world. It mirrors the server's farm state (sync) and turns server events into motion
// and sound (onEvent). It never decides an outcome: eggs, sales and builds come from the server.
import { animate, createTimeline, steps } from 'animejs';
import { Container, Graphics, RenderTexture, Sprite, type Renderer } from 'pixi.js';
import type { CoopKind, FarmState, LaidEgg, UnlockId } from '@coys/shared';
import type { AssetStore } from '../../assets/store';
import type { AudioEngine, LoopHandle } from '../../audio/audio';
import { juice } from '../../motion/juice';
import { dayElapsed, isNight, type ClientEvent } from '../../state/game';
import { FrameSprite } from '../FrameSprite';
import { Fx } from '../Fx';
import { GAME_H, GAME_W, type Scene } from '../host';
import { HenActor } from './HenActor';
import { PLOTS, PROPS, SPOTS, TROUGH_SPOTS, YARD, randomIn, type Point } from './layout';

const MAX_VISIBLE_HENS = 40;
const TILE = 16;

export interface FarmHooks {
  collect(eggId: string): Promise<boolean>;
  /** Coins fly from a world point to the cash counter (drawn in the UI layer). */
  coins(from: Point, count: number): void;
}

interface GroundEgg {
  egg: LaidEgg;
  s: FrameSprite;
  pending: boolean;
}

const MACHINE_SPRITES: Record<Exclude<UnlockId, 'conveyor'>, { id: string; idle: string; run: string; at: Point }> = {
  grader: { id: '19-egg-grader', idle: 'idle', run: 'running', at: SPOTS.grader },
  hopper: { id: '21-feed-hopper', idle: 'idle', run: 'refilling', at: SPOTS.hopper },
  cart: { id: '20-delivery-cart', idle: 'idle', run: 'moving', at: SPOTS.cart },
  clerk: { id: '22-sales-clerk', idle: 'idle', run: 'stamping', at: SPOTS.clerk },
};

export class FarmScene implements Scene {
  readonly root = new Container();
  private readonly world = new Container();
  private readonly ysort = new Container();
  private readonly fx: Fx;
  private readonly night = new Graphics();
  private readonly animated: FrameSprite[] = [];
  private readonly hens = new Map<string, HenActor>();
  private readonly coops = new Map<string, { s: FrameSprite; kind: CoopKind; plot: number }>();
  private readonly machines = new Map<string, FrameSprite>();
  private readonly conveyor: FrameSprite[] = [];
  private readonly eggs = new Map<string, GroundEgg>();
  private readonly spawned = new Set<string>();
  private farmhouse: FrameSprite;
  private trough: FrameSprite;
  private sack: FrameSprite;
  private crate: FrameSprite;
  private farm: FarmState | null = null;
  private nightOn = false;
  private ambience: { day: LoopHandle | null; night: LoopHandle | null; snore: LoopHandle | null } = { day: null, night: null, snore: null };
  private machineLoops = new Map<string, LoopHandle>();
  private roostIndex = 0;

  constructor(
    private readonly assets: AssetStore,
    private readonly audio: AudioEngine,
    renderer: Renderer,
    private readonly hooks: FarmHooks,
  ) {
    this.fx = new Fx(assets);
    this.world.addChild(this.bakeGround(renderer));
    this.ysort.sortableChildren = true;
    this.world.addChild(this.ysort, this.fx.layer);
    this.night.rect(0, 0, GAME_W, GAME_H).fill({ color: 0x1b2a4a, alpha: 0.42 });
    this.night.alpha = 0;
    this.root.addChild(this.world, this.night);

    // tiles that move: grass in the wind, straw fluttering in the yard
    for (const [row, x, y] of [
      ['grass-sway', 8, 64],
      ['grass-sway', 392, 96],
      ['grass-sway', 104, 328],
      ['grass-sway', 344, 330],
      ['straw-flutter', 72, 200],
      ['straw-flutter', 312, 264],
      ['straw-flutter', 184, 296],
    ] as const) {
      const s = new FrameSprite(assets, ['23-farm-tileset'], row).desync();
      s.position.set(x + TILE / 2, y + TILE / 2);
      this.world.addChildAt(s, 1);
      this.animated.push(s);
    }

    for (const p of PROPS) this.place(new FrameSprite(assets, ['24-farm-props'], p.row).desync(), p);
    this.farmhouse = this.place(new FrameSprite(assets, ['16-farmhouse'], 'day'), SPOTS.farmhouse);
    this.place(new FrameSprite(assets, ['17-sign-farm'], 'sway').desync(), SPOTS.sign);
    this.trough = this.place(new FrameSprite(assets, ['14-trough'], 'full'), SPOTS.trough);
    this.sack = this.place(new FrameSprite(assets, ['13-sack-standard'], 'idle'), SPOTS.sack);
    this.crate = this.place(new FrameSprite(assets, ['12-crate'], 'empty'), SPOTS.crate);

    this.ambience.day = audio.loop('39-day', { volume: 0.45, fadeMs: 1200 });
  }

  private place<T extends FrameSprite>(s: T, at: Point): T {
    s.position.set(at.x, at.y);
    s.zIndex = at.y;
    this.ysort.addChild(s);
    this.animated.push(s);
    return s;
  }

  private unplace(s: FrameSprite): void {
    const i = this.animated.indexOf(s);
    if (i >= 0) this.animated.splice(i, 1);
    s.destroy();
  }

  /** Grass, straw yard, dirt path and fence, drawn once into a texture. */
  private bakeGround(renderer: Renderer): Sprite {
    const g = new Container();
    const tile = (cx: number, cy: number, x: number, y: number) => {
      const t = new Sprite(this.assets.region('23-farm-tileset', cx * 128, cy * 128, 128, 128));
      t.scale.set(1 / 8);
      t.position.set(x, y);
      g.addChild(t);
    };
    for (let y = 0; y < GAME_H; y += TILE) for (let x = 0; x < GAME_W; x += TILE) tile(Math.floor(Math.random() * 4), 0, x, y);
    for (let y = YARD.top - 8; y < YARD.bottom + 8; y += TILE)
      for (let x = YARD.left - 8; x < YARD.right + 8; x += TILE) tile(Math.floor(Math.random() * 2), 3, x, y); // straw columns 2 and 3 carry an egg and a quill
    for (let y = 248; y < GAME_H; y += TILE) for (const x of [424, 440]) tile(0, 2, x, y);
    for (let x = 0; x < 424; x += TILE) tile(x % 64 === 0 ? 1 : 0, 6, x, 326);
    const rt = RenderTexture.create({ width: GAME_W, height: GAME_H, scaleMode: 'nearest' });
    renderer.render({ container: g, target: rt });
    g.destroy({ children: true });
    return new Sprite(rt);
  }

  // ---- state ----------------------------------------------------------------------------------

  sync(farm: FarmState): void {
    const first = this.farm === null;
    this.farm = farm;

    // hens: show up to MAX_VISIBLE_HENS; new ones waddle in through the gate
    const shown = farm.hens.slice(0, MAX_VISIBLE_HENS);
    const ids = new Set(shown.map((h) => h.id));
    for (const [id, actor] of this.hens) {
      if (!ids.has(id)) {
        actor.sprite.destroy();
        this.hens.delete(id);
      }
    }
    for (const h of shown) {
      if (this.hens.has(h.id)) continue;
      const actor = new HenActor(this.assets, h, first ? randomIn(YARD) : SPOTS.gate);
      this.hens.set(h.id, actor);
      this.ysort.addChild(actor.sprite);
      if (!first) actor.walkTo(randomIn(YARD));
    }

    // coops
    for (const c of farm.coops) {
      const have = this.coops.get(c.id);
      const plot = PLOTS[c.plot] ?? PLOTS[0];
      if (!plot) continue;
      if (!have) {
        const s = this.place(new FrameSprite(this.assets, [`15-coop-${c.kind}`], 'idle').desync(), plot);
        this.coops.set(c.id, { s, kind: c.kind, plot: c.plot });
      } else if (have.kind !== c.kind) {
        have.kind = c.kind;
        have.s.setSheets([`15-coop-${c.kind}`]);
      }
    }

    // machines bought with unlocks
    for (const u of farm.unlocks) this.ensureMachine(u, false);

    this.trough.play(farm.fedToday > 0 ? 'full' : 'empty');
    const sackId = `13-sack-${farm.feedTier}`;
    if (!this.machines.has(`sack:${sackId}`)) {
      this.unplace(this.sack);
      this.sack = this.place(new FrameSprite(this.assets, [sackId], 'idle'), SPOTS.sack);
      this.machines.set(`sack:${sackId}`, this.sack);
      for (const k of [...this.machines.keys()]) if (k.startsWith('sack:') && k !== `sack:${sackId}`) this.machines.delete(k);
    }
    this.crate.play(this.crateRow());

    // eggs collected elsewhere (or already, after a reconnect) leave the ground
    for (const e of farm.layPlan) {
      const g = this.eggs.get(e.id);
      if (g && e.collected && !g.pending) {
        g.s.destroy();
        this.eggs.delete(e.id);
      }
    }
  }

  private crateRow(): string {
    const c = this.farm?.crate;
    const n = c ? c.white + c.cream + c.brown + c.golden : 0;
    return n === 0 ? 'empty' : n < 20 ? 'half' : n < 60 ? 'full' : 'overflow';
  }

  private ensureMachine(u: UnlockId, boot: boolean): void {
    if (u === 'conveyor') {
      if (this.conveyor.length) return;
      for (let x = SPOTS.conveyorFrom; x <= SPOTS.conveyorTo; x += TILE) {
        const row = x === SPOTS.conveyorFrom ? 'start' : x + TILE > SPOTS.conveyorTo ? 'end' : 'horizontal';
        const s = new FrameSprite(this.assets, ['18-conveyor'], row);
        s.position.set(x, SPOTS.conveyorY);
        s.zIndex = SPOTS.conveyorY - 12;
        this.ysort.addChild(s);
        this.conveyor.push(s);
        if (boot) {
          s.alpha = 0;
          animate(s, { alpha: 1, duration: 120, delay: (x - SPOTS.conveyorFrom) * 2, ease: steps(2) });
        }
      }
      this.machineLoops.set('conveyor', this.audio.loop('25-conveyor', { volume: 0.18, fadeMs: 800 }) as LoopHandle);
      return;
    }
    if (this.machines.has(u)) return;
    const m = MACHINE_SPRITES[u];
    const s = this.place(new FrameSprite(this.assets, [m.id], m.idle).desync(), m.at);
    this.machines.set(u, s);
    if (u === 'grader') this.machineLoops.set('grader', this.audio.loop('26-sorter', { volume: 0.14, fadeMs: 800 }) as LoopHandle);
    if (!boot) return;
    // boot: pop into place, puff steam, run one cycle, settle
    const k = { s: 0.2 };
    animate(k, { s: [0.2, 1.2, 1], duration: 520, ease: 'outBack(2)', onUpdate: () => s.squash(k.s, k.s) });
    s.play(m.run, { restart: true });
    setTimeout(() => s.play(m.idle), 1600);
    this.fx.burst('steam-puff', m.at.x, m.at.y - 18, { count: 3, spread: 8, rise: 0.02 });
  }

  // ---- events ---------------------------------------------------------------------------------

  onEvent(e: ClientEvent): void {
    switch (e.kind) {
      case 'hensBought': {
        this.fx.burst('dust-puff', SPOTS.gate.x, SPOTS.gate.y - 4, { count: 3, spread: 10 });
        this.audio.play('01-cluck', { volume: 0.8 });
        this.audio.play('03-flap', { delayMs: 120, volume: 0.6 });
        break;
      }
      case 'feedBought': {
        this.sack.play('tip', {
          loop: false,
          restart: true,
          onDone: () => {
            this.sack.play('pour');
            setTimeout(() => this.sack.play('idle'), 1300);
          },
        });
        this.audio.play('28-grain');
        this.trough.play('spill', { loop: false, restart: true, onDone: () => this.trough.play('full') });
        break;
      }
      case 'coopBuilt': {
        const plot = PLOTS[e.plot];
        const coop = this.coops.get(e.coopId);
        if (!plot || !coop) break;
        coop.s.play('build', { loop: false, restart: true, onDone: () => coop.s.play('idle') });
        const k = { y: 0.1 };
        createTimeline()
          .add(k, {
            y: [0.1, 1.25],
            duration: 380,
            ease: 'outQuad',
            onUpdate: () => coop.s.squash(1 + (1 - k.y) * 0.4, k.y),
          })
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
        coop.s.play('upgrade', { loop: false, restart: true, onDone: () => coop.s.play('idle') });
        const plot = PLOTS[coop.plot];
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
      case 'collected': {
        const g = this.eggs.get(e.eggId);
        if (!g) break;
        this.eggs.delete(e.eggId);
        juice.hitstop(45);
        this.fx.burst('sparkle', g.s.x, g.s.y - 6);
        this.audio.play('08-egg-pop');
        this.flyToCrate(g.s, 0, () => this.audio.play('12-crate', { volume: 0.5, minGapMs: 60 }));
        break;
      }
      case 'sold': {
        this.fx.burst('cash-burst', SPOTS.crate.x, SPOTS.crate.y - 16);
        this.crate.play('egg-drop', { loop: false, restart: true, onDone: () => this.crate.play(this.crateRow()) });
        this.hooks.coins({ x: SPOTS.crate.x, y: SPOTS.crate.y - 20 }, Math.min(12, 3 + Math.round(e.totalMilli / 4000)));
        let n = 0;
        for (const a of this.hens.values()) if (n++ < 8 && Math.random() < 0.6) a.cheer();
        break;
      }
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
      case 'rivalBust':
        this.audio.play('32-collapse');
        this.audio.play('23-sign-fall', { delayMs: 250 });
        this.audio.play('45-rival-bust', { delayMs: 600 });
        juice.shake(3, 360);
        break;
      default:
        break;
    }
  }

  /** Day close: every egg on the ground streams into the crate; a big one shakes the farm. */
  private haul(count: number): void {
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
      this.fx.burst('confetti', SPOTS.crate.x, SPOTS.crate.y - 24, { count: 3, spread: 12 });
      this.hooks.coins({ x: SPOTS.crate.x, y: SPOTS.crate.y - 20 }, 6);
      this.audio.play('14-coins-large');
      setTimeout(() => this.crate.play(this.crateRow()), 1400);
    }, onGround.length * 40 + 420);
  }

  private flyToCrate(s: FrameSprite, delay: number, onLand: () => void): void {
    const from = { x: s.x, y: s.y };
    const to = { x: SPOTS.crate.x + (Math.random() * 10 - 5), y: SPOTS.crate.y - 14 };
    const box = { p: 0 };
    s.zIndex = 999;
    animate(box, {
      p: 1,
      delay,
      duration: 420,
      ease: 'inQuad',
      onUpdate: () => {
        const p = box.p;
        s.position.set(Math.round(from.x + (to.x - from.x) * p), Math.round(from.y + (to.y - from.y) * p - 36 * 4 * p * (1 - p)));
      },
      onComplete: () => {
        s.destroy();
        onLand();
      },
    });
  }

  private spawnEgg(egg: LaidEgg, at: Point, animated: boolean): void {
    const s = new FrameSprite(this.assets, [`11-egg-${egg.grade}`], egg.grade === 'golden' ? 'shimmer' : 'wobble').desync();
    s.position.set(Math.round(at.x), Math.round(at.y));
    s.zIndex = at.y;
    this.ysort.addChild(s);
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
    if (!animated) return;
    // drop with squash and stretch
    const k = { y: -10, sy: 1.3 };
    animate(k, {
      y: 0,
      duration: 260,
      ease: 'inQuad',
      onUpdate: () => {
        s.y = Math.round(at.y + k.y);
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

  private readonly loose = new Set<FrameSprite>();
  private trackSprite(s: FrameSprite): void {
    this.loose.add(s);
    s.once('destroyed', () => this.loose.delete(s));
  }

  /** Lay events whose time has come: animate them on a hen (or drop them in place on load). */
  private processLays(): void {
    const farm = this.farm;
    if (!farm) return;
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
        const at = actor ? actor.position : randomIn(YARD);
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

  update(dtMs: number): void {
    this.processLays();
    this.syncDayNight();
    const fed = (this.farm?.fedToday ?? 0) > 0;
    const coopSpots = [...this.coops.values()].map((c) => PLOTS[c.plot]).filter((p): p is Point => Boolean(p));
    const world = {
      night: this.nightOn,
      fed,
      troughSpot: () => TROUGH_SPOTS[Math.floor(Math.random() * TROUGH_SPOTS.length)] ?? SPOTS.trough,
      roost: () => {
        const c = coopSpots[this.roostIndex++ % Math.max(1, coopSpots.length)] ?? { x: 100, y: 160 };
        return { x: c.x + (Math.random() * 44 - 22), y: c.y + 12 + Math.random() * 14 };
      },
    };
    for (const a of this.hens.values()) {
      a.update(dtMs, world);
      a.sprite.zIndex = a.sprite.y;
    }
    for (const s of this.animated) s.update(dtMs);
    for (const s of this.conveyor) s.update(dtMs);
    for (const s of this.loose) if (!s.destroyed) s.update(dtMs);
    this.fx.update(dtMs);
  }

  destroy(): void {
    this.ambience.day?.stop(600);
    this.ambience.night?.stop(600);
    this.ambience.snore?.stop(600);
    for (const l of this.machineLoops.values()) l?.stop(600);
    this.root.destroy({ children: true });
  }
}
