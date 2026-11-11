// The farm: the world on the canvas, the HUD, the card tray and desk, the card overlay, the shop,
// the ledger, and the market board over the town square. Server state flows in through the
// socket; player choices go out as actions and come back as events with juice.
import { useCallback, useEffect, useRef, useState } from 'react';
import { isCrash, type CardView, type UnlockId } from '@coys/shared';
import { useServices } from '../app/services';
import { worldToUi } from '../app/viewport';
import { GameSocket, type Action } from '../net/socket';
import { FarmScene, type WorldTarget } from '../pixi/farm/FarmScene';
import { TownScene } from '../pixi/TownScene';
import { events, game } from '../state/game';
import { useStore } from '../state/store';
import { CardOverlay, type OverlayResult } from '../ui/CardOverlay';
import { GlutCard, SellCard } from '../ui/Cards';
import { LOOK } from '../ui/cast';
import { Desk } from '../ui/Desk';
import { FxLayer, uiFx } from '../ui/FxLayer';
import { Ticker, TopBar } from '../ui/Hud';
import { LedgerPanel } from '../ui/Ledger';
import { MarketBoard } from '../ui/MarketBoard';
import { Onboarding, onboardingSeen } from '../ui/Onboarding';
import { ShopPanel, type ShopTab } from '../ui/Panels';
import { HenPanel, MachinePanel, SellPanel } from '../ui/WorldPanels';

type OpenPanel =
  | { kind: 'shop'; tab: ShopTab }
  | { kind: 'ledger' }
  | { kind: 'hen'; henId: string }
  | { kind: 'sell' }
  | { kind: 'machine'; unlock: UnlockId };

/** What clicking each thing on the farm opens. */
function panelFor(t: WorldTarget): OpenPanel | 'market' {
  switch (t.kind) {
    case 'hen':
      return { kind: 'hen', henId: t.hen.id };
    case 'crate':
      return { kind: 'sell' };
    case 'feed':
      return { kind: 'shop', tab: 'feed' };
    case 'coop':
      return { kind: 'shop', tab: 'coops' };
    case 'farmhouse':
      return { kind: 'ledger' };
    case 'sign':
      return 'market';
    case 'machine':
      return { kind: 'machine', unlock: t.unlock };
  }
}

const REFUSALS: Record<string, string> = {
  insufficient_funds: 'NOT ENOUGH COINS',
  insufficient_stock: 'NOT ENOUGH IN STOCK',
  rate_limited: 'EASY THERE, ONE THING AT A TIME',
  invalid_action: 'CANNOT DO THAT RIGHT NOW',
  not_found: 'THAT IS GONE ALREADY',
  farm_bust: 'THIS FARM IS BUST',
};

