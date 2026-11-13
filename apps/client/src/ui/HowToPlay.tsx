// The How to play guide: short sections in plain words, each with a picture from the game's own
// art. Opens from Settings and from the ? in the top bar. One section at a time, with previous and
// next; a section longer than the window allows is split into pages (never a scrollbar).
import { Children, Fragment, isValidElement, useState, type ReactNode } from 'react';
import { ECONOMY, MARKET_CHART_DAYS, UNLOCK_IDS, type MilestoneId } from '@coys/shared';
import { uiSound, useServices } from '../app/services';
import { useViewport } from '../app/Stage';
import { Modal } from './Modal';
import { Paged } from './Paged';
import { MachineArt, UNLOCK_TEXT } from './Panels';
import { SheetSprite } from './SheetSprite';

export const MILESTONE_TEXT: Record<MilestoneId, string> = {
  'full-coop': 'FILL YOUR COOPS FOR THE FIRST TIME',
  'good-week': `STAY IN GOOD STANDING FOR ${ECONOMY.feathers.goodDays} DAYS`,
  'eggs-sold': `SELL ${ECONOMY.feathers.eggsSold} EGGS`,
  'haggles-won': `WIN ${ECONOMY.feathers.hagglesWon} HAGGLES`,
  'all-machines': 'OWN ALL FIVE MACHINES',
  'outlast-rival': 'OUTLAST A RIVAL FARM THAT GOES BUST',
  'top-three': `FINISH A DAY IN THE TOP ${ECONOMY.feathers.topRank} OF THE MARKET'S FARMS`,
};

const minutes = Math.round(ECONOMY.day.lengthMs / 60_000);
const pct = (v: number) => `${Math.round(v * 100)}%`;

interface Section {
  id: string;
  title: string;
  /** The section's name in the list, short enough to fit it. */
  short: string;
  picture: () => ReactNode;
  body: ReactNode;
}

function Hen() {
  const v = useViewport();
  return <SheetSprite id="02-body" layers={['02-body', '02-comb-default']} row="idle" play="loop" size={v.p * 2} box={{ w: 72, h: 72 }} />;
}

function Art({ id, row, zoom }: { id: string; row: string; zoom?: number }) {
  const v = useViewport();
  return <SheetSprite id={id} row={row} play="loop" size={v.p * (zoom ?? 1)} box={{ w: 72, h: 72 }} />;
}

