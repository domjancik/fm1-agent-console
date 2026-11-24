import type { MidiMessage } from "./framing";
import { assertSafeMidi, type MidiTransport } from "./transport";

type MidiModule = typeof import("@julusian/midi");

let modulePromise: Promise<MidiModule> | undefined;

/** The native binding loads on first use, so importing this package needs no MIDI stack. */
const loadMidi = (): Promise<MidiModule> => (modulePromise ??= import("@julusian/midi"));

export interface MidiPorts {
  inputs: string[];
  outputs: string[];
}

export async function listMidiPorts(): Promise<MidiPorts> {
  const midi = await loadMidi();
  return { inputs: midi.Input.getPortNames(), outputs: midi.Output.getPortNames() };
}

export type CoreMidiOptions =
  /** Open existing ports whose names contain these substrings (case-insensitive). */
  | { kind: "ports"; input: string; output: string }
  /** Create a named virtual source/destination pair (simulator side). */
  | { kind: "virtual"; name: string };

export class MidiPortNotFoundError extends Error {
  constructor(
    readonly direction: "input" | "output",
    readonly wanted: string,
    readonly available: readonly string[],
  ) {
    super(`no MIDI ${direction} matching "${wanted}" (have: ${available.join(", ") || "none"})`);
    this.name = "MidiPortNotFoundError";
  }
}

export function findPort(names: readonly string[], substring: string): number {
  const needle = substring.toLowerCase();
  return names.findIndex((n) => n.toLowerCase().includes(needle));
}

export async function openCoreMidi(options: CoreMidiOptions): Promise<MidiTransport> {
  const midi = await loadMidi();
  const input = new midi.Input();
  const output = new midi.Output();
  try {
    // Drop SysEx, clock and active sensing on input: the protocol uses CCs only.
    input.ignoreTypes(true, true, true);
    if (options.kind === "virtual") {
      input.openVirtualPort(options.name);
      output.openVirtualPort(options.name);
    } else {
      openMatching(input, "input", options.input);
      openMatching(output, "output", options.output);
    }
  } catch (err) {
    input.destroy();
    output.destroy();
    throw err;
  }
  return new CoreMidiTransport(input, output);
}

interface PortLike {
  getPortCount(): number;
  getPortName(i: number): string;
  openPort(i: number): void;
}

function openMatching(port: PortLike, direction: "input" | "output", wanted: string): void {
  const names = Array.from({ length: port.getPortCount() }, (_, i) => port.getPortName(i));
  const index = findPort(names, wanted);
  if (index < 0) throw new MidiPortNotFoundError(direction, wanted, names);
  port.openPort(index);
}

class CoreMidiTransport implements MidiTransport {
  private listeners = new Set<(msg: MidiMessage) => void>();
  private closed = false;

  constructor(
    private readonly input: InstanceType<MidiModule["Input"]>,
    private readonly output: InstanceType<MidiModule["Output"]>,
  ) {
    input.on("message", (_delta: number, msg: number[]) => {
      for (const cb of [...this.listeners]) cb(msg);
    });
  }

  send(bytes: number[]): void {
    assertSafeMidi(bytes);
    if (this.closed) throw new Error("transport closed");
    this.output.sendMessage(bytes);
  }

  onMessage(cb: (msg: MidiMessage) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    this.input.removeAllListeners("message");
    this.input.closePort();
    this.output.closePort();
    this.input.destroy();
    this.output.destroy();
  }
}
