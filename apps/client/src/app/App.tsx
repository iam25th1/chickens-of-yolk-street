// Screen flow: boot loading, title, login, farm loading, farm. PLAY opens a guest farm at once (no
// sign-in); SIGN IN is for returning players, and a guest's SAVE THIS FARM signs in with the farm
// carried along. Settings opens over any screen. The Feather Mint has its own address (/mint): it
// opens straight from the boot, or from the title, without entering the farm; signing in from it goes
// to the farm with the mint open.
import { useCallback, useEffect, useRef, useState } from 'react';
import { AssetStore } from '../assets/store';
import { BOOT_GROUPS, BOOT_SOUNDS, FARM_GROUPS, FARM_SOUNDS, LATER_GROUPS, TITLE_GROUPS } from '../assets/catalog';
import { AudioEngine } from '../audio/audio';
import { motion } from '../motion/ui';
import { GUEST_SESSION, GuestLimitError, api, sessionStore, type ServerConfigView } from '../net/api';
import { BackdropScene } from '../pixi/BackdropScene';
import { PixiHost } from '../pixi/host';
import { FarmScreen } from '../screens/FarmScreen';
import { LoadingScreen } from '../screens/LoadingScreen';
import { GuestLimitScreen, LoginScreen, type SignedIn } from '../screens/LoginScreen';
import { TitleScreen } from '../screens/TitleScreen';
import { FeatherMint } from '../ui/FeatherMint';
import { OPEN_MINT_KEY } from '../state/ui';
import { settings } from '../state/settings';
import { Ticker } from '../ui/Hud';
import { HowToPlay } from '../ui/HowToPlay';
import { SettingsPanel } from '../ui/Panels';
import { UpdatePrompt } from '../ui/UpdatePrompt';
import { ServicesContext, type Services } from './services';
import { Stage, useViewport } from './Stage';
import { viewport } from './viewport';

type Screen = 'boot' | 'title' | 'mint' | 'login' | 'guestLimit' | 'loadingFarm' | 'farm';

/** The Feather Mint's own address. */
const MINT_PATH = '/mint';


const FONTS = ['16px "Pixelify Sans"', '8px Silkscreen', 'bold 8px Silkscreen'];

