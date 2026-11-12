// Where things stand on the farm, in world pixels. The window shows the farm's composition (COMP)
// whole, inside the part of the window no UI zone covers (app/viewport.ts), with grass around it.
// Below SAFE_Y the composition's left part holds only ground: the goal tracker and the toasts may
// sit there; every hen, egg and machine stays above it or to its right.

export interface Point {
  x: number;
  y: number;
}

/** Everything the farm draws, roofs to the gate, in world pixels (with a 2 px margin). */
export const COMP = { left: 4, top: 36, right: 506, bottom: 348 } as const;
/** Below this line, left of SAFE_X, there is only ground. */
export const SAFE_Y = 312;
export const SAFE_X = 330;

/** The straw yard the hens roam. */
export const YARD = { left: 24, top: 150, right: 392, bottom: 304 };

/** Feet positions of the four coop plots. */
export const PLOTS: Point[] = [
  { x: 64, y: 140 },
  { x: 160, y: 140 },
  { x: 256, y: 140 },
  { x: 352, y: 140 },
];

export const SPOTS = {
  farmhouse: { x: 452, y: 132 },
  sign: { x: 432, y: 196 },
  trough: { x: 212, y: 232 },
  sack: { x: 160, y: 236 },
  hopper: { x: 264, y: 236 },
  crate: { x: 444, y: 300 },
  grader: { x: 486, y: 262 },
  clerk: { x: 400, y: 330 },
  cart: { x: 484, y: 340 },
  /** Where new hens arrive. */
  gate: { x: 444, y: 344 },
  conveyorY: 304,
  conveyorFrom: 40,
  conveyorTo: 424,
} as const;

export const PROPS: { row: 'hay-bale' | 'flowers' | 'puddle' | 'signpost'; x: number; y: number }[] = [
  { row: 'hay-bale', x: 22, y: 160 },
  { row: 'flowers', x: 340, y: 344 },
  { row: 'hay-bale', x: 484, y: 212 },
  { row: 'puddle', x: 408, y: 250 },
  { row: 'flowers', x: 410, y: 160 },
];

/** Trough-side places for hens eating. */
export const TROUGH_SPOTS: Point[] = [-26, -14, 0, 14, 26].map((dx, i) => ({ x: SPOTS.trough.x + dx, y: SPOTS.trough.y + (i % 2 ? 8 : 10) }));

export const randomIn = (r: { left: number; top: number; right: number; bottom: number }): Point => ({
  x: Math.round(r.left + Math.random() * (r.right - r.left)),
  y: Math.round(r.top + Math.random() * (r.bottom - r.top)),
});
