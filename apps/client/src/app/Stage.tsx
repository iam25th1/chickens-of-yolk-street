// The 640x360 stage, scaled by the largest whole number that fits the window. The canvas and the
// UI layer share one coordinate space, so a UI element at (x, y) sits over world pixel (x, y).
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { GAME_H, GAME_W } from '../pixi/host';

function fitScale(): number {
  return Math.max(1, Math.floor(Math.min(window.innerWidth / GAME_W, window.innerHeight / GAME_H)));
}

export function useStageScale(): number {
  const [scale, setScale] = useState(fitScale);
  useEffect(() => {
    const onResize = () => setScale(fitScale());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return scale;
}

export function Stage({
  scale,
  onMount,
  cursor,
  onPointerDown,
  children,
}: {
  scale: number;
  onMount: (el: HTMLDivElement) => void;
  cursor: string | null;
  onPointerDown: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);

  useLayoutEffect(() => {
    if (ref.current && !mounted.current) {
      mounted.current = true;
      onMount(ref.current);
    }
  }, [onMount]);

  const w = GAME_W * scale;
  const h = GAME_H * scale;
  return (
    <div
      ref={ref}
      className="viewport"
      onPointerDown={onPointerDown}
      style={{
        width: w,
        height: h,
        left: Math.max(0, Math.floor((window.innerWidth - w) / 2)),
        top: Math.max(0, Math.floor((window.innerHeight - h) / 2)),
        cursor: cursor ?? 'default',
      }}
    >
      <div className="ui" style={{ transform: `scale(${scale})` }}>
        {children}
      </div>
    </div>
  );
}
