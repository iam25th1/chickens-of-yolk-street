import { describe, expect, it } from 'vitest';
import {
  ECONOMY,
  averageEggBasePrice,
  coopUpgradeCost,
  crowdingFactor,
  eggPrice,
  feedCostPerHenDay,
  gradeForRoll,
  henDailyMargin,
  henLayingRate,
  henPaybackDays,
  isCrash,
  marketMultiplier,
  saleValue,
  simulateReinvest,
  toMilli,
} from '../src/economy';

describe('economy sheet values', () => {
  it('one hen on standard feed at 1.00x earns a 0.46 margin per day', () => {
    expect(henDailyMargin({ tier: 'standard', multiplier: 1 })).toBeCloseTo(0.46, 2);
  });

  it('that hen pays back its price in 17.3 days', () => {
    expect(henPaybackDays({ tier: 'standard', multiplier: 1 })).toBeCloseTo(17.3, 1);
  });

  it('market multiplier at 1300 daily supply is 0.54', () => {
    expect(marketMultiplier(1300)).toBeCloseTo(0.54, 2);
  });

  it('a 10-hen farm reinvesting with a 20-coin reserve fills a 30-hen coop on day 16', () => {
    const run = simulateReinvest({
      hens: ECONOMY.start.hens,
      cash: ECONOMY.start.cash,
      reserve: 20,
      capacity: ECONOMY.coops.kinds.red.capacity,
      tier: 'standard',
      multiplier: 1,
    });
    expect(run.dayFilled).toBe(16);
  });
});

describe('formulas', () => {
  it('standard feed costs 0.48 per hen per day and averages 1.24 per egg', () => {
    expect(feedCostPerHenDay('standard', [])).toBeCloseTo(0.48, 10);
    expect(averageEggBasePrice('standard')).toBeCloseTo(1.24, 10);
  });

  it('market multiplier is 1 at the reference supply and clamps at both ends', () => {
    expect(marketMultiplier(600)).toBe(1);
    expect(marketMultiplier(0)).toBe(2.5);
    expect(marketMultiplier(1)).toBe(2.5);
    expect(marketMultiplier(100_000)).toBe(0.4);
    expect(isCrash(0.8)).toBe(true);
    expect(isCrash(0.81)).toBe(false);
  });

  it('crowding loses 15% per 10% over capacity, capped at 90%', () => {
    expect(crowdingFactor(12, 12)).toBe(1);
    expect(crowdingFactor(33, 30)).toBeCloseTo(0.85, 10);
    expect(crowdingFactor(36, 30)).toBeCloseTo(0.7, 10);
    expect(crowdingFactor(300, 30)).toBeCloseTo(0.1, 10);
  });

  it('hens past their prime lay half as much', () => {
    expect(henLayingRate({ feedMultiplier: 1, ageDays: 119 })).toBeCloseTo(0.8, 10);
    expect(henLayingRate({ feedMultiplier: 1, ageDays: 120 })).toBeCloseTo(0.4, 10);
  });

  it('unlocks apply their bonuses', () => {
    expect(eggPrice('brown', 1, ['grader'])).toBeCloseTo(1.65, 10);
    expect(saleValue({ white: 10 }, 1, ['clerk'])).toBeCloseTo(10.5, 10);
    expect(feedCostPerHenDay('standard', ['hopper'])).toBeCloseTo(0.432, 10);
    expect(coopUpgradeCost('starter', 'red')).toBe(150);
    expect(coopUpgradeCost('red', 'deluxe')).toBe(300);
  });

  it('grade rolls follow the tier mix', () => {
    expect(gradeForRoll('standard', 0)).toBe('white');
    expect(gradeForRoll('standard', 0.39)).toBe('white');
    expect(gradeForRoll('standard', 0.4)).toBe('cream');
    expect(gradeForRoll('standard', 0.75)).toBe('brown');
    expect(gradeForRoll('standard', 0.995)).toBe('golden');
    expect(gradeForRoll('cheap', 0.999)).toBe('brown');
  });

  it('milli conversion is exact for coin prices', () => {
    expect(toMilli(1.2 * 1.1)).toBe(1320);
    expect(toMilli(0.5)).toBe(500);
  });
});
