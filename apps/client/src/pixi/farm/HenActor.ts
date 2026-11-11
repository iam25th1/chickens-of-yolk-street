// One hen on the farm: stacked trait layers, a small behaviour loop (wander, eat, lay, sleep)
// and squash-and-stretch when she lays.
import { animate } from 'animejs';
import type { HenView } from '@coys/shared';
import type { AssetStore } from '../../assets/store';
import { FrameSprite } from '../FrameSprite';
import { YARD, randomIn, type Point } from './layout';

type HenState = 'idle' | 'walk' | 'eat' | 'lay' | 'sleep' | 'happy' | 'sad';

export interface HenWorld {
  night: boolean;
  fed: boolean;
  troughSpot(): Point;
  roost(): Point;
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
    return this.state === 'lay';
  }

  get position(): Point {
    return { x: this.sprite.x, y: this.sprite.y };
  }

  walkTo(p: Point, then: HenState = 'idle'): void {
    if (this.state === 'lay') return;
    this.target = { ...p };
    this.afterWalk = then;
    this.state = 'walk';
    this.sprite.play('waddle');
  }

  /** Lay: puff up, strain, and drop the egg at frame two. */
  lay(onDrop: (at: Point, dir: number) => void): void {
    this.state = 'lay';
    this.target = null;
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
    if (this.state === 'lay') return;

    if (world.night && this.state !== 'sleep' && this.afterWalk !== 'sleep') {
      this.walkTo(world.roost(), 'sleep');
    } else if (!world.night && this.state === 'sleep') {
      this.state = 'idle';
      this.timer = 300 + Math.random() * 1500;
      this.sprite.play('idle');
    }

    if (this.state === 'walk' && this.target) {
      const dx = this.target.x - this.sprite.x;
      const dy = this.target.y - this.sprite.y;
      const dist = Math.hypot(dx, dy);
      const step = WALK_SPEED * dtMs;
      if (Math.abs(dx) > 0.5) this.sprite.face(dx > 0 ? 1 : -1);
      if (dist <= step) {
        this.sprite.position.set(Math.round(this.target.x), Math.round(this.target.y));
        this.target = null;
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
    else if (world.fed && roll < 0.28) this.walkTo(world.troughSpot(), 'eat');
    else if (roll < 0.8) this.walkTo(randomIn(YARD));
    else this.enter('idle');
  }

  private enter(state: HenState): void {
    this.state = state;
    this.afterWalk = 'idle';
    const rows: Record<HenState, string> = { idle: 'idle', walk: 'waddle', eat: 'eat', lay: 'lay', sleep: 'sleep', happy: 'happy', sad: 'sad' };
    this.sprite.play(rows[state]);
    this.timer = state === 'eat' ? 2200 + Math.random() * 1800 : 800 + Math.random() * 2600;
  }
}
