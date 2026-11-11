// The farm: the world on the canvas, the HUD, the card tray and the shop. Server state flows in
// through the socket; player choices go out as actions and come back as events with juice.
import { useCallback, useEffect, useRef, useState } from 'react';
import { isCrash } from '@coys/shared';
import { useServices } from '../app/services';
import { GameSocket, type Action } from '../net/socket';
import { FarmScene } from '../pixi/farm/FarmScene';
import { events, game } from '../state/game';
import { useStore } from '../state/store';
import { FeedCard, GlutCard, SellCard } from '../ui/Cards';
import { FxLayer, uiFx } from '../ui/FxLayer';
import { Ticker, TopBar } from '../ui/Hud';
import { ShopPanel } from '../ui/Panels';

const REFUSALS: Record<string, string> = {
  insufficient_funds: 'NOT ENOUGH COINS',
  insufficient_stock: 'NOT ENOUGH EGGS',
  rate_limited: 'EASY THERE, ONE THING AT A TIME',
  invalid_action: 'CANNOT DO THAT RIGHT NOW',
  farm_bust: 'THIS FARM IS BUST',
};

export function FarmScreen({
  session,
  accountId,
  onSignedOut,
  onSettings,
}: {
  session: string;
  accountId: string | null;
  onSignedOut: () => void;
  onSettings: () => void;
}) {
  const { assets, audio, pixi } = useServices();
  const farm = useStore(game, (s) => s.farm);
  const market = useStore(game, (s) => s.market);
  const status = useStore(game, (s) => s.status);
  const [shop, setShop] = useState(false);
  const socket = useRef<GameSocket | null>(null);
  const scene = useRef<FarmScene | null>(null);
  const linked = useRef(false);

  const send = useCallback(async (a: Action): Promise<boolean> => {
    const ack = await socket.current?.send(a);
    return Boolean(ack?.ok);
  }, []);

  // connect
  useEffect(() => {
    const s = new GameSocket(session);
    socket.current = s;
    s.connect();
    return () => {
      s.close();
      socket.current = null;
      game.set({ status: 'idle', farm: null });
    };
  }, [session]);

  useEffect(() => {
    if (status === 'unauthenticated') onSignedOut();
    if (status === 'online' && accountId && !linked.current) {
      linked.current = true;
      void send({ t: 'linkWallet', accountId });
    }
  }, [status, accountId, onSignedOut, send]);

  // world: created once the first farm state arrives
  useEffect(() => {
    if (!farm || scene.current) return;
    const s = new FarmScene(assets, audio, pixi.app.renderer, {
      collect: (eggId) => send({ t: 'collect', eggId }),
      coins: (from, count) => uiFx.emit({ kind: 'coins', from, count }),
    });
    scene.current = s;
    s.sync(farm);
    pixi.setScene(s);
  }, [farm, assets, audio, pixi, send]);

  useEffect(() => () => pixi.setScene(null), [pixi]);
  useEffect(() => {
    if (farm) scene.current?.sync(farm);
  }, [farm]);

  // music follows the market: tension while it has crashed
  const crashed = market ? isCrash(market.multiplier) : false;
  useEffect(() => {
    audio.playMusic(crashed ? '43-market-tension' : '42-farm-day', 1200);
  }, [audio, crashed]);

  // events: juice in the world, stamps and toasts in the UI
  useEffect(
    () =>
      events.on((e) => {
        scene.current?.onEvent(e);
        switch (e.kind) {
          case 'sold':
            uiFx.emit({ kind: 'stamp', row: 'sold', coins: e.totalMilli / 1000 });
            break;
          case 'refused':
            if (e.code !== 'bad_message') uiFx.emit({ kind: 'toast', text: REFUSALS[e.code] ?? 'SOMETHING WENT WRONG', tone: 'bad' });
            audio.play('35-back', { volume: 0.6 });
            break;
          case 'dayEnded': {
            const s = e.summary;
            uiFx.emit({ kind: 'toast', text: `DAY ${s.day}: ${s.laid} LAID, ${s.broken} BROKEN. MARKET X${s.nextMultiplier.toFixed(2)}` });
            if (s.fedMultiplier === 0) {
              audio.play('29-alarm-bell', { delayMs: 800 });
              uiFx.emit({ kind: 'toast', text: 'THE TROUGH IS EMPTY: NO EGGS TOMORROW', tone: 'bad' });
            }
            break;
          }
          case 'rivalBust':
            uiFx.emit({ kind: 'toast', text: `${e.name.toUpperCase()} WENT BUST. ${e.hens} HENS AT AUCTION` });
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
      <div className="layer">
        <div className="toast" style={{ position: 'absolute', left: 254, top: 170 }}>
          {status === 'offline' ? 'RECONNECTING TO THE MARKET' : 'WALKING TO THE FARM'}
        </div>
      </div>
    );
  }

  return (
    <div className="layer">
      <TopBar farm={farm} onShop={() => setShop(true)} onSettings={onSettings} />
      <div className="tray">
        <SellCard farm={farm} market={market} send={send} />
        <FeedCard farm={farm} send={send} />
        {market.crash && <GlutCard market={market} />}
      </div>
      <Ticker extra={[farm.name.toUpperCase()]} />
      {status === 'offline' && (
        <div className="toast" style={{ position: 'absolute', left: 190, top: 300 }}>
          RECONNECTING TO THE MARKET
        </div>
      )}
      {shop && <ShopPanel farm={farm} send={send} onClose={() => setShop(false)} />}
      <FxLayer />
    </div>
  );
}
