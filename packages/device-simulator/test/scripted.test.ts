import { describe, expect, test } from "bun:test";
import { ScriptedDriver, WaitTimeoutError } from "../src/scripted";
import { connected, rig } from "./harness";

describe("scripted driver", () => {
  test("press/hold/turn produce the protocol gestures; waitFor sees host state", async () => {
    const r = connected();
    const d = new ScriptedDriver(r.device);
    // A minimal stand-in host: select whichever key gets a single press.
    r.host().on("message", ({ message }) => {
      if (message.kind === "KEY" && message.gesture === "single") {
        r.host().send({
          kind: "SET_SLOT",
          key: message.key,
          state: "idle",
          flags: { selected: true, codex: false, stale: false, pinned: false },
          label: "picked",
        });
      }
    });
    await d.press(6);
    await d.press(7, "double");
    await d.press(8, "long");
    await d.hold("REC", 1200);
    d.turn("ALGORITHM", 3);
    const s = await d.waitFor((st) => st.slots[6]?.label === "picked");
    expect(s.slots[6]?.flags.selected).toBe(true);
    await d.waitFor(() => r.host().pendingCount === 0);

    const seq = r.inputs().map((m) => {
      if (m.kind === "KEY") return `K${m.key}:${m.gesture}`;
      if (m.kind === "BUTTON") return `${m.button}:${m.edge}`;
      if (m.kind === "ENCODER") return `${m.encoder}:${m.delta}`;
      return m.kind;
    });
    expect(seq).toEqual([
      "K6:down",
      "K6:up",
      "K6:single",
      "K7:down",
      "K7:up",
      "K7:down",
      "K7:up",
      "K7:double",
      "K8:down",
      "K8:long",
      "K8:up",
      "REC:down",
      "REC:up",
      "ALGORITHM:3",
    ]);
  });

  test("waitFor times out against a fake clock", async () => {
    const r = rig();
    r.device.start();
    const d = new ScriptedDriver(r.device);
    await expect(d.waitFor((s) => s.link.phase === "connected", 500)).rejects.toBeInstanceOf(WaitTimeoutError);
  });
});
