import { createContext, useContext } from 'react';
import type { AssetStore } from '../assets/store';
import type { AudioEngine } from '../audio/audio';
import type { PixiHost } from '../pixi/host';

export interface Services {
  assets: AssetStore;
  audio: AudioEngine;
  pixi: PixiHost;
}

export const ServicesContext = createContext<Services | null>(null);

export function useServices(): Services {
  const s = useContext(ServicesContext);
  if (!s) throw new Error('services not ready');
  return s;
}

/** Plays the standard UI sounds for a control. */
export function uiSound(audio: AudioEngine, kind: 'hover' | 'click' | 'back'): void {
  audio.unlock();
  audio.play(`35-${kind}`, { volume: kind === 'hover' ? 0.35 : 0.7, minGapMs: 40 });
}
