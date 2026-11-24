/**
 * CoreMIDI smoke check through a private virtual port pair. It never opens an
 * existing port, so the FM-1 is not touched. Exit code 0 means the round trip worked.
 * (Run as a script: under `bun test` the prebuild loader trips over the jest shim.)
 */
import { listMidiPorts, openCoreMidi } from "../src/coremidi";
import { UnsafeMidiError } from "../src/transport";

const name = `fm1-protocol-test-${process.pid}`;

async function main(): Promise<void> {
  const sim = await openCoreMidi({ kind: "virtual", name });
  try {
    const ports = await listMidiPorts();
    if (!ports.inputs.some((p) => p.includes(name))) throw new Error(`virtual port ${name} not listed`);
    const client = await openCoreMidi({ kind: "ports", input: name, output: name });
    try {
      const got = new Promise<number[]>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no message within 2 s")), 2000);
        sim.onMessage((m) => {
          clearTimeout(timer);
          resolve([...m]);
        });
      });
      client.send([0xbf, 118, 1]);
      const msg = await got;
      if (msg.join() !== [0xbf, 118, 1].join()) throw new Error(`got ${msg.join()}`);
      let blocked = false;
      try {
        client.send([0xf0, 0x7e, 0xf7]);
      } catch (err) {
        blocked = err instanceof UnsafeMidiError;
      }
      if (!blocked) throw new Error("SysEx was not blocked");
    } finally {
      client.close();
    }
  } finally {
    sim.close();
  }
  console.log("coremidi loopback ok");
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
