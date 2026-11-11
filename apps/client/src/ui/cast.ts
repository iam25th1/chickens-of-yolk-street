// How each agent looks and sounds: portrait sheet, voice babble set, and which portrait rows play
// for a good outcome and a bad one.
import type { AgentKind, CardKind, CardView } from '@coys/shared';

export interface CastLook {
  portrait: string;
  voice: string;
  good: string;
  bad: string;
  /** Rival farms' signs (they tip over when the farm goes bust). */
  sign: string | null;
}

export const LOOK: Record<AgentKind, CastLook> = {
  upstart: { portrait: '04-upstart', voice: '40-upstart', good: 'gloat', bad: 'panic', sign: '17-sign-upstart' },
  'old-money': { portrait: '05-old-money', voice: '40-old-money', good: 'pleased', bad: 'annoyed', sign: '17-sign-old-money' },
  squeezer: { portrait: '06-squeezer', voice: '40-squeezer', good: 'deal', bad: 'refuse', sign: null },
  loyalist: { portrait: '07-loyalist', voice: '40-loyalist', good: 'deal', bad: 'disappointed', sign: null },
  bakery: { portrait: '08-bakery-buyer', voice: '40-bakery-buyer', good: 'happy', bad: 'angry', sign: null },
  trader: { portrait: '09-market-trader', voice: '40-market-trader', good: 'impressed', bad: 'walks-away', sign: null },
  wholesaler: { portrait: '10-wholesaler', voice: '40-wholesaler', good: 'deal', bad: 'lowball', sign: null },
};

export const CARD_ART: Record<CardKind, string> = {
  'bulk-order': '29-card-bulk-order',
  'premium-order': '29-card-premium-order',
  'standing-contract': '29-card-standing-contract',
  'feed-deal': '29-card-feed-deal',
  'credit-terms': '29-card-credit-terms',
  undercut: '29-card-undercut',
  'buyout-offer': '29-card-buyout-offer',
  'glut-warning': '29-card-glut-warning',
  'player-trade': '29-card-player-trade',
};

export const CARD_TITLE: Record<CardKind, string> = {
  'bulk-order': 'BULK ORDER',
  'premium-order': 'PREMIUM ORDER',
  'standing-contract': 'STANDING CONTRACT',
  'feed-deal': 'FEED DEAL',
  'credit-terms': 'CREDIT TERMS',
  undercut: 'UNDERCUT',
  'buyout-offer': 'BUYOUT OFFER',
  'glut-warning': 'GLUT WARNING',
  'player-trade': 'PLAYER TRADE',
};

/** Unit each card's price is per. */
export const CARD_UNIT: Record<CardKind, string> = {
  'bulk-order': 'EGG',
  'premium-order': 'EGG',
  'standing-contract': 'EGG',
  'feed-deal': 'BAG',
  'credit-terms': 'BAG',
  undercut: 'EGG',
  'buyout-offer': 'HEN',
  'glut-warning': '',
  'player-trade': 'EGG',
};

const GRADE_WORD: Record<string, string> = { white: 'WHITE EGGS', cream: 'CREAM EGGS', brown: 'BROWN EGGS', golden: 'GOLDEN EGGS', any: 'EGGS' };

/** One plain line: what saying yes to this card means for the player. */
export function acceptMeaning(card: CardView): string {
  const price = (card.offerMilli / 1000).toFixed(2);
  const eggs = GRADE_WORD[card.grade ?? 'any'] ?? 'EGGS';
  const total = ((card.offerMilli * card.qty) / 1000).toFixed(2);
  const feed = `${(card.tier ?? 'standard').toUpperCase()} FEED`;
  switch (card.kind) {
    case 'bulk-order':
    case 'premium-order':
      return `ACCEPT: SELL ${card.qty} ${eggs} FROM YOUR CRATE NOW AT ${price} EACH, ${total} COINS IN ALL.`;
    case 'standing-contract':
      return `ACCEPT: DELIVER ${card.qty} ${eggs} EVERY DAY FOR ${card.days ?? 0} DAYS AT ${price} EACH. A MISSED DAY COSTS A PENALTY.`;
    case 'feed-deal':
      return `ACCEPT: BUY ${card.qty} BAGS OF ${feed} AT ${price} A BAG.`;
    case 'credit-terms':
      return `ACCEPT: TAKE ${card.qty} BAGS OF ${feed} NOW AND PAY ${price} A BAG OVER ${card.days ?? 0} DAYS.`;
    case 'undercut':
      return `MATCH PRICE: SELL AT HIS LOWER PRICE NOW. HOLD: KEEP YOUR EGGS FOR A BETTER DAY.`;
    case 'buyout-offer':
      return `SELL HENS: HAND OVER ${card.qty} HENS FOR ${price} EACH, ${total} COINS IN ALL.`;
    case 'glut-warning':
      return `SELL NOW: EMPTY YOUR CRATE AT TODAY'S LOW PRICE. HOLD: WAIT FOR PRICES TO COME BACK.`;
    case 'player-trade':
      return `ACCEPT: TRADE ${card.qty} ${eggs} AT ${price} EACH WITH ANOTHER FARMER.`;
  }
}

export const CHOICE_LABEL: Record<string, string> = {
  accept: 'ACCEPT',
  decline: 'DECLINE',
  counter: 'COUNTER',
  switchSupplier: 'SWITCH SUPPLIER',
  matchPrice: 'MATCH PRICE',
  sellNow: 'SELL NOW',
  hold: 'HOLD',
  sellHens: 'SELL HENS',
};
