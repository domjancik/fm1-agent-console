// Protocol version 7 (docs/ui-v3.md section 13, docs/protocol.md section 3): Markdown highlights in SET_TEXT rows. A
// version 7 simulator gets the control bytes and draws them; a version 6 device gets the same rows as plain text.
import { afterEach, describe, expect, test } from "bun:test";
import type { DeviceView } from "@fm1/agent-core";
import { encode, MAX_BODY, stripSpans, visibleLength, type SetText } from "@fm1/device-protocol";
import { SIM_VERSIONS_V7 } from "@fm1/device-simulator";
import { framesFor, richText, textFrames } from "../src/device/render";
import { rig, type Rig } from "./rig";

let r: Rig | undefined;
afterEach(async () => {
  await r?.stop();
  r = undefined;
});

const B = "\x01";
const K = "\x02";
const O = "\x03";
const R = "\x04";
const BUDDY = { sessions: "buddy", inbox: "list" } as const;
const MSG = "## Done\n\nFixed **two** bugs in `view.ts`.\n\n| File | Lines |\n|---|---|\n| a.ts | 12 |";

describe("render: spans to control bytes, gated by the negotiated version", () => {
  const view = { text: [{ style: "body", text: "a bold word", spans: [{ start: 2, end: 6, mark: "bold" }] }, { style: "body", text: "x y", spans: [{ start: 1, end: 2, mark: "rule" }] }] } as unknown as DeviceView;

  test("textFrames encodes the spans; version 7 keeps them, 3-6 strip them to the same columns, 1-2 get no SET_TEXT", () => {
    const frames = textFrames(view);
    expect(frames[0]?.lines.slice(0, 2).map((l) => l.text)).toEqual([`a ${B}bold${O} word`, `x${R}y`]);
    const v7 = framesFor(7, frames) as SetText[];
    expect(v7[0]?.lines[0]?.text).toBe(`a ${B}bold${O} word`);
    for (const proto of [3, 4, 5, 6]) {
      const plain = framesFor(proto, frames) as SetText[];
      expect(plain[0]?.lines.slice(0, 2).map((l) => l.text)).toEqual(["a bold word", "x y"]);
      for (const f of plain) for (const l of f.lines) expect(l.text).toMatch(/^[\x20-\x7e]*$/);
    }
    expect(framesFor(2, frames).some((f) => f.kind === "SET_TEXT")).toBe(false);
  });

  test("version 7: a group over MAX_BODY goes as consecutive frames in row order; each encodes", () => {
    const row = `${B}a${O}`.repeat(4) + "x".repeat(25);
    const f: SetText = { kind: "SET_TEXT", row: 3, lines: [0, 1, 2].map(() => ({ style: "body" as const, text: row })) };
    const parts = richText(7, f);
    expect(parts.map((p) => [p.row, p.lines.length])).toEqual([[3, 2], [5, 1]]);
    for (const p of parts) expect(encode(p, 0).length - 4).toBeLessThanOrEqual(MAX_BODY);
    expect(richText(6, f)).toEqual([{ ...f, lines: f.lines.map((l) => ({ ...l, text: stripSpans(l.text) })) }]);
    // A group that fits stays one frame.
    expect(richText(7, { ...f, lines: f.lines.slice(0, 2) })).toHaveLength(1);
  });
});

describe("protocol version 7 end to end", () => {
  async function shown(deviceMax: number): Promise<Rig> {
    r = await rig({ deviceMax, layouts: BUDDY });
    const x = r;
    const s = x.adapter.snapshotNow().sessions.find((v) => v.ref.sessionId === "s-claude-fw");
    if (!s) throw new Error("fixture changed");
    x.adapter.upsertSession({ ...s, details: { lastMessage: MSG, lastMessageAt: s.createdAt } });
    await x.driver.press(x.slotOf("s-claude-fw"));
    await x.driver.waitFor((d) => d.text.some((t) => stripSpans(t.text) === "Fixed two bugs in view.ts."));
    return x;
  }

  test("a version 7 device gets bold, code and the table rule as control bytes; never more than 29 columns", async () => {
    const x = await shown(SIM_VERSIONS_V7.max);
    expect(x.device.state.link.proto).toBe(7);
    const rows = x.device.state.text.map((t) => t.text);
    expect(rows).toContain(`Fixed ${B}two${O} bugs in ${K}view.ts${O}.`);
    expect(rows).toContain(`File${R}Lines`);
    for (const f of x.hostFrames) if (f.message.kind === "SET_TEXT") for (const l of f.message.lines) expect(visibleLength(l.text)).toBeLessThanOrEqual(29);
  });

  test("a version 6 device gets the same rows as plain text: no control byte ever goes out", async () => {
    const x = await shown(6);
    expect(x.device.state.link.proto).toBe(6);
    const rows = x.device.state.text.map((t) => t.text);
    expect(rows).toContain("Fixed two bugs in view.ts.");
    expect(rows).toContain("File Lines");
    for (const f of x.hostFrames) if (f.message.kind === "SET_TEXT") for (const l of f.message.lines) expect(l.text).toMatch(/^[\x20-\x7e]*$/);
  });
});
