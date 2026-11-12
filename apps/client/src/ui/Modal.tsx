// The one modal: a panel inside the modal zone (app/viewport.ts) over a backdrop that dims the whole
// window. Escape, the close button or a click on the backdrop dismiss it.
import { useEffect, useRef, type ReactNode } from 'react';
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
  /** Wanted size in UI pixels; it shrinks to the modal zone. */
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
  const height = Math.min(h, Math.floor(z.h));
  // centred in the zone, on whole UI pixels
  const left = Math.round(z.x + (z.w - width) / 2);
  const top = Math.round(z.y + (z.h - height) / 2);
  return (
    <>
      <div className="backdrop" data-ui="backdrop" onClick={dismiss ? onClose : undefined} />
      <div ref={el} className={`panel modal ${className ?? ''}`} role="dialog" aria-modal="true" data-ui="modal" style={{ left, top, width, height, zIndex: 30 }}>
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