const SECTIONS: Section[] = [
  {
    id: 'goal',
    title: 'GOAL OF THE GAME',
    short: 'GOAL OF THE GAME',
    picture: () => <Hen />,
    body: (
      <>
        <p>RUN THE BEST EGG FARM ON YOLK STREET. SOME FARMS ON YOLK STREET ARE OTHER PLAYERS, SOME ARE AI (MARKED AI). THE FEED SUPPLIERS AND THE EGG BUYERS ARE AI, EACH WITH ITS OWN COINS AND MEMORY.</p>
        <p>KEEP YOUR FARM OUT OF THE RED, GROW YOUR FLOCK, OUTLAST THE RIVALS, AND EARN FOUNDING HENS ALONG THE WAY.</p>
      </>
    ),
  },
  {
    id: 'day',
    title: 'YOUR DAY',
    short: 'YOUR DAY',
    picture: () => <SheetSprite id="32-icons" row="clock" zoom={4} />,
    body: (
      <>
        <p>A DAY LASTS ABOUT {minutes} MINUTES. HENS LAY THROUGH IT, OFFERS ARRIVE ON CARDS, AND YOU COLLECT, SELL AND DECIDE.</p>
        <p>AT MIDNIGHT THE DAY CLOSES: EGGS LEFT ON THE GROUND GO TO THE CRATE, THE MARKET SETTLES, AND THE LEDGER GETS THE DAY&apos;S RECEIPT. HENS EAT AT DAWN.</p>
      </>
    ),
  },
  {
    id: 'eggs',
    title: 'EGGS AND THE CRATE',
    short: 'EGGS AND THE CRATE',
    picture: () => <Art id="12-crate" row="full" zoom={2} />,
    body: (
      <>
        <p>TAP AN EGG TO PUT IT IN YOUR CRATE. THERE ARE FOUR GRADES: WHITE, CREAM, BROWN AND THE RARE GOLDEN, WORTH SIX WHITES.</p>
        <p>
          ABOUT {pct(ECONOMY.eggs.breakage)} OF EGGS CRACK. SELL FROM THE CRATE AT TODAY&apos;S PRICE, OR KEEP THEM FOR A BETTER DAY: EGGS DO NOT SPOIL.
        </p>
      </>
    ),
  },
  {
    id: 'market',
    title: 'THE SHARED MARKET',
    short: 'THE SHARED MARKET',
    picture: () => <SheetSprite id="32-icons" row="market" zoom={4} />,
    body: (
      <>
        <p>ONE PRICE FOR EVERYONE. TODAY&apos;S PRICE COMES FROM YESTERDAY&apos;S SUPPLY: HOW MANY EGGS THE WHOLE STREET SOLD AGAINST WHAT IT NEEDS.</p>
        <p>SELL TOO MANY AT ONCE AND PRICES CRASH (A GLUT). WHEN EGGS ARE SCARCE, PRICES RISE.</p>
        <p>
          THE MARKET (MARKET IN THE TOP BAR, OR TAP YOUR FARM SIGN) HAS IT ALL: PRICES WITH THE LAST {MARKET_CHART_DAYS} DAYS AND WHAT THE AI TRADERS SAY; SELL FROM YOUR CRATE OR POST YOUR OWN PRICE; THE AI
          BUYERS&apos; ORDERS TO FILL; YOUR ORDERS; OTHER FARMS&apos; OFFERS TO BUY; THE HEN AUCTION; AND THE FARMS RANKED.
        </p>
      </>
    ),
  },
  {
    id: 'feed',
    title: 'FEED AND LAYING',
    short: 'FEED AND LAYING',
    picture: () => <Art id="13-sack-standard" row="idle" zoom={2} />,
    body: (
      <>
        <p>
          NO FEED, NO EGGS. CHEAP FEED LAYS {pct(ECONOMY.feed.tiers.cheap.laying)}, STANDARD {pct(ECONOMY.feed.tiers.standard.laying)}, PREMIUM{' '}
          {pct(ECONOMY.feed.tiers.premium.laying)}, AND BETTER FEED GIVES BETTER GRADES.
        </p>
        <p>THE LOYALIST GIVES REGULARS A DISCOUNT AND CREDIT. THE SQUEEZER CHARGES MORE WHEN YOUR TROUGH LOOKS EMPTY.</p>
      </>
    ),
  },
  {
    id: 'offers',
    title: 'OFFERS, HAGGLING AND CONTRACTS',
    short: 'OFFERS AND HAGGLES',
    picture: () => <SheetSprite id="32-icons" row="cash" zoom={4} />,
    body: (
      <>
        <p>BUYERS AND SUPPLIERS SEND CARDS. ACCEPT, DECLINE, OR COUNTER WITH YOUR OWN PRICE: UP TO {ECONOMY.haggle.maxRounds} ROUNDS AGAINST THEIR HIDDEN WALK-AWAY PRICE.</p>
        <p>A STANDING CONTRACT ASKS FOR EGGS EVERY DAY. A MISSED DELIVERY COSTS A PENALTY, AND TOO MANY END IT.</p>
      </>
    ),
  },
  {
    id: 'machines',
    title: 'MACHINES',
    short: 'MACHINES',
    picture: () => <MachineArt unlock="grader" />,
    body: (
      <ul>
        {UNLOCK_IDS.map((u) => (
          <li key={u}>
            {UNLOCK_TEXT[u].name} ({ECONOMY.unlocks[u].price}): {UNLOCK_TEXT[u].saves}
          </li>
        ))}
      </ul>
    ),
  },
  {
    id: 'wear',
    title: 'MACHINES WEAR OUT',
    short: 'WEAR AND REPAIR',
    picture: () => <Art id="19c-egg-grader-wear" row="worn" />,
    body: (
      <>
        <p>
          A MACHINE WEARS A LITTLE EACH DAY IT WORKS (THE CART: EACH DELIVERY). DOWN TO {pct(ECONOMY.wear.fullEffectAbove)} IT GIVES ITS FULL EFFECT; BELOW THAT IT GIVES LESS. UNDER{' '}
          {pct(ECONOMY.wear.breakdownBelow)} IT MAY BREAK DOWN AT A DAY CLOSE AND STOP UNTIL YOU REPAIR IT.
        </p>
        <p>TAP A MACHINE TO SEE ITS CONDITION. A REPAIR TO 100% COSTS UP TO {pct(ECONOMY.wear.repairShare)} OF ITS PRICE, LESS THE LESS IT IS WORN. EACH MACHINE PAYS FOR ITSELF BEFORE ITS FIRST REPAIR.</p>
      </>
    ),
  },
  {
    id: 'rivals',
    title: 'RIVALS AND BUSTS',
    short: 'RIVALS AND BUSTS',
    picture: () => <Art id="17-sign-upstart" row="sway" />,
    body: (
      <>
        <p>RIVAL FARMS TRADE IN THE SAME MARKET. A FARM THAT RUNS OUT OF COINS GOES BUST: ITS SIGN FALLS AND ITS HENS GO TO THE MARKET&apos;S HEN AUCTION.</p>
        <p>YOUR FARM CAN GO BUST TOO. WATCH YOUR COINS AND YOUR CREDIT.</p>
      </>
    ),
  },
  {
    id: 'feathers',
    title: 'FEATHERS (BETA)',
    short: 'FEATHERS',
    picture: () => <SheetSprite id="x-feather-golden-quill" row="float" play="loop" zoom={1} />,
    body: (
      <>
        <p>
          ONLY {ECONOMY.feathers.maxSupply} FEATHERS WILL EVER EXIST, AND THE CONTRACT ON NEAR ENFORCES IT. A FEATHER IS A CLAIM TICKET FOR ONE OF THE {ECONOMY.feathers.maxSupply} FOUNDING HENS, PLANNED TO BE
          REVEALED AND MINTED AS HENS AT THE MAINNET LAUNCH. HENS ON YOUR FARM ARE NEVER MINTED.
        </p>
        <p>
          A MILESTONE CAN WIN YOU A FEATHER TICKET. OPEN THE FEATHER MINT (MINT, TOP BAR) AND MINT IT FOR {ECONOMY.feathers.redeemFee} COINS: THE PRESS STAMPS IT OUT AND ITS FEATHER IS MINTED AT ONCE TO
          YOUR WALLET ON NEAR&apos;S TEST NETWORK. THE GAME PAYS THE NETWORK; YOU NEVER NEED TEST NEAR. TICKETS KEEP, SO YOU CAN WAIT.
        </p>
      </>
    ),
  },
  {
    id: 'grades',
    title: 'GRADES AND ODDS',
    short: 'GRADES AND ODDS',
    picture: () => <SheetSprite id="x-founders-frame-legendary" row="plate" zoom={1} />,
    body: (
      <>
        <p>
          WHEN YOU MINT, YOUR FARM&apos;S MANAGEMENT SCORE SETS THE FEATHER&apos;S GRADE: DAYS IN GOOD STANDING, YOUR DELIVERY RECORD, HAGGLES WON AND PROFIT. FLUFF, PLUME (FROM{' '}
          {pct(ECONOMY.feathers.bands.plume)}), QUILL (FROM {pct(ECONOMY.feathers.bands.quill)}), GOLDEN QUILL (FROM {pct(ECONOMY.feathers.bands['golden-quill'])}).
        </p>
        <p>
          THE GRADE SETS THE ODDS OF A HIGH-RARITY HEN, NOT THE HEN. THE 777 HENS ARE FIXED: 7 LEGENDARY, 70 EPIC, 200 RARE, 500 COMMON. A GOLDEN QUILL WEIGHS 8 TOWARD LEGENDARY TO A
          FLUFF&apos;S 1. THE FEATHER MINT SHOWS EACH GRADE&apos;S ESTIMATED CHANCES FROM THE FEATHERS MINTED SO FAR.
        </p>
      </>
    ),
  },
  {
    id: 'mint-page',
    title: 'THE FEATHER MINT',
    short: 'THE MINT',
    picture: () => <SheetSprite id="x-founders-frame-unminted" row="plate" zoom={1} />,
    body: (
      <>
        <p>
          THE FEATHER MINT (MINT IN THE TOP BAR OR ON THE TITLE, OR /MINT) SHOWS ALL 777 NUMBERS: MINTED ONES AS FEATHER CARDS, THE REST AS DARK SILHOUETTES. IT LISTS YOUR
          TICKETS, RECENT MINTS, THE FOUNDERS HASH (COMMITTED ON NEAR BEFORE THE FIRST FEATHER) AND THE CONTRACT. ANYONE CAN OPEN IT; YOU SIGN IN ONLY TO MINT.
        </p>
        <p>
          EACH FEATHER GETS A RANDOM FREE NUMBER FROM 001 TO 777, DRAWN BY THE SERVER FROM A SEED ANYONE CAN CHECK: THE SHA-256 OF THE SEASON, THE TICKET AND THE LAST DAY&apos;S
          SETTLEMENT ON NEAR. YOU SEE IT SENT TO NEAR, THEN CONFIRMED. IF NEAR REFUSES IT, YOUR TICKET AND YOUR COINS COME BACK.
        </p>
        <p>
          PLANNED FOR MAINNET: A SNAPSHOT OF FEATHER HOLDERS, A REVEAL SEEDED BY A PUBLIC EVENT CHOSEN IN ADVANCE THAT ALWAYS DRAWS EXACTLY 7/70/200/500, AND A CLAIM BY LOGGING IN WITH THE
          SAME ACCOUNT. NOTHING OF IT IS LIVE YET: THIS IS THE BETA.
        </p>
      </>
    ),
  },
  {
    id: 'milestones',
    title: 'MILESTONES',
    short: 'MILESTONES',
    picture: () => <SheetSprite id="32-icons" row="hen" zoom={4} />,
    body: (
      <>
        <p>
          EACH MILESTONE GIVES A FARM IN GOOD STANDING ONE CHANCE ({pct(ECONOMY.feathers.odds)}) AT A FEATHER TICKET, ONCE. A MISS IS FINAL BUT KIND: THE NEXT MILESTONE IS ANOTHER CHANCE. GOOD STANDING: NEVER BUST THIS SEASON, NO CREDIT PAST
          ITS DUE DAY, NO CONTRACT MISSED IN THE LAST {ECONOMY.feathers.missWindowDays} DAYS.
        </p>
        <ul>
          {(Object.keys(MILESTONE_TEXT) as MilestoneId[]).map((m) => (
            <li key={m}>{MILESTONE_TEXT[m]}</li>
          ))}
        </ul>
      </>
    ),
  },
  {
    id: 'glossary',
    title: 'GLOSSARY',
    short: 'GLOSSARY',
    picture: () => <SheetSprite id="32-icons" row="ledger" zoom={4} />,
    body: (
      <ul>
        <li>CRATE: WHERE COLLECTED EGGS WAIT TO BE SOLD.</li>
        <li>PRICES AT N%: TODAY&apos;S PRICE AGAINST A NORMAL DAY.</li>
        <li>GLUT: MORE EGGS SOLD THAN THE STREET NEEDS; PRICES FALL.</li>
        <li>WALK-AWAY PRICE: THE LOWEST (OR HIGHEST) A TRADER WILL TAKE.</li>
        <li>CLERK FLOOR: THE SHARE OF TODAY&apos;S PRICE THE SALES CLERK ACCEPTS ON ITS OWN.</li>
        <li>GOOD STANDING: WHAT A FARM NEEDS FOR MILESTONE CHANCES.</li>
        <li>FEATHER TICKET: WON AT A MILESTONE; MINT IT IN THE FEATHER MINT.</li>
        <li>FEATHER: A TESTNET NFT, A CLAIM TICKET FOR ONE OF THE 777 FOUNDING HENS (PLANNED).</li>
        <li>GRADE: FLUFF, PLUME, QUILL OR GOLDEN QUILL; IT SETS THE ODDS, NOT THE HEN.</li>
        <li>RECEIPT: THE DAY&apos;S RECORD ON NEAR, LINKED IN THE LEDGER.</li>
        <li>TESTNET: NEAR&apos;S PRACTICE NETWORK, WHERE THIS BETA RECORDS EVERYTHING.</li>
      </ul>
    ),
  },
];

