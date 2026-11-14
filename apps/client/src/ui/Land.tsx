// Land: the shop's LAND tab (a map of the home plot and the four plots around it, each owned or for
// sale at the next land price) and, once the farm is bigger than the window, the look-round
// controls in the farm's top-left corner: a map button that opens a small map of the plots with the
// part in view (a tap on it moves the view there), and, once the view is off the home plot, a HOME
// button that brings it back.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { ECONOMY, LAND_IDS, LAND_NAME, landPrice, type FarmState, type LandId } from '@coys/shared';
import { uiSound, useServices } from '../app/services';
import { MARGIN, type Rect } from '../app/viewport';
import type { Action } from '../net/socket';
import { DRAG_FROM, farmCamera } from '../pixi/farm/camera';
import { useStore } from '../state/store';

/** Where each plot sits on the shop's map: a 3 x 3 grid with the home plot in the middle. */
const CELL: Record<LandId | 'home', { col: number; row: number }> = {
  north: { col: 2, row: 1 },
  west: { col: 1, row: 2 },
  home: { col: 2, row: 2 },
  east: { col: 3, row: 2 },
  south: { col: 2, row: 3 },
};

export function LandTab({ farm, send, onBought }: { farm: FarmState; send: (a: Action) => Promise<boolean>; onBought: () => void }) {
  const { audio } = useServices();
  const cash = farm.cashMilli / 1000;
  const price = landPrice(farm.land.length);
  const slots = ECONOMY.land.plots.east.coopSlots;
  return (
    <div className="col" style={{ gap: 6 }} data-ui="land-tab">
      <span style={{ lineHeight: '10px' }}>EACH PLOT OF LAND ADDS {slots} COOP PLOTS AND A PASTURE FOR YOUR HENS; EACH ONE YOU BUY COSTS MORE THAN THE LAST.</span>
      <div className="land-map" data-ui="land-map">
        <div className="land-cell home" style={{ gridColumn: CELL.home.col, gridRow: CELL.home.row }} data-ui="land-home">
          <span>YOUR FARM</span>
          <span>{ECONOMY.coops.plots} COOP PLOTS</span>
        </div>
        {LAND_IDS.map((id) => {
          const owned = farm.land.includes(id);
          return (
            <div key={id} className={`land-cell ${owned ? 'owned' : ''}`} style={{ gridColumn: CELL[id].col, gridRow: CELL[id].row }} data-ui={`land-${id}`}>
              <span>{LAND_NAME[id]}</span>
              {owned ? (
                <span className="chip on">OWNED</span>
              ) : (
                <button
                  className="btn red"
                  data-ui={`buy-land-${id}`}
                  disabled={price === null || cash < price}
                  onMouseEnter={() => uiSound(audio, 'hover')}
                  onClick={() => {
                    uiSound(audio, 'click');
                    void send({ t: 'buyLand', plot: id }).then((ok) => ok && onBought());
                  }}
                >
                  BUY {price ?? ''}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The small map's largest size (UI pixels): half what it was, so it covers little of the farm. */
const MAP_W = 32;
const MAP_H = 20;

/** Whether this player left the small map open (kept in this browser; none kept when storage is off). */
const mapKey = (farmId: string) => `coys.farmMap.${farmId}`;
function mapWasOpen(farmId: string): boolean {
  try {
    return localStorage.getItem(mapKey(farmId)) === '1';
  } catch {
    return false;
  }
}
function keepMapOpen(farmId: string, open: boolean): void {
  try {
    localStorage.setItem(mapKey(farmId), open ? '1' : '0');
  } catch {
    // (private browsing: the map starts closed next time)
  }
}

/** The map button's picture, drawn like the small map: the home plot in straw, the plots round it. */
function MapIcon() {
  const cell = (left: number, top: number, bg: string) => <span style={{ position: 'absolute', left, top, width: 4, height: 3, background: bg }} />;
  return (
    <span aria-hidden="true" style={{ position: 'relative', display: 'inline-block', width: 16, height: 16, flex: 'none' }}>
      <span style={{ position: 'absolute', left: 1, top: 2, width: 14, height: 11, background: 'var(--grass-deep)', boxShadow: '0 0 0 1px var(--ink)' }} />
      {cell(6, 2, 'var(--grass)')}
      {cell(1, 6, 'var(--grass)')}
      {cell(6, 6, 'var(--straw)')}
      {cell(11, 6, 'var(--grass)')}
      {cell(6, 10, 'var(--grass)')}
    </span>
  );
}

/** HOME's picture: a small farmhouse, a red roof over cream walls and a door. */
function HomeIcon() {
  const roof = [
    [7, 2, 2],
    [6, 3, 4],
    [5, 4, 6],
    [4, 5, 8],
    [3, 6, 10],
  ] as const;
  return (
    <span aria-hidden="true" style={{ position: 'relative', display: 'inline-block', width: 16, height: 16, flex: 'none' }}>
      {roof.map(([left, top, width]) => (
        <span key={top} style={{ position: 'absolute', left, top, width, height: 1, background: 'var(--barn)' }} />
      ))}
      <span style={{ position: 'absolute', left: 4, top: 7, width: 8, height: 6, background: 'var(--cream)', boxShadow: '0 0 0 1px var(--ink)' }} />
      <span style={{ position: 'absolute', left: 7, top: 10, width: 2, height: 3, background: 'var(--ink)' }} />
    </span>
  );
}

/**
 * The look-round controls, in the world zone's top-left corner while the farm is bigger than the
 * window: a map button (the size of the top bar's buttons) and, while the view is off the home plot,
 * HOME beside it; the button opens the small map (the plots, and a frame for the part in view) to
 * their right, along the grass at the farm's top edge, clear of the coop under the corner. A tap
 * on the button again, or anywhere else, closes the map; a drag, the arrow keys and WASD leave it as
 * it is. Whether it was left open is kept for the player.
 */
export function LookAround({ rect, farmId, onHome, onLook }: { rect: Rect; farmId: string; onHome: () => void; onLook: (p: { x: number; y: number }) => void }) {
  const { audio } = useServices();
  const cam = useStore(farmCamera, (s) => s);
  const [open, setOpen] = useState(() => mapWasOpen(farmId));
  const box = useRef<HTMLDivElement>(null);
  const toggle = (on: boolean) => {
    setOpen(on);
    keepMapOpen(farmId, on);
  };
  // a tap anywhere else closes the open map (a press that moves further is a drag, and leaves it)
  useEffect(() => {
    if (!open || !cam.on) return;
    let down: { x: number; y: number } | null = null;
    const inside = (e: PointerEvent) => !!box.current && e.target instanceof Node && box.current.contains(e.target);
    const press = (e: PointerEvent) => {
      down = inside(e) ? null : { x: e.clientX, y: e.clientY };
    };
    const release = (e: PointerEvent) => {
      if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < DRAG_FROM) {
        setOpen(false);
        keepMapOpen(farmId, false);
      }
      down = null;
    };
    window.addEventListener('pointerdown', press, true);
    window.addEventListener('pointerup', release, true);
    return () => {
      window.removeEventListener('pointerdown', press, true);
      window.removeEventListener('pointerup', release, true);
      // a press elsewhere that took these controls away before it was let go (a tap on the farm that
      // opened a card, which on a phone takes this corner) was a tap elsewhere too
      if (down) {
        setOpen(false);
        keepMapOpen(farmId, false);
      }
    };
  }, [open, cam.on, farmId]);
  if (!cam.on) return null;
  const away = cam.x !== 0 || cam.y !== 0;
  const ww = cam.world.right - cam.world.left;
  const wh = cam.world.bottom - cam.world.top;
  const k = Math.min(MAP_W / ww, MAP_H / wh);
  const w = Math.round(ww * k);
  const h = Math.round(wh * k);
  const at = (b: { left: number; top: number; right: number; bottom: number }) => {
    const left = Math.round((b.left - cam.world.left) * k);
    const top = Math.round((b.top - cam.world.top) * k);
    return { left, top, width: Math.max(1, Math.round((b.right - cam.world.left) * k) - left), height: Math.max(1, Math.round((b.bottom - cam.world.top) * k) - top) };
  };
  const look = (e: ReactPointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    // the map is drawn at the UI's zoom: its box in CSS pixels maps onto its w x h
    const x = ((e.clientX - r.left) / Math.max(1, r.width)) * w;
    const y = ((e.clientY - r.top) / Math.max(1, r.height)) * h;
    uiSound(audio, 'click');
    onLook({ x: cam.world.left + x / k, y: cam.world.top + y / k });
  };
  return (
    <div ref={box} className="look zone" data-ui="look" data-open={open ? '1' : '0'} style={{ left: rect.x + MARGIN, top: rect.y + MARGIN }}>
      <button
        className={`btn ${open ? 'red' : ''}`}
        style={{ height: 16, padding: '0 1px' }}
        data-ui="farm-map-button"
        aria-label={open ? 'Close the map of your farm' : 'Open the map of your farm'}
        aria-expanded={open}
        title="Map of your farm"
        onMouseEnter={() => uiSound(audio, 'hover')}
        onClick={() => {
          uiSound(audio, 'click');
          toggle(!open);
        }}
      >
        <MapIcon />
      </button>
      {away && (
        <button
          className="btn"
          style={{ height: 16, padding: '0 1px' }}
          data-ui="farm-home"
          aria-label="Home: back to your home plot"
          title="Home: back to your home plot"
          onMouseEnter={() => uiSound(audio, 'hover')}
          onClick={() => {
            uiSound(audio, 'click');
            onHome();
          }}
        >
          <HomeIcon />
        </button>
      )}
      {open && (
        <div className="land-mini" data-ui="farm-map" role="img" aria-label="Map of your farm" style={{ width: w, height: h }} onPointerDown={look}>
          {cam.plots.map((p) => (
            <div key={p.id} className={`land-mini-plot ${p.id === 'home' ? 'home' : ''}`} style={at(p.box)} />
          ))}
          <div className="land-mini-view" data-ui="farm-map-view" style={at({ left: cam.x, top: cam.y, right: cam.x + cam.w, bottom: cam.y + cam.h })} />
        </div>
      )}
    </div>
  );
}
