export interface Timer {
  cancel(): void;
}

/** Time source and one-shot timers, injectable so link logic is deterministic in tests. */
export interface Clock {
  now(): number;
  schedule(ms: number, fn: () => void): Timer;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  schedule(ms, fn) {
    const handle = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(handle) };
  },
};

interface Pending {
  id: number;
  at: number;
  fn: () => void;
}

/** Manual clock: timers fire only inside `advance`, in due-time order. */
export class FakeClock implements Clock {
  private t: number;
  private nextId = 0;
  private timers: Pending[] = [];

  constructor(start = 0) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  schedule(ms: number, fn: () => void): Timer {
    const timer: Pending = { id: this.nextId++, at: this.t + Math.max(0, ms), fn };
    this.timers.push(timer);
    return { cancel: () => this.remove(timer.id) };
  }

  get pendingTimers(): number {
    return this.timers.length;
  }

  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      const due = this.earliest();
      if (!due || due.at > target) break;
      this.remove(due.id);
      this.t = due.at;
      due.fn();
    }
    this.t = target;
  }

  private earliest(): Pending | undefined {
    let best: Pending | undefined;
    for (const p of this.timers) {
      if (!best || p.at < best.at || (p.at === best.at && p.id < best.id)) best = p;
    }
    return best;
  }

  private remove(id: number): void {
    this.timers = this.timers.filter((p) => p.id !== id);
  }
}
