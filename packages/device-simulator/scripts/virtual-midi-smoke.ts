// End-to-end check over CoreMIDI: start the simulator on its own virtual port, connect a
// host Link to that port by name, and verify handshake, a SET_* frame and a key gesture.
// Only the simulator's private virtual port is opened; any other port (e.g. a real FM-1) is refused.
import { Link, listMidiPorts, openCoreMidi } from "@fm1/device-protocol";
import { SimDevice } from "../src/device";
import { openVirtualMidi, VIRTUAL_PORT_NAME } from "../src/transports";

const fail = (msg: string): never => {
  process.stderr.write(`FAIL: ${msg}\n`);
  process.exit(1);
};

const device = new SimDevice({ transport: await openVirtualMidi() });
device.start();
await Bun.sleep(300);

const ports = await listMidiPorts();
const exact = (names: string[]) => names.filter((n) => n.includes(VIRTUAL_PORT_NAME));
if (exact(ports.inputs).length !== 1 || exact(ports.outputs).length !== 1) {
  fail(`expected exactly one "${VIRTUAL_PORT_NAME}" port each way, got ${JSON.stringify(ports)}`);
}

const host = Link.host({ transport: await openCoreMidi({ kind: "ports", input: VIRTUAL_PORT_NAME, output: VIRTUAL_PORT_NAME }) });
const keys: string[] = [];
host.on("message", ({ message }) => {
  if (message.kind === "KEY") keys.push(`${message.key}:${message.gesture}`);
});
host.start();

const deadline = Date.now() + 4000;
while (device.state.link.phase !== "connected" && Date.now() < deadline) await Bun.sleep(20);
if (device.state.link.phase !== "connected") fail("no handshake over CoreMIDI");

host.send({ kind: "SET_VIEW", view: "tasks", page: 0, pages: 1, title: "OVER MIDI" });
device.keyDown(12);
await Bun.sleep(60);
device.keyUp(12);
await Bun.sleep(600);

if (device.state.view.title !== "OVER MIDI") fail(`SET_VIEW not applied: ${JSON.stringify(device.state.view)}`);
if (keys.join(",") !== "12:down,12:up,12:single") fail(`key gestures: ${keys.join(",")}`);

host.close();
device.stop();
process.stdout.write("OK: handshake, SET_VIEW and key gesture over CoreMIDI virtual port\n");
process.exit(0);
