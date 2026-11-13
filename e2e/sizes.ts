// Window sizes for the browser checks. E2E_SIZES=1280x720,1920x1080,390x844 keeps only those (the
// GitHub browser job runs these three); every listed size by default (the full sweep, run locally
// before merging). A check whose sizes all fall outside the filter keeps its first, so it still runs.
export function sizes<T extends readonly [number, number, number]>(list: readonly T[]): T[] {
  const only = process.env.E2E_SIZES?.split(',').map((s) => s.trim());
  if (!only?.length) return [...list];
  const kept = list.filter(([w, h]) => only.includes(`${w}x${h}`));
  return kept.length ? kept : list.slice(0, 1);
}