/** A section's body as blocks to page: each paragraph, and each list item as a list of one. */
function blocksOf(body: ReactNode): ReactNode[] {
  const out: ReactNode[] = [];
  const walk = (n: ReactNode) => {
    for (const c of Children.toArray(n)) {
      const kids = isValidElement(c) ? (c.props as { children?: ReactNode }).children : null;
      if (isValidElement(c) && c.type === Fragment) walk(kids);
      else if (isValidElement(c) && c.type === 'ul') for (const li of Children.toArray(kids)) out.push(<ul key={`li-${out.length}`}>{li}</ul>);
      else out.push(c);
    }
  };
  walk(body);
  return out;
}

export function HowToPlay({ onClose }: { onClose: () => void }) {
  const { audio } = useServices();
  const v = useViewport();
  const [at, setAt] = useState(0);
  const s = SECTIONS[at] ?? SECTIONS[0];
  if (!s) return null;
  // the list of sections beside the text when the window is wide enough; else previous and next only
  const wide = Math.min(520, Math.floor(v.zones.modal.w)) >= 440;
  const go = (i: number) => {
    uiSound(audio, 'click');
    setAt(i);
  };
  return (
    <Modal title="HOW TO PLAY" onClose={onClose} w={520} h={320} className="guide-page">
      <div className="row" style={{ alignItems: 'flex-start', gap: 8 }} data-ui="guide">
        {wide && (
          <nav className="col" style={{ width: 150, flex: 'none', gap: 1 }} aria-label="Sections">
            {SECTIONS.map((x, i) => (
              <button
                key={x.id}
                className={`btn ${i === at ? 'red' : ''}`}
                style={{ justifyContent: 'flex-start', width: '100%', whiteSpace: 'nowrap', height: 13 }}
                title={x.title}
                data-tour={`guide-${x.id}`}
                onClick={() => go(i)}
              >
                {x.short}
              </button>
            ))}
          </nav>
        )}
        <article className="col" style={{ flex: 1, minWidth: 0, gap: 6 }} data-ui="guide-section" data-section={s.id}>
          <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
            <div style={{ width: 72, height: 72, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#e3cc96' }}>{s.picture()}</div>
            <h3 className="panel-title" style={{ margin: 0 }}>
              {s.title}
            </h3>
          </div>
          <div className="guide-text">
            <Paged
              key={s.id}
              items={blocksOf(s.body)}
              gap={4}
              resetKey={s.id}
              label={`SECTION ${at + 1} OF ${SECTIONS.length}`}
              onPrevEdge={at > 0 ? () => go(at - 1) : undefined}
              onNextEdge={at < SECTIONS.length - 1 ? () => go(at + 1) : undefined}
              ui="guide-pages"
            />
          </div>
        </article>
      </div>
    </Modal>
  );
}
