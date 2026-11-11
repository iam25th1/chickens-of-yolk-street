// A 640x360 painted plate that stays centred in a window of any shape: the window around it is
// filled with each edge's own colour, so wide and tall windows show no black bars.
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
      bg.scale.set(assets.scale(id));
      this.content.addChild(bg);
    }
    root.addChild(this.fill, this.content);
  }

  /** Centres the plate in a w x h world and paints the margins. Returns the plate's offset. */
  resize(w: number, h: number): { x: number; y: number } {
    const x = Math.round((w - PLATE_W) / 2);
    const y = Math.round((h - PLATE_H) / 2);
    this.content.position.set(x, y);
    const c = this.colours;
    this.fill.clear();
    if (y > 0) this.fill.rect(0, 0, w, y).fill(c.top).rect(0, y + PLATE_H, w, h - y - PLATE_H).fill(c.bottom);
    if (x > 0) this.fill.rect(0, Math.max(0, y), x, Math.min(h, PLATE_H)).fill(c.left).rect(x + PLATE_W, Math.max(0, y), w - x - PLATE_W, Math.min(h, PLATE_H)).fill(c.right);
    return { x, y };
  }
}
