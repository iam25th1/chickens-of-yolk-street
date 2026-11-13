// The farm's camera: which part of the farm the farm area shows. With only the home plot the farm is
// exactly the farm area and the camera stays at the origin, as it always did; with land the player
// looks round the whole farm by dragging it, with the arrow keys or WASD, or the small map, and the
// HOME button brings the home plot back. The camera is the farm area's top-left corner in world
// pixels, kept on whole pixels and inside the farm. Pure helpers (tested in test/camera.test.ts),
// the store the small map reads, and the pointer and key input that moves it.
import { createStore } from '../../state/store';
import type { Box, FarmLayout, Point } from './layout';

/** Where the camera's corner may go: the farm area stays on the farm. */
export function cameraRoom(l: FarmLayout): Box {
  return { left: l.world.left, top: l.world.top, right: Math.max(l.world.left, l.world.right - l.w), bottom: Math.max(l.world.top, l.world.bottom - l.h) };
}

/** A camera corner kept inside its room. */
export function clampCamera(p: Point, l: FarmLayout): Point {
  const r = cameraRoom(l);
  return { x: Math.min(r.right, Math.max(r.left, p.x)), y: Math.min(r.bottom, Math.max(r.top, p.y)) };
}

/** Whether the farm is bigger than the farm area, so the camera can move at all. */
export const canLook = (l: FarmLayout): boolean => l.world.left < 0 || l.world.top < 0 || l.world.right > l.w || l.world.bottom > l.h;

/** The camera that shows a box: centred on it, kept inside the room. */
export function cameraOn(box: Box, l: FarmLayout): Point {
  return clampCamera({ x: Math.round((box.left + box.right - l.w) / 2), y: Math.round((box.top + box.bottom - l.h) / 2) }, l);
}

/** Whether a point is in the part of the farm the camera shows (a margin inside its edges). */
export const inView = (p: Point, cam: Point, l: FarmLayout, margin = 24): boolean => p.x >= cam.x + margin && p.x <= cam.x + l.w - margin && p.y >= cam.y + margin && p.y <= cam.y + l.h - margin;

/** What the small map draws: the farm's plots, and the part of the farm in view (world pixels). */
export interface CameraState {
  /** The farm is bigger than the farm area: the map and HOME show. */
  on: boolean;
  x: number;
  y: number;
  w: number;
  h: number;
  world: Box;
  plots: { id: string; box: Box }[];
}

export const farmCamera = createStore<CameraState>({ on: false, x: 0, y: 0, w: 1, h: 1, world: { left: 0, top: 0, right: 1, bottom: 1 }, plots: [] });

/** What the input moves: the farm scene's camera. */
export interface Lookable {
  /** Moves the camera by world pixels (the farm follows the pointer the other way). */
  pan(dx: number, dy: number): void;
  /** The keys held down now that move it (arrow keys and WASD), read each frame. */
  hold(dir: { x: number; y: number }): void;
  /** Taps on the farm do nothing while it is dragged. */
  setDragging(on: boolean): void;
  /** The farm is the scene on screen and bigger than the farm area. */
  lookable(): boolean;
}

/** Device pixels per world pixel and per CSS pixel, to turn a pointer's move into world pixels. */
export type Scale = () => { k: number; dpr: number };

/** A drag starts once the pointer has moved this far (CSS pixels); a shorter move is still a tap. */
export const DRAG_FROM = 5;

const KEYS: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
  a: [-1, 0],
  d: [1, 0],
  w: [0, -1],
  s: [0, 1],
  A: [-1, 0],
  D: [1, 0],
  W: [0, -1],
  S: [0, 1],
};

/**
 * Pointer drag on the canvas and the arrow keys and WASD on the window move the camera. A drag
 * longer than DRAG_FROM marks the farm as dragged until the next press, so letting go over a hen
 * or a machine does not open it. Keys count only while `keys()` allows (no modal or tour open, no
 * text field focused). Returns the function that removes it all.
 */
export function attachLook(canvas: HTMLElement, target: Lookable, scale: Scale, keys: () => boolean): () => void {
  let down: { id: number; x: number; y: number; lastX: number; lastY: number; dragging: boolean } | null = null;
  const held = new Set<string>();
  const onDown = (e: PointerEvent) => {
    target.setDragging(false);
    if (!target.lookable() || (e.pointerType === 'mouse' && e.button !== 0)) return;
    down = { id: e.pointerId, x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY, dragging: false };
  };
  const onMove = (e: PointerEvent) => {
    if (!down || e.pointerId !== down.id) return;
    if (!down.dragging && Math.hypot(e.clientX - down.x, e.clientY - down.y) < DRAG_FROM) return;
    if (!down.dragging) {
      down.dragging = true;
      target.setDragging(true);
    }
    const { k, dpr } = scale();
    target.pan(((down.lastX - e.clientX) * dpr) / k, ((down.lastY - e.clientY) * dpr) / k);
    down.lastX = e.clientX;
    down.lastY = e.clientY;
  };
  const onUp = (e: PointerEvent) => {
    if (down && e.pointerId === down.id) down = null;
  };
  const steer = () => {
    let x = 0;
    let y = 0;
    for (const key of held) {
      const d = KEYS[key];
      if (d) {
        x += d[0];
        y += d[1];
      }
    }
    target.hold({ x: Math.sign(x), y: Math.sign(y) });
  };
  const typing = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  };
  const onKey = (e: KeyboardEvent) => {
    if (!KEYS[e.key] || e.ctrlKey || e.metaKey || e.altKey || typing(e)) return;
    if (!keys() || !target.lookable()) {
      held.clear();
      steer();
      return;
    }
    e.preventDefault();
    held.add(e.key);
    steer();
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (!held.delete(e.key)) return;
    steer();
  };
  const onBlur = () => {
    held.clear();
    steer();
    down = null;
  };
  canvas.addEventListener('pointerdown', onDown, true);
  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointercancel', onUp, true);
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  return () => {
    canvas.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('pointercancel', onUp, true);
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
  };
}
