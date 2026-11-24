import { expect, test } from "bun:test";

// The native MIDI binding does not load inside `bun test`, so the CoreMIDI check runs as a
// child process. It creates only the simulator's own virtual port. Opt in with FM1_MIDI_TESTS=1.
test.skipIf(process.env.FM1_MIDI_TESTS !== "1")("CoreMIDI virtual port end to end", async () => {
  const proc = Bun.spawn(["bun", new URL("../scripts/virtual-midi-smoke.ts", import.meta.url).pathname], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  expect(err).toBe("");
  expect(out).toContain("OK:");
  expect(code).toBe(0);
}, 30_000);