export function App() {
  const vp = useViewport();
  const [services, setServices] = useState<Services | null>(null);
  const [screen, setScreen] = useState<Screen>('boot');
  const [progress, setProgress] = useState(0);
  const [config, setConfig] = useState<ServerConfigView | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [audioReady, setAudioReady] = useState(false);
  const [signedIn, setSignedIn] = useState<{ session: string; accountId: string | null } | null>(null);
  /** The login screen was opened from a guest farm (SAVE THIS FARM): BACK returns to it. */
  const [fromGuest, setFromGuest] = useState(false);
  const [guestLimit, setGuestLimit] = useState<'ip' | 'hour'>('ip');
  const [cursor, setCursor] = useState<string | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const screenEl = useRef<HTMLDivElement>(null);

  // boot: Pixi, the asset index, the loading backdrop, then everything the title needs
  const onMount = useCallback((el: HTMLDivElement) => {
    void (async () => {
      try {
        const [pixi, assets, cfg] = await Promise.all([PixiHost.create(el), AssetStore.load(), api.config()]);
        setConfig(cfg);
        const audio = new AudioEngine(assets.index);
        audio.setLevels(settings.get().sound);
        const v0 = viewport.get();
        // stage 1: the loading screen's own art (a few KB), on screen at once
        await assets.loadGroups([...BOOT_GROUPS], v0.p);
        pixi.setScene(new BackdropScene(assets, 'loading'));
        // the page's own loading screen (index.html) hands over to the game's
        document.getElementById('boot')?.remove();
        setServices({ assets, audio, pixi });
        // stage 2: the title (art and fonts); the button clicks follow, music streams after the first tap
        const total = TITLE_GROUPS.length + FONTS.length;
        let done = 0;
        const tick = () => setProgress(++done / total);
        await Promise.all([assets.loadGroups([...TITLE_GROUPS], v0.p, { onEach: tick }), ...FONTS.map((f) => document.fonts.load(f).then(tick, tick))]);
        // the mint's own address opens the mint (it needs the card art)
        if (location.pathname === MINT_PATH) await assets.loadGroups(['cards'], v0.p).catch(() => undefined);
        setScreen(location.pathname === MINT_PATH ? 'mint' : 'title');
        void audio.load(BOOT_SOUNDS).catch(() => undefined);
        // stage 3 starts now: the farm's art downloads while the player reads the title
        void assets.loadGroups([...FARM_GROUPS], viewport.get().farm.k, { quick: true }).catch(() => undefined);
      } catch (e) {
        setFatal(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  // a new window density brings the matching atlases for the groups already loaded (sprites keep
  // drawing meanwhile); it never starts a group early
  useEffect(() => {
    if (!services) return;
    services.assets.retarget({ farm: vp.farm.k, fx: vp.farm.k }, vp.p);
  }, [services, vp.p, vp.farm.k]);

  // pixel cursor from 34-cursor: each art pixel p device pixels
  const cursorPx = Math.min(128, Math.max(16, Math.round((16 * vp.p) / vp.dpr)));
  useEffect(() => {
    if (!services) return;
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      const size = cursorPx;
      c.width = size;
      c.height = size;
      const ctx = c.getContext('2d');
      if (!ctx) return;
      ctx.imageSmoothingEnabled = false;
      const r = services.assets.frameRects('34-cursor', 'default')[0];
      if (!r) return;
      ctx.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, size, size);
      setCursor(`url(${c.toDataURL()}) ${Math.round(size * 0.2)} ${Math.round(size * 0.12)}, auto`);
    };
    img.src = services.assets.url('34-cursor');
  }, [services, cursorPx]);

  useEffect(() => {
    if (screenEl.current) motion.slideIn(screenEl.current, 'up');
  }, [screen]);

  const unlockAudio = () => {
    if (!services || audioReady) return;
    services.audio.unlock();
    void services.audio.ctx.resume().then(() => setAudioReady(true));
  };

  const openMint = () => {
    unlockAudio();
    if (location.pathname !== MINT_PATH) history.pushState(null, '', MINT_PATH);
    void services?.assets.loadGroups(['cards'], viewport.get().p).catch(() => undefined);
    setScreen('mint');
  };
  const leaveMint = () => {
    if (location.pathname === MINT_PATH) history.pushState(null, '', '/');
    setScreen('title');
  };
  // the mint's own tab title
  useEffect(() => {
    const base = 'Chickens of Yolk Street (Beta): an egg farm in a market of players and AI';
    document.title = screen === 'mint' ? 'Feather Mint: Chickens of Yolk Street (Beta)' : base;
  }, [screen]);
  // the browser's back and forward move between the title and the mint
  useEffect(() => {
    const onPop = () => setScreen((s) => (s === 'title' && location.pathname === MINT_PATH ? 'mint' : s === 'mint' && location.pathname !== MINT_PATH ? 'title' : s));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const play = () => {
    unlockAudio();
    if (location.pathname === MINT_PATH) history.pushState(null, '', '/');
    // a local recording server (DEMO_MODE) signs straight into a demo farm: no login screen is shown
    const demo = new URLSearchParams(location.search).get('demo');
    if (demo && config?.demoSession) {
      void api
        .loginDemo(demo)
        .then((login) => {
          sessionStore.set(login.session);
          setSignedIn({ session: login.session, accountId: null });
          setScreen('loadingFarm');
        })
        .catch((e: unknown) => setFatal(e instanceof Error ? e.message : String(e)));
      return;
    }
    // a returning player's session opens their farm; anyone else plays at once as a guest
    const session = sessionStore.get();
    if (session) {
      setSignedIn({ session, accountId: null });
      setScreen('loadingFarm');
      return;
    }
    if (!config?.guestPlay) {
      setFromGuest(false);
      setScreen('login');
      return;
    }
    void api
      .loginGuest()
      .then(() => {
        setSignedIn({ session: GUEST_SESSION, accountId: null });
        setScreen('loadingFarm');
      })
      .catch((e: unknown) => {
        if (e instanceof GuestLimitError) {
          setGuestLimit(e.limit);
          setScreen('guestLimit');
        } else setFatal(e instanceof Error ? e.message : String(e));
      });
  };

  /** SIGN IN (returning players): their farm if this browser still has their session, else the sign-in. */
  const signIn = () => {
    unlockAudio();
    if (location.pathname === MINT_PATH) history.pushState(null, '', '/');
    const session = sessionStore.get();
    if (session) {
      setSignedIn({ session, accountId: null });
      setScreen('loadingFarm');
      return;
    }
    setFromGuest(false);
    setScreen('login');
  };

  /** A guest saves the farm: the sign-in, with the farm carried into the account. */
  const saveFarm = useCallback(() => {
    setFromGuest(true);
    setScreen('login');
  }, []);

  // farm loading: the jingle plays while the farm's art and sound arrive
  useEffect(() => {
    if (screen !== 'loadingFarm' || !services) return;
    const { assets, audio, pixi } = services;
    pixi.setScene(new BackdropScene(assets, 'loading'));
    // quiet while the farm downloads: music would take the line the farm's art needs
    audio.playMusic(null, 300);
    setProgress(0);
    let done = 0;
    const tick = () => setProgress(++done / FARM_GROUPS.length);
    const v = viewport.get();
    void assets
      .loadGroups([...FARM_GROUPS], v.farm.k, { quick: true, onEach: tick })
      .then(() => {
        setTimeout(() => setScreen('farm'), 250);
        // the sharp farm first; sounds and the other screens' art a few seconds after it, so nothing
        // shares the line with the farm while it opens
        void assets
          .loadGroups([...FARM_GROUPS], v.farm.k)
          .catch(() => undefined)
          .then(() => new Promise((r) => setTimeout(r, 3000)))
          .then(() => audio.load(FARM_SOUNDS).catch(() => undefined))
          .then(() => assets.loadGroups([...LATER_GROUPS], viewport.get().p).catch(() => undefined));
      })
      .catch((e: unknown) => setFatal(e instanceof Error ? e.message : String(e)));
  }, [screen, services]);

  const onSignedIn = (s: SignedIn) => {
    setSignedIn({ session: s.login.session, accountId: s.accountId });
    setScreen('loadingFarm');
  };

  const signOut = useCallback(() => {
    // a guest whose farm is gone (moved to an account, or bust) goes back to the title
    if (signedIn?.session === GUEST_SESSION) {
      setSignedIn(null);
      setScreen('title');
      return;
    }
    sessionStore.set(null);
    setSignedIn(null);
    setScreen('login');
  }, [signedIn]);

  return (
    <Stage onMount={onMount} cursor={cursor} onPointerDown={unlockAudio}>
      {services && (
        <ServicesContext.Provider value={services}>
          <div ref={screenEl} className="layer">
            {screen !== 'farm' && screen !== 'mint' && (
              <div className="stage640">
                {screen === 'boot' && <LoadingScreen progress={progress} label="WAKING THE HENS" />}
                {screen === 'title' && <TitleScreen audioReady={audioReady} onPlay={play} onSignIn={signIn} onMint={openMint} onSettings={() => setSettingsOpen(true)} />}
                {screen === 'login' && config && (
                  <LoginScreen
                    privyAppId={config.privyAppId}
                    devLogin={config.devLogin}
                    fromGuest={fromGuest && signedIn?.session === GUEST_SESSION}
                    onSignedIn={onSignedIn}
                    onBack={() => setScreen(fromGuest && signedIn?.session === GUEST_SESSION ? 'loadingFarm' : 'title')}
                  />
                )}
                {screen === 'guestLimit' && <GuestLimitScreen limit={guestLimit} onSignIn={signIn} onBack={() => setScreen('title')} />}
                {screen === 'loadingFarm' && <LoadingScreen progress={progress} label="LOADING THE FARM" />}
              </div>
            )}
            {screen === 'mint' && (
              <div className="layer">
                <FeatherMint
                  farm={null}
                  market={null}
                  onMint={null}
                  onSignIn={() => {
                    sessionStorage.setItem(OPEN_MINT_KEY, '1');
                    signIn();
                  }}
                  onClose={leaveMint}
                  closeLabel="TITLE"
                />
              </div>
            )}
            {/* the title's live prices run along the whole window's foot */}
            {screen === 'title' && <Ticker />}
            {screen === 'farm' && signedIn && (
              <FarmScreen session={signedIn.session} accountId={signedIn.accountId} onSignedOut={signOut} onSave={saveFarm} />
            )}
          </div>
          {guideOpen && screen !== 'farm' && (
            <div className="layer" style={{ zIndex: 65 }}>
              <HowToPlay onClose={() => setGuideOpen(false)} />
            </div>
          )}
          {/* a deploy while the page was open: offer the new version */}
          <div className="stage640" style={{ zIndex: 75, pointerEvents: 'none' }}>
            <UpdatePrompt />
          </div>
          {settingsOpen && (
            <div className="stage640" style={{ zIndex: 60 }}>
              <SettingsPanel
                onClose={() => setSettingsOpen(false)}
                onGuide={() => {
                  setSettingsOpen(false);
                  setGuideOpen(true);
                }}
              />
            </div>
          )}
        </ServicesContext.Provider>
      )}
      {fatal && (
        <div className="stage640" style={{ zIndex: 70 }}>
          <div className="panel" role="alert" style={{ left: 160, top: 140, width: 320 }}>
            <h2 className="panel-title">THE FARM DID NOT OPEN</h2>
            <span>{fatal.toUpperCase()}</span>
          </div>
        </div>
      )}
    </Stage>
  );
}
