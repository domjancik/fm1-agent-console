import { describe, expect, test } from "bun:test";
import { encode, type HostMessage } from "@fm1/device-protocol";
import { layoutScreen, type RegionId } from "../src/layout";
import { connected } from "./harness";

const flags = { selected: false, codex: false, stale: false, pinned: false };
const regionText = (r: ReturnType<typeof connected>, id: RegionId): string =>
  JSON.stringify(layoutScreen(r.device.state, r.device.nowMs).regions.find((x) => x.id === id)?.ops);

describe("host frames update rendering state", () => {
  test("each SET_* frame replaces its element and shows in the layout", () => {
    const r = connected();
    const h = r.host();
    h.send({ kind: "SET_VIEW", view: "inbox", page: 1, pages: 3, title: "INBOX" });
    h.send({ kind: "SET_SLOT", key: 7, state: "failed", flags: { ...flags, selected: true, stale: true }, label: "deploy" });
    h.send({ kind: "SET_DETAIL", provider: "codex", state: "failed", lines: ["l1", "l2", "l3", "l4"] });
    h.send({ kind: "SET_LEGEND", labels: ["A", "B", "C", "D"] });
    h.send({ kind: "SET_STATUS", link: "backend_degraded", attentionCount: 4, text: "busy" });
    h.send({ kind: "SET_VOICE", voice: "recording", level: 50, elapsedDs: 23, target: "deploy" });
    r.clock.advance(10);
    const s = r.device.state;
    expect(s.view).toEqual({ view: "inbox", page: 1, pages: 3, title: "INBOX" });
    expect(s.slots[7]).toEqual({ state: "failed", flags: { ...flags, selected: true, stale: true }, label: "deploy" });
    expect(s.detail).toEqual({ provider: "codex", state: "failed", lines: ["l1", "l2", "l3", "l4"] });
    expect(s.legend).toEqual(["A", "B", "C", "D"]);
    expect(s.status).toEqual({ link: "backend_degraded", attentionCount: 4, text: "busy" });
    expect(s.voice).toMatchObject({ voice: "recording", level: 50, elapsedDs: 23, target: "deploy", barN: 1 });
    expect(s.voice.bars[0]).toBe(50); // the v4 meter: one bar per elapsed step while recording (fm1c_model.h)

    expect(regionText(r, "status")).toContain("INBOX 2/3");
    expect(regionText(r, "status")).toContain('"LIMITED"');
    expect(regionText(r, "status")).toContain('"4"');
    expect(regionText(r, "detail")).toContain("CODEX");
    expect(regionText(r, "detail")).toContain("deploy");
    expect(regionText(r, "detail")).toContain('"l4"');
    expect(regionText(r, "legend")).toContain('"D"');

    h.send({ kind: "SET_VIEW", view: "voice", page: 0, pages: 1, title: "VOICE" });
    r.clock.advance(10);
    expect(regionText(r, "detail")).toContain("RECORDING");
    expect(regionText(r, "detail")).toContain("2.3 s");
    expect(regionText(r, "detail")).toContain("to deploy");

    h.send({ kind: "SET_VIEW", view: "confirm", page: 0, pages: 1, title: "CONFIRM" });
    r.clock.advance(10);
    expect(regionText(r, "detail")).toContain('"text":"yes"');
    expect(regionText(r, "detail")).toContain('"text":"FX"');
  });

  test("CLEAR_SLOTS empties all 27 slots", () => {
    const r = connected();
    r.host().send({ kind: "SET_SLOT", key: 0, state: "idle", flags, label: "x" });
    r.host().send({ kind: "CLEAR_SLOTS" });
    r.clock.advance(10);
    expect(r.device.state.slots.every((s) => s.state === "empty" && s.label === "")).toBe(true);
  });

  test("COMMAND_RESULT shows in the footer for 2 s", () => {
    const r = connected();
    r.host().send({ kind: "SET_DETAIL", provider: "none", state: "idle", lines: ["", "", "", "REC reply  PLAY open"] });
    r.host().send({ kind: "COMMAND_RESULT", reqSeq: 5, result: "sent", text: "Sent" });
    r.host().send({ kind: "COMMAND_RESULT", reqSeq: 6, result: "unsupported", text: "" });
    r.clock.advance(10);
    expect(r.device.state.lastResult).toMatchObject({ reqSeq: 6, result: "unsupported", text: "" });
    expect(regionText(r, "detail")).toContain('"Not supported"');
    expect(regionText(r, "detail")).not.toContain('"PLAY"');
    r.clock.advance(2000);
    expect(regionText(r, "detail")).not.toContain("Not supported");
    // proto 2: band 5 returns to the hint bar, control names white, verbs grey
    expect(regionText(r, "detail")).toContain('"text":"PLAY","font":"small","color":"#FFFFFF"');
    expect(regionText(r, "detail")).toContain('"text":"reply","font":"small","color":"#A0A0A0"');
  });
});

describe("robustness", () => {
  test("a malformed frame is ignored, counted, and not acknowledged", () => {
    const r = connected();
    const before = JSON.stringify(r.device.state);
    const acks = r.deviceFrames.filter((f) => f.message.kind === "ACK").length;
    const payload = encode({ kind: "SET_LEGEND", labels: ["X", "X", "X", "X"] }, 60);
    payload[payload.length - 1] = (payload[payload.length - 1]! + 1) & 0x7f; // break checksum
    r.injectPayload(payload);
    r.injectPayload([0x46, 61]); // truncated
    expect(JSON.stringify(r.device.state)).toBe(before);
    expect(r.device.rxErrors).toBe(2);
    expect(r.deviceFrames.filter((f) => f.message.kind === "ACK").length).toBe(acks);
    r.clock.advance(1000);
    const beat = r.deviceFrames.filter((f) => f.message.kind === "HEARTBEAT").at(-1)?.message;
    expect(beat).toMatchObject({ rxErrors: 2 });
  });

  test("a duplicate frame is re-acknowledged but not re-applied", () => {
    const r = connected();
    const applied: HostMessage[] = [];
    r.device.on("applied", (m) => applied.push(m));
    const msg: HostMessage = { kind: "COMMAND_RESULT", reqSeq: 3, result: "completed", text: "done" };
    r.inject(msg, 50);
    const first = r.device.state.lastResult;
    r.clock.advance(500);
    r.inject(msg, 50);
    expect(applied).toEqual([msg]);
    expect(r.device.state.lastResult).toBe(first);
    const acks = r.deviceFrames.filter((f) => f.message.kind === "ACK" && f.message.ackedSeq === 50);
    expect(acks.length).toBe(2);
  });

  test("an out-of-range key in SET_SLOT is rejected by the codec, not applied", () => {
    const r = connected();
    const before = JSON.stringify(r.device.state.slots);
    // Hand-built body: key 30 is outside 0..26.
    const body = [30, 2, 0, 1, 65];
    const ck = ((0x43 + 70 + body.length + body.reduce((a, b) => a + b, 0)) & 0x7f) ^ 0x2a;
    r.injectPayload([0x43, 70, body.length, ...body, ck]);
    expect(JSON.stringify(r.device.state.slots)).toBe(before);
  });
});
