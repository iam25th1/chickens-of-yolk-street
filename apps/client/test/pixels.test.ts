import { describe, expect, it } from 'vitest';
import { alphaCut, isFeather, ownerRows, recolourBody } from '../src/assets/pixels';

const px = (...rgba: number[][]) => Uint8ClampedArray.from(rgba.flat());

describe('alpha cut', () => {
  it('makes soft halo pixels clear and the rest solid', () => {
    const d = px([10, 10, 10, 20], [10, 10, 10, 127], [10, 10, 10, 128], [10, 10, 10, 255]);
    alphaCut(d);
    expect([d[3], d[7], d[11], d[15]]).toEqual([0, 0, 255, 255]);
  });
});

describe('body palette swap', () => {
  it('recolours cream feathers but keeps outline, eye white, beak and comb', () => {
    expect(isFeather(250, 226, 196)).toBe(true); // cream feather
    expect(isFeather(214, 178, 150)).toBe(true); // shaded feather
    expect(isFeather(42, 22, 12)).toBe(false); // outline
    expect(isFeather(250, 248, 244)).toBe(false); // eye white
    expect(isFeather(240, 160, 30)).toBe(false); // beak
    expect(isFeather(200, 40, 30)).toBe(false); // comb
  });

  it('maps feathers by brightness onto the ramp', () => {
    const d = px([250, 226, 196, 255], [214, 178, 150, 255], [240, 160, 30, 255], [250, 226, 196, 0]);
    const changed = recolourBody(d, [
      [92, 48, 26],
      [196, 128, 74],
    ]);
    expect(changed).toBe(2);
    expect([d[0], d[1], d[2]]).toEqual([196, 128, 74]); // brightest feather: light end
    expect([d[4], d[5], d[6]]).toEqual([92, 48, 26]); // darkest feather: dark end
    expect([d[8], d[9], d[10]]).toEqual([240, 160, 30]); // beak untouched
    expect([d[12], d[13], d[14]]).toEqual([250, 226, 196]); // clear pixel untouched
  });
});

describe('hen row ownership', () => {
  it('gives each blob to the row its lowest pixel sits in', () => {
    // 4x8 sheet, rows of 4 px. A blob in rows 0-1 straddling the line belongs to row 1 (its feet);
    // a blob only in row 0 belongs to row 0.
    const w = 4;
    const h = 8;
    const mask = new Uint8ClampedArray(w * h * 4);
    const set = (x: number, y: number) => (mask[(y * w + x) * 4 + 3] = 255);
    set(0, 0);
    set(0, 1); // blob A: rows y0-y1, row 0
    set(3, 2);
    set(3, 3);
    set(3, 4);
    set(3, 5); // blob B: y2-y5, lowest pixel in row 1
    const owner = ownerRows([mask], w, h, 4);
    expect(owner[0]).toBe(0);
    expect(owner[1 * w]).toBe(0);
    expect(owner[2 * w + 3]).toBe(1);
    expect(owner[5 * w + 3]).toBe(1);
    expect(owner[7 * w]).toBe(-1);
  });
});
