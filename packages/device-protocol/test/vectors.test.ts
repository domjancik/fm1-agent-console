import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { decode, encode, FrameAssembler, HOST_VERSIONS, negotiate, payloadToMidi, PROTOCOL_VERSION, RICH_TEXT_VERSION, SPLIT_VERSION, type VectorFile } from "../src";
import { renderVectorFile, VECTORS_PATH } from "../scripts/gen-vectors";

/** Frame-level rules from docs/protocol.md section 2, checked independently. */
function brokenRules(b: readonly number[]): string[] {
  if (b.length < 4) return ["bad_length"];
  const out: string[] = [];
  if (b.some((x) => x > 0x7f)) out.push("not_7bit");
  const len = b[2] ?? 0;
  if (len > 100) out.push("len_too_large");
  else if (b.length !== len + 4) out.push("bad_length");
  const sum = b.slice(0, -1).reduce((a, x) => a + x, 0);
  if (((sum & 0x7f) ^ 0x2a) !== b.at(-1)) out.push("bad_checksum");
  return out;
}

const V6_VALID = ["set_view_split", "set_view_split_grouped", "set_view_split_max", "set_view_keys_ranked", "set_view_settings", "set_view_settings_v5_body",
  "set_slot_task_chosen", "set_slot_filter_needs", "set_slot_chosen_v4_body", "set_slot_chosen_flags_max_row"];
const V6_INVALID = ["set_view_view_7", "set_slot_flags_32", "set_view_keys_2", "set_view_split_no_task_page", "set_view_split_no_task_pages", "set_view_task_pages_0",
  "set_view_task_page_past_end", "set_view_ranked_extra_byte", "set_view_split_extra_byte", "set_slot_selected_and_chosen"];

const onDisk = readFileSync(VECTORS_PATH, "utf8");
const file = JSON.parse(onDisk) as VectorFile;

