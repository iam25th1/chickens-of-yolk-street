// The two headless players of the 30-day simulations: they play greedily (feed first, accept good
// cards, haggle sometimes, expand while it pays, sell everything). Shared by sim.test.ts and
// agent-compare.test.ts, so both replay the same players on the same seeds.
import { ECONOMY, type FarmState } from '@coys/shared';
import type { TestGame } from './helpers';

const eggs = (f: FarmState) => f.crate.white + f.crate.cream + f.crate.brown + f.crate.golden;

export async function playDay(t: TestGame, players: { playerId: string; farmId: string }[], day: number): Promise<void> {
  // cards arrive through the day; walk the clock across the day in steps
  for (const frac of [0.15, 0.35, 0.55, 0.75, 0.95]) {
    const start = t.game.getClock().dayStartedAt;
    t.clock.t = start + Math.floor(ECONOMY.day.lengthMs * frac);
    await t.game.tick();
    for (const p of players) {
      const farm = await t.game.getFarmState(p.farmId);
      for (const card of farm.cards.filter((c) => c.status === 'open')) {
        const haggle = card.choices.includes('counter') && (day + card.id.charCodeAt(0)) % 3 === 0;
        const choice = haggle ? 'counter' : card.choices.includes('accept') ? 'accept' : (card.choices[0] ?? 'decline');
        const ask = haggle ? (card.offerMilli / 1000) * (card.kind === 'feed-deal' || card.kind === 'credit-terms' ? 0.85 : 1.2) : undefined;
        await t.game.act(p.playerId, { t: 'respondCard', rid: `${card.id}-${frac}`, cardId: card.id, choice, ...(ask ? { ask } : {}) });
      }
      for (const c of farm.contracts.filter((c) => !c.deliveredToday)) {
        await t.game.act(p.playerId, { t: 'deliverContract', rid: `d-${c.id}-${day}-${frac}`, contractId: c.id });
      }
    }
  }
  for (const p of players) {
    let farm = await t.game.getFarmState(p.farmId);
    if (eggs(farm) > 0) await t.game.act(p.playerId, { t: 'sell', rid: `s-${p.farmId}-${day}`, items: farm.crate });
    farm = await t.game.getFarmState(p.farmId);
    // feed first: keep four days in the trough, standard feed when it can, cheap when short
    for (let i = 0; i < 4; i++) {
      const feed = farm.feedGrams.cheap + farm.feedGrams.standard + farm.feedGrams.premium;
      if (feed >= farm.hens.length * 120 * 4) break;
      const tier = farm.cashMilli >= 110_000 ? 'standard' : 'cheap';
      if (farm.cashMilli < ECONOMY.feed.tiers[tier].bagPrice * 1150) break;
      if (!(await t.game.act(p.playerId, { t: 'buyFeed', rid: `f-${p.farmId}-${day}-${i}`, tier, bags: 1 })).ok) break;
      farm = await t.game.getFarmState(p.farmId);
    }
    const room = farm.coops.reduce((s, c) => s + ECONOMY.coops.kinds[c.kind].capacity, 0) - farm.hens.length;
    // expand with what is left after a bag of feed for the bigger flock
    const afford = Math.floor((farm.cashMilli / 1000 - 25 - ECONOMY.feed.tiers.standard.bagPrice) / ECONOMY.hen.price);
    if (room > 0 && afford > 0) await t.game.act(p.playerId, { t: 'buyHens', rid: `h-${p.farmId}-${day}`, count: Math.min(room, afford, 20) });
    if (farm.cashMilli > 200_000 && farm.coops.length < ECONOMY.coops.plots) await t.game.act(p.playerId, { t: 'buildCoop', rid: `c-${p.farmId}-${day}`, kind: 'red' });
  }
  t.clock.t = t.game.getClock().dayStartedAt + ECONOMY.day.lengthMs;
  await t.game.endDay();
}

/** The open AI farms (rival agents) and open player farms after a day close. */
export async function aiFarmsOpen(t: TestGame): Promise<{ ai: number; players: number }> {
  const [r] = await t.db.query(
    `SELECT (SELECT count(*) FROM agents WHERE status = 'open' AND role = 'rival') AS ai, (SELECT count(*) FROM farms WHERE owner_kind = 'player' AND bust_day IS NULL) AS players`,
  );
  return { ai: Number(r?.ai), players: Number(r?.players) };
}
