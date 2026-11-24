import { checksum, encode, type DecodeErrorCode } from "./codec";
import { MessageType } from "./constants";
import { payloadToMidi } from "./framing";
import { originOf, type Message, type Role, type SlotFlags } from "./messages";

export type VectorDirection = "device_to_host" | "host_to_device";

export interface ValidVector {
  name: string;
  direction: VectorDirection;
  message: Message;
  /** What decoding `payload` yields, when the sender sanitised or truncated a string. */
  decoded?: Message;
  seq: number;
  payload: number[];
  midi: number[][];
}

/**
 * Each invalid payload breaks exactly one rule, so implementations that check the
 * rules in a different order still report the same error. In particular the last
 * byte always equals `(sum of all other bytes & 0x7F) ^ 0x2A`.
 */
export interface InvalidVector {
  name: string;
  payload: number[];
  expectedError: DecodeErrorCode;
  /** Decode as received from this sender; a type owned by the other side is `unknown_type`. */
  sender?: Role;
}

/** HELLO range x host range -> the version HELLO_ACK carries (docs/ux-v2.md sections 4 and 7). */
export interface NegotiationVector {
  name: string;
  device: { min: number; max: number };
  host: { min: number; max: number };
  proto: number;
}

export interface VectorFile {
  /** Wire format revision (frames and bodies), not the negotiated version. */
  protocol: 1;
  generatedBy: string;
  /** Over `valid` and `invalid` only, so wire consumers are unaffected by negotiation cases. */
  checksum: string;
  valid: ValidVector[];
  invalid: InvalidVector[];
  negotiation: NegotiationVector[];
}

export const NEGOTIATION_CASES: NegotiationVector[] = [
  { name: "v2_device_v2_host", device: { min: 1, max: 2 }, host: { min: 1, max: 2 }, proto: 2 },
  { name: "v1_device_v2_host", device: { min: 1, max: 1 }, host: { min: 1, max: 2 }, proto: 1 },
  { name: "v2_device_v1_host", device: { min: 1, max: 2 }, host: { min: 1, max: 1 }, proto: 1 },
  { name: "v3_device_v3_host", device: { min: 1, max: 3 }, host: { min: 1, max: 3 }, proto: 3 },
  { name: "v2_device_v3_host", device: { min: 1, max: 2 }, host: { min: 1, max: 3 }, proto: 2 },
  { name: "v3_device_v2_host", device: { min: 1, max: 3 }, host: { min: 1, max: 2 }, proto: 2 },
  { name: "v1_device_v3_host", device: { min: 1, max: 1 }, host: { min: 1, max: 3 }, proto: 1 },
  { name: "v4_device_v4_host", device: { min: 1, max: 4 }, host: { min: 1, max: 4 }, proto: 4 },
  { name: "v3_device_v4_host", device: { min: 1, max: 3 }, host: { min: 1, max: 4 }, proto: 3 },
  { name: "v4_device_v3_host", device: { min: 1, max: 4 }, host: { min: 1, max: 3 }, proto: 3 },
  { name: "v1_device_v4_host", device: { min: 1, max: 1 }, host: { min: 1, max: 4 }, proto: 1 },
  { name: "v5_device_v5_host", device: { min: 1, max: 5 }, host: { min: 1, max: 5 }, proto: 5 },
  { name: "v4_device_v5_host", device: { min: 1, max: 4 }, host: { min: 1, max: 5 }, proto: 4 },
  { name: "v5_device_v4_host", device: { min: 1, max: 5 }, host: { min: 1, max: 4 }, proto: 4 },
  { name: "v1_device_v5_host", device: { min: 1, max: 1 }, host: { min: 1, max: 5 }, proto: 1 },
  { name: "v6_device_v6_host", device: { min: 1, max: 6 }, host: { min: 1, max: 6 }, proto: 6 },
  { name: "v5_device_v6_host", device: { min: 1, max: 5 }, host: { min: 1, max: 6 }, proto: 5 },
  { name: "v6_device_v5_host", device: { min: 1, max: 6 }, host: { min: 1, max: 5 }, proto: 5 },
  { name: "v1_device_v6_host", device: { min: 1, max: 1 }, host: { min: 1, max: 6 }, proto: 1 },
  { name: "v7_device_v7_host", device: { min: 1, max: 7 }, host: { min: 1, max: 7 }, proto: 7 },
  { name: "v6_device_v7_host", device: { min: 1, max: 6 }, host: { min: 1, max: 7 }, proto: 6 },
  { name: "v7_device_v6_host", device: { min: 1, max: 7 }, host: { min: 1, max: 6 }, proto: 6 },
  { name: "v1_device_v7_host", device: { min: 1, max: 1 }, host: { min: 1, max: 7 }, proto: 1 },
];

