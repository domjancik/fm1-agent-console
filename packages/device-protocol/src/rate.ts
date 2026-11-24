import type { Clock, Timer } from "./clock";
import { TIMING } from "./constants";
import type { SetSlot } from "./messages";

/**
 * Runs jobs in order at no more than `perSecond` per second. With the default
 * `burst` of 1 jobs are evenly spaced, so no 1 s window holds more than `perSecond`
 * jobs; a larger burst lets that many run back to back. Infinity disables pacing.
 */
export class PacedQueue {
  private tokens: number;
  private last: number;
  private queue: (() => void)[] = [];
  /** Urgent jobs at the head of `queue` (FIFO among themselves). */
  private urgentHead = 0;
  private timer: Timer | undefined;

  constructor(
    private readonly clock: Clock,
    private readonly perSecond: number,
    private readonly burst = 1,
  ) {
    this.tokens = burst;
    this.last = clock.now();
  }

  /**
   * `urgent` jobs (ACKs) go ahead of every queued job, still within the rate: a burst of state frames must not hold
   * an ACK back past the peer's 250 ms retransmit (the retransmitted input would run twice once the 32-entry
   * duplicate window has filled with the burst's ACKs).
   */
  run(job: () => void, urgent = false): void {
    // Urgent jobs keep their own order (behind earlier urgent jobs, ahead of every normal one).
    if (urgent) this.queue.splice(this.urgentHead++, 0, job);
    else this.queue.push(job);
    this.drain();
  }

  get queued(): number {
    return this.queue.length;
  }

  clear(): void {
    this.queue = [];
    this.urgentHead = 0;
    this.timer?.cancel();
    this.timer = undefined;
  }

  private refill(): void {
    const now = this.clock.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) * this.perSecond) / 1000);
    this.last = now;
  }

  private drain(): void {
    if (this.timer) return;
    while (this.queue.length > 0) {
      if (this.perSecond !== Infinity) {
        this.refill();
        if (this.tokens < 1) {
          const wait = Math.ceil(((1 - this.tokens) * 1000) / this.perSecond);
          this.timer = this.clock.schedule(wait, () => {
            this.timer = undefined;
            this.drain();
          });
          return;
        }
        this.tokens -= 1;
      }
      if (this.urgentHead > 0) this.urgentHead--;
      this.queue.shift()?.();
    }
  }
}

/**
 * Coalesces SET_SLOT updates per key: the first update after a quiet period goes out
 * at once, later ones within `intervalMs` collapse to the newest state per key.
 */
export class SlotCoalescer {
  private pending = new Map<number, SetSlot>();
  private timer: Timer | undefined;
  private lastFlush = -Infinity;

  constructor(
    private readonly clock: Clock,
    private readonly flush: (slots: SetSlot[]) => void,
    private readonly intervalMs: number = TIMING.slotCoalesceMs,
  ) {}

  push(slot: SetSlot): void {
    this.pushAll([slot]);
  }

  /**
   * Queues several updates as one: they leave in the same flush. A selection move is a deselect plus a select, and a
   * device drawing between the two would show no selection (the LIST layout's window would jump; docs/ui-v3.md 8.3).
   */
  pushAll(slots: readonly SetSlot[]): void {
    if (slots.length === 0) return;
    for (const slot of slots) this.pending.set(slot.key, slot);
    if (this.timer) return;
    const wait = this.lastFlush + this.intervalMs - this.clock.now();
    if (wait <= 0) {
      this.flushNow();
      return;
    }
    this.timer = this.clock.schedule(wait, () => {
      this.timer = undefined;
      this.flushNow();
    });
  }

  /** Drops pending updates (for example before a full resync). */
  cancel(): void {
    this.pending.clear();
    this.timer?.cancel();
    this.timer = undefined;
  }

  private flushNow(): void {
    if (this.pending.size === 0) return;
    const slots = [...this.pending.values()].sort((a, b) => a.key - b.key);
    this.pending.clear();
    this.lastFlush = this.clock.now();
    this.flush(slots);
  }
}
