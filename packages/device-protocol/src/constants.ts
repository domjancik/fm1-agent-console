/**
 * Highest protocol version implemented by this package (docs/protocol.md section 3). Version 2 keeps the v1 wire
 * format byte for byte; it only marks the UX v2 rendering rules (docs/ux-v2.md section 4). Version 3 adds SET_TEXT
 * and the `detail` view (docs/ux-v2.md section 7); the host sends them only when version 3 was agreed. Version 4
 * (docs/ui-v3.md section 5) is a rendering marker over version 3: same wire format, the device draws the characters
 * and the speech bubble, and the host fills SET_TEXT rows 0-6 with the bubble in the base views and voice. Version 5
 * (docs/ui-v3.md section 8) adds the optional SET_VIEW layout byte and the SET_SLOT title and age (the LIST layout).
 * Version 6 (docs/ui-v3.md section 10, SPLIT keys and settings) adds the optional SET_VIEW keys byte and task page,
 * the view value 6 `settings` and SET_SLOT flag bit 4 `chosen`; the host sends them only when version 6 was agreed.
 * Version 7 (docs/ui-v3.md section 13, Markdown highlights) lets SET_TEXT row text carry the control bytes 0x01-0x04
 * (rich-text.ts); the host sends them only when version 7 was agreed.
 */
export const PROTOCOL_VERSION = 7;
/** First version with the DETAILS page (SET_TEXT, view `detail`). */
export const DETAIL_VERSION = 3;
/** First version with the UI v3 layout (characters, speech bubble; docs/ui-v3.md section 5). */
export const BUBBLE_VERSION = 4;
/**
 * First version with the LIST layout (docs/ui-v3.md section 8): additive over version 4. SET_VIEW may carry a layout
 * byte and SET_SLOT a row title and age; the host sends those forms only when version 5 was agreed.
 */
export const LIST_VERSION = 5;
/**
 * First version with SPLIT keys and the SETTINGS view (docs/ui-v3.md section 10): additive over version 5. SET_VIEW may
 * carry a keys byte (and, for SPLIT, the task page), view 6 is `settings`, SET_SLOT flag bit 4 marks the chosen
 * filter/task key. The host sends those forms only when version 6 was agreed.
 */
export const SPLIT_VERSION = 6;
/**
 * First version with inline highlights in SET_TEXT rows (docs/ui-v3.md section 13): additive over version 6. A row's
 * text may carry 0x01 bold, 0x02 code, 0x03 off (no column) and 0x04 a column rule (one column); at most 29 visible
 * columns and 8 style bytes (37 bytes). The host sends them only when version 7 was agreed.
 */
export const RICH_TEXT_VERSION = 7;
/** Wire format revision of the frames and bodies; unchanged by the rendering-only version 2. */
export const WIRE_FORMAT = 1;

/** Control change on MIDI channel 16. */
export const CC_STATUS = 0xbf;

export const CC = {
  hostControl: 118,
  hostData: 119,
  deviceControl: 116,
  deviceData: 117,
} as const;

export const FRAME_CONTROL = { start: 1, end: 2, abort: 3 } as const;

export const MAX_BODY = 100;
/** TYPE + SEQ + LEN + CK. */
export const FRAME_OVERHEAD = 4;
export const MAX_FRAME = MAX_BODY + FRAME_OVERHEAD;
export const SEQ_MODULO = 128;
export const CHECKSUM_XOR = 0x2a;

/** The `req_seq` value meaning "no originating device frame". */
export const NO_REQ_SEQ = 127;

export const SLOT_COUNT = 27;

export const MessageType = {
  HELLO: 0x01,
  BUTTON: 0x02,
  KEY: 0x03,
  ENCODER: 0x04,
  POT: 0x05,
  DEVICE_HEARTBEAT: 0x06,
  DEVICE_ACK: 0x07,
  HELLO_ACK: 0x41,
  SET_VIEW: 0x42,
  SET_SLOT: 0x43,
  SET_DETAIL: 0x44,
  SET_VOICE: 0x45,
  SET_LEGEND: 0x46,
  SET_STATUS: 0x47,
  COMMAND_RESULT: 0x48,
  HOST_HEARTBEAT: 0x49,
  HOST_ACK: 0x4a,
  CLEAR_SLOTS: 0x4b,
  SET_TEXT: 0x4c,
} as const;

export const STR_MAX = {
  helloAckReason: 24,
  viewTitle: 20,
  slotLabel: 12,
  detailLine: 20,
  voiceTarget: 20,
  legendLabel: 6,
  statusText: 20,
  commandText: 20,
  textRow: 29,
  slotTitle: 20,
  slotAge: 3,
  /** Version 5 GROUPED (docs/ui-v3.md section 9.5): the header row's title and count. */
  headTitle: 20,
  headCount: 11,
} as const;

/** SET_SLOT row byte (docs/ui-v3.md section 9.5): bits 0-1 indent, bit 2 start, bit 3 task; bits 4-6 zero. */
export const ROW_INDENT_MAX = 2;
export const ROW_START = 4;
export const ROW_TASK = 8;

/** SET_TEXT: rows in the DETAILS buffer and rows per frame (docs/protocol.md section 4). */
export const TEXT_ROWS = 12;

/** SET_SLOT flags (docs/protocol.md section 4): bit 4 `chosen` (version 6) never together with bit 0 `selected`. */
export const FLAG_CHOSEN = 16;
export const FLAGS_MAX = 31;
export const TEXT_ROWS_PER_FRAME = 3;

export const TIMING = {
  retransmitMs: 250,
  maxRetransmits: 3,
  heartbeatMs: 1000,
  helloMs: 1000,
  peerTimeoutMs: 3500,
  slotCoalesceMs: 50,
  hostMaxFramesPerSecond: 200,
  dedupWindow: 32,
} as const;
