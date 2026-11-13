// Farm names: generated ones always pass the rules; the rules refuse what they should and let
// harmless farm words through.
import { describe, expect, it } from 'vitest';
import { FARM_NAME_MAX, checkFarmName, farmNameKey, isRude, suggestFarmName } from '../src/names';

describe('farm names', () => {
  it('suggestions are goofy farm names that pass every rule', () => {
    let s = 1;
    const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const n = suggestFarmName(rnd);
      expect(n.length).toBeLessThanOrEqual(FARM_NAME_MAX);
      expect(checkFarmName(n)).toEqual({ ok: true, name: n });
      seen.add(n);
    }
    expect(seen.size).toBeGreaterThan(200);
  });

  it('keeps names to 3 to 24 characters of letters, numbers, spaces and simple punctuation', () => {
    expect(checkFarmName('  Cluckingham   Acres ')).toEqual({ ok: true, name: 'Cluckingham Acres' });
    expect(checkFarmName("Ma & Pa's Coop, No. 2!")).toMatchObject({ ok: true });
    expect(checkFarmName('ab')).toMatchObject({ problem: 'length' });
    expect(checkFarmName('a'.repeat(25))).toMatchObject({ problem: 'length' });
    expect(checkFarmName('farmer@example.com')).toMatchObject({ problem: 'characters' });
    expect(checkFarmName('Hen <b>')).toMatchObject({ problem: 'characters' });
    expect(checkFarmName('1234')).toMatchObject({ problem: 'letters' });
  });

  it('refuses rude words, disguised or not, and lets farm words through', () => {
    for (const bad of ['Fuck Farm', 'Sh1t Acres', 'Big Dick Ranch', 'Ass Patch', 'B1tch Coop']) expect(isRude(bad), bad).toBe(true);
    for (const fine of ['Cockerel Acres', 'Essex Farm', 'Swanky Roost', 'Spice Patch', 'Title Fields', 'Hatchling Nook', 'Peacock Yard']) expect(isRude(fine), fine).toBe(false);
  });

  it("refuses the player's own email name anywhere in the farm name", () => {
    expect(checkFarmName('Farmer Dan Acres', 'farmer.dan')).toMatchObject({ problem: 'email' });
    expect(checkFarmName('FARMERDAN', 'farmer_dan')).toMatchObject({ problem: 'email' });
    expect(checkFarmName('Dan Acres', 'farmer.dan')).toMatchObject({ ok: true });
  });

  it('compares names without case or extra spaces', () => {
    expect(farmNameKey(' Cluckingham  ACRES')).toBe(farmNameKey('cluckingham acres'));
  });
});
