import { decode, FrameAssembler, type Message, type MidiMessage, type MidiTransport } from "@fm1/device-protocol";
import type { LogEntry } from "./wire";

/** One-line field summary of a decoded message, e.g. `key=4 gesture=single`. */
export function summarize(msg: Message): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(msg)) {
    if (k === "kind" || k === "from") continue;
    if (k === "flags" && typeof v === "object" && v !== null) {
      const on = Object.entries(v).filter(([, b]) => b === true).map(([n]) => n);
      parts.push(`flags=${on.join("+") || "-"}`);
    } else if (Array.isArray(v)) {
      parts.push(`${k}=${v.map((s) => JSON.stringify(s)).join(",")}`);
    } else {
      parts.push(`${k}=${typeof v === "string" ? JSON.stringify(v) : String(v)}`);
    }
  }
  return parts.join(" ");
}

export function logEntry(dir: LogEntry["dir"], payload: readonly number[], atMs: number): LogEntry {
  const res = decode(payload);
  if (res.ok) {
    const { seq, message } = res.value;
    return { atMs, dir, seq, kind: message.kind, summary: summarize(message) };
  }
  const seq = res.error.frame?.seq ?? (payload.length > 1 ? payload[1] ?? null : null);
  return { atMs, dir, seq, kind: "INVALID", summary: res.error.detail, error: res.error.code };
}

/**
 * Wraps a transport and reports every complete frame in both directions, without
 * changing what the link sees. It subscribes to the inner transport once.
 */
export class TappedTransport implements MidiTransport {
  private readonly tx = new FrameAssembler("device");
  private readonly rx = new FrameAssembler("host");
  private readonly listeners = new Set<(msg: MidiMessage) => void>();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly inner: MidiTransport,
    private readonly onFrame: (dir: LogEntry["dir"], payload: number[]) => void,
  ) {
    this.unsubscribe = inner.onMessage((m) => {
      const payload = this.rx.push(m);
      if (payload) this.onFrame("rx", payload);
      for (const cb of [...this.listeners]) cb(m);
    });
  }

  send(bytes: number[]): void {
    // Assemble before sending: a synchronous peer may reply (and we may ACK) inside send().
    const payload = this.tx.push(bytes);
    if (payload) this.onFrame("tx", payload);
    this.inner.send(bytes);
  }

  onMessage(cb: (msg: MidiMessage) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  close(): void {
    this.unsubscribe();
    this.listeners.clear();
    this.inner.close();
  }
}
