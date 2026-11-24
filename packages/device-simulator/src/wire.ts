// Messages between the simulator server and the browser UI. Browser-safe (types and pure parsing).
import type { ButtonId, EncoderId } from "@fm1/device-protocol";
import { BUTTON_IDS } from "./leds";
import type { DeviceState } from "./state";

export interface LogEntry {
  /** Device time in ms. */
  atMs: number;
  dir: "rx" | "tx";
  seq: number | null;
  kind: string;
  summary: string;
  /** Decode error code, or "not sent" for input dropped while there is no host. */
  error?: string;
}

export type ServerMessage =
  | { t: "state"; state: DeviceState; deviceMs: number }
  | { t: "log"; entries: LogEntry[] };

export type ClientMessage =
  | { t: "key"; key: number; down: boolean }
  | { t: "button"; button: ButtonId; down: boolean }
  | { t: "encoder"; encoder: EncoderId; delta: number }
  | { t: "pot"; value: number };

/** Most detents one encoder message may carry (a spin, not a stream). */
export const MAX_TURN = 1000;

export const ENCODER_IDS: readonly EncoderId[] = ["SELECT", "ALGORITHM", "K1", "K2", "K3", "K4", "PRESETS"];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
const isButton = (v: unknown): v is ButtonId => typeof v === "string" && (BUTTON_IDS as readonly string[]).includes(v);
const isEncoder = (v: unknown): v is EncoderId =>
  typeof v === "string" && (ENCODER_IDS as readonly string[]).includes(v);

/** Validates a message from the browser; returns null for anything malformed. */
export function parseClientMessage(raw: string): ClientMessage | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(v)) return null;
  switch (v.t) {
    case "key":
      return isInt(v.key) && v.key >= 0 && v.key <= 26 && typeof v.down === "boolean"
        ? { t: "key", key: v.key, down: v.down }
        : null;
    case "button":
      return isButton(v.button) && typeof v.down === "boolean" ? { t: "button", button: v.button, down: v.down } : null;
    case "encoder":
      return isEncoder(v.encoder) && isInt(v.delta) && v.delta !== 0 && Math.abs(v.delta) <= MAX_TURN
        ? { t: "encoder", encoder: v.encoder, delta: v.delta }
        : null;
    case "pot":
      return isInt(v.value) && v.value >= 0 && v.value <= 1023 ? { t: "pot", value: v.value } : null;
    default:
      return null;
  }
}
