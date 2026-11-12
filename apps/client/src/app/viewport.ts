// The window's layout, in whole device pixels.
//
// The UI is laid out in UI pixels and drawn at p device pixels each (p a whole number), so pixel
// fonts and pixel art always land on whole device pixels: nothing is ever scaled by a fraction.
// The world (the canvas) is drawn at k device pixels per world pixel, also whole; painted art comes
// in atlases cut at exactly k texels per world pixel (or k/2, drawn twice over while the full one
// loads), so a texel is one device pixel.
//
// Fixed zones that never overlap (UI pixels): the top bar, the right side panel, a bottom-left goal
// tracker, the toast area stacked above the tracker, and the world (the rest). The farm is placed
// so its composition fits whole inside the world zone and the tracker and toasts sit only over its
// ground (see pixi/farm/layout.ts). A modal opens in the modal rect (inside the world zone, above
// the toasts); in portrait it takes the side panel's place under the farm.
import { MIN_H, MIN_W } from '../pixi/farm/layout';
import { createStore } from '../state/store';

/** Whole zooms the UI and the world use; painted atlases exist at the densities that divide them. */
export const SCALES = [8, 6, 4, 3, 2] as const;
export const TOP_H = 20;
export const PORTRAIT_TOP_H = 38;
export const SIDE_W = 136;
export const TRACK_H = 20;
export const MARGIN = 6;
/** Two toast lines above the tracker. */
const TOASTS_H = 34;
/** The guide band at the bottom left: margin, tracker, gap, toasts. */
const GUIDE_H = MARGIN + TRACK_H + 4 + TOASTS_H + 2;
const TRACK_W = 300;
/** In portrait, the room kept under the farm for the side panel and for a modal (UI px). */
const PORTRAIT_BELOW_MIN = 360;
export const PLATE_W = 640;
export const PLATE_H = 360;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** How a scene's world maps to the window: k device pixels per world pixel, offset in device pixels. */
export interface WorldView {
  k: number;
  offX: number;
  offY: number;
}

/** The farm's view: its area (world pixels, from the origin) and the bottom-left band the guide covers. */
export interface FarmView extends WorldView {
  w: number;
  h: number;
  guide: { w: number; h: number };
}

export interface Viewport {
  cssW: number;
  cssH: number;
  dpr: number;
  devW: number;
  devH: number;
  portrait: boolean;
  /** Device pixels per UI pixel, and the UI's size in UI pixels. */
  p: number;
  uiW: number;
  uiH: number;
  /** The farm's view (world origin = farm origin) and the 640x360 plates' view (title, loading, town). */
  farm: FarmView;
  plate: WorldView;
  zones: { top: Rect; side: Rect; tracker: Rect; toasts: Rect; world: Rect; modal: Rect };
}

const pick = (ok: (s: number) => boolean): number => SCALES.find(ok) ?? 1;

