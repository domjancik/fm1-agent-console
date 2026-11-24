import { LoopbackPair, openCoreMidi, type MidiTransport } from "@fm1/device-protocol";

/** Name of the simulator's CoreMIDI virtual source/destination pair. */
export const VIRTUAL_PORT_NAME = "FM1 CONSOLE (sim)";

/**
 * Creates the simulator's own virtual port pair, so a companion opens it by name exactly
 * as it opens the hardware. It never opens an existing port, so the real FM-1 is untouched.
 */
export function openVirtualMidi(name = VIRTUAL_PORT_NAME): Promise<MidiTransport> {
  return openCoreMidi({ kind: "virtual", name });
}

/** In-process pair: `device` goes to the SimDevice, `host` to a host Link (tests, demo). */
export const loopback = (): LoopbackPair => new LoopbackPair();
