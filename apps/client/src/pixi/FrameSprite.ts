// A frame-by-frame sprite driven by anim.json timing. Several sheets can be stacked as layers
// (the hen: body, eyes, comb, accessory) and they advance on the same clock, frame for frame.
import { Container, Sprite } from 'pixi.js';
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
  row = '';
  speed = 1;

  constructor(
    private readonly assets: AssetStore,
    private sheets: string[],
    row: string,
    scale?: number,
  ) {
    super();
    this.size = scale ?? assets.scale(sheets[0] ?? '');
    this.scale.set(this.size);
    this.play(row);
  }

  /** Replace the layer stack (same frames, different traits). */
  setSheets(sheets: string[]): void {
    this.sheets = sheets;
    const row = this.row;
    this.row = '';
    this.play(row, { loop: this.looping });
  }

  play(row: string, opts: { loop?: boolean; onDone?: () => void; restart?: boolean } = {}): this {
    if (row === this.row && !opts.restart && !this.ended) {
      if (opts.onDone) this.onDone = opts.onDone;
      return this;
    }
    this.row = row;
    this.frames = this.sheets.map((id) => this.assets.frames(id, row));
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

  /** Random start frame, so a flock does not move in lockstep. */
  desync(): this {
    const n = this.frames[0]?.length ?? 1;
    this.i = Math.floor(Math.random() * n);
    this.apply();
    return this;
  }

  face(dir: 1 | -1): void {
    this.facing = dir;
    this.scale.x = this.size * dir;
  }

  get dir(): number {
    return this.facing;
  }

  /** Scale on top of the art divisor (squash and stretch). */
  squash(sx: number, sy: number): void {
    this.scale.set(this.size * sx * this.facing, this.size * sy);
  }

  get finished(): boolean {
    return this.ended;
  }

  get frameIndex(): number {
    return this.i;
  }

  update(dtMs: number): void {
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
          done?.();
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
