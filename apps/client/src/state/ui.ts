// What the farm screen shows over the world: one modal at a time. The tour reads this to know where
// the player is, and listens to uiEvents for the things it asks the player to do.
import type { FeatherGrade, MilestoneId, UnlockId } from '@coys/shared';
import { Emitter, createStore } from './store';

export type ShopTab = 'hens' | 'feed' | 'coops' | 'machines';
export type MarketTab = 'board' | 'farms' | 'orders' | 'trades';

export type ModalState =
  | { kind: 'shop'; tab: ShopTab }
  | { kind: 'ledger' }
  | { kind: 'hen'; henId: string }
  | { kind: 'sell' }
  | { kind: 'machine'; unlock: UnlockId }
  | { kind: 'market'; tab: MarketTab }
  | { kind: 'card'; cardId: string }
  | { kind: 'reveal'; ticketId: string; number: number; grade: FeatherGrade; milestone: MilestoneId; txHash: string; day: number }
  | { kind: 'feathers' }
  | { kind: 'settings' }
  | { kind: 'guide' };

export const ui = createStore<{ modal: ModalState | null }>({ modal: null });

/** Things the player did in the UI that the tour waits for (opened a modal, switched a tab, tapped an explainer). */
export type UiEvent = { kind: 'opened'; modal: ModalState } | { kind: 'tab'; modal: 'shop' | 'market'; tab: string } | { kind: 'tapped'; what: string };
export const uiEvents = new Emitter<UiEvent>();

export function openModal(modal: ModalState): void {
  ui.set({ modal });
  uiEvents.emit({ kind: 'opened', modal });
}

export function closeModal(): void {
  ui.set({ modal: null });
}
