import { FLAG_CHOSEN, FLAGS_MAX, MessageType, NO_REQ_SEQ, ROW_INDENT_MAX, ROW_START, ROW_TASK, SLOT_COUNT, STR_MAX, TEXT_ROWS, TEXT_ROWS_PER_FRAME } from "./constants";
import {
  AckStatuses,
  Buttons,
  CommandResults,
  Edges,
  Encoders,
  Gestures,
  KeyModes,
  Layouts,
  LinkStates,
  Pots,
  Providers,
  SlotStates,
  TextStyles,
  Views,
  VoiceStates,
} from "./enums";
import { BodyError, BodyReader, BodyWriter } from "./fields";
import type { FourStrings, Message, SetSlot, SetView, SlotFlags, SlotRow, TextRow } from "./messages";

const MAX_KEY = SLOT_COUNT - 1;

export function typeCodeOf(msg: Message): number {
  switch (msg.kind) {
    case "HELLO":
      return MessageType.HELLO;
    case "BUTTON":
      return MessageType.BUTTON;
    case "KEY":
      return MessageType.KEY;
    case "ENCODER":
      return MessageType.ENCODER;
    case "POT":
      return MessageType.POT;
    case "HEARTBEAT":
      return msg.from === "device" ? MessageType.DEVICE_HEARTBEAT : MessageType.HOST_HEARTBEAT;
    case "ACK":
      return msg.from === "device" ? MessageType.DEVICE_ACK : MessageType.HOST_ACK;
    case "HELLO_ACK":
      return MessageType.HELLO_ACK;
    case "SET_VIEW":
      return MessageType.SET_VIEW;
    case "SET_SLOT":
      return MessageType.SET_SLOT;
    case "SET_DETAIL":
      return MessageType.SET_DETAIL;
    case "SET_VOICE":
      return MessageType.SET_VOICE;
    case "SET_LEGEND":
      return MessageType.SET_LEGEND;
    case "SET_STATUS":
      return MessageType.SET_STATUS;
    case "COMMAND_RESULT":
      return MessageType.COMMAND_RESULT;
    case "CLEAR_SLOTS":
      return MessageType.CLEAR_SLOTS;
    case "SET_TEXT":
      return MessageType.SET_TEXT;
  }
}

const flagsToWire = (f: SlotFlags): number => {
  if (f.selected && f.chosen) throw new RangeError("flags.selected and flags.chosen are exclusive");
  return (f.selected ? 1 : 0) | (f.codex ? 2 : 0) | (f.stale ? 4 : 0) | (f.pinned ? 8 : 0) | (f.chosen ? FLAG_CHOSEN : 0);
};

const flagsFromWire = (v: number): SlotFlags => {
  // Version 6: bit 4 chosen (the SPLIT black row), never with bit 0 selected (docs/ui-v3.md section 10.6).
  if ((v & 1) !== 0 && (v & FLAG_CHOSEN) !== 0) throw new BodyError("flags: selected and chosen together");
  const f: SlotFlags = { selected: (v & 1) !== 0, codex: (v & 2) !== 0, stale: (v & 4) !== 0, pinned: (v & 8) !== 0 };
  if ((v & FLAG_CHOSEN) !== 0) f.chosen = true;
  return f;
};

const rowToWire = (r: SlotRow): number => {
  if (!Number.isInteger(r.indent) || r.indent < 0 || r.indent > ROW_INDENT_MAX) throw new RangeError(`row.indent ${r.indent} out of 0..${ROW_INDENT_MAX}`);
  return r.indent | (r.start ? ROW_START : 0) | (r.task ? ROW_TASK : 0);
};

const rowFromWire = (v: number): SlotRow => {
  const indent = v & 3;
  if (indent > ROW_INDENT_MAX || (v & 0x70) !== 0) throw new BodyError(`row ${v} invalid`);
  const start = (v & ROW_START) !== 0;
  const task = (v & ROW_TASK) !== 0;
  if (task && !start) throw new BodyError("row.task without row.start");
  return { indent: indent as SlotRow["indent"], start, task };
};

