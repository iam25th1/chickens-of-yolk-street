// The one modal: a panel inside the modal zone (app/viewport.ts) over a backdrop that dims the whole
// window. Escape, the close button or a click on the backdrop dismiss it.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { uiSound, useServices } from '../app/services';
import { useViewport } from '../app/Stage';
import { motion } from '../motion/ui';

export function Modal({
  title,
  onClose,
  children,
  w,
  h,
  className,
  dismiss = true,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** Largest size in UI pixels (it shrinks to the modal zone; the height follows the content). */
  w: number;
  h: number;
  className?: string;
  /** A click on the backdrop closes it (cards keep the backdrop inert). */
  dismiss?: boolean;
}) {
  const { audio } = useServices();
  const v = useViewport();
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (el.current) motion.enter(el.current);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const z = v.zones.modal;
  const width = Math.min(w, Math.floor(z.w));
  const maxH = Math.min(h, Math.floor(z.h));
  // the panel is as tall as its content; it is centred on whole UI pixels once measured
  const [height, setHeight] = useState(maxH);
  useLayoutEffect(() => {
    const panel = el.current;
    if (!panel) return;
    const fit = () => setHeight(Math.min(maxH, Math.ceil(panel.scrollHeight)));
    fit();
    const ro = new ResizeObserver(fit);
    const body = panel.querySelector('.modal-body');
    if (body?.firstElementChild) for (const c of body.children) ro.observe(c);
    return () => ro.disconnect();
  }, [maxH, children]);
  const left = Math.round(z.x + (z.w - width) / 2);
  const top = Math.round(z.y + (z.h - height) / 2);
  return (
    <>
      <div className="backdrop" data-ui="backdrop" onClick={dismiss ? onClose : undefined} />
      <div ref={el} className={`panel modal ${className ?? ''}`} role="dialog" aria-modal="true" data-ui="modal" style={{ left, top, width, maxHeight: maxH, zIndex: 30 }}>
        <div className="modal-head">
          <h2 className="panel-title" style={{ margin: 0 }}>
            {title}
          </h2>
          <button
            className="btn"
            aria-label="Close"
            data-tour="close"
            onMouseEnter={() => uiSound(audio, 'hover')}
            onClick={() => {
              uiSound(audio, 'back');
              onClose();
            }}
          >
            X
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </>
  );
}
