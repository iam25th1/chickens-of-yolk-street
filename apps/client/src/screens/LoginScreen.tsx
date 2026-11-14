// Login. With PRIVY_APP_ID set: email sign-in through Privy, and the player's farm account is made
// quietly in the background. Without it: a clearly labelled local dev login, so the game stays
// playable. From a guest farm (SAVE THIS FARM) the farm comes along; when the account already has a
// farm the player chooses which one to keep, and the other is retired.
import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { uiSound, useServices } from '../app/services';
import { motion } from '../motion/ui';
import { api, sessionStore, type ChooseFarm, type FarmChoiceView, type LoginResult } from '../net/api';
import { BackdropScene } from '../pixi/BackdropScene';

const PrivyLogin = lazy(() => import('../login/PrivyLogin'));

export interface SignedIn {
  login: LoginResult;
  /** Account made silently by Privy, linked after the farm connects. */
  accountId: string | null;
}

export function LoginScreen({
  privyAppId,
  devLogin,
  onSignedIn,
  onBack,
  fromGuest = false,
}: {
  privyAppId: string | null;
  devLogin: boolean;
  onSignedIn: (s: SignedIn) => void;
  onBack: () => void;
  /** Opened from a guest farm's SAVE THIS FARM: the farm comes along. */
  fromGuest?: boolean;
}) {
  const { assets, audio, pixi } = useServices();
  const panel = useRef<HTMLDivElement>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [choice, setChoice] = useState<{ view: ChooseFarm['choose']; finish: (keep: 'guest' | 'account') => Promise<void> } | null>(null);

  useEffect(() => {
    pixi.setScene(new BackdropScene(assets, 'title'));
    if (panel.current) motion.enter(panel.current);
    return () => pixi.setScene(null);
  }, [assets, pixi]);

  const startDev = async () => {
    uiSound(audio, 'click');
    setBusy(true);
    setError(null);
    try {
      // a typed name names the farm (if it passes the rules); blank: a generated one, chosen after
      const deviceId = sessionStore.deviceId();
      const done = (login: LoginResult) => {
        sessionStore.set(login.session);
        onSignedIn({ login, accountId: null });
      };
      const login = await api.loginDev(name.trim(), deviceId);
      if ('choose' in login) {
        setChoice({
          view: login.choose,
          finish: async (keep) => {
            const again = await api.loginDev(name.trim(), deviceId, keep);
            if ('choose' in again) throw new Error('Could not sign in');
            done(again);
          },
        });
        setBusy(false);
        return;
      }
      done(login);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not sign in');
      setBusy(false);
    }
  };

  if (choice) {
    return (
      <div className="layer">
        <ChooseFarmPanel
          view={choice.view}
          onKeep={async (keep) => {
            await choice.finish(keep);
          }}
        />
      </div>
    );
  }

  return (
    <div className="layer">
      <div ref={panel} className="panel" style={{ left: 184, top: 76, width: 272, height: 200 }}>
        <h2 className="panel-title">{fromGuest ? 'SAVE YOUR FARM' : 'START YOUR FARM'}</h2>
        <div className="col" style={{ gap: 8 }}>
          <span>
            {fromGuest
              ? 'SIGN IN WITH YOUR EMAIL. THIS FARM AND EVERYTHING ON IT COMES WITH YOU, AND A NEAR WALLET IS MADE FOR YOU (NO SEED PHRASE).'
              : 'ONE MARKET. FARMS ARE RUN BY PLAYERS AND BY AI; SUPPLIERS AND BUYERS ARE AI. YOUR EGGS SET THE PRICE.'}
          </span>
          {privyAppId && (
            <Suspense fallback={<span>OPENING SIGN-IN</span>}>
              <PrivyLogin
                appId={privyAppId}
                onSignedIn={(s) => {
                  sessionStore.set(s.login.session);
                  onSignedIn(s);
                }}
                onError={setError}
                onChoose={(view, finish) => setChoice({ view, finish })}
              />
            </Suspense>
          )}
          {devLogin && (
            <div className="col" style={{ gap: 6 }}>
              <div className="row spread">
                <span className="devlabel">LOCAL DEV LOGIN</span>
                <span style={{ color: '#8b5a2b' }}>{privyAppId ? 'TESTING ONLY' : 'EMAIL SIGN-IN NOT SET UP'}</span>
              </div>
              <input
                className="field"
                placeholder="FARMER NAME"
                maxLength={20}
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void startDev();
                }}
                aria-label="Farmer name"
              />
              <button className="btn red" disabled={busy} onMouseEnter={() => uiSound(audio, 'hover')} onClick={() => void startDev()}>
                {busy ? 'OPENING THE GATE' : 'START FARMING'}
              </button>
            </div>
          )}
          {error && (
            <span role="alert" style={{ color: '#b8321f' }}>
              {error.toUpperCase()}
            </span>
          )}
          <button
            className="btn"
            style={{ alignSelf: 'flex-start' }}
            onMouseEnter={() => uiSound(audio, 'hover')}
            onClick={() => {
              uiSound(audio, 'back');
              onBack();
            }}
          >
            BACK
          </button>
        </div>
      </div>
    </div>
  );
}

