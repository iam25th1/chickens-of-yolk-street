// One hen on the farm: stacked trait layers, a small behaviour loop (wander, eat, lay, sleep)
// and squash-and-stretch when she lays.
import { animate } from 'animejs';
import type { HenView } from '@coys/shared';
import type { AssetStore } from '../../assets/store';
import { FrameSprite } from '../FrameSprite';
import type { Point } from './layout';

type HenState = 'idle' | 'walk' | 'eat' | 'lay' | 'sleep' | 'happy' | 'sad' | 'hatch';

/** Walks are routes: points to walk to in turn, round anything standing in the way (movement.ts). */
export interface HenWorld {
  night: boolean;
  fed: boolean;
  troughSpot(from: Point): Point[];
  roost(from: Point): Point[];
  /** A free spot in the yard, away from the other hens. */
  spot(from: Point): Point[];
  /** A hen reached (or left) her roost by a coop: the coop's door swings once. */
  door(at: Point): void;
}

/** Layer sheets for a hen's traits, in stack order: body, eyes, comb, accessory. */
export function henLayers(h: HenView): string[] {
  const layers = [h.body === 'cream' ? '02-body' : `02-body@${h.body}`];
  if (h.eyes !== 'default') layers.push(`02-eyes-${h.eyes}`);
  layers.push(`02-comb-${h.comb}`);
  if (h.accessory !== 'none') layers.push(`02-acc-${h.accessory}`);
  return layers;
}

const WALK_SPEED = 0.018; // game pixels per ms

export class HenActor {
  readonly sprite: FrameSprite;
  private state: HenState = 'idle';
  private timer = 400 + Math.random() * 2400;
  private target: Point | null = null;
  /** The rest of the route after target. */
  private route: Point[] = [];
  private afterWalk: HenState = 'idle';
  private puff = { s: 1 };

  constructor(
    assets: AssetStore,
    readonly hen: HenView,
    at: Point,
  ) {
    this.sprite = new FrameSprite(assets, henLayers(hen), 'idle').desync();
    this.sprite.position.set(at.x, at.y);
    this.sprite.face(Math.random() < 0.5 ? 1 : -1);
  }

  get busy(): boolean {
    return this.state === 'lay' || this.state === 'hatch';
  }

  /** A new hen waits, unseen, in her egg at `at` until it bursts (the farm plays the egg). */
  awaitHatch(at: Point): void {
    this.state = 'hatch';
    this.target = null;
    this.route = [];
    this.sprite.position.set(at.x, at.y);
    this.sprite.visible = false;
  }

  /** The egg burst: she pops out with a squash and a stretch, shakes herself off, then wanders. */
  popOut(): void {
    this.sprite.visible = true;
    this.sprite.play('happy');
    const k = { s: 0.35 };
    animate(k, {
      s: [0.35, 1.3, 0.9, 1],
      duration: 620,
      ease: 'outQuad',
      onUpdate: () => this.sprite.squash(2 - k.s, k.s),
    });
    // she shakes herself off: a quick look one way, the other, and back
    for (const [ms, dir] of [[640, -1], [760, 1], [880, -1], [1000, 1]] as const) {
      setTimeout(() => this.state === 'hatch' && this.sprite.face(dir), ms);
    }
    setTimeout(() => {
      if (this.state !== 'hatch') return;
      this.state = 'idle';
      this.timer = 200 + Math.random() * 500;
      this.sprite.play('idle');
    }, 1100);
  }

  get position(): Point {
    return { x: this.sprite.x, y: this.sprite.y };
  }

  walkTo(p: Point | Point[], then: HenState = 'idle'): void {
    if (this.state === 'lay') return;
    const points = Array.isArray(p) ? p.map((q) => ({ ...q })) : [{ ...p }];
    const first = points.shift();
    if (!first) return;
    this.target = first;
    this.route = points;
    this.afterWalk = then;
    this.state = 'walk';
    this.sprite.play('waddle');
  }

  /**
   * The window changed: the yard re-flowed. Carry the hen (and any walk she was on) to her place in
   * the new layout, in world units; she then picks a fresh walk from there.
   */
  carry(map: (p: Point) => Point): void {
    const at = map(this.position);
    this.sprite.position.set(at.x, at.y);
    this.target = null;
    this.route = [];
    if (this.state === 'walk') {
      this.state = 'idle';
      this.afterWalk = 'idle';
      this.timer = 200 + Math.random() * 600;
      this.sprite.play('idle');
    }
  }

  /** Lay: puff up, strain, and drop the egg at frame two. */
  lay(onDrop: (at: Point, dir: number) => void): void {
    this.state = 'lay';
    this.target = null;
    this.route = [];
    this.sprite.play('lay', {
      loop: false,
      restart: true,
      onDone: () => {
        this.state = 'idle';
        this.timer = 600;
        this.sprite.play('idle');
      },
    });
    animate(this.puff, {
      s: [1, 1.16, 0.92, 1],
      duration: 900,
      ease: 'outQuad',
      onUpdate: () => this.sprite.squash(this.puff.s, 2 - this.puff.s),
    });
    setTimeout(() => onDrop({ x: this.sprite.x - 6 * this.sprite.dir, y: this.sprite.y }, this.sprite.dir), 560);
  }

  cheer(): void {
    if (this.state === 'lay' || this.state === 'sleep') return;
    this.state = 'happy';
    this.timer = 1200 + Math.random() * 600;
    this.sprite.play('happy');
  }

  update(dtMs: number, world: HenWorld): void {
    this.sprite.update(dtMs);
    if (this.state === 'lay' || this.state === 'hatch') return;

    if (world.night && this.state !== 'sleep' && this.afterWalk !== 'sleep') {
      this.walkTo(world.roost(this.position), 'sleep');
    } else if (!world.night && this.state === 'sleep') {
      world.door(this.position);
      this.walkTo(world.spot(this.position));
    }

    if (this.state === 'walk' && this.target) {
      const dx = this.target.x - this.sprite.x;
      const dy = this.target.y - this.sprite.y;
      const dist = Math.hypot(dx, dy);
      const step = WALK_SPEED * dtMs;
      if (Math.abs(dx) > 0.5) this.sprite.face(dx > 0 ? 1 : -1);
      if (dist <= step) {
        this.sprite.position.set(Math.round(this.target.x), Math.round(this.target.y));
        const next = this.route.shift();
        if (next) {
          this.target = next;
          return;
        }
        this.target = null;
        if (this.afterWalk === 'sleep') world.door(this.position);
        this.enter(this.afterWalk);
      } else {
        this.sprite.x += (dx / dist) * step;
        this.sprite.y += (dy / dist) * step;
      }
      return;
    }

    if (this.state === 'sleep') return;
    this.timer -= dtMs;
    if (this.timer > 0) return;
    const roll = Math.random();
    if (!world.fed && roll < 0.25) this.enter('sad');
    else if (world.fed && roll < 0.28) this.walkTo(world.troughSpot(this.position), 'eat');
    else if (roll < 0.8) this.walkTo(world.spot(this.position));
    else this.enter('idle');
  }

  private enter(state: HenState): void {
    this.state = state;
    this.afterWalk = 'idle';
    const rows: Record<HenState, string> = { idle: 'idle', walk: 'waddle', eat: 'eat', lay: 'lay', sleep: 'sleep', happy: 'happy', sad: 'sad', hatch: 'idle' };
    this.sprite.play(rows[state]);
    this.timer = state === 'eat' ? 2200 + Math.random() * 1800 : 800 + Math.random() * 2600;
  }
}
