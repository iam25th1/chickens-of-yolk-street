// Haggling: up to three rounds. The agent accepts any ask on the right side of its walk-away price,
// otherwise it concedes part of the gap, or walks away when out of rounds or insulted.
import { ECONOMY } from '@coys/shared';
import type { Personality } from './cast';

export interface HaggleState {
  /** The agent's current price per unit. */
  offer: number;
  /** Its walk-away price, never shown. */
  reserve: number;
  /** Counters already made. */
  round: number;
  side: 'agent_buys' | 'agent_sells';
}

export type HaggleResult = { outcome: 'accept'; price: number } | { outcome: 'counter'; offer: number } | { outcome: 'walk'; insulted: boolean };

export function haggleStep(state: HaggleState, ask: number, personality: Personality): HaggleResult {
  const { offer, reserve, round, side } = state;
  const buys = side === 'agent_buys';
  if (buys ? ask <= reserve : ask >= reserve) return { outcome: 'accept', price: ask };

  const stretch = ECONOMY.haggle.maxAskStretch;
  const insulting = buys ? ask > offer * (1 + stretch) : ask < offer * (1 - stretch);
  if (insulting && personality.pride > 0.5) return { outcome: 'walk', insulted: true };
  if (round + 1 >= ECONOMY.haggle.maxRounds) return { outcome: 'walk', insulted: false };

  const next = offer + (reserve - offer) * personality.concession;
  // never concede past the player's own ask
  const bounded = buys ? Math.min(next, ask) : Math.max(next, ask);
  return { outcome: 'counter', offer: bounded };
}