const coins = (milli: number): string => (milli / 1000).toFixed(2);

/** The account already has a farm: keep one; the other is retired (it goes bust, its hens to auction). */
function ChooseFarmPanel({ view, onKeep }: { view: ChooseFarm['choose']; onKeep: (keep: 'guest' | 'account') => Promise<void> }) {
  const { audio } = useServices();
  const panel = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (panel.current) motion.enter(panel.current);
  }, []);
  const keep = (k: 'guest' | 'account') => () => {
    uiSound(audio, 'click');
    setBusy(true);
    setError(null);
    onKeep(k).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : 'Could not sign in');
      setBusy(false);
    });
  };
  const column = (label: string, f: FarmChoiceView, k: 'guest' | 'account') => (
    <div className="col" style={{ gap: 3, flex: 1, minWidth: 0 }} data-ui={`choose-${k}`}>
      <span style={{ color: '#8b5a2b' }}>{label}</span>
      <b style={{ overflowWrap: 'anywhere' }}>{f.name.toUpperCase()}</b>
      <span>{coins(f.cashMilli)} COINS</span>
      <span>
        {f.hens} HENS, {f.land} LAND PLOT{f.land === 1 ? '' : 'S'}
      </span>
      <span>
        {f.badges} BADGE{f.badges === 1 ? '' : 'S'}, {f.tickets} TICKET{f.tickets === 1 ? '' : 'S'}
      </span>
      <span>
        {f.days} DAY{f.days === 1 ? '' : 'S'} ON THE STREET
      </span>
      <button className="btn red" style={{ alignSelf: 'flex-start' }} disabled={busy} data-ui={`keep-${k}`} onMouseEnter={() => uiSound(audio, 'hover')} onClick={keep(k)}>
        KEEP THIS FARM
      </button>
    </div>
  );
  return (
    <div ref={panel} className="panel" data-ui="choose-farm" style={{ left: 150, top: 60, width: 340, height: 230 }}>
      <h2 className="panel-title">WHICH FARM DO YOU KEEP?</h2>
      <div className="col" style={{ gap: 8 }}>
        <span style={{ lineHeight: '10px' }}>YOUR ACCOUNT ALREADY HAS A FARM. KEEP ONE: THE OTHER IS RETIRED (IT GOES BUST AND ITS HENS GO TO THE AUCTION).</span>
        <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
          {column('THIS GUEST FARM', view.guest, 'guest')}
          {column("YOUR ACCOUNT'S FARM", view.account, 'account')}
        </div>
        {error && (
          <span role="alert" style={{ color: '#b8321f' }}>
            {error.toUpperCase()}
          </span>
        )}
      </div>
    </div>
  );
}

/** PLAY past the guest limits: a friendly stop that offers signing in instead. */
export function GuestLimitScreen({ limit, onSignIn, onBack }: { limit: 'ip' | 'hour'; onSignIn: () => void; onBack: () => void }) {
  const { assets, audio, pixi } = useServices();
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    pixi.setScene(new BackdropScene(assets, 'title'));
    if (panel.current) motion.enter(panel.current);
    return () => pixi.setScene(null);
  }, [assets, pixi]);
  return (
    <div className="layer">
      <div ref={panel} className="panel" data-ui="guest-limit" data-limit={limit} style={{ left: 184, top: 96, width: 272, height: 150 }}>
        <h2 className="panel-title">SIGN IN TO START ANOTHER FARM</h2>
        <div className="col" style={{ gap: 8 }}>
          <span style={{ lineHeight: '10px' }}>
            {limit === 'ip' ? 'THIS CONNECTION HAS STARTED ALL THE GUEST FARMS IT CAN TODAY.' : 'YOLK STREET HAS TAKEN ALL THE NEW GUEST FARMS IT CAN THIS HOUR.'} SIGN IN WITH YOUR EMAIL TO START A FARM NOW.
          </span>
          <div className="row" style={{ gap: 6 }}>
            <button
              className="btn red"
              data-ui="guest-limit-sign-in"
              onMouseEnter={() => uiSound(audio, 'hover')}
              onClick={() => {
                uiSound(audio, 'click');
                onSignIn();
              }}
            >
              SIGN IN
            </button>
            <button
              className="btn"
              onMouseEnter={() => uiSound(audio, 'hover')}
              onClick={() => {
                uiSound(audio, 'back');
                onBack();
              }}
            >
              BACK
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
