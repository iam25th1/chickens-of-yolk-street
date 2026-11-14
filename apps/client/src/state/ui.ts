// What the farm screen shows over the world: one modal at a time. The tour reads this to know where
// the player is, and listens to uiEvents for the things it asks the player to do.
import type { FeatherGrade, MilestoneId, UnlockId } from '@coys/shared';
import { Emitter, createStore } from './store';

export type ShopTab = 'hens' | 'feed' | 'coops' | 'machines' | 'land';
/** The Market page's tabs: prices, sell, buy orders, your orders, trade, hen auction, farms. */
export type MarketTab = 'prices' | 'sell' | 'buyers' | 'mine' | 'trade' | 'auction' | 'farms';
export const PROFILE_TABS = ['overview', 'eggs', 'money', 'flock', 'machines', 'market', 'mint', 'badges'] as const;
export type ProfileTab = (typeof PROFILE_TABS)[number];

/** Why a guest is offered to save the farm (sign in). */
export type SaveReason = 'ticket' | 'mint' | 'nudge' | 'settings' | 'profile';

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
  /** A guest farm: sign in to save it (and to mint). */
  | { kind: 'saveFarm'; reason: SaveReason }
  /** The player's own profile page (private), on a tab. */
  | { kind: 'profile'; tab: ProfileTab }
  /** A farm's public profile, opened from the farms ranking or the profile's own link. */
  /** back: the profile tab (or the Market's FARMS tab) it was opened from, reopened on close. */
  | { kind: 'publicProfile'; farmId: string; back: ProfileTab | 'market' | null };

export const ui = createStore<{ modal: ModalState | null }>({ modal: null });

/** Set (session storage) when the player signs in from the open Feather Mint: the farm opens with the mint. */
export const OPEN_MINT_KEY = 'coys.openMint';

/** Things the player did in the UI that the tour waits for (opened a modal, switched a tab, tapped an explainer). */
export type UiEvent = { kind: 'opened'; modal: ModalState } | { kind: 'tab'; modal: 'shop' | 'market' | 'profile'; tab: string } | { kind: 'tapped'; what: string };
export const uiEvents = new Emitter<UiEvent>();

/**
 * Going into or out of the Market changes the whole picture (the farm's canvas becomes the town
 * square): the farm screen registers how that change goes through the curtain (app/curtain.ts). While
 * such a change is on its way, every later modal change waits its turn behind it, and each change is
 * decided against the modal that is open when its turn comes (so nothing lands out of order).
 */
let pageSwap: ((apply: () => void) => Promise<void>) | null = null;
export function setPageSwap(fn: ((apply: () => void) => Promise<void>) | null): void {
  pageSwap = fn;
}
const isMarket = (m: ModalState | null) => m?.kind === 'market';
let queue: Promise<void> = Promise.resolve();
let waiting = 0;

function change(next: ModalState | null, after?: () => void): void {
  const run = (): Promise<void> | void => {
    const apply = () => {
      ui.set({ modal: next });
      after?.();
    };
    if (pageSwap && isMarket(next) !== isMarket(ui.get().modal)) return pageSwap(apply);
    apply();
  };
  if (!waiting && !(pageSwap && isMarket(next) !== isMarket(ui.get().modal))) {
    run();
    return;
  }
  waiting++;
  queue = queue
    .then(run)
    .catch(() => undefined)
    .finally(() => {
      waiting--;
    });
}

export function openModal(modal: ModalState): void {
  change(modal, () => uiEvents.emit({ kind: 'opened', modal }));
}

export function closeModal(): void {
  change(null);
}
