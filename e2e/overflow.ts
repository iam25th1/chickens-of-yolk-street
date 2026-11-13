// What the browser checks look for, run in the page: anything that scrolls, anything cut off by
// its box or by the window, and a page that scrolls. Shared by the no-scroll and mint checks.
/**
 * Run in the page: every element that scrolls (overflow auto or scroll, with more content than room),
 * every element that clips content (overflow hidden, or an ellipsis, with a piece of text, a button
 * or a picture reaching past its edge), and the page itself if it scrolls. A marquee ([data-marquee],
 * the price ticker) runs its text past on purpose and is left out.
 */
export function overflowing(): string[] {
  const out: string[] = [];
  const isContent = (e: Element): boolean => {
    if (e.closest('[data-marquee]')) return false;
    if (/^(BUTTON|INPUT|IMG|A)$/.test(e.tagName) || (e.tagName === 'CANVAS' && e.classList.contains('sprite'))) return true;
    for (const n of e.childNodes) if (n.nodeType === 3 && (n.textContent ?? '').trim()) return true;
    return false;
  };
  /** Where a content element really draws: its own box, or for text the text itself (a centred line is narrower than its box). */
  const drawn = (e: Element): DOMRect => {
    if (/^(BUTTON|INPUT|IMG|A|CANVAS)$/.test(e.tagName)) return e.getBoundingClientRect();
    const range = document.createRange();
    let rect: DOMRect | null = null;
    for (const n of e.childNodes) {
      if (n.nodeType !== 3 || !(n.textContent ?? '').trim()) continue;
      range.selectNodeContents(n);
      const r = range.getBoundingClientRect();
      rect = rect ? new DOMRect(Math.min(rect.left, r.left), Math.min(rect.top, r.top), Math.max(rect.right, r.right) - Math.min(rect.left, r.left), Math.max(rect.bottom, r.bottom) - Math.min(rect.top, r.top)) : r;
    }
    return rect ?? e.getBoundingClientRect();
  };
  const shown = (e: Element): boolean => {
    const cs = getComputedStyle(e);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0;
  };
  for (const el of document.querySelectorAll<HTMLElement>('body *')) {
    if (el.tagName === 'CANVAS' || el.closest('[data-marquee]')) continue;
    if (!shown(el)) continue;
    const cs = getComputedStyle(el);
    const sy = el.scrollHeight - el.clientHeight;
    const sx = el.scrollWidth - el.clientWidth;
    if (sy <= 1 && sx <= 1) continue;
    const ov = `${cs.overflowX} ${cs.overflowY}`;
    const name = (el.dataset.ui ?? el.dataset.tour ?? (String(el.className) || el.tagName)).slice(0, 32);
    if (/auto|scroll/.test(ov)) {
      out.push(`SCROLLS ${name}${sx > 1 ? ` x+${sx}` : ''}${sy > 1 ? ` y+${sy}` : ''} "${(el.textContent ?? '').trim().slice(0, 32)}"`);
      continue;
    }
    if (!/hidden|clip/.test(ov) && cs.textOverflow !== 'ellipsis') continue;
    // which content pokes out of this box
    const box = el.getBoundingClientRect();
    if (cs.textOverflow === 'ellipsis' && isContent(el)) {
      out.push(`CUTS ${name} "${(el.textContent ?? '').trim().slice(0, 40)}"`);
      continue;
    }
    for (const c of el.querySelectorAll('*')) {
      if (!isContent(c) || !shown(c)) continue;
      const r = drawn(c);
      if (r.width === 0 || r.height === 0) continue;
      if (r.left < box.left - 1 || r.right > box.right + 1 || r.top < box.top - 1 || r.bottom > box.bottom + 1) {
        out.push(`CLIPS ${name}: "${(c.textContent ?? c.tagName).trim().slice(0, 40)}" at ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)} in ${Math.round(box.left)},${Math.round(box.top)} ${Math.round(box.width)}x${Math.round(box.height)}`);
        break;
      }
    }
  }
  // nothing is cut by the window either
  for (const c of document.querySelectorAll('body *')) {
    if (!isContent(c) || !shown(c)) continue;
    const r = drawn(c);
    if (r.width === 0 || r.height === 0) continue;
    if (r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1) {
      out.push(`OFF SCREEN "${(c.textContent ?? c.tagName).trim().slice(0, 40)}" at ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
  }
  const d = document.scrollingElement;
  if (d && (d.scrollHeight > innerHeight + 1 || d.scrollWidth > innerWidth + 1)) out.push(`PAGE SCROLLS x+${d.scrollWidth - innerWidth} y+${d.scrollHeight - innerHeight}`);
  return out;
}
