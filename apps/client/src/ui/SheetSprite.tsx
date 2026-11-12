// Sprites in the DOM, always on whole device pixels.
//
// Exact sheets (true pixel art: icons, frames, card art, stamps) are CSS backgrounds of their atlas
// at a whole zoom (UI pixels per texel), so each art pixel is zoom x p device pixels. Painted art
// (portraits, signs, hens) is painted into a canvas whose pixels are device pixels: each texel of
// the density loaded for this screen becomes m x m of them (m whole), nearest neighbour. Frames can
// play with the sprite's own per-frame durations.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type HTMLAttributes } from 'react';
import { useServices } from '../app/services';
import { useViewport } from '../app/Stage';

export interface SheetSpriteProps extends HTMLAttributes<HTMLElement> {
  id: string;
  row: string;
  frame?: number;
  play?: 'loop' | 'once' | false;
  onDone?: () => void;
  /** Exact sheets: UI pixels per texel (a whole number). */
  zoom?: number;
  /**
   * Painted art: how big to draw it, as device pixels per design pixel (world pixel for farm art,
   * UI pixel for portraits). Rounded to a whole number of device pixels per texel.
   */
  size?: number;
  /** More layers stacked on the same pivot (a hen's traits). */
  layers?: string[];
  /** Painted art: a fixed box in UI pixels with the pivot at its bottom centre, so frames do not jump. */
  box?: { w: number; h: number };
}

/** Steps through a row's frames on the sprite's own clock. */
function useFrame(count: number, msOf: (i: number) => number, frame: number, play: SheetSpriteProps['play'], onDone: (() => void) | undefined, key: string): number {
  const [i, setI] = useState(frame);
  useEffect(() => setI(frame), [frame, key]);
  useEffect(() => {
    if (!play || count < 2) return;
    let index = 0;
    let timer: ReturnType<typeof setTimeout>;
    const step = () => {
      timer = setTimeout(() => {
        if (index + 1 >= count) {
          if (play === 'once') return onDone?.();
          index = 0;
        } else index++;
        setI(index);
        step();
      }, msOf(index));
    };
    setI(0);
    step();
    return () => clearTimeout(timer);
    // msOf and onDone are read when they fire; the key names the row
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, play, count]);
  return Math.min(i, Math.max(0, count - 1));
}

export function SheetSprite({ id, row, frame = 0, play = false, onDone, zoom, size, layers, box, className, style, ...rest }: SheetSpriteProps) {
  const { assets } = useServices();
  const v = useViewport();
  const [, bump] = useState(0);
  useEffect(() => assets.onChange(() => bump((n) => n + 1)), [assets]);
  const painted = assets.isPainted(id);
  const rects = assets.has(id) ? assets.frameRects(id, row) : [];
  const i = useFrame(rects.length, (k) => rects[k]?.ms || 100, frame, play, onDone, `${id}/${row}`);
  if (painted) return <PaintedCanvas id={id} layers={layers} row={row} frame={i} size={size ?? v.p} box={box} className={className} style={style} {...rest} />;
  const f = rects[i];
  if (!f) return null;
  const z = Math.max(1, Math.round(zoom ?? assets.texelScale(id)));
  const atlas = assets.atlasSize(id, f.page);
  const css: CSSProperties = {
    width: f.w * z,
    height: f.h * z,
    backgroundImage: `url(${assets.url(id, f.page)})`,
    backgroundSize: `${atlas.w * z}px ${atlas.h * z}px`,
    backgroundPosition: `${-f.x * z}px ${-f.y * z}px`,
    ...style,
  };
  return <div className={`sprite ${className ?? ''}`} style={css} {...rest} />;
}

function PaintedCanvas({
  id,
  layers,
  row,
  frame,
  size,
  box,
  className,
  style,
  ...rest
}: { id: string; layers?: string[]; row: string; frame: number; size: number; box?: { w: number; h: number } } & HTMLAttributes<HTMLElement>) {
  const { assets } = useServices();
  const v = useViewport();
  const ref = useRef<HTMLCanvasElement>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const stack = layers ?? [id];
  const key = stack.join('+');
  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas || !assets.has(id)) return;
    // whole device pixels per texel: the density loaded for this screen, drawn m times over
    const m = Math.max(1, Math.round(size * assets.texelScale(id)));
    const fixed = box ? { w: Math.round(box.w * v.p), h: Math.round(box.h * v.p) } : null;
    const out = assets.paint(canvas, stack, row, frame, m, fixed ? { ...fixed, px: Math.round(fixed.w / 2), py: fixed.h - Math.round(2 * v.p) } : undefined);
    if (out && (out.w !== dims?.w || out.h !== dims?.h)) setDims({ w: out.w, h: out.h });
    // the store's version brings sharper frames in
  }, [assets, id, key, row, frame, size, box, v.p, dims, assets.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const css: CSSProperties = dims ? { width: dims.w / v.p, height: dims.h / v.p, ...style } : { visibility: 'hidden', ...style };
  return <canvas ref={ref} className={`sprite ${className ?? ''}`} style={css} {...(rest as HTMLAttributes<HTMLCanvasElement>)} />;
}

/** Characters on the split-flap sheet: 13 columns of 64x96 cells (source pixels). */
const FLAP_ROWS = ['0123456789^v.', 'ABCDEFGHIJKLM', 'NOPQRSTUVWXYZ'];

export function flapRect(ch: string): { x: number; y: number } | null {
  const c = ch.toUpperCase();
  for (const [r, row] of FLAP_ROWS.entries()) {
    const col = row.indexOf(c);
    if (col >= 0) return { x: col * 64, y: r * 96 };
  }
  return null;
}
