#!/usr/bin/env bun
import { parseArgs } from "node:util";
import type { MidiTransport } from "@fm1/device-protocol";
import { startDemoHost } from "./demo-host";
import { SimDevice } from "./device";
import { DEFAULT_PORT, startSimServer } from "./server";
import { loopback, openVirtualMidi, VIRTUAL_PORT_NAME } from "./transports";

const USAGE = `usage: bun packages/device-simulator/src/cli.ts [--virtual-midi] [--demo] [--port ${DEFAULT_PORT}]

  --virtual-midi   create the CoreMIDI virtual port pair "${VIRTUAL_PORT_NAME}" for a companion
  --demo           attach a built-in fixture host (static frames) instead of MIDI
  --port N         HTTP port for the browser UI (default ${DEFAULT_PORT})
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "virtual-midi": { type: "boolean", default: false },
      demo: { type: "boolean", default: false },
      port: { type: "string", default: String(DEFAULT_PORT) },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`bad --port ${values.port}`);
  if (values["virtual-midi"] && values.demo) throw new Error("--virtual-midi and --demo are exclusive");

  let transport: MidiTransport;
  let describe: string;
  if (values["virtual-midi"]) {
    transport = await openVirtualMidi();
    describe = `CoreMIDI virtual port "${VIRTUAL_PORT_NAME}"`;
  } else {
    const pair = loopback();
    transport = pair.device;
    if (values.demo) startDemoHost(pair.host);
    describe = values.demo ? "built-in demo host" : "unconnected loopback (NO COMPANION)";
  }

  const device = new SimDevice({ transport });
  // Server first, so the protocol log includes the handshake.
  const server = await startSimServer({ device, port });
  device.start();
  process.stdout.write(`FM-1 simulator: ${server.url}  (transport: ${describe})\n`);

  const shutdown = (): void => {
    server.stop();
    device.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n${USAGE}`);
  process.exit(1);
});
