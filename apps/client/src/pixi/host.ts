// One PixiJS application for the whole game: a 640x360 canvas, nearest-neighbour everywhere,
// scaled up by a whole number in CSS. Screens swap scenes in and out.
import { Application, Container, TextureSource } from 'pixi.js';
import { juice } from '../motion/juice';

TextureSource.defaultOptions.scaleMode = 'nearest';

export const GAME_W = 640;
export const GAME_H = 360;

export interface Scene {
  readonly root: Container;
  update(dtMs: number): void;
  destroy(): void;
}

export class PixiHost {
  private scene: Scene | null = null;

  private constructor(readonly app: Application) {}

  static async create(parent: HTMLElement): Promise<PixiHost> {
    const app = new Application();
    await app.init({
      width: GAME_W,
      height: GAME_H,
      resolution: 1,
      antialias: false,
      roundPixels: true,
      background: '#2a160c',
      autoDensity: false,
      preference: 'webgl',
    });
    app.canvas.setAttribute('aria-hidden', 'true');
    parent.prepend(app.canvas);
    const host = new PixiHost(app);
    app.ticker.add((t) => {
      if (!host.scene) return;
      // Hitstop freezes the world: scenes get no time while it lasts.
      host.scene.update(juice.frozen() ? 0 : Math.min(t.deltaMS, 100));
      const o = juice.offset();
      host.scene.root.position.set(o.x, o.y);
    });
    return host;
  }

  /** Swaps scenes; keep leaves the old one alive (the farm keeps running behind the market board). */
  setScene(scene: Scene | null, opts: { keep?: boolean } = {}): void {
    if (this.scene && this.scene !== scene) {
      this.app.stage.removeChild(this.scene.root);
      if (!opts.keep) this.scene.destroy();
    }
    this.scene = scene;
    if (scene) this.app.stage.addChild(scene.root);
  }
}