describe("fixtures/device/vectors.json", () => {
  test("is up to date with the generator", () => {
    expect(onDisk).toBe(renderVectorFile());
  });

  test("has the expected coverage", () => {
    expect(file.valid.length).toBeGreaterThanOrEqual(40);
    expect(file.invalid.length).toBeGreaterThanOrEqual(15);
    expect(file.valid.some((v) => v.seq === 127)).toBe(true);
    const errors = new Set(file.invalid.map((v) => v.expectedError));
    for (const code of ["bad_length", "not_7bit", "len_too_large", "bad_checksum", "unknown_type", "bad_body"]) {
      expect(errors.has(code as never)).toBe(true);
    }
  });

  for (const v of file.valid) {
    test(`valid: ${v.name}`, () => {
      expect(encode(v.message, v.seq)).toEqual(v.payload);
      const res = decode(v.payload);
      if (!res.ok) throw new Error(res.error.detail);
      expect(res.value.message).toEqual(v.decoded ?? v.message);
      const sender = v.direction === "device_to_host" ? "device" : "host";
      expect(payloadToMidi(v.payload, sender)).toEqual(v.midi);
      const asm = new FrameAssembler(sender);
      const out = v.midi.map((m) => asm.push(m)).filter((p) => p !== undefined);
      expect(out).toEqual([v.payload]);
    });
  }

  for (const v of file.invalid) {
    test(`invalid: ${v.name}`, () => {
      const res = decode(v.payload, v.sender);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe(v.expectedError);
      // only one rule is broken, whatever order a decoder checks them in
      const broken = brokenRules(v.payload);
      if (v.expectedError === "unknown_type" || v.expectedError === "bad_body") expect(broken).toEqual([]);
      else expect(broken).toEqual([v.expectedError]);
      if (v.sender) expect(decode(v.payload).ok).toBe(true);
    });
  }

  test("negotiation: the UX v2, v3, UI v3 (proto 4), LIST (proto 5) and SPLIT (proto 6) and rich text (proto 7) cases, and the host range is 1..7", () => {
    expect(PROTOCOL_VERSION).toBe(7);
    expect(SPLIT_VERSION).toBe(6);
    expect(RICH_TEXT_VERSION).toBe(7);
    expect(HOST_VERSIONS).toEqual({ min: 1, max: 7 });
    expect(file.protocol).toBe(1);
    expect(file.negotiation.map((n) => [n.device.max, n.host.max, n.proto])).toEqual([
      [2, 2, 2], [1, 2, 1], [2, 1, 1], [3, 3, 3], [2, 3, 2], [3, 2, 2], [1, 3, 1],
      [4, 4, 4], [3, 4, 3], [4, 3, 3], [1, 4, 1],
      [5, 5, 5], [4, 5, 4], [5, 4, 4], [1, 5, 1],
      [6, 6, 6], [5, 6, 5], [6, 5, 5], [1, 6, 1],
      [7, 7, 7], [6, 7, 6], [7, 6, 6], [1, 7, 1],
    ]);
  });

  test("SET_TEXT: largest body fits LEN 100, and every version 3 vector is present", () => {
    const max = file.valid.find((v) => v.name === "set_text_three_rows_max");
    expect(max?.payload[2]).toBe(95);
    const names = new Set([...file.valid, ...file.invalid].map((v) => v.name));
    for (const n of ["set_view_detail", "set_text_one_row", "set_text_empty_rows", "set_text_sanitised", "type_0x4d", "set_view_view_7", "set_text_row_12", "set_text_count_0", "set_text_count_4", "set_text_past_end", "set_text_style_3", "set_text_str_30"]) {
      expect(names.has(n)).toBe(true);
    }
  });

  test("version 5: the LIST vectors are present, older vectors are untouched, largest SET_SLOT is 41 bytes", () => {
    const names = new Set([...file.valid, ...file.invalid].map((v) => v.name));
    for (const n of ["set_view_list", "set_view_todo_buddy", "set_slot_list_row", "set_slot_list_max", "set_slot_list_empty_strings", "set_slot_list_truncated",
      "set_view_layout_3", "set_view_layout_extra_byte", "set_slot_title_21", "set_slot_age_4", "set_slot_title_no_age", "set_slot_list_extra_byte"]) {
      expect(names.has(n)).toBe(true);
    }
    expect(file.valid.find((v) => v.name === "set_slot_list_max")?.payload[2]).toBe(41);
    // the version 1-4 bodies carry no version 5 field, so a version 4 decoder still reads them
    for (const v of file.valid) {
      if (v.name.includes("list") || v.name.includes("group") || v.name === "set_view_todo_buddy" || V6_VALID.includes(v.name)) continue;
      const m = v.message;
      expect((m.kind === "SET_VIEW" && "layout" in m) || (m.kind === "SET_SLOT" && ("title" in m || "age" in m))).toBe(false);
    }
  });

  test("version 5 GROUPED (docs/ui-v3.md section 9.5): vectors present, largest SET_SLOT is 77 bytes, row only after title + age", () => {
    const names = new Set([...file.valid, ...file.invalid].map((v) => v.name));
    for (const n of ["set_view_grouped", "set_slot_group_header", "set_slot_group_member", "set_slot_group_child", "set_slot_group_folded", "set_slot_group_max",
      "set_slot_group_truncated", "set_view_layout_3", "set_slot_row_indent_3", "set_slot_row_bit4", "set_slot_row_task_no_start", "set_slot_head_missing",
      "set_slot_head_flags_2", "set_slot_head_title_21", "set_slot_head_count_12", "set_slot_group_extra_byte", "set_slot_row_no_start_extra"]) {
      expect(names.has(n)).toBe(true);
    }
    expect(names.has("set_view_layout_2")).toBe(false);
    expect(file.valid.find((v) => v.name === "set_slot_group_max")?.payload[2]).toBe(77);
    for (const v of file.valid) {
      const m = v.message;
      if (m.kind !== "SET_SLOT" || m.row === undefined) continue;
      expect(m.title !== undefined && m.age !== undefined).toBe(true);
      expect(m.head !== undefined).toBe(m.row.start);
    }
  });

  test("version 6 SPLIT (docs/ui-v3.md section 10.6): vectors present, keys only after a layout, task page only with split, chosen never with selected", () => {
    const names = new Set([...file.valid, ...file.invalid].map((v) => v.name));
    for (const n of [...V6_VALID, ...V6_INVALID]) expect(names.has(n)).toBe(true);
    // the two vectors whose rule version 6 relaxed are gone (view 6 and flag bit 4 are valid now)
    expect(names.has("set_view_view_6")).toBe(false);
    expect(names.has("set_slot_flags_16")).toBe(false);
    for (const v of file.valid) {
      const m = v.message;
      if (m.kind === "SET_VIEW") {
        if (m.keys !== undefined) expect(m.layout).toBeDefined();
        expect(m.taskPage !== undefined).toBe(m.keys === "split");
        expect(m.taskPages !== undefined).toBe(m.keys === "split");
        if (m.keys === "split") expect(m.taskPage ?? 0).toBeLessThan(m.taskPages ?? 0);
        if (!V6_VALID.includes(v.name)) expect(m.keys === undefined && m.view !== "settings").toBe(true);
      }
      if (m.kind === "SET_SLOT") {
        expect(m.flags.selected && m.flags.chosen).not.toBe(true);
        if (!V6_VALID.includes(v.name)) expect(m.flags.chosen).toBeUndefined();
      }
    }
    // a version 6 SET_VIEW grows by 3 bytes at most (keys + task page + task pages); the largest SET_SLOT is unchanged
    expect(file.valid.find((v) => v.name === "set_view_split_max")?.payload[2]).toBe(3 + 21 + 1 + 3);
    expect(Math.max(...file.valid.filter((v) => v.message.kind === "SET_SLOT").map((v) => v.payload[2] ?? 0))).toBe(77);
  });

  for (const n of file.negotiation) {
    test(`negotiation: ${n.name}`, () => {
      expect(negotiate(n.device, n.host)).toEqual({ proto: n.proto, reason: "" });
    });
  }
});
