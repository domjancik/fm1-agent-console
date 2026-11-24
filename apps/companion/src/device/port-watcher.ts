// Keeps the device link bound to a named MIDI port across unplug/replug by polling the port list.
import { systemClock, type Clock, type MidiTransport, type Timer } from "@fm1/device-protocol";
import type { MidiPorts } from "@fm1/device-protocol";
import type { PortDriver } from "./ports";
import { hasExactPort } from "./ports";

export interface PortWatcherTarget {
  attach(transport: MidiTransport, name: string): void;
  detach(): void;
}

export interface BackoffOptions {
  /** First retry delay while the port is absent. */
  minMs: number;
  /** Ceiling for the doubling retry delay. */
  maxMs: number;
  /** Presence check interval while connected. */
  presentMs: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = { minMs: 500, maxMs: 8000, presentMs: 1000 };

export class PortWatcher {
  private transport: MidiTransport | null = null;
  /** The port name actually opened (differs from `name` when `resolve` picked e.g. the " Bluetooth" port). */
  private openName: string;
  private timer: Timer | null = null;
  private delay: number;
  private running = false;
  private readonly backoff: BackoffOptions;
  readonly history: string[] = [];

  constructor(
    private readonly name: string,
    private readonly driver: PortDriver,
    private readonly target: PortWatcherTarget,
    private readonly opts: {
      clock?: Clock;
      backoff?: Partial<BackoffOptions>;
      log?: (text: string) => void;
      /** Picks the port to open from the current list on every poll (a Bluetooth port can appear after start). */
      resolve?: (ports: MidiPorts, name: string) => string;
    } = {},
  ) {
    this.openName = name;
    this.backoff = { ...DEFAULT_BACKOFF, ...opts.backoff };
    this.delay = this.backoff.minMs;
  }

  get attached(): boolean {
    return this.transport !== null;
  }

  /** Current retry delay (exposed for diagnostics and tests). */
  get retryDelayMs(): number {
    return this.delay;
  }

  start(): Promise<void> {
    if (this.running) return Promise.resolve();
    this.running = true;
    return this.tick();
  }

  stop(): void {
    this.running = false;
    this.timer?.cancel();
    this.timer = null;
    this.release("stopped");
  }

  private get clock(): Clock {
    return this.opts.clock ?? systemClock;
  }

  private schedule(ms: number): void {
    if (!this.running) return;
    this.timer = this.clock.schedule(ms, () => {
      this.timer = null;
      void this.tick();
    });
  }

  private note(text: string): void {
    this.history.push(text);
    this.opts.log?.(text);
  }

  private async tick(): Promise<void> {
    let present = false;
    try {
      const ports = await this.driver.list();
      if (!this.transport) this.openName = this.opts.resolve ? this.opts.resolve(ports, this.name) : this.name;
      present = hasExactPort(ports, this.openName);
    } catch (e) {
      this.note(`port list failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!this.running) return;
    if (this.transport && !present) this.release("unplugged");
    if (!this.transport && present) await this.open();
    if (this.transport) {
      this.delay = this.backoff.minMs;
      return this.schedule(this.backoff.presentMs);
    }
    const wait = this.delay;
    this.delay = Math.min(this.backoff.maxMs, this.delay * 2);
    this.schedule(wait);
  }

  private async open(): Promise<void> {
    try {
      const t = await this.driver.open(this.openName);
      if (!this.running) return t.close();
      this.transport = t;
      this.target.attach(t, this.openName);
      this.note(`attached "${this.openName}"`);
    } catch (e) {
      this.note(`open "${this.openName}" failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private release(why: string): void {
    if (!this.transport) return;
    this.target.detach();
    try {
      this.transport.close();
    } catch {
      // A vanished CoreMIDI port may already be gone.
    }
    this.transport = null;
    this.note(`detached "${this.openName}" (${why})`);
  }
}
