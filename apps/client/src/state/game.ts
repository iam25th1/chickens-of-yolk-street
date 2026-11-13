// Client mirror of the server's state. The server is authoritative; this only displays it.
import type { ClockState, ErrorCode, FarmState, GameEvent, LedgerDay, MarketState, ProfileData } from '@coys/shared';
import { ECONOMY } from '@coys/shared';
import { Emitter, createStore } from './store';

export type ConnectionStatus = 'idle' | 'connecting' | 'online' | 'offline' | 'unauthenticated';

export interface GameView {
  status: ConnectionStatus;
  playerName: string;
  farm: FarmState | null;
  market: MarketState | null;
  clock: ClockState | null;
  /** Server clock minus local clock, in ms. */
  offset: number;
  ledger: LedgerDay[] | null;
  /** The player's own profile, once asked for (getProfile). */
  profile: ProfileData | null;
}

export const game = createStore<GameView>({ status: 'idle', playerName: '', farm: null, market: null, clock: null, offset: 0, ledger: null, profile: null });

export type ClientEvent =
  | GameEvent
  | { kind: 'newDay'; day: number }
  | { kind: 'crash'; on: boolean }
  | { kind: 'refused'; code: ErrorCode; message: string };

export const events = new Emitter<ClientEvent>();

export const serverNow = (): number => Date.now() + game.get().offset;

/** Milliseconds into the current in-game day. */
/**
 * True while the clock and a farm's lay plan are on the same day. Around midnight the new plan can
 * arrive a moment before the new clock: measured against the old day's time, every egg of the new
 * day would look laid already.
 */
export function sameDay(farm: { day: number }): boolean {
  return game.get().clock?.day === farm.day;
}

export function dayElapsed(): number {
  const c = game.get().clock;
  return c ? Math.max(0, serverNow() - c.dayStartedAt) : 0;
}

/** 0 at dawn, 1 at the next dawn (the server sets the day length; demo recordings shorten it). */
export const dayFraction = (): number => Math.min(1, dayElapsed() / (game.get().clock?.dayLengthMs ?? ECONOMY.day.lengthMs));

export const isNight = (): boolean => dayFraction() >= ECONOMY.day.nightStart;

/** In-game clock: dawn is 06:00 and a day runs 20 game hours. */
export function gameTime(): { h: number; m: number } {
  const minutes = Math.floor(dayFraction() * 20 * 60) + 6 * 60;
  return { h: Math.floor(minutes / 60) % 24, m: minutes % 60 };
}
