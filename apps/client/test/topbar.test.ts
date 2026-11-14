// The two-row top bar's rule (ui/Hud.tsx rowOneWidth): its first row holds the farm's numbers and
// BETA. At 360 UI pixels a new farm keeps the words COLLECT and SELL; longer numbers drop them; and
// without them even the longest numbers a farm reaches still fit. e2e/topbar.test.ts checks the same
// bar in a real browser.
import { describe, expect, it } from 'vitest';
import { TWO_ROW_WORDS, rowOneWidth, textWidth } from '../src/ui/Hud';

describe('the two-row top bar', () => {
  it('measures numbers in the bar font', () => {
    expect(textWidth('50.00')).toBe(27);
    expect(textWidth('10/12')).toBe(27);
    expect(textWidth('999.99')).toBe(33);
    expect(textWidth('1.2M')).toBe(21);
  });

  it('keeps the words for a new farm at 360 pixels, and drops them for longer numbers', () => {
    const fresh = rowOneWidth({ cashMilli: 50_000, ground: 0, hens: 10, crate: 0, hensText: '10/12', feed: '10.0D' });
    expect(fresh).toBeLessThanOrEqual(360);
    const seeded = rowOneWidth({ cashMilli: 101_920, ground: 0, hens: 10, crate: 54, hensText: '10/12', feed: '10.8D' });
    expect(seeded).toBeGreaterThan(360);
    expect(seeded - TWO_ROW_WORDS).toBeLessThanOrEqual(360);
  });

  it('fits the longest numbers without the words at 360 pixels', () => {
    for (const cashMilli of [999_990, 999_999_000, 12_345_678_000, -999_990]) {
      const w = rowOneWidth({ cashMilli, ground: 240, hens: 240, crate: 99_999, hensText: '240/240', feed: '999.9D' });
      expect(w - TWO_ROW_WORDS, `coins ${cashMilli / 1000}`).toBeLessThanOrEqual(360);
    }
  });

  it('counts coins from 100 up as wide as 999.99, which they pass through as they count', () => {
    expect(rowOneWidth({ cashMilli: 12_345_000, ground: 0, hens: 0, crate: 0, hensText: '', feed: '' })).toBe(
      rowOneWidth({ cashMilli: 999_990, ground: 0, hens: 0, crate: 0, hensText: '', feed: '' }),
    );
  });
});
