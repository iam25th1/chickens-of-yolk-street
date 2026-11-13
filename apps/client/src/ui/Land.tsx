// Land: the shop's LAND tab (a map of the home plot and the four plots around it, each owned or for
// sale at the next land price) and, once the farm is bigger than the window, the look-round
// controls over the farm's top-left corner: a small map of the plots with the part in view, which
// moves the view where it is tapped, and HOME, which brings the home plot back.
import type { PointerEvent as ReactPointerEvent } from 'react';
import { ECONOMY, LAND_IDS, LAND_NAME, landPrice, type FarmState, type LandId } from '@coys/shared';
import { uiSound, useServices } from '../app/services';
import { MARGIN, type Rect } from '../app/viewport';
import type { Action } from '../net/socket';
import { farmCamera } from '../pixi/farm/camera';
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

/** The small map's largest size (UI pixels). */
const MAP_W = 64;
const MAP_H = 40;

/**
 * The look-round controls, over the world zone's top-left corner while the farm is bigger than the
 * window: the small map (the plots, and a frame for the part in view) and HOME.
 */
export function LookAround({ rect, onHome, onLook }: { rect: Rect; onHome: () => void; onLook: (p: { x: number; y: number }) => void }) {
  const { audio } = useServices();
  const cam = useStore(farmCamera, (s) => s);
  if (!cam.on) return null;
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
    <div className="look zone" data-ui="look" style={{ left: rect.x + MARGIN, top: rect.y + MARGIN }}>
      <div className="land-mini" data-ui="farm-map" role="img" aria-label="Map of your farm" style={{ width: w, height: h }} onPointerDown={look}>
        {cam.plots.map((p) => (
          <div key={p.id} className={`land-mini-plot ${p.id === 'home' ? 'home' : ''}`} style={at(p.box)} />
        ))}
        <div className="land-mini-view" data-ui="farm-map-view" style={at({ left: cam.x, top: cam.y, right: cam.x + cam.w, bottom: cam.y + cam.h })} />
      </div>
      <button
        className="btn"
        data-ui="farm-home"
        onMouseEnter={() => uiSound(audio, 'hover')}
        onClick={() => {
          uiSound(audio, 'click');
          onHome();
        }}
      >
        HOME
      </button>
    </div>
  );
}
