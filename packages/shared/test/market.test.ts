import { describe, expect, it } from 'vitest';
import { ECONOMY, eggPrice } from '../src/economy';
import { bakeryPrice, creditDue, desperation, limitPriceOk, loyalistBagPrice, squeezerBagPrice, traderPrice, wholesalePrice } from '../src/market';

describe('agent pricing', () => {
  it('desperation rises as feed and cash run out', () => {
    expect(desperation(10, 500)).toBe(0);
    expect(desperation(0, 0)).toBe(1);
    expect(desperation(1, 20)).toBeGreaterThan(desperation(4, 20));
  });

  it('the Squeezer charges a hungry farm more; the Loyalist charges regulars less, down to its floor', () => {
    const list = ECONOMY.feed.tiers.standard.bagPrice;
    expect(squeezerBagPrice('standard', 0)).toBeCloseTo(list * ECONOMY.suppliers.squeezer.baseMarkup, 10);
    expect(squeezerBagPrice('standard', 1)).toBeCloseTo(list * (ECONOMY.suppliers.squeezer.baseMarkup + ECONOMY.suppliers.squeezer.desperationMarkup), 10);
    expect(loyalistBagPrice('standard', 0)).toBe(list);
    expect(loyalistBagPrice('standard', 3)).toBeCloseTo(list * 0.94, 10);
    expect(loyalistBagPrice('standard', 100)).toBeCloseTo(list * (1 - ECONOMY.suppliers.loyalist.maxDiscount), 10);
    expect(creditDue(100)).toBeCloseTo(108, 10);
  });

  it('buyers price around the live market, within what they can resell for', () => {
    expect(bakeryPrice(1)).toBeCloseTo(1.15, 10);
    expect(traderPrice('brown', 1)).toBeCloseTo(1.875, 10);
    expect(traderPrice('golden', 2.5)).toBeCloseTo(ECONOMY.buyers.trader.resale.golden * 0.92, 10);
    expect(wholesalePrice('white', 1)).toBeCloseTo(0.72, 10);
  });

  it('limit prices must sit in a band around the live price', () => {
    const live = eggPrice('cream', 1.5, []);
    expect(limitPriceOk('cream', live, 1.5)).toBe(true);
    expect(limitPriceOk('cream', live * 0.1, 1.5)).toBe(false);
    expect(limitPriceOk('cream', live * 6, 1.5)).toBe(false);
  });
});
