// One PixiJS application for the whole game. The canvas fills the window at device resolution. A
// scene's world is drawn at k device pixels per world pixel (k whole, from app/viewport.ts) and
// placed on whole device pixels, so every texel lands on whole device pixels: the farm by its own
// view, the 640x360 plates (title, loading, town square) centred by theirs. Scenes are told the
// part of the world the window shows and lay themselves out to it.
import { Application, Container, TextureSource } from 'pixi.js';
import { viewport, type Viewport, type WorldView } from '../app/viewport';
import { juice } from '../motion/juice';

TextureSource.defaultOptions.scaleMode = 'nearest';

export interface Scene {
  readonly root: Container;
  /** Which view the scene's world uses: the farm's, or a centred 640x360 plate's. */
  readonly fit: 'farm' | 'plate';
  update(dtMs: number): void;
  /** The visible world, in world pixels (it may start left of or above the origin). */
  resize?(view: { x: number; y: number; w: number; h: number }, v: Viewport): void;
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
      host.place();
    });
    return host;
  }

  private view(v: Viewport): WorldView {
    return this.scene?.fit === 'farm' ? v.farm : v.plate;
  }

  /** The world's offset, plus any screen shake, on whole device pixels. */
  private place(): void {
    const v = viewport.get();
    const view = this.view(v);
    const o = juice.offset();
    this.world.position.set((view.offX + Math.round(o.x * view.k)) / v.dpr, (view.offY + Math.round(o.y * view.k)) / v.dpr);
  }

  private layout(v: Viewport): void {
    this.app.renderer.resolution = v.dpr;
    this.app.renderer.resize(v.cssW, v.cssH);
    const view = this.view(v);
    this.world.scale.set(view.k / v.dpr);
    this.place();
    this.scene?.resize?.({ x: -view.offX / view.k, y: -view.offY / view.k, w: v.devW / view.k, h: v.devH / view.k }, v);
  }

  /** Swaps scenes; keep leaves the old one alive (the farm keeps running behind the market board). */
  setScene(scene: Scene | null, opts: { keep?: boolean } = {}): void {
    if (this.scene && this.scene !== scene) {
      this.world.removeChild(this.scene.root);
      if (!opts.keep) this.scene.destroy();
    }
    this.scene = scene;
    if (scene) this.world.addChild(scene.root);
    this.layout(viewport.get());
  }
}
