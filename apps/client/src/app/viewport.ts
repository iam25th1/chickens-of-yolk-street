// The window's layout: the world is 360 logical pixels tall and as wide as the window's shape (no
// letterbox); in portrait it is 480 wide and as tall as the window. The DOM UI uses its own logical
// space so text stays readable on a phone. Zoom is a whole number whenever the window allows it.
import { createStore } from '../state/store';

export const WORLD_H = 360;
const PORTRAIT_WORLD_W = 480;
const PORTRAIT_UI_W = 360;

export interface Viewport {
  cssW: number;
  cssH: number;
  dpr: number;
  portrait: boolean;
  /** CSS pixels per world pixel. */
  zoom: number;
  worldW: number;
  worldH: number;
  /** CSS pixels per UI pixel, and the UI's logical size. */
  uiZoom: number;
  uiW: number;
  uiH: number;
}

/** Snap a zoom so it lands on whole device pixels when that costs at most a few rows. */
function snap(z: number, dpr: number): number {
  const device = z * dpr;
  const whole = Math.round(device);
  return Math.abs(device - whole) < 0.02 && whole >= 1 ? whole / dpr : z;
}

export function measure(): Viewport {
  const cssW = Math.max(1, window.innerWidth);
  const cssH = Math.max(1, window.innerHeight);
  const dpr = window.devicePixelRatio || 1;
  const portrait = cssH > cssW;
  const zoom = snap(portrait ? cssW / PORTRAIT_WORLD_W : cssH / WORLD_H, dpr);
  const uiZoom = portrait ? cssW / PORTRAIT_UI_W : zoom;
  return {
    cssW,
    cssH,
    dpr,
    portrait,
    zoom,
    worldW: cssW / zoom,
    worldH: cssH / zoom,
    uiZoom,
    uiW: cssW / uiZoom,
    uiH: cssH / uiZoom,
  };
}

export const viewport = createStore<Viewport>(measure());

let installed = false;
export function watchViewport(): void {
  if (installed) return;
  installed = true;
  const update = () => viewport.set(measure());
  window.addEventListener('resize', update);
  window.matchMedia?.('(resolution: 1dppx)').addEventListener?.('change', update);
}

/** A world point (stage coordinates) in UI coordinates. */
export function worldToUi(p: { x: number; y: number }): { x: number; y: number } {
  const v = viewport.get();
  return { x: (p.x * v.zoom) / v.uiZoom, y: (p.y * v.zoom) / v.uiZoom };
}
