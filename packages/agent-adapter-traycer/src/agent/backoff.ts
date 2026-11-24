/**
 * Exponential backoff: `initialMs * factor^attempt`, capped at `maxMs`.
 * Deterministic unless a jitter function is supplied, so tests can assert
 * exact delays.
 */
export interface BackoffPolicy {
  readonly initialMs: number;
  readonly maxMs: number;
  readonly factor: number;
  /** Maps a computed delay to the delay actually used (e.g. full jitter). */
  readonly jitter?: (delayMs: number) => number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = { initialMs: 500, maxMs: 30_000, factor: 2 };

export class Backoff {
  private attempt = 0;

  constructor(private readonly policy: BackoffPolicy = DEFAULT_BACKOFF) {}

  /** Delay before the next attempt; advances the attempt counter. */
  next(): number {
    const raw = Math.min(this.policy.maxMs, this.policy.initialMs * this.policy.factor ** this.attempt);
    this.attempt += 1;
    const delay = this.policy.jitter ? this.policy.jitter(raw) : raw;
    return Math.max(0, Math.min(this.policy.maxMs, delay));
  }

  get attempts(): number {
    return this.attempt;
  }

  reset(): void {
    this.attempt = 0;
  }
}