const writeFour = (w: BodyWriter, s: FourStrings, max: number): void => {
  for (const line of s) w.str(line, max);
};

const readFour = (r: BodyReader, field: string, max: number): FourStrings => [
  r.str(`${field}[0]`, max),
  r.str(`${field}[1]`, max),
  r.str(`${field}[2]`, max),
  r.str(`${field}[3]`, max),
];

export function writeBody(msg: Message): number[] {
  const w = new BodyWriter();
  switch (msg.kind) {
    case "HELLO":
      w.u7(msg.protoMin, "protoMin").u7(msg.protoMax, "protoMax");
      w.u7(msg.fwMajor, "fwMajor").u7(msg.fwMinor, "fwMinor").u7(msg.fwPatch, "fwPatch");
      w.u14(msg.bootId, "bootId");
      break;
    case "BUTTON":
      w.enum(Buttons, msg.button).enum(Edges, msg.edge);
      break;
    case "KEY":
      w.u7(msg.key, "key", 0, MAX_KEY).enum(Gestures, msg.gesture);
      break;
    case "ENCODER":
      w.enum(Encoders, msg.encoder).s7(msg.delta, "delta");
      break;
    case "POT":
      w.enum(Pots, msg.pot).u14(msg.value, "value", 1023);
      break;
    case "HEARTBEAT":
      if (msg.from === "device") w.u14(msg.uptimeS, "uptimeS").u7(msg.rxErrors, "rxErrors");
      else w.u14(msg.hostUptimeS, "hostUptimeS");
      break;
    case "ACK":
      w.u7(msg.ackedSeq, "ackedSeq").enum(AckStatuses, msg.status);
      break;
    case "HELLO_ACK":
      w.u7(msg.proto, "proto").u14(msg.hostSession, "hostSession");
      w.str(msg.reason, STR_MAX.helloAckReason);
      break;
    case "SET_VIEW":
      w.enum(Views, msg.view).u7(msg.page, "page").u7(msg.pages, "pages");
      w.str(msg.title, STR_MAX.viewTitle);
      if (msg.layout !== undefined) w.enum(Layouts, msg.layout);
      if (msg.keys !== undefined) {
        // Version 6 (docs/ui-v3.md section 10.6): the keys byte, then for SPLIT the task page and the task page count.
        if (msg.layout === undefined) throw new RangeError("keys needs a layout");
        w.enum(KeyModes, msg.keys);
        if (msg.keys === "split") {
          const pages = msg.taskPages ?? -1;
          w.u7(msg.taskPage ?? -1, "taskPage", 0, Math.max(0, pages - 1)).u7(pages, "taskPages", 1, 127);
        } else if (msg.taskPage !== undefined || msg.taskPages !== undefined) throw new RangeError("taskPage/taskPages need keys split");
      } else if (msg.taskPage !== undefined || msg.taskPages !== undefined) throw new RangeError("taskPage/taskPages need keys split");
      break;
    case "SET_SLOT":
      w.u7(msg.key, "key", 0, MAX_KEY).enum(SlotStates, msg.state);
      w.u7(flagsToWire(msg.flags), "flags").str(msg.label, STR_MAX.slotLabel);
      if (msg.title !== undefined || msg.age !== undefined || msg.row !== undefined) w.str(msg.title ?? "", STR_MAX.slotTitle).str(msg.age ?? "", STR_MAX.slotAge);
      if (msg.row !== undefined) {
        // Version 5 GROUPED (docs/ui-v3.md section 9.5): the row byte, then the header when it starts a group.
        if (msg.row.task && !msg.row.start) throw new RangeError("row.task needs row.start");
        if ((msg.head !== undefined) !== msg.row.start) throw new RangeError("head must be present exactly when row.start is set");
        w.u7(rowToWire(msg.row), "row");
        if (msg.head) {
          w.enum(SlotStates, msg.head.state).u7(msg.head.pinned ? 1 : 0, "head.flags");
          w.str(msg.head.title, STR_MAX.headTitle).str(msg.head.count, STR_MAX.headCount);
        }
      } else if (msg.head !== undefined) throw new RangeError("head needs a row");
      break;
    case "SET_DETAIL":
      w.enum(Providers, msg.provider).enum(SlotStates, msg.state);
      writeFour(w, msg.lines, STR_MAX.detailLine);
      break;
    case "SET_VOICE":
      w.enum(VoiceStates, msg.voice).u7(msg.level, "level", 0, 100);
      w.u14(msg.elapsedDs, "elapsedDs").str(msg.target, STR_MAX.voiceTarget);
      break;
    case "SET_LEGEND":
      writeFour(w, msg.labels, STR_MAX.legendLabel);
      break;
    case "SET_STATUS":
      w.enum(LinkStates, msg.link).u7(msg.attentionCount, "attentionCount");
      w.str(msg.text, STR_MAX.statusText);
      break;
    case "COMMAND_RESULT":
      w.u7(msg.reqSeq, "reqSeq").enum(CommandResults, msg.result);
      w.str(msg.text, STR_MAX.commandText);
      break;
    case "CLEAR_SLOTS":
      break;
    case "SET_TEXT": {
      const n = msg.lines.length;
      w.u7(msg.row, "row", 0, TEXT_ROWS - 1).u7(n, "count", 1, Math.min(TEXT_ROWS_PER_FRAME, TEXT_ROWS - msg.row));
      for (const line of msg.lines) w.enum(TextStyles, line.style).textRow(line.text);
      break;
    }
  }
  return w.bytes;
}