const NO_FLAGS: SlotFlags = { selected: false, codex: false, stale: false, pinned: false };
const ALL_FLAGS: SlotFlags = { selected: true, codex: true, stale: true, pinned: true };
const s = (n: number, ch = "W"): string => ch.repeat(n);
/** Version 7 SET_TEXT control bytes (rich-text.ts TEXT_MARK). */
const B = "\u0001";
const K = "\u0002";
const O = "\u0003";
const R = "\u0004";
const V7_MAX = `${B}aaaa${O}${K}bbbb${O}${B}cccc${O}${K}dddd${O}${s(9, "e")}${R}${s(3, "f")}`;

type Case = [name: string, seq: number, message: Message, decoded?: Message];

const deviceCases: Case[] = [
  ["hello_basic", 0, { kind: "HELLO", protoMin: 1, protoMax: 1, fwMajor: 0, fwMinor: 1, fwPatch: 0, bootId: 0 }],
  ["hello_extremes", 127, { kind: "HELLO", protoMin: 1, protoMax: 3, fwMajor: 127, fwMinor: 127, fwPatch: 127, bootId: 16383 }],
  ["hello_v2_range", 6, { kind: "HELLO", protoMin: 1, protoMax: 2, fwMajor: 0, fwMinor: 2, fwPatch: 0, bootId: 9 }],
  ["hello_boot_id_split", 5, { kind: "HELLO", protoMin: 1, protoMax: 1, fwMajor: 1, fwMinor: 2, fwPatch: 3, bootId: 128 }],
  ["button_rec_down", 1, { kind: "BUTTON", button: "REC", edge: "down" }],
  ["button_rec_up_seq127", 127, { kind: "BUTTON", button: "REC", edge: "up" }],
  ["button_oct_down_down", 2, { kind: "BUTTON", button: "OCT_DOWN", edge: "down" }],
  ["key_0_single", 3, { kind: "KEY", key: 0, gesture: "single" }],
  ["key_26_double", 4, { kind: "KEY", key: 26, gesture: "double" }],
  ["key_13_long", 5, { kind: "KEY", key: 13, gesture: "long" }],
  ["key_4_down", 6, { kind: "KEY", key: 4, gesture: "down" }],
  ["key_4_up", 7, { kind: "KEY", key: 4, gesture: "up" }],
  ["encoder_select_min", 8, { kind: "ENCODER", encoder: "SELECT", delta: -64 }],
  ["encoder_presets_max", 9, { kind: "ENCODER", encoder: "PRESETS", delta: 63 }],
  ["encoder_k1_zero", 10, { kind: "ENCODER", encoder: "K1", delta: 0 }],
  ["encoder_k4_minus1", 11, { kind: "ENCODER", encoder: "K4", delta: -1 }],
  ["pot_master_min", 12, { kind: "POT", pot: "MASTER", value: 0 }],
  ["pot_master_max", 13, { kind: "POT", pot: "MASTER", value: 1023 }],
  ["device_heartbeat_zero", 14, { kind: "HEARTBEAT", from: "device", uptimeS: 0, rxErrors: 0 }],
  ["device_heartbeat_max", 15, { kind: "HEARTBEAT", from: "device", uptimeS: 16383, rxErrors: 127 }],
  ["device_ack_ok", 16, { kind: "ACK", from: "device", ackedSeq: 0, status: "ok" }],
  ["device_ack_busy_127", 127, { kind: "ACK", from: "device", ackedSeq: 127, status: "busy" }],
];