export function measure(cssW = window.innerWidth, cssH = window.innerHeight, dpr = window.devicePixelRatio || 1): Viewport {
  cssW = Math.max(1, cssW);
  cssH = Math.max(1, cssH);
  const devW = Math.round(cssW * dpr);
  const devH = Math.round(cssH * dpr);
  const portrait = devH > devW;
  // plates fit the window; on a phone they may lose their sides (never the 256-pixel logo in the middle)
  // in landscape a plate covers the window when that crops at most a sixteenth of it a side, else it fits
  const cover = [...SCALES].reverse().find((s) => PLATE_W * s >= devW && PLATE_H * s >= devH);
  const coverOk = cover !== undefined && (PLATE_W * cover - devW) / 2 <= (PLATE_W * cover) / 16 && (PLATE_H * cover - devH) / 2 <= (PLATE_H * cover) / 16;
  const kp = portrait
    ? pick((s) => 256 * s <= devW && PLATE_H * s <= devH * 0.6)
    : coverOk && cover !== undefined
      ? cover
      : pick((s) => PLATE_W * s <= devW && PLATE_H * s <= devH);
  const plate: WorldView = { k: kp, offX: Math.round((devW - PLATE_W * kp) / 2), offY: Math.round((devH - PLATE_H * kp) / 2) };

  if (portrait) {
    const p = pick((s) => devW / s >= 360 && devH / s >= 560);
    const uiW = devW / p;
    const uiH = devH / p;
    const top: Rect = { x: 0, y: 0, w: uiW, h: PORTRAIT_TOP_H };
    // the farm across the width, under the top bar, as tall as the screen allows while the side
    // panel (and a modal, which opens in its place) keeps PORTRAIT_BELOW_MIN under it; then the guide
    const k = pick((s) => MIN_W * s <= devW && (MIN_H + 40) * s <= devH * 0.5);
    const stack = 2 + 36 + 4 + TRACK_H + MARGIN;
    const room = Math.floor(((uiH - PORTRAIT_TOP_H - stack - PORTRAIT_BELOW_MIN) * p) / k);
    const farmH = Math.max(MIN_H + 40, Math.min(room, Math.floor(devW / k)));
    const farm: FarmView = { k, offX: 0, offY: PORTRAIT_TOP_H * p, w: Math.floor(devW / k), h: farmH, guide: { w: 0, h: 0 } };
    const below = (farm.offY + farmH * k) / p + 2;
    const toasts: Rect = { x: MARGIN, y: below, w: uiW - 2 * MARGIN, h: 36 };
    const tracker: Rect = { x: MARGIN, y: toasts.y + toasts.h + 4, w: uiW - 2 * MARGIN, h: TRACK_H };
    const sideY = tracker.y + TRACK_H + MARGIN;
    const side: Rect = { x: 0, y: sideY, w: uiW, h: uiH - sideY };
    const world: Rect = { x: 0, y: top.h, w: uiW, h: tracker.y + TRACK_H - top.h };
    const modal: Rect = { x: MARGIN, y: sideY, w: uiW - 2 * MARGIN, h: uiH - sideY - MARGIN };
    return { cssW, cssH, dpr, devW, devH, portrait, p, uiW, uiH, farm, plate, zones: { top, side, tracker, toasts, world, modal } };
  }

  const p = pick((s) => devW / s >= 560 && devH / s >= 330);
  const uiW = devW / p;
  const uiH = devH / p;
  const top: Rect = { x: 0, y: 0, w: uiW, h: TOP_H };
  const side: Rect = { x: uiW - SIDE_W, y: TOP_H, w: SIDE_W, h: uiH - TOP_H };
  const world: Rect = { x: 0, y: TOP_H, w: uiW - SIDE_W, h: uiH - TOP_H };
  const zw = world.w * p;
  const zh = world.h * p;
  // the farm fills the whole world zone; the zoom is the largest whose smallest layout still fits
  // above the guide band
  const k = pick((s) => MIN_W * s <= zw && MIN_H * s + GUIDE_H * p <= zh);
  const tracker: Rect = { x: MARGIN, y: uiH - MARGIN - TRACK_H, w: Math.min(TRACK_W, world.w - 2 * MARGIN), h: TRACK_H };
  const toasts: Rect = { x: MARGIN, y: uiH - GUIDE_H + 2, w: tracker.w, h: TOASTS_H };
  const farm: FarmView = {
    k,
    offX: 0,
    offY: TOP_H * p,
    w: Math.floor(zw / k),
    h: Math.floor(zh / k),
    guide: { w: Math.ceil(((MARGIN + tracker.w + 4) * p) / k), h: Math.ceil((GUIDE_H * p) / k) },
  };
  const modal: Rect = { x: MARGIN, y: TOP_H + MARGIN, w: world.w - 2 * MARGIN, h: Math.max(120, toasts.y - 4 - (TOP_H + MARGIN)) };
  return { cssW, cssH, dpr, devW, devH, portrait, p, uiW, uiH, farm, plate, zones: { top, side, tracker, toasts, world, modal } };
}

export const viewport = createStore<Viewport>(typeof window === 'undefined' ? measure(1280, 720, 1) : measure());

let installed = false;
export function watchViewport(): void {
  if (installed) return;
  installed = true;
  const update = () => viewport.set(measure());
  window.addEventListener('resize', update);
  const watchDpr = () => {
    const mq = window.matchMedia?.(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    mq?.addEventListener?.(
      'change',
      () => {
        update();
        watchDpr();
      },
      { once: true },
    );
  };
  watchDpr();
}

/** A farm point (world pixels) in UI pixels. */
export function worldToUi(pt: { x: number; y: number }, v: Viewport = viewport.get()): { x: number; y: number } {
  return { x: (v.farm.offX + pt.x * v.farm.k) / v.p, y: (v.farm.offY + pt.y * v.farm.k) / v.p };
}
