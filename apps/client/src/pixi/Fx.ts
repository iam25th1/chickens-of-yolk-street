// Particle bursts from 35-particles: feather puffs, sparkles, dust, steam, confetti, cash.
import { Container } from 'pixi.js';
import type { AssetStore } from '../assets/store';
import { FrameSprite } from './FrameSprite';

export type FxRow = 'feather-puff' | 'sparkle' | 'coin' | 'dust-puff' | 'steam-puff' | 'confetti' | 'cash-burst' | 'falling-feather';

interface Particle {
  s: FrameSprite;
  vx: number;
  vy: number;
  g: number;
  life: number;
}

export class Fx {
  readonly layer = new Container();
  private readonly live: Particle[] = [];

  constructor(private readonly assets: AssetStore) {}

  burst(row: FxRow, x: number, y: number, opts: { count?: number; spread?: number; rise?: number; gravity?: number } = {}): void {
    const count = opts.count ?? 1;
    for (let n = 0; n < count; n++) {
      const s = new FrameSprite(this.assets, ['35-particles'], row);
      const spread = opts.spread ?? 0;
      s.position.set(Math.round(x + (Math.random() * 2 - 1) * spread), Math.round(y + (Math.random() * 2 - 1) * spread * 0.5));
      if (count > 1) s.desync();
      this.layer.addChild(s);
      this.live.push({
        s,
        vx: count > 1 ? (Math.random() * 2 - 1) * 0.03 : 0,
        vy: -(opts.rise ?? (count > 1 ? 0.04 : 0)),
        g: opts.gravity ?? 0,
        life: row === 'coin' ? 900 : 2000,
      });
    }
  }

  update(dtMs: number): void {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const p = this.live[i];
      if (!p) continue;
      p.s.update(dtMs);
      p.vy += p.g * dtMs;
      p.s.x += p.vx * dtMs;
      p.s.y += p.vy * dtMs;
      p.life -= dtMs;
      if (p.s.finished || p.life <= 0) {
        p.s.destroy();
        this.live.splice(i, 1);
      }
    }
  }
}
