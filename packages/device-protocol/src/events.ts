type Listener<A> = (arg: A) => void;

/** Minimal typed event emitter: one argument per event. */
export class Emitter<E extends object> {
  private listeners = new Map<keyof E, Set<Listener<never>>>();

  on<K extends keyof E>(event: K, fn: Listener<E[K]>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn);
    return () => set.delete(fn);
  }

  protected emit<K extends keyof E>(event: K, arg: E[K]): void {
    const set = this.listeners.get(event) as Set<Listener<E[K]>> | undefined;
    if (!set) return;
    for (const fn of [...set]) fn(arg);
  }
}
