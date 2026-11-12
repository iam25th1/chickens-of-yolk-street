// The How to play guide: short sections in plain words, each with a picture from the game's own
// art. Opens from Settings and from the ? in the top bar.
import { useState, type ReactNode } from 'react';
import { ECONOMY, UNLOCK_IDS, type MilestoneId } from '@coys/shared';
import { uiSound, useServices } from '../app/services';
import { useViewport } from '../app/Stage';
import { Modal } from './Modal';
import { MachineArt, UNLOCK_TEXT } from './Panels';
import { SheetSprite } from './SheetSprite';

export const MILESTONE_TEXT: Record<MilestoneId, string> = {
  'full-coop': 'FILL YOUR COOPS FOR THE FIRST TIME',
  'good-week': `STAY IN GOOD STANDING FOR ${ECONOMY.founding.goodDays} DAYS`,
  'eggs-sold': `SELL ${ECONOMY.founding.eggsSold} EGGS`,
  'haggles-won': `WIN ${ECONOMY.founding.hagglesWon} HAGGLES`,
  'all-machines': 'OWN ALL FIVE MACHINES',
  'outlast-rival': 'OUTLAST A RIVAL FARM THAT GOES BUST',
  'top-three': `FINISH A DAY IN THE BOARD'S TOP ${ECONOMY.founding.topRank}`,
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
        <p>RUN THE BEST EGG FARM ON YOLK STREET. EVERY RIVAL, SUPPLIER AND BUYER IS AN AI WITH ITS OWN COINS AND MEMORY.</p>
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
        <p>SELL TOO MANY AT ONCE AND PRICES CRASH (A GLUT). WHEN EGGS ARE SCARCE, PRICES RISE. THE BOARD SHOWS BOTH, AND AN ORDER BOOK FOR YOUR OWN PRICE.</p>
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
    picture: () => <SheetSprite id="29-card-bulk-order" row="flutter" zoom={1} style={{ height: 72, overflow: 'hidden' }} />,
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
    id: 'rivals',
    title: 'RIVALS AND BUSTS',
    short: 'RIVALS AND BUSTS',
    picture: () => <Art id="17-sign-upstart" row="sway" />,
    body: (
      <>
        <p>RIVAL FARMS TRADE IN THE SAME MARKET. A FARM THAT RUNS OUT OF COINS GOES BUST: ITS SIGN FALLS AND ITS HENS GO TO AUCTION IN THE SHOP.</p>
        <p>YOUR FARM CAN GO BUST TOO. WATCH YOUR COINS AND YOUR CREDIT.</p>
      </>
    ),
  },
  {
    id: 'founding',
    title: 'FOUNDING HENS AND CERTIFICATES',
    short: 'FOUNDING HENS',
    picture: () => <SheetSprite id="30-stamps" row="accepted" zoom={1} />,
    body: (
      <>
        <p>
          ONLY {ECONOMY.founding.maxSupply} FOUNDING HENS WILL EVER EXIST. EACH IS RECORDED ON NEAR AS A CERTIFICATE THAT PROVES SHE IS YOURS FOR GOOD. ORDINARY HENS ARE NOT
          RECORDED.
        </p>
        <p>A FOUNDING HEN IS A FULL HEN: SHE LAYS, CARRIES HER TRAITS, LIVES ON YOUR FARM AND CAN BE TRADED. THE BOARD SHOWS HOW MANY ARE LEFT.</p>
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
          EACH MILESTONE GIVES A FARM IN GOOD STANDING ONE CHANCE ({pct(ECONOMY.founding.odds)}) AT A FOUNDING HEN, ONCE. GOOD STANDING: NEVER BUST THIS SEASON, NO CREDIT PAST
          ITS DUE DAY, NO CONTRACT MISSED IN THE LAST {ECONOMY.founding.missWindowDays} DAYS.
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
        <li>CERTIFICATE: A FOUNDING HEN&apos;S RECORD ON NEAR.</li>
        <li>RECEIPT: THE DAY&apos;S RECORD ON NEAR, LINKED IN THE LEDGER.</li>
        <li>TESTNET: NEAR&apos;S PRACTICE NETWORK, WHERE THIS BETA RECORDS EVERYTHING.</li>
      </ul>
    ),
  },
];

export function HowToPlay({ onClose }: { onClose: () => void }) {
  const { audio } = useServices();
  const [at, setAt] = useState(0);
  const s = SECTIONS[at] ?? SECTIONS[0];
  if (!s) return null;
  return (
    <Modal title="HOW TO PLAY" onClose={onClose} w={520} h={320} className="guide-page">
      <div className="row" style={{ alignItems: 'flex-start', gap: 8 }} data-ui="guide">
        <nav className="col" style={{ width: 150, flex: 'none', gap: 2 }} aria-label="Sections">
          {SECTIONS.map((x, i) => (
            <button
              key={x.id}
              className={`btn ${i === at ? 'red' : ''}`}
              style={{ justifyContent: 'flex-start', width: '100%', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'clip' }}
              title={x.title}
              data-tour={`guide-${x.id}`}
              onClick={() => {
                uiSound(audio, 'click');
                setAt(i);
              }}
            >
              {x.short}
            </button>
          ))}
        </nav>
        <article className="col" style={{ flex: 1, minWidth: 0, gap: 6 }}>
          <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
            <div style={{ width: 72, height: 72, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#e3cc96', overflow: 'hidden' }}>{s.picture()}</div>
            <h3 className="panel-title" style={{ margin: 0 }}>
              {s.title}
            </h3>
          </div>
          <div className="guide-text">{s.body}</div>
        </article>
      </div>
    </Modal>
  );
}
