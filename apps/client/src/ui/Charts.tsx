// Small charts for the profile, drawn in the DOM in the game's palette (UI, not game art): bars on a
// straw ground with an ink edge, every height in whole UI pixels; a signed chart grows up and down
// from its zero line; a line chart is a dot per day joined by one-pixel steps. Each fits the width it
// is given (one column per day), with the first and last day under it.
import type { ReactNode } from 'react';

export const PALETTE = { ink: '#2a160c', wood: '#8b5a2b', straw: '#f2c94c', ground: '#e3cc96', cream: '#f6e7c1', grass: '#5c9e3a', barn: '#b8321f', sky: '#2f6f9e', bronze: '#b8743a' } as const;

export interface Bar {
  key: number | string;
  value: number;
  /** A second value stacked on top (eggs sold over eggs laid, say). */
  over?: number;
}

function Frame({ caption, top, height, children, first, last, ui }: { caption: ReactNode; top?: string; height: number; children: ReactNode; first?: string; last?: string; ui?: string }) {
  return (
    <div className="col" style={{ gap: 2 }} data-ui={ui}>
      <span className="row spread" style={{ gap: 6, alignItems: 'flex-start' }}>
        <span style={{ lineHeight: '9px', flex: '1 1 auto', minWidth: 0 }}>{caption}</span>
        {top && <span style={{ lineHeight: '9px', flex: 'none', color: PALETTE.wood }}>{top}</span>}
      </span>
      <div style={{ display: 'flex', alignItems: 'stretch', gap: 1, height, padding: 1, background: PALETTE.ground, boxShadow: `0 0 0 1px ${PALETTE.wood}` }}>{children}</div>
      {(first || last) && (
        <span className="row spread" style={{ color: PALETTE.wood }}>
          <span>{first}</span>
          <span>{last}</span>
        </span>
      )}
    </div>
  );
}

/** Bars from the ground up (two colours when a bar has a second value on top). */
export function BarChart({
  bars,
  height = 40,
  colour = PALETTE.grass,
  overColour = PALETTE.straw,
  caption,
  fmt = (v: number) => String(Math.round(v)),
  first,
  last,
  ui,
}: {
  bars: Bar[];
  height?: number;
  colour?: string;
  overColour?: string;
  caption: ReactNode;
  /** How the tallest bar's value reads, beside the caption. */
  fmt?: (v: number) => string;
  first?: string;
  last?: string;
  ui?: string;
}) {
  const room = height - 2;
  const max = Math.max(1, ...bars.map((b) => b.value + (b.over ?? 0)));
  return (
    <Frame caption={caption} top={bars.length ? `TOP ${fmt(max)}` : undefined} height={height} first={first} last={last} ui={ui}>
      {bars.map((b) => {
        const h = Math.round((b.value / max) * room);
        const o = Math.round(((b.over ?? 0) / max) * room);
        return (
          <span key={b.key} style={{ flex: '1 1 0', minWidth: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }} title={String(b.value)}>
            {o > 0 && <span style={{ height: o, background: overColour, boxShadow: `inset 0 1px 0 ${PALETTE.ink}` }} />}
            {h > 0 && <span style={{ height: h, background: colour, boxShadow: o > 0 ? undefined : `inset 0 1px 0 ${PALETTE.ink}` }} />}
          </span>
        );
      })}
    </Frame>
  );
}

/** Bars up for gains and down for losses, from a zero line placed by the largest of each. */
export function SignedChart({
  bars,
  height = 44,
  caption,
  fmt = (v: number) => String(Math.round(v)),
  first,
  last,
  ui,
}: {
  bars: Bar[];
  height?: number;
  caption: ReactNode;
  fmt?: (v: number) => string;
  first?: string;
  last?: string;
  ui?: string;
}) {
  const room = height - 3;
  const up = Math.max(0, ...bars.map((b) => b.value));
  const down = Math.max(0, ...bars.map((b) => -b.value));
  const span = Math.max(1, up + down);
  const top = Math.round((up / span) * room);
  return (
    <Frame caption={caption} top={bars.length ? `+${fmt(up)} / -${fmt(down)}` : undefined} height={height} first={first} last={last} ui={ui}>
      {bars.map((b) => {
        const h = Math.round((Math.abs(b.value) / span) * room);
        return (
          <span key={b.key} style={{ flex: '1 1 0', minWidth: 1, position: 'relative' }} title={String(b.value)}>
            <span style={{ position: 'absolute', left: 0, right: 0, top, height: 1, background: PALETTE.wood }} />
            {h > 0 && (
              <span
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  top: b.value >= 0 ? top - h : top + 1,
                  height: h,
                  background: b.value >= 0 ? PALETTE.grass : PALETTE.barn,
                }}
              />
            )}
          </span>
        );
      })}
    </Frame>
  );
}

/** A dot per day joined by one-pixel steps; `best` is drawn at the top (rank 1, say), `worst` at the bottom. Days without a value are gaps. */
export function LineChart({
  points,
  best,
  worst,
  height = 40,
  caption,
  first,
  last,
  ui,
}: {
  points: { key: number; value: number | null }[];
  best: number;
  worst: number;
  height?: number;
  caption: ReactNode;
  first?: string;
  last?: string;
  ui?: string;
}) {
  const room = height - 5;
  const y = (v: number) => Math.round(((v - best) / (worst - best || 1)) * room);
  let prev: number | null = null;
  return (
    <Frame caption={caption} top={`${best} TO ${worst}`} height={height} first={first} last={last} ui={ui}>
      {points.map((p) => {
        const at = p.value === null ? null : y(p.value);
        const from = prev;
        prev = at;
        return (
          <span key={p.key} style={{ flex: '1 1 0', minWidth: 3, position: 'relative' }} title={p.value === null ? '' : String(p.value)}>
            {at !== null && from !== null && from !== at && (
              <span style={{ position: 'absolute', left: 0, width: 1, top: Math.min(from, at) + 1, height: Math.abs(from - at) + 1, background: PALETTE.sky }} />
            )}
            {at !== null && <span style={{ position: 'absolute', left: 0, right: 0, margin: '0 auto', width: 3, height: 3, top: at, background: PALETTE.ink }} />}
          </span>
        );
      })}
    </Frame>
  );
}
