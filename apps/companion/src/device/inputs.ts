// Device frames (facts) -> agent-core DeviceInput. The companion decides what they mean.
import type { DeviceInput } from "@fm1/agent-core";
import type { DeviceMessage } from "@fm1/device-protocol";

/** Returns null for frames that carry no controller input (HELLO, HEARTBEAT, ACK, POT: MASTER is unassigned). */
export function toDeviceInput(msg: DeviceMessage): DeviceInput | null {
  switch (msg.kind) {
    case "BUTTON":
      return { kind: "button", button: msg.button, edge: msg.edge };
    case "KEY":
      return { kind: "key", key: msg.key, gesture: msg.gesture };
    case "ENCODER":
      return { kind: "encoder", encoder: msg.encoder, delta: msg.delta };
    default:
      return null;
  }
}

/** Short human label for logs and toasts. */
export function describeInput(i: DeviceInput): string {
  switch (i.kind) {
    case "button":
      return `${i.button} ${i.edge}`;
    case "key":
      return `KEY${i.key} ${i.gesture}`;
    case "encoder":
      return `${i.encoder} ${i.delta > 0 ? "+" : ""}${i.delta}`;
  }
}
