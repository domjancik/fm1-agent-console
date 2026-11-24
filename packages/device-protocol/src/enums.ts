/** Maps protocol enum names to contiguous wire values starting at `offset`. */
export class EnumTable<N extends string> {
  constructor(
    readonly names: readonly N[],
    readonly offset = 0,
  ) {}

  toWire(name: N): number {
    const index = this.names.indexOf(name);
    if (index < 0) throw new RangeError(`unknown enum name: ${name}`);
    return index + this.offset;
  }

  fromWire(value: number): N | undefined {
    return this.names[value - this.offset];
  }
}

const table = <const N extends string>(names: readonly N[], offset = 0): EnumTable<N> =>
  new EnumTable(names, offset);

export const Buttons = table([
  "OCT_DOWN",
  "OCT_UP",
  "FX",
  "SEL",
  "ENV",
  "LFO",
  "EDIT",
  "GLO",
  "HOME",
  "SAVE",
  "ARP",
  "SEQ",
  "PLAY",
  "REC",
]);
export type ButtonId = (typeof Buttons.names)[number];

export const Edges = table(["up", "down"]);
export type Edge = (typeof Edges.names)[number];

export const Gestures = table(["single", "double", "long", "down", "up"], 1);
export type Gesture = (typeof Gestures.names)[number];

export const Encoders = table(["SELECT", "ALGORITHM", "K1", "K2", "K3", "K4", "PRESETS"]);
export type EncoderId = (typeof Encoders.names)[number];

export const Pots = table(["MASTER"]);
export type PotId = (typeof Pots.names)[number];

export const AckStatuses = table(["ok", "unknown_type", "bad_body", "busy"]);
export type AckStatus = (typeof AckStatuses.names)[number];

/** View 5 `detail` needs version 3, view 6 `settings` version 6 (docs/ui-v3.md section 10.2). */
export const Views = table(["sessions", "tasks", "inbox", "voice", "confirm", "detail", "settings"]);
export type View = (typeof Views.names)[number];

export const SlotStates = table([
  "empty",
  "disconnected",
  "idle",
  "working",
  "waiting_input",
  "approval_required",
  "completed_unread",
  "completed_read",
  "failed",
  "unknown",
]);
export type SlotState = (typeof SlotStates.names)[number];

export const Providers = table(["none", "claude", "codex", "other"]);
export type Provider = (typeof Providers.names)[number];

export const VoiceStates = table([
  "ready",
  "recording",
  "transcribing",
  "reviewing",
  "submitting",
  "delivered",
  "cancelled",
  "failed",
  "target_unavailable",
]);
export type VoiceState = (typeof VoiceStates.names)[number];

/** SET_VIEW layout (protocol version 5, docs/ui-v3.md sections 8 and 9.5): `grouped` only in view 0. */
export const Layouts = table(["buddy", "list", "grouped"]);
export type Layout = (typeof Layouts.names)[number];

/** SET_VIEW keys byte (protocol version 6, docs/ui-v3.md section 10): what the 27 keys on the device are. */
export const KeyModes = table(["ranked", "split"]);
export type KeyMode = (typeof KeyModes.names)[number];

export const TextStyles = table(["body", "heading", "muted"]);
export type TextStyle = (typeof TextStyles.names)[number];

export const LinkStates = table(["ok", "backend_degraded", "backend_down"]);
export type LinkState = (typeof LinkStates.names)[number];

export const CommandResults = table([
  "accepted_locally",
  "sent",
  "acknowledged",
  "completed",
  "failed",
  "unsupported",
  "target_unavailable",
]);
export type CommandResultCode = (typeof CommandResults.names)[number];
