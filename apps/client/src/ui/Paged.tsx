// Content that always fits its panel, in pages instead of a scrollbar. Each item (a block of the
// list, or a cell of a grid) is measured as it is drawn; the items are packed into pages that fit
// the room the panel has left (the closest [data-room] ancestor says how tall it may grow), with
// previous and next controls when there is more than one page. The room is read again on every
// resize, so the same content splits differently at every window size, and nothing is ever cut off.
import { Fragment, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { uiSound, useServices } from '../app/services';
import { useViewport } from '../app/Stage';

/** The height (UI pixels) the controls row takes, with its gap above. */
const NAV_H = 18;

/** How tall the closest [data-room] host may grow, and how much of that its content leaves free. */
function freeRoom(el: HTMLElement): number {
  const host = el.parentElement?.closest<HTMLElement>('[data-room]');
  if (!host) return Infinity;
  const room = Number(host.dataset.room);
  if (!Number.isFinite(room) || room <= 0) return Infinity;
  return room - host.scrollHeight;
}

/** Greedy pages: as many items in a row as fit the budget (never fewer than one). */
export function packPages(heights: number[], gap: number, budget: number): number[][] {
  const pages: number[][] = [];
  let cur: number[] = [];
  let used = 0;
  heights.forEach((h, i) => {
    const add = (cur.length ? gap : 0) + h;
    if (cur.length && used + add > budget) {
      pages.push(cur);
      cur = [i];
      used = h;
    } else {
      cur.push(i);
      used += add;
    }
  });
  if (cur.length || !pages.length) pages.push(cur);
  return pages;
}

/** Items per page of a grid of fixed cells in a given width and height (at least one). */
export function gridPage(cell: { w: number; h: number }, gap: number, width: number, height: number): { cols: number; rows: number; per: number } {
  const cols = Math.max(1, Math.floor((width + gap) / (cell.w + gap)));
  const rows = Math.max(1, Math.floor((height + gap) / (cell.h + gap)));
  return { cols, rows, per: cols * rows };
}

export function Paged({
  items,
  gap = 3,
  cell,
  label,
  onPrevEdge,
  onNextEdge,
  resetKey,
  fill = false,
  style,
  ui,
}: {
  items: ReactNode[];
  gap?: number;
  /** A grid of same-size cells instead of a column of blocks: this size (UI pixels), or 'auto' to measure the first cell. */
  cell?: { w: number; h: number } | 'auto';
  /** Shown between the controls when there is a single page (a section counter, say). */
  label?: string;
  /** Called by PREV on the first page and NEXT on the last (the guide steps to the next section). */
  onPrevEdge?: () => void;
  onNextEdge?: () => void;
  /** A change of this value goes back to the first page. */
  resetKey?: unknown;
  /** Take the height a flex parent gives (flex: 1) and fit the pages to it, instead of growing the panel. */
  fill?: boolean;
  style?: CSSProperties;
  ui?: string;
}) {
  const { audio } = useServices();
  const v = useViewport();
  const self = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const [pages, setPages] = useState<number[][]>(() => [items.map((_, i) => i)]);
  const [at, setAt] = useState(0);
  const tries = useRef(0);
  const sig = `${items.length}|${v.uiW}x${v.uiH}|${String(resetKey)}`;
  const lastSig = useRef(sig);
  if (lastSig.current !== sig) {
    lastSig.current = sig;
    tries.current = 0;
  }
  useLayoutEffect(() => {
    setAt(0);
  }, [resetKey]);

  useLayoutEffect(() => {
    const el = self.current;
    const m = measure.current;
    if (!el || !m) return;
    // a layout that keeps changing its mind stops after a few tries (until the size or items change)
    if (tries.current > 6) return;
    const budget = fill ? el.clientHeight : el.offsetHeight + freeRoom(el);
    let next: number[][];
    if (cell) {
      const first = el.firstElementChild?.firstElementChild as HTMLElement | null | undefined;
      const size = cell === 'auto' ? (first ? { w: first.offsetWidth, h: first.offsetHeight } : null) : cell;
      if (!size || !size.w || !size.h) return;
      const width = el.clientWidth;
      const all = gridPage(size, gap, width, Infinity);
      const rowsAll = Math.ceil(items.length / all.cols);
      const fullH = rowsAll * size.h + Math.max(0, rowsAll - 1) * gap;
      if (fullH <= budget) next = [items.map((_, i) => i)];
      else {
        const { per } = gridPage(size, gap, width, budget - NAV_H);
        next = [];
        for (let i = 0; i < items.length; i += per) next.push(items.slice(i, i + per).map((_, j) => i + j));
        if (!next.length) next = [[]];
      }
    } else {
      const heights = [...m.children].map((c) => (c as HTMLElement).offsetHeight);
      const total = heights.reduce((s, h) => s + h, 0) + Math.max(0, heights.length - 1) * gap;
      const edges = onPrevEdge !== undefined || onNextEdge !== undefined;
      next = total <= budget - (edges ? NAV_H : 0) ? [items.map((_, i) => i)] : packPages(heights, gap, budget - NAV_H);
    }
    const same = next.length === pages.length && next.every((p, i) => p.length === pages[i]?.length && p[0] === pages[i]?.[0]);
    if (!same) {
      tries.current++;
      setPages(next);
    }
  }, [cell, pages, gap, items, onPrevEdge, onNextEdge, fill, v.uiW, v.uiH]);

  const n = pages.length;
  const page = Math.min(at, n - 1);
  // a narrow panel (the side panel's desk) gets the short controls: < 1/2 >
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const w = self.current?.clientWidth ?? 0;
    if (w > 0 && w < 220 !== narrow) setNarrow(w < 220);
  }, [narrow, v.uiW, v.uiH]);
  const shown = pages[page] ?? [];
  const edges = onPrevEdge !== undefined || onNextEdge !== undefined;
  const nav = n > 1 || edges;
  const go = (d: number) => {
    uiSound(audio, 'click');
    if (page + d < 0) onPrevEdge?.();
    else if (page + d >= n) onNextEdge?.();
    else setAt(page + d);
  };
  const box: CSSProperties = cell ? { display: 'flex', flexWrap: 'wrap', gap, alignContent: 'flex-start' } : { display: 'flex', flexDirection: 'column', gap };
  return (
    <div
      ref={self}
      className="paged"
      data-ui={ui}
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        ...(fill ? { flex: 1, minHeight: 0, overflow: 'hidden', justifyContent: 'space-between' } : {}),
        ...style,
      }}
    >
      <div style={box}>
        {shown.map((i) => (
          <Fragment key={i}>{items[i]}</Fragment>
        ))}
      </div>
      {nav && (
        <div
          className="row"
          style={{
            gap: 6,
            alignItems: 'center',
            justifyContent: 'center',
            height: NAV_H - 4,
            flex: 'none',
          }}
          data-ui="pager"
        >
          <button className="btn" aria-label="Previous page" data-ui="page-prev" disabled={page === 0 && !onPrevEdge} onClick={() => go(-1)}>
            {narrow ? '<' : '< PREV'}
          </button>
          <span data-ui="page-label" style={{ whiteSpace: 'nowrap' }}>
            {n > 1 ? (narrow ? `${page + 1}/${n}` : `PAGE ${page + 1} OF ${n}${label ? ` (${label})` : ''}`) : (label ?? '')}
          </span>
          <button className="btn" aria-label="Next page" data-ui="page-next" disabled={page >= n - 1 && !onNextEdge} onClick={() => go(1)}>
            {narrow ? '>' : 'NEXT >'}
          </button>
        </div>
      )}
      {!cell && (
        <div ref={measure} className="paged-measure" aria-hidden="true">
          {items.map((it, i) => (
            // flow-root keeps an item's own margins inside its measured height
            <div key={i} style={{ display: 'flow-root' }}>
              {it}
            </div>
          ))}
        </div>
      )}
      {cell && <div ref={measure} hidden />}
    </div>
  );
}