export function FarmScreen({ session, accountId, onSignedOut, onSettings }: { session: string; accountId: string | null; onSignedOut: () => void; onSettings: () => void }) {
  const { assets, audio, pixi } = useServices();
  const farm = useStore(game, (s) => s.farm);
  const market = useStore(game, (s) => s.market);
  const status = useStore(game, (s) => s.status);
  const [panel, setPanel] = useState<OpenPanel | null>(null);
  const [view, setView] = useState<'farm' | 'market'>('farm');
  // first run on this browser: three cards on collecting, selling and decision cards
  const [tour, setTour] = useState(() => !onboardingSeen());
  const [overlay, setOverlay] = useState<{ card: CardView; result: OverlayResult | null; mood: 'warm' | 'firm' | 'cross' | null } | null>(null);
  const queue = useRef<CardView[]>([]);
  const socket = useRef<GameSocket | null>(null);
  const scene = useRef<FarmScene | null>(null);
  const town = useRef<TownScene | null>(null);
  const linked = useRef(false);

  const send = useCallback(async (a: Action): Promise<boolean> => {
    const ack = await socket.current?.send(a);
    return Boolean(ack?.ok);
  }, []);

  useEffect(() => {
    const s = new GameSocket(session);
    socket.current = s;
    s.connect();
    return () => {
      s.close();
      socket.current = null;
      game.set({ status: 'idle', farm: null, ledger: null });
    };
  }, [session]);

  useEffect(() => {
    if (status === 'unauthenticated') onSignedOut();
    if (status === 'online' && accountId && !linked.current) {
      linked.current = true;
      void send({ t: 'linkWallet', accountId });
    }
  }, [status, accountId, onSignedOut, send]);

  // the world
  useEffect(() => {
    if (!farm || scene.current) return;
    const s = new FarmScene(assets, audio, pixi.app.renderer, {
      collect: (eggId) => send({ t: 'collect', eggId }),
      coins: (from, count) => uiFx.emit({ kind: 'coins', from: worldToUi(from), count }),
      open: (target) => {
        const p = panelFor(target);
        if (p === 'market') setView('market');
        else setPanel(p);
      },
    });
    scene.current = s;
    (window as unknown as { __coysFarm?: unknown }).__coysFarm = { targets: () => s.targets() };
    s.sync(farm);
    pixi.setScene(s);
  }, [farm, assets, audio, pixi, send]);

  useEffect(
    () => () => {
      town.current?.destroy();
      pixi.setScene(null);
    },
    [pixi],
  );
  useEffect(() => {
    if (farm) scene.current?.sync(farm);
  }, [farm]);

  // the market board swaps the canvas to the town square; the farm keeps running behind it
  useEffect(() => {
    if (!scene.current) return;
    if (view === 'market') {
      town.current = new TownScene(assets, audio);
      pixi.setScene(town.current, { keep: true });
      audio.play('16-ticker', { volume: 0.4 });
    } else if (town.current) {
      pixi.setScene(scene.current);
      town.current = null;
    }
  }, [view, assets, audio, pixi]);

  const crashed = market ? isCrash(market.multiplier) : false;
  useEffect(() => {
    audio.playMusic(crashed ? '43-market-tension' : '42-farm-day', 1200);
  }, [audio, crashed]);

  // cards: queue arrivals, show one at a time
  const showNext = useCallback(() => {
    const next = queue.current.shift();
    setOverlay(next ? { card: next, result: null, mood: null } : null);
  }, []);
  const openCard = useCallback((card: CardView) => {
    setOverlay((cur) => (cur ? cur : { card, result: null, mood: null }));
  }, []);

  useEffect(
    () =>
      events.on((e) => {
        scene.current?.onEvent(e);
        switch (e.kind) {
          case 'cardArrived':
            setOverlay((cur) => {
              if (!cur) return { card: e.card, result: null, mood: null };
              if (!queue.current.some((c) => c.id === e.card.id) && cur.card.id !== e.card.id) queue.current.push(e.card);
              return cur;
            });
            break;
          case 'haggle':
            setOverlay((cur) => (cur && cur.card.id === e.card.id ? { card: e.card, result: null, mood: e.mood } : cur));
            break;
          case 'cardResolved':
            if (e.auto) {
              uiFx.emit({ kind: 'toast', text: `THE CLERK TOOK ${e.card.from.toUpperCase()}'S OFFER: +${(e.totalMilli / 1000).toFixed(2)}` });
              queue.current = queue.current.filter((c) => c.id !== e.card.id);
              setOverlay((cur) => (cur && cur.card.id === e.card.id ? null : cur));
            } else setOverlay((cur) => (cur && cur.card.id === e.card.id ? { card: e.card, result: { outcome: e.outcome, totalMilli: e.totalMilli }, mood: null } : cur));
            break;
          case 'sold':
            uiFx.emit({ kind: 'stamp', row: 'sold', coins: e.totalMilli / 1000 });
            break;
          case 'refused':
            if (e.code !== 'bad_message') uiFx.emit({ kind: 'toast', text: REFUSALS[e.code] ?? 'SOMETHING WENT WRONG', tone: 'bad' });
            audio.play('35-back', { volume: 0.6 });
            break;
          case 'dayEnded': {
            // every card closes with its day: drop queued ones and any card still waiting for an answer
            queue.current = [];
            setOverlay((cur) => (cur && !cur.result ? null : cur));
            const s = e.summary;
            uiFx.emit({ kind: 'toast', text: `DAY ${s.day}: ${s.laid} LAID. MARKET X${s.nextMultiplier.toFixed(2)}${s.missed ? `. ${s.missed} DELIVERY MISSED` : ''}` });
            if (s.fedMultiplier === 0) {
              audio.play('29-alarm-bell', { delayMs: 800 });
              uiFx.emit({ kind: 'toast', text: 'THE TROUGH IS EMPTY: NO EGGS TOMORROW', tone: 'bad' });
            }
            break;
          }
          case 'contractDelivered':
            uiFx.emit({ kind: 'coins', from: { x: 444, y: 280 }, count: 4 });
            if (e.auto) uiFx.emit({ kind: 'toast', text: `THE CART DELIVERED ${e.qty} EGGS` });
            break;
          case 'contractMissed':
            uiFx.emit({ kind: 'toast', text: `MISSED A DELIVERY: -${(e.penaltyMilli / 1000).toFixed(2)}. THE BAKERY IS NOT HAPPY`, tone: 'bad' });
            audio.play('20-fail', { volume: 0.6 });
            break;
          case 'debtCharged':
            if (e.defaulted) uiFx.emit({ kind: 'toast', text: 'COULD NOT PAY THE LOYALIST IN FULL', tone: 'bad' });
            break;
          case 'orderFilled':
            uiFx.emit({ kind: 'toast', text: `${e.side === 'sell' ? 'SOLD' : 'BOUGHT'} ${e.qty} ${e.side === 'sell' ? 'TO' : 'FROM'} ${e.counterparty.toUpperCase()}` });
            break;
          case 'rivalBust':
            uiFx.emit({ kind: 'bust', name: e.name, sign: LOOK[e.agentKind].sign });
            break;
          case 'agentOpened':
            uiFx.emit({ kind: 'toast', text: `NEW IN TOWN: ${e.name.toUpperCase()}` });
            break;
          case 'crash':
            if (e.on) uiFx.emit({ kind: 'toast', text: 'MARKET CRASH! TOO MANY EGGS', tone: 'bad' });
            break;
          case 'coopBuilt':
            uiFx.emit({ kind: 'toast', text: `NEW ${e.coopKind.toUpperCase()} COOP` });
            break;
          case 'unlockBought':
            uiFx.emit({ kind: 'toast', text: `${e.unlock.toUpperCase()} ONLINE` });
            break;
          default:
            break;
        }
      }),
    [audio],
  );

  if (!farm || !market) {
    return (
      <div className="stage640">
        <div className="toast" style={{ position: 'absolute', left: 320, top: 170, transform: 'translateX(-50%)' }}>
          {status === 'offline' ? 'RECONNECTING TO THE MARKET' : 'WALKING TO THE FARM'}
        </div>
      </div>
    );
  }

  return (
    <div className="layer">
      <TopBar
        farm={farm}
        onShop={() => setPanel({ kind: 'shop', tab: 'hens' })}
        onSettings={onSettings}
        onMarket={() => setView(view === 'market' ? 'farm' : 'market')}
        onLedger={() => setPanel({ kind: 'ledger' })}
      />
      {view === 'market' ? (
        <div className="stage640">
          <MarketBoard farm={farm} market={market} send={send} onBack={() => setView('farm')} />
        </div>
      ) : (
        <div className="tray">
          <SellCard farm={farm} market={market} send={send} />
          <Desk farm={farm} send={send} onOpen={openCard} />
          {market.crash && <GlutCard market={market} />}
        </div>
      )}
      <Ticker extra={[farm.name.toUpperCase()]} />
      {status === 'offline' && (
        <div className="stage640">
          <div className="toast" style={{ position: 'absolute', left: 320, top: 300, transform: 'translateX(-50%)' }}>
            RECONNECTING TO THE MARKET
          </div>
        </div>
      )}
      {panel && (
        <div className="stage640" style={{ zIndex: 20 }}>
          {panel.kind === 'shop' && <ShopPanel key={panel.tab} tab={panel.tab} farm={farm} send={send} onClose={() => setPanel(null)} />}
          {panel.kind === 'ledger' && <LedgerPanel farm={farm} send={send} onClose={() => setPanel(null)} />}
          {panel.kind === 'sell' && <SellPanel farm={farm} market={market} send={send} onClose={() => setPanel(null)} />}
          {panel.kind === 'machine' && (
            <MachinePanel unlock={panel.unlock} farm={farm} onShop={() => setPanel({ kind: 'shop', tab: 'machines' })} onClose={() => setPanel(null)} />
          )}
          {panel.kind === 'hen' &&
            (() => {
              const hen = farm.hens.find((h) => h.id === panel.henId);
              return hen ? <HenPanel hen={hen} onClose={() => setPanel(null)} /> : null;
            })()}
        </div>
      )}
      {tour && view === 'farm' && <Onboarding onDone={() => setTour(false)} />}
      {overlay && view === 'farm' && !tour && (
        <CardOverlay key={overlay.card.id} card={overlay.card} result={overlay.result} haggleMood={overlay.mood} send={send} onClose={showNext} />
      )}
      <FxLayer />
    </div>
  );
}
