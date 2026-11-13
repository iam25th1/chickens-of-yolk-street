// The farm: the world on the canvas and the UI in fixed zones that never overlap (app/viewport.ts):
// the top bar, the side panel (crate, waiting cards, desk), the goal tracker with the toast area
// above it, and one modal at a time over a dimmed backdrop (shop, ledger, market board, a card, a
// hen, a machine, the crate, a hen's certificate, settings). Server state flows in through the
// socket; player choices go out as actions and come back as events with juice.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ECONOMY, isCrash, type CardView } from '@coys/shared';
import { useServices } from '../app/services';
import { useViewport } from '../app/Stage';
import { worldToUi } from '../app/viewport';
import { GameSocket, type Action } from '../net/socket';
import { FarmScene, type WorldTarget } from '../pixi/farm/FarmScene';
import { TownScene } from '../pixi/TownScene';
import { events, game } from '../state/game';
import { useStore } from '../state/store';
import { startTourFor, tour } from '../state/tour';
import { OPEN_MINT_KEY, closeModal, openModal, ui, type ModalState } from '../state/ui';
import { CardOverlay, type OverlayResult } from '../ui/CardOverlay';
import { LOOK } from '../ui/cast';
import { SidePanel } from '../ui/Desk';
import { FxLayer, uiFx } from '../ui/FxLayer';
import { ToastArea, Tracker } from '../ui/Guide';
import { TopBar } from '../ui/Hud';
import { LedgerPanel } from '../ui/Ledger';
import { MarketBoard } from '../ui/MarketBoard';
import { HowToPlay, MILESTONE_TEXT } from '../ui/HowToPlay';
import { Modal } from '../ui/Modal';
import { SettingsBody, ShopPanel } from '../ui/Panels';
import { Spotlight, TOUR, TourBox } from '../ui/Tour';
import { RevealPanel, type RevealState } from '../ui/Feathers';
import { FeatherMint } from '../ui/FeatherMint';
import { MintMoment } from '../ui/MintMoment';
import { HenPanel, MachinePanel, SellPanel } from '../ui/WorldPanels';
import { NameFarm } from '../ui/NameFarm';
import { ProfilePage } from '../ui/Profile';
import { PublicProfileModal } from '../ui/PublicProfile';
import { BadgeMoments } from '../ui/BadgeMoment';
import { MACHINE_NAME } from '../pixi/farm/FarmScene';

/** What clicking each thing on the farm opens. */
/** Whether the minting moment is showing this ticket's mint. */
function mintingNow(ticketId: string): boolean {
  const m = ui.get().modal;
  return m?.kind === 'minting' && m.ticketId === ticketId;
}

