// A 640x360 painted plate at the world origin. The window around it (the visible world beyond the
// plate) continues the plate's own edges, mirrored outwards, so wide and tall windows show no bars.
import { Container, Rectangle, Sprite, Texture } from 'pixi.js';
import type { AssetStore } from '../assets/store';

export const PLATE_W = 640;
export const PLATE_H = 360;

export class Plate {
  /** Holds the plate and everything drawn on it, in plate coordinates. */
  readonly content = new Container();
  private readonly fill = new Container();
  private texture: Texture | null = null;
  private scale = 1;

  constructor(
    assets: AssetStore,
    id: string,
    readonly root: Container,
  ) {
    const frame = assets.frames(id, 'plate')[0];
    if (frame) {
      this.scale = assets.texelScale(id);
      this.texture = frame.texture;
      const bg = new Sprite(frame.texture);
      bg.anchor.set(0);
      bg.scale.set(this.scale);
      this.content.addChild(bg);
    }
    root.addChild(this.fill, this.content);
  }

  /**
   * Fills the visible world beyond the plate with the plate's own edges mirrored outwards, so the
   * landscape carries on (sky above, grass below, trees and hills at the sides) instead of bars.
   */
  resize(view: { x: number; y: number; w: number; h: number }): void {
    for (const c of this.fill.removeChildren()) c.destroy();
    const t = this.texture;
    if (!t) return;
    const f = t.frame;
    const k = 1 / this.scale;
    const left = Math.min(PLATE_W, Math.max(0, Math.ceil(-view.x)));
    const right = Math.min(PLATE_W, Math.max(0, Math.ceil(view.x + view.w - PLATE_W)));
    const top = Math.min(PLATE_H, Math.max(0, Math.ceil(-view.y)));
    const bottom = Math.min(PLATE_H, Math.max(0, Math.ceil(view.y + view.h - PLATE_H)));
    // a strip of the plate (plate pixels), mirrored about the plate's edge
    const strip = (x: number, y: number, w: number, h: number, flipX: boolean, flipY: boolean, at: { x: number; y: number }) => {
      if (w <= 0 || h <= 0) return;
      const tex = new Texture({ source: t.source, frame: new Rectangle(f.x + x * k, f.y + y * k, w * k, h * k) });
      const sp = new Sprite(tex);
      sp.scale.set(this.scale * (flipX ? -1 : 1), this.scale * (flipY ? -1 : 1));
      sp.position.set(at.x, at.y);
      this.fill.addChild(sp);
    };
    strip(0, 0, left, PLATE_H, true, false, { x: 0, y: 0 });
    strip(PLATE_W - right, 0, right, PLATE_H, true, false, { x: PLATE_W + right, y: 0 });
    strip(0, 0, PLATE_W, top, false, true, { x: 0, y: 0 });
    strip(0, PLATE_H - bottom, PLATE_W, bottom, false, true, { x: 0, y: PLATE_H + bottom });
    strip(0, 0, left, top, true, true, { x: 0, y: 0 });
    strip(PLATE_W - right, 0, right, top, true, true, { x: PLATE_W + right, y: 0 });
    strip(0, PLATE_H - bottom, left, bottom, true, true, { x: 0, y: PLATE_H + bottom });
    strip(PLATE_W - right, PLATE_H - bottom, right, bottom, true, true, { x: PLATE_W + right, y: PLATE_H + bottom });
  }
}
