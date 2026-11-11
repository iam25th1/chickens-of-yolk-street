// A frame of a derived atlas as a DOM element (CSS background, pixelated), optionally animated with
// the sprite's own per-frame durations. Needs only the manifest: the browser fetches the atlas.
import { useEffect, useState, type CSSProperties, type HTMLAttributes } from 'react';
import { useServices } from '../app/services';

export interface SheetSpriteProps extends HTMLAttributes<HTMLDivElement> {
  id: string;
  row: string;
  frame?: number;
  play?: 'loop' | 'once' | false;
  onDone?: () => void;
  /** Source pixels per UI pixel, as the packed sheets count them (kept for older call sites). */
  divisor?: number;
  /** UI pixels per atlas pixel; defaults to the sprite's world scale. */
  zoom?: number;
}

export function SheetSprite({ id, row, frame = 0, play = false, onDone, divisor, zoom, className, style, ...rest }: SheetSpriteProps) {
  const { assets } = useServices();
  const rects = assets.frameRects(id, row);
  const [i, setI] = useState(frame);

  useEffect(() => setI(frame), [frame, row]);

  useEffect(() => {
    if (!play || rects.length < 2) return;
    let index = 0;
    let timer: ReturnType<typeof setTimeout>;
    const step = () => {
      timer = setTimeout(() => {
        if (index + 1 >= rects.length) {
          if (play === 'once') return onDone?.();
          index = 0;
        } else index++;
        setI(index);
        step();
      }, rects[index]?.ms || 100);
    };
    setI(0);
    step();
    return () => clearTimeout(timer);
    // rects are stable per id and row
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, row, play]);

  const f = rects[Math.min(i, rects.length - 1)];
  if (!f) return null;
  const z = zoom ?? (divisor ? assets.grid(id) / divisor : assets.scale(id));
  const atlas = assets.atlasSize(id);
  const css: CSSProperties = {
    width: f.w * z,
    height: f.h * z,
    backgroundImage: `url(${assets.url(id)})`,
    backgroundSize: `${atlas.w * z}px ${atlas.h * z}px`,
    backgroundPosition: `${-f.x * z}px ${-f.y * z}px`,
    ...style,
  };
  return <div className={`sprite ${className ?? ''}`} style={css} {...rest} />;
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
