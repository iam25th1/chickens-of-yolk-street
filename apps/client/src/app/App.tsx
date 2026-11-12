// Screen flow: boot loading, title, login, farm loading, farm. Settings opens over any screen.
import { useCallback, useEffect, useRef, useState } from 'react';
import { AssetStore } from '../assets/store';
import { BOOT_GROUPS, BOOT_SOUNDS, FARM_GROUPS, FARM_SOUNDS, LATER_GROUPS, TITLE_GROUPS } from '../assets/catalog';
import { AudioEngine } from '../audio/audio';
import { motion } from '../motion/ui';
import { api, sessionStore, type ServerConfigView } from '../net/api';
import { BackdropScene } from '../pixi/BackdropScene';
import { PixiHost } from '../pixi/host';
import { FarmScreen } from '../screens/FarmScreen';
import { LoadingScreen } from '../screens/LoadingScreen';
import { LoginScreen, type SignedIn } from '../screens/LoginScreen';
import { TitleScreen } from '../screens/TitleScreen';
import { settings } from '../state/settings';
import { SettingsPanel } from '../ui/Panels';
import { ServicesContext, type Services } from './services';
import { Stage, useViewport } from './Stage';
import { viewport } from './viewport';

type Screen = 'boot' | 'title' | 'login' | 'loadingFarm' | 'farm';

const FONTS = ['16px "Pixelify Sans"', '8px Silkscreen', 'bold 8px Silkscreen'];

export function App() {
  const vp = useViewport();
  const [services, setServices] = useState<Services | null>(null);
  const [screen, setScreen] = useState<Screen>('boot');
  const [progress, setProgress] = useState(0);
  const [config, setConfig] = useState<ServerConfigView | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [audioReady, setAudioReady] = useState(false);
  const [signedIn, setSignedIn] = useState<{ session: string; accountId: string | null } | null>(null);
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
        audio.setVolumes(settings.get().music, settings.get().sfx);
        const v0 = viewport.get();
        // stage 1: the loading screen's own art (a few KB), on screen at once
        await assets.loadGroups([...BOOT_GROUPS], v0.p);
        pixi.setScene(new BackdropScene(assets, 'loading'));
        // the page's own loading screen (index.html) hands over to the game's
        document.getElementById('boot')?.remove();
        setServices({ assets, audio, pixi });
        // stage 2: the title (art, fonts, the button clicks); music streams after the first tap
        const total = TITLE_GROUPS.length + FONTS.length + 1;
        let done = 0;
        const tick = () => setProgress(++done / total);
        await Promise.all([
          assets.loadGroups([...TITLE_GROUPS], v0.p, { onEach: tick }),
          audio.load(BOOT_SOUNDS, () => undefined).then(tick, tick),
          ...FONTS.map((f) => document.fonts.load(f).then(tick, tick)),
        ]);
        setScreen('title');
        // stage 3 starts now: the farm's art downloads while the player reads the title
        void assets.loadGroups([...FARM_GROUPS], viewport.get().farm.k, { quick: true }).catch(() => undefined);
      } catch (e) {
        setFatal(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  // a new window density brings the matching atlases (sprites keep drawing meanwhile)
  useEffect(() => {
    if (!services || screen === 'boot') return;
    void services.assets.loadGroups([...TITLE_GROUPS, ...LATER_GROUPS], vp.p).catch(() => undefined);
    void services.assets.loadGroups([...FARM_GROUPS], vp.farm.k, { quick: true }).catch(() => undefined);
  }, [services, screen, vp.p, vp.farm.k]);

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

  const play = () => {
    unlockAudio();
    const session = sessionStore.get();
    if (session) {
      setSignedIn({ session, accountId: null });
      setScreen('loadingFarm');
    } else setScreen('login');
  };

  // farm loading: the jingle plays while the farm's art and sound arrive
  useEffect(() => {
    if (screen !== 'loadingFarm' || !services) return;
    const { assets, audio, pixi } = services;
    pixi.setScene(new BackdropScene(assets, 'loading'));
    audio.playMusic('44-jingle', 300);
    setProgress(0);
    let done = 0;
    const tick = () => setProgress(++done / FARM_GROUPS.length);
    const v = viewport.get();
    void assets
      .loadGroups([...FARM_GROUPS], v.farm.k, { quick: true, onEach: tick })
      .then(() => {
        setTimeout(() => setScreen('farm'), 250);
        // sounds and the other screens' art arrive in the background; nothing waits for them
        void audio.load(FARM_SOUNDS).catch(() => undefined);
        void assets.loadGroups([...LATER_GROUPS], v.p).catch(() => undefined);
      })
      .catch((e: unknown) => setFatal(e instanceof Error ? e.message : String(e)));
  }, [screen, services]);

  const onSignedIn = (s: SignedIn) => {
    setSignedIn({ session: s.login.session, accountId: s.accountId });
    setScreen('loadingFarm');
  };

  const signOut = useCallback(() => {
    sessionStore.set(null);
    setSignedIn(null);
    setScreen('login');
  }, []);

  return (
    <Stage onMount={onMount} cursor={cursor} onPointerDown={unlockAudio}>
      {services && (
        <ServicesContext.Provider value={services}>
          <div ref={screenEl} className="layer">
            {screen !== 'farm' && (
              <div className="stage640">
                {screen === 'boot' && <LoadingScreen progress={progress} label="WAKING THE HENS" />}
                {screen === 'title' && <TitleScreen audioReady={audioReady} onPlay={play} onSettings={() => setSettingsOpen(true)} />}
                {screen === 'login' && config && (
                  <LoginScreen privyAppId={config.privyAppId} devLogin={config.devLogin} onSignedIn={onSignedIn} onBack={() => setScreen('title')} />
                )}
                {screen === 'loadingFarm' && <LoadingScreen progress={progress} label="LOADING THE FARM" />}
              </div>
            )}
            {screen === 'farm' && signedIn && (
              <FarmScreen session={signedIn.session} accountId={signedIn.accountId} onSignedOut={signOut} />
            )}
          </div>
          {settingsOpen && (
            <div className="stage640" style={{ zIndex: 60 }}>
              <SettingsPanel onClose={() => setSettingsOpen(false)} />
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
