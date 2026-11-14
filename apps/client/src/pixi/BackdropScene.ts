// Loading and title backdrops: a 640x360 plate with drifting clouds and little hens. On the title the
// hens march along a path on ground drawn by code in the plate's own colours: the plate's art ends at
// y 300 and below it is one flat green, which a tall window shows as a bare band.
import { Container, Graphics } from 'pixi.js';
import type { AssetStore } from '../assets/store';
import { FrameSprite } from './FrameSprite';
import type { Scene } from './host';
import { Plate, PLATE_H, PLATE_W } from './plate';

/** Where the plate's art ends (below it the plate is one flat green), and the hens' path. */
const GROUND_Y = 300;
const PATH_Y = 342;
/** The plate's own colours: its meadow, its lighter grass, its path and the path's edge. */
const MEADOW = 0x82b425;
const TUFT = 0xafcc22;
const PATH = 0xcdd659;
const PATH_EDGE = 0xbbc138;

interface Drifter {
  s: FrameSprite;
  speed: number;
  min: number;
  max: number;
}

export class BackdropScene implements Scene {
  readonly root = new Container();
  readonly fit = 'plate' as const;
  private readonly drifters: Drifter[] = [];
  private readonly sprites: FrameSprite[] = [];
  private logo: FrameSprite | null = null;
  private readonly plate: Plate;
  /** The title's ground below the plate's art (redrawn to the window's width and height). */
  private readonly ground: Graphics | null;

  constructor(
    private readonly assets: AssetStore,
    readonly kind: 'loading' | 'title',
  ) {
    const plate = kind === 'loading' ? '25-loading-plate' : '26-title-plate';
    const anim = kind === 'loading' ? '25-loading-anim' : '26-title-anim';
    this.plate = new Plate(assets, plate, this.root);
    const at = this.plate.content;
    this.ground = kind === 'title' ? new Graphics() : null;
    if (this.ground) {
      at.addChild(this.ground);
      this.drawGround({ x: 0, y: 0, w: PLATE_W, h: PLATE_H });
    }

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
      const hens: FrameSprite[] = [];
      for (let i = 0; i < 5; i++) {
        // the march row's frames carry anchors that swap sides every frame (the hen would jump half
        // its frame each step): one anchor, the frame's centre, for every frame
        const s = new FrameSprite(assets, [anim], 'hen-march').desync().pin(0.5, 0.5);
        s.position.set(-40 - i * 34, PATH_Y - 6);
        at.addChild(s);
        this.drifters.push({ s, speed: 0.022, min: -200, max: PLATE_W + 40 });
        hens.push(s);
      }
      // read only, for automated checks: where each marching hen is drawn (CSS pixels)
      (window as unknown as { __coysTitle?: unknown }).__coysTitle = { hens: () => hens.map((h) => Math.round(h.getBounds().minX * 10) / 10) };
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

  /**
   * The title's ground from the plate's art line (y 300) to the window's foot, across the window: the
   * plate's meadow green with tufts in its lighter green, and the plate's pale path where the hens walk.
   */
  private drawGround(view: { x: number; y: number; w: number; h: number }): void {
    const g = this.ground;
    if (!g) return;
    const x0 = Math.floor(Math.min(0, view.x)) - 2;
    const x1 = Math.ceil(Math.max(PLATE_W, view.x + view.w)) + 2;
    const y1 = Math.ceil(Math.max(PLATE_H, view.y + view.h)) + 2;
    g.clear();
    g.rect(x0, GROUND_Y, x1 - x0, y1 - GROUND_Y).fill({ color: MEADOW });
    // tufts: two-pixel marks on a fixed grid (the same at every window size), never on the path
    for (let y = GROUND_Y + 4; y < y1; y += 9) {
      if (y > PATH_Y - 13 && y < PATH_Y + 13) continue;
      const shift = ((y - GROUND_Y) / 9) % 2 ? 6 : 0;
      for (let x = Math.floor(x0 / 12) * 12 + shift; x < x1; x += 12) g.rect(x, y, 2, 1).fill({ color: TUFT }).rect(x + 1, y - 1, 1, 1).fill({ color: TUFT });
    }
    g.rect(x0, PATH_Y - 10, x1 - x0, 20).fill({ color: PATH });
    g.rect(x0, PATH_Y - 11, x1 - x0, 1).fill({ color: PATH_EDGE });
    g.rect(x0, PATH_Y + 10, x1 - x0, 1).fill({ color: PATH_EDGE });
  }

  /** Clouds and marching hens cross the whole window, not only the plate. */
  resize(view: { x: number; y: number; w: number; h: number }): void {
    this.plate.resize(view);
    this.drawGround(view);
    for (const d of this.drifters) {
      d.min = Math.min(d.min, view.x - 200);
      d.max = Math.max(PLATE_W + 40, view.x + view.w + 80);
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
