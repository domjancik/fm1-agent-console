import type { Clock, Gesture, Timer } from "@fm1/device-protocol";

export const GESTURE_TIMING = {
  /** Held at least this long is a long press. */
  longMs: 600,
  /** A second down within this long of the first up is a double press. */
  doubleMs: 300,
} as const;

interface KeyTrack {
  held: boolean;
  /** The current press is the second of a double. */
  second: boolean;
  longFired: boolean;
  longTimer?: Timer;
  /** Open double window after a first up; firing it emits `single`. */
  windowTimer?: Timer;
}

/**
 * Per-key gesture timing as the firmware does it (docs/protocol.md section 4): `down`/`up`
 * always; `long` once the key has been held 600 ms; `double` on the second up when the
 * second down came within 300 ms of the first up; otherwise `single` when the window closes.
 */
export class GestureTracker {
  private readonly keys = new Map<number, KeyTrack>();

  constructor(
    private readonly clock: Clock,
    private readonly emit: (key: number, gesture: Gesture) => void,
  ) {}

  down(key: number): void {
    const k = this.track(key);
    if (k.held) return;
    k.held = true;
    k.longFired = false;
    k.second = k.windowTimer !== undefined;
    k.windowTimer?.cancel();
    k.windowTimer = undefined;
    this.emit(key, "down");
    if (k.second) return;
    k.longTimer = this.clock.schedule(GESTURE_TIMING.longMs, () => {
      k.longTimer = undefined;
      if (!k.held) return;
      k.longFired = true;
      this.emit(key, "long");
    });
  }

  up(key: number): void {
    const k = this.track(key);
    if (!k.held) return;
    k.held = false;
    k.longTimer?.cancel();
    k.longTimer = undefined;
    this.emit(key, "up");
    if (k.longFired) return;
    if (k.second) {
      k.second = false;
      this.emit(key, "double");
      return;
    }
    // The window is inclusive: a second down exactly 300 ms after the up is still a double.
    k.windowTimer = this.clock.schedule(GESTURE_TIMING.doubleMs + 1, () => {
      k.windowTimer = undefined;
      this.emit(key, "single");
    });
  }

  isHeld(key: number): boolean {
    return this.keys.get(key)?.held ?? false;
  }

  /** Drops all timers (device shutdown). */
  reset(): void {
    for (const k of this.keys.values()) {
      k.longTimer?.cancel();
      k.windowTimer?.cancel();
    }
    this.keys.clear();
  }

  private track(key: number): KeyTrack {
    let k = this.keys.get(key);
    if (!k) {
      k = { held: false, second: false, longFired: false };
      this.keys.set(key, k);
    }
    return k;
  }
}