/** Returns undefined for an unknown type code; throws BodyError for a malformed body. */
export function readBody(type: number, body: readonly number[]): Message | undefined {
  const r = new BodyReader(body);
  const msg = readFields(type, r);
  if (msg) r.end();
  return msg;
}

function readFields(type: number, r: BodyReader): Message | undefined {
  switch (type) {
    case MessageType.HELLO:
      return {
        kind: "HELLO",
        protoMin: r.u7("protoMin"),
        protoMax: r.u7("protoMax"),
        fwMajor: r.u7("fwMajor"),
        fwMinor: r.u7("fwMinor"),
        fwPatch: r.u7("fwPatch"),
        bootId: r.u14("bootId"),
      };
    case MessageType.BUTTON:
      return { kind: "BUTTON", button: r.enum("button", Buttons), edge: r.enum("edge", Edges) };
    case MessageType.KEY:
      return { kind: "KEY", key: r.u7("key", 0, MAX_KEY), gesture: r.enum("gesture", Gestures) };
    case MessageType.ENCODER:
      return { kind: "ENCODER", encoder: r.enum("encoder", Encoders), delta: r.s7("delta") };
    case MessageType.POT:
      return { kind: "POT", pot: r.enum("pot", Pots), value: r.u14("value", 1023) };
    case MessageType.DEVICE_HEARTBEAT:
      return { kind: "HEARTBEAT", from: "device", uptimeS: r.u14("uptimeS"), rxErrors: r.u7("rxErrors") };
    case MessageType.DEVICE_ACK:
      return { kind: "ACK", from: "device", ackedSeq: r.u7("ackedSeq"), status: r.enum("status", AckStatuses) };
    case MessageType.HELLO_ACK:
      return {
        kind: "HELLO_ACK",
        proto: r.u7("proto"),
        hostSession: r.u14("hostSession"),
        reason: r.str("reason", STR_MAX.helloAckReason),
      };
    case MessageType.SET_VIEW: {
      const msg: SetView = {
        kind: "SET_VIEW",
        view: r.enum("view", Views),
        page: r.u7("page"),
        pages: r.u7("pages"),
        title: r.str("title", STR_MAX.viewTitle),
      };
      // Version 5: an optional layout byte (decoding does not depend on the negotiated version).
      if (r.remaining() > 0) msg.layout = r.enum("layout", Layouts);
      // Version 6: an optional keys byte after it; SPLIT carries the task page and the task page count.
      if (r.remaining() > 0) {
        msg.keys = r.enum("keys", KeyModes);
        if (msg.keys === "split") {
          const taskPage = r.u7("taskPage");
          const taskPages = r.u7("taskPages", 1, 127);
          if (taskPage >= taskPages) throw new BodyError(`taskPage ${taskPage} not below taskPages ${taskPages}`);
          msg.taskPage = taskPage;
          msg.taskPages = taskPages;
        }
      }
      return msg;
    }
    case MessageType.SET_SLOT: {
      const msg: SetSlot = {
        kind: "SET_SLOT",
        key: r.u7("key", 0, MAX_KEY),
        state: r.enum("state", SlotStates),
        flags: flagsFromWire(r.u7("flags", 0, FLAGS_MAX)),
        label: r.str("label", STR_MAX.slotLabel),
      };
      // Version 5: the row title and age, both or neither.
      if (r.remaining() > 0) {
        msg.title = r.str("title", STR_MAX.slotTitle);
        msg.age = r.str("age", STR_MAX.slotAge);
        // Version 5 GROUPED: the optional row byte, and the header after a `start` row.
        if (r.remaining() > 0) {
          msg.row = rowFromWire(r.u7("row"));
          if (msg.row.start) {
            const state = r.enum("head.state", SlotStates);
            const pinned = r.u7("head.flags", 0, 1) === 1;
            msg.head = { state, pinned, title: r.str("head.title", STR_MAX.headTitle), count: r.str("head.count", STR_MAX.headCount) };
          }
        }
      }
      return msg;
    }
    case MessageType.SET_DETAIL:
      return {
        kind: "SET_DETAIL",
        provider: r.enum("provider", Providers),
        state: r.enum("state", SlotStates),
        lines: readFour(r, "lines", STR_MAX.detailLine),
      };
    case MessageType.SET_VOICE:
      return {
        kind: "SET_VOICE",
        voice: r.enum("voice", VoiceStates),
        level: r.u7("level", 0, 100),
        elapsedDs: r.u14("elapsedDs"),
        target: r.str("target", STR_MAX.voiceTarget),
      };
    case MessageType.SET_LEGEND:
      return { kind: "SET_LEGEND", labels: readFour(r, "labels", STR_MAX.legendLabel) };
    case MessageType.SET_STATUS:
      return {
        kind: "SET_STATUS",
        link: r.enum("link", LinkStates),
        attentionCount: r.u7("attentionCount"),
        text: r.str("text", STR_MAX.statusText),
      };
    case MessageType.COMMAND_RESULT:
      return {
        kind: "COMMAND_RESULT",
        reqSeq: r.u7("reqSeq", 0, NO_REQ_SEQ),
        result: r.enum("result", CommandResults),
        text: r.str("text", STR_MAX.commandText),
      };
    case MessageType.HOST_HEARTBEAT:
      return { kind: "HEARTBEAT", from: "host", hostUptimeS: r.u14("hostUptimeS") };
    case MessageType.HOST_ACK:
      return { kind: "ACK", from: "host", ackedSeq: r.u7("ackedSeq"), status: r.enum("status", AckStatuses) };
    case MessageType.CLEAR_SLOTS:
      return { kind: "CLEAR_SLOTS" };
    case MessageType.SET_TEXT: {
      const row = r.u7("row", 0, TEXT_ROWS - 1);
      const count = r.u7("count", 1, Math.min(TEXT_ROWS_PER_FRAME, TEXT_ROWS - row));
      const lines: TextRow[] = [];
      for (let i = 0; i < count; i++) lines.push({ style: r.enum(`lines[${i}].style`, TextStyles), text: r.textRow(`lines[${i}].text`) });
      return { kind: "SET_TEXT", row, lines };
    }
    default:
      return undefined;
  }
}
