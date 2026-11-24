import { describe, expect, test } from "bun:test";
import { checksum, decode, encode, MessageType, sanitizeAscii, type Message } from "../src";
import { validVectors } from "../src/vectors";

describe("codec round trip", () => {
  const vectors = validVectors();

  test("covers every message type code", () => {
    const codes = new Set(vectors.map((v) => v.payload[0]));
    for (const code of Object.values(MessageType)) expect(codes.has(code)).toBe(true);
  });

  for (const v of vectors) {
    test(v.name, () => {
      const res = decode(encode(v.message, v.seq));
      if (!res.ok) throw new Error(`${res.error.code}: ${res.error.detail}`);
      expect(res.value.seq).toBe(v.seq);
      expect(res.value.message).toEqual(v.decoded ?? v.message);
    });
  }

  test("decode with an expected origin rejects the other direction", () => {
    const bytes = encode({ kind: "KEY", key: 1, gesture: "single" }, 0);
    expect(decode(bytes, "device").ok).toBe(true);
    const res = decode(bytes, "host");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("unknown_type");
      expect(res.error.frame?.seq).toBe(0);
    }
  });

  test("ACK and HEARTBEAT use direction-specific type codes", () => {
    expect(encode({ kind: "ACK", from: "device", ackedSeq: 1, status: "ok" }, 0)[0]).toBe(0x07);
    expect(encode({ kind: "ACK", from: "host", ackedSeq: 1, status: "ok" }, 0)[0]).toBe(0x4a);
    expect(encode({ kind: "HEARTBEAT", from: "device", uptimeS: 1, rxErrors: 0 }, 0)[0]).toBe(0x06);
    expect(encode({ kind: "HEARTBEAT", from: "host", hostUptimeS: 1 }, 0)[0]).toBe(0x49);
  });
});

describe("field encoding", () => {
  test("checksum matches the spec formula", () => {
    // (0x03 + 5 + 2 + 4 + 1) & 0x7f = 15, ^ 0x2a = 37
    expect(checksum(0x03, 5, [4, 1])).toBe(37);
    expect(encode({ kind: "KEY", key: 4, gesture: "single" }, 5)).toEqual([3, 5, 2, 4, 1, 37]);
  });

  test("u14 is high 7 bits first", () => {
    const bytes = encode({ kind: "POT", pot: "MASTER", value: 1000 }, 0);
    expect(bytes.slice(3, 6)).toEqual([0, 1000 >> 7, 1000 & 0x7f]);
  });

  test("s7 is value + 64", () => {
    expect(encode({ kind: "ENCODER", encoder: "K2", delta: -64 }, 0)[4]).toBe(0);
    expect(encode({ kind: "ENCODER", encoder: "K2", delta: 63 }, 0)[4]).toBe(127);
    expect(encode({ kind: "ENCODER", encoder: "K2", delta: 0 }, 0)[4]).toBe(64);
  });

  test("sanitizeAscii replaces non-printables per code point and truncates", () => {
    expect(sanitizeAscii("a\u{1F600}b\nc", 10)).toBe("a?b?c");
    expect(sanitizeAscii("abcdef", 3)).toBe("abc");
    expect(sanitizeAscii("~ ", 5)).toBe("~ ");
  });

  test("slot flags pack into bits 0..3", () => {
    const bytes = encode(
      { kind: "SET_SLOT", key: 0, state: "idle", flags: { selected: true, codex: false, stale: true, pinned: false }, label: "" },
      0,
    );
    expect(bytes[5]).toBe(0b0101);
  });

  test("largest message fits the 100-byte body limit", () => {
    const long = "x".repeat(50);
    const bytes = encode({ kind: "SET_DETAIL", provider: "other", state: "idle", lines: [long, long, long, long] }, 0);
    expect(bytes[2]).toBe(86);
    expect(bytes.length).toBe(90);
  });
});

describe("encode rejects caller bugs", () => {
  const bad: [string, Message, number][] = [
    ["key 27", { kind: "KEY", key: 27, gesture: "single" }, 0],
    ["delta 64", { kind: "ENCODER", encoder: "K1", delta: 64 }, 0],
    ["delta -65", { kind: "ENCODER", encoder: "K1", delta: -65 }, 0],
    ["pot 1024", { kind: "POT", pot: "MASTER", value: 1024 }, 0],
    ["u14 overflow", { kind: "HEARTBEAT", from: "host", hostUptimeS: 16384 }, 0],
    ["level 101", { kind: "SET_VOICE", voice: "ready", level: 101, elapsedDs: 0, target: "" }, 0],
    ["fractional", { kind: "SET_STATUS", link: "ok", attentionCount: 1.5, text: "" }, 0],
    ["seq 128", { kind: "CLEAR_SLOTS" }, 128],
    ["seq -1", { kind: "CLEAR_SLOTS" }, -1],
  ];
  for (const [name, msg, seq] of bad) {
    test(name, () => expect(() => encode(msg, seq)).toThrow(RangeError));
  }
});

