// A frame-by-frame sprite driven by anim.json timing. Several sheets can be stacked as layers
// (the hen: body, eyes, comb, accessory) and they advance on the same clock, frame for frame.
import { Container, Rectangle, Sprite } from 'pixi.js';
import type { AssetStore, Frame } from '../assets/store';

export class FrameSprite extends Container {
  private readonly layers: Sprite[] = [];
  private frames: Frame[][] = [];
  private i = 0;
  private t = 0;
  private looping = true;
  private onDone: (() => void) | null = null;
  private ended = false;
  private facing = 1;
  private size = 1;
  private sx = 1;
  private sy = 1;
  /** Multiplies the art's own size (1 for nearly everything; the market's rival signs use it). */
  private readonly extra: number;
  private seen = -1;
  /** When set, the hit box follows the art (in world pixels of margin), at whatever density is drawn. */
  private hitMargin: number | null = null;
  row = '';
  speed = 1;
  /** The row to settle on after a play-once row ends (see rest). */
  private base: string | null = null;

  constructor(
    private readonly assets: AssetStore,
    private sheets: string[],
    row: string,
    extra = 1,
  ) {
    super();
    this.extra = extra;
    this.play(row);
  }

  /** Replace the layer stack (same frames, different traits). */
  setSheets(sheets: string[]): void {
    this.sheets = sheets;
    const row = this.row;
    this.row = '';
    this.play(row, { loop: this.looping });
  }

  /**
   * The row this sprite shows when nothing else is happening, from game state. A play-once row
   * that is still running (a spill, a tip, a drop) finishes first and then settles here, so a
   * state update never cuts an animation off or flips the sprite back and forth.
   */
  rest(row: string): this {
    this.base = row;
    if (this.busy) return this;
    return this.play(row);
  }

  /** A play-once row is running. */
  get busy(): boolean {
    return !this.looping && !this.ended && this.row !== '';
  }

  play(row: string, opts: { loop?: boolean; onDone?: () => void; restart?: boolean } = {}): this {
    if (row === this.row && !opts.restart && !this.ended) {
      if (opts.onDone) this.onDone = opts.onDone;
      return this;
    }
    this.row = row;
    this.load();
    this.looping = opts.loop ?? this.assets.rowMode(this.sheets[0] ?? '', row) === 'loop';
    this.onDone = opts.onDone ?? null;
    this.ended = false;
    this.i = 0;
    this.t = 0;
    while (this.layers.length < this.frames.length) this.layers.push(this.addChild(new Sprite()));
    while (this.layers.length > this.frames.length) this.layers.pop()?.destroy();
    this.apply();
    return this;
  }

  /** Frames at the level the store draws now; a sharper atlas landing swaps them in place. */
  private load(): void {
    this.seen = this.assets.version;
    this.frames = this.sheets.map((id) => this.assets.frames(id, this.row));
    this.size = this.assets.texelScale(this.sheets[0] ?? '') * this.extra;
    this.applyScale();
    this.fitHit();
  }

  /** Makes the hit box the art's own box (this row's first frame, all layers), margin world pixels larger all round. */
  hitBox(margin: number): this {
    this.hitMargin = margin;
    this.fitHit();
    return this;
  }

  private fitHit(): void {
    if (this.hitMargin === null) return;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const frames of this.frames) {
      const t = frames[0]?.texture;
      if (!t) continue;
      const w = t.frame.width;
      const h = t.frame.height;
      const ax = (t.defaultAnchor?.x ?? 0.5) * w;
      const ay = (t.defaultAnchor?.y ?? 1) * h;
      x0 = Math.min(x0, -ax);
      y0 = Math.min(y0, -ay);
      x1 = Math.max(x1, w - ax);
      y1 = Math.max(y1, h - ay);
    }
    if (x0 === Infinity) return;
    const m = this.hitMargin / Math.max(1e-6, this.size);
    this.hitArea = new Rectangle(x0 - m, y0 - m, x1 - x0 + 2 * m, y1 - y0 + 2 * m);
  }

  private applyScale(): void {
    if (this.destroyed) return;
    this.scale.set(this.size * this.sx * this.facing, this.size * this.sy);
  }

  /** Shows one frame of a row and holds it (a coop at rest: the door shut, nothing moving). */
  still(row: string, frame = 0): this {
    this.base = null;
    this.play(row, { loop: false, restart: true });
    this.i = Math.min(frame, Math.max(0, (this.frames[0]?.length ?? 1) - 1));
    this.ended = true;
    this.apply();
    return this;
  }

  /** Random start frame, so a flock does not move in lockstep. */
  desync(): this {
    const n = this.frames[0]?.length ?? 1;
    this.i = Math.floor(Math.random() * n);
    this.apply();
    return this;
  }

  face(dir: 1 | -1): void {
    if (this.destroyed) return;
    this.facing = dir;
    this.applyScale();
  }

  get dir(): number {
    return this.facing;
  }

  /** Scale on top of the art's own size (squash and stretch). */
  squash(sx: number, sy: number): void {
    // tweens can outlive the sprite (an egg collected mid-bounce)
    if (this.destroyed) return;
    this.sx = sx;
    this.sy = sy;
    this.applyScale();
  }

  get finished(): boolean {
    return this.ended;
  }

  get frameIndex(): number {
    return this.i;
  }

  update(dtMs: number): void {
    if (this.seen !== this.assets.version && this.row) {
      this.load();
      this.apply();
    }
    const base = this.frames[0];
    if (!base || this.ended || base.length <= 1) return;
    this.t += dtMs * this.speed;
    let changed = false;
    while (this.t >= (base[this.i]?.ms ?? 100)) {
      this.t -= base[this.i]?.ms ?? 100;
      if (this.i + 1 >= base.length) {
        if (!this.looping) {
          this.ended = true;
          const done = this.onDone;
          this.onDone = null;
          if (done) done();
          else if (this.base && this.base !== this.row) this.play(this.base);
          break;
        }
        this.i = 0;
      } else this.i++;
      changed = true;
    }
    if (changed) this.apply();
  }

  private apply(): void {
    this.frames.forEach((frames, layer) => {
      const f = frames[Math.min(this.i, frames.length - 1)];
      const s = this.layers[layer];
      if (!f || !s) return;
      s.texture = f.texture;
      s.anchor.set(f.texture.defaultAnchor?.x ?? 0.5, f.texture.defaultAnchor?.y ?? 1);
    });
  }
}
