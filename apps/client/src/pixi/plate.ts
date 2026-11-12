// A 640x360 painted plate at the world origin: the window around it (the visible world beyond the
// plate) is filled with each edge's own colour, so wide and tall windows show no black bars.
import { Container, Graphics, Sprite } from 'pixi.js';
import type { AssetStore } from '../assets/store';

export const PLATE_W = 640;
export const PLATE_H = 360;

export class Plate {
  /** Holds the plate and everything drawn on it, in plate coordinates. */
  readonly content = new Container();
  private readonly fill = new Graphics();
  private readonly colours: { left: number; right: number; top: number; bottom: number };

  constructor(
    assets: AssetStore,
    id: string,
    readonly root: Container,
  ) {
    this.colours = assets.edgeColours(id);
    const frame = assets.frames(id, 'plate')[0];
    if (frame) {
      const bg = new Sprite(frame.texture);
      bg.anchor.set(0);
      bg.scale.set(assets.texelScale(id));
      this.content.addChild(bg);
    }
    root.addChild(this.fill, this.content);
  }

  /** Paints the visible world around the plate. */
  resize(view: { x: number; y: number; w: number; h: number }): void {
    const c = this.colours;
    const x1 = view.x + view.w;
    const y1 = view.y + view.h;
    this.fill.clear();
    if (view.y < 0) this.fill.rect(view.x, view.y, view.w, -view.y).fill(c.top);
    if (y1 > PLATE_H) this.fill.rect(view.x, PLATE_H, view.w, y1 - PLATE_H).fill(c.bottom);
    if (view.x < 0) this.fill.rect(view.x, 0, -view.x, PLATE_H).fill(c.left);
    if (x1 > PLATE_W) this.fill.rect(PLATE_W, 0, x1 - PLATE_W, PLATE_H).fill(c.right);
  }
}
