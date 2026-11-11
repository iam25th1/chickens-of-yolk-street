import { useSyncExternalStore } from 'react';

export interface Store<T> {
  get(): T;
  set(patch: Partial<T> | ((s: T) => Partial<T>)): void;
  subscribe(fn: () => void): () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const subs = new Set<() => void>();
  return {
    get: () => state,
    set(patch) {
      const next = typeof patch === 'function' ? patch(state) : patch;
      state = { ...state, ...next };
      for (const fn of subs) fn();
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

/** Selects a slice; the selector must return existing references (or primitives). */
export function useStore<T extends object, S>(store: Store<T>, select: (s: T) => S): S {
  return useSyncExternalStore(store.subscribe, () => select(store.get()));
}

export class Emitter<E> {
  private readonly subs = new Set<(e: E) => void>();
  on(fn: (e: E) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
  emit(e: E): void {
    for (const fn of this.subs) fn(e);
  }
}