const hostCases: Case[] = [
  ["hello_ack_ok", 0, { kind: "HELLO_ACK", proto: 1, hostSession: 1234, reason: "" }],
  ["hello_ack_v2", 2, { kind: "HELLO_ACK", proto: 2, hostSession: 1234, reason: "" }],
  ["hello_ack_reject_max_reason", 1, { kind: "HELLO_ACK", proto: 0, hostSession: 16383, reason: s(24, "R") }],
  ["set_view_sessions_empty", 2, { kind: "SET_VIEW", view: "sessions", page: 0, pages: 1, title: "" }],
  ["set_view_confirm_max", 127, { kind: "SET_VIEW", view: "confirm", page: 127, pages: 127, title: s(20, "T") }],
  ["set_view_inbox", 3, { kind: "SET_VIEW", view: "inbox", page: 1, pages: 3, title: "Inbox 2/3" }],
  ["set_slot_empty", 4, { kind: "SET_SLOT", key: 0, state: "empty", flags: NO_FLAGS, label: "" }],
  ["set_slot_max", 5, { kind: "SET_SLOT", key: 26, state: "approval_required", flags: ALL_FLAGS, label: s(12, "L") }],
  ["set_slot_stale_codex", 6, { kind: "SET_SLOT", key: 9, state: "unknown", flags: { ...NO_FLAGS, codex: true, stale: true }, label: "api-fix" }],
  [
    "set_slot_sanitised",
    7,
    { kind: "SET_SLOT", key: 1, state: "working", flags: { ...NO_FLAGS, selected: true }, label: "café\tok" },
    { kind: "SET_SLOT", key: 1, state: "working", flags: { ...NO_FLAGS, selected: true }, label: "caf??ok" },
  ],
  [
    "set_slot_truncated",
    8,
    { kind: "SET_SLOT", key: 2, state: "idle", flags: NO_FLAGS, label: "0123456789abcdef" },
    { kind: "SET_SLOT", key: 2, state: "idle", flags: NO_FLAGS, label: "0123456789ab" },
  ],
  ["set_detail_max", 9, { kind: "SET_DETAIL", provider: "codex", state: "failed", lines: [s(20, "A"), s(20, "B"), s(20, "C"), s(20, "~")] }],
  ["set_detail_empty", 10, { kind: "SET_DETAIL", provider: "none", state: "empty", lines: ["", "", "", ""] }],
  ["set_detail_claude", 11, { kind: "SET_DETAIL", provider: "claude", state: "waiting_input", lines: ["fm1 console", "needs input", "", "K1 open"] }],
  ["set_voice_ready", 12, { kind: "SET_VOICE", voice: "ready", level: 0, elapsedDs: 0, target: "" }],
  ["set_voice_recording_max", 13, { kind: "SET_VOICE", voice: "recording", level: 100, elapsedDs: 16383, target: s(20, "v") }],
  ["set_voice_target_unavailable", 14, { kind: "SET_VOICE", voice: "target_unavailable", level: 50, elapsedDs: 128, target: "slot 3" }],
  ["set_legend_max", 15, { kind: "SET_LEGEND", labels: [s(6, "a"), s(6, "b"), s(6, "c"), s(6, "d")] }],
  ["set_legend_empty", 16, { kind: "SET_LEGEND", labels: ["", "", "", ""] }],
  ["set_status_ok", 17, { kind: "SET_STATUS", link: "ok", attentionCount: 0, text: "" }],
  ["set_status_down_max", 18, { kind: "SET_STATUS", link: "backend_down", attentionCount: 127, text: s(20, "!") }],
  ["set_status_degraded", 19, { kind: "SET_STATUS", link: "backend_degraded", attentionCount: 3, text: "traycer slow" }],
  ["command_result_none_failed", 20, { kind: "COMMAND_RESULT", reqSeq: 127, result: "failed", text: "no target" }],
  ["command_result_req0_unavailable", 21, { kind: "COMMAND_RESULT", reqSeq: 0, result: "target_unavailable", text: s(20, "c") }],
  ["host_heartbeat_zero", 22, { kind: "HEARTBEAT", from: "host", hostUptimeS: 0 }],
  ["host_heartbeat_max", 23, { kind: "HEARTBEAT", from: "host", hostUptimeS: 16383 }],
  ["host_ack_ok", 24, { kind: "ACK", from: "host", ackedSeq: 127, status: "ok" }],
  ["host_ack_unknown_type", 25, { kind: "ACK", from: "host", ackedSeq: 1, status: "unknown_type" }],
  ["host_ack_bad_body", 26, { kind: "ACK", from: "host", ackedSeq: 64, status: "bad_body" }],
  ["clear_slots", 27, { kind: "CLEAR_SLOTS" }],
  ["clear_slots_seq127", 127, { kind: "CLEAR_SLOTS" }],
  ["set_view_detail", 28, { kind: "SET_VIEW", view: "detail", page: 1, pages: 3, title: "DETAILS fm1 console" }],
  ["set_text_one_row", 29, { kind: "SET_TEXT", row: 0, lines: [{ style: "heading", text: "WORKING, 2m" }] }],
  [
    "set_text_three_rows_max",
    30,
    { kind: "SET_TEXT", row: 9, lines: [{ style: "body", text: s(29, "a") }, { style: "heading", text: s(29, "b") }, { style: "muted", text: s(29, "~") }] },
  ],
  ["set_text_empty_rows", 31, { kind: "SET_TEXT", row: 3, lines: [{ style: "body", text: "" }, { style: "body", text: "" }, { style: "body", text: "" }] }],
  [
    "set_text_sanitised",
    32,
    { kind: "SET_TEXT", row: 11, lines: [{ style: "muted", text: "Files 2: caf\u00e9.ts, 0123456789abcdefghijklmnopqrstuvwxyz" }] },
    { kind: "SET_TEXT", row: 11, lines: [{ style: "muted", text: "Files 2: caf?.ts, 0123456789a" }] },
  ],
  // Version 5 (docs/ui-v3.md section 8): the optional SET_VIEW layout byte and SET_SLOT title + age.
  ["set_view_list", 33, { kind: "SET_VIEW", view: "sessions", page: 0, pages: 2, title: "ACTIVE 15", layout: "list" }],
  ["set_view_todo_buddy", 34, { kind: "SET_VIEW", view: "inbox", page: 0, pages: 1, title: "TO DO 5", layout: "buddy" }],
  [
    "set_slot_list_row",
    35,
    { kind: "SET_SLOT", key: 3, state: "completed_unread", flags: { ...NO_FLAGS, selected: true }, label: "VOICE TESTS", title: "Voice tests for the", age: "2m" },
  ],
  ["set_slot_list_max", 36, { kind: "SET_SLOT", key: 26, state: "approval_required", flags: ALL_FLAGS, label: s(12, "L"), title: s(20, "T"), age: "99w" }],
  ["set_slot_list_empty_strings", 37, { kind: "SET_SLOT", key: 0, state: "idle", flags: NO_FLAGS, label: "", title: "", age: "" }],
  [
    "set_slot_list_truncated",
    38,
    { kind: "SET_SLOT", key: 5, state: "working", flags: { ...NO_FLAGS, codex: true }, label: "fw review", title: "fw review of the console build", age: "12345" },
    { kind: "SET_SLOT", key: 5, state: "working", flags: { ...NO_FLAGS, codex: true }, label: "fw review", title: "fw review of the con", age: "123" },
  ],
  // Version 5 GROUPED (docs/ui-v3.md section 9.5): SET_VIEW layout 2, the SET_SLOT row byte and group header.
  ["set_view_grouped", 39, { kind: "SET_VIEW", view: "sessions", page: 0, pages: 1, title: "ACTIVE 20", layout: "grouped" }],
  [
    "set_slot_group_header",
    40,
    {
      kind: "SET_SLOT", key: 0, state: "failed", flags: { ...NO_FLAGS, selected: true }, label: "fw review", title: "fw review build", age: "3h",
      row: { indent: 1, start: true, task: false },
      head: { state: "failed", pinned: false, title: "Firmware v5", count: "2 need you" },
    },
  ],
  ["set_slot_group_member", 41, { kind: "SET_SLOT", key: 1, state: "working", flags: NO_FLAGS, label: "tests", title: "tests for the list", age: "now", row: { indent: 1, start: false, task: false } }],
  ["set_slot_group_child", 42, { kind: "SET_SLOT", key: 2, state: "idle", flags: { ...NO_FLAGS, codex: true }, label: "sub agent", title: "sub agent: lint", age: "12m", row: { indent: 2, start: false, task: false } }],
  [
    "set_slot_group_folded",
    43,
    {
      kind: "SET_SLOT", key: 3, state: "idle", flags: NO_FLAGS, label: "Docs pass", title: "Docs pass", age: "2d",
      row: { indent: 0, start: true, task: true },
      head: { state: "idle", pinned: false, title: "Docs pass", count: "4 quiet" },
    },
  ],
  [
    "set_slot_group_max",
    44,
    {
      kind: "SET_SLOT", key: 26, state: "approval_required", flags: ALL_FLAGS, label: s(12, "L"), title: s(20, "T"), age: "99w",
      row: { indent: 2, start: true, task: false },
      head: { state: "approval_required", pinned: true, title: s(20, "H"), count: s(11, "C") },
    },
  ],
  [
    "set_slot_group_truncated",
    45,
    {
      kind: "SET_SLOT", key: 4, state: "waiting_input", flags: NO_FLAGS, label: "q", title: "question", age: "1m",
      row: { indent: 1, start: true, task: false },
      head: { state: "waiting_input", pinned: false, title: "A very long task title here", count: "12 need you!!" },
    },
    {
      kind: "SET_SLOT", key: 4, state: "waiting_input", flags: NO_FLAGS, label: "q", title: "question", age: "1m",
      row: { indent: 1, start: true, task: false },
      head: { state: "waiting_input", pinned: false, title: "A very long task tit", count: "12 need you" },
    },
  ],
  // Version 6 (docs/ui-v3.md section 10.6): SET_VIEW keys byte + task page, view 6 settings, SET_SLOT flag bit 4 chosen.
  ["set_view_split", 46, { kind: "SET_VIEW", view: "sessions", page: 0, pages: 2, title: "NEEDS YOU 3", layout: "buddy", keys: "split", taskPage: 0, taskPages: 3 }],
  ["set_view_split_grouped", 47, { kind: "SET_VIEW", view: "sessions", page: 1, pages: 2, title: "Firmware v5 18", layout: "grouped", keys: "split", taskPage: 2, taskPages: 3 }],
  ["set_view_split_max", 48, { kind: "SET_VIEW", view: "sessions", page: 127, pages: 127, title: s(20, "T"), layout: "list", keys: "split", taskPage: 126, taskPages: 127 }],
  ["set_view_keys_ranked", 49, { kind: "SET_VIEW", view: "sessions", page: 0, pages: 1, title: "ACTIVE 20", layout: "list", keys: "ranked" }],
  ["set_view_settings", 50, { kind: "SET_VIEW", view: "settings", page: 0, pages: 1, title: "SETTINGS", layout: "buddy", keys: "split", taskPage: 0, taskPages: 1 }],
  ["set_view_settings_v5_body", 51, { kind: "SET_VIEW", view: "settings", page: 0, pages: 1, title: "SETTINGS" }],
  [
    "set_slot_task_chosen",
    52,
    { kind: "SET_SLOT", key: 8, state: "approval_required", flags: { ...NO_FLAGS, pinned: true, chosen: true }, label: "FV5", title: "Firmware v5", age: "3h" },
  ],
  ["set_slot_filter_needs", 53, { kind: "SET_SLOT", key: 5, state: "waiting_input", flags: NO_FLAGS, label: "YOU", title: "Needs you", age: "" }],
  ["set_slot_chosen_v4_body", 54, { kind: "SET_SLOT", key: 1, state: "idle", flags: { ...NO_FLAGS, chosen: true }, label: "ALL" }],
  // (wire coverage: the largest valid flags value, 30; the host never sets codex or stale on a black key)
  [
    "set_slot_chosen_flags_max_row",
    55,
    { kind: "SET_SLOT", key: 25, state: "idle", flags: { ...NO_FLAGS, codex: true, stale: true, pinned: true, chosen: true }, label: "DPA", title: "Docs pass", age: "2d", row: { indent: 0, start: false, task: false } },
  ],
  // Version 7 (docs/ui-v3.md section 13): SET_TEXT rows with 0x01 bold, 0x02 code, 0x03 off, 0x04 column rule.
  ["set_text_v7_bold_code", 56, { kind: "SET_TEXT", row: 1, lines: [{ style: "body", text: `I fixed ${B}the bug${O} in ${K}view.ts${O}` }] }],
  [
    "set_text_v7_table",
    57,
    { kind: "SET_TEXT", row: 3, lines: [{ style: "heading", text: `File${R}Lines` }, { style: "body", text: `a.ts${R}12` }, { style: "body", text: `b.ts${R}3` }] },
  ],
  // 29 visible characters and 8 style bytes: the longest row (37 bytes); two of them fill a 78 + 2 byte body.
  ["set_text_v7_row_max", 58, { kind: "SET_TEXT", row: 10, lines: [{ style: "muted", text: V7_MAX }, { style: "heading", text: V7_MAX }] }],
  // Unterminated span (ends with the row), a span right at the start, consecutive marks.
  ["set_text_v7_open_span", 59, { kind: "SET_TEXT", row: 0, lines: [{ style: "body", text: `${K}${B}x${O} y ${K}code to the end` }] }],
  [
    "set_text_v7_sanitised",
    60,
    { kind: "SET_TEXT", row: 11, lines: [{ style: "body", text: `a\u0007b${B}${O}${B}${O}${B}${O}${B}${O}${B}c${O}${B}` }] },
    { kind: "SET_TEXT", row: 11, lines: [{ style: "body", text: `a?b${B}${O}${B}${O}${B}${O}${B}${O}c` }] },
  ],
];

