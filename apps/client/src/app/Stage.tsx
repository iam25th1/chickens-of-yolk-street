// The stage fills the window. The canvas draws the world (see pixi/host.ts); the UI layer above it
// is laid out in UI pixels and drawn at p device pixels each through CSS zoom (p whole, from
// app/viewport.ts): text and pixel art render at the screen's own resolution, never stretched.
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { useStore } from '../state/store';
import { viewport, watchViewport, type Viewport } from './viewport';

export function useViewport(): Viewport {
  useEffect(() => watchViewport(), []);
  return useStore(viewport, (v) => v);
}

export function Stage({
  onMount,
  cursor,
  onPointerDown,
  children,
}: {
  onMount: (el: HTMLDivElement) => void;
  cursor: string | null;
  onPointerDown: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);
  const v = useViewport();

  useLayoutEffect(() => {
    if (ref.current && !mounted.current) {
      mounted.current = true;
      onMount(ref.current);
    }
  }, [onMount]);

  // screens drawn for 640x360 (title, login, loading) sit centred on whole device pixels
  const cx = Math.round((v.devW - 640 * v.p) / 2) / v.p;
  const cy = Math.round((v.devH - 360 * v.p) / 2) / v.p;
  return (
    <div ref={ref} className={`viewport ${v.portrait ? 'portrait' : 'landscape'}`} onPointerDown={onPointerDown} style={{ cursor: cursor ?? 'default' }}>
      <div
        className="ui"
        data-p={v.p}
        style={{
          width: v.uiW,
          height: v.uiH,
          zoom: v.p / v.dpr,
          ['--c640x' as string]: `${cx}px`,
          ['--c640y' as string]: `${cy}px`,
        }}
      >
        {children}
      </div>
    </div>
  );
}
