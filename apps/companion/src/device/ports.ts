// MIDI port choice. The real FM-1 console port is matched by exact name, so the simulator's
// "FM1 CONSOLE (sim)" (or anything else containing the name) is never mistaken for hardware.
import { findPort, listMidiPorts, openCoreMidi, type MidiPorts, type MidiTransport } from "@fm1/device-protocol";

export const REAL_PORT_NAME = "FM1 CONSOLE";
export const SIM_PORT_NAME = "FM1 CONSOLE (sim)";
/** fm1-emu `fm1-live --usb` running the real firmware package (firmware/tests/console/run_emu.sh). */
export const EMU_PORT_NAME = "FM1 CONSOLE (emu)";

export type PortTarget = "real" | "sim";

export const portNameFor = (t: PortTarget): string => (t === "real" ? REAL_PORT_NAME : SIM_PORT_NAME);

/** True when both directions of exactly `name` exist. */
export function hasExactPort(ports: MidiPorts, name: string): boolean {
  return ports.inputs.includes(name) && ports.outputs.includes(name);
}

/** CoreMIDI names a Bluetooth MIDI device's port "<device name> Bluetooth" ("FM1 CONSOLE 19E2 Bluetooth"),
 * while Audio MIDI Setup shows the device name. Accept either: the exact name wins, else the suffixed one. */
export function resolveDevicePort(ports: MidiPorts, name: string): string {
  if (hasExactPort(ports, name)) return name;
  const bt = `${name} Bluetooth`;
  return hasExactPort(ports, bt) ? bt : name;
}

export interface PortClassification {
  real: boolean;
  sim: boolean;
  /** Names that contain "FM1 CONSOLE" but are neither (shown by doctor, never opened). */
  other: string[];
}

export function classifyPorts(ports: MidiPorts): PortClassification {
  const all = [...new Set([...ports.inputs, ...ports.outputs])];
  return {
    real: hasExactPort(ports, REAL_PORT_NAME),
    sim: hasExactPort(ports, SIM_PORT_NAME),
    other: all.filter((n) => n.toUpperCase().includes(REAL_PORT_NAME) && n !== REAL_PORT_NAME && n !== SIM_PORT_NAME && n !== EMU_PORT_NAME),
  };
}

export class AmbiguousPortError extends Error {
  constructor(name: string, picked: string) {
    super(`port "${name}" would resolve to "${picked}"; refusing to open a port that is not an exact match`);
    this.name = "AmbiguousPortError";
  }
}

/**
 * device-protocol opens the first port whose name contains the wanted string. We check first
 * that this first match is the exact name in both directions, so nothing else is ever opened.
 */
export function checkExact(ports: MidiPorts, name: string): void {
  for (const names of [ports.inputs, ports.outputs]) {
    const i = findPort(names, name);
    const picked = i < 0 ? undefined : names[i];
    if (picked === undefined) throw new Error(`MIDI port "${name}" not present`);
    if (picked !== name) throw new AmbiguousPortError(name, picked);
  }
}

export interface PortDriver {
  list(): Promise<MidiPorts>;
  open(name: string): Promise<MidiTransport>;
}

export const coreMidiDriver: PortDriver = {
  list: listMidiPorts,
  async open(name) {
    checkExact(await listMidiPorts(), name);
    return openCoreMidi({ kind: "ports", input: name, output: name });
  },
};