/** Appends the checksum the spec formula gives over all bytes so far, LEN field as written. */
const sealed = (bytes: number[]): number[] => [
  ...bytes,
  (bytes.reduce((a, b) => a + b, 0) & 0x7f) ^ 0x2a,
];

/** Payload with a correct checksum around an arbitrary type and body. */
export const rawFrame = (type: number, seq: number, body: number[]): number[] => [
  type,
  seq,
  body.length,
  ...body,
  checksum(type, seq, body),
];

const T = MessageType;

export const invalidVectors = (): InvalidVector[] => {
  const ok = encode({ kind: "KEY", key: 1, gesture: "single" }, 9);
  const flipped = [...ok];
  flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 1;
  const unxored = [...ok];
  unxored[unxored.length - 1] = (unxored[unxored.length - 1] ?? 0) ^ 0x2a;
  const fill = (n: number): number[] => new Array<number>(n).fill(0x41);
  return [
    { name: "empty", payload: [], expectedError: "bad_length" },
    { name: "three_bytes", payload: [T.KEY, 0, 0], expectedError: "bad_length" },
    { name: "body_short_of_len", payload: sealed([T.KEY, 0, 2, 1]), expectedError: "bad_length" },
    { name: "trailing_byte", payload: sealed(ok), expectedError: "bad_length" },
    { name: "len_0_with_body", payload: sealed([T.CLEAR_SLOTS, 0, 0, 0]), expectedError: "bad_length" },
    { name: "len_101", payload: sealed([T.SET_SLOT, 0, 101, ...fill(101)]), expectedError: "len_too_large" },
    { name: "len_127", payload: sealed([T.SET_SLOT, 0, 127, ...fill(127)]), expectedError: "len_too_large" },
    { name: "byte_over_7bit", payload: sealed([T.KEY, 0x80, 2, 1, 1]), expectedError: "not_7bit" },
    { name: "checksum_flipped", payload: flipped, expectedError: "bad_checksum" },
    { name: "checksum_without_xor", payload: unxored, expectedError: "bad_checksum" },
    { name: "type_0x00", payload: rawFrame(0x00, 0, []), expectedError: "unknown_type" },
    { name: "type_0x08", payload: rawFrame(0x08, 1, [1, 2]), expectedError: "unknown_type" },
    { name: "type_0x4d", payload: rawFrame(0x4d, 2, []), expectedError: "unknown_type" },
    { name: "type_0x7f", payload: rawFrame(0x7f, 127, [0]), expectedError: "unknown_type" },
    { name: "key_27", payload: rawFrame(T.KEY, 0, [27, 1]), expectedError: "bad_body" },
    { name: "gesture_0", payload: rawFrame(T.KEY, 0, [1, 0]), expectedError: "bad_body" },
    { name: "button_14", payload: rawFrame(T.BUTTON, 0, [14, 1]), expectedError: "bad_body" },
    { name: "pot_1024", payload: rawFrame(T.POT, 0, [0, 8, 0]), expectedError: "bad_body" },
    { name: "ack_status_4", payload: rawFrame(T.HOST_ACK, 0, [3, 4]), expectedError: "bad_body" },
    { name: "set_view_view_7", payload: rawFrame(T.SET_VIEW, 0, [7, 0, 1, 0]), expectedError: "bad_body" },
    { name: "set_slot_label_13", payload: rawFrame(T.SET_SLOT, 0, [0, 2, 0, 13, ...new Array<number>(13).fill(0x41)]), expectedError: "bad_body" },
    { name: "set_slot_control_char", payload: rawFrame(T.SET_SLOT, 0, [0, 2, 0, 2, 0x41, 0x1f]), expectedError: "bad_body" },
    { name: "set_slot_flags_32", payload: rawFrame(T.SET_SLOT, 0, [0, 2, 32, 0]), expectedError: "bad_body" },
    { name: "set_voice_level_101", payload: rawFrame(T.SET_VOICE, 0, [1, 101, 0, 0, 0]), expectedError: "bad_body" },
    { name: "set_status_str_overruns_body", payload: rawFrame(T.SET_STATUS, 0, [0, 0, 5, 0x41]), expectedError: "bad_body" },
    { name: "command_result_7", payload: rawFrame(T.COMMAND_RESULT, 0, [127, 7, 0]), expectedError: "bad_body" },
    { name: "host_heartbeat_extra_byte", payload: rawFrame(T.HOST_HEARTBEAT, 0, [0, 1, 2]), expectedError: "bad_body" },
    { name: "clear_slots_with_body", payload: rawFrame(T.CLEAR_SLOTS, 0, [0]), expectedError: "bad_body" },
    { name: "set_text_row_12", payload: rawFrame(T.SET_TEXT, 0, [12, 1, 0, 0]), expectedError: "bad_body" },
    { name: "set_text_count_0", payload: rawFrame(T.SET_TEXT, 0, [0, 0]), expectedError: "bad_body" },
    { name: "set_text_count_4", payload: rawFrame(T.SET_TEXT, 0, [0, 4, 0, 0, 0, 0, 0, 0, 0, 0]), expectedError: "bad_body" },
    { name: "set_text_past_end", payload: rawFrame(T.SET_TEXT, 0, [10, 3, 0, 0, 0, 0, 0, 0]), expectedError: "bad_body" },
    { name: "set_text_style_3", payload: rawFrame(T.SET_TEXT, 0, [0, 1, 3, 0]), expectedError: "bad_body" },
    { name: "set_text_str_30", payload: rawFrame(T.SET_TEXT, 0, [0, 1, 0, 30, ...new Array<number>(30).fill(0x41)]), expectedError: "bad_body" },
    // Version 5 (docs/ui-v3.md section 8.6)
    { name: "set_view_layout_3", payload: rawFrame(T.SET_VIEW, 0, [0, 0, 1, 0, 3]), expectedError: "bad_body" },
    // (since version 6 the first byte after the layout is a valid keys byte, so this vector carries two)
    { name: "set_view_layout_extra_byte", payload: rawFrame(T.SET_VIEW, 0, [0, 0, 1, 0, 1, 0, 0]), expectedError: "bad_body" },
    { name: "set_slot_title_21", payload: rawFrame(T.SET_SLOT, 0, [0, 2, 0, 0, 21, ...new Array<number>(21).fill(0x41), 0]), expectedError: "bad_body" },
    { name: "set_slot_age_4", payload: rawFrame(T.SET_SLOT, 0, [0, 2, 0, 0, 0, 4, 0x31, 0x32, 0x33, 0x34]), expectedError: "bad_body" },
    { name: "set_slot_title_no_age", payload: rawFrame(T.SET_SLOT, 0, [0, 2, 0, 0, 2, 0x41, 0x42]), expectedError: "bad_body" },
    // (since section 9.5 the first byte after the age is a valid row byte, so this vector carries two)
    { name: "set_slot_list_extra_byte", payload: rawFrame(T.SET_SLOT, 0, [0, 2, 0, 0, 0, 0, 0, 0]), expectedError: "bad_body" },
    // Version 5 GROUPED (docs/ui-v3.md section 9.5); head = state 8, flags 0, title "T", count "1"
    { name: "set_slot_row_indent_3", payload: rawFrame(T.SET_SLOT, 0, [0, 2, 0, 0, 0, 0, 3]), expectedError: "bad_body" },
    { name: "set_slot_row_bit4", payload: rawFrame(T.SET_SLOT, 0, [0, 2, 0, 0, 0, 0, 0x11]), expectedError: "bad_body" },
    { name: "set_slot_row_task_no_start", payload: rawFrame(T.SET_SLOT, 0, [0, 2, 0, 0, 0, 0, 8]), expectedError: "bad_body" },
    { name: "set_slot_head_missing", payload: rawFrame(T.SET_SLOT, 0, [0, 2, 0, 0, 0, 0, 5]), expectedError: "bad_body" },
    { name: "set_slot_head_flags_2", payload: rawFrame(T.SET_SLOT, 0, [0, 2, 0, 0, 0, 0, 5, 8, 2, 1, 0x54, 1, 0x31]), expectedError: "bad_body" },
    { name: "set_slot_head_title_21", payload: rawFrame(T.SET_SLOT, 0, [0, 2, 0, 0, 0, 0, 5, 8, 0, 21, ...fill(21), 1, 0x31]), expectedError: "bad_body" },
    { name: "set_slot_head_count_12", payload: rawFrame(T.SET_SLOT, 0, [0, 2, 0, 0, 0, 0, 5, 8, 0, 1, 0x54, 12, ...fill(12)]), expectedError: "bad_body" },
    { name: "set_slot_group_extra_byte", payload: rawFrame(T.SET_SLOT, 0, [0, 2, 0, 0, 0, 0, 5, 8, 0, 1, 0x54, 1, 0x31, 0]), expectedError: "bad_body" },
    { name: "set_slot_row_no_start_extra", payload: rawFrame(T.SET_SLOT, 0, [0, 2, 0, 0, 0, 0, 1, 8]), expectedError: "bad_body" },
    // Version 6 (docs/ui-v3.md section 10.6); SET_VIEW = sessions, page 0, pages 1, title "", layout buddy, then keys
    { name: "set_view_keys_2", payload: rawFrame(T.SET_VIEW, 0, [0, 0, 1, 0, 0, 2]), expectedError: "bad_body" },
    { name: "set_view_split_no_task_page", payload: rawFrame(T.SET_VIEW, 0, [0, 0, 1, 0, 0, 1]), expectedError: "bad_body" },
    { name: "set_view_split_no_task_pages", payload: rawFrame(T.SET_VIEW, 0, [0, 0, 1, 0, 0, 1, 0]), expectedError: "bad_body" },
    { name: "set_view_task_pages_0", payload: rawFrame(T.SET_VIEW, 0, [0, 0, 1, 0, 0, 1, 0, 0]), expectedError: "bad_body" },
    { name: "set_view_task_page_past_end", payload: rawFrame(T.SET_VIEW, 0, [0, 0, 1, 0, 0, 1, 3, 3]), expectedError: "bad_body" },
    { name: "set_view_ranked_extra_byte", payload: rawFrame(T.SET_VIEW, 0, [0, 0, 1, 0, 0, 0, 0]), expectedError: "bad_body" },
    { name: "set_view_split_extra_byte", payload: rawFrame(T.SET_VIEW, 0, [0, 0, 1, 0, 0, 1, 0, 1, 0]), expectedError: "bad_body" },
    { name: "set_slot_selected_and_chosen", payload: rawFrame(T.SET_SLOT, 0, [0, 2, 17, 0]), expectedError: "bad_body" },
    // Version 7 (docs/ui-v3.md section 13): text rows of 0x01-0x04 and printable ASCII, <= 37 bytes, <= 29 visible
    { name: "set_text_v7_byte_0x05", payload: rawFrame(T.SET_TEXT, 0, [0, 1, 0, 2, 0x41, 0x05]), expectedError: "bad_body" },
    { name: "set_text_v7_byte_0x00", payload: rawFrame(T.SET_TEXT, 0, [0, 1, 0, 2, 0x00, 0x41]), expectedError: "bad_body" },
    { name: "set_text_v7_len_38", payload: rawFrame(T.SET_TEXT, 0, [0, 1, 0, 38, ...new Array<number>(9).fill(0x03), ...fill(29)]), expectedError: "bad_body" },
    { name: "set_text_v7_visible_30", payload: rawFrame(T.SET_TEXT, 0, [0, 1, 0, 32, 0x01, ...fill(29), 0x03, 0x04]), expectedError: "bad_body" },
    { name: "key_received_by_device", payload: rawFrame(T.KEY, 3, [1, 1]), expectedError: "unknown_type", sender: "host" },
    { name: "device_ack_received_by_device", payload: rawFrame(T.DEVICE_ACK, 4, [0, 0]), expectedError: "unknown_type", sender: "host" },
    { name: "set_slot_received_by_host", payload: rawFrame(T.SET_SLOT, 5, [0, 0, 0, 0]), expectedError: "unknown_type", sender: "device" },
    { name: "host_heartbeat_received_by_host", payload: rawFrame(T.HOST_HEARTBEAT, 6, [0, 0]), expectedError: "unknown_type", sender: "device" },
  ];
};

export const validVectors = (): ValidVector[] =>
  [...deviceCases, ...hostCases].map(([name, seq, message, decoded]) => {
    const sender = originOf(message);
    const payload = encode(message, seq);
    const vector: ValidVector = {
      name,
      direction: sender === "device" ? "device_to_host" : "host_to_device",
      message,
      seq,
      payload,
      midi: payloadToMidi(payload, sender),
    };
    if (decoded) vector.decoded = decoded;
    return vector;
  });

/** FNV-1a over the canonical JSON of the vectors, so stale copies are detectable. */
const fnv1a = (text: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
};

export function buildVectorFile(): VectorFile {
  const valid = validVectors();
  const invalid = invalidVectors();
  return {
    protocol: 1,
    generatedBy: "packages/device-protocol/scripts/gen-vectors.ts",
    checksum: fnv1a(JSON.stringify({ valid, invalid })),
    valid,
    invalid,
    negotiation: NEGOTIATION_CASES.map((c) => ({ ...c, device: { ...c.device }, host: { ...c.host } })),
  };
}
