// Renders a hen's portrait once, at mint: the packed trait layers (body, eyes, comb, accessory)
// stacked on the first idle frame, the body palette-swapped like the client does, cut to hard
// alpha and sampled nearest-neighbour to 32x32. The PNG travels in the NFT metadata as a data URI
// with its SHA-256, so the token shows its hen without any image host.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { alphaCut, recolourBody, type HenView } from '@coys/shared';
import { decodePng, encodePng, type Rgba } from './png';

const CELL = 256;
const SIZE = 32;

export interface HenImage {
  dataUri: string;
  sha256Base64: string;
  bytes: number;
}

export class HenRenderer {
  private readonly sheets = new Map<string, Rgba>();
  private readonly cache = new Map<string, HenImage>();
  private readonly ramps: Record<string, [[number, number, number], [number, number, number]]>;

  constructor(private readonly assetsDir: string) {
    const index = JSON.parse(readFileSync(join(assetsDir, 'index.json'), 'utf8')) as {
      traits: { bodyRecolour: Record<string, [[number, number, number], [number, number, number]]> };
    };
    this.ramps = index.traits.bodyRecolour;
  }

  private sheet(id: string): Rgba {
    const hit = this.sheets.get(id);
    if (hit) return hit;
    const img = decodePng(readFileSync(join(this.assetsDir, 'sprites', `${id}.png`)));
    // keep only the first idle cell; that is all a portrait needs
    const cell = new Uint8Array(CELL * CELL * 4);
    for (let y = 0; y < CELL; y++) cell.set(img.data.subarray(y * img.width * 4, y * img.width * 4 + CELL * 4), y * CELL * 4);
    alphaCut(cell);
    const out = { width: CELL, height: CELL, data: cell };
    this.sheets.set(id, out);
    return out;
  }

  render(hen: Pick<HenView, 'body' | 'eyes' | 'comb' | 'accessory'>): HenImage {
    const key = `${hen.body}/${hen.eyes}/${hen.comb}/${hen.accessory}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const body = this.sheet('02-body');
    const stack: Uint8Array[] = [];
    if (hen.body === 'cream') stack.push(body.data);
    else {
      const swapped = Uint8Array.from(body.data);
      const ramp = this.ramps[hen.body];
      if (ramp) recolourBody(swapped, ramp);
      stack.push(swapped);
    }
    if (hen.eyes !== 'default') stack.push(this.sheet(`02-eyes-${hen.eyes}`).data);
    stack.push(this.sheet(`02-comb-${hen.comb}`).data);
    if (hen.accessory !== 'none') stack.push(this.sheet(`02-acc-${hen.accessory}`).data);

    const out = new Uint8Array(SIZE * SIZE * 4);
    const step = CELL / SIZE;
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const s = (Math.floor((y + 0.5) * step) * CELL + Math.floor((x + 0.5) * step)) * 4;
        const o = (y * SIZE + x) * 4;
        for (const layer of stack) {
          if ((layer[s + 3] ?? 0) === 0) continue;
          out[o] = layer[s] ?? 0;
          out[o + 1] = layer[s + 1] ?? 0;
          out[o + 2] = layer[s + 2] ?? 0;
          out[o + 3] = 255;
        }
      }
    }
    const png = encodePng({ width: SIZE, height: SIZE, data: out });
    const image = {
      dataUri: `data:image/png;base64,${png.toString('base64')}`,
      sha256Base64: createHash('sha256').update(png).digest('base64'),
      bytes: png.length,
    };
    this.cache.set(key, image);
    return image;
  }
}