function modalFor(t: WorldTarget): ModalState {
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
      return { kind: 'market', tab: 'board' };
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

export function FarmScreen({ session, accountId, onSignedOut }: { session: string; accountId: string | null; onSignedOut: () => void }) {
  const { assets, audio, pixi } = useServices();
  const v = useViewport();
  const farm = useStore(game, (s) => s.farm);
  const market = useStore(game, (s) => s.market);
  const status = useStore(game, (s) => s.status);
  const modal = useStore(ui, (s) => s.modal);
  const profile = useStore(game, (s) => s.profile);
  const touring = useStore(tour, (s) => s.active);
  // the open card's live state: haggle mood and outcome arrive as events
  const [cardState, setCardState] = useState<{ card: CardView; result: OverlayResult | null; mood: 'warm' | 'firm' | 'cross' | null } | null>(null);
  const reveals = useRef<RevealState[]>([]);
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
      closeModal();
      game.set({ status: 'idle', farm: null, ledger: null, profile: null });
    };
  }, [session]);

  useEffect(() => {
    if (status === 'unauthenticated') onSignedOut();
    if (status === 'online' && accountId && !linked.current) {
      linked.current = true;
      void send({ t: 'linkWallet', accountId });
    }
  }, [status, accountId, onSignedOut, send]);

  // first entry to this farm: the tour starts on its own for a player who has never done it, and
  // the server hears when it is finished or skipped
  const farmId = farm?.farmId ?? null;
  const tourDone = farm?.tourDone ?? false;
  // a farm without a chosen name is named first (once a visit), then the tour starts
  const needsName = farm?.needsName ?? false;
  const askedName = useRef(false);
  useEffect(() => {
    if (!farmId || !needsName || askedName.current) return;
    askedName.current = true;
    openModal({ kind: 'name', mode: 'first' });
  }, [farmId, needsName]);
  useEffect(() => {
    if (!farmId || needsName) return;
    // signed in from the open Feather Mint: a player past the tour goes back to the mint
    const fromMint = sessionStorage.getItem(OPEN_MINT_KEY);
    sessionStorage.removeItem(OPEN_MINT_KEY);
    if (fromMint && tourDone) openModal({ kind: 'feathers' });
    else startTourFor(farmId, tourDone);
    // the farm's first named state decides
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [farmId, needsName]);
  const wasTouring = useRef(false);
  useEffect(() => {
    if (wasTouring.current && !touring && !tourDone) void send({ t: 'tourDone' });
    wasTouring.current = touring;
  }, [touring, tourDone, send]);

  // the world
  useEffect(() => {
    if (!farm || scene.current) return;
    const s = new FarmScene(assets, audio, pixi.app.renderer, {
      collect: (eggId) => send({ t: 'collect', eggId }),
      coins: (from, count) => uiFx.emit({ kind: 'coins', from: worldToUi(from), count }),
      open: (target) => openModal(modalFor(target)),
    });
    scene.current = s;
    // read-only hooks for automated checks: where things are on the farm, and opening a modal as a click would
    (window as unknown as { __coysFarm?: unknown }).__coysFarm = { targets: () => s.targets(), yard: () => s.yardBox() };
    (window as unknown as { __coysUi?: unknown }).__coysUi = { open: openModal, close: closeModal };
    // and showing any tour step, so every step's box can be checked at every window size
    (window as unknown as { __coysTour?: unknown }).__coysTour = { count: TOUR.length, show: (step: number) => tour.set({ active: true, step }), end: () => tour.set({ active: false, step: 0 }) };
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

  // the rival farms' signs at the farm's edge: one per rival, the open farm if there is one
  useEffect(() => {
    if (!market) return;
    const byKind = new Map<string, { sign: string; name: string; bust: boolean }>();
    for (const r of market.ranking) {
      if (r.kind === 'player') continue;
      const sign = LOOK[r.kind].sign;
      if (!sign) continue;
      const have = byKind.get(r.kind);
      if (!have || (have.bust && !r.bust)) byKind.set(r.kind, { sign, name: r.name, bust: r.bust });
    }
    scene.current?.setRivals([...byKind.values()]);
  }, [market, farm]);

  // the market board swaps the canvas to the town square (on a phone the farm stays behind it);
  // the farm keeps running either way
  const marketOpen = modal?.kind === 'market' && !v.portrait;
  // the town square's art comes with the later groups: a board opened before they arrive loads them
  // first (the farm stays behind the board meanwhile) instead of drawing art that is not there
  const townReady = () => assets.has('27-town-square-plate') && assets.has('27-town-square-anim');
  const [townArt, setTownArt] = useState(townReady);
  useEffect(() => {
    if (!marketOpen || townArt) return;
    let live = true;
    void assets
      .loadGroups(['market'], v.p, { quick: true })
      .then(() => {
        if (live) setTownArt(townReady());
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // townReady reads the store
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketOpen, townArt, assets, v.p]);
  useEffect(() => {
    if (!scene.current) return;
    if (marketOpen && townArt && !town.current) {
      town.current = new TownScene(assets, audio);
      pixi.setScene(town.current, { keep: true });
      audio.play('16-ticker', { volume: 0.4 });
    } else if (!marketOpen && town.current) {
      pixi.setScene(scene.current);
      town.current = null;
    }
  }, [marketOpen, townArt, assets, audio, pixi]);

  // the farm's music starts once its sharp art is in (the stream would otherwise share the line)
  const crashed = market ? isCrash(market.multiplier) : false;
  const [artIn, setArtIn] = useState(false);
  useEffect(() => {
    let live = true;
    void assets
      .loadGroups(['farm'], v.farm.k)
      .catch(() => undefined)
      .then(() => live && setArtIn(true));
    return () => {
      live = false;
    };
  }, [assets, v.farm.k]);
  useEffect(() => {
    if (artIn) audio.playMusic(crashed ? '43-market-tension' : '42-farm-day', 1200);
  }, [audio, crashed, artIn]);

  // a Feather's reveal waits until no other modal is open
  useEffect(() => {
    if (modal || !reveals.current.length) return;
    const next = reveals.current.shift();
    if (next) openModal({ kind: 'reveal', ...next });
  }, [modal, farm]);

  // the profile asks for its data when it opens, and again when a day closes or a badge comes while it is open
  const profileOpen = modal?.kind === 'profile';
  useEffect(() => {
    if (!profileOpen) return;
    void send({ t: 'getProfile' });
    return events.on((e) => {
      if (e.kind === 'dayEnded' || e.kind === 'badgeEarned') void send({ t: 'getProfile' });
    });
  }, [profileOpen, send]);

  /** Mints a held ticket: the minting moment opens at once and follows the mint's stages. */
  const startMint = useCallback(
    (ticketId: string) => {
      openModal({ kind: 'minting', ticketId, attempt: Date.now() });
      void send({ t: 'redeemTicket', ticketId }).then((ok) => {
        // refused (the coins, say): the toast says why, and the mint page comes back
        if (!ok) openModal({ kind: 'feathers' });
      });
    },
    [send],
  );

  const openCard = useCallback((card: CardView) => {
    setCardState({ card, result: null, mood: null });
    openModal({ kind: 'card', cardId: card.id });
  }, []);

  useEffect(
    () =>
      events.on((e) => {
        scene.current?.onEvent(e);
        switch (e.kind) {
          case 'cardArrived':
            uiFx.emit({ kind: 'toast', text: `NEW OFFER FROM ${e.card.from.toUpperCase()}: OPEN IT FROM THE CARD LIST` });
            audio.play('17-card', { volume: 0.5 });
            break;
          case 'haggle':
            setCardState((cur) => (cur && cur.card.id === e.card.id ? { card: e.card, result: null, mood: e.mood } : cur));
            break;
          case 'cardResolved':
            if (e.auto) uiFx.emit({ kind: 'toast', text: `THE CLERK TOOK ${e.card.from.toUpperCase()}'S OFFER: +${(e.totalMilli / 1000).toFixed(2)}` });
            setCardState((cur) => (cur && cur.card.id === e.card.id ? { card: e.card, result: { outcome: e.outcome, totalMilli: e.totalMilli }, mood: null } : cur));
            break;
          case 'sold':
            uiFx.emit({ kind: 'stamp', row: 'sold', coins: e.totalMilli / 1000 });
            break;
          case 'machineBroke':
            uiFx.emit({ kind: 'toast', text: `YOUR ${MACHINE_NAME[e.unlock]} BROKE DOWN. TAP IT TO REPAIR IT.`, tone: 'bad' });
            break;
          case 'machineRepaired':
            uiFx.emit({ kind: 'toast', text: `${MACHINE_NAME[e.unlock]} REPAIRED: -${(e.costMilli / 1000).toFixed(2)}` });
            break;
          case 'refused':
            // a refused farm name is explained on the naming screen itself
            if (e.code !== 'bad_message' && !e.code.startsWith('name_')) uiFx.emit({ kind: 'toast', text: REFUSALS[e.code] ?? 'SOMETHING WENT WRONG', tone: 'bad' });
            audio.play('35-back', { volume: 0.6 });
            break;
          case 'dayEnded': {
            // every card closes with its day
            const m = ui.get().modal;
            if (m?.kind === 'card') closeModal();
            const s = e.summary;
            uiFx.emit({ kind: 'toast', text: `DAY ${s.day} CLOSED: ${s.laid} LAID. PRICES TOMORROW ${Math.round(s.nextMultiplier * 100)}%${s.missed ? `. ${s.missed} DELIVERY MISSED` : ''}` });
            if (s.fedMultiplier === 0) {
              audio.play('29-alarm-bell', { delayMs: 800 });
              uiFx.emit({ kind: 'toast', text: 'THE TROUGH IS EMPTY: NO EGGS TOMORROW', tone: 'bad' });
            }
            break;
          }
          // a mint the minting moment is showing is its own; any other (a catch-up at a day close) gets the reveal
          case 'featherMinted':
            if (!mintingNow(e.ticketId)) reveals.current.push({ ticketId: e.ticketId, number: e.number, grade: e.grade, milestone: e.milestone, txHash: e.txHash, day: e.day });
            break;
          case 'mintFailed':
            if (!mintingNow(e.ticketId)) uiFx.emit({ kind: 'toast', tone: 'bad', text: `A FEATHER MINT DID NOT GO THROUGH: YOUR TICKET AND ${(e.refundMilli / 1000).toFixed(0)} COINS ARE BACK. MINT IT AGAIN FROM THE MINT.` });
            break;
          case 'mintWaiting':
            if (!mintingNow(e.ticketId)) uiFx.emit({ kind: 'toast', text: `A FEATHER MINT WAITS: ${e.note.toUpperCase()}` });
            break;
          case 'milestoneRoll': {
            const what = MILESTONE_TEXT[e.milestone];
            const next = e.next ? ` NEXT: ${MILESTONE_TEXT[e.next]}.` : '';
            if (e.won) {
              audio.play('19-haggle-win', { volume: 0.7 });
              uiFx.emit({ kind: 'toast', tone: 'good', text: `MILESTONE: ${what}! YOU WON A FEATHER TICKET. MINT IT IN THE FEATHER MINT. ${e.left} OF ${ECONOMY.feathers.maxSupply} FEATHERS LEFT.` });
            } else {
              uiFx.emit({
                kind: 'toast',
                text: `MILESTONE: ${what}. NO TICKET THIS TIME (A ${Math.round(e.odds * 100)}% CHANCE), BUT WELL FARMED.${next}`,
              });
            }
            break;
          }
          case 'contractDelivered':
            uiFx.emit({ kind: 'coins', from: worldToUi({ x: 444, y: 280 }), count: 4 });
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
        <div className="toast" style={{ position: 'absolute', left: 220, top: 170, width: 200, textAlign: 'center' }}>
          {status === 'offline' ? 'RECONNECTING TO THE MARKET' : 'WALKING TO THE FARM'}
        </div>
      </div>
    );
  }

  const z = v.zones;
  const ctx = { modal, farm, market };
  const card = modal?.kind === 'card' ? (cardState?.card.id === modal.cardId ? cardState.card : farm.cards.find((c) => c.id === modal.cardId)) : null;
  const hen = modal?.kind === 'hen' ? farm.hens.find((h) => h.id === modal.henId) : null;

  return (
    <div className="layer">
      <TopBar
        farm={farm}
        rect={z.top}
        onShop={() => openModal({ kind: 'shop', tab: 'hens' })}
        onSettings={() => openModal({ kind: 'settings' })}
        onMarket={() => openModal({ kind: 'market', tab: 'board' })}
        onLedger={() => openModal({ kind: 'ledger' })}
        onHelp={() => openModal({ kind: 'guide' })}
        onFeathers={() => openModal({ kind: 'feathers' })}
        onProfile={() => openModal({ kind: 'profile', tab: 'overview' })}
      />
      {!(v.portrait && modal) && <SidePanel farm={farm} market={market} rect={z.side} send={send} onOpen={openCard} />}
      <ToastArea farm={farm} rect={z.toasts} offline={status === 'offline'} />
      <Tracker farm={farm} rect={z.tracker} send={send} />
      {touring && <TourBox ctx={ctx} send={send} />}
      {modal?.kind === 'shop' && (
        <ShopPanel
          farm={farm}
          send={send}
          tab={modal.tab}
          onTab={(tab) => ui.set({ modal: { kind: 'shop', tab } })}
          onMachine={(unlock) => openModal({ kind: 'machine', unlock })}
          onClose={closeModal}
        />
      )}
      {modal?.kind === 'ledger' && <LedgerPanel farm={farm} send={send} onClose={closeModal} />}
      {modal?.kind === 'sell' && <SellPanel farm={farm} market={market} send={send} onClose={closeModal} />}
      {modal?.kind === 'machine' && <MachinePanel unlock={modal.unlock} farm={farm} send={send} onShop={() => openModal({ kind: 'shop', tab: 'machines' })} onClose={closeModal} />}
      {modal?.kind === 'hen' && hen && <HenPanel hen={hen} onClose={closeModal} />}
      {modal?.kind === 'reveal' && (
        <RevealPanel reveal={modal} market={market} onLedger={() => openModal({ kind: 'ledger' })} onMintPage={() => openModal({ kind: 'feathers' })} onClose={closeModal} />
      )}
      {modal?.kind === 'feathers' && (
        <FeatherMint farm={farm} market={market} onMint={startMint} onSignIn={null} onClose={closeModal} closeLabel="BACK TO THE FARM" />
      )}
      {modal?.kind === 'profile' && (
        <ProfilePage
          farm={farm}
          market={market}
          profile={profile}
          tab={modal.tab}
          onTab={(tab) => ui.set({ modal: { kind: 'profile', tab } })}
          onPublic={(farmId) => openModal({ kind: 'publicProfile', farmId, back: modal.tab })}
          onMint={() => openModal({ kind: 'feathers' })}
          onClose={closeModal}
        />
      )}
      {modal?.kind === 'publicProfile' && (
        <PublicProfileModal key={modal.farmId} farmId={modal.farmId} onClose={() => (modal.back ? openModal({ kind: 'profile', tab: modal.back }) : closeModal())} />
      )}
      {modal?.kind === 'minting' && (
        <MintMoment
          key={`${modal.ticketId}-${modal.attempt}`}
          ticketId={modal.ticketId}
          explorer={market.explorer}
          onRetry={startMint}
          onLedger={() => openModal({ kind: 'ledger' })}
          onClose={() => openModal({ kind: 'feathers' })}
        />
      )}
      {modal?.kind === 'market' && (
        <MarketBoard
          farm={farm}
          market={market}
          send={send}
          tab={modal.tab}
          onTab={(tab) => ui.set({ modal: { kind: 'market', tab } })}
          onFeathers={() => openModal({ kind: 'feathers' })}
          onClose={closeModal}
        />
      )}
      {modal?.kind === 'card' && card && (
        <CardOverlay
          key={card.id}
          card={card}
          result={cardState?.card.id === card.id ? cardState.result : null}
          haggleMood={cardState?.card.id === card.id ? cardState.mood : null}
          send={send}
          onClose={closeModal}
        />
      )}
      {modal?.kind === 'settings' && (
        <Modal title="SETTINGS" onClose={closeModal} w={400} h={420}>
          <SettingsBody
            onClose={closeModal}
            onGuide={() => openModal({ kind: 'guide' })}
            farm={farm}
            onRename={() => openModal({ kind: 'name', mode: 'rename' })}
            onProfile={() => openModal({ kind: 'profile', tab: 'overview' })}
          />
        </Modal>
      )}
      {modal?.kind === 'guide' && <HowToPlay onClose={closeModal} />}
      {modal?.kind === 'name' && farm && <NameFarm farm={farm} mode={modal.mode} send={send} onClose={closeModal} />}
      {touring && <Spotlight ctx={ctx} />}
      <BadgeMoments />
      <FxLayer />
    </div>
  );
}