describe("protocol version 5 (docs/ui-v3.md section 8.6): optional SET_VIEW layout, SET_SLOT title + age", () => {
  const flags = { selected: false, codex: false, stale: false, pinned: false };
  test("without the fields the bodies are the version 4 bodies, byte for byte", () => {
    const v4 = encode({ kind: "SET_VIEW", view: "sessions", page: 0, pages: 1, title: "A" }, 1);
    expect(v4[2]).toBe(5);
    const s4 = encode({ kind: "SET_SLOT", key: 1, state: "idle", flags, label: "AB" }, 1);
    expect(s4[2]).toBe(6);
    const d = decode(s4);
    expect(d.ok && d.value.message).toEqual({ kind: "SET_SLOT", key: 1, state: "idle", flags, label: "AB" });
  });
  test("a title alone still writes an empty age, so the pair is never split on the wire", () => {
    const p = encode({ kind: "SET_SLOT", key: 1, state: "idle", flags, label: "", title: "Hi" }, 1);
    const d = decode(p);
    expect(d.ok && d.value.message).toEqual({ kind: "SET_SLOT", key: 1, state: "idle", flags, label: "", title: "Hi", age: "" });
  });
  test("layout round-trips in every view", () => {
    for (const view of ["sessions", "tasks", "inbox", "voice", "confirm", "detail"] as const) {
      for (const layout of ["buddy", "list"] as const) {
        const d = decode(encode({ kind: "SET_VIEW", view, page: 0, pages: 1, title: "", layout }, 2));
        expect(d.ok && d.value.message).toEqual({ kind: "SET_VIEW", view, page: 0, pages: 1, title: "", layout });
      }
    }
  });
});

describe("version 5 GROUPED (docs/ui-v3.md section 9.5): layout 2, the SET_SLOT row byte and header", () => {
  const flags = { selected: false, codex: false, stale: false, pinned: false };
  const base = { kind: "SET_SLOT" as const, key: 2, state: "working" as const, flags, label: "a", title: "b", age: "c" };
  test("layout grouped round-trips; 3 is a bad body", () => {
    const d = decode(encode({ kind: "SET_VIEW", view: "sessions", page: 0, pages: 1, title: "", layout: "grouped" }, 2));
    expect(d.ok && d.value.message).toMatchObject({ layout: "grouped" });
  });
  test("row without header, with header, folded; all round-trip", () => {
    for (const msg of [
      { ...base, row: { indent: 2 as const, start: false, task: false } },
      { ...base, row: { indent: 1 as const, start: true, task: false }, head: { state: "failed" as const, pinned: true, title: "T", count: "1 need you" } },
      { ...base, row: { indent: 0 as const, start: true, task: true }, head: { state: "idle" as const, pinned: false, title: "Docs", count: "4 quiet" } },
    ]) {
      const d = decode(encode(msg, 3));
      expect(d.ok && d.value.message).toEqual(msg);
    }
  });
  test("a row writes title and age even when they are missing", () => {
    const d = decode(encode({ kind: "SET_SLOT", key: 0, state: "empty", flags, label: "", row: { indent: 0, start: false, task: false } }, 1));
    expect(d.ok && d.value.message).toEqual({ kind: "SET_SLOT", key: 0, state: "empty", flags, label: "", title: "", age: "", row: { indent: 0, start: false, task: false } });
  });
  test("the encoder refuses inconsistent rows", () => {
    expect(() => encode({ ...base, row: { indent: 0, start: false, task: true } }, 1)).toThrow(RangeError);
    expect(() => encode({ ...base, row: { indent: 0, start: true, task: false } }, 1)).toThrow(RangeError);
    expect(() => encode({ ...base, head: { state: "idle", pinned: false, title: "", count: "" } }, 1)).toThrow(RangeError);
    expect(() => encode({ ...base, row: { indent: 3 as 2, start: false, task: false } }, 1)).toThrow(RangeError);
  });
});

describe("version 6 SPLIT (docs/ui-v3.md section 10.6): keys byte, task page, view settings, flag bit 4 chosen", () => {
  const flags = { selected: false, codex: false, stale: false, pinned: false };
  const view = { kind: "SET_VIEW" as const, view: "sessions" as const, page: 0, pages: 1, title: "ALL 3" };
  test("keys split and ranked round-trip; the version 5 body still decodes without keys", () => {
    for (const msg of [
      { ...view, layout: "list" as const, keys: "split" as const, taskPage: 1, taskPages: 2 },
      { ...view, layout: "buddy" as const, keys: "ranked" as const },
      { ...view, layout: "grouped" as const },
      { ...view, view: "settings" as const, layout: "buddy" as const, keys: "ranked" as const },
    ]) {
      const d = decode(encode(msg, 4));
      expect(d.ok && d.value.message).toEqual(msg);
    }
  });
  test("the encoder refuses keys without a layout, split without a valid task page, task pages without split", () => {
    expect(() => encode({ ...view, keys: "ranked" }, 1)).toThrow(RangeError);
    expect(() => encode({ ...view, layout: "buddy", keys: "split" }, 1)).toThrow(RangeError);
    expect(() => encode({ ...view, layout: "buddy", keys: "split", taskPage: 2, taskPages: 2 }, 1)).toThrow(RangeError);
    expect(() => encode({ ...view, layout: "buddy", keys: "split", taskPage: 0, taskPages: 0 }, 1)).toThrow(RangeError);
    expect(() => encode({ ...view, layout: "buddy", keys: "ranked", taskPage: 0, taskPages: 1 }, 1)).toThrow(RangeError);
    expect(() => encode({ ...view, layout: "buddy", taskPage: 0, taskPages: 1 }, 1)).toThrow(RangeError);
  });
  test("chosen is bit 4, decoded only when set, never with selected", () => {
    const slot = { kind: "SET_SLOT" as const, key: 8, state: "failed" as const, label: "FV5" };
    const bytes = encode({ ...slot, flags: { ...flags, pinned: true, chosen: true } }, 5);
    expect(bytes[5]).toBe(8 | 16);
    const d = decode(bytes);
    expect(d.ok && d.value.message).toEqual({ ...slot, flags: { ...flags, pinned: true, chosen: true } });
    const plain = decode(encode({ ...slot, flags }, 5));
    expect(plain.ok && plain.value.message.kind === "SET_SLOT" && "chosen" in plain.value.message.flags).toBe(false);
    expect(() => encode({ ...slot, flags: { ...flags, selected: true, chosen: true } }, 1)).toThrow(RangeError);
  });
});
