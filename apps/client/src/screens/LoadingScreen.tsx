// Loading: the loading plate with drifting clouds and hens (canvas), and an egg that fills up.
import { useEffect, useRef } from 'react';
import { motion } from '../motion/ui';

/** Row widths of a 20x26 pixel egg, top to bottom. */
const EGG_ROWS = [6, 10, 12, 14, 14, 16, 16, 18, 18, 18, 20, 20, 20, 20, 20, 20, 20, 20, 18, 18, 18, 16, 14, 12, 10, 6];
const W = 22;
const H = EGG_ROWS.length + 2;

function EggBar({ progress }: { progress: number }) {
  const filled = Math.round(progress * EGG_ROWS.length);
  const rows = EGG_ROWS.map((w, y) => ({ x: (W - w) / 2, y: y + 1, w }));
  return (
    <svg width={W * 2} height={H * 2} viewBox={`0 0 ${W} ${H}`} shapeRendering="crispEdges" role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
      {rows.map((r) => (
        <rect key={`o${r.y}`} x={r.x - 1} y={r.y - 1} width={r.w + 2} height={3} fill="#2a160c" />
      ))}
      {rows.map((r) => (
        <rect key={`c${r.y}`} x={r.x} y={r.y} width={r.w} height={1} fill="#f6e7c1" />
      ))}
      {rows
        .filter((_, i) => i >= EGG_ROWS.length - filled)
        .map((r) => (
          <rect key={`f${r.y}`} x={r.x} y={r.y} width={r.w} height={1} fill="#f2c94c" />
        ))}
      {rows
        .filter((_, i) => i === EGG_ROWS.length - filled)
        .map((r) => (
          <rect key={`l${r.y}`} x={r.x} y={r.y} width={r.w} height={1} fill="#d9a63a" />
        ))}
      <rect x={7} y={5} width={2} height={4} fill="#ffffff" />
    </svg>
  );
}

export function LoadingScreen({ progress, label }: { progress: number; label: string }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (box.current) motion.enter(box.current);
  }, []);
  return (
    <div className="layer">
      <div
        ref={box}
        style={{ position: 'absolute', left: 260, top: 236, width: 120, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}
      >
        <EggBar progress={progress} />
        <div className="shadowed" style={{ color: '#f6e7c1', textAlign: 'center' }}>
          {label} {Math.round(progress * 100)}%
        </div>
      </div>
    </div>
  );
}
