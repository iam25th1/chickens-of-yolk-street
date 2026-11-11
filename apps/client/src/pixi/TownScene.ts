// The market board backdrop: the town square plate, bunting across the top and a milling crowd.
import { Container, Sprite } from 'pixi.js';
import type { AssetStore } from '../assets/store';
import type { AudioEngine, LoopHandle } from '../audio/audio';
import { FrameSprite } from './FrameSprite';
import { GAME_W, type Scene } from './host';

export class TownScene implements Scene {
  readonly root = new Container();
  private readonly sprites: FrameSprite[] = [];
  private readonly crowd: { s: FrameSprite; dir: number; min: number; max: number }[] = [];
  private murmur: LoopHandle | null;

  constructor(
    assets: AssetStore,
    audio: AudioEngine,
  ) {
    const frame = assets.frames('27-town-square-plate', 'plate')[0];
    if (frame) {
      const bg = new Sprite(frame.texture);
      bg.anchor.set(0);
      bg.scale.set(assets.scale('27-town-square-plate'));
      this.root.addChild(bg);
    }
    for (let x = 32; x < GAME_W; x += 64) {
      const s = new FrameSprite(assets, ['27-town-square-anim'], 'bunting').desync();
      s.position.set(x, 32);
      this.root.addChild(s);
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
      this.root.addChild(s);
      if (row === 'milling') this.crowd.push({ s, dir: Math.random() < 0.5 ? -1 : 1, min: x - 40, max: x + 40 });
      else this.sprites.push(s);
    }
    this.murmur = audio.loop('34-market', { volume: 0.4, fadeMs: 900 });
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
