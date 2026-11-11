// The market board backdrop: the town square plate, bunting across the top and a milling crowd.
import { Container } from 'pixi.js';
import type { AssetStore } from '../assets/store';
import type { AudioEngine, LoopHandle } from '../audio/audio';
import { FrameSprite } from './FrameSprite';
import type { Scene } from './host';
import { Plate, PLATE_W } from './plate';

export class TownScene implements Scene {
  readonly root = new Container();
  private readonly sprites: FrameSprite[] = [];
  private readonly crowd: { s: FrameSprite; dir: number; min: number; max: number }[] = [];
  private murmur: LoopHandle | null;
  private readonly plate: Plate;

  constructor(
    assets: AssetStore,
    audio: AudioEngine,
  ) {
    this.plate = new Plate(assets, '27-town-square-plate', this.root);
    for (let x = 32; x < PLATE_W; x += 64) {
      const s = new FrameSprite(assets, ['27-town-square-anim'], 'bunting').desync();
      s.position.set(x, 32);
      this.plate.content.addChild(s);
      this.sprites.push(s);
    }
    const rows: [string, number, number][] = [
      ['milling', 90, 318],
      ['chatting', 210, 330],
      ['pointing', 330, 322],
      ['milling', 470, 332],
      ['chatting', 560, 318],
    ];
    for (const [row, x, y] of rows) {
      const s = new FrameSprite(assets, ['27-town-square-anim'], row).desync();
      s.position.set(x, y);
      this.plate.content.addChild(s);
      if (row === 'milling') this.crowd.push({ s, dir: Math.random() < 0.5 ? -1 : 1, min: x - 40, max: x + 40 });
      else this.sprites.push(s);
    }
    this.murmur = audio.loop('34-market', { volume: 0.4, fadeMs: 900 });
  }

  resize(w: number, h: number): void {
    this.plate.resize(w, h);
  }

  update(dtMs: number): void {
    for (const s of this.sprites) s.update(dtMs);
    for (const c of this.crowd) {
      c.s.update(dtMs);
      c.s.x += c.dir * 0.012 * dtMs;
      if (c.s.x < c.min || c.s.x > c.max) {
        c.dir *= -1;
        c.s.face(c.dir > 0 ? 1 : -1);
      }
    }
  }

  destroy(): void {
    this.murmur?.stop(500);
    this.murmur = null;
    this.root.destroy({ children: true });
  }
}
