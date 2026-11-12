// Which painted atlas a screen loads: one level per sprite for the screen's density.
import { describe, expect, it } from 'vitest';
import { paintedLevel } from '../src/assets/store';

describe('painted levels', () => {
  it('takes the sharpest level that divides the density, or the smallest for the quick first look', () => {
    expect(paintedLevel([2, 3, 4, 6, 8], 6)).toBe(6);
    expect(paintedLevel([2, 3, 4, 6, 8], 6, true)).toBe(2);
    expect(paintedLevel([2, 4, 8], 3)).toBe(2);
  });

  it('still loads something on a density-1 screen (a small phone), so no sprite is ever missing', () => {
    expect(paintedLevel([2, 3, 4, 6, 8], 1)).toBe(2);
    expect(paintedLevel([3, 6], 1, true)).toBe(3);
    expect(paintedLevel([], 1)).toBeNull();
  });
});
