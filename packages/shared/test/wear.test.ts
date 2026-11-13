// Machine wear: effect by condition, repair prices, and the payback the config is tuned to: each
// machine earns its price on the reference farm before its first repair is due, and owning a
// machine without ever repairing it earns less than keeping it repaired.
import { describe, expect, it } from 'vitest';
import { ECONOMY, UNLOCK_IDS, breakageRate, eggPrice, feedBagPrice, machineEffect, machineNet, machinePayback, repairCost, saleValue } from '../src/economy';

describe('machine wear', () => {
  it('full effect at 50% and over, then in line with the condition; nothing when broken', () => {
    expect(machineEffect(1, false)).toBe(1);
    expect(machineEffect(0.5, false)).toBe(1);
    expect(machineEffect(0.25, false)).toBeCloseTo(0.5);
    expect(machineEffect(0, false)).toBe(0);
    expect(machineEffect(0.9, true)).toBe(0);
  });

  it('the price formulas scale each machine by its effect', () => {
    const half = { power: { conveyor: 0.5, grader: 0.5, hopper: 0.5, clerk: 0.5 } };
    expect(breakageRate(half)).toBeCloseTo(0.035);
    expect(eggPrice('white', 1, half)).toBeCloseTo(1.05);
    expect(feedBagPrice('standard', half)).toBeCloseTo(95);
    expect(saleValue({ white: 1 }, 1, half)).toBeCloseTo(1.05 * 1.025);
    // a plain list still means full strength
    expect(eggPrice('white', 1, ['grader'])).toBeCloseTo(1.1);
  });

  it('a repair costs 40% of the price at 0%, in proportion to what is missing', () => {
    expect(repairCost('grader', 0)).toBeCloseTo(ECONOMY.unlocks.grader.price * 0.4);
    expect(repairCost('grader', 0.5)).toBeCloseTo(ECONOMY.unlocks.grader.price * 0.2);
    expect(repairCost('grader', 1)).toBe(0);
  });

  it('each machine pays for itself before its first repair, and never repairing loses to repairing', () => {
    for (const u of UNLOCK_IDS) {
      const p = machinePayback(u);
      expect(p.paysBeforeRepair, `${u}: earns ${p.earnedBeforeRepair.toFixed(1)} of ${ECONOMY.unlocks[u].price} before its repair`).toBe(true);
      expect(machineNet(u, 150, false), u).toBeLessThan(machineNet(u, 150, true));
    }
    // all five, never repaired, earn little over 150 days next to keeping them repaired
    const all = (repair: boolean) => UNLOCK_IDS.reduce((s, u) => s + machineNet(u, 150, repair), 0);
    expect(all(false)).toBeLessThan(all(true) * 0.5);
  });
});
