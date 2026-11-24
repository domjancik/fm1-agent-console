import { FakeClock, type ButtonId, type EncoderId } from "@fm1/device-protocol";
import type { SimDevice } from "./device";
import { GESTURE_TIMING } from "./gestures";
import type { DeviceState } from "./state";

/** How the driver lets time pass: advance a fake clock, or wait in real time. */
export interface Sleeper {
  sleep(ms: number): Promise<void>;
}

export const realSleeper: Sleeper = { sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

/** Advances `clock` in small steps so timers interleave as they would in real time. */
export function fakeSleeper(clock: FakeClock, stepMs = 10): Sleeper {
  return {
    async sleep(ms) {
      let left = ms;
      while (left > 0) {
        const step = Math.min(stepMs, left);
        clock.advance(step);
        left -= step;
        // Let promise continuations (e.g. host handlers) run between steps.
        await Promise.resolve();
      }
    },
  };
}

export class WaitTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`condition not met within ${timeoutMs} ms`);
    this.name = "WaitTimeoutError";
  }
}

export type PressKind = "single" | "double" | "long";

/**
 * Headless driver for end-to-end tests: performs physical actions on a SimDevice with
 * the same timing a person would, and waits for host-driven state.
 */
export class ScriptedDriver {
  readonly sleeper: Sleeper;

  constructor(
    readonly device: SimDevice,
    sleeper?: Sleeper,
  ) {
    this.sleeper = sleeper ?? (device.clock instanceof FakeClock ? fakeSleeper(device.clock) : realSleeper);
  }

  /**
   * Presses a key and waits until the gesture has been reported: a single press waits out
   * the double window, a long press holds past the long threshold.
   */
  async press(key: number, kind: PressKind = "single"): Promise<void> {
    const tap = 40;
    const s = this.sleeper;
    if (kind === "long") {
      this.device.keyDown(key);
      await s.sleep(GESTURE_TIMING.longMs + 50);
      this.device.keyUp(key);
      return;
    }
    this.device.keyDown(key);
    await s.sleep(tap);
    this.device.keyUp(key);
    if (kind === "double") {
      await s.sleep(tap);
      this.device.keyDown(key);
      await s.sleep(tap);
      this.device.keyUp(key);
      return;
    }
    await s.sleep(GESTURE_TIMING.doubleMs + 20);
  }

  /** Holds a button for `ms` (e.g. REC push-to-talk), sending down then up edges. */
  async hold(button: ButtonId, ms: number): Promise<void> {
    this.device.button(button, true);
    await this.sleeper.sleep(ms);
    this.device.button(button, false);
  }

  /** A short press of a button. */
  tap(button: ButtonId): Promise<void> {
    return this.hold(button, 40);
  }

  turn(encoder: EncoderId, delta: number): void {
    this.device.turn(encoder, delta);
  }

  /** Resolves with the state once `predicate` holds; rejects with WaitTimeoutError. */
  async waitFor(predicate: (s: DeviceState) => boolean, timeoutMs = 2000): Promise<DeviceState> {
    if (predicate(this.device.state)) return this.device.state;
    const fake = this.device.clock instanceof FakeClock;
    if (fake) {
      for (let waited = 0; waited < timeoutMs; waited += 10) {
        await this.sleeper.sleep(10);
        if (predicate(this.device.state)) return this.device.state;
      }
      throw new WaitTimeoutError(timeoutMs);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new WaitTimeoutError(timeoutMs));
      }, timeoutMs);
      const off = this.device.on("state", (s) => {
        if (!predicate(s)) return;
        clearTimeout(timer);
        off();
        resolve(s);
      });
    });
  }
}
