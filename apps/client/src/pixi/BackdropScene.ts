// Loading and title backdrops: a 640x360 plate with drifting clouds and little hens.
import { Container } from 'pixi.js';
import type { AssetStore } from '../assets/store';
import { FrameSprite } from './FrameSprite';
import type { Scene } from './host';
import { Plate, PLATE_W } from './plate';

interface Drifter {
  s: FrameSprite;
  speed: number;
  min: number;
  max: number;
}

export class BackdropScene implements Scene {
  readonly root = new Container();
  private readonly drifters: Drifter[] = [];
  private readonly sprites: FrameSprite[] = [];
  private logo: FrameSprite | null = null;
  private readonly plate: Plate;

  constructor(
    private readonly assets: AssetStore,
    readonly kind: 'loading' | 'title',
  ) {
    const plate = kind === 'loading' ? '25-loading-plate' : '26-title-plate';
    const anim = kind === 'loading' ? '25-loading-anim' : '26-title-anim';
    this.plate = new Plate(assets, plate, this.root);
    const at = this.plate.content;

    const cloudRow = kind === 'loading' ? 'big-cloud' : 'clouds';
    const clouds: [string, number, number, number][] = [
      [cloudRow, 40, 18, 0.006],
      ['small-clouds', 260, 40, 0.009],
      [cloudRow, 470, 10, 0.005],
      ['small-clouds', 610, 54, 0.008],
    ];
    for (const [row, x, y, speed] of clouds) {
      const s = new FrameSprite(assets, [anim], row).desync();
      s.position.set(x, y + 16);
      at.addChild(s);
      this.drifters.push({ s, speed, min: -80, max: PLATE_W + 80 });
    }

    if (kind === 'loading') {
      const hens: [string, number, number, 1 | -1][] = [
        ['hen-bob', 140, 318, 1],
        ['hen-peck', 196, 330, -1],
        ['hen-bob', 452, 334, -1],
      ];
      for (const [row, x, y, dir] of hens) {
        const s = new FrameSprite(assets, [anim], row).desync();
        s.position.set(x, y);
        s.face(dir);
        at.addChild(s);
        this.sprites.push(s);
      }
    } else {
      for (let i = 0; i < 5; i++) {
        const s = new FrameSprite(assets, [anim], 'hen-march').desync();
        s.position.set(-40 - i * 34, 336);
        at.addChild(s);
        this.drifters.push({ s, speed: 0.022, min: -200, max: PLATE_W + 40 });
      }
    }
  }

  /** Title logo: stamps in, then idles with its shine. */
  showLogo(onImpact: () => void): FrameSprite {
    const logo = new FrameSprite(this.assets, ['28-logo'], 'stamp-in');
    logo.position.set(PLATE_W / 2, 92);
    logo.play('stamp-in', {
      loop: false,
      onDone: () => logo.play('idle', { loop: true }),
    });
    this.plate.content.addChild(logo);
    this.logo = logo;
    onImpact();
    return logo;
  }

  /** Clouds and marching hens cross the whole window, not only the plate. */
  resize(w: number, h: number): void {
    const o = this.plate.resize(w, h);
    for (const d of this.drifters) {
      d.min = Math.min(d.min, -o.x - 200);
      d.max = Math.max(PLATE_W + 40, w - o.x + 80);
    }
  }

  update(dtMs: number): void {
    for (const d of this.drifters) {
      d.s.update(dtMs);
      d.s.x += d.speed * dtMs;
      if (d.s.x > d.max) d.s.x = d.min;
    }
    for (const s of this.sprites) s.update(dtMs);
    this.logo?.update(dtMs);
  }

  destroy(): void {
    this.root.destroy({ children: true });
  }
}
