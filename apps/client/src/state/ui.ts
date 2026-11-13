// What the farm screen shows over the world: one modal at a time. The tour reads this to know where
// the player is, and listens to uiEvents for the things it asks the player to do.
import type { FeatherGrade, MilestoneId, UnlockId } from '@coys/shared';
import { Emitter, createStore } from './store';

export type ShopTab = 'hens' | 'feed' | 'coops' | 'machines';
/** The Market page's tabs: prices, sell, buy orders, your orders, trade, hen auction, farms. */
export type MarketTab = 'prices' | 'sell' | 'buyers' | 'mine' | 'trade' | 'auction' | 'farms';
export const PROFILE_TABS = ['overview', 'eggs', 'money', 'flock', 'machines', 'market', 'mint', 'badges'] as const;
export type ProfileTab = (typeof PROFILE_TABS)[number];

export type ModalState =
  | { kind: 'shop'; tab: ShopTab }
  | { kind: 'ledger' }
  | { kind: 'hen'; henId: string }
  | { kind: 'sell' }
  | { kind: 'machine'; unlock: UnlockId }
  | { kind: 'market'; tab: MarketTab }
  | { kind: 'card'; cardId: string }
  | { kind: 'reveal'; ticketId: string; number: number; grade: FeatherGrade; milestone: MilestoneId; txHash: string | null; day: number }
  | { kind: 'feathers' }
  | { kind: 'minting'; ticketId: string; attempt: number }
  | { kind: 'settings' }
  | { kind: 'guide' }
  | { kind: 'name'; mode: 'first' | 'rename' }
  /** The player's own profile page (private), on a tab. */
  | { kind: 'profile'; tab: ProfileTab }
  /** A farm's public profile, opened from the farms ranking or the profile's own link. */
  | { kind: 'publicProfile'; farmId: string; back: ProfileTab | null };

export const ui = createStore<{ modal: ModalState | null }>({ modal: null });

/** Set (session storage) when the player signs in from the open Feather Mint: the farm opens with the mint. */
export const OPEN_MINT_KEY = 'coys.openMint';

/** Things the player did in the UI that the tour waits for (opened a modal, switched a tab, tapped an explainer). */
export type UiEvent = { kind: 'opened'; modal: ModalState } | { kind: 'tab'; modal: 'shop' | 'market' | 'profile'; tab: string } | { kind: 'tapped'; what: string };
export const uiEvents = new Emitter<UiEvent>();

export function openModal(modal: ModalState): void {
  ui.set({ modal });
  uiEvents.emit({ kind: 'opened', modal });
}

export function closeModal(): void {
  ui.set({ modal: null });
}
