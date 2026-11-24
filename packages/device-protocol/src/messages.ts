import type {
  AckStatus,
  ButtonId,
  CommandResultCode,
  Edge,
  EncoderId,
  Gesture,
  KeyMode,
  Layout,
  LinkState,
  PotId,
  Provider,
  SlotState,
  TextStyle,
  View,
  VoiceState,
} from "./enums";

export type Role = "host" | "device";

// Device -> host

export interface Hello {
  kind: "HELLO";
  protoMin: number;
  protoMax: number;
  fwMajor: number;
  fwMinor: number;
  fwPatch: number;
  /** u14, random per boot. */
  bootId: number;
}

export interface ButtonEvent {
  kind: "BUTTON";
  button: ButtonId;
  edge: Edge;
}

export interface KeyEvent {
  kind: "KEY";
  /** 0..26 */
  key: number;
  gesture: Gesture;
}

export interface EncoderEvent {
  kind: "ENCODER";
  encoder: EncoderId;
  /** -64..63 */
  delta: number;
}

export interface PotEvent {
  kind: "POT";
  pot: PotId;
  /** 0..1023 */
  value: number;
}

export interface DeviceHeartbeat {
  kind: "HEARTBEAT";
  from: "device";
  uptimeS: number;
  /** Saturates at 127. */
  rxErrors: number;
}

export interface Ack<F extends Role> {
  kind: "ACK";
  from: F;
  ackedSeq: number;
  status: AckStatus;
}

export type DeviceMessage =
  | Hello
  | ButtonEvent
  | KeyEvent
  | EncoderEvent
  | PotEvent
  | DeviceHeartbeat
  | Ack<"device">;

// Host -> device

export interface HelloAck {
  kind: "HELLO_ACK";
  /** Chosen version, or 0 when there is no overlap. */
  proto: number;
  hostSession: number;
  reason: string;
}

export interface SetView {
  kind: "SET_VIEW";
  view: View;
  page: number;
  pages: number;
  title: string;
  /** Version 5 only (docs/ui-v3.md section 8): the trailing layout byte. Absent = the version 1-4 body (buddy). */
  layout?: Layout;
  /**
   * Version 6 only (docs/ui-v3.md section 10.6): the keys byte after the layout (which must then be set). Absent =
   * ranked. `split` needs `taskPage` (0-based) and `taskPages` (1-127, taskPage < taskPages); `ranked` neither.
   */
  keys?: KeyMode;
  taskPage?: number;
  taskPages?: number;
}

export interface SlotFlags {
  selected: boolean;
  codex: boolean;
  stale: boolean;
  pinned: boolean;
  /**
   * Version 6 (docs/ui-v3.md section 10.6): bit 4, the chosen filter or task key of the SPLIT black row. Never together
   * with `selected`. Absent = false (decoding sets it only when the bit is set).
   */
  chosen?: boolean;
}

export interface SetSlot {
  kind: "SET_SLOT";
  key: number;
  state: SlotState;
  flags: SlotFlags;
  label: string;
  /**
   * Version 5 only: the list row's title (<= 20) and age (<= 3). Both or neither on the wire: when either is set,
   * both are written (a missing one as ""). Absent = the version 1-4 body.
   */
  title?: string;
  age?: string;
  /**
   * Version 5 GROUPED only (docs/ui-v3.md section 9.5): the row byte after the age (title and age are then always
   * written). Absent = indent 0, no header. `head` must be present exactly when `row.start` is set.
   */
  row?: SlotRow;
  head?: SlotHead;
}

/** The SET_SLOT row byte: the session row's indent (0-2), a header drawn before it (`start`), a folded task row (`task`). */
export interface SlotRow {
  indent: 0 | 1 | 2;
  start: boolean;
  task: boolean;
}

/** The group header drawn before a `start` row: its state (mini colour), pinned dot, title (<= 20) and count (<= 11). */
export interface SlotHead {
  state: SlotState;
  pinned: boolean;
  title: string;
  count: string;
}

export type FourStrings = readonly [string, string, string, string];

export interface SetDetail {
  kind: "SET_DETAIL";
  provider: Provider;
  state: SlotState;
  lines: FourStrings;
}

export interface SetVoice {
  kind: "SET_VOICE";
  voice: VoiceState;
  /** 0..100 */
  level: number;
  /** Tenths of a second, u14. */
  elapsedDs: number;
  target: string;
}

export interface SetLegend {
  kind: "SET_LEGEND";
  labels: FourStrings;
}

export interface SetStatus {
  kind: "SET_STATUS";
  link: LinkState;
  attentionCount: number;
  text: string;
}

export interface CommandResult {
  kind: "COMMAND_RESULT";
  /** Device frame SEQ that caused this, or NO_REQ_SEQ (127). */
  reqSeq: number;
  result: CommandResultCode;
  text: string;
}

export interface HostHeartbeat {
  kind: "HEARTBEAT";
  from: "host";
  hostUptimeS: number;
}

export interface ClearSlots {
  kind: "CLEAR_SLOTS";
}

export interface TextRow {
  style: TextStyle;
  /**
   * <= 29 visible characters. Version 7 (rich-text.ts): may also carry the control bytes 0x01 bold, 0x02 code, 0x03 off
   * (no column) and 0x04 a column rule (one column): <= 37 bytes, <= 8 style bytes.
   */
  text: string;
}

/** Version 3: replaces rows `row .. row + lines.length - 1` of the 12-row DETAILS text (1..3 rows per frame). */
export interface SetText {
  kind: "SET_TEXT";
  /** 0..11 */
  row: number;
  lines: readonly TextRow[];
}

export type HostMessage =
  | HelloAck
  | SetView
  | SetSlot
  | SetDetail
  | SetVoice
  | SetLegend
  | SetStatus
  | CommandResult
  | HostHeartbeat
  | Ack<"host">
  | ClearSlots
  | SetText;

export type Message = DeviceMessage | HostMessage;

/** Messages a given role sends. */
export type Outgoing<R extends Role> = R extends "host" ? HostMessage : DeviceMessage;
/** Messages a given role receives. */
export type Incoming<R extends Role> = R extends "host" ? DeviceMessage : HostMessage;

export const peerOf = (role: Role): Role => (role === "host" ? "device" : "host");

const HOST_KINDS: ReadonlySet<string> = new Set([
  "HELLO_ACK",
  "SET_VIEW",
  "SET_SLOT",
  "SET_DETAIL",
  "SET_VOICE",
  "SET_LEGEND",
  "SET_STATUS",
  "COMMAND_RESULT",
  "CLEAR_SLOTS",
  "SET_TEXT",
]);

export function originOf(msg: Message): Role {
  if (msg.kind === "ACK" || msg.kind === "HEARTBEAT") return msg.from;
  return HOST_KINDS.has(msg.kind) ? "host" : "device";
}

/** Every frame except ACK and HEARTBEAT must be acknowledged. */
export const requiresAck = (msg: Message): boolean =>
  msg.kind !== "ACK" && msg.kind !== "HEARTBEAT";
