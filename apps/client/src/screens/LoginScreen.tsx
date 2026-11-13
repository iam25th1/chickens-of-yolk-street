// Login. With PRIVY_APP_ID set: email sign-in through Privy, and the player's farm account is made
// quietly in the background. Without it: a clearly labelled local dev login, so the game stays
// playable. No wallet or chain words appear here.
import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { uiSound, useServices } from '../app/services';
import { motion } from '../motion/ui';
import { api, sessionStore, type LoginResult } from '../net/api';
import { BackdropScene } from '../pixi/BackdropScene';

const PrivyLogin = lazy(() => import('../login/PrivyLogin'));

export interface SignedIn {
  login: LoginResult;
  /** Account made silently by Privy, linked after the farm connects. */
  accountId: string | null;
}

export function LoginScreen({ privyAppId, devLogin, onSignedIn, onBack }: { privyAppId: string | null; devLogin: boolean; onSignedIn: (s: SignedIn) => void; onBack: () => void }) {
  const { assets, audio, pixi } = useServices();
  const panel = useRef<HTMLDivElement>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      const login = await api.loginDev(name.trim(), sessionStore.deviceId());
      sessionStore.set(login.session);
      onSignedIn({ login, accountId: null });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not sign in');
      setBusy(false);
    }
  };

  return (
    <div className="layer">
      <div ref={panel} className="panel" style={{ left: 184, top: 76, width: 272, height: 200 }}>
        <h2 className="panel-title">START YOUR FARM</h2>
        <div className="col" style={{ gap: 8 }}>
          <span>ONE MARKET. FARMS ARE RUN BY PLAYERS AND BY AI; SUPPLIERS AND BUYERS ARE AI. YOUR EGGS SET THE PRICE.</span>
          {privyAppId && (
            <Suspense fallback={<span>OPENING SIGN-IN</span>}>
              <PrivyLogin
                appId={privyAppId}
                onSignedIn={(s) => {
                  sessionStore.set(s.login.session);
                  onSignedIn(s);
                }}
                onError={setError}
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
