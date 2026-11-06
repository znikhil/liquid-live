// A minimal observable state holder that React reads with useSyncExternalStore,
// so call logic lives in plain classes and components only render.

import { useSyncExternalStore } from "react";

export class Store<T extends object> {
  #state: T;
  readonly #listeners = new Set<() => void>();

  constructor(initial: T) {
    this.#state = initial;
  }

  get state(): T {
    return this.#state;
  }

  protected patch(change: Partial<T>) {
    this.#state = { ...this.#state, ...change };
    for (const listener of this.#listeners) listener();
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
}

export function useStore<T extends object>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, () => store.state);
}
