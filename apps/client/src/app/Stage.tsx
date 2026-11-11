// The stage fills the window. The canvas draws the world (see pixi/host.ts); the UI layer above it
// has its own logical size (app/viewport.ts), scaled to the window, with HUD pieces pinned to its edges.
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { useStore } from '../state/store';
import { PORTRAIT_FARM_TOP } from '../pixi/farm/layout';
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

  return (
    <div ref={ref} className={`viewport ${v.portrait ? 'portrait' : 'landscape'}`} onPointerDown={onPointerDown} style={{ cursor: cursor ?? 'default' }}>
      <div
        className="ui"
        style={{
          width: v.uiW,
          height: v.uiH,
          transform: `scale(${v.uiZoom})`,
          ['--ui-w' as string]: `${v.uiW}px`,
          ['--ui-h' as string]: `${v.uiH}px`,
          ['--fit' as string]: String(Math.min(1, v.uiW / 640, v.uiH / 360)),
          // where the farm's fence line ends, in UI pixels (the tray starts there in portrait)
          ['--farm-bottom' as string]: `${Math.round(((PORTRAIT_FARM_TOP + 344) * v.zoom) / v.uiZoom)}px`,
        }}
      >
        {children}
      </div>
    </div>
  );
}
