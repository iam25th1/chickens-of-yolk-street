// The world's fixed draw order, bottom to top: ground (baked tiles, pads, path, fence), ground
// animation (grass in the wind, straw), floor (the conveyor belt and what rides it), depth (every
// object, hen, egg and standing machine, sorted by where its feet touch the ground), labels (machine
// name plates), fx (particles). Nothing on the ground layers can ever draw above an object or hen.
import { Container } from 'pixi.js';

export const LAYERS = ['ground', 'groundAnim', 'floor', 'depth', 'labels', 'fx'] as const;
export type Layer = (typeof LAYERS)[number];

/** Depth key from the foot position: lower on screen draws later; ties break left to right. */
export const depthOf = (footY: number, x = 0): number => Math.round(footY * 16) + Math.max(0, Math.min(15, Math.floor((x + 1024) / 128)));

export class WorldLayers {
  readonly root = new Container();
  readonly by: Record<Layer, Container>;

  constructor() {
    this.by = Object.fromEntries(LAYERS.map((l) => [l, new Container()])) as Record<Layer, Container>;
    this.by.depth.sortableChildren = true;
    for (const l of LAYERS) this.root.addChild(this.by[l]);
  }

  /** Adds a display object to a layer; in the depth layer it sorts by its foot position. */
  add<T extends Container>(layer: Layer, obj: T, foot?: { x: number; y: number }): T {
    this.by[layer].addChild(obj);
    if (layer === 'depth') obj.zIndex = depthOf(foot?.y ?? obj.y, foot?.x ?? obj.x);
    return obj;
  }

  /** Re-sorts a depth object after it moved (a walking hen, a rolling egg). */
  static resort(obj: Container): void {
    obj.zIndex = depthOf(obj.y, obj.x);
  }

  /** Every display object in final draw order with its layer (for checks). */
  drawOrder(): { layer: Layer; obj: Container }[] {
    const out: { layer: Layer; obj: Container }[] = [];
    for (const l of LAYERS) {
      const kids = [...this.by[l].children] as Container[];
      if (l === 'depth') kids.sort((a, b) => a.zIndex - b.zIndex);
      for (const k of kids) out.push({ layer: l, obj: k });
    }
    return out;
  }
}
