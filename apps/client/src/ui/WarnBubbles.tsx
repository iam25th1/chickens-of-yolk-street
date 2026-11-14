// Warnings that belong to something on the farm: a small "!" bubble over that thing (the crate, the
// trough, a worn or broken machine, a full coop), bobbing gently; a tap opens that thing's card, which
// fixes the cause, and the bubble goes as soon as the cause has gone. Hidden while a card or a tour
// step is up. Drawn by code in the UI's own colours (ink, cream, barn red), on whole UI pixels.
import { animate } from 'animejs';
import { useEffect, useRef, useState } from 'react';
import type { FarmState } from '@coys/shared';
import { uiSound, useServices } from '../app/services';
import { viewport } from '../app/viewport';
import { warnings, type WarnTarget, type Warning } from './Guide';

type Box = { kind: string; id?: string; x: number; y: number; w: number; h: number };

const matches = (t: WarnTarget, b: Box) => b.kind === t.kind && (t.kind === 'machine' ? b.id === t.unlock : t.kind === 'coop' ? b.id === t.coopId : true);

function Bubble({ w, at, onOpen }: { w: Warning; at: { x: number; y: number }; onOpen: () => void }) {
  const { audio } = useServices();
  const el = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    const a = animate(node, { translateY: [0, -2], duration: 560, alternate: true, loop: true, ease: 'inOutSine' });
    return () => {
      a.pause();
    };
  }, []);
  return (
    <button
      ref={el}
      className="warn-bubble"
      data-ui="warn-bubble"
      data-warn={w.key}
      title={w.text}
      aria-label={w.text}
      style={{ left: at.x, top: at.y }}
      onClick={() => {
        uiSound(audio, 'click');
        onOpen();
      }}
    >
      !
    </button>
  );
}

export function WarnBubbles({ farm, boxes, hidden, onOpen }: { farm: FarmState; boxes: () => Box[]; hidden: boolean; onOpen: (t: WarnTarget) => void }) {
  const list = warnings(farm).filter((w): w is Warning & { target: WarnTarget } => w.target !== null);
  const [spots, setSpots] = useState<Record<string, { x: number; y: number }>>({});
  const want = list.map((w) => w.key).join(',');
  // where each warned thing is drawn now (the camera moves, hens walk): read a few times a second
  useEffect(() => {
    if (!want) {
      setSpots({});
      return;
    }
    const read = () => {
      const v = viewport.get();
      const s = v.p / v.dpr; // CSS pixels per UI pixel
      const all = boxes();
      const next: Record<string, { x: number; y: number }> = {};
      for (const w of list) {
        const b = all.find((x) => matches(w.target, x));
        if (!b) continue;
        // above the thing's middle, clear of its top (UI pixels)
        next[w.key] = { x: Math.round((b.x + b.w / 2) / s) - 6, y: Math.max(v.zones.top.h + 2, Math.round(b.y / s) - 18) };
      }
      setSpots((old) => (JSON.stringify(old) === JSON.stringify(next) ? old : next));
    };
    read();
    const t = setInterval(read, 250);
    return () => clearInterval(t);
    // the list is rebuilt each render; its keys say when it changed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [want, boxes]);
  if (hidden) return null;
  return (
    <>
      {list.map((w) => {
        const at = spots[w.key];
        return at ? <Bubble key={w.key} w={w} at={at} onOpen={() => onOpen(w.target)} /> : null;
      })}
    </>
  );
}
