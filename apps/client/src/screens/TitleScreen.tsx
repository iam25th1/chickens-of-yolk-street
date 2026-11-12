// Title: the title plate (canvas), the logo stamping in then shining, the live price ticker,
// and Play and Settings.
import { animate } from 'animejs';
import { useEffect, useRef, useState } from 'react';
import { uiSound, useServices } from '../app/services';
import { juice } from '../motion/juice';
import { motion } from '../motion/ui';
import { api } from '../net/api';
import { BackdropScene } from '../pixi/BackdropScene';
import { game } from '../state/game';

export function TitleScreen({ onPlay, onSettings, audioReady }: { onPlay: () => void; onSettings: () => void; audioReady: boolean }) {
  const { assets, audio, pixi } = useServices();
  const buttons = useRef<HTMLDivElement>(null);
  const prompt = useRef<HTMLDivElement>(null);
  const [scene] = useState(() => new BackdropScene(assets, 'title'));

  useEffect(() => {
    pixi.setScene(scene);
    const logo = scene.showLogo(() => undefined);
    // stamp-in: slam from big, land with a thump and a little shake, then settle
    const k = { s: 2.2 };
    animate(k, {
      s: [2.2, 1],
      duration: 260,
      ease: 'inQuad',
      onUpdate: () => logo.squash(k.s, k.s),
      onComplete: () => {
        juice.shake(3, 260);
        audio.play('18-stamp');
        const b = { s: 0.86 };
        animate(b, { s: [0.86, 1], duration: 420, ease: 'outElastic(1, .45)', onUpdate: () => logo.squash(b.s, b.s) });
        if (buttons.current) motion.enter([...buttons.current.children], 120);
      },
    });
    return () => pixi.setScene(null);
  }, [audio, pixi, scene]);

  useEffect(() => {
    if (audioReady) audio.playMusic('41-title');
  }, [audio, audioReady]);

  useEffect(() => {
    if (prompt.current) motion.bob(prompt.current);
  }, []);

  // public market feed for the ticker
  useEffect(() => {
    let live = true;
    const load = () =>
      api
        .market()
        .then((m) => {
          if (live) game.set({ market: m.market, clock: m.clock, offset: m.clock.serverNow - Date.now() });
        })
        .catch(() => undefined);
    void load();
    const t = setInterval(load, 5000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  const press = (fn: () => void) => () => {
    uiSound(audio, 'click');
    fn();
  };

  return (
    <div className="layer">
      <div ref={buttons} style={{ position: 'absolute', left: 0, top: 266, width: 640, display: 'flex', justifyContent: 'center', gap: 12 }}>
        <button className="btn red big" style={{ height: 22, padding: '0 18px', opacity: 0 }} onMouseEnter={() => uiSound(audio, 'hover')} onClick={press(onPlay)}>
          PLAY
        </button>
        <button className="btn" style={{ height: 22, padding: '0 10px', opacity: 0 }} onMouseEnter={() => uiSound(audio, 'hover')} onClick={press(onSettings)}>
          SETTINGS
        </button>
      </div>
      {!audioReady && (
        <div ref={prompt} className="shadowed" style={{ position: 'absolute', left: 0, top: 300, width: 640, textAlign: 'center', color: '#f6e7c1' }}>
          CLICK ANYWHERE TO WAKE THE FARM
        </div>
      )}
    </div>
  );
}
