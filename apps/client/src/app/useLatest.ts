// The newest value, read through a ref. An effect that calls a callback through it never has to list
// the callback as a dependency, so a parent passing a new function on every render (an inline arrow)
// never re-runs the effect: an open animation plays once, when it should, and not again on each render.
import { useLayoutEffect, useRef, type MutableRefObject } from 'react';

export function useLatest<T>(value: T): MutableRefObject<T> {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}
