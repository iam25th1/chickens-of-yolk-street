// One PixiJS application for the whole game. The canvas fills the window at device resolution;
// the world is 360 pixels tall (see app/viewport.ts) and drawn nearest-neighbour with rounded pixels.
// Scenes are told the visible world size and lay themselves out to it.
import { Application, Container, TextureSource } from 'pixi.js';
import { viewport, type Viewport } from '../app/viewport';
import { juice } from '../motion/juice';

TextureSource.defaultOptions.scaleMode = 'nearest';

export interface Scene {
  readonly root: Container;
  update(dtMs: number): void;
  /** The visible world, in world pixels. */
  resize?(width: number, height: number): void;
  destroy(): void;
}

export class PixiHost {
  private scene: Scene | null = null;
  private readonly world = new Container();

  private constructor(readonly app: Application) {}

  static async create(parent: HTMLElement): Promise<PixiHost> {
    const app = new Application();
    const v = viewport.get();
    await app.init({
      width: v.cssW,
      height: v.cssH,
      resolution: v.dpr,
      autoDensity: true,
      antialias: false,
      roundPixels: true,
      background: '#2a160c',
      preference: 'webgl',
    });
    app.canvas.setAttribute('aria-hidden', 'true');
    parent.prepend(app.canvas);
    const host = new PixiHost(app);
    app.stage.addChild(host.world);
    host.layout(v);
    viewport.subscribe(() => host.layout(viewport.get()));
    app.ticker.add((t) => {
      if (!host.scene) return;
      // Hitstop freezes the world: scenes get no time while it lasts.
      host.scene.update(juice.frozen() ? 0 : Math.min(t.deltaMS, 100));
      const o = juice.offset();
      const z = viewport.get().zoom;
      host.world.position.set(Math.round(o.x * z), Math.round(o.y * z));
    });
    return host;
  }

  private layout(v: Viewport): void {
    this.app.renderer.resolution = v.dpr;
    this.app.renderer.resize(v.cssW, v.cssH);
    this.world.scale.set(v.zoom);
    this.scene?.resize?.(v.worldW, v.worldH);
  }

  /** Swaps scenes; keep leaves the old one alive (the farm keeps running behind the market board). */
  setScene(scene: Scene | null, opts: { keep?: boolean } = {}): void {
    if (this.scene && this.scene !== scene) {
      this.world.removeChild(this.scene.root);
      if (!opts.keep) this.scene.destroy();
    }
    this.scene = scene;
    if (scene) {
      this.world.addChild(scene.root);
      const v = viewport.get();
      scene.resize?.(v.worldW, v.worldH);
    }
  }
}
