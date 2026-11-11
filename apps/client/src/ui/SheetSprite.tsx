// A frame of a packed sheet as a DOM element (CSS background, pixelated), optionally animated with
// the sheet's own per-frame durations.
import { useEffect, useState, type CSSProperties, type HTMLAttributes } from 'react';
import { useServices } from '../app/services';

export interface SheetSpriteProps extends HTMLAttributes<HTMLDivElement> {
  id: string;
  row: string;
  frame?: number;
  play?: 'loop' | 'once' | false;
  onDone?: () => void;
  /** Override the sheet's divisor (art pixels per game pixel). */
  divisor?: number;
}

export function SheetSprite({ id, row, frame = 0, play = false, onDone, divisor, className, style, ...rest }: SheetSpriteProps) {
  const { assets } = useServices();
  const sheet = assets.sheet(id);
  const names = sheet.animations[row] ?? [];
  const [i, setI] = useState(frame);

  useEffect(() => setI(frame), [frame, row]);

  useEffect(() => {
    if (!play || names.length < 2) return;
    let index = 0;
    let timer: ReturnType<typeof setTimeout>;
    const step = () => {
      const f = sheet.frames[names[index] ?? ''];
      timer = setTimeout(() => {
        if (index + 1 >= names.length) {
          if (play === 'once') return onDone?.();
          index = 0;
        } else index++;
        setI(index);
        step();
      }, f?.duration || 100);
    };
    setI(0);
    step();
    return () => clearTimeout(timer);
    // names and sheet are stable per id and row
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, row, play]);

  const f = sheet.frames[names[Math.min(i, names.length - 1)] ?? '']?.frame;
  const d = divisor ?? assets.divisor(id);
  if (!f) return null;
  const css: CSSProperties = {
    width: f.w / d,
    height: f.h / d,
    backgroundImage: `url(${assets.url(id)})`,
    backgroundSize: `${sheet.meta.size.w / d}px ${sheet.meta.size.h / d}px`,
    backgroundPosition: `${-f.x / d}px ${-f.y / d}px`,
    ...style,
  };
  return <div className={`sprite ${className ?? ''}`} style={css} {...rest} />;
}

/** Characters on the split-flap sheet: 13 columns of 64x96 cells. */
const FLAP_ROWS = ['0123456789^v.', 'ABCDEFGHIJKLM', 'NOPQRSTUVWXYZ'];

export function flapRect(ch: string): { x: number; y: number } | null {
  const c = ch.toUpperCase();
  for (const [r, row] of FLAP_ROWS.entries()) {
    const col = row.indexOf(c);
    if (col >= 0) return { x: col * 64, y: r * 96 };
  }
  return null;
}
