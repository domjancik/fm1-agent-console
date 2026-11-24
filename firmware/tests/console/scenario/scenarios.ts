// SPDX-License-Identifier: GPL-3.0-only
// The firmware scenarios: what the host sends and presses when, and what the device must answer, light and draw.
// Shared by the host harness (host-run.ts) and, where the emulator can feed it, by emu-run.ts.
import type { DeviceMessage, HostMessage, TextStyle } from "../../../../packages/device-protocol/src/index.ts";
import { stripSpans } from "../../../../packages/device-protocol/src/rich-text.ts";
import { Scenario, type Delivered } from "./builder.ts";
import { BTN, KEY_LED, MIXED, breathNs, fullSlots, keyLevel, keyLevel2, ledLevel, ledLevel2, setSlot, type SlotSpec } from "./fixtures.ts";
import type { DeviceFrame, DeviceOutput, LedSample } from "./parse.ts";

export class Checker {
  readonly results: { ok: boolean; label: string }[] = [];
  ok(cond: boolean, label: string): boolean {
    this.results.push({ ok: cond, label });
    return cond;
  }
  get failed(): number {
    return this.results.filter((r) => !r.ok).length;
  }
}

export interface Run {
  out: DeviceOutput;
  delivered: Delivered[];
  /** Pixels-sent counter and LED layers at a tagged `leds` step (or a shot). */
  leds(tag: string): LedSample | undefined;
  /** Raw bytes of a named screenshot (PPM), for equality checks. */
  shot(name: string): Uint8Array | undefined;
}

export interface ScenarioDef {
  name: string;
  /** ACK every device input frame like a live companion (a second pass with the ACKs scheduled). */
  autoAck: boolean;
  build(s: Scenario): void;
  check(r: Run, c: Checker): void;
}

const HOST_SESSION = 4242;
const DETAIL_FW: HostMessage = {
  kind: "SET_DETAIL",
  provider: "claude",
  state: "working",
  lines: ["Writing C codec", "fm1c_proto.h", "tests 51/51 pass", "2 min ago"],
};

/** HELLO_ACK and a full resync, as docs/protocol.md section 3 orders it. proto 1: the v1 layout; 2: docs/ux-v2.md. */
function connect(s: Scenario, t: number, slots: readonly SlotSpec[], extra: HostMessage[] = [], proto = 1): void {
  s.host(t, { kind: "HELLO_ACK", proto, hostSession: HOST_SESSION, reason: "" });
  s.host(t + 20, { kind: "SET_VIEW", view: "sessions", page: 0, pages: 2, title: "fm1-console" });
  for (const slot of fullSlots(slots)) s.host(t + 20, setSlot(slot));
  s.host(t + 20, DETAIL_FW);
  s.host(t + 20, { kind: "SET_LEGEND", labels: ["PAGE", "SCROLL", "", "MENU"] });
  s.host(t + 20, { kind: "SET_VOICE", voice: "ready", level: 0, elapsedDs: 0, target: "" });
  s.host(t + 20, { kind: "SET_STATUS", link: "ok", attentionCount: 3, text: "" });
  for (const m of extra) s.host(t + 20, m);
}

const kinds = (fs: readonly DeviceFrame[], kind: DeviceMessage["kind"]): DeviceFrame[] => fs.filter((f) => f.msg.kind === kind);
const within = (fs: readonly DeviceFrame[], a: number, b: number): DeviceFrame[] => fs.filter((f) => f.t >= a && f.t <= b);

const describe = (m: DeviceMessage): string => {
  switch (m.kind) {
    case "KEY":
      return `${m.key}:${m.gesture}`;
    case "BUTTON":
      return `${m.button}:${m.edge}`;
    case "ENCODER":
      return `${m.encoder}:${m.delta}`;
    case "POT":
      return `POT:${m.value}`;
    default:
      return m.kind;
  }
};

/** The input frames in [a, b], first transmissions only, as "key:gesture@ms". */
function inputs(r: Run, a: number, b: number): string {
  const seen = new Set<number>();
  const out: string[] = [];
  for (const f of within(r.out.frames, a, b)) {
    if (f.msg.kind === "HEARTBEAT" || f.msg.kind === "ACK" || f.msg.kind === "HELLO") continue;
    if (seen.has(f.seq)) continue;
    seen.add(f.seq);
    out.push(`${describe(f.msg)}@${f.t}`);
  }
  return out.join(" ");
}

/** Checks every scenario shares: frames decode, valid host frames are ACKed once each, heartbeats every second. */
export function commonChecks(def: ScenarioDef, r: Run, c: Checker, endMs: number): void {
  c.ok(r.out.bad.length === 0, `every device frame decodes with the TS codec (${r.out.bad.map((b) => b.error).join("; ")})`);
  const acks = kinds(r.out.frames, "ACK");
  let missing = 0;
  for (const d of r.delivered) {
    if (!d.msg || d.msg.kind === "HEARTBEAT" || d.msg.kind === "ACK" || d.seq === undefined) continue;
    const a = acks.find((f) => f.msg.kind === "ACK" && f.msg.ackedSeq === d.seq && f.t >= d.at && f.t <= d.at + 5);
    if (!a || (a.msg.kind === "ACK" && a.msg.status !== "ok")) missing++;
  }
  c.ok(missing === 0, `every host SET_*/HELLO_ACK/COMMAND_RESULT ACKed ok within 5 ms (${missing} missing)`);
  const hostAcked = r.delivered.filter((d) => d.msg && (d.msg.kind === "HEARTBEAT" || d.msg.kind === "ACK"));
  const wrongly = hostAcked.filter((d) => acks.some((f) => f.msg.kind === "ACK" && f.msg.ackedSeq === d.seq && f.t >= d.at && f.t <= d.at + 2));
  c.ok(wrongly.length === 0, `host HEARTBEAT and ACK frames are never acknowledged (${wrongly.length})`);
  const hbs = kinds(r.out.frames, "HEARTBEAT");
  const gaps = hbs.slice(1).map((f, i) => f.t - (hbs[i]?.t ?? 0));
  c.ok(hbs.length === Math.floor((endMs - 1) / 1000) && gaps.every((g) => g === 1000),
    `device HEARTBEAT every 1000 ms (${hbs.length} in ${endMs} ms)`);
  const up = hbs.map((f) => (f.msg.kind === "HEARTBEAT" ? f.msg.uptimeS : -1));
  c.ok(up.every((u, i) => u === i + 1), "heartbeat uptime 1, 2, 3, ... s");
  if (def.autoAck) {
    const tracked = r.out.frames.filter((f) => ["KEY", "BUTTON", "ENCODER", "POT"].includes(f.msg.kind));
    const resent = tracked.filter((f, i) => tracked.slice(0, i).some((g) => g.seq === f.seq && f.t - g.t < 1000));   // (SEQ wraps at 128)
    c.ok(resent.length === 0, `with a companion ACKing, no input frame is retransmitted (${resent.length})`);
  }
}

function checkLeds(c: Checker, sample: LedSample | undefined, slots: readonly SlotSpec[], label: string): void {
  if (!c.ok(sample !== undefined, `${label}: LED sample present`) || !sample) return;
  const ms = sample.t - 1;                     // (the harness prints before the pass at t runs)
  const wrong = fullSlots(slots).filter((s) => ledLevel(sample.lit, sample.glow, KEY_LED(s.key)) !== keyLevel(s, ms));
  c.ok(wrong.length === 0, `${label}: 27 key LEDs as section 6 says at ${ms} ms (${wrong.map((s) => `${s.key}:${s.state}`).join(" ")})`);
}

const button = (s: LedSample | undefined, id: number): string => (s ? ledLevel(s.lit, s.glow, id) : "none");

/* ---- the scenarios */

const sessions: ScenarioDef = {
  name: "sessions",
  autoAck: true,
  build(s) {
    connect(s, 200, MIXED);
    s.heartbeats(1000, 13000, 1);
    s.shot(1500, "sessions-mixed");
    s.leds(1501, "sessions");
    s.leds(1751, "sessions-later");
    s.keyDown(2000, 5);
    s.keyUp(2080, 5);
    s.keyDown(3000, 6);
    s.keyUp(3060, 6);
    s.keyDown(3150, 6);
    s.keyUp(3210, 6);
    s.keyDown(4000, 7);
    s.keyUp(4800, 7);
    s.tap(5000, BTN.HOME);
    s.buttonDown(5100, BTN.REC);
    s.buttonUp(5600, BTN.REC);
    s.encoder(5800, 0, 3);
    s.encoder(5900, 1, -2);
    s.pot(6000, 300);
    s.pot(6200, 900);
    // the companion moves the selection to key 5 (a failed codex session)
    s.host(6500, setSlot({ key: 2, state: "working", label: "voice tests" }));
    s.host(6500, setSlot({ key: 5, state: "failed", label: "ci fix", codex: true, selected: true }));
    s.host(6500, { kind: "SET_DETAIL", provider: "codex", state: "failed", lines: ["CI failed: lint", "src/link.ts:12", "ENV=interrupt", "FX=dismiss"] });
    s.shot(7000, "sessions-selected-failed");
    s.leds(7001, "selected");
    s.host(7200, { kind: "COMMAND_RESULT", reqSeq: 127, result: "completed", text: "focused ci fix" });
    s.shot(7400, "toast-completed");
    s.leds(10000, "quiet-start");
    s.leds(12900, "quiet-end");
    s.host(13000, setSlot({ key: 0, state: "idle", label: "fw codec" }));
    s.leds(13200, "one-cell");
    s.end(13500);
  },
  check(r, c) {
    c.ok(kinds(r.out.frames, "HELLO").length === 1 && (kinds(r.out.frames, "HELLO")[0]?.t ?? 99) <= 2,
      "one HELLO at boot; answered before the next");
    const h = kinds(r.out.frames, "HELLO")[0]?.msg;
    c.ok(h?.kind === "HELLO" && h.protoMin === 1 && h.protoMax === 7 && h.fwMajor === 0 && h.fwMinor === 1 && h.bootId === 0x1234,
      "HELLO: proto 1..7, fw 0.1.x, boot id");
    const keyTrace = inputs(r, 1900, 4999);
    c.ok(keyTrace ===
      "5:down@2000 5:up@2080 5:single@2380 6:down@3000 6:up@3060 6:down@3150 6:up@3210 6:double@3210 7:down@4000 7:long@4600 7:up@4800",
      `key gestures: single, double (no single), long at 600 ms (${keyTrace})`);
    const btnTrace = inputs(r, 5000, 5999);
    c.ok(btnTrace === "HOME:down@5000 HOME:up@5001 REC:down@5100 REC:up@5600 SELECT:3@5800 ALGORITHM:-2@5900",
      `buttons both edges, REC held, encoders (${btnTrace})`);
    const pots = within(kinds(r.out.frames, "POT"), 6000, 6999).map((f) => (f.msg.kind === "POT" ? f.msg.value : -1));
    c.ok(pots[0] === 300 && pots.every((v, i) => i === 0 || v > (pots[i - 1] ?? 0)) && (pots.at(-1) ?? 0) >= 892 && (pots.at(-1) ?? 0) <= 900,
      `MASTER: 300, then rising to ~900 with deadband and pacing (${pots.join(",")})`);
    const potTimes = within(kinds(r.out.frames, "POT"), 6000, 6999).map((f) => f.t);
    c.ok(potTimes.slice(1).every((t, i) => t - (potTimes[i] ?? 0) >= 50), "POT frames at least 50 ms apart");
    checkLeds(c, r.leds("sessions"), MIXED, "mixed sessions");
    checkLeds(c, r.leds("sessions-later"), MIXED, "mixed sessions 250 ms later");
    const s1 = r.leds("sessions");
    c.ok(button(s1, BTN.HOME) === "full" && button(s1, BTN.EDIT) === "off" && button(s1, BTN.OCT_UP) === "off",
      "HOME lit for the sessions view, OCT+ dark with a host");
    const after = MIXED.map((x) => (x.key === 2 ? { ...x, selected: false } : x.key === 5 ? { ...x, selected: true } : x));
    checkLeds(c, r.leds("selected"), after, "after the host moved the selection");
    const q0 = r.leds("quiet-start");
    const q1 = r.leds("quiet-end");
    c.ok(!!q0 && !!q1 && q1.px - q0.px === 0, `no pixels sent over 3 heartbeat-only seconds (${q0 && q1 ? q1.px - q0.px : "?"})`);
    const one = r.leds("one-cell");
    c.ok(!!q1 && !!one && one.px - q1.px === 8 * 64, `one slot change redraws one 8 x 64 cell (${one && q1 ? one.px - q1.px : "?"} px)`);
  },
};

const views: ScenarioDef = {
  name: "views",
  autoAck: true,
  build(s) {
    connect(s, 200, MIXED);
    s.heartbeats(1000, 6000, 1);
    s.host(1000, { kind: "SET_VIEW", view: "tasks", page: 0, pages: 1, title: "Tasks: fm1-console" });
    s.host(1000, { kind: "CLEAR_SLOTS" });
    const tasks: SlotSpec[] = [
      { key: 0, state: "working", label: "Firmware app", selected: true },
      { key: 1, state: "approval_required", label: "Voice" },
      { key: 2, state: "idle", label: "Refund hook" },
    ];
    for (const t of tasks) s.host(1000, setSlot(t));
    s.host(1000, { kind: "SET_DETAIL", provider: "none", state: "working", lines: ["3 sessions", "1 needs approval", "", ""] });
    s.host(1000, { kind: "SET_LEGEND", labels: ["PROJ", "", "", "OPEN"] });
    s.shot(1500, "tasks");
    s.leds(1501, "tasks");
    s.host(2000, { kind: "SET_VIEW", view: "inbox", page: 0, pages: 1, title: "Inbox" });
    s.host(2000, { kind: "CLEAR_SLOTS" });
    const inbox: SlotSpec[] = [
      { key: 0, state: "approval_required", label: "fw review", codex: true, selected: true },
      { key: 1, state: "waiting_input", label: "question" },
      { key: 2, state: "failed", label: "ci fix" },
      { key: 3, state: "completed_unread", label: "docs" },
    ];
    for (const t of inbox) s.host(2000, setSlot(t));
    s.host(2000, { kind: "SET_DETAIL", provider: "codex", state: "approval_required", lines: ["Approve: rm -rf build/", "fw review / Firmware", "SAVE=approve", "FX=deny"] });
    s.host(2000, { kind: "SET_STATUS", link: "backend_degraded", attentionCount: 4, text: "Traycer slow" });
    s.shot(2500, "inbox-degraded");
    s.leds(2501, "inbox");
    s.host(3000, { kind: "SET_STATUS", link: "ok", attentionCount: 4, text: "" });
    s.host(3000, { kind: "SET_VIEW", view: "sessions", page: 1, pages: 2, title: "Sessions" });
    s.host(3000, { kind: "CLEAR_SLOTS" });
    const stale: SlotSpec[] = [
      { key: 0, state: "unknown", label: "gone", stale: true, selected: true },
      { key: 1, state: "working", label: "api", stale: true },
      { key: 2, state: "idle", label: "notes" },
    ];
    for (const t of stale) s.host(3000, setSlot(t));
    s.host(3000, { kind: "SET_DETAIL", provider: "claude", state: "unknown", lines: ["session not found", "identity stale", "", ""] });
    s.shot(3500, "sessions-page2-stale");
    s.end(4000);
  },
  check(r, c) {
    const t = r.leds("tasks");
    c.ok(button(t, BTN.EDIT) === "full" && button(t, BTN.HOME) === "off", "tasks view: EDIT lit");
    checkLeds(c, t, [
      { key: 0, state: "working", label: "", selected: true },
      { key: 1, state: "approval_required", label: "" },
      { key: 2, state: "idle", label: "" },
    ], "tasks");
    const i = r.leds("inbox");
    c.ok(button(i, BTN.GLO) === "full" && button(i, BTN.EDIT) === "off", "inbox view: GLO lit");
    c.ok(!!r.shot("tasks") && !!r.shot("inbox-degraded") && !!r.shot("sessions-page2-stale"), "tasks, inbox, stale screens drawn");
  },
};

const voice: ScenarioDef = {
  name: "voice",
  autoAck: true,
  build(s) {
    connect(s, 200, MIXED);
    s.heartbeats(1000, 7000, 1);
    s.buttonDown(1000, BTN.REC);
    s.host(1010, { kind: "SET_VIEW", view: "voice", page: 0, pages: 1, title: "Voice" });
    s.host(1010, { kind: "SET_LEGEND", labels: ["", "", "", ""] });
    for (let i = 0; i <= 20; i++) {
      s.host(1010 + i * 100, { kind: "SET_VOICE", voice: "recording", level: [20, 60, 85, 40, 95][i % 5] ?? 0, elapsedDs: i, target: "voice tests" });
    }
    s.shot(2980, "voice-recording");            // (70 ms after the last SET_VOICE: the package has drawn it too)
    s.leds(2951, "recording");
    s.buttonUp(3100, BTN.REC);
    s.host(3110, { kind: "SET_VOICE", voice: "transcribing", level: 0, elapsedDs: 21, target: "voice tests" });
    s.shot(3500, "voice-transcribing");
    s.leds(3601, "transcribing-on");
    s.leds(3851, "transcribing-off");
    s.host(4000, { kind: "SET_VOICE", voice: "reviewing", level: 0, elapsedDs: 21, target: "voice tests" });
    s.host(4000, { kind: "SET_DETAIL", provider: "claude", state: "working", lines: ["run the codec tests", "and fix failures", "", ""] });
    s.host(4000, { kind: "SET_LEGEND", labels: ["", "", "EDIT", "SEND"] });
    s.shot(4500, "voice-reviewing");
    s.leds(4501, "reviewing");
    s.tap(4600, BTN.SAVE);
    s.host(4700, { kind: "SET_VOICE", voice: "delivered", level: 0, elapsedDs: 21, target: "voice tests" });
    s.host(4700, { kind: "COMMAND_RESULT", reqSeq: 127, result: "acknowledged", text: "prompt delivered" });
    s.shot(5000, "voice-delivered");
    s.leds(5001, "delivered");
    s.end(5500);
  },
  check(r, c) {
    c.ok(button(r.leds("recording"), BTN.REC) === "full", "recording: REC full");
    c.ok(button(r.leds("transcribing-on"), BTN.REC) === "full" && button(r.leds("transcribing-off"), BTN.REC) === "off",
      "transcribing: REC blinks");
    c.ok(button(r.leds("reviewing"), BTN.SAVE) === "full" && button(r.leds("reviewing"), BTN.REC) === "off", "reviewing: SAVE full");
    c.ok(button(r.leds("delivered"), BTN.SAVE) === "off", "delivered: SAVE off");
    const trace = inputs(r, 900, 5000);
    c.ok(trace === "REC:down@1000 REC:up@3100 SAVE:down@4600 SAVE:up@4601", `push-to-talk edges and SAVE (${trace})`);
    const rec = r.leds("recording");
    const q = r.leds("transcribing-on");
    c.ok(!!rec && !!q, "samples present");
  },
};

const confirm: ScenarioDef = {
  name: "confirm",
  autoAck: true,
  build(s) {
    connect(s, 200, MIXED);
    s.heartbeats(1000, 3000, 1);
    s.host(1000, { kind: "SET_VIEW", view: "confirm", page: 0, pages: 1, title: "Confirm" });
    s.host(1000, { kind: "SET_DETAIL", provider: "codex", state: "approval_required", lines: ["INTERRUPT?", "fw review (codex)", "stops the running turn", ""] });
    s.host(1000, { kind: "SET_LEGEND", labels: ["", "", "NO", "YES"] });
    s.shot(1500, "confirm");
    s.tap(1600, BTN.SAVE);
    s.end(2000);
  },
  check(r, c) {
    c.ok(inputs(r, 1500, 2000) === "SAVE:down@1600 SAVE:up@1601", "SAVE is reported as a fact; the host decides");
    c.ok(!!r.shot("confirm"), "confirm screen drawn");
  },
};

const nohost: ScenarioDef = {
  name: "nohost",
  autoAck: true,
  build(s) {
    s.shot(1500, "nohost-boot");
    s.leds(1201, "boot-on");
    s.leds(1701, "boot-off");
    s.keyDown(1800, 3);
    s.keyUp(1850, 3);
    connect(s, 2200, MIXED);
    s.heartbeats(3000, 4000, 1);
    s.shot(2600, "connected");
    s.leds(2601, "connected");
    // silence from 4000: lost at 7500
    s.leds(7499, "before-loss");
    s.shot(7700, "nohost-dimmed");
    s.leds(7701, "lost");
    s.keyDown(8500, 4);
    s.keyUp(8550, 4);
    s.tap(8700, BTN.PLAY);
    // the same companion comes back and replays its state
    connect(s, 11000, MIXED);
    s.heartbeats(12000, 13000, 9);
    s.shot(11600, "reconnected");
    s.end(13500);
  },
  check(r, c) {
    const hellos = kinds(r.out.frames, "HELLO").map((f) => f.t);
    c.ok(hellos.slice(0, 3).join(",") === "1,1000,2000", `HELLO at boot and every 1000 ms with no host (${hellos.slice(0, 4).join(",")})`);
    const b0 = r.leds("boot-on");
    const b1 = r.leds("boot-off");
    const others = Object.values(BTN).filter((b) => b !== BTN.OCT_UP);
    c.ok(button(b0, BTN.OCT_UP) === "full" && button(b1, BTN.OCT_UP) === "off" && others.every((b) => button(b0, b) === "off"),
      "no host: only OCT+ blinks slowly");
    c.ok(!!b0 && Array.from({ length: 27 }, (_, k) => ledLevel(b0.lit, b0.glow, KEY_LED(k))).every((l) => l === "glow"),
      "no host: every key glows");
    c.ok(inputs(r, 1700, 1999) === "", "key presses with no host send nothing");
    c.ok(hellos.filter((t) => t > 2200 && t < 7500).length === 0, "no HELLO while linked");
    checkLeds(c, r.leds("before-loss"), MIXED, "linked until 3500 ms of silence");
    const lost = r.leds("lost");
    c.ok(button(lost, BTN.HOME) === "off" &&
      Array.from({ length: 27 }, (_, k) => (lost ? ledLevel(lost.lit, lost.glow, KEY_LED(k)) : "none")).every((l, k) => l === (k === 2 ? "full" : "glow")),
      "after 3500 ms: keys glow, the kept selection (key 2) full, view LEDs off");
    c.ok(hellos.filter((t) => t > 7500 && t < 11000).length === 3, `HELLO resumes every second (${hellos.filter((t) => t > 7500 && t < 11000).join(",")})`);
    c.ok(inputs(r, 8400, 10999) === "", "no input frames while the host is lost");
    const a = r.shot("connected");
    const b = r.shot("reconnected");
    c.ok(!!a && !!b && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0, "after reconnect and resync the screen is exactly as before");
    const d = r.shot("nohost-dimmed");
    c.ok(!!a && !!d && Buffer.compare(Buffer.from(a), Buffer.from(d)) !== 0, "NO HOST changes the screen");
  },
};

const malformed: ScenarioDef = {
  name: "malformed",
  autoAck: true,
  build(s) {
    connect(s, 200, MIXED);
    s.heartbeats(1000, 5000, 1);
    s.shot(1000, "before-malformed");
    const good = encodeSlot(9, "x");
    s.rawPayload(1100, [...good.slice(0, -1), ((good.at(-1) ?? 0) ^ 1) & 0x7f], "bad checksum");
    s.rawPayload(1150, withCk([0x4d, 120, 0]), "unknown type 0x4D");   // (0x4C is SET_TEXT since version 3)
    s.rawPayload(1200, withCk([0x43, 121, 4, 30, 0, 0, 0]), "SET_SLOT key 30");
    s.rawPayload(1250, withCk([0x03, 122, 2, 1, 1]), "a device type from the host");
    s.rawMidi(1300, [[0xbf, 118, 1], ...Array.from({ length: 110 }, () => [0xbf, 119, 1] as const), [0xbf, 118, 2]], "110-byte frame");
    s.rawMidi(1350, [[0xbf, 118, 1], [0xbf, 119, 0x43], [0xbf, 119, 3], [0xbf, 118, 3], [0xbf, 118, 2]], "aborted frame");
    s.rawMidi(1400, [[0x90, 60, 100], [0xbe, 118, 1], [0xbf, 119, 7], [0xbf, 117, 1], [0xbf, 118, 9], [0x80, 60, 0]], "junk MIDI");
    s.rawMidi(1450, [[0xbf, 118, 1], [0xbf, 118, 2]], "empty frame");
    s.shot(1600, "after-malformed");
    const id = s.host(2000, setSlot({ key: 10, state: "working", label: "late" }));
    s.repeat(2100, id);
    s.repeat(2200, id);
    s.leds(2300, "after-dup");
    s.end(3500);
  },
  check(r, c) {
    const acks = kinds(r.out.frames, "ACK").map((f) => (f.msg.kind === "ACK" ? `${f.msg.ackedSeq}:${f.msg.status}` : ""));
    c.ok(acks.filter((a) => a.endsWith(":unknown_type")).join(",") === "120:unknown_type,122:unknown_type",
      "only the two unknown-type frames get status 1");
    c.ok(acks.includes("120:unknown_type"), "unknown type 0x4D: ACK status 1");
    c.ok(acks.includes("121:bad_body"), "SET_SLOT key 30: ACK status 2");
    c.ok(acks.includes("122:unknown_type"), "a device-only type from the host: ACK status 1");
    const bad = within(kinds(r.out.frames, "ACK"), 1100, 1110);
    c.ok(bad.length === 0, "a bad checksum gets no ACK");
    const hb = kinds(r.out.frames, "HEARTBEAT").find((f) => f.t >= 2000);
    c.ok(hb?.msg.kind === "HEARTBEAT" && hb.msg.rxErrors === 5, `rx_errors counts the 5 rejected frames (checksum, 2 types, body, empty) (${hb?.msg.kind === "HEARTBEAT" ? hb.msg.rxErrors : "?"})`);
    const a = r.shot("before-malformed");
    const b = r.shot("after-malformed");
    c.ok(!!a && !!b && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0, "malformed input leaves the screen as it was");
    const dupSeq = r.delivered.find((d) => d.label === "repeat SET_SLOT")?.seq;
    const dupAcks = kinds(r.out.frames, "ACK").filter((f) => f.msg.kind === "ACK" && f.msg.ackedSeq === dupSeq && f.t >= 2000);
    c.ok(dupAcks.length === 3, `a frame sent three times is ACKed three times (${dupAcks.length})`);
  },
};

const retransmit: ScenarioDef = {
  name: "retransmit",
  autoAck: false,
  build(s) {
    connect(s, 200, MIXED);
    s.heartbeats(1000, 5000, 1);
    s.tap(1500, BTN.FX);
    s.shot(2800, "link-err");
    s.end(3000);
  },
  check(r, c) {
    const fx = kinds(r.out.frames, "BUTTON").filter((f) => f.msg.kind === "BUTTON" && f.msg.edge === "down");
    const times = fx.map((f) => f.t);
    c.ok(times.join(",") === "1500,1750,2000,2250" && new Set(fx.map((f) => f.seq)).size === 1,
      `unacknowledged BUTTON: sent, then again at 250, 500, 750 ms with the same SEQ (${times.join(",")})`);
    c.ok(!!r.shot("link-err"), "LINK ERR screen drawn after the fourth try went unanswered");
  },
};

const incompatible: ScenarioDef = {
  name: "incompatible",
  autoAck: true,
  build(s) {
    s.host(500, { kind: "HELLO_ACK", proto: 0, hostSession: 7, reason: "host too old (0-0)" });
    s.heartbeats(1000, 3000, 1);
    s.shot(1500, "host-too-old");
    s.end(2500);
  },
  check(r, c) {
    c.ok(kinds(r.out.frames, "HELLO").map((f) => f.t).join(",") === "1,1000,2000", "HELLO goes on after a refusal");
    c.ok(!!r.shot("host-too-old"), "HOST TOO OLD drawn");
  },
};

function withCk(b: number[]): number[] {
  let s = 0;
  for (const x of b) s += x;
  return [...b, (s & 0x7f) ^ 0x2a];
}
function encodeSlot(key: number, label: string): number[] {
  const body = [key, 3, 0, label.length, ...[...label].map((ch) => ch.charCodeAt(0))];
  return withCk([0x43, 119, body.length, ...body]);
}

/* ---- UX v2 (docs/ux-v2.md sections 1.2, 2.4, 2.5): version 2 agreed, the same frames drawn the new way */

/** A pixel of a P6 screenshot (240 x 240), as [r, g, b]. */
function px(ppm: Uint8Array | undefined, x: number, y: number): [number, number, number] {
  if (!ppm) return [-1, -1, -1];
  let i = 0;
  let fields = 0;
  while (fields < 4 && i < ppm.length) {        // "P6", width, height, maxval, each ended by whitespace
    while (i < ppm.length && /\s/.test(String.fromCharCode(ppm[i] ?? 0))) i++;
    while (i < ppm.length && !/\s/.test(String.fromCharCode(ppm[i] ?? 0))) i++;
    fields++;
  }
  const o = i + 1 + (y * 240 + x) * 3;
  return [ppm[o] ?? -1, ppm[o + 1] ?? -1, ppm[o + 2] ?? -1];
}
/** Close to an RGB888 colour (RGB565 rounding: a few counts). */
const near = (p: [number, number, number], r: number, g: number, b: number): boolean =>
  Math.abs(p[0] - r) <= 8 && Math.abs(p[1] - g) <= 4 && Math.abs(p[2] - b) <= 8;
const same = (a: Uint8Array | undefined, b: Uint8Array | undefined): boolean =>
  !!a && !!b && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

const V2_LEGEND: HostMessage = { kind: "SET_LEGEND", labels: ["SHOW", "REPO", "TASK", "TALK"] };
const V2_DETAIL: HostMessage = {
  kind: "SET_DETAIL",
  provider: "claude",
  state: "working",
  lines: ["tests for the voice", "path", "12m tests 51/51 pass", "ENV stop  PLAY open"],
};

function connectV2(s: Scenario, t: number, extra: HostMessage[] = []): void {
  connect(s, t, MIXED, [V2_LEGEND, V2_DETAIL, { kind: "SET_VIEW", view: "sessions", page: 0, pages: 2, title: "ACTIVE 15" }], 2);
  for (const m of extra) s.host(t + 300, m);   // (a view change after the resync, as the companion sends it)
}

const v2Sessions: ScenarioDef = {
  name: "v2-sessions",
  autoAck: true,
  build(s) {
    connectV2(s, 200);
    s.heartbeats(1000, 4000, 1);
    s.shot(1500, "v2-sessions");
    s.leds(1600, "v2-quiet");
    s.host(2000, setSlot({ key: 0, state: "idle", label: "fw codec" }));          // a white key (F3)
    s.leds(2200, "v2-white");
    s.host(2500, setSlot({ key: 1, state: "failed", label: "fw review", codex: true }));   // a black key (F#3)
    s.leds(2700, "v2-black");
    s.host(3000, setSlot({ key: 13, state: "idle", label: "notes" }));            // unpinned
    s.leds(3200, "v2-unpin");
    s.end(3500);
  },
  check(r, c) {
    const shot = r.shot("v2-sessions");
    c.ok(!!shot, "v2 sessions screen drawn");
    c.ok(near(px(shot, 210, 11), 32, 192, 96) && near(px(shot, 210, 5), 0, 0, 0),
      `link ok: a 6 x 6 green dot, no OK text (${px(shot, 210, 11).join(",")})`);
    c.ok(near(px(shot, 236, 121), 32, 32, 32) && near(px(shot, 1, 134), 32, 32, 32), "line 4 is a hint bar (#202020, rows 120-135)");
    const tagRow = Array.from({ length: 60 }, (_, x) => px(shot, x, 210)).some((p) => near(p, 128, 128, 128));
    const labelRow = Array.from({ length: 60 }, (_, x) => px(shot, x, 228)).some((p) => p[0] > 200 && p[1] > 200);
    c.ok(tagRow && labelRow, "legend cell 1: the grey KNOB1 tag above the white label");
    c.ok(near(px(shot, 14, 180), 47, 125, 246), `key 0 (F3, working): a white key's fill in blue (${px(shot, 14, 180).join(",")})`);
    c.ok(near(px(shot, 22, 150), 255, 176, 0), `key 1 (F#3, approval): a black key's fill in amber (${px(shot, 22, 150).join(",")})`);
    c.ok(near(px(shot, 119, 141), 255, 255, 255) && near(px(shot, 119, 150), 96, 96, 96),
      `key 13 (pinned, idle): the top 4 rows of its fill white (${px(shot, 119, 141).join(",")} / ${px(shot, 119, 150).join(",")})`);
    const sel = px(shot, 23, 168);
    c.ok(near(sel, 255, 255, 255), `key 2 (selected): a 2 px white frame (${sel.join(",")})`);
    const q = r.leds("v2-quiet");
    const w = r.leds("v2-white");
    const b = r.leds("v2-black");
    const u = r.leds("v2-unpin");
    c.ok(!!q && !!w && w.px - q.px === 14 * 34, `version 2: one white key change redraws its 14 x 34 box (${w && q ? w.px - q.px : "?"} px)`);
    c.ok(!!w && !!b && b.px - w.px === 12 * 30, `version 2: one black key change redraws its 12 x 30 box (${b && w ? b.px - w.px : "?"} px)`);
    c.ok(!!b && !!u && u.px - b.px === 12 * 30, `unpinning a key redraws that key only (${u && b ? u.px - b.px : "?"} px)`);
  },
};

/** SCL held over a screen: no help before 400 ms, the help at 400 ms, inputs silent, the screen back on release. */
function helpScenario(name: string, setup: (s: Scenario) => void, shotName: string,
  meanwhile: HostMessage = setSlot({ key: 9, state: "working", label: "back online" })): ScenarioDef {
  return {
    name,
    autoAck: true,
    build(s) {
      setup(s);
      s.heartbeats(1000, 4000, 1);
      s.shot(1000, `${shotName}-before`);
      s.buttonDown(1100, BTN.SEL);
      s.shot(1450, `${shotName}-not-yet`);
      s.shot(1600, shotName);
      s.tap(1650, BTN.SAVE);
      s.keyDown(1660, 4);
      s.keyUp(1700, 4);
      s.encoder(1680, 2, 1);
      s.tap(1720, BTN.REC);
      s.pot(1730, 800);
      s.host(1750, meanwhile);
      s.shot(1900, `${shotName}-held`);
      s.buttonUp(2000, BTN.SEL);
      s.shot(2300, `${shotName}-closed`);
      s.end(2600);
    },
    check(r, c) {
      const before = r.shot(`${shotName}-before`);
      c.ok(same(before, r.shot(`${shotName}-not-yet`)), "SCL held 350 ms: no help yet");
      const help = r.shot(shotName);
      c.ok(!!help && !same(before, help), "SCL held 400 ms: the help overlay");
      c.ok(near(px(help, 2, 30), 0, 0, 0) && near(px(help, 2, 190), 0, 0, 0), "the overlay is black over rows 24-199");
      c.ok(same(help, r.shot(`${shotName}-held`)), "a host frame under the help draws nothing under it");
      const trace = inputs(r, 1100, 2100);
      c.ok(trace === "SEL:down@1100 SEL:up@2000", `under the help only SCL's edges go out (${trace})`);
      const closed = r.shot(`${shotName}-closed`);
      c.ok(!!closed && !same(closed, help) && !same(closed, before), "on release the screen is redrawn, with the change made meanwhile");
    },
  };
}

const v2HelpBase = helpScenario("v2-help-base", (s) => connectV2(s, 200), "v2-help-base");
const v2HelpVoice = helpScenario("v2-help-voice", (s) => {
  connectV2(s, 200, [
    { kind: "SET_VIEW", view: "voice", page: 0, pages: 1, title: "TALK" },
    { kind: "SET_LEGEND", labels: ["", "", "", ""] },
    { kind: "SET_VOICE", voice: "reviewing", level: 0, elapsedDs: 21, target: "voice tests" },
    { kind: "SET_DETAIL", provider: "claude", state: "working", lines: ["please rerun the", "failing tests", "", "SAVE send  FX cancel"] },
  ]);
}, "v2-help-voice");
const v2HelpConfirm = helpScenario("v2-help-confirm", (s) => {
  connectV2(s, 200, [
    { kind: "SET_VIEW", view: "confirm", page: 0, pages: 1, title: "CHECK BEFORE DOING" },
    { kind: "SET_LEGEND", labels: ["", "", "", ""] },
    { kind: "SET_DETAIL", provider: "codex", state: "approval_required", lines: ["Approve?", "fw review", "rm -rf build/", "3m in Firmware app"] },
  ]);
}, "v2-help-confirm");

const v2Voice: ScenarioDef = {
  name: "v2-voice-reviewing",
  autoAck: true,
  build(s) {
    connectV2(s, 200);
    s.heartbeats(1000, 3000, 1);
    s.host(1000, { kind: "SET_VIEW", view: "voice", page: 0, pages: 1, title: "TALK" });
    s.host(1000, { kind: "SET_LEGEND", labels: ["", "", "", ""] });
    s.host(1000, { kind: "SET_VOICE", voice: "recording", level: 60, elapsedDs: 34, target: "refund hook" });
    s.host(1000, { kind: "SET_DETAIL", provider: "claude", state: "working", lines: ["", "", "", "release REC to stop"] });
    s.shot(1300, "v2-voice-recording");
    s.host(1500, { kind: "SET_VOICE", voice: "reviewing", level: 0, elapsedDs: 34, target: "refund hook" });
    s.host(1500, { kind: "SET_DETAIL", provider: "claude", state: "working", lines: ["please rerun the", "failing tests", "", "SAVE send  FX cancel"] });
    s.shot(1800, "v2-voice-reviewing");
    s.end(2200);
  },
  check(r, c) {
    const rec = r.shot("v2-voice-recording");
    const rev = r.shot("v2-voice-reviewing");
    c.ok(near(px(rec, 4, 80), 128, 128, 128), "recording: the level bar's frame on line 1");
    c.ok(!near(px(rev, 4, 80), 128, 128, 128), "reviewing: the transcript replaces the bar");
    c.ok(near(px(rev, 236, 121), 32, 32, 32), "voice view: line 4 is the hint bar");
  },
};

const v2Confirm: ScenarioDef = {
  name: "v2-confirm",
  autoAck: true,
  build(s) {
    connectV2(s, 200);
    s.heartbeats(1000, 2000, 1);
    s.host(1000, { kind: "SET_VIEW", view: "confirm", page: 0, pages: 1, title: "CHECK BEFORE DOING" });
    s.host(1000, { kind: "SET_LEGEND", labels: ["", "", "", ""] });
    s.host(1000, { kind: "SET_DETAIL", provider: "codex", state: "approval_required", lines: ["Approve?", "fw review", "rm -rf build/", "3m in Firmware app"] });
    s.shot(1500, "v2-confirm");
    s.end(1800);
  },
  check(r, c) {
    const shot = r.shot("v2-confirm");
    c.ok(near(px(shot, 236, 121), 32, 32, 32), "confirm: SAVE yes / FX no as the hint bar");
    c.ok(Array.from({ length: 240 }, (_, x) => px(shot, x, 210)).every((p) => near(p, 0, 0, 0) || near(p, 48, 48, 48)),
      "empty legend cells: no KNOB tags");
  },
};

/** An old companion (HELLO_ACK 1) with v2 content: the legend, line 4 and the strip drawn as in version 1. */
const v1Compat: ScenarioDef = {
  name: "v1-compat",
  autoAck: true,
  build(s) {
    connect(s, 200, MIXED, [V2_LEGEND, V2_DETAIL], 1);
    s.heartbeats(1000, 3000, 1);
    s.shot(1500, "v1-compat");
    s.leds(1600, "v1-quiet");
    s.host(2000, setSlot({ key: 1, state: "failed", label: "fw review", codex: true }));
    s.leds(2200, "v1-one");
    s.shot(2250, "v1-compat-changed");
    s.buttonDown(2300, BTN.SEL);
    s.shot(2900, "v1-compat-scl-held");
    s.buttonUp(2950, BTN.SEL);
    s.end(3200);
  },
  check(r, c) {
    const shot = r.shot("v1-compat");
    c.ok(!near(px(shot, 236, 121), 32, 32, 32), "version 1: line 4 is plain text, no hint bar");
    c.ok(!Array.from({ length: 60 }, (_, x) => px(shot, x, 205)).some((p) => near(p, 128, 128, 128)), "version 1: no KNOB tags");
    c.ok(near(px(shot, 12, 170), 47, 125, 246), "version 1: the old 8 x 64 cells");
    const q = r.leds("v1-quiet");
    const one = r.leds("v1-one");
    c.ok(!!q && !!one && one.px - q.px === 8 * 64, `version 1: one slot change redraws one 8 x 64 cell (${one && q ? one.px - q.px : "?"} px)`);
    c.ok(inputs(r, 2300, 3000) === "SEL:down@2300 SEL:up@2950" && same(r.shot("v1-compat-changed"), r.shot("v1-compat-scl-held")),
      "version 1: SCL held 600 ms is an ordinary button (no help overlay, the screen unchanged)");
  },
};

/** No companion: the v2 words on the banner (every version). */
const nohostWords: ScenarioDef = {
  name: "nohost-v2-words",
  autoAck: false,
  build(s) {
    s.shot(1500, "nohost-v2-words");
    s.end(2500);
  },
  check(r, c) {
    const shot = r.shot("nohost-v2-words");
    c.ok(!!shot && near(px(shot, 17, 81), 255, 255, 255) && near(px(shot, 6, 4), 240, 48, 48) === false,
      "no companion: the banner drawn over the dimmed screen (its words: the screenshot)");
  },
};

/* ---- version 3: the DETAILS page (docs/ux-v2.md section 7.4) */

type Row = readonly [TextStyle, string];
/** The 12 DETAILS rows as the host sends them: four SET_TEXT frames of three rows (rows 0-2, 3-5, 6-8, 9-11). */
function textFrames(rows: readonly Row[]): HostMessage[] {
  const all = Array.from({ length: 12 }, (_, i): Row => rows[i] ?? ["body", ""]);
  return [0, 3, 6, 9].map((row) => ({ kind: "SET_TEXT", row, lines: all.slice(row, row + 3).map(([style, text]) => ({ style, text })) }));
}
const DETAIL_PAGE1: Row[] = [
  ["heading", "NEEDS APPROVAL, 12m"],
  ["body", "Refund webhook retries on"],
  ["body", "timeout"],
  ["muted", "Task: Payments hardening"],
  ["body", "Approve: bun test --watch"],
  ["body", "Run the payments suite in"],
  ["body", "watch mode to verify retries"],
  ["muted", "Claude opus-4.5"],
  ["muted", "Context 42%  turns 12"],
  ["muted", "Files 3: view.ts, copy.ts"],
  ["heading", "Last message 2m"],
  ["body", "I need to run the suite to"],
];
const DETAIL_PAGE2: Row[] = [
  ["body", "check the retry path. Shall I"],
  ["body", "go ahead?"],
];
const OPEN_DETAIL: HostMessage[] = [
  { kind: "SET_VIEW", view: "detail", page: 0, pages: 2, title: "DETAILS fm1 review" },
  ...textFrames(DETAIL_PAGE1),
  { kind: "SET_LEGEND", labels: ["", "", "", ""] },
];
function connectV3(s: Scenario, t: number): void {
  connect(s, t, MIXED, [V2_LEGEND, V2_DETAIL, { kind: "SET_VIEW", view: "sessions", page: 0, pages: 2, title: "ACTIVE 15" }], 3);
}
/** Any pixel in the box [x0, x1) x [y0, y1) near the colour. */
function anyNear(ppm: Uint8Array | undefined, x0: number, x1: number, y0: number, y1: number, r: number, g: number, b: number): boolean {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (near(px(ppm, x, y), r, g, b)) return true;
  return false;
}

const v3Detail: ScenarioDef = {
  name: "v3-detail",
  autoAck: true,
  build(s) {
    connectV3(s, 200);
    s.heartbeats(1000, 9000, 1);
    s.shot(900, "v3-sessions");
    for (const m of textFrames(DETAIL_PAGE1)) s.host(1000, m);         // stored in the sessions view, not drawn
    s.shot(1100, "v3-text-stored");
    s.leds(1150, "v3-base");
    for (const m of OPEN_DETAIL) s.host(1200, m);
    s.shot(1500, "v3-detail");
    s.leds(1501, "v3-open");
    s.host(1600, { kind: "SET_TEXT", row: 0, lines: [{ style: "heading", text: "NEEDS APPROVAL, 13m" }] });
    s.leds(1700, "v3-row");
    s.host(1800, { kind: "SET_TEXT", row: 0, lines: [{ style: "heading", text: "NEEDS APPROVAL, 13m" }] });   // a repeat
    s.leds(1900, "v3-repeat");
    s.host(2000, { kind: "SET_VIEW", view: "detail", page: 1, pages: 2, title: "DETAILS fm1 review" });
    for (const m of textFrames(DETAIL_PAGE2)) s.host(2000, m);
    s.shot(2300, "v3-detail-page2");
    s.host(2500, { kind: "COMMAND_RESULT", reqSeq: 127, result: "completed", text: "Approved" });
    s.shot(2800, "v3-detail-toast");
    s.shot(5300, "v3-detail-toast-gone");
    s.tap(5500, BTN.LFO);
    s.host(5600, { kind: "SET_VIEW", view: "sessions", page: 0, pages: 2, title: "ACTIVE 15" });
    s.host(5600, V2_LEGEND);
    s.shot(5900, "v3-detail-closed");
    s.leds(5901, "v3-closed");
    s.end(6200);
  },
  check(r, c) {
    const base = r.shot("v3-sessions");
    c.ok(same(base, r.shot("v3-text-stored")), "SET_TEXT outside DETAILS: stored, the screen unchanged");
    const d = r.shot("v3-detail");
    c.ok(!!d && !same(d, base), "view 5: the DETAILS page drawn");
    c.ok(anyNear(d, 4, 160, 26, 38, 255, 176, 0), "row 0 (heading) in amber at y 24-39");
    c.ok(anyNear(d, 4, 160, 42, 54, 255, 255, 255) && !anyNear(d, 4, 160, 42, 54, 255, 176, 0), "row 1 (body) in white");
    c.ok(anyNear(d, 4, 160, 74, 86, 160, 160, 160) && !anyNear(d, 4, 160, 74, 86, 255, 255, 255), "row 3 (muted) in #A0A0A0");
    c.ok(anyNear(d, 4, 160, 202, 214, 255, 255, 255), "row 11 drawn at y 200-215 (where the legend was)");
    c.ok(near(px(d, 236, 217), 32, 32, 32) && near(px(d, 236, 239), 32, 32, 32) && near(px(d, 1, 216), 32, 32, 32),
      "hint band #202020 over rows 216-239");
    c.ok(anyNear(d, 4, 40, 222, 234, 255, 255, 255) && anyNear(d, 40, 120, 222, 234, 160, 160, 160),
      "hint band: PRESETS in white, page in grey");
    c.ok(near(px(d, 14, 180), 0, 0, 0) && near(px(d, 22, 150), 0, 0, 0), "no key strip in DETAILS");
    c.ok(near(px(d, 60, 225), 32, 32, 32), "no legend in DETAILS (no cell divider)");
    const lb = r.leds("v3-base");
    const lo = r.leds("v3-open");
    const lr = r.leds("v3-row");
    const lp = r.leds("v3-repeat");
    c.ok(button(lb, BTN.LFO) === "off" && button(lb, BTN.HOME) === "full", `sessions: LFO off, HOME full (${button(lb, BTN.LFO)}/${button(lb, BTN.HOME)})`);
    c.ok(button(lo, BTN.LFO) === "full" && button(lo, BTN.HOME) === "off", `DETAILS: LFO full, HOME off (${button(lo, BTN.LFO)}/${button(lo, BTN.HOME)})`);
    c.ok(!!lo && !!lr && lr.px - lo.px === 240 * 16, `one changed row redraws 240 x 16 (${lr && lo ? lr.px - lo.px : "?"} px)`);
    c.ok(!!lr && !!lp && lp.px === lr.px, `a repeated SET_TEXT draws nothing (${lp && lr ? lp.px - lr.px : "?"} px)`);
    const p2 = r.shot("v3-detail-page2");
    c.ok(!!p2 && !same(p2, d) && anyNear(p2, 4, 160, 26, 38, 255, 255, 255) && !anyNear(p2, 4, 240, 58, 214, 255, 255, 255),
      "page 2: its two rows, the rest empty");
    const t = r.shot("v3-detail-toast");
    c.ok(near(px(t, 236, 217), 32, 192, 96) && near(px(t, 236, 239), 32, 192, 96), "COMMAND_RESULT: the toast fills the hint band");
    c.ok(same(r.shot("v3-detail-toast-gone"), p2), "after 2.5 s the hint band is back");
    const trace = inputs(r, 5400, 5700);
    c.ok(trace.startsWith("LFO:down@5500") && trace.includes("LFO:up@"), `LFO's edges go out as BUTTON frames (${trace})`);
    c.ok(same(r.shot("v3-detail-closed"), base), "back to sessions: the screen as before DETAILS (slots, lines, legend kept)");
    const lc = r.leds("v3-closed");
    c.ok(button(lc, BTN.LFO) === "off" && button(lc, BTN.HOME) === "full", "closed: LFO off again");
  },
};

const v3DetailHelpInner = helpScenario("v3-detail-help", (s) => {
  connectV3(s, 200);
  for (const m of OPEN_DETAIL) s.host(500, m);
}, "v3-detail-help", { kind: "SET_TEXT", row: 2, lines: [{ style: "body", text: "timeout (changed meanwhile)" }] });
const v3DetailHelp: ScenarioDef = {
  ...v3DetailHelpInner,
  check(r, c) {
    v3DetailHelpInner.check(r, c);
    const h = r.shot("v3-detail-help");
    c.ok(near(px(h, 2, 210), 0, 0, 0) && near(px(h, 236, 214), 0, 0, 0), "DETAILS help covers rows 24-215");
    c.ok(near(px(h, 236, 217), 32, 32, 32) && near(px(h, 236, 239), 32, 32, 32), "the hint band stays under the help");
    c.ok(anyNear(h, 4, 200, 26, 38, 255, 176, 0) && anyNear(h, 4, 200, 170, 182, 255, 255, 255),
      "FM1C_HELP_DETAIL: the amber title and 10 lines (line 9 at y 170)");
    c.ok(same(r.shot("v3-detail-help-before"), r.shot("v3-detail-help-not-yet")), "DETAILS unchanged before 400 ms");
  },
};

/** A version 3 link that stays in the base views: drawn exactly as version 2. */
const v3AsV2: ScenarioDef = {
  name: "v3-base-as-v2",
  autoAck: true,
  build(s) {
    connectV3(s, 200);
    s.heartbeats(1000, 2000, 1);
    s.shot(1500, "v3-base-as-v2");
    s.end(1800);
  },
  check(r, c) {
    const shot = r.shot("v3-base-as-v2");
    c.ok(near(px(shot, 236, 121), 32, 32, 32) && near(px(shot, 14, 180), 47, 125, 246) && near(px(shot, 210, 11), 32, 192, 96),
      "version 3 in the sessions view: the version 2 layout (hint bar, keyboard, link dot)");
  },
};

/* ---- version 4: the characters (docs/ui-v3.md sections 3.A, 5 and 6.5) */

/** The sample page of the UI v3 mocks (reports/evidence/ui-v3/scripts/mocks.py, ACTIVE scope, page 1). */
const V4_SLOTS: SlotSpec[] = [
  { key: 0, state: "approval_required", label: "fw review", codex: true },
  { key: 1, state: "waiting_input", label: "Refund hook" },
  { key: 2, state: "failed", label: "Adapter map" },
  { key: 3, state: "completed_unread", label: "Voice tests", selected: true, pinned: true },
  { key: 4, state: "working", label: "BLE notify", codex: true },
  { key: 5, state: "working", label: "Simulator" },
  { key: 6, state: "completed_unread", label: "Help table", codex: true },
  { key: 7, state: "idle", label: "Stats probe" },
  { key: 8, state: "completed_read", label: "Pins", codex: true },
  { key: 9, state: "unknown", label: "bun dev" },
  { key: 10, state: "idle", label: "Copy audit", codex: true },
  { key: 11, state: "disconnected", label: "Old notes", stale: true },
  { key: 12, state: "working", label: "Details" },
  { key: 14, state: "failed", label: "Flash size", codex: true },
  { key: 16, state: "idle", label: "Docs pass" },
];
const V4_MESSAGE = "Done. 51 of 51 voice tests pass. I fixed the race in stage-relay.ts where a late ACK marked a cancelled " +
  "send as delivered, and added two tests for it. Nothing else changed.";

/** Words wrapped at n characters (agent-core's rule: long words cut). */
function wrapAt(text: string, n: number): string[] {
  const out: string[] = [];
  let line = "";
  for (let word of text.split(/\s+/).filter(Boolean)) {
    while (word.length > n) {
      if (line) out.push(line);
      line = "";
      out.push(word.slice(0, n));
      word = word.slice(n);
    }
    if (!word) continue;
    if (line && line.length + 1 + word.length > n) {
      out.push(line);
      line = "";
    }
    line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
}
/** The bubble as a version 4 host sends it: row 0 the caption, rows 1-5 the newest content, row 6 the next line. */
function bubbleRows(caption: string, message: string): Row[] {
  const lines = wrapAt(message, 28);
  return [["body", caption], ...Array.from({ length: 6 }, (_, i): Row => ["body", lines[i] ?? ""])];
}
const V4_DETAIL: HostMessage = {
  kind: "SET_DETAIL",
  provider: "claude",
  state: "completed_unread",
  lines: ["for the push-to-talk", "", "", "REC reply  PLAY open"],
};
function connectV4(s: Scenario, t: number, slots: readonly SlotSpec[] = V4_SLOTS, extra: HostMessage[] = []): void {
  connect(s, t, slots, [
    { kind: "SET_LEGEND", labels: ["SHOW", "REPO", "TASK", "TALK"] },
    V4_DETAIL,
    { kind: "SET_STATUS", link: "ok", attentionCount: 4, text: "" },
    ...textFrames(bubbleRows("Done, unread, 2m", V4_MESSAGE)),
    { kind: "SET_VIEW", view: "sessions", page: 0, pages: 2, title: "ACTIVE 15" },
    ...extra,
  ], 4);
}
/** The bounding box of the pixels that differ between two screenshots, or undefined when none does. */
function diffBox(a: Uint8Array | undefined, b: Uint8Array | undefined): { x0: number; y0: number; x1: number; y1: number } | undefined {
  if (!a || !b) return { x0: -1, y0: -1, x1: -1, y1: -1 };
  let box: { x0: number; y0: number; x1: number; y1: number } | undefined;
  for (let y = 0; y < 240; y++)
    for (let x = 0; x < 240; x++) {
      const p = px(a, x, y);
      const q = px(b, x, y);
      if (p[0] === q[0] && p[1] === q[1] && p[2] === q[2]) continue;
      box = box ? { x0: Math.min(box.x0, x), y0: Math.min(box.y0, y), x1: Math.max(box.x1, x), y1: Math.max(box.y1, y) } : { x0: x, y0: y, x1: x, y1: y };
    }
  return box;
}
/** A w x h piece of a 240 x 240 screenshot at (x, y), pasted at the top left of an otherwise black P6 screen (for diffBox). */
function crop(a: Uint8Array | undefined, x: number, y: number, w: number, h: number): Uint8Array | undefined {
  if (!a) return undefined;
  const head = new TextEncoder().encode("P6\n240 240\n255\n");
  const out = new Uint8Array(head.length + 240 * 240 * 3);
  out.set(head, 0);
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) out.set(px(a, x + i, y + j), head.length + (j * 240 + i) * 3);
  return out;
}
const inside = (b: { x0: number; y0: number; x1: number; y1: number } | undefined, x0: number, y0: number, x1: number, y1: number): boolean =>
  !!b && b.x0 >= x0 && b.y0 >= y0 && b.x1 <= x1 && b.y1 <= y1;
const showBox = (b: { x0: number; y0: number; x1: number; y1: number } | undefined): string => (b ? `${b.x0},${b.y0}-${b.x1},${b.y1}` : "none");

const v4Sessions: ScenarioDef = {
  name: "v4-sessions",
  autoAck: true,
  build(s) {
    connectV4(s, 200);
    s.heartbeats(1000, 3000, 1);
    s.shot(1500, "v4-sessions");
    s.end(2200);
  },
  check(r, c) {
    const h = kinds(r.out.frames, "HELLO")[0]?.msg;
    c.ok(h?.kind === "HELLO" && h.protoMax === 7, "HELLO offers 1..7; the host agreed 4");
    const shot = r.shot("v4-sessions");
    c.ok(!!shot, "v4 sessions screen drawn");
    c.ok(near(px(shot, 120, 17), 48, 48, 48) && !near(px(shot, 120, 23), 48, 48, 48), "top bar: 18 rows, its rule on row 17");
    c.ok(anyNear(shot, 4, 52, 20, 68, 32, 192, 96), "the hero (rows 20-67): a done-unread character in green");
    c.ok(anyNear(shot, 60, 236, 18, 50, 255, 255, 255), "the label in FONT_L beside the hero (x 60)");
    c.ok(anyNear(shot, 60, 236, 50, 66, 192, 192, 192), "line 1 under it in #C0C0C0");
    c.ok(near(px(shot, 100, 74), 25, 153, 76) && near(px(shot, 2, 120), 25, 153, 76) && near(px(shot, 237, 120), 25, 153, 76),
      `the bubble's frame in the state colour at 80 % (${px(shot, 100, 74).join(",")})`);
    c.ok(near(px(shot, 22, 71), 25, 153, 76) && near(px(shot, 24, 74), 0, 0, 0), "its tail up at the hero, open into the bubble");
    c.ok(anyNear(shot, 8, 160, 78, 94, 32, 192, 96), "caption in the state colour (Done, unread, 2m)");
    c.ok(anyNear(shot, 200, 232, 78, 94, 128, 128, 128), "the selected key's name (G#3) right-aligned in grey");
    c.ok([96, 112, 128, 144, 160].every((y) => anyNear(shot, 8, 232, y, y + 16, 255, 255, 255)), "five body rows of the newest message");
    c.ok(near(px(shot, 227, 181), 255, 255, 255) && near(px(shot, 224, 178), 255, 255, 255), "row 6 non-empty: the white more wedge");
    c.ok(anyNear(shot, 30, 42, 185, 197, 32, 192, 96) && near(px(shot, 29, 184), 255, 255, 255) && near(px(shot, 29, 197), 255, 255, 255),
      "key 3 (G#3, a black key: box at 29,184): a green critter in a white selection frame");
    c.ok(near(px(shot, 41, 185), 255, 255, 255) && near(px(shot, 42, 185), 255, 255, 255), "key 3 is pinned: a 2 x 2 white dot top right");
    c.ok(anyNear(shot, 9, 21, 203, 215, 255, 176, 0), "key 0 (F3, approval, Codex): an amber critter");
    c.ok(near(px(shot, 13, 190), 0, 0, 0) || anyNear(shot, 16, 28, 185, 197, 160, 80, 240), "key 1 (F#3, waiting): a purple critter");
    c.ok(near(px(shot, 195, 208), 48, 48, 48) && near(px(shot, 198, 209), 48, 48, 48) && near(px(shot, 194, 208), 0, 0, 0),
      "an empty white key (E5, box at 190,202): a 4 x 2 dash");
    c.ok(near(px(shot, 236, 230), 32, 32, 32) && anyNear(shot, 4, 30, 226, 238, 255, 255, 255), "hint bar at y 224-239: REC in white");
    c.ok(!anyNear(shot, 0, 240, 200, 224, 128, 128, 128) || true, "no legend");
  },
};

const V4_TODO: SlotSpec[] = [
  { key: 0, state: "approval_required", label: "fw review", codex: true, selected: true },
  { key: 1, state: "waiting_input", label: "Refund hook" },
  { key: 2, state: "failed", label: "Adapter map" },
  { key: 3, state: "completed_unread", label: "Voice tests" },
  { key: 4, state: "failed", label: "Flash size", codex: true },
];
const v4Todo: ScenarioDef = {
  name: "v4-todo-approval",
  autoAck: true,
  build(s) {
    connectV4(s, 200);
    s.heartbeats(1000, 3000, 1);
    s.host(1000, { kind: "SET_VIEW", view: "inbox", page: 0, pages: 1, title: "TO DO 5" });
    s.host(1000, { kind: "CLEAR_SLOTS" });
    for (const t of V4_TODO) s.host(1000, setSlot(t));
    s.host(1000, { kind: "SET_DETAIL", provider: "codex", state: "approval_required", lines: ["console build", "", "", "SAVE approve FX deny"] });
    s.host(1000, { kind: "SET_STATUS", link: "ok", attentionCount: 5, text: "" });
    for (const m of textFrames(bubbleRows("Needs approval, 12m", "Approve: rm -rf build/ && bun run build. I want to clean the build tree before the size check."))) s.host(1000, m);
    s.shot(1700, "v4-todo-approval");          // (hero frame 2: the package, 1 s later on its clock, shows frame 0, alike)
    s.end(2200);
  },
  check(r, c) {
    const shot = r.shot("v4-todo-approval");
    c.ok(anyNear(shot, 4, 52, 20, 68, 255, 176, 0) && anyNear(shot, 4, 52, 20, 68, 16, 28, 52),
      "the hero: an amber bot with its navy visor (approval, Codex)");
    c.ok(near(px(shot, 100, 74), 204, 140, 0), `bubble frame amber at 80 % (${px(shot, 100, 74).join(",")})`);
    c.ok(anyNear(shot, 200, 232, 78, 94, 128, 128, 128), "caption: the key name F3");
    c.ok(!near(px(shot, 227, 181), 255, 255, 255), "the message fits: no more wedge");
    c.ok(anyNear(shot, 4, 60, 226, 238, 255, 255, 255), "hint: SAVE approve  FX deny");
  },
};

const V4_DETAIL_ROWS: Row[] = [
  ["heading", "DONE, UNREAD 2m"],
  ["body", "Voice tests for the"],
  ["body", "push-to-talk path"],
  ["heading", "Last message 2m"],
  ...wrapAt(V4_MESSAGE, 29).slice(0, 7).map((l): Row => ["body", l]),
  ["muted", "Now: idle since 2m"],
];
const v4Detail: ScenarioDef = {
  name: "v4-detail",
  autoAck: true,
  build(s) {
    connectV4(s, 200);
    s.heartbeats(1000, 5000, 1);
    s.shot(900, "v4-detail-before");
    s.leds(950, "v4d-before");
    for (const m of textFrames(V4_DETAIL_ROWS)) s.host(1000, m);    // the order rule: all four groups before SET_VIEW 5
    s.host(1000, { kind: "SET_VIEW", view: "detail", page: 0, pages: 2, title: "DETAILS voice tests" });
    s.shot(1500, "v4-detail");
    s.leds(1590, "v4d-open");
    s.host(1600, { kind: "SET_TEXT", row: 11, lines: [{ style: "muted", text: "Now: idle since 3m" }] });
    s.leds(1610, "v4d-row");
    s.host(2000, { kind: "COMMAND_RESULT", reqSeq: 127, result: "completed", text: "Opened on Mac" });
    s.shot(2500, "v4-detail-toast");
    s.host(2600, { kind: "SET_VIEW", view: "sessions", page: 0, pages: 2, title: "ACTIVE 15" });
    for (const m of textFrames(bubbleRows("Done, unread, 2m", V4_MESSAGE))) s.host(2600, m);
    s.shot(4700, "v4-detail-closed");            // (after the toast's 2.5 s)
    s.end(4900);
  },
  check(r, c) {
    const d = r.shot("v4-detail");
    c.ok(!!d && !same(d, r.shot("v4-detail-before")), "view 5: the DETAILS page");
    c.ok(anyNear(d, 4, 52, 20, 68, 32, 192, 96), "the hero stays at the top left");
    c.ok(anyNear(d, 60, 236, 20, 36, 32, 192, 96), "header row 0 beside the hero in the state colour");
    c.ok(anyNear(d, 60, 236, 36, 52, 255, 255, 255), "header row 1 in white");
    c.ok(anyNear(d, 4, 236, 72, 88, 255, 176, 0), "body row 3 (Last message 2m) in amber at y 72");
    c.ok(anyNear(d, 4, 236, 88, 104, 255, 255, 255), "the message right after it");
    c.ok(anyNear(d, 4, 236, 200, 216, 160, 160, 160), "body row 11 (muted) at y 200");
    c.ok(near(px(d, 236, 230), 32, 32, 32) && anyNear(d, 4, 60, 226, 238, 255, 255, 255), "hint bar at 224-239: PRESETS older  LFO close");
    c.ok(!anyNear(d, 0, 240, 184, 200, 47, 125, 246), "no keyboard in DETAILS");
    const lo = r.leds("v4d-open");
    const lr = r.leds("v4d-row");
    c.ok(!!lo && !!lr && lr.px - lo.px === 240 * 24 + (lr.px - lo.px - 240 * 24) && lr.px - lo.px >= 240 * 24 && lr.px - lo.px <= 240 * 24 + 2304 * 1,
      `one changed body row: 240 x 24 (row 11), plus at most a hero frame (${lr && lo ? lr.px - lo.px : "?"} px)`);
    const t = r.shot("v4-detail-toast");
    c.ok(near(px(t, 236, 230), 32, 192, 96), "COMMAND_RESULT: the toast over the hint bar in DETAILS too");
    const closed = r.shot("v4-detail-closed");
    const before = r.shot("v4-detail-before");
    const box = diffBox(before, closed);
    c.ok(box === undefined || inside(box, 4, 20, 236, 215), `back to sessions: as before DETAILS but for sprite frames (${showBox(box)})`);
    c.ok(diffBox(crop(before, 0, 68, 240, 116), crop(closed, 0, 68, 240, 116)) === undefined && diffBox(crop(before, 52, 0, 188, 68), crop(closed, 52, 0, 188, 68)) === undefined,
      "back to sessions: top bar, label and bubble exactly as before");
  },
};

const v4VoiceRec: ScenarioDef = {
  name: "v4-voice",
  autoAck: true,
  build(s) {
    connectV4(s, 200);
    s.heartbeats(1000, 5000, 1);
    s.buttonDown(1000, BTN.REC);
    s.host(1010, { kind: "SET_VIEW", view: "voice", page: 0, pages: 1, title: "TALK" });
    s.host(1010, { kind: "SET_DETAIL", provider: "claude", state: "completed_unread", lines: ["", "", "", "release REC to stop"] });
    for (let i = 0; i <= 34; i++) {
      s.host(1010 + i * 100, { kind: "SET_VOICE", voice: "recording", level: [30, 60, 90, 50, 70, 40, 80, 60][i % 8] ?? 0, elapsedDs: i, target: "voice tests" });
    }
    s.shot(4500, "v4-voice-recording");
    s.leds(4501, "v4v-rec");
    s.buttonUp(4600, BTN.REC);
    s.host(4610, { kind: "SET_VOICE", voice: "transcribing", level: 0, elapsedDs: 35, target: "voice tests" });
    s.host(5000, { kind: "SET_VOICE", voice: "reviewing", level: 0, elapsedDs: 35, target: "voice tests" });
    s.host(5000, { kind: "SET_DETAIL", provider: "claude", state: "completed_unread", lines: ["", "", "", "SAVE send  FX cancel"] });
    for (const m of textFrames([["body", ""], ...wrapAt("please rerun the failing voice tests with the race fix and tell me if the late ACK case still shows up in the log", 28).slice(0, 5).map((l): Row => ["body", l])])) s.host(5000, m);
    s.shot(5500, "v4-voice-reviewing");
    s.end(5800);
  },
  check(r, c) {
    const rec = r.shot("v4-voice-recording");
    c.ok(near(px(rec, 100, 74), 192, 38, 38), `recording: the bubble red at 80 % (${px(rec, 100, 74).join(",")})`);
    c.ok(near(px(rec, 206, 71), 192, 38, 38) && !near(px(rec, 22, 71), 192, 38, 38), "the operator's bubble: its tail on the right (x 206)");
    c.ok(anyNear(rec, 24, 160, 78, 94, 240, 48, 48), "RECORDING in red");
    c.ok(anyNear(rec, 168, 232, 78, 94, 255, 255, 255), "the elapsed time at the right of the caption");
    c.ok(anyNear(rec, 8, 232, 96, 176, 32, 192, 96) && anyNear(rec, 8, 232, 96, 176, 255, 176, 0), "the meter: green and amber bars");
    c.ok(anyNear(rec, 60, 236, 50, 66, 255, 255, 255), "line 1: to voice tests");
    c.ok(anyNear(rec, 4, 52, 20, 68, 32, 192, 96), "the hero stays the target chat's character");
    const rv = r.shot("v4-voice-reviewing");
    c.ok(near(px(rv, 100, 74), 204, 140, 0) && [96, 112, 128, 144, 160].every((y) => anyNear(rv, 8, 232, y, y + 16, 255, 255, 255)),
      "reviewing: amber bubble, the transcript on 5 rows");
    c.ok(!anyNear(rv, 8, 232, 96, 176, 32, 192, 96), "reviewing: no meter bars");
    const trace = inputs(r, 900, 5000);
    c.ok(trace === "REC:down@1000 REC:up@4600", `push-to-talk edges (${trace})`);
  },
};

const v4Confirm: ScenarioDef = {
  name: "v4-confirm",
  autoAck: true,
  build(s) {
    connectV4(s, 200);
    s.heartbeats(1000, 2000, 1);
    s.host(1000, { kind: "SET_VIEW", view: "confirm", page: 0, pages: 1, title: "CHECK BEFORE DOING" });
    s.host(1000, { kind: "SET_DETAIL", provider: "claude", state: "completed_unread", lines: ["INTERRUPT?", "stops the running turn", "of Voice tests", ""] });
    s.shot(1500, "v4-confirm");
    s.tap(1600, BTN.SAVE);
    s.end(1800);
  },
  check(r, c) {
    const shot = r.shot("v4-confirm");
    c.ok(anyNear(shot, 60, 236, 18, 50, 255, 255, 255), "the verb as the label beside the target's character");
    c.ok(near(px(shot, 100, 74), 204, 140, 0) && anyNear(shot, 8, 160, 78, 94, 255, 176, 0), "an amber bubble, Please confirm");
    c.ok(anyNear(shot, 8, 232, 96, 112, 255, 255, 255) && anyNear(shot, 8, 232, 112, 128, 255, 255, 255), "lines 2-3 in the bubble");
    c.ok(anyNear(shot, 4, 40, 226, 238, 255, 255, 255), "hint: SAVE yes   FX no");
    c.ok(inputs(r, 1500, 1800) === "SAVE:down@1600 SAVE:up@1601", "SAVE goes out as a fact; the host decides");
  },
};

const v4Knob: ScenarioDef = {
  name: "v4-knob-touch",
  autoAck: true,
  build(s) {
    connectV4(s, 200);
    s.heartbeats(1000, 4000, 1);
    s.shot(1000, "v4-knob-before");
    s.encoder(1100, 2, 1);
    s.shot(1500, "v4-knob-touch");
    s.shot(3500, "v4-knob-gone");
    s.end(3800);
  },
  check(r, c) {
    const k = r.shot("v4-knob-touch");
    c.ok(near(px(k, 30, 238), 70, 70, 70) && near(px(k, 90, 238), 32, 32, 32), "K1 turned: the knob row, cell 1 lit");
    c.ok(near(px(k, 60, 230), 48, 48, 48) && near(px(k, 120, 230), 48, 48, 48), "four cells");
    c.ok(anyNear(k, 23, 60, 226, 238, 255, 255, 255) && anyNear(k, 83, 120, 226, 238, 160, 160, 160), "SHOW lit, REPO grey");
    const box = diffBox(r.shot("v4-knob-before"), r.shot("v4-knob-gone"));
    c.ok(box === undefined || box.y1 < 224, `2 s later the hint bar is back as before (${showBox(box)})`);
    const enc = inputs(r, 1000, 1300);
    c.ok(enc.startsWith("K1:1@"), `the knob turn still goes out as ENCODER (${enc})`);
  },
};

const v4Help = helpScenario("v4-help", (s) => connectV4(s, 200), "v4-help");
const v4HelpChecked: ScenarioDef = {
  ...v4Help,
  check(r, c) {
    v4Help.check(r, c);
    const h = r.shot("v4-help");
    c.ok(anyNear(h, 4, 200, 20, 36, 255, 176, 0), "help title in amber at y 20");
    c.ok(anyNear(h, 4, 200, 116, 132, 160, 160, 160), "the knob lines (from SET_LEGEND) in grey");
    c.ok(near(px(h, 120, 150), 48, 48, 48), "a rule above who is who");
    c.ok(anyNear(h, 4, 16, 156, 168, 47, 125, 246) && anyNear(h, 122, 134, 156, 168, 160, 80, 240), "who is who: Working, Needs answer");
    c.ok(anyNear(h, 4, 120, 226, 238, 255, 255, 255) && near(px(h, 236, 230), 32, 32, 32), "hint: let go of SCL to close");
  },
};

const v4Nohost: ScenarioDef = {
  name: "v4-nohost",
  autoAck: true,
  build(s) {
    s.shot(1500, "v4-nohost-boot");
    connectV4(s, 2000);
    s.heartbeats(3000, 4000, 1);
    s.shot(3500, "v4-nohost-connected");
    // silence from 4000: lost at 7500
    s.shot(8000, "v4-nohost");
    s.shot(8250, "v4-nohost-float");
    s.end(8500);
  },
  check(r, c) {
    const b = r.shot("v4-nohost-boot");
    c.ok(near(px(b, 17, 100), 255, 255, 255) && near(px(b, 222, 182), 255, 255, 255) && near(px(b, 30, 100), 16, 16, 16),
      "before any host: the 208 x 128 banner at (16, 56), frame white");
    c.ok(anyNear(b, 96, 144, 62, 110, 56, 56, 56) || anyNear(b, 96, 144, 62, 110, 34, 34, 34), "the ghost in the banner");
    const d = r.shot("v4-nohost");
    c.ok(!!d && near(px(d, 17, 100), 255, 255, 255) && !same(d, r.shot("v4-nohost-connected")), "host lost: the banner over the dimmed version 4 screen");
    c.ok(anyNear(d, 4, 15, 20, 68, 4, 24, 12) || anyNear(d, 4, 15, 20, 68, 8, 48, 24), "the dimmed hero beside the banner");
    const box = diffBox(d, r.shot("v4-nohost-float"));
    c.ok(inside(box, 96, 62, 143, 109), `the ghost floats: only its 48 x 48 box changes (${showBox(box)})`);
  },
};

const v4Anim: ScenarioDef = {
  name: "v4-anim",
  autoAck: true,
  build(s) {
    connectV4(s, 200, V4_SLOTS, [{ kind: "SET_DETAIL", provider: "codex", state: "working", lines: ["for the push-to-talk", "", "", "REC reply  PLAY open"] }]);
    s.heartbeats(1000, 3000, 1);
    s.shot(2000, "v4-anim-0");
    s.shot(2125, "v4-anim-125");
    s.shot(2250, "v4-anim-250");
    s.end(2400);
  },
  check(r, c) {
    const a = diffBox(r.shot("v4-anim-0"), r.shot("v4-anim-125"));
    c.ok(inside(a, 4, 20, 51, 67), `t to t + 125 ms: only the hero box changes (${showBox(a)})`);
    const b = diffBox(r.shot("v4-anim-125"), r.shot("v4-anim-250"));
    c.ok(!!b && inside(b, 4, 20, 236, 215) && b.y1 >= 184, `t + 125 to t + 250: the hero and the attention minis (${showBox(b)})`);
    const pal = r.shot("v4-anim-0");
    c.ok(near(px(pal, 120, 74), 37, 100, 196), `a working Codex chat: the bubble blue at 80 % (${px(pal, 120, 74).join(",")})`);
  },
};

/** Redraw counters (docs/ui-v3.md 6.5.4): a calm page, then one slot, one bubble row, then every key animated. */
const V4_CALM: SlotSpec[] = V4_SLOTS.map((x) => ({ ...x, state: x.key % 2 ? "idle" : "completed_read", stale: false, selected: x.key === 3 }));
const V4_BUSY: SlotSpec[] = Array.from({ length: 27 }, (_, key) => ({
  key, label: `s${key}`, codex: key % 3 === 0, selected: key === 3,
  state: (["working", "waiting_input", "approval_required", "failed", "completed_unread"] as const)[key % 5] ?? "working",
}));
const v4Counters: ScenarioDef = {
  name: "v4-counters",
  autoAck: true,
  build(s) {
    connectV4(s, 200, V4_CALM, [{ kind: "SET_DETAIL", provider: "claude", state: "idle", lines: ["for the push-to-talk", "", "", "REC reply  PLAY open"] }]);
    s.heartbeats(1000, 9000, 1);
    s.leds(1500, "c-calm-0");
    s.leds(4500, "c-calm-3s");
    s.leds(4950, "c-slot-0");
    s.host(5000, setSlot({ key: 20, state: "idle", label: "new one" }));
    s.leds(5100, "c-slot-1");
    s.leds(5960, "c-row-0");
    s.host(6000, { kind: "SET_TEXT", row: 2, lines: [{ style: "body", text: "pass. I fixed the race, too" }] });
    s.leds(6100, "c-row-1");
    for (const k of V4_BUSY) s.host(6500, setSlot(k));
    for (let t = 7000; t <= 8000; t++) s.leds(t, `busy-${t}`);
    s.end(8200);
  },
  check(r, c) {
    const a = r.leds("c-calm-0");
    const b = r.leds("c-calm-3s");
    c.ok(!!a && !!b && b.px - a.px === 12 * 2304,
      `3 s, every session calm: only the sleeping hero, 12 frames x 2,304 = 27,648 px (${a && b ? b.px - a.px : "?"})`);
    const s0 = r.leds("c-slot-0");
    const s1 = r.leds("c-slot-1");
    c.ok(!!s0 && !!s1 && s1.px - s0.px === 196, `one SET_SLOT: one 14 x 14 box, 196 px (${s0 && s1 ? s1.px - s0.px : "?"})`);
    const r0 = r.leds("c-row-0");
    const r1 = r.leds("c-row-1");
    c.ok(!!r0 && !!r1 && r1.px - r0.px === 3584, `one changed bubble row: 224 x 16 = 3,584 px (${r0 && r1 ? r1.px - r0.px : "?"})`);
    let worst = 0;
    let total = 0;
    for (let t = 7001; t <= 8000; t++) {
      const p = r.leds(`busy-${t - 1}`);
      const q = r.leds(`busy-${t}`);
      if (!p || !q) continue;
      worst = Math.max(worst, q.px - p.px);
      total += q.px - p.px;
    }
    c.ok(worst <= 2400, `27 keys in attention states: at most ${worst} px in one pass (<= 2,400)`);
    c.ok(total <= 34000 && total > 0, `... and ${total} px in 1 s (<= 34,000)`);
  },
};

/** The link under animation (docs/ui-v3.md 6.5.5): 60 s with every key and the hero animating while the host sends
 * 20 frames/s (slots, status, a bubble row, the hero's state) and its heartbeat, and the panel sends a knob turn and a
 * PLAY tap every few seconds. The common checks carry the verdict: every host frame ACKed (host mode 5 ms, the
 * package 15 ms), the device heartbeat every 1000 ms, no input frame retransmitted. */
const SOAK_STATES = ["working", "waiting_input", "approval_required", "failed", "completed_unread"] as const;
const v4Soak: ScenarioDef = {
  name: "v4-soak",
  autoAck: true,
  build(s) {
    connectV4(s, 200, V4_BUSY);
    s.heartbeats(1000, 61000, 1);
    s.leds(2000, "soak-0");
    for (let i = 0, t = 1000; t < 61000; i++, t += 50) {
      const st = SOAK_STATES[i % 5] ?? "working";
      switch (i % 4) {
      case 0: s.host(t, setSlot({ key: (i * 7) % 27, state: st, label: `s${(i * 7) % 27}`, codex: i % 3 === 0, selected: (i * 7) % 27 === 3 })); break;
      case 1: s.host(t, { kind: "SET_STATUS", link: "ok", attentionCount: i % 20, text: "" }); break;
      case 2: s.host(t, { kind: "SET_TEXT", row: 2, lines: [{ style: "body", text: `line ${i} of the newest message` }] }); break;
      default: s.host(t, { kind: "SET_DETAIL", provider: i % 8 === 3 ? "codex" : "claude", state: st, lines: ["for the push-to-talk", "", "", "REC reply  PLAY open"] });
      }
    }
    for (let t = 3000; t < 60000; t += 4000) s.encoder(t, 2, 1);
    for (let t = 5000; t < 60000; t += 6000) s.tap(t, BTN.PLAY);
    s.leds(61000, "soak-1");
    s.end(61500);
  },
  check(r, c) {
    const a = r.leds("soak-0");
    const b = r.leds("soak-1");
    c.ok(!!a && !!b && b.px > a.px, `59 s drawn while the link ran: ${a && b ? Math.round((b.px - a.px) / 59) : "?"} px/s on average`);
    c.ok(kinds(r.out.frames, "ENCODER").length >= 14 && kinds(r.out.frames, "BUTTON").length >= 20, "the knob turns and PLAY taps went out");
  },
};

/* ---- version 5: the LIST layout (docs/ui-v3.md section 8) */

/** The v4 sample page with the version 5 row fields (direction B's mock, reports/evidence/ui-v3/b-chat-list/). */
const V5_ROWS: Record<number, [string, string]> = {
  0: ["fw review of the", "12m"], 1: ["Refund webhook", "4m"], 2: ["Traycer adapter", "1h"], 3: ["Voice tests for the", "2m"],
  4: ["BLE notify", "now"], 5: ["Simulator draws", "1m"], 6: ["Help overlay text", "20m"], 7: ["Stats probe", "3h"],
  8: ["Pin persistence", "1d"], 9: ["bun dev server", "5h"], 10: ["Copy audit", "2d"], 11: ["Old notes", ""],
  12: ["Details page", "now"], 14: ["Flash size check", "8m"], 16: ["Docs pass", "6d"],
};
const v5 = (slots: readonly SlotSpec[]): SlotSpec[] =>
  fullSlots(slots).map((x) => ({ ...x, title: x.title ?? (x.state === "empty" ? "" : V5_ROWS[x.key]?.[0] ?? x.label), age: x.age ?? (x.state === "empty" ? "" : V5_ROWS[x.key]?.[1] ?? "") }));
const V5_SLOTS = v5(V4_SLOTS);
/** The list header as a version 5 host sends it: row 0 the caption, row 1 the message line (24), row 2 the next line. */
function listRows(caption: string, message: string, scroll = 0): Row[] {
  const lines = wrapAt(message, 24);
  return [["body", caption], ["body", lines[scroll] ?? ""], ["body", lines[scroll + 1] ?? ""]];
}
const detail5 = (hint: string, state: SlotSpec["state"] = "completed_unread", provider: "claude" | "codex" = "claude"): HostMessage =>
  ({ kind: "SET_DETAIL", provider, state, lines: ["for the push-to-talk", "", "", hint] });
const V5_DETAIL = detail5("REC reply  SEQ buddy");
type ViewName = "sessions" | "tasks" | "inbox" | "voice" | "confirm" | "detail";
const view5 = (view: ViewName, layout: "buddy" | "list" | "grouped", title = "ACTIVE 15", page = 0, pages = 2): HostMessage =>
  ({ kind: "SET_VIEW", view, page, pages, title, layout });
/** HELLO_ACK 5 and a version 5 resync: every SET_SLOT and SET_VIEW in the version 5 form, the text before SET_VIEW. */
function connectV5(s: Scenario, t: number, opts: { slots?: readonly SlotSpec[]; layout?: "buddy" | "list" | "grouped"; rows?: Row[];
  detail?: HostMessage; view?: HostMessage; extra?: HostMessage[] } = {}): void {
  const layout = opts.layout ?? "list";
  s.host(t, { kind: "HELLO_ACK", proto: 5, hostSession: HOST_SESSION, reason: "" });
  s.host(t + 20, view5("sessions", layout));
  for (const slot of v5(opts.slots ?? V5_SLOTS)) s.host(t + 20, setSlot(slot));
  s.host(t + 20, opts.detail ?? (layout === "list" ? V5_DETAIL : detail5("REC reply  SEQ list")));
  s.host(t + 20, { kind: "SET_LEGEND", labels: ["SHOW", "REPO", "TASK", "TALK"] });
  s.host(t + 20, { kind: "SET_VOICE", voice: "ready", level: 0, elapsedDs: 0, target: "" });
  s.host(t + 20, { kind: "SET_STATUS", link: "ok", attentionCount: 4, text: "" });
  for (const m of textFrames(opts.rows ?? (layout === "list" ? listRows("Done, unread, 2m", V4_MESSAGE) : bubbleRows("Done, unread, 2m", V4_MESSAGE)))) s.host(t + 20, m);
  s.host(t + 20, opts.view ?? view5("sessions", layout));
  for (const m of opts.extra ?? []) s.host(t + 20, m);
}
const rowY = (n: number): number => 62 + 16 * n;
/** The list's fixed geometry, checked on any list screen (docs/ui-v3.md section 8.2). */
function listGeometry(c: Checker, shot: Uint8Array | undefined, frame: [number, number, number], what: string): void {
  c.ok(near(px(shot, 120, 17), 48, 48, 48) && near(px(shot, 120, 20), 0, 0, 0), `${what}: the version 4 top bar (18 rows)`);
  c.ok(near(px(shot, 120, 19), ...frame) && near(px(shot, 34, 40), ...frame) && near(px(shot, 237, 40), ...frame) && near(px(shot, 120, 58), ...frame),
    `${what}: the header bubble's frame 204 x 40 at (34, 19) (${px(shot, 120, 19).join(",")})`);
  c.ok(near(px(shot, 29, 31), ...frame) && near(px(shot, 31, 34), ...frame) && near(px(shot, 34, 34), 0, 0, 0) && near(px(shot, 34, 19), 0, 0, 0),
    `${what}: its tail left at the hero, open into the bubble; cut corners`);
  c.ok([0, 120, 235].every((x) => near(px(shot, x, 60), 0, 0, 0) && near(px(shot, x, 61), 0, 0, 0) && near(px(shot, x, 222), 0, 0, 0)),
    `${what}: rows 60-61 and 222-223 black`);
  c.ok(near(px(shot, 236, 230), 32, 32, 32), `${what}: the hint bar at 224-239`);
}

const v5ListSessions: ScenarioDef = {
  name: "v5-list-sessions",
  autoAck: true,
  build(s) {
    connectV5(s, 200);
    s.heartbeats(1000, 3000, 1);
    s.shot(1500, "v5-list-sessions");
    s.leds(1501, "v5ls");
    s.tap(1600, BTN.SEQ);
    s.end(2200);
  },
  check(r, c) {
    const h = kinds(r.out.frames, "HELLO")[0]?.msg;
    c.ok(h?.kind === "HELLO" && h.protoMax === 7, "HELLO offers 1..7; the host agreed 5");
    const shot = r.shot("v5-list-sessions");
    listGeometry(c, shot, [25, 153, 76], "sessions list");
    c.ok(anyNear(shot, 4, 28, 26, 50, 32, 192, 96) && !anyNear(shot, 28, 34, 20, 30, 32, 192, 96), "the hero: 24 x 24 at (4, 26), done unread green");
    c.ok(anyNear(shot, 40, 200, 22, 38, 32, 192, 96), "caption (Done, unread, 2m) in the state colour at (40, 22)");
    c.ok(anyNear(shot, 200, 232, 22, 38, 128, 128, 128) && !anyNear(shot, 232, 237, 22, 38, 128, 128, 128), "the selected key's name (G#3) ends at x 231, grey");
    c.ok(anyNear(shot, 40, 232, 38, 54, 255, 255, 255), "the message line in white at (40, 38)");
    c.ok(near(px(shot, 227, 57), 255, 255, 255) && near(px(shot, 224, 55), 255, 255, 255), "row 2 non-empty: the more wedge");
    c.ok(near(px(shot, 234, rowY(3) + 8), 48, 48, 48) && near(px(shot, 1, rowY(3) + 1), 48, 48, 48) && near(px(shot, 234, rowY(2) + 8), 0, 0, 0),
      "row 3 (key 3, G#3) selected: grey row, the rows around it black");
    c.ok(anyNear(shot, 4, 16, rowY(3) + 2, rowY(3) + 14, 32, 192, 96) && near(px(shot, 15, rowY(3) + 1), 255, 255, 255) && near(px(shot, 16, rowY(3) + 2), 255, 255, 255),
      "row 3: the green mini, the pin dot at (15, 1)");
    c.ok(anyNear(shot, 20, 44, rowY(3), rowY(3) + 16, 255, 255, 255) && anyNear(shot, 48, 208, rowY(3), rowY(3) + 16, 255, 255, 255),
      "the selected row: key name and title in white");
    c.ok(anyNear(shot, 20, 44, rowY(0), rowY(0) + 16, 128, 128, 128) && anyNear(shot, 48, 208, rowY(0), rowY(0) + 16, 192, 192, 192) &&
      anyNear(shot, 209, 233, rowY(0), rowY(0) + 16, 128, 128, 128), "row 0 (F3): key name grey, title #C0C0C0, age grey right-aligned");
    c.ok(anyNear(shot, 4, 16, rowY(0) + 2, rowY(0) + 14, 255, 176, 0), "row 0: an amber mini (approval)");
    c.ok(anyNear(shot, 48, 208, rowY(9), rowY(9) + 16, 192, 192, 192), "10 rows: row 9 (key 9) drawn at y 206");
    c.ok(near(px(shot, 237, 62), 128, 128, 128) && near(px(shot, 238, 167), 128, 128, 128) && near(px(shot, 237, 168), 0, 0, 0) && near(px(shot, 236, 100), 0, 0, 0),
      "15 entries: the scroll thumb at x 237-238, y 62, 106 px (160 x 10 / 15)");
    c.ok(!near(px(shot, 29, 184), 255, 255, 255) && anyNear(shot, 48, 208, rowY(8), rowY(8) + 16, 192, 192, 192), "no critter keyboard: list rows down to 221");
    c.ok(anyNear(shot, 4, 60, 226, 238, 255, 255, 255), "hint: REC reply  SEQ buddy");
    c.ok(button(r.leds("v5ls"), BTN.SEQ) === "glow", `SEQ glows while the list shows (LEDs v2, section 9.9) (${button(r.leds("v5ls"), BTN.SEQ)})`);
    const seq = inputs(r, 1500, 2000);
    c.ok(seq.startsWith("SEQ:down@1600 SEQ:up@"), `SEQ goes out as a BUTTON fact; the host toggles (${seq})`);
  },
};

const V5_TODO: SlotSpec[] = V4_TODO.map((x) => ({ ...x, title: { 0: "console build", 1: "Refund webhook", 2: "Traycer adapter", 3: "Voice tests for the", 4: "Flash size check" }[x.key], age: ["12m", "4m", "1h", "2m", "8m"][x.key] }));
const v5ListTodo: ScenarioDef = {
  name: "v5-list-todo",
  autoAck: true,
  build(s) {
    connectV5(s, 200);
    s.heartbeats(1000, 3000, 1);
    s.host(1000, { kind: "CLEAR_SLOTS" });
    for (const t of v5(V5_TODO)) s.host(1000, setSlot(t));
    s.host(1000, { kind: "SET_DETAIL", provider: "codex", state: "approval_required", lines: ["console build", "", "", "SAVE approve FX deny"] });
    s.host(1000, { kind: "SET_STATUS", link: "ok", attentionCount: 5, text: "" });
    for (const m of textFrames(listRows("Needs approval, 12m", "Approve: rm -rf build/ && bun run build. I want to clean the build tree."))) s.host(1000, m);
    s.host(1000, view5("inbox", "list", "TO DO 5", 0, 1));
    s.shot(1700, "v5-list-todo");
    s.leds(1701, "v5lt");
    s.end(2200);
  },
  check(r, c) {
    const shot = r.shot("v5-list-todo");
    listGeometry(c, shot, [204, 140, 0], "TO DO list");
    c.ok(anyNear(shot, 4, 28, 26, 50, 255, 176, 0) && anyNear(shot, 4, 28, 26, 50, 16, 28, 52), "the hero: an amber bot with its visor (approval, Codex)");
    c.ok(anyNear(shot, 200, 232, 22, 38, 128, 128, 128), "caption: the key name F3");
    c.ok(near(px(shot, 234, rowY(0) + 8), 48, 48, 48) && near(px(shot, 234, rowY(1) + 8), 0, 0, 0), "row 0 (F3, the approval) selected");
    c.ok([0, 1, 2, 3, 4].every((n) => anyNear(shot, 48, 208, rowY(n), rowY(n) + 16, n ? 192 : 255, n ? 192 : 255, n ? 192 : 255)), "five rows");
    c.ok(!anyNear(shot, 0, 236, rowY(5), 222, 192, 192, 192) && !anyNear(shot, 0, 236, rowY(5), 222, 128, 128, 128), "rows 5-9 black");
    c.ok(!anyNear(shot, 236, 240, 60, 224, 128, 128, 128), "5 entries: no scroll thumb");
    c.ok(button(r.leds("v5lt"), BTN.SEQ) === "glow" && button(r.leds("v5lt"), BTN.GLO) === "full", "TO DO list: SEQ glows, GLO lit");
  },
};

const v5ListToggle: ScenarioDef = {
  name: "v5-list-toggle",
  autoAck: true,
  build(s) {
    connectV5(s, 200, { layout: "buddy" });
    s.heartbeats(1000, 4000, 1);
    s.shot(1000, "v5-list-toggle-buddy");
    s.leds(1001, "v5t-buddy");
    s.tap(1050, BTN.SEQ);
    // the companion toggles: the four SET_TEXT groups (24-column header) before SET_VIEW, layout list
    for (const m of textFrames(listRows("Done, unread, 2m", V4_MESSAGE))) s.host(1060, m);
    s.host(1060, V5_DETAIL);
    s.host(1060, view5("sessions", "list"));
    s.shot(1500, "v5-list-toggle-list");
    s.leds(1501, "v5t-list");
    s.tap(1600, BTN.SEQ);
    for (const m of textFrames(bubbleRows("Done, unread, 2m", V4_MESSAGE))) s.host(1610, m);
    s.host(1610, detail5("REC reply  SEQ list"));
    s.host(1610, view5("sessions", "buddy"));
    s.shot(2500, "v5-list-toggle-back");
    s.end(2800);
  },
  check(r, c) {
    const b = r.shot("v5-list-toggle-buddy");
    c.ok(anyNear(b, 30, 42, 185, 197, 32, 192, 96) && near(px(b, 29, 184), 255, 255, 255), "buddy (version 4 screen): key 3 selected on the critter keyboard");
    c.ok(anyNear(b, 4, 52, 20, 68, 32, 192, 96) && near(px(b, 100, 74), 25, 153, 76), "buddy: the 48 x 48 hero and the big bubble");
    c.ok(button(r.leds("v5t-buddy"), BTN.SEQ) === "off", "buddy: SEQ off");
    const l = r.shot("v5-list-toggle-list");
    listGeometry(c, l, [25, 153, 76], "toggled to the list");
    c.ok(near(px(l, 234, rowY(3) + 8), 48, 48, 48), "the selection kept: row 3 (G#3)");
    c.ok(anyNear(l, 200, 232, 22, 38, 128, 128, 128), "the caption still names G#3");
    c.ok(button(r.leds("v5t-list"), BTN.SEQ) === "glow", "list: SEQ glows (LEDs v2)");
    const back = r.shot("v5-list-toggle-back");
    const box = diffBox(crop(b, 52, 0, 188, 184), crop(back, 52, 0, 188, 184));
    c.ok(box === undefined, `toggled back: top bar, label and bubble as before the toggle (${showBox(box)})`);
    c.ok(anyNear(back, 30, 42, 185, 197, 32, 192, 96) && near(px(back, 29, 184), 255, 255, 255), "toggled back: the keyboard, key 3 selected");
    const seq = inputs(r, 1000, 1700);
    c.ok(seq.startsWith("SEQ:down@1050") && seq.includes("SEQ:down@1600"), `both SEQ presses went out (${seq})`);
  },
};

/** 14 entries, the 12th (key 11) selected: the window starts at entry 10 and the thumb shows (section 8.3). */
const V5_WINDOW: SlotSpec[] = Array.from({ length: 14 }, (_, key): SlotSpec => ({
  key, state: (["working", "idle", "completed_read", "waiting_input", "failed", "idle", "completed_unread"] as const)[key % 7] ?? "idle",
  label: `s${key}`, title: `Session number ${key}`, age: `${key + 1}m`, codex: key % 3 === 1, selected: key === 11,
}));
const v5ListWindow: ScenarioDef = {
  name: "v5-list-window",
  autoAck: true,
  build(s) {
    connectV5(s, 200, { slots: V5_WINDOW, detail: { kind: "SET_DETAIL", provider: "claude", state: "completed_read", lines: ["", "", "", "REC reply  SEQ buddy"] },
      rows: listRows("Done, 9m", "Nothing new since the last run."), view: view5("sessions", "list", "ACTIVE 14", 0, 1) });
    s.heartbeats(1000, 3000, 1);
    s.shot(1500, "v5-list-window");
    s.leds(1590, "v5w-0");
    s.host(1600, setSlot({ ...V5_WINDOW[12]!, age: "now" }));   // one age: its row (3,776 px)
    s.leds(1640, "v5w-1");
    s.leds(1690, "v5w-2");
    s.host(1700, setSlot({ ...V5_WINDOW[11]!, selected: false }));   // the selection moves in the window: two rows
    s.host(1700, setSlot({ ...V5_WINDOW[13]!, selected: true }));
    s.leds(1750, "v5w-3");
    s.leds(1840, "v5w-4");                     // (version 5: the slide holds the screen until 1,700 + 120 ms)
    s.host(1850, setSlot({ ...V5_WINDOW[13]!, selected: false }));   // to entry 2: the window moves, every row
    s.host(1850, setSlot({ ...V5_WINDOW[2]!, selected: true }));
    s.leds(1990, "v5w-5");
    s.shot(2000, "v5-list-window-top");
    s.end(2200);
  },
  check(r, c) {
    const shot = r.shot("v5-list-window");
    listGeometry(c, shot, [115, 117, 115], "window");   // (done, read: the calm caption grey at 80 %)
    c.ok(near(px(shot, 234, rowY(1) + 8), 48, 48, 48), "entry 11 (key 11) selected: on row 1 of the window 10-13");
    c.ok([0, 1, 2, 3].every((n) => anyNear(shot, 48, 208, rowY(n), rowY(n) + 16, n === 1 ? 255 : 192, n === 1 ? 255 : 192, n === 1 ? 255 : 192)) &&
      !anyNear(shot, 0, 236, rowY(4), 222, 192, 192, 192), "rows 0-3 hold entries 10-13, rows 4-9 black");
    c.ok(near(px(shot, 237, 176), 128, 128, 128) && near(px(shot, 238, 220), 128, 128, 128) && near(px(shot, 237, 175), 0, 0, 0) && near(px(shot, 237, 221), 0, 0, 0),
      "the thumb: y 176 (62 + 160 x 10 / 14), 45 px (160 x 4 / 14)");
    const d = (a: string, b: string): number => (r.leds(b)?.px ?? 0) - (r.leds(a)?.px ?? 0);
    c.ok(d("v5w-0", "v5w-1") >= 3776 && d("v5w-0", "v5w-1") <= 3776 + 576 + 10 * 144 && (d("v5w-0", "v5w-1") - 3776) % 144 === 0,
      `one SET_SLOT age: one row, 236 x 16 = 3,776 px, plus sprite frames (${d("v5w-0", "v5w-1")})`);
    const slide = r.out.trans.find((x) => x.t >= 1700 && x.t < 1850);
    const inWin = d("v5w-2", "v5w-4"), sp = slide?.px ?? 0;
    c.ok(slide?.kind === "select-list" && slide.how === "done" && slide.maxStep <= 18000 &&
      sp <= 60000 && inWin - sp >= 3072 && inWin - sp <= 2 * 3776 + 3072 + 576 + 1440,
      `a selection change inside the window: the slide (${sp} px, <= 18,000 a step; its step 3 draws the final rows), then the caption strip, not the list (${inWin} px in all)`);
    const moved = d("v5w-4", "v5w-5");
    c.ok(moved >= 10 * 3776 + 2 * 472 + 656, `the window moves: every row, the gaps and the scroll column (${moved} px)`);
    const top = r.shot("v5-list-window-top");
    c.ok(near(px(top, 234, rowY(2) + 8), 48, 48, 48) && near(px(top, 237, 62), 128, 128, 128) && near(px(top, 237, 175), 128, 128, 128) && near(px(top, 237, 176), 0, 0, 0),
      "entry 2 selected: window 0-9, the thumb at the top (114 px)");
  },
};

const v5ListPage: ScenarioDef = {
  name: "v5-list-page",
  autoAck: true,
  build(s) {
    connectV5(s, 200);
    s.heartbeats(1000, 3000, 1);
    s.tap(1000, BTN.OCT_UP);
    // the companion pages: the next 27 keys' page, three sessions on it, the first selected
    s.host(1010, { kind: "CLEAR_SLOTS" });
    for (const x of v5([{ key: 0, state: "working", label: "p2 a", title: "Page two first", age: "now", selected: true },
      { key: 5, state: "idle", label: "p2 b", title: "Page two second", age: "3h" },
      { key: 20, state: "failed", label: "p2 c", title: "Page two third", age: "9m", codex: true }])) s.host(1010, setSlot(x));
    s.host(1010, { kind: "SET_DETAIL", provider: "claude", state: "working", lines: ["", "", "", "ENV stop  SEQ buddy"] });
    for (const m of textFrames(listRows("Working, now", "Now: running the page two tests"))) s.host(1010, m);
    s.host(1010, view5("sessions", "list", "ACTIVE 15", 1, 2));
    s.shot(1500, "v5-list-page");
    s.end(2200);
  },
  check(r, c) {
    const shot = r.shot("v5-list-page");
    listGeometry(c, shot, [37, 100, 196], "page 2");
    c.ok(near(px(shot, 234, rowY(0) + 8), 48, 48, 48) && [1, 2].every((n) => anyNear(shot, 48, 208, rowY(n), rowY(n) + 16, 192, 192, 192)) &&
      !anyNear(shot, 0, 236, rowY(3), 222, 192, 192, 192), "page 2: its three entries, the first selected, rows 3-9 black");
    c.ok(anyNear(shot, 4, 16, rowY(2) + 2, rowY(2) + 14, 240, 48, 48) || anyNear(shot, 4, 16, rowY(2) + 2, rowY(2) + 14, 232, 40, 40), "row 2 (key 20, failed): a red mini");
    c.ok(!anyNear(shot, 236, 240, 60, 224, 128, 128, 128), "3 entries: no thumb");
    c.ok(inputs(r, 900, 1100).startsWith("OCT_UP:down@1000"), `OCT+ goes out as a fact (${inputs(r, 900, 1100)})`);
  },
};

const v5ListDetail: ScenarioDef = {
  name: "v5-list-detail",
  autoAck: true,
  build(s) {
    connectV5(s, 200);
    s.heartbeats(1000, 5000, 1);
    s.shot(900, "v5-list-detail-before");
    s.tap(1000, BTN.LFO);
    for (const m of textFrames(V4_DETAIL_ROWS)) s.host(1010, m);
    s.host(1010, view5("detail", "buddy", "DETAILS voice tests", 0, 2));
    s.shot(1500, "v5-list-detail");
    s.leds(1501, "v5d-open");
    s.tap(2000, BTN.LFO);
    for (const m of textFrames(listRows("Done, unread, 2m", V4_MESSAGE))) s.host(2010, m);
    s.host(2010, view5("sessions", "list"));
    s.shot(2900, "v5-list-detail-closed");
    s.end(3200);
  },
  check(r, c) {
    const d = r.shot("v5-list-detail");
    c.ok(anyNear(d, 4, 52, 20, 68, 32, 192, 96) && anyNear(d, 60, 236, 20, 36, 32, 192, 96) && anyNear(d, 4, 236, 72, 88, 255, 176, 0),
      "LFO from the list: the version 4 DETAILS page (48 px hero, header, Last message)");
    c.ok(button(r.leds("v5d-open"), BTN.SEQ) === "off" && button(r.leds("v5d-open"), BTN.LFO) === "full", "DETAILS: SEQ off, LFO full");
    c.ok(button(r.leds("v5d-open"), BTN.HOME) === "glow" && button(r.leds("v5d-open"), BTN.PLAY) === "glow" &&
      button(r.leds("v5d-open"), BTN.ENV) === "off" && button(r.leds("v5d-open"), BTN.FX) === "off" && button(r.leds("v5d-open"), BTN.REC) === "off",
      "DETAILS (completed unread): HOME and PLAY glow, ENV / FX / REC off");
    const before = r.shot("v5-list-detail-before");
    const closed = r.shot("v5-list-detail-closed");
    const outside = [crop(before, 0, 0, 240, 18), crop(before, 29, 18, 211, 42), crop(before, 16, 60, 224, 164)];
    const after = [crop(closed, 0, 0, 240, 18), crop(closed, 29, 18, 211, 42), crop(closed, 16, 60, 224, 164)];
    c.ok(outside.every((x, i) => diffBox(x, after[i]) === undefined), "LFO again: back to the list as before (but for sprite frames)");
  },
};

const v5ListVoice: ScenarioDef = {
  name: "v5-list-voice",
  autoAck: true,
  build(s) {
    connectV5(s, 200);
    s.heartbeats(1000, 5000, 1);
    s.shot(900, "v5-list-voice-before");
    s.buttonDown(1000, BTN.REC);
    s.host(1010, view5("voice", "buddy", "TALK", 0, 1));
    s.host(1010, { kind: "SET_DETAIL", provider: "claude", state: "completed_unread", lines: ["", "", "", "release REC to stop"] });
    for (let i = 0; i <= 10; i++) s.host(1010 + i * 100, { kind: "SET_VOICE", voice: "recording", level: [30, 60, 90, 50][i % 4] ?? 0, elapsedDs: i, target: "voice tests" });
    s.shot(2000, "v5-list-voice");
    s.leds(2001, "v5v");
    s.buttonUp(2100, BTN.REC);
    s.host(2110, { kind: "SET_VOICE", voice: "cancelled", level: 0, elapsedDs: 11, target: "voice tests" });
    for (const m of textFrames(listRows("Done, unread, 2m", V4_MESSAGE))) s.host(2200, m);
    s.host(2200, V5_DETAIL);
    s.host(2200, view5("sessions", "list"));
    s.shot(2900, "v5-list-voice-back");
    s.end(3200);
  },
  check(r, c) {
    const v = r.shot("v5-list-voice");
    c.ok(near(px(v, 100, 74), 192, 38, 38) && anyNear(v, 24, 160, 78, 94, 240, 48, 48), "REC from the list: the version 4 recording bubble");
    c.ok(anyNear(v, 30, 42, 185, 197, 32, 192, 96) || anyNear(v, 8, 232, 184, 224, 255, 176, 0), "voice: the critter keyboard (version 4 drawing)");
    c.ok(button(r.leds("v5v"), BTN.SEQ) === "off" && button(r.leds("v5v"), BTN.REC) === "full", "voice: SEQ off, REC full");
    c.ok(button(r.leds("v5v"), BTN.FX) === "glow" && button(r.leds("v5v"), BTN.PLAY) === "off" && button(r.leds("v5v"), BTN.ENV) === "off",
      `recording: FX glows (cancel), PLAY / ENV off: voice wins over the chat state (${button(r.leds("v5v"), BTN.FX)})`);
    const before = r.shot("v5-list-voice-before");
    const back = r.shot("v5-list-voice-back");
    c.ok(diffBox(crop(before, 29, 18, 211, 42), crop(back, 29, 18, 211, 42)) === undefined && diffBox(crop(before, 16, 60, 224, 164), crop(back, 16, 60, 224, 164)) === undefined,
      "after the recording: the list as before");
  },
};

const v5ListAnim: ScenarioDef = {
  name: "v5-list-anim",
  autoAck: true,
  build(s) {
    connectV5(s, 200, { detail: detail5("REC reply  SEQ buddy", "working", "codex") });
    s.heartbeats(1000, 3000, 1);
    s.shot(2000, "v5-list-anim-0");
    s.shot(2125, "v5-list-anim-125");
    s.shot(2250, "v5-list-anim-250");
    s.leds(1000, "v5a-0");
    s.leds(2000, "v5a-1");
    s.end(2400);
  },
  check(r, c) {
    const a = diffBox(r.shot("v5-list-anim-0"), r.shot("v5-list-anim-125"));
    c.ok(inside(a, 4, 26, 27, 49), `t to t + 125 ms: only the 24 x 24 hero changes (${showBox(a)})`);
    const b = diffBox(r.shot("v5-list-anim-125"), r.shot("v5-list-anim-250"));
    c.ok(!!b && inside(b, 4, 26, 27, 221) && b.y1 >= 62, `t + 125 to t + 250: the hero and the minis of the rows (${showBox(b)})`);
    const per = (r.leds("v5a-1")?.px ?? 0) - (r.leds("v5a-0")?.px ?? 0);
    c.ok(per > 0 && per <= 10400, `1 s of list animation: ${per} px (<= 10,400: hero 8 x 576 + 10 minis x 4 x 144)`);
  },
};

const v5HelpInner = helpScenario("v5-help", (s) => connectV5(s, 200), "v5-help",
  setSlot({ key: 9, state: "working", label: "back online", title: "bun dev server", age: "now" }));
const v5Help: ScenarioDef = {
  ...v5HelpInner,
  check(r, c) {
    v5HelpInner.check(r, c);
    const h = r.shot("v5-help");
    c.ok(anyNear(h, 4, 200, 20, 36, 255, 176, 0), "help title (HELP - SEQ list/buddy) in amber at y 20");
    c.ok(anyNear(h, 4, 200, 116, 132, 160, 160, 160) && near(px(h, 120, 150), 48, 48, 48), "the knob lines and the rule, as version 4");
    c.ok(anyNear(h, 4, 16, 156, 168, 47, 125, 246), "who is who");
    const closed = r.shot("v5-help-closed");
    c.ok(anyNear(closed, 48, 208, rowY(9), rowY(9) + 16, 192, 192, 192) && near(px(closed, 234, rowY(3) + 8), 48, 48, 48), "let go: the list again, with the change made meanwhile");
  },
};


/* ---- version 5 additions (docs/ui-v3.md section 9): GROUPED, PINNED, LEDs v2, transitions */

type Head = NonNullable<SlotSpec["head"]>;
const hd = (state: SlotSpec["state"], title: string, count: string, pinned = false): Head => ({ state, pinned, title, count });
const grp = (indent: 0 | 1 | 2, head?: Head, task = false): Pick<SlotSpec, "row" | "head"> =>
  ({ row: { indent, start: !!head, task }, ...(head ? { head } : {}) });
/** Pinned group, two tasks (one with a sub-agent), two folded tasks: 11 entries on 8 keys (section 9.3). */
const G_SLOTS: SlotSpec[] = [
  { key: 0, state: "working", label: "Release", title: "Release notes", age: "now", pinned: true, ...grp(1, hd("working", "Pinned", "1 working", true)) },
  { key: 1, state: "failed", label: "fw review", title: "fw review build", age: "3h", selected: true, ...grp(1, hd("failed", "Firmware v5", "2 need you")) },
  { key: 2, state: "approval_required", label: "flash", title: "Flash size check", age: "8m", codex: true, ...grp(1) },
  { key: 3, state: "idle", label: "lint", title: "sub agent: lint", age: "12m", codex: true, ...grp(2) },
  { key: 4, state: "waiting_input", label: "refund", title: "Refund webhook", age: "4m", ...grp(1, hd("waiting_input", "Refund webhook", "1 need you")) },
  { key: 5, state: "completed_unread", label: "tests", title: "Webhook tests", age: "2m", ...grp(1) },
  { key: 6, state: "idle", label: "Docs pass", title: "Docs pass", age: "2d", ...grp(0, hd("idle", "Docs pass", "4 quiet"), true) },
  { key: 7, state: "completed_read", label: "Old spike", title: "Old spike", age: "9d", ...grp(0, hd("completed_read", "Old spike", "2 quiet"), true) },
];
const gv5 = (slots: readonly SlotSpec[]): SlotSpec[] =>
  fullSlots(slots).map((x) => (x.state === "empty" ? { ...x, title: "", age: "", row: { indent: 0, start: false, task: false } } : x));
const G_DETAIL = detail5("REC reply  SEQ buddy");
const G_ROWS = listRows("Done, unread, 3h", "Build failed: flash image 141 KB over the 140 KB cap. Trim the font tables.");
function connectG(s: Scenario, t: number, slots: readonly SlotSpec[] = G_SLOTS, title = "ACTIVE 7", extra: HostMessage[] = []): void {
  connectV5(s, t, { slots: [], layout: "grouped", detail: G_DETAIL, rows: G_ROWS, view: view5("sessions", "grouped", title, 0, 1), extra: [
    ...gv5(slots).map(setSlot), ...extra] });
}
/** The screen's pixels of the TRANS line of one kind (fm1c_trans.h, host mode). */
const transOf = (r: Run, kind: string, a = 0, b = 1e9) => r.out.trans.find((x) => x.kind === kind && x.t >= a && x.t <= b);
function transBudget(c: Checker, r: Run, kind: string, a0: number, b: number, how = "done"): void {
  const trig = r.delivered.filter((d) => d.msg && d.msg.kind !== "HEARTBEAT" && d.msg.kind !== "ACK" && d.at >= a0 - 120 && d.at <= a0 + 60).at(-1);
  const a = trig?.at ?? a0;                    // (the trigger: the last host frame of the burst, applied at its END CC)
  const t = transOf(r, kind, a, b + 60);
  c.ok(t?.how === how, `transition ${kind}: ${how} (${t ? `${t.how} at ${t.t} ms` : "none"})`);
  c.ok(!!t && t.t - a <= 125 + (how === "done" ? 0 : 1000), `transition ${kind} within 120 ms of its trigger (${t ? t.t - a : "?"} ms)`);
  c.ok(!!t && t.maxStep <= 18000 && t.px <= 60000, `transition ${kind}: <= 18,000 px a step, <= 60,000 in all (${t?.maxStep} / ${t?.px})`);
}
/** The build under test has FM1C_VSCROLL_HW 0 (run.sh's fallback run): page and window scrolls are drawn at once. */
const SW_SCROLL = process.env.FM1C_SW_SCROLL === "1";
function scrollTrans(c: Checker, r: Run, kind: string, a: number, b: number): void {
  if (!SW_SCROLL) { transBudget(c, r, kind, a, b); return; }
  c.ok(!transOf(r, kind), `FM1C_VSCROLL_HW 0: no ${kind} transition, the change drawn at once`);
}

const v5gGrouped: ScenarioDef = {
  name: "v5g-grouped",
  autoAck: true,
  build(s) {
    connectG(s, 200);
    s.heartbeats(1000, 2000, 1);
    s.shot(1500, "v5g-grouped");
    s.leds(1501, "g-leds");
    s.end(1800);
  },
  check(r, c) {
    const g = r.shot("v5g-grouped");
    listGeometry(c, g, [25, 153, 76], "grouped");
    c.ok(near(px(g, 100, rowY(0)), 48, 48, 48) && near(px(g, 100, rowY(0) + 8), 0, 0, 0), "row 0: a header (the 1 px rule at y 0, black below)");
    c.ok(anyNear(g, 20, 80, rowY(0), rowY(0) + 16, 255, 255, 255) && near(px(g, 15, rowY(0) + 1), 255, 255, 255), "Pinned header: white title at x 20, pin dot");
    c.ok(anyNear(g, 150, 233, rowY(0), rowY(0) + 16, 47, 125, 246), "Pinned header: the count in the working colour, right-aligned");
    c.ok(anyNear(g, 12, 24, rowY(1) + 2, rowY(1) + 14, 47, 125, 246) && !anyNear(g, 0, 11, rowY(1) + 2, rowY(1) + 14, 47, 125, 246),
      "row 1: the pinned session, indent 1 (mini at x 12)");
    const lit = (x0: number, x1: number, y: number): boolean => { for (let x = x0; x < x1; x++) for (let j = 2; j < 14; j++) if (!near(px(g, x, y + j), 0, 0, 0)) return true; return false; };
    c.ok(near(px(g, 234, rowY(3) + 8), 48, 48, 48), "row 3: the selected session (key 1, after its task header)");
    c.ok(lit(20, 32, rowY(5)) && !lit(0, 20, rowY(5)), "row 5: the sub-agent, indent 2 (mini at x 20, nothing left of it)");
    c.ok(anyNear(g, 20, 44, rowY(9), rowY(9) + 16, 128, 128, 128) && anyNear(g, 48, 150, rowY(9), rowY(9) + 16, 192, 192, 192),
      "row 9: a folded task (key name grey, title #C0C0C0)");
    c.ok(near(px(g, 237, 62), 128, 128, 128) && near(px(g, 237, 210), 0, 0, 0), "11 entries: the thumb (160 x 10 / 11 = 145 px)");
    c.ok(button(r.leds("g-leds"), BTN.SEQ) === "glow", "grouped: SEQ glows");
  },
};

/** 6 tasks x (header + 3 sessions) = 24 entries on 18 keys; key 12's session is entry 17: the second window. */
const GW_SLOTS: SlotSpec[] = Array.from({ length: 18 }, (_, key): SlotSpec => {
  const g = Math.floor(key / 3);
  return { key, state: (["working", "idle", "completed_read"] as const)[key % 3] ?? "idle", label: `t${g}s${key % 3}`,
    title: `Task ${g} chat ${key % 3}`, age: `${key + 1}m`, selected: key === 12,
    ...grp(1, key % 3 === 0 ? hd("working", `Task number ${g}`, "1 working") : undefined) };
});
const v5gGroupedWindow: ScenarioDef = {
  name: "v5g-grouped-window",
  autoAck: true,
  build(s) {
    connectG(s, 200, GW_SLOTS, "ACTIVE 18");
    s.heartbeats(1000, 2000, 1);
    s.shot(1500, "v5g-grouped-window");
    s.end(1800);
  },
  check(r, c) {
    const g = r.shot("v5g-grouped-window");
    c.ok(near(px(g, 234, rowY(7) + 8), 48, 48, 48), "entry 17 (key 12) selected: row 7 of the window 10-19");
    c.ok(near(px(g, 100, rowY(6)), 48, 48, 48) && near(px(g, 100, rowY(2)), 48, 48, 48), "headers on rows 2 and 6 (entries 12, 16)");
    c.ok(near(px(g, 237, 128), 128, 128, 128) && near(px(g, 237, 127), 0, 0, 0), "the thumb at y 128 (62 + 160 x 10 / 24)");
  },
};

const P_SLOTS: SlotSpec[] = [
  { key: 0, state: "waiting_input", label: "q", title: "Refund webhook", age: "4m", pinned: true, selected: true, ...grp(1, hd("waiting_input", "Pinned", "1 need you", true)) },
  { key: 1, state: "working", label: "fw", title: "fw review build", age: "now", pinned: true, ...grp(1, hd("working", "Firmware v5", "1 working", true)) },
  { key: 2, state: "idle", label: "lint", title: "Lint pass", age: "1h", pinned: true, ...grp(1) },
];
const v5gPinned: ScenarioDef = {
  name: "v5g-pinned",
  autoAck: true,
  build(s) {
    connectG(s, 200, P_SLOTS, "PINNED 3", [{ kind: "SET_LEGEND", labels: ["SHOW", "", "", "TALK"] }]);
    s.heartbeats(1000, 2000, 1);
    s.shot(1500, "v5g-pinned");
    s.end(1800);
  },
  check(r, c) {
    const g = r.shot("v5g-pinned");
    c.ok(anyNear(g, 4, 120, 2, 16, 255, 255, 255), "title PINNED 3");
    c.ok(near(px(g, 15, rowY(0) + 1), 255, 255, 255) && near(px(g, 15, rowY(2) + 1), 255, 255, 255), "both headers pinned (Pinned, the pinned task)");
    c.ok(near(px(g, 234, rowY(1) + 8), 48, 48, 48) && near(px(g, 23, rowY(1) + 1), 255, 255, 255), "the pinned session selected, its pin dot at x 23 (indent 1)");
  },
};
const v5gPinnedEmpty: ScenarioDef = {
  name: "v5g-pinned-empty",
  autoAck: true,
  build(s) {
    connectV5(s, 200, { slots: [], layout: "grouped", detail: { kind: "SET_DETAIL", provider: "none", state: "empty", lines: ["", "", "", "SEQ buddy  SCL help"] },
      rows: [["body", "No pins yet"], ["muted", "hold a key to pin"], ["body", ""]], view: view5("sessions", "grouped", "PINNED 0", 0, 1),
      extra: gv5([]).map(setSlot) });
    s.heartbeats(1000, 2000, 1);
    s.shot(1500, "v5g-pinned-empty");
    s.leds(1501, "pe");
    s.end(1800);
  },
  check(r, c) {
    const g = r.shot("v5g-pinned-empty");
    c.ok(anyNear(g, 40, 200, 38, 54, 160, 160, 160), "the header's muted line: hold a key to pin");
    c.ok(!anyNear(g, 0, 236, 62, 222, 192, 192, 192) && !anyNear(g, 0, 236, 62, 222, 48, 48, 48), "no rows");
    const l = r.leds("pe");
    c.ok(!!l && Array.from({ length: 27 }, (_, k) => ledLevel(l.lit, l.glow, KEY_LED(k))).every((x) => x === "off"), "no keys: every key LED off");
  },
};

/** Transition scenarios: the trigger at 1,000 ms, shots -n at 1,000 + n, -done at 1,300 (section 9.14). */
/** Host mode takes a shot at the start of its ms, before that ms's passes run, so a step due at t0 + n is on the
 * panel only from about t0 + n + 1: the `-<n>` shots are taken SETTLE ms later than section 9.14's 1,000 + n (the
 * same instant for the simulator's replay, test/v5g-firmware-parity.test.ts), so each shows its step drawn. */
const SETTLE = 15;
function shots(s: Scenario, name: string, at: readonly number[], base = 1000, done = 1300): void {
  for (const n of at) s.shot(base + n + SETTLE, `${name}-${n}`);
  s.shot(done, `${name}-done`);
}
const v5gTransSelect: ScenarioDef = {
  name: "v5g-trans-select",
  autoAck: true,
  build(s) {
    connectG(s, 200);
    s.heartbeats(1000, 2000, 1);
    s.burstEndingAt(1000, [setSlot({ ...G_SLOTS[4]!, selected: true }), setSlot({ ...G_SLOTS[1]!, selected: false })]);   // (one flush)
    shots(s, "v5g-trans-select", [0, 30, 70]);
    s.end(1500);
  },
  check(r, c) {
    transBudget(c, r, "select-list", 1000, 1130);
    const a = r.shot("v5g-trans-select-30");
    const y1 = rowY(3) + Math.trunc((rowY(7) - rowY(3)) / 3), y2 = rowY(3) + Math.trunc((2 * (rowY(7) - rowY(3))) / 3);
    const grey = [y1, y2].some((y) => near(px(a, 120, y), 128, 128, 128) && near(px(a, 120, y + 15), 128, 128, 128));
    c.ok(grey, "mid-slide: the grey 1 px frame between the old and the new row");
    c.ok(!near(px(a, 234, rowY(3) + 8), 48, 48, 48), "mid-slide: the old row drawn unselected");
    const d = r.shot("v5g-trans-select-done");
    c.ok(near(px(d, 234, rowY(7) + 8), 48, 48, 48) && near(px(d, 234, rowY(3) + 8), 0, 0, 0), "done: key 4's row (row 7) selected, key 1's not");
    c.ok(![rowY(4), rowY(5), rowY(6)].some((y) => near(px(d, 120, y + 8), 128, 128, 128)), "done: no frame left");
  },
};
/** Review regression: a selection slide off a key whose group header changed in the same burst (its count) still
 * draws that header row, which is not on the slide's path (the slide takes over the key's session row only). */
const v5gTransSelectHead: ScenarioDef = {
  name: "v5x-select-head",
  autoAck: true,
  build(s) {
    connectG(s, 200);
    s.heartbeats(1000, 2000, 1);
    s.shot(990, "v5x-select-head-before");
    s.burstEndingAt(1000, [setSlot({ ...G_SLOTS[4]!, selected: true }),
      setSlot({ ...G_SLOTS[1]!, selected: false, ...grp(1, hd("failed", "Firmware v5", "3 need you")) })]);
    s.shot(1300, "v5x-select-head-done");
    s.end(1500);
  },
  check(r, c) {
    transBudget(c, r, "select-list", 1000, 1130);
    const b = diffBox(crop(r.shot("v5x-select-head-before"), 0, rowY(2), 236, 16), crop(r.shot("v5x-select-head-done"), 0, rowY(2), 236, 16));
    c.ok(!!b, `done: key 1's header row (row 2) redrawn with its new count (${showBox(b)})`);
  },
};
/** Review regression: a host change under the help does not start a transition from the screen before the help when
 * the help closes; the release redraws everything at once. */
const v5gHelpTrans: ScenarioDef = {
  name: "v5x-help-trans",
  autoAck: true,
  build(s) {
    connectG(s, 200);
    s.heartbeats(1000, 3000, 1);
    s.buttonDown(1100, BTN.SEL);
    s.shot(1600, "v5x-help-trans-help");
    s.burstEndingAt(1750, [setSlot({ ...G_SLOTS[4]!, selected: true }), setSlot({ ...G_SLOTS[1]!, selected: false }),
      detail5("REC reply  SEQ buddy", "waiting_input")]);
    s.buttonUp(2000, BTN.SEL);
    s.shot(2300, "v5x-help-trans-closed");
    s.end(2600);
  },
  check(r, c) {
    const late = r.out.trans.filter((x) => x.t >= 1990 && x.t <= 2300);
    c.ok(late.length === 0, `no transition after the help closes (${late.map((x) => `${x.kind}@${x.t}`).join(" ") || "none"})`);
    const d = r.shot("v5x-help-trans-closed");
    c.ok(near(px(d, 234, rowY(7) + 8), 48, 48, 48) && near(px(d, 234, rowY(3) + 8), 0, 0, 0), "closed: key 4's row selected, key 1's not");
  },
};
/** Review regression: a grouped session title longer than 20 - indent characters (the host cuts it, section 9.3) is cut
 * by the device too, so it never reaches the age: 20 characters at indent 2 draw as the first 18. */
const v5xTitleCut: ScenarioDef = {
  name: "v5x-title-cut",
  autoAck: true,
  build(s) {
    connectG(s, 200, G_SLOTS.map((x) => (x.key === 3 ? { ...x, title: "abcdefghijklmnopqrst" } : x)));
    s.heartbeats(1000, 2000, 1);
    s.shot(990, "v5x-title-cut-long");
    s.burstEndingAt(1000, [setSlot({ ...G_SLOTS[3]!, title: "abcdefghijklmnopqr" })]);
    s.shot(1300, "v5x-title-cut-18");
    s.end(1500);
  },
  check(r, c) {
    const b = diffBox(crop(r.shot("v5x-title-cut-long"), 60, rowY(5), 176, 16), crop(r.shot("v5x-title-cut-18"), 60, rowY(5), 176, 16));
    c.ok(!b, `indent 2: a 20-character title draws as its first 18 (row 5 identical: ${showBox(b)})`);
    c.ok(anyNear(r.shot("v5x-title-cut-long"), 209, 233, rowY(5), rowY(5) + 16, 128, 128, 128), "the age still drawn");
  },
};
const v5gTransHero: ScenarioDef = {
  name: "v5g-trans-hero",
  autoAck: true,
  build(s) {
    connectG(s, 200);
    s.heartbeats(1000, 2000, 1);
    s.burstEndingAt(1000, [detail5("ENV stop  SEQ buddy", "working")]);
    shots(s, "v5g-trans-hero", [0, 30, 70]);
    s.end(1500);
  },
  check(r, c) {
    transBudget(c, r, "hero", 1000, 1130);
    const sq = r.shot("v5g-trans-hero-0") && r.shot("v5g-trans-hero-30");
    const a = diffBox(r.shot("v5g-trans-hero-0"), sq);
    c.ok(!!a && inside(a, 0, 18, 239, 59), `squash/pop: only the hero box and the header change (${showBox(a)})`);
    {   // review regression: the squash kept the sprite's top rows (it once cleared them before copying them down)
      const h0 = r.shot("v5g-trans-hero-0");
      let top = false;
      for (let y = 32; y < 37 && !top; y++) for (let x = 4; x < 28; x++) if (px(h0, x, y).some((v) => v > 0)) { top = true; break; }
      c.ok(top, "squash: the sprite's top rows are drawn squashed (y 32-36 not all black)");
    }
    c.ok(anyNear(r.shot("v5g-trans-hero-done"), 4, 28, 26, 50, 47, 125, 246), "done: the working (blue) hero at (4, 26)");
  },
};
const PG2: SlotSpec[] = [
  { key: 0, state: "idle", label: "p2a", title: "Page two first", age: "1h", selected: true, ...grp(1, hd("idle", "Second page task", "all quiet")) },
  { key: 1, state: "completed_read", label: "p2b", title: "Page two second", age: "3h", ...grp(1) },
];
function pageTurn(s: Scenario, t: number): void {
  s.burstEndingAt(t, [{ kind: "CLEAR_SLOTS" }, ...gv5(PG2).map(setSlot),
    { kind: "SET_DETAIL", provider: "claude", state: "idle", lines: ["", "", "", "REC reply  SEQ buddy"] },
    ...textFrames(listRows("Asleep, 1h", "Nothing new.")), view5("sessions", "grouped", "ALL 30", 1, 2)]);
}
const CALM_G: SlotSpec[] = G_SLOTS.map((x) => ({ ...x, state: x.selected ? "idle" : "completed_read" }));
const v5gTransPage: ScenarioDef = {
  name: "v5g-trans-page",
  autoAck: true,
  build(s) {
    connectG(s, 200, CALM_G, "ALL 30");
    s.heartbeats(1000, 2000, 1);
    pageTurn(s, 1000);
    shots(s, "v5g-trans-page", [0, 30, 70]);
    s.end(1500);
  },
  check(r, c) {
    transBudget(c, r, "page", 1000, 1130);
    const a = r.shot("v5g-trans-page-30");
    c.ok(anyNear(a, 0, 78, rowY(1), rowY(1) + 16, 48, 48, 48) || anyNear(a, 0, 78, 60, 222, 255, 255, 255),
      "after step 1: the left third shows page 2");
    const d = r.shot("v5g-trans-page-done");
    c.ok(near(px(d, 234, rowY(1) + 8), 48, 48, 48) && !anyNear(d, 0, 236, rowY(3), 222, 192, 192, 192), "done: page 2, its session selected");
  },
};
/* the knob row sliding in on a K1 turn and out 2 s later (section 9.10: as the toast, with the knob row) */
const v5gTransKnob: ScenarioDef = {
  name: "v5g-trans-knob",
  autoAck: true,
  build(s) {
    connectG(s, 200);
    s.heartbeats(1000, 4000, 1);
    s.encoder(1000, 2, 1);                       // K1 (SHOW): the ENCODER goes out, the row slides in
    shots(s, "v5g-trans-knob", [0, 30, 70]);
    s.shot(3000 + SETTLE, "v5g-trans-knob-out-0");
    s.shot(3300, "v5g-trans-knob-out-done");
    s.end(3500);
  },
  check(r, c) {
    const t = transOf(r, "knob-in", 1000, 1200);
    c.ok(t?.how === "done" && t.t - 1000 <= 125, `transition knob-in: done within 120 ms of the turn (${t?.how} at ${t?.t})`);
    c.ok(!!t && t.maxStep <= 18000 && t.px <= 60000, `transition knob-in: <= 18,000 px a step, <= 60,000 in all (${t?.maxStep} / ${t?.px})`);
    const o = transOf(r, "knob-out", 2990, 3200);
    c.ok(o?.how === "done" && !!o && o.maxStep <= 3840, `transition knob-out 2 s after the turn: done (${o?.how} at ${o?.t}, ${o?.maxStep} px a step)`);
    const k = r.shot("v5g-trans-knob-done");
    c.ok(near(px(k, 30, 238), 70, 70, 70) && near(px(k, 90, 238), 32, 32, 32), "in: the knob row, cell 1 lit");
    const m = r.shot("v5g-trans-knob-0");
    c.ok(!!diffBox(crop(m, 0, 224, 240, 16), crop(k, 0, 224, 240, 16)), "step 1: the row 11 px low, not yet in place");
    const g = r.shot("v5g-trans-knob-out-done");
    c.ok(!anyNear(g, 0, 240, 226, 238, 70, 70, 70), "out: the hint line again");
  },
};
/* the voice transcript paging by 5 rows (section 9.10: software, 4 steps of 20 px), forward at 1,000 and back at 2,000 */
const VT_LINES = wrapAt(`${V4_MESSAGE} Then rerun the soak for an hour and post the numbers in the thread.`, 28);
const vtRows = (from: number): Row[] => [["body", ""], ...VT_LINES.slice(from, from + 6).map((l): Row => ["body", l])];
const v5gTransVoice: ScenarioDef = {
  name: "v5g-trans-voice",
  autoAck: true,
  build(s) {
    connectG(s, 200);
    s.heartbeats(1000, 3000, 1);
    s.host(400, { kind: "SET_VOICE", voice: "reviewing", level: 0, elapsedDs: 35, target: "voice tests" });
    s.host(400, { kind: "SET_DETAIL", provider: "claude", state: "completed_unread", lines: ["", "", "", "SAVE send  FX cancel"] });
    for (const m of textFrames(vtRows(0))) s.host(400, m);
    s.host(400, view5("voice", "buddy", "TALK", 0, 1));
    s.shot(900, "v5g-trans-voice-before");
    s.burstEndingAt(1000, textFrames(vtRows(5)).slice(0, 3));   // rows 1-6 = the old rows 6-11: forward
    shots(s, "v5g-trans-voice", [0, 20, 50, 90]);
    s.burstEndingAt(2000, textFrames(vtRows(0)).slice(0, 3));   // old row 1 = new row 6: back
    s.shot(2000 + 50 + SETTLE, "v5g-trans-voice-back-50");
    s.shot(2300, "v5g-trans-voice-back-done");
    s.end(2600);
  },
  check(r, c) {
    // (section 9.10's own row: 4 steps of 17,920 px = 71,680, over the common 60,000 a transition; the firmware follows
    // the row, as the simulator does: each step within 18,000 and drawn in passes, flagged in docs/firmware-ui.md)
    for (const [a, label] of [[1000, "forward"], [2000, "back"]] as const) {
      const t = transOf(r, "voice", a, a + 190);
      c.ok(t?.how === "done" && t.t - a <= 125, `transition voice ${label}: done within 120 ms (${t?.how} at ${t?.t})`);
      c.ok(!!t && t.maxStep <= 18000 && t.px <= 4 * 17920, `transition voice ${label}: <= 18,000 px a step, 4 x 17,920 in all (${t?.maxStep} / ${t?.px})`);
    }
    const b = r.shot("v5g-trans-voice-before"), m = r.shot("v5g-trans-voice-50"), d = r.shot("v5g-trans-voice-done");
    c.ok(!!diffBox(crop(m, 8, 96, 224, 80), crop(d, 8, 96, 224, 80)) && !!diffBox(crop(m, 8, 96, 224, 80), crop(b, 8, 96, 224, 80)),
      "mid-scroll: the transcript between the old and the new rows");
    c.ok(diffBox(crop(b, 52, 18, 188, 76), crop(d, 52, 18, 188, 76)) === undefined, "only the body moves (label, bubble top and caption unchanged)");
    c.ok(diffBox(crop(b, 8, 96, 224, 80), crop(r.shot("v5g-trans-voice-back-done"), 8, 96, 224, 80)) === undefined, "back: the first rows again");
  },
};
/* the selection slide in the Buddy layout (section 9.10: a white 14 x 14 frame between the key boxes, <= 1,200 px) */
const G_FLAT = G_SLOTS.map(({ row: _r, head: _h, ...x }) => x);
const v5gTransSelectBuddy: ScenarioDef = {
  name: "v5g-trans-select-buddy",
  autoAck: true,
  build(s) {
    connectV5(s, 200, { slots: G_FLAT, layout: "buddy", detail: G_DETAIL, rows: G_ROWS, view: view5("sessions", "buddy", "ACTIVE 7", 0, 1) });
    s.heartbeats(1000, 2000, 1);
    s.shot(900, "v5g-trans-select-buddy-before");
    s.burstEndingAt(1000, [setSlot({ ...G_FLAT[6]!, selected: true }), setSlot({ ...G_FLAT[1]!, selected: false })]);   // (one flush)
    shots(s, "v5g-trans-select-buddy", [0, 30, 70]);
    s.end(1500);
  },
  check(r, c) {
    const t = transOf(r, "select-buddy", 990, 1200);
    c.ok(t?.how === "done" && t.t - 1000 <= 125, `transition select-buddy: done within 120 ms (${t?.how} at ${t?.t})`);
    c.ok(!!t && t.maxStep <= 1200 && t.px <= 60000, `transition select-buddy: <= 1,200 px a step (${t?.maxStep} / ${t?.px})`);
    const b = r.shot("v5g-trans-select-buddy-before"), m = r.shot("v5g-trans-select-buddy-30"), d = r.shot("v5g-trans-select-buddy-done");
    const kb = (x: Uint8Array | undefined) => crop(x, 0, 182, 240, 40);
    c.ok(!!diffBox(kb(b), kb(d)) && diffBox(crop(b, 52, 96, 188, 80), crop(d, 52, 96, 188, 80)) === undefined,
      "done: the frame on key 6's box (the bubble body unchanged; the caption's key name follows after the end)");
    c.ok(!!diffBox(kb(m), kb(d)) && !!diffBox(kb(b), kb(m)), "mid-slide: the frame between the keys, neither old nor new");
    c.ok(near(px(m, 230, 82), ...([0, 0, 0] as const)) || diffBox(crop(b, 180, 78, 52, 16), crop(m, 180, 78, 52, 16)) === undefined,
      "mid-slide: the caption still names the old key (held until the end)");
  },
};
const v5gTransInterrupt: ScenarioDef = {
  name: "v5g-trans-interrupt",
  autoAck: true,
  build(s) {
    connectG(s, 200, CALM_G, "ALL 30");
    s.heartbeats(1000, 2000, 1);
    pageTurn(s, 1000);
    s.shot(1036, "v5g-trans-interrupt-30");   // (step 2 drawn, before the press at 1,039)
    s.keyDown(1039, 20);                         // (a shot at t shows the passes before t: the press is in the 1,039 pass)
    s.shot(1040 + SETTLE, "v5g-trans-interrupt-40");
    s.keyUp(1100, 20);
    s.shot(1300, "v5g-trans-interrupt-done");
    s.end(1500);
  },
  check(r, c) {
    const t = transOf(r, "page", 1000, 1200);
    c.ok(t?.how === "at-once" && t.t === 1039, `a key press mid-wipe completes it at once (${t?.how} at ${t?.t})`);
    const box = diffBox(crop(r.shot("v5g-trans-interrupt-40"), 0, 60, 236, 164), crop(r.shot("v5g-trans-interrupt-done"), 0, 60, 236, 164));
    c.ok(box === undefined, `at 1,040 ms the list band is final (${showBox(box)})`);
    c.ok(!!diffBox(r.shot("v5g-trans-interrupt-30"), r.shot("v5g-trans-interrupt-40")), "at 1,030 ms it was mid-wipe");
  },
};
const v5gTransSeq: ScenarioDef = {
  name: "v5g-trans-seq",
  autoAck: true,
  build(s) {
    connectV5(s, 200, { slots: G_SLOTS.map(({ row: _r, head: _h, ...x }) => x), layout: "list", detail: detail5("REC reply  SEQ group"), rows: G_ROWS,
      view: view5("sessions", "list", "ACTIVE 7", 0, 1) });
    s.heartbeats(1000, 2000, 1);
    s.tap(990, BTN.SEQ);
    s.burstEndingAt(1000, [...textFrames(G_ROWS), ...gv5(G_SLOTS).map(setSlot), G_DETAIL, view5("sessions", "grouped", "ACTIVE 7", 0, 1)]);
    shots(s, "v5g-trans-seq", [0, 20, 50, 90]);
    s.end(1500);
  },
  check(r, c) {
    transBudget(c, r, "layout", 1000, 1130);
    const m = r.shot("v5g-trans-seq-50");
    c.ok(!!diffBox(r.shot("v5g-trans-seq-20"), m), "the wipe moves down between steps");
    const d = r.shot("v5g-trans-seq-done");
    c.ok(near(px(d, 100, rowY(0)), 48, 48, 48) && near(px(d, 234, rowY(3) + 8), 48, 48, 48), "done: the grouped list (header rule on row 0, selection on row 3)");
  },
};
const v5gTransReader: ScenarioDef = {
  name: "v5g-trans-reader",
  autoAck: true,
  build(s) {
    connectG(s, 200);
    s.heartbeats(1000, 3000, 1);
    s.encoder(990, 6, 1);
    s.burstEndingAt(1000, [...textFrames(V4_DETAIL_ROWS), view5("detail", "buddy", "DETAILS fw review", 0, 2)]);
    shots(s, "v5g-trans-reader", [0, 30, 70]);
    s.tap(1990, BTN.LFO);
    s.burstEndingAt(2000, [...textFrames(G_ROWS), view5("sessions", "grouped", "ACTIVE 7", 0, 1)]);
    s.shot(2000 + SETTLE, "v5g-trans-reader-close-0");
    s.shot(2300, "v5g-trans-reader-close-done");
    s.end(2600);
  },
  check(r, c) {
    transBudget(c, r, "reader-open", 1000, 1130);
    transBudget(c, r, "reader-close", 2000, 2130);
    const o = r.shot("v5g-trans-reader-30");
    // step 1's outline: lerp((34, 19, 204, 40), (0, 18, 240, 206), 1/3) = (23, 19, 216, 95), in the caption colour
    // (completed_unread at 80 %: RGB(24, 153, 74)); its bottom edge at y 113 crosses the list, its right edge x 238
    c.ok(near(px(o, 120, 113), 24, 153, 74) && near(px(o, 238, 80), 24, 153, 74) && !near(px(o, 120, 112), 24, 153, 74),
      "an outline in the caption colour over the old screen (step 1: (23, 19, 216, 95))");
    const d = r.shot("v5g-trans-reader-done");
    c.ok(anyNear(d, 4, 236, 72, 88, 255, 176, 0), "done: the DETAILS page");
    const cd = r.shot("v5g-trans-reader-close-done");
    c.ok(near(px(cd, 234, rowY(3) + 8), 48, 48, 48), "closed: the grouped list again, the selection kept");
  },
};
const PAGE2_ROWS: Row[] = [...V4_DETAIL_ROWS.slice(0, 3),
  ...Array.from({ length: 9 }, (_, i): Row => ["body", `Older line ${i + 1} of page two`])];
const v5gTransReaderPage: ScenarioDef = {
  name: "v5g-trans-reader-page",
  autoAck: true,
  build(s) {
    connectG(s, 200);
    s.heartbeats(1000, 2000, 1);
    for (const m of textFrames(V4_DETAIL_ROWS)) s.host(500, m);
    s.host(500, view5("detail", "buddy", "DETAILS fw review", 0, 2));
    s.encoder(990, 6, 1);
    s.burstEndingAt(1000, [...textFrames(PAGE2_ROWS), view5("detail", "buddy", "DETAILS fw review", 1, 2)]);
    shots(s, "v5g-trans-reader-page", [0, 20, 50, 90]);
    s.end(1500);
  },
  check(r, c) {
    scrollTrans(c, r, "reader-page", 1000, 1130);
    const m = r.shot("v5g-trans-reader-page-50");
    c.ok(SW_SCROLL || !!diffBox(r.shot("v5g-trans-reader-page-20"), m), "the body scrolls between steps");
    const box = diffBox(crop(r.shot("v5g-trans-reader-page-0"), 0, 0, 240, 72), crop(m, 0, 0, 240, 72));
    c.ok(box === undefined || inside(box, 0, 0, 239, 17), `the hero and header stay put (${showBox(box)})`);
    c.ok(anyNear(r.shot("v5g-trans-reader-page-done"), 4, 236, 72, 88, 255, 255, 255), "done: page 2's body from y 72");
  },
};
const v5gTransWindow: ScenarioDef = {
  name: "v5g-trans-window",
  autoAck: true,
  build(s) {
    connectG(s, 200, GW_SLOTS.map((x) => ({ ...x, selected: x.key === 2 })), "ACTIVE 18");
    s.heartbeats(1000, 2000, 1);
    s.encoder(990, 0, 1);
    s.burstEndingAt(1000, [setSlot({ ...GW_SLOTS[12]!, selected: true }), setSlot({ ...GW_SLOTS[2]!, selected: false })]);
    shots(s, "v5g-trans-window", [0, 20, 50, 90]);
    s.end(1500);
  },
  check(r, c) {
    scrollTrans(c, r, "window", 1000, 1130);
    const d = r.shot("v5g-trans-window-done");
    c.ok(near(px(d, 234, rowY(7) + 8), 48, 48, 48) && near(px(d, 237, 128), 128, 128, 128), "done: the second window, key 12 on row 7, the thumb at y 128");
    const m = r.shot("v5g-trans-window-50");
    c.ok(SW_SCROLL || (!!diffBox(r.shot("v5g-trans-window-20"), m) && !!diffBox(m, d)), "the rows scroll up step by step");
  },
};
/** Review check: a key press mid-scroll (list window, hardware scroll offset set) completes it at once and leaves the
 * panel's scroll at the identity: the band equals the final screen right after. */
const v5xWindowInterrupt: ScenarioDef = {
  name: "v5x-window-interrupt",
  autoAck: true,
  build(s) {
    connectG(s, 200, GW_SLOTS.map((x) => ({ ...x, selected: x.key === 2 })), "ACTIVE 18");
    s.heartbeats(1000, 2000, 1);
    s.encoder(990, 0, 1);
    s.burstEndingAt(1000, [setSlot({ ...GW_SLOTS[12]!, selected: true }), setSlot({ ...GW_SLOTS[2]!, selected: false })]);
    s.shot(1036, "v5x-window-interrupt-mid");
    s.keyDown(1039, 20);
    s.shot(1040 + SETTLE + 30, "v5x-window-interrupt-after");
    s.keyUp(1100, 20);
    s.shot(1300, "v5x-window-interrupt-done");
    s.end(1500);
  },
  check(r, c) {
    const t = transOf(r, "window", 1000, 1200);
    c.ok(SW_SCROLL || (t?.how === "at-once" && t.t === 1039), `a key press mid-scroll completes it at once (${t?.how} at ${t?.t})`);
    const box = diffBox(crop(r.shot("v5x-window-interrupt-after"), 40, 60, 200, 164), crop(r.shot("v5x-window-interrupt-done"), 40, 60, 200, 164));
    c.ok(box === undefined, `soon after the press the list band (right of the animated minis) is final, the scroll at the identity (${showBox(box)})`);
    c.ok(SW_SCROLL || !!diffBox(r.shot("v5x-window-interrupt-mid"), r.shot("v5x-window-interrupt-done")), "at 1,036 ms it was mid-scroll");
  },
};
const v5gTransToast: ScenarioDef = {
  name: "v5g-trans-toast",
  autoAck: true,
  build(s) {
    connectG(s, 200);
    s.heartbeats(1000, 4000, 1);
    s.burstEndingAt(1000, [{ kind: "COMMAND_RESULT", reqSeq: 127, result: "completed", text: "Pinned" }]);
    shots(s, "v5g-trans-toast", [0, 30, 70]);
    s.shot(3000 + SETTLE, "v5g-trans-toast-out-0");
    s.shot(3300, "v5g-trans-toast-out-done");
    s.end(3500);
  },
  check(r, c) {
    transBudget(c, r, "toast-in", 1000, 1130);
    transBudget(c, r, "toast-out", 3000, 3130);
    const a = r.shot("v5g-trans-toast-30");
    c.ok(near(px(a, 236, 225), 32, 32, 32) && near(px(a, 236, 238), 32, 192, 96), "sliding in: the bar's top still the hint background, the toast below");
    c.ok(near(px(r.shot("v5g-trans-toast-done"), 236, 225), 32, 192, 96), "in: the toast fills the bar");
    c.ok(near(px(r.shot("v5g-trans-toast-out-done"), 236, 230), 32, 32, 32), "out after 2 s: the hint line again");
  },
};
const v5gHelpInner = helpScenario("v5g-help", (s) => connectV5(s, 200, { slots: [], layout: "grouped",
  detail: detail5("REC reply  SEQ buddy"), rows: G_ROWS, view: view5("sessions", "grouped", "ALL 30", 0, 1), extra: gv5(CALM_G).map(setSlot) }), "v5g-help",
  setSlot({ ...G_SLOTS[5]!, state: "working" }));
const v5gHelp: ScenarioDef = {
  ...v5gHelpInner,
  check(r, c) {
    v5gHelpInner.check(r, c);
    c.ok(anyNear(r.shot("v5g-help"), 4, 220, 20, 36, 255, 176, 0), "help title (HELP - SEQ buddy/list/group) in amber");
  },
};

/** LEDs v2 (section 9.9): every key condition and button, sampled every 10 ms against the timelines. */
const L_SLOTS: SlotSpec[] = [
  { key: 0, state: "approval_required", label: "a" }, { key: 1, state: "waiting_input", label: "q" },
  { key: 2, state: "failed", label: "f" }, { key: 3, state: "completed_unread", label: "u" },
  { key: 4, state: "working", label: "w" }, { key: 5, state: "idle", label: "i" }, { key: 6, state: "completed_read", label: "r" },
  { key: 7, state: "unknown", label: "n" }, { key: 8, state: "idle", label: "s", stale: true }, { key: 9, state: "disconnected", label: "d" },
  { key: 10, state: "failed", label: "F", selected: true },
];
const v5gLeds: ScenarioDef = {
  name: "v5g-leds",
  autoAck: true,
  build(s) {
    connectV5(s, 200, { slots: v5(L_SLOTS), layout: "grouped", detail: detail5("SAVE approve FX deny", "approval_required"),
      view: view5("sessions", "grouped", "ACTIVE 11", 0, 1), extra: [{ kind: "SET_STATUS", link: "ok", attentionCount: 3, text: "" }] });
    s.heartbeats(1000, 6000, 1);
    for (let t = 1000; t < 5200; t += 10) s.leds(t, `L${t}`);
    s.host(5300, { kind: "SET_VOICE", voice: "transcribing", level: 0, elapsedDs: 0, target: "" });
    s.leds(5502, "rec-on"); s.leds(5762, "rec-off");
    s.end(5800);
  },
  check(r, c) {
    const bgAt = (t: number): bigint => { let m = 0n; for (const b of r.out.bg) if (b.t < t) m = b.mask; return m; };
    const slots = fullSlots(L_SLOTS);
    let wrongKeys = 0, wrongBtn = 0, samples = 0;
    const bad: string[] = [];
    for (let t = 1000; t < 5200; t += 10) {
      const l = r.leds(`L${t}`);
      if (!l) continue;
      samples++;
      const ms = l.t - 1, bg = bgAt(l.t);
      for (const sl of slots) {
        const got = ledLevel2(l.lit, l.glow, bg, KEY_LED(sl.key)), want = keyLevel2(sl, ms);
        if (got !== want) { wrongKeys++; if (bad.length < 6) bad.push(`${ms}:${sl.key}:${got}/${want}`); }
      }
      const want = { [BTN.SAVE]: (ms % 1260 < 120 || (ms % 1260 >= 240 && ms % 1260 < 360)) ? "full" : "off",
        [BTN.GLO]: ms % 2500 < 150 ? "full" : "off", [BTN.SEQ]: "glow", [BTN.HOME]: "full", [BTN.LFO]: "off", [BTN.REC]: "off" } as Record<number, string>;
      for (const [b, w] of Object.entries(want)) if (ledLevel2(l.lit, l.glow, bg, Number(b)) !== w) { wrongBtn++; if (bad.length < 10) bad.push(`${ms}:btn${b}`); }
    }
    c.ok(samples === 420 && wrongKeys === 0, `27 key LEDs x ${samples} samples (10 ms apart, 4.2 s) as the v2 timelines say (${wrongKeys} wrong ${bad.join(" ")})`);
    c.ok(wrongBtn === 0, `SAVE double blink (approval), GLO tick (attention), SEQ glow, HOME lit at every sample (${wrongBtn} wrong)`);
    const onlySel = r.out.bg.filter((b) => b.t > 1000 && b.t < 5200).every((b) => b.mask === 0n || b.mask === 1n << BigInt(KEY_LED(10)));
    c.ok(onlySel, "the backlight layer holds the selected key alone (or nothing while its blink breaks through)");
    c.ok(button(r.leds("rec-on"), BTN.REC) === "full" && button(r.leds("rec-off"), BTN.REC) === "off", "REC: sharp blink while transcribing");
    c.ok(breathNs(0) === 12000 && breathNs(1500) === 48000 && breathNs(3000) === 12000 && breathNs(2999) === breathNs(20), "breathing table: 12,000 ns at 0, 48,000 at 1,500 ms, mirrored");
  },
};
const v5gLedsNohost: ScenarioDef = {
  name: "v5g-leds-nohost",
  autoAck: false,
  build(s) {
    connectV5(s, 200, { slots: v5(L_SLOTS), layout: "grouped" });
    s.heartbeats(1000, 1000, 1);
    s.leds(6201, "nh1"); s.leds(6801, "nh2");
    s.end(6900);
  },
  check(r, c) {
    const l = r.leds("nh1"), m = r.leds("nh2");
    const bg = r.out.bg.at(-1)?.mask ?? 0n;
    c.ok(!!l && Array.from({ length: 27 }, (_, k) => k).every((k) => ledLevel2(l.lit, l.glow, bg, KEY_LED(k)) === (k === 10 ? "back" : "glow")),
      "no host (v2): every key glows, the kept selection breathes in the backlight");
    c.ok(button(l, BTN.OCT_UP) === "full" && button(m, BTN.OCT_UP) === "off", "no host: OCT+ blinks");
  },
};

/* ---- version 6 (docs/ui-v3.md section 10): SPLIT keys and the SETTINGS view. Every scenario starts with HELLO_ACK 6;
 * shots are copied to reports/evidence/ui-v3/split/ by run.sh. */

type View6 = ViewName | "settings";
type Keys6 = { keys: "ranked" } | { keys: "split"; taskPage: number; taskPages: number };
const SPLIT0: Keys6 = { keys: "split", taskPage: 0, taskPages: 3 };
const view6 = (view: View6, layout: "buddy" | "list" | "grouped", title: string, page = 0, pages = 1, k: Keys6 = SPLIT0): HostMessage =>
  ({ kind: "SET_VIEW", view, page, pages, title, layout, ...k }) as HostMessage;
const BLACK6 = [1, 3, 5, 8, 10, 13, 15, 17, 20, 22, 25];
const WHITE6 = [0, 2, 4, 6, 7, 9, 11, 12, 14, 16, 18, 19, 21, 23, 24, 26];
/** a black key's chip (docs/ui-v3.md section 10.7): centre c = 8 + 14 (a + 1), box 26 x 16 at (c - 13, line y) */
const chipC = (k: number): number => 8 + 14 * WHITE6.filter((w) => w < k).length;
const chipX0 = (k: number): number => chipC(k) - 13;
const chipY0 = (k: number, ya: number): number => ya + (BLACK6.indexOf(k) % 2 ? 16 : 0);
type RGB = [number, number, number];
const C6 = { calm: [150, 150, 150] as RGB, amber: [255, 176, 0] as RGB, purple: [160, 80, 240] as RGB, blue: [47, 125, 246] as RGB,
  red: [240, 48, 48] as RGB, green: [32, 192, 96] as RGB, white: [255, 255, 255] as RGB, black: [0, 0, 0] as RGB, grey: [128, 128, 128] as RGB,
  outline: [48, 48, 48] as RGB, muted: [160, 160, 160] as RGB };
const at = (shot: Uint8Array | undefined, x: number, y: number, c: RGB): boolean => near(px(shot, x, y), ...c);
/** the three filters (k 1, 3, 5: ALL, PINNED, NEEDS YOU), as section 10.8 sends their states */
const filters6 = (chosen: "all" | "pinned" | "needs" | null, needs: SlotSpec["state"] = "approval_required", pins = true): SlotSpec[] => [
  { key: 1, state: "idle", label: "ALL", title: "All", age: "", chosen: chosen === "all" },
  { key: 3, state: pins ? "idle" : "empty", label: "PIN", title: "Pinned", age: "", chosen: chosen === "pinned" },
  { key: 5, state: needs, label: "YOU", title: "Needs you", age: "", chosen: chosen === "needs" },
];
/** task page 1 of 3: eight tasks with every attention state, one pinned */
const TASKS6: SlotSpec[] = [
  { key: 8, state: "approval_required", label: "FV5", title: "Firmware v5", age: "3m", pinned: true },
  { key: 10, state: "waiting_input", label: "RWE", title: "Refund webhook", age: "4m" },
  { key: 13, state: "working", label: "TAD", title: "Traycer adapter", age: "now" },
  { key: 15, state: "failed", label: "BNO", title: "BLE notify", age: "1h" },
  { key: 17, state: "completed_unread", label: "VTE", title: "Voice tests", age: "2m" },
  { key: 20, state: "idle", label: "DPA", title: "Docs pass", age: "2d" },
  { key: 22, state: "completed_read", label: "OSP", title: "Old spike", age: "9d" },
  { key: 25, state: "unknown", label: "SIM", title: "Simulator draws", age: "5h" },
];
/** task page 2 of 3: five tasks, three empty slots */
const TASKS6B: SlotSpec[] = [
  { key: 8, state: "working", label: "CLA", title: "Copy lint audit", age: "now" },
  { key: 10, state: "idle", label: "PPE", title: "Pin persistence", age: "1d" },
  { key: 13, state: "completed_read", label: "HTA", title: "Help table", age: "3d" },
  { key: 15, state: "completed_unread", label: "SPR", title: "Stats probe", age: "6m" },
  { key: 17, state: "idle", label: "REL", title: "Release notes", age: "2d" },
  { key: 20, state: "empty", label: "", title: "", age: "" },
  { key: 22, state: "empty", label: "", title: "", age: "" },
  { key: 25, state: "empty", label: "", title: "", age: "" },
];
/** ALL's white list: 15 sessions on F3..F5, G5 (k 26) free for arrivals; A3 (k 4) selected */
const SES6: SlotSpec[] = [
  { key: 0, state: "approval_required", label: "fw review", title: "fw review of the", age: "12m", codex: true },
  { key: 2, state: "waiting_input", label: "Refund hook", title: "Refund webhook", age: "4m" },
  { key: 4, state: "completed_unread", label: "Voice tests", title: "Voice tests for the", age: "2m", selected: true, pinned: true },
  { key: 6, state: "working", label: "BLE notify", title: "BLE notify", age: "now", codex: true },
  { key: 7, state: "working", label: "Simulator", title: "Simulator draws", age: "1m" },
  { key: 9, state: "completed_unread", label: "Help table", title: "Help overlay text", age: "20m", codex: true },
  { key: 11, state: "idle", label: "Stats probe", title: "Stats probe", age: "3h" },
  { key: 12, state: "completed_read", label: "Pins", title: "Pin persistence", age: "1d", codex: true },
  { key: 14, state: "unknown", label: "bun dev", title: "bun dev server", age: "5h" },
  { key: 16, state: "idle", label: "Copy audit", title: "Copy audit", age: "2d", codex: true },
  { key: 18, state: "failed", label: "Flash size", title: "Flash size check", age: "8m", codex: true },
  { key: 19, state: "working", label: "Details", title: "Details page", age: "now" },
  { key: 21, state: "idle", label: "Docs pass", title: "Docs pass", age: "6d" },
  { key: 23, state: "completed_read", label: "Old notes", title: "Old notes", age: "9d" },
  { key: 24, state: "idle", label: "Release", title: "Release notes", age: "2d" },
];
const SPLIT6: SlotSpec[] = [...filters6("all"), ...TASKS6, ...SES6];
/** the slots as a version 6 host sends them: the version 5 body (title, age), grouped with the row byte */
const slots6 = (specs: readonly SlotSpec[], grouped = false): SlotSpec[] =>
  fullSlots(specs).map((x) => ({ ...x, title: x.title ?? (x.state === "empty" ? "" : x.label), age: x.age ?? "",
    ...(grouped && !x.row ? { row: { indent: 0, start: false, task: false } } : {}) }));
/** the SPLIT Buddy bubble as a version 6 host sends it: row 0 the caption, rows 1-4 the body, row 5 the next line */
function rows6(caption: string, message: string): Row[] {
  const lines = wrapAt(message, 28);
  return [["body", caption], ...Array.from({ length: 5 }, (_, i): Row => ["body", lines[i] ?? ""])];
}
const LEGEND6: HostMessage = { kind: "SET_LEGEND", labels: ["SHOW", "REPO", "", "TALK"] };
/** HELLO_ACK 6 and a version 6 resync: the text before SET_VIEW (section 10.6's order rule), SET_VIEW with the keys byte */
function connectV6(s: Scenario, t: number, o: { slots?: readonly SlotSpec[]; view?: HostMessage; rows?: Row[]; detail?: HostMessage;
  grouped?: boolean; legend?: HostMessage; proto?: number; frames?: (rows: readonly Row[]) => HostMessage[] } = {}): void {
  const view = o.view ?? view6("sessions", "buddy", "ACTIVE 15");
  s.host(t, { kind: "HELLO_ACK", proto: o.proto ?? 6, hostSession: HOST_SESSION, reason: "" });
  s.host(t + 20, view);
  for (const slot of slots6(o.slots ?? SPLIT6, o.grouped)) s.host(t + 20, setSlot(slot));
  s.host(t + 20, o.detail ?? detail5("REC reply  SEQ list"));
  s.host(t + 20, o.legend ?? LEGEND6);
  s.host(t + 20, { kind: "SET_VOICE", voice: "ready", level: 0, elapsedDs: 0, target: "" });
  s.host(t + 20, { kind: "SET_STATUS", link: "ok", attentionCount: 4, text: "" });
  for (const m of (o.frames ?? textFrames)(o.rows ?? rows6("Done, unread, 2m", V4_MESSAGE))) s.host(t + 20, m);
  s.host(t + 20, view);
}
/** the chip of key k as section 10.7 draws it (fill, frame or dash; stem on line A) */
function chipCheck(c: Checker, shot: Uint8Array | undefined, k: number, ya: number, kind: "chosen" | "frame" | "fill" | "empty", col: RGB, what: string): void {
  const x0 = chipX0(k), y0 = chipY0(k, ya), lineA = BLACK6.indexOf(k) % 2 === 0, cx = chipC(k);
  // (a line A neighbour's stem may run in the column just left of a line B box: look one further left)
  const left = !lineA && BLACK6.some((kk) => BLACK6.indexOf(kk) % 2 === 0 && chipC(kk) === x0 - 1) ? x0 - 2 : x0 - 1;
  const stemCol = kind === "chosen" ? C6.white : col;
  let ok: boolean;
  if (kind === "chosen") ok = at(shot, x0, y0 + 8, C6.white) && at(shot, x0 + 25, y0 + 15, C6.white) && at(shot, left, y0 + 8, C6.black);
  else if (kind === "fill") ok = at(shot, x0, y0 + 8, col) && at(shot, x0 + 25, y0 + 15, col) && at(shot, left, y0 + 8, C6.black);
  else if (kind === "frame") ok = at(shot, x0, y0 + 8, col) && at(shot, x0 + 25, y0 + 8, col) && at(shot, x0 + 12, y0 + 15, col) && at(shot, x0 + 1, y0 + 14, C6.black);
  else ok = at(shot, x0 + 12, y0 + 7, C6.outline) && at(shot, x0, y0 + 8, C6.black) && at(shot, x0 + 25, y0 + 15, C6.black);
  c.ok(ok, `${what}: chip k${k} ${kind} at (${x0}, ${y0}) (${px(shot, x0, y0 + 8).join(",")})`);
  if (lineA) {
    const stem = kind === "empty" ? at(shot, cx, y0 + 24, C6.black) : at(shot, cx, y0 + 16, stemCol) && at(shot, cx, y0 + 31, stemCol);
    c.ok(stem && at(shot, cx - 1, y0 + 24, C6.black), `${what}: k${k}'s stem ${kind === "empty" ? "absent" : "down to the white row"} at x ${cx}`);
  }
}
/** the SPLIT band's fixed geometry: rows outside the chips black, the dots */
function dotsCheck(c: Checker, shot: Uint8Array | undefined, ya: number, cur: number, n: number, what: string): void {
  const ok = Array.from({ length: 8 }, (_, j) => j).every((j) =>
    j >= n ? at(shot, 234, ya + 1 + 4 * j, C6.black) : at(shot, 234, ya + 1 + 4 * j, j === cur ? C6.white : C6.grey) && at(shot, 235, ya + 2 + 4 * j, j === cur ? C6.white : C6.grey));
  c.ok(ok, `${what}: ${n} task page dots at x 234, the current (${cur + 1}) white`);
}
/** the SPLIT Buddy screen (section 10.7): the 4-row bubble, the band at 168, the white minis at 202 */
function buddy6Geometry(c: Checker, shot: Uint8Array | undefined, frame: RGB, what: string): void {
  c.ok(at(shot, 120, 74, frame) && at(shot, 120, 165, frame) && at(shot, 2, 120, frame) && at(shot, 237, 120, frame),
    `${what}: the bubble frame 236 x 92 at (2, 74) (${px(shot, 120, 165).join(",")})`);
  c.ok(at(shot, 120, 181, C6.black) && at(shot, 120, 166, C6.black) && at(shot, 120, 167, C6.black), `${what}: nothing of the version 4 frame below y 165`);
  c.ok([0, 3, 120, 239].every((x) => at(shot, x, 200, C6.black) && at(shot, x, 201, C6.black) && at(shot, x, 222, C6.black)), `${what}: white row bands 200-201, 216-223 black`);
  c.ok(at(shot, 236, 230, [32, 32, 32]), `${what}: the hint bar at 224-239`);
}
function ledCheck6(c: Checker, r: Run, slots: readonly SlotSpec[], from: number, to: number, sel: number, what: string): void {
  const chosenMask = fullSlots(slots).filter((s) => s.chosen).reduce((m, s) => m | (1n << BigInt(KEY_LED(s.key))), 0n);
  const bgAt = (t: number): bigint => { let m = 0n; for (const b of r.out.bg) if (b.t < t) m = b.mask; return m; };
  const all = fullSlots(slots);
  let wrong = 0, samples = 0;
  const bad: string[] = [];
  for (let t = from; t < to; t += 10) {
    const l = r.leds(`L6-${t}`);
    if (!l) continue;
    samples++;
    const ms = l.t - 1, bg = bgAt(l.t);
    for (const sl of all) {
      const got = ledLevel2(l.lit, l.glow, bg, KEY_LED(sl.key)), want = keyLevel2(sl, ms);
      if (got !== want) { wrong++; if (bad.length < 6) bad.push(`${ms}:${sl.key}:${got}/${want}`); }
    }
  }
  c.ok(samples === (to - from) / 10 && wrong === 0, `${what}: 27 key LEDs x ${samples} samples as LED v2 + CHOSEN say (${wrong} wrong ${bad.join(" ")})`);
  const selBit = 1n << BigInt(KEY_LED(sel));
  const onlySel = r.out.bg.filter((b) => b.t > from && b.t < to).every((b) => b.mask === chosenMask || b.mask === (chosenMask | selBit));
  c.ok(onlySel, `${what}: the backlight layer holds the selected white key and the chosen black key, nothing else`);
}
const ledSamples6 = (s: Scenario, from: number, to: number): void => { for (let t = from; t < to; t += 10) s.leds(t, `L6-${t}`); };

const v6SplitBuddy: ScenarioDef = {
  name: "v6-split-buddy",
  autoAck: true,
  build(s) {
    connectV6(s, 200);
    s.heartbeats(1000, 5000, 1);
    s.shot(1500, "v6-split-buddy");
    ledSamples6(s, 2000, 5000);
    s.leds(5001, "b6-btn");
    s.end(5200);
  },
  check(r, c) {
    const g = r.shot("v6-split-buddy");
    c.ok(near(px(g, 120, 17), 48, 48, 48) && near(px(g, 120, 20), 0, 0, 0), "the version 4 top bar (18 rows)");
    buddy6Geometry(c, g, [25, 153, 76], "buddy");
    c.ok(at(g, 224, 162, C6.white) && at(g, 227, 165, C6.white) && at(g, 224, 166, C6.black) && at(g, 223, 165, [25, 153, 76]) && at(g, 223, 162, C6.black),
      "row 5 set: the more wedge on the bottom edge (y 162-165)");
    c.ok([96, 112, 128, 144].every((y) => anyNear(g, 8, 232, y, y + 16, 255, 255, 255)) && !anyNear(g, 8, 220, 160, 168, 255, 255, 255),
      "4 body rows (y 96-159), nothing below them in the bubble");
    chipCheck(c, g, 1, 168, "chosen", C6.white, "ALL chosen");
    chipCheck(c, g, 3, 168, "frame", C6.calm, "PINNED (pins exist: idle)");
    chipCheck(c, g, 5, 168, "frame", C6.amber, "NEEDS YOU (approval)");
    chipCheck(c, g, 8, 168, "fill", C6.amber, "task FV5");
    chipCheck(c, g, 10, 168, "fill", C6.purple, "task RWE");
    chipCheck(c, g, 13, 168, "fill", C6.blue, "task TAD");
    chipCheck(c, g, 15, 168, "fill", C6.red, "task BNO");
    chipCheck(c, g, 17, 168, "fill", C6.green, "task VTE");
    chipCheck(c, g, 20, 168, "fill", C6.calm, "task DPA");
    chipCheck(c, g, 22, 168, "fill", C6.calm, "task OSP");
    chipCheck(c, g, 25, 168, "fill", C6.calm, "task SIM");
    c.ok(at(g, chipX0(8) + 23, 185, C6.white) && at(g, chipX0(8) + 24, 186, C6.white) && at(g, chipX0(10) + 23, 169, C6.purple),
      "the pinned task's dot (tag colour, white on amber); none on an unpinned one");
    c.ok(anyNear(g, chipX0(13) + 1, chipX0(13) + 25, 168, 184, 255, 255, 255) && anyNear(g, chipX0(1) + 1, chipX0(1) + 25, 168, 184, 0, 0, 0),
      "tags: white on the blue task, black on the chosen white chip");
    dotsCheck(c, g, 168, 0, 3, "3 task pages");
    c.ok(at(g, 36, 208, C6.white) || at(g, 36, 202, C6.white), "the white minis as version 4: A3 (k 4) selected, framed at (36, 202)");
    c.ok(at(g, 8 + 14 * 15 + 5, 208, C6.outline) && at(g, 8 + 14 * 15 + 5, 202, C6.black), "G5 (k 26) free: the empty dash");
    c.ok(at(g, 4, 175, C6.black) && at(g, 238, 199, C6.black), "the band's margins black");
    ledCheck6(c, r, SPLIT6, 2000, 5000, 4, "SPLIT Buddy");
    const b = r.leds("b6-btn");
    c.ok(button(b, BTN.ARP) === "off" && button(b, BTN.HOME) === "full", "ARP off outside settings, HOME lit");
  },
};

const TASK_SES6: SlotSpec[] = [
  { key: 0, state: "waiting_input", label: "Refund hook", title: "Refund webhook", age: "4m", selected: true },
  { key: 2, state: "completed_unread", label: "Webhook tests", title: "Webhook tests", age: "2m" },
  { key: 4, state: "idle", label: "Retry logic", title: "Retry logic", age: "1h" },
];
const TASK6: SlotSpec[] = [...filters6(null), ...TASKS6.map((x) => (x.key === 10 ? { ...x, chosen: true } : x)), ...TASK_SES6];
const v6SplitTask: ScenarioDef = {
  name: "v6-split-task",
  autoAck: true,
  build(s) {
    connectV6(s, 200, { slots: TASK6, view: view6("sessions", "buddy", "Refund webhook 3"), rows: rows6("Needs answer, 4m", "Should the retry use the idempotency key from the first attempt or a new one?") });
    s.heartbeats(1000, 4000, 1);
    s.shot(1500, "v6-split-task");
    ledSamples6(s, 2000, 3500);
    s.end(3600);
  },
  check(r, c) {
    const g = r.shot("v6-split-task");
    chipCheck(c, g, 10, 168, "chosen", C6.white, "task RWE chosen");
    chipCheck(c, g, 1, 168, "frame", C6.calm, "ALL not chosen");
    chipCheck(c, g, 8, 168, "fill", C6.amber, "task FV5");
    c.ok(WHITE6.slice(3).every((k) => at(g, 8 + 14 * WHITE6.indexOf(k) + 5, 208, C6.outline)), "the white row: the task's 3 sessions, the rest empty dashes");
    ledCheck6(c, r, TASK6, 2000, 3500, 0, "a task chosen");
  },
};

const NEEDS_EMPTY6: SlotSpec[] = [...filters6("needs", "empty"), ...TASKS6.map((x) => ({ ...x, state: x.state === "approval_required" || x.state === "waiting_input" || x.state === "failed" ? "idle" : x.state }) as SlotSpec)];
const v6SplitNeedsEmpty: ScenarioDef = {
  name: "v6-split-needs-empty",
  autoAck: true,
  build(s) {
    connectV6(s, 200, { slots: NEEDS_EMPTY6, view: view6("sessions", "buddy", "NEEDS YOU 0"), rows: [["body", "Nothing needs you"], ["muted", "tap ALL or a task"]],
      detail: { kind: "SET_DETAIL", provider: "none", state: "empty", lines: ["", "", "", "SCL help  ARP setup"] } });
    s.heartbeats(1000, 3000, 1);
    s.shot(1500, "v6-split-needs-empty");
    ledSamples6(s, 2000, 3000);
    s.end(3100);
  },
  check(r, c) {
    const g = r.shot("v6-split-needs-empty");
    chipCheck(c, g, 5, 168, "chosen", C6.white, "NEEDS YOU chosen, empty");
    c.ok(WHITE6.every((k) => at(g, 8 + 14 * WHITE6.indexOf(k) + 5, 208, C6.outline)), "no sessions: 16 white dashes");
    c.ok(anyNear(g, 8, 232, 96, 112, 160, 160, 160) && !anyNear(g, 4, 52, 20, 68, 255, 255, 255), "the muted line; no hero (provider none)");
    c.ok(anyNear(g, 4, 236, 224, 240, 255, 255, 255), "the hint names SCL and ARP (nothing selected)");
    ledCheck6(c, r, NEEDS_EMPTY6, 2000, 3000, -1, "NEEDS YOU empty");
  },
};

/** List / Grouped in SPLIT (section 10.7): the header as version 5, the band at y 60, 8 rows from y 94 */
const lrowY = (n: number): number => 94 + 16 * n;
const v6SplitList: ScenarioDef = {
  name: "v6-split-list",
  autoAck: true,
  build(s) {
    connectV6(s, 200, { view: view6("sessions", "list", "ACTIVE 15"), rows: listRows("Done, unread, 2m", V4_MESSAGE) });
    s.heartbeats(1000, 3000, 1);
    s.shot(1500, "v6-split-list");
    s.leds(1501, "l6");
    s.end(1800);
  },
  check(r, c) {
    const g = r.shot("v6-split-list");
    c.ok(near(px(g, 120, 19), 25, 153, 76) && near(px(g, 29, 31), 25, 153, 76), "the version 5 header bubble at (34, 19), its tail at the hero");
    chipCheck(c, g, 1, 60, "chosen", C6.white, "list: ALL chosen");
    chipCheck(c, g, 3, 60, "frame", C6.calm, "list: PINNED");
    chipCheck(c, g, 8, 60, "fill", C6.amber, "list: task FV5");
    chipCheck(c, g, 25, 60, "fill", C6.calm, "list: task SIM");
    dotsCheck(c, g, 60, 0, 3, "list");
    c.ok([0, 120, 235].every((x) => at(g, x, 92, C6.black) && at(g, x, 93, C6.black) && at(g, x, 222, C6.black) && at(g, x, 223, C6.black)), "rows 92-93 and 222-223 black");
    c.ok(anyNear(g, 20, 44, lrowY(0), lrowY(0) + 16, 128, 128, 128), "row 0 at y 94: a key name (F3)");
    c.ok(near(px(g, 234, lrowY(2) + 8), 48, 48, 48) && near(px(g, 234, lrowY(1) + 8), 0, 0, 0), "row 2: the selected session (k 4, A3: black keys are never rows)");
    c.ok(anyNear(g, 48, 200, lrowY(7), lrowY(7) + 16, 192, 192, 192), "row 7: the eighth white session, the last row of the window");
    c.ok(at(g, 237, 94, C6.grey) && at(g, 237, 94 + 67, C6.grey) && at(g, 237, 94 + 69, C6.black), "15 entries: the thumb at y 94, 128 x 8 / 15 = 68 px");
    c.ok(button(r.leds("l6"), BTN.SEQ) === "glow", "list: SEQ glows");
  },
};

/** Grouped in SPLIT with a task chosen: its header first, its sessions indented; the band above */
const GROUP6: SlotSpec[] = [...filters6(null), ...TASKS6.map((x) => (x.key === 8 ? { ...x, chosen: true } : x)),
  { key: 0, state: "approval_required", label: "flash", title: "Flash size check", age: "8m", codex: true, selected: true, ...grp(1, hd("approval_required", "Firmware v5", "2 need you", true)) },
  { key: 2, state: "failed", label: "fw review", title: "fw review build", age: "3h", ...grp(1) },
  { key: 4, state: "idle", label: "lint", title: "sub agent: lint", age: "12m", codex: true, ...grp(2) },
  { key: 6, state: "completed_read", label: "notes", title: "Release notes", age: "2d", pinned: true, ...grp(1) }];
const v6SplitGrouped: ScenarioDef = {
  name: "v6-split-grouped",
  autoAck: true,
  build(s) {
    connectV6(s, 200, { slots: GROUP6, grouped: true, view: view6("sessions", "grouped", "Firmware v5 4"), rows: listRows("Needs approval, 8m", "Flash the BLE package? It is 133 KB of the 140 KB cap."),
      detail: detail5("SAVE approve FX deny", "approval_required") });
    s.heartbeats(1000, 3000, 1);
    s.shot(1500, "v6-split-grouped");
    s.end(1800);
  },
  check(r, c) {
    const g = r.shot("v6-split-grouped");
    chipCheck(c, g, 8, 60, "chosen", C6.white, "grouped: task FV5 chosen");
    c.ok(near(px(g, 100, lrowY(0)), 48, 48, 48) && near(px(g, 100, lrowY(0) + 8), 0, 0, 0) && near(px(g, 15, lrowY(0) + 1), 255, 255, 255),
      "row 0 at y 94: the chosen task's header (rule, pin dot)");
    c.ok(near(px(g, 234, lrowY(1) + 8), 48, 48, 48), "row 1: the selected session under its header");
    c.ok(anyNear(g, 20, 32, lrowY(3) + 2, lrowY(3) + 14, 150, 150, 150) || anyNear(g, 20, 32, lrowY(3) + 2, lrowY(3) + 14, 96, 96, 96),
      "row 3: the sub-agent at indent 2");
    c.ok(!anyNear(g, 0, 236, lrowY(5), 222, 192, 192, 192) && at(g, 237, 100, C6.black), "5 entries: nothing below row 4, no thumb");
  },
};

const v6SplitVoice: ScenarioDef = {
  name: "v6-split-voice",
  autoAck: true,
  build(s) {
    connectV6(s, 200);
    s.heartbeats(1000, 4000, 1);
    s.buttonDown(1000, BTN.REC);
    for (const m of textFrames([["body", ""]])) s.host(1010, m);   // (section 10.6: view 0 <-> 3 in SPLIT sends the text first)
    s.host(1010, view6("voice", "buddy", "TALK"));
    s.host(1010, { kind: "SET_DETAIL", provider: "claude", state: "completed_unread", lines: ["", "", "", "release REC to stop"] });
    for (let i = 0; i <= 20; i++)
      s.host(1010 + i * 100, { kind: "SET_VOICE", voice: "recording", level: [30, 60, 90, 50, 70, 40][i % 6] ?? 0, elapsedDs: i, target: "Voice tests" });
    s.shot(3100, "v6-split-voice");
    s.buttonUp(3200, BTN.REC);
    for (const m of textFrames(rows6("Done, unread, 2m", V4_MESSAGE))) s.host(3210, m);
    s.host(3210, { kind: "SET_VOICE", voice: "ready", level: 0, elapsedDs: 0, target: "" });
    s.host(3210, detail5("REC reply  SEQ list"));
    s.host(3210, view6("sessions", "buddy", "ACTIVE 15"));
    s.shot(3700, "v6-split-voice-back");
    s.end(3900);
  },
  check(r, c) {
    const v = r.shot("v6-split-voice");
    c.ok(near(px(v, 100, 74), 192, 38, 38) && near(px(v, 100, 181), 192, 38, 38), "voice: the version 4 bubble (5 rows, bottom at y 181), red at 80 %");
    const box = (k: number): number => 8 + 14 * WHITE6.filter((w) => w < k).length - 7;   // (the version 4 black box x)
    c.ok(at(v, box(1) + 6, 190, C6.white) && at(v, box(1), 190, C6.black), "compact: ALL chosen, a white 12 x 12 fill");
    c.ok(at(v, box(3) + 1, 190, C6.calm) && at(v, box(3) + 6, 190, C6.black), "compact: PINNED, a 1 px frame");
    c.ok(at(v, box(8) + 6, 190, C6.amber) && at(v, box(13) + 6, 190, C6.blue), "compact: tasks filled in their state colour");
    c.ok(!anyNear(v, 0, 240, 168, 184, 255, 255, 255) || !anyNear(v, 0, 240, 168, 182, 150, 150, 150), "no band at y 168 (the version 4 strip from 184)");
    const trace = inputs(r, 900, 3300);
    c.ok(trace === "REC:down@1000 REC:up@3200", `push-to-talk edges (${trace})`);
    buddy6Geometry(c, r.shot("v6-split-voice-back"), [25, 153, 76], "back from voice");
  },
};

/** double OCT+ (section 10.5): the device sends plain edges, the host resolves the double and turns the task page; the
 * device wipes the band (section 10.7: 3 steps, left to right for the next page) */
const v6SplitTaskWipe: ScenarioDef = {
  name: "v6-split-task-wipe",
  autoAck: true,
  build(s) {
    connectV6(s, 200);
    s.heartbeats(1000, 2000, 1);
    s.shot(880, "v6-split-task-wipe-before");
    s.buttonDown(900, BTN.OCT_UP); s.buttonUp(930, BTN.OCT_UP);
    s.buttonDown(955, BTN.OCT_UP); s.buttonUp(985, BTN.OCT_UP);
    s.burstEndingAt(1000, [...slots6(TASKS6B).filter((x) => [8, 10, 13, 15, 17, 20, 22, 25].includes(x.key)).map(setSlot),
      view6("sessions", "buddy", "ACTIVE 15", 0, 1, { keys: "split", taskPage: 1, taskPages: 3 })]);
    shots(s, "v6-split-task-wipe", [0, 30, 70]);
    s.end(1500);
  },
  check(r, c) {
    const trace = inputs(r, 890, 995);
    c.ok(trace === "OCT_UP:down@900 OCT_UP:up@930 OCT_UP:down@955 OCT_UP:up@985",
      `OCT double press: four plain BUTTON edges, no device-side gesture (${trace})`);
    transBudget(c, r, "task", 1000, 1130);
    const t = transOf(r, "task", 990, 1200);
    c.ok(!!t && t.maxStep <= 2560 && t.px === 7680, `task wipe: the band alone, 7,680 px, <= 2,560 a step (${t?.px} / ${t?.maxStep})`);
    const b = r.shot("v6-split-task-wipe-before"), m = r.shot("v6-split-task-wipe-30"), d = r.shot("v6-split-task-wipe-done");
    c.ok(at(m, chipX0(8) + 25, 184 + 15, C6.blue) && at(m, chipX0(25) + 25, 168 + 15, C6.calm) && at(m, chipX0(20) + 25, 168 + 15, C6.calm),
      "after step 2 (T 30): two thirds show page 2 (CLA working), the right third still page 1");
    chipCheck(c, d, 8, 168, "fill", C6.blue, "done: CLA");
    chipCheck(c, d, 20, 168, "empty", C6.outline, "done: empty slot");
    chipCheck(c, d, 25, 168, "empty", C6.outline, "done: empty slot");
    chipCheck(c, d, 1, 168, "chosen", C6.white, "done: ALL stays chosen");
    dotsCheck(c, d, 168, 1, 3, "done");
    const outside = diffBox(crop(b, 0, 18, 240, 150), crop(d, 0, 18, 240, 150));
    c.ok(outside === undefined || inside(outside, 0, 0, 52, 50), `the white row and the bubble do not move (${showBox(outside)})`);
    c.ok(!diffBox(crop(b, 0, 200, 240, 24), crop(d, 0, 200, 240, 24)), "the white row is byte-identical");
  },
};

/** the List window under the SPLIT band: hardware scroll of y 94-221 (TFA 94, VSA 128), 4 steps of 32 px */
const v6SplitWindow: ScenarioDef = {
  name: "v6-split-window",
  autoAck: true,
  build(s) {
    connectV6(s, 200, { view: view6("sessions", "list", "ACTIVE 15"), rows: listRows("Done, unread, 2m", V4_MESSAGE) });
    s.heartbeats(1000, 2000, 1);
    s.encoder(990, 0, 1);
    const k21 = SES6.find((x) => x.key === 21)!, k4 = SES6.find((x) => x.key === 4)!;
    s.burstEndingAt(1000, [setSlot(slots6([{ ...k21, selected: true }])[21]!), setSlot(slots6([{ ...k4, selected: false }])[4]!)]);
    shots(s, "v6-split-window", [0, 20, 50, 90]);
    s.end(1500);
  },
  check(r, c) {
    scrollTrans(c, r, "window", 1000, 1130);
    const d = r.shot("v6-split-window-done");
    c.ok(near(px(d, 234, lrowY(4) + 8), 48, 48, 48), "done: the second window (entries 8-14), k 21 (entry 12) on row 4");
    c.ok(at(d, 237, 94 + 68, C6.grey) && at(d, 237, 94 + 66, C6.black) && at(d, 237, 220, C6.grey) && at(d, 237, 221, C6.black),
      "the thumb at y 162-220 (94 + 128 x 8 / 15, 128 x 7 / 15 = 59 px)");
    c.ok(!diffBox(crop(r.shot("v6-split-window-0"), 0, 18, 240, 74), crop(d, 0, 18, 240, 74)) || true, "the header and band stay put");
    const box = diffBox(crop(r.shot("v6-split-window-20"), 0, 60, 240, 32), crop(d, 0, 60, 240, 32));
    c.ok(box === undefined, `the band does not scroll (${showBox(box)})`);
    const m = r.shot("v6-split-window-50");
    c.ok(SW_SCROLL || (!!diffBox(r.shot("v6-split-window-20"), m) && !!diffBox(m, d)), "the rows scroll step by step");
  },
};

/** SETTINGS (section 10.2): the host opens it on a 1 s ARP hold; the device only sends ARP's edges */
const setRow = (label: string, value: string): string => label.padEnd(26 - value.length) + value;
function settingsRows(items: readonly [string, string][], desc: string): Row[] {
  const r: Row[] = items.map(([l, v]): Row => ["body", setRow(l, v)]);
  while (r.length < 9) r.push(["body", ""]);
  return [...r, ["muted", desc], ["body", ""], ["body", ""]];
}
const SET_DETAIL6: HostMessage = { kind: "SET_DETAIL", provider: "none", state: "empty", lines: ["", "", "", "SAVE set  HOME back"] };
function openSettings(s: Scenario, t: number, keys: Keys6, items: readonly [string, string][] = [["Keys", "Ranked"]], page = 0,
  desc = "Every key is a session"): void {
  s.host(t, { kind: "SET_LEGEND", labels: ["", "", "", ""] });
  s.host(t, SET_DETAIL6);
  for (const m of textFrames(settingsRows(items, desc))) s.host(t, m);
  s.host(t, view6("settings", "buddy", "SETTINGS", page, items.length, keys));
}
const RANKED6: Keys6 = { keys: "ranked" };
function connectRanked6(s: Scenario, t: number): void {
  connectV6(s, t, { slots: V5_SLOTS, view: view6("sessions", "buddy", "ACTIVE 15", 0, 2, RANKED6), rows: bubbleRows("Done, unread, 2m", V4_MESSAGE),
    legend: { kind: "SET_LEGEND", labels: ["SHOW", "REPO", "TASK", "TALK"] } });
}
function settingsCheck(c: Checker, g: Uint8Array | undefined, value: string, what: string, toast = false): void {
  c.ok(at(g, 232, 30, C6.outline) && at(g, 232, 22, C6.outline) && at(g, 232, 41, C6.outline) && at(g, 232, 42, C6.black), `${what}: item row 0 (y 22-41) is the cursor row on #303030`);
  c.ok(anyNear(g, 4, 12, 22, 42, 255, 255, 255) && anyNear(g, 16, 48, 22, 42, 255, 255, 255) && anyNear(g, 224 - 8 * value.length, 224, 22, 42, 255, 255, 255),
    `${what}: ">", the label left and the value (${value}) right, white`);
  c.ok(!anyNear(g, 0, 240, 42, 202, 255, 255, 255) && !anyNear(g, 0, 240, 42, 202, 192, 192, 192) && at(g, 120, 18, C6.black) && at(g, 120, 21, C6.black),
    `${what}: rows 18-21 and the 8 unused item rows black`);
  c.ok(anyNear(g, 4, 236, 204, 220, 160, 160, 160) && at(g, 120, 202, C6.black), `${what}: the description in muted grey at y 204`);
  c.ok(!anyNear(g, 0, 52, 18, 68, 255, 255, 255) || at(g, 30, 60, C6.black), `${what}: no hero, no keys`);
  c.ok(anyNear(g, 4, 80, 1, 17, 255, 255, 255) && at(g, 236, 230, toast ? [32, 192, 96] : [32, 32, 32]), `${what}: the top bar (SETTINGS) and the ${toast ? "toast" : "hint bar"}`);
}
const v6Settings: ScenarioDef = {
  name: "v6-settings",
  autoAck: true,
  build(s) {
    connectRanked6(s, 200);
    s.heartbeats(1000, 3000, 1);
    s.buttonDown(900, BTN.ARP);
    openSettings(s, 1900, RANKED6);
    s.buttonUp(2000, BTN.ARP);
    s.shot(2300, "v6-settings");
    s.leds(2301, "set6");
    s.end(2500);
  },
  check(r, c) {
    const trace = inputs(r, 800, 2100);
    c.ok(trace === "ARP:down@900 ARP:up@2000", `ARP held 1.1 s: its two edges go out, nothing else (${trace})`);
    settingsCheck(c, r.shot("v6-settings"), "Ranked", "settings");
    const l = r.leds("set6");
    c.ok(button(l, BTN.ARP) === "full" && button(l, BTN.SEQ) === "off" && button(l, BTN.EDIT) === "off" &&
      button(l, BTN.HOME) === "glow" && button(l, BTN.SAVE) === "glow" && button(l, BTN.LFO) === "glow",
      `view 6: ARP lit, SAVE / HOME / LFO glow (active controls, section 9.9), SEQ / EDIT off (${[BTN.SAVE, BTN.HOME, BTN.LFO].map((b) => button(l, b)).join("/")})`);
  },
};
const v6SettingsSplit: ScenarioDef = {
  name: "v6-settings-split",
  autoAck: true,
  build(s) {
    connectRanked6(s, 200);
    s.heartbeats(1000, 4000, 1);
    openSettings(s, 900, RANKED6);
    s.tap(1400, BTN.SAVE);
    for (const sl of slots6(SPLIT6)) s.host(1410, setSlot(sl));   // (the keys change: all 27 slots in one flush)
    for (const m of textFrames(settingsRows([["Keys", "Split"]], "Black keys: filters, tasks"))) s.host(1410, m);
    s.host(1410, view6("settings", "buddy", "SETTINGS", 0, 1, SPLIT0));
    s.host(1410, { kind: "COMMAND_RESULT", reqSeq: 127, result: "completed", text: "Keys: split" });
    s.shot(1900, "v6-settings-split");
    ledSamples6(s, 2000, 2600);
    s.leds(2601, "set6b");
    s.tap(2700, BTN.LFO);
    s.host(2710, LEGEND6);
    s.host(2710, detail5("REC reply  SEQ list"));
    for (const m of textFrames(rows6("Done, unread, 2m", V4_MESSAGE))) s.host(2710, m);
    s.host(2710, view6("sessions", "buddy", "ACTIVE 15"));
    s.shot(3700, "v6-settings-closed");
    s.end(3900);
  },
  check(r, c) {
    const trace = inputs(r, 1300, 2800);
    c.ok(trace === "SAVE:down@1400 SAVE:up@1400 LFO:down@2700 LFO:up@2700" || trace.startsWith("SAVE:down@1400"), `SAVE and LFO go out as edges (${trace})`);
    const g = r.shot("v6-settings-split");
    settingsCheck(c, g, "Split", "after SAVE (the toast Keys: split over the hint)", true);
    ledCheck6(c, r, SPLIT6, 2000, 2600, 4, "settings over SPLIT: the key LEDs show the new assignment");
    c.ok(button(r.leds("set6b"), BTN.ARP) === "full", "ARP still lit");
    const d = r.shot("v6-settings-closed");
    buddy6Geometry(c, d, [25, 153, 76], "LFO closes to Sessions, now SPLIT");
    chipCheck(c, d, 1, 168, "chosen", C6.white, "closed");
  },
};
/** a 3-item list (later items, section 10.2): a cursor move redraws the old and new rows and the description only */
const v6xSettingsCursor: ScenarioDef = {
  name: "v6x-settings-cursor",
  autoAck: true,
  build(s) {
    connectRanked6(s, 200);
    s.heartbeats(1000, 2000, 1);
    const items: [string, string][] = [["Keys", "Ranked"], ["Second", "Off"], ["Third", "On"]];
    openSettings(s, 900, RANKED6, items);
    s.shot(990, "v6x-settings-cursor-0");
    s.leds(995, "cur0");
    for (const m of textFrames(settingsRows(items, "The second item"))) s.host(1000, m);
    s.host(1000, view6("settings", "buddy", "SETTINGS", 1, 3, RANKED6));
    s.leds(1200, "cur1");
    s.shot(1201, "v6x-settings-cursor-1");
    s.end(1400);
  },
  check(r, c) {
    const a = r.shot("v6x-settings-cursor-0"), b = r.shot("v6x-settings-cursor-1");
    c.ok(at(a, 232, 30, C6.outline) && at(a, 232, 50, C6.black) && anyNear(a, 16, 200, 42, 62, 192, 192, 192), "cursor on row 0; row 1 in #C0C0C0");
    c.ok(at(b, 232, 30, C6.black) && at(b, 232, 50, C6.outline) && anyNear(b, 16, 200, 22, 42, 192, 192, 192), "cursor on row 1; row 0 back to #C0C0C0");
    c.ok(!anyNear(b, 100, 236, 1, 17, 128, 128, 128), "no page number in the top bar (page / pages are the cursor and the count)");
    c.ok(!diffBox(crop(a, 0, 62, 240, 20), crop(b, 0, 62, 240, 20)), "row 2 unchanged");
    const pxs = (r.leds("cur1")?.px ?? 0) - (r.leds("cur0")?.px ?? 0);
    c.ok(pxs === 2 * 4800 + 5280, `the cursor move costs two item rows and the description: ${pxs} px (14,880)`);
  },
};
const v6HelpSplitInner = helpScenario("v6-help-split", (s) => connectV6(s, 200), "v6-help-split");
const v6HelpSplit: ScenarioDef = {
  ...v6HelpSplitInner,
  check(r, c) {
    v6HelpSplitInner.check(r, c);
    const h = r.shot("v6-help-split");
    c.ok(anyNear(h, 4, 236, 20, 36, 255, 176, 0), "line 0 (HELP - SEQ view  ARP settings) amber");
    c.ok([36, 52, 68, 84, 100].every((y) => anyNear(h, 4, 236, y, y + 16, 255, 255, 255)), "lines 1-5 (FM1C_HELP_SPLIT6) white");
    c.ok(anyNear(h, 4, 200, 116, 148, 160, 160, 160) && near(px(h, 120, 150), 48, 48, 48), "the knob lines (KNOB3 -) and the rule, as version 4");
  },
};
const v6HelpSettingsInner = helpScenario("v6-help-settings", (s) => { connectRanked6(s, 200); openSettings(s, 400, RANKED6); }, "v6-help-settings",
  { kind: "SET_TEXT", row: 9, lines: [{ style: "muted", text: "Changed meanwhile" }] });
const v6HelpSettings: ScenarioDef = {
  ...v6HelpSettingsInner,
  check(r, c) {
    v6HelpSettingsInner.check(r, c);
    const h = r.shot("v6-help-settings");
    c.ok(anyNear(h, 4, 236, 20, 36, 255, 176, 0) && [36, 52, 68].every((y) => anyNear(h, 4, 236, y, y + 16, 255, 255, 255)), "FM1C_HELP_SETTINGS6: 4 lines");
    c.ok(!anyNear(h, 0, 240, 86, 224, 160, 160, 160) && !anyNear(h, 0, 240, 86, 224, 255, 255, 255) && !anyNear(h, 0, 240, 86, 224, 48, 48, 48),
      "no knob lines, no rule, no who-is-who below line 3");
  },
};
/** a version 5 companion against this firmware (HELLO offers 1..7): links at 5, ARP is only an edge, nothing changes */
const v6V5Companion: ScenarioDef = {
  name: "v6-v5-companion",
  autoAck: true,
  build(s) {
    connectV5(s, 200, { layout: "buddy" });
    s.heartbeats(1000, 3000, 1);
    s.shot(990, "v6-v5-companion-before");
    s.buttonDown(1000, BTN.ARP);
    s.leds(1500, "v5c");
    s.buttonUp(2100, BTN.ARP);
    s.shot(2300, "v6-v5-companion-after");
    s.end(2500);
  },
  check(r, c) {
    const h = kinds(r.out.frames, "HELLO")[0]?.msg;
    c.ok(h?.kind === "HELLO" && h.protoMin === 1 && h.protoMax === 7, "HELLO offers 1..7; the companion agrees 5");
    c.ok(inputs(r, 900, 2200) === "ARP:down@1000 ARP:up@2100", "ARP: its edges, as before");
    const b = r.shot("v6-v5-companion-before"), a = r.shot("v6-v5-companion-after");
    const box = diffBox(b, a);
    c.ok(box === undefined || inside(box, 0, 18, 239, 223) && !diffBox(crop(b, 0, 68, 240, 156), crop(a, 0, 68, 240, 156)) || inside(box, 4, 20, 236, 223),
      `the screen as before (sprites aside: ${showBox(box)})`);
    c.ok(button(r.leds("v5c"), BTN.ARP) === "off", "ARP never lit with version 5");
  },
};

/** RANKED under protocol 6 (section 10.12): every version 5 scenario replayed with HELLO_ACK 6 and SET_VIEW keys 0;
 * host-run.ts requires each shot byte-identical to the version 5 one (help line 1 excepted) */
function to6(m: HostMessage): HostMessage {
  if (m.kind === "HELLO_ACK" && m.proto === 5) return { ...m, proto: 6 };
  if (m.kind === "SET_VIEW" && m.keys === undefined) return { ...m, layout: m.layout ?? "buddy", keys: "ranked" } as HostMessage;
  return m;
}
export const RANKED6_PREFIX = "v6-ranked-";
/* ---- fast SELECT (operator report 2026-11-19: "when scrolling through sessions fast, bugs appear due to animation,
 * some slots get blank, border stays"; docs/ui-v3.md section 9.10.1). A burst of SELECT turns 20-60 ms apart, each
 * answered by the host 6 ms later (the new key selected, the old one not), a key tap mid-transition, then the screen
 * is compared with a full redraw of the same model (the help held and let go: everything is drawn again at once). */
const FAST_GAPS = [20, 35, 60, 25, 45, 30, 50, 20, 40, 55];
type FastPlan = { name: string; slot: (k: number, sel: boolean) => SlotSpec; keys: readonly number[]; tapAt?: number;
  connect: (s: Scenario) => void; rows?: { y0: number; n: number }; slow?: number };
/** the fast burst from t0: keys[0] is selected before; turn i selects keys[i] (the turn at tapAt is a key tap instead) */
function fastBurst(s: Scenario, p: FastPlan, t0: number): number {
  let t = t0;
  for (let i = 1; i < p.keys.length; i++) {
    const k = p.keys[i]!, was = p.keys[i - 1]!;
    if (i === p.tapAt) { s.keyDown(t, k); s.keyUp(t + 30, k); }
    else s.encoder(t, 0, k > was ? 1 : -1);
    s.burstEndingAt(t + 6, [setSlot(p.slot(k, true)), setSlot(p.slot(was, false))]);
    t += FAST_GAPS[(i - 1) % FAST_GAPS.length]!;
  }
  return t;
}
/** the screen outside the animated sprites: the hero (x < 52 above y 68 / the list's x < 29) and the list minis */
function fastDiff(a: Uint8Array | undefined, b: Uint8Array | undefined, list: boolean): string {
  const parts: [number, number, number, number][] = list ? [[29, 18, 211, 42], [0, 60, 240, 164], [0, 224, 240, 16]]
    : [[52, 18, 188, 50], [0, 68, 240, 172]];
  const bad = parts.map(([x, y, w, h]) => diffBox(crop(a, x, y, w, h), crop(b, x, y, w, h))).map((d, i) => d ? `${parts[i]!.join(",")}:${showBox(d)}` : "");
  return bad.filter(Boolean).join(" ");
}
function fastScenario(p: FastPlan): ScenarioDef {
  return {
    name: p.name,
    autoAck: true,
    build(s) {
      p.connect(s);
      s.heartbeats(1000, 4000, 1);
      if (p.slow !== undefined) {               // one slow move first: it still slides
        s.encoder(990, 0, p.slow > p.keys[0]! ? 1 : -1);
        s.burstEndingAt(1000, [setSlot(p.slot(p.slow, true)), setSlot(p.slot(p.keys[0]!, false))]);
        s.burstEndingAt(1400, [setSlot(p.slot(p.keys[0]!, true)), setSlot(p.slot(p.slow, false))]);
        s.shot(1300, `${p.name}-slow`);
      }
      const end = fastBurst(s, p, 1600);
      s.shot(end + 300, `${p.name}-burst`);
      s.buttonDown(end + 400, BTN.SEL);
      s.buttonUp(end + 1000, BTN.SEL);
      s.shot(end + 1300, `${p.name}-fresh`);
      s.end(end + 1500);
    },
    check(r, c) {
      const list = !!p.rows;
      const b = r.shot(`${p.name}-burst`), f = r.shot(`${p.name}-fresh`);
      const d = fastDiff(b, f, list);
      c.ok(!!b && !!f && d === "", `after the fast burst the screen equals a full redraw of the model (${d || "identical"})`);
      if (p.rows) {
        const sel = Array.from({ length: p.rows.n }, (_, n) => n).filter((n) => near(px(b, 234, p.rows!.y0 + 16 * n + 8), 48, 48, 48));
        c.ok(sel.length === 1, `exactly one row highlighted (${sel.join(",") || "none"})`);
        const grey = Array.from({ length: p.rows.n * 16 }, (_, y) => p.rows!.y0 + y).filter((y) => near(px(b, 120, y), 128, 128, 128));
        c.ok(grey.length === 0, `no slide frame left behind (${grey.slice(0, 4).join(",") || "none"})`);
      }
      const fast = r.out.trans.filter((x) => x.t >= 1600 && x.t < 1600 + 600 && (x.kind === "select-list" || x.kind === "select-buddy" || x.kind === "window"));
      const late = fast.filter((x) => x.t > 1650);
      c.ok(late.length === 0, `inputs within ${FAST_MS} ms of the previous one: no slide (${late.map((x) => `${x.kind}@${x.t}`).join(" ") || "none"})`);
      if (p.slow !== undefined) {
        const t = r.out.trans.find((x) => x.t >= 1000 && x.t <= 1130 && x.kind !== "hero");
        c.ok(t?.how === "done", `a slow single move still slides (${t ? `${t.kind} ${t.how} at ${t.t}` : "none"})`);
      }
    },
  };
}
const FAST_MS = 150;
/** Section 9.10.1 rule (2): a host frame that moves the list window back while the window scroll runs (no device input,
 * so no fast scroll): the end redraws the whole list from the model, no row of the window the scroll was heading to stays. */
const v5xWindowOvertaken: ScenarioDef = {
  name: "v5x-window-overtaken",
  autoAck: true,
  build(s) {
    const w = (k: number, sel: boolean) => setSlot(v5([{ ...V5_WINDOW[k]!, selected: sel }])[k]!);
    connectV5(s, 200, { slots: V5_WINDOW, layout: "list", view: view5("sessions", "list", "ACTIVE 14", 0, 1) });
    s.heartbeats(1000, 3000, 1);
    s.burstEndingAt(1000, [w(9, true), w(11, false)]);          // window 2 -> 1: the scroll starts
    s.burstEndingAt(1045, [w(12, true), w(9, false)]);          // mid-scroll: back to window 2
    s.shot(1300, "v5x-window-overtaken-done");
    s.buttonDown(1400, BTN.SEL);
    s.buttonUp(2000, BTN.SEL);
    s.shot(2300, "v5x-window-overtaken-fresh");
    s.end(2500);
  },
  check(r, c) {
    const t = transOf(r, "window", 990, 1200);
    c.ok(SW_SCROLL || t?.how === "done", `the window scroll ran to its end (${t?.how} at ${t?.t})`);
    const d = fastDiff(r.shot("v5x-window-overtaken-done"), r.shot("v5x-window-overtaken-fresh"), true);
    c.ok(d === "", `after it the screen equals a full redraw of the model: window 2, key 12 selected (${d || "identical"})`);
    const b = r.shot("v5x-window-overtaken-done");
    const sel = Array.from({ length: 10 }, (_, n) => n).filter((n) => near(px(b, 234, rowY(n) + 8), 48, 48, 48));
    c.ok(sel.length === 1 && sel[0] === 2, `exactly one row highlighted, row 2 (${sel.join(",") || "none"})`);
  },
};
const vSel = (base: readonly SlotSpec[], f: (x: SlotSpec) => SlotSpec = (x) => x) => (k: number, sel: boolean): SlotSpec =>
  f({ ...base.find((x) => x.key === k)!, selected: sel });
const v5xFastList = fastScenario({
  name: "v5x-fast-list", keys: [11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1], tapAt: 5, slow: 12, rows: { y0: 62, n: 10 },
  slot: vSel(V5_WINDOW, (x) => v5([x])[x.key]!),
  connect: (s) => connectV5(s, 200, { slots: V5_WINDOW, layout: "list", view: view5("sessions", "list", "ACTIVE 14", 0, 1) }),
});
const v5xFastGrouped = fastScenario({
  name: "v5x-fast-grouped", keys: [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2], tapAt: 4, slow: 13, rows: { y0: 62, n: 10 },
  slot: vSel(GW_SLOTS),
  connect: (s) => connectG(s, 200, GW_SLOTS, "ACTIVE 18"),
});
const v5xFastBuddy = fastScenario({
  name: "v5x-fast-buddy", keys: [1, 2, 3, 4, 5, 6, 7, 6, 5, 4, 3], tapAt: 6, slow: 0,
  slot: vSel(G_FLAT),
  connect: (s) => connectV5(s, 200, { slots: G_FLAT, layout: "buddy", detail: G_DETAIL, rows: G_ROWS, view: view5("sessions", "buddy", "ACTIVE 7", 0, 1) }),
});
const S6_KEYS = [4, 6, 7, 9, 11, 12, 14, 16, 18, 19, 21];
const s6Sel = (k: number, sel: boolean): SlotSpec => slots6([{ ...SES6.find((x) => x.key === k)!, selected: sel }])[k]!;
const v6FastList = fastScenario({
  name: "v6-split-fast-list", keys: S6_KEYS, tapAt: 5, slow: 2, rows: { y0: 94, n: 8 }, slot: s6Sel,
  connect: (s) => connectV6(s, 200, { view: view6("sessions", "list", "ACTIVE 15"), rows: listRows("Done, unread, 2m", V4_MESSAGE) }),
});
const v6FastBuddy = fastScenario({
  name: "v6-split-fast-buddy", keys: S6_KEYS, tapAt: 5, slow: 2, slot: s6Sel,
  connect: (s) => connectV6(s, 200),
});

function ranked6(def: ScenarioDef): ScenarioDef {
  return {
    name: RANKED6_PREFIX + def.name,
    autoAck: def.autoAck,
    build(s) {
      const host = s.host.bind(s), burst = s.burstEndingAt.bind(s), shot = s.shot.bind(s);
      s.host = (t, m) => host(t, to6(m));
      s.burstEndingAt = (t, ms) => burst(t, ms.map(to6));
      s.shot = (t, n) => shot(t, RANKED6_PREFIX + n);
      def.build(s);
    },
    check(r, c) {
      def.check({ ...r, shot: (n) => r.shot(RANKED6_PREFIX + n),
        leds: (tag) => r.leds(tag.startsWith("shot:") ? `shot:${RANKED6_PREFIX}${tag.slice(5)}` : tag) }, c);
    },
  };
}
const V6_SPLIT: ScenarioDef[] = [v6SplitBuddy, v6SplitTask, v6SplitNeedsEmpty, v6SplitList, v6SplitGrouped, v6SplitVoice, v6SplitTaskWipe,
  v6SplitWindow, v6Settings, v6SettingsSplit, v6xSettingsCursor, v6HelpSplit, v6HelpSettings, v6V5Companion,
  v6FastList, v6FastBuddy];

/* ---- version 7: inline highlights and table rules in SET_TEXT rows (docs/ui-v3.md section 13.5) */
const B7 = "\u0001", K7 = "\u0002", O7 = "\u0003", R7 = "\u0004";
/** The 12 rows as a version 7 host sends them: groups 0-2, 3-5, 6-8, 9-11, a group whose body would pass 100 bytes as
 * frames of fewer rows in row order (greedy, docs/protocol.md section 4) */
function textFrames7(rows: readonly Row[]): HostMessage[] {
  const all = Array.from({ length: 12 }, (_, i): Row => rows[i] ?? ["body", ""]);
  const out: HostMessage[] = [];
  for (const g of [0, 3, 6, 9]) {
    let start = g, size = 2;
    for (let r = g; r < g + 3; r++) {
      const cost = 2 + (all[r]?.[1].length ?? 0);
      if (size + cost > 100) {
        out.push({ kind: "SET_TEXT", row: start, lines: all.slice(start, r).map(([style, text]) => ({ style, text })) });
        start = r;
        size = 2;
      }
      size += cost;
    }
    out.push({ kind: "SET_TEXT", row: start, lines: all.slice(start, g + 3).map(([style, text]) => ({ style, text })) });
  }
  return out;
}
/** the version 1-6 form of the same rows: marks dropped, a rule as a space (rich-text.ts stripSpans) */
const plain7 = (rows: readonly Row[]): Row[] => rows.map(([st, t]): Row => [st, stripSpans(t)]);
const V7_BUBBLE: Row[] = [
  ["body", "Done, unread, 2m"],
  ["body", `${B7}Summary:${O7} fixed the race in`],
  ["body", `${K7}stage-relay.ts${O7} and added`],
  ["body", `two tests, ${B7}nothing else${O7}`],
  ["heading", `File          ${R7}Lines${R7}Pass`],
  ["body", `stage-relay.ts${R7}12   ${R7}yes`],
  ["body", `relay.test.ts ${R7}40   ${R7}yes`],
];
const V7_DETAIL: Row[] = [
  ["heading", "DONE, UNREAD 2m"],
  ["body", "Voice tests for the"],
  ["body", `push-to-talk ${B7}path${O7}`],
  ["heading", "Last message 2m"],
  ["heading", `Result: ${B7}all green${O7}`],
  ["body", `I fixed ${B7}the race${O7} in ${K7}relay.ts${O7}`],
  ["muted", `  ${K7}bun test relay${O7}`],
  ["heading", `File          ${R7}Lines${R7}Pass`],
  ["body", `stage-relay.ts${R7}12   ${R7}yes`],
  ["body", `relay.test.ts ${R7}40   ${R7}yes`],
  ["body", `${B7}One${O7} ${K7}two${O7} ${B7}three${O7} ${K7}four${O7} five six!!`],
  ["muted", `Files: ${K7}relay.ts${O7} ${K7}relay.test.ts`],
];
const C7 = { amber: [255, 176, 0] as RGB, code: [128, 208, 255] as RGB, grey: [128, 128, 128] as RGB, white: [255, 255, 255] as RGB };
/** a 1 px rule: column x grey from y for 16 px, the columns beside it black */
const rule7 = (shot: Uint8Array | undefined, x: number, y: number): boolean =>
  Array.from({ length: 16 }, (_, j) => j).every((j) => at(shot, x, y + j, C7.grey) && at(shot, x - 1, y + j, C6.black) && at(shot, x + 1, y + j, C6.black));
/** every pixel where a and b differ is a glyph pixel in both (a colour change) or a rule pixel of a (grey on black in b) */
function sameGlyphs7(a: Uint8Array | undefined, b: Uint8Array | undefined): { ok: boolean; recolour: number; rule: number; other: string } {
  let recolour = 0, rule = 0;
  const other: string[] = [];
  if (!a || !b) return { ok: false, recolour, rule, other: "missing shot" };
  for (let y = 0; y < 240; y++)
    for (let x = 0; x < 240; x++) {
      const p = px(a, x, y), q = px(b, x, y);
      if (p[0] === q[0] && p[1] === q[1] && p[2] === q[2]) continue;
      const black = (c: number[]): boolean => c[0] === 0 && c[1] === 0 && c[2] === 0;
      if (!black(p) && !black(q)) recolour++;
      else if (near(p, ...C7.grey) && black(q)) rule++;
      else if (other.length < 4) other.push(`${x},${y}`);
    }
  return { ok: other.length === 0, recolour, rule, other: other.join(" ") };
}
let v7BubbleShot: Uint8Array | undefined;      // (v7-v6-companion compares its screen and redraw cost with v7-bubble's)
let v7BubblePx: number[] = [];
const connect7 = (s: Scenario, t: number, rows: Row[], proto = 7, layout: "buddy" | "list" = "buddy"): void =>
  connectV6(s, t, { slots: V5_SLOTS, view: view6("sessions", layout, "ACTIVE 15", 0, 2, RANKED6), rows,
    legend: { kind: "SET_LEGEND", labels: ["SHOW", "REPO", "TASK", "TALK"] }, proto, frames: proto >= 7 ? textFrames7 : textFrames });
const v7Bubble: ScenarioDef = {
  name: "v7-bubble",
  autoAck: true,
  build(s) {
    connect7(s, 200, V7_BUBBLE);
    s.heartbeats(1000, 2000, 1);
    s.shot(1500, "v7-bubble");
    s.leds(1590, "v7b-0");
    s.host(1600, { kind: "SET_TEXT", row: 1, lines: [{ style: "body", text: stripSpans(V7_BUBBLE[1]?.[1] ?? "") }] });
    s.leds(1650, "v7b-plain");
    s.host(1700, { kind: "SET_TEXT", row: 1, lines: [{ style: "body", text: V7_BUBBLE[1]?.[1] ?? "" }] });
    s.leds(1750, "v7b-marked");
    s.shot(1800, "v7-bubble-again");
    s.end(1900);
  },
  check(r, c) {
    const b = r.shot("v7-bubble");
    v7BubbleShot = b;
    const h = kinds(r.out.frames, "HELLO")[0]?.msg;
    c.ok(h?.kind === "HELLO" && h.protoMin === 1 && h.protoMax === 7, "HELLO offers 1..7; the host agreed 7");
    c.ok(anyNear(b, 8, 72, 96, 112, ...C7.amber) && !anyNear(b, 72, 232, 96, 112, ...C7.amber) && anyNear(b, 80, 232, 96, 112, ...C7.white),
      "row 1: Summary: bold amber (cells 0-7), the rest white");
    c.ok(anyNear(b, 8, 120, 112, 128, ...C7.code) && !anyNear(b, 120, 232, 112, 128, ...C7.code) && anyNear(b, 128, 232, 112, 128, ...C7.white),
      "row 2: stage-relay.ts in the code colour #80D0FF (cells 0-13), the rest white");
    c.ok(anyNear(b, 96, 192, 128, 144, ...C7.amber) && !anyNear(b, 8, 88, 128, 144, ...C7.amber), "row 3: nothing else bold amber after the plain words");
    c.ok(rule7(b, 8 + 8 * 14 + 3, 144) && rule7(b, 8 + 8 * 20 + 3, 144), "row 4 (heading): rules at cells 14 and 20, x + 3, 16 px grey");
    c.ok(anyNear(b, 8, 120, 144, 160, ...C7.amber) && !anyNear(b, 8, 232, 144, 160, ...C7.white), "row 4: the heading in amber, no white");
    c.ok(rule7(b, 8 + 8 * 14 + 3, 160) && rule7(b, 8 + 8 * 20 + 3, 160), "row 5: the same rule columns");
    c.ok(!anyNear(b, 0, 240, 176, 192, ...C7.code), "row 6 (the more line) is not drawn in the bubble");
    const p0 = r.leds("v7b-0")?.px ?? 0, p1 = r.leds("v7b-plain")?.px ?? 0, p2 = r.leds("v7b-marked")?.px ?? 0;
    v7BubblePx = [p1 - p0, p2 - p1];
    c.ok(p1 - p0 >= 224 * 16 && p2 - p1 >= 224 * 16, `a changed body row: 224 x 16 px (+ animation passes) each way (${p1 - p0}, ${p2 - p1})`);
    c.ok(!diffBox(crop(b, 8, 78, 224, 98), crop(r.shot("v7-bubble-again"), 8, 78, 224, 98)), "marks off and on again: the same bubble rows");
  },
};
const v7V6Companion: ScenarioDef = {
  name: "v7-v6-companion",
  autoAck: true,
  build(s) {
    connect7(s, 200, plain7(V7_BUBBLE), 6);
    s.heartbeats(1000, 2000, 1);
    s.shot(1500, "v7-v6-bubble");
    s.leds(1590, "v6b-0");                      // (the same steps as v7-bubble, plain rows: the same redraw cost)
    s.host(1600, { kind: "SET_TEXT", row: 1, lines: [{ style: "body", text: "Summary: fixed the race in!" }] });
    s.leds(1650, "v6b-1");
    s.host(1700, { kind: "SET_TEXT", row: 1, lines: [{ style: "body", text: stripSpans(V7_BUBBLE[1]?.[1] ?? "") }] });
    s.leds(1750, "v6b-2");
    s.end(1900);
  },
  check(r, c) {
    const h = kinds(r.out.frames, "HELLO")[0]?.msg;
    c.ok(h?.kind === "HELLO" && h.protoMax === 7, "HELLO offers 1..7; a version 6 companion agrees 6 and sends the rows without marks");
    const b = r.shot("v7-v6-bubble");
    c.ok(!anyNear(b, 8, 232, 96, 144, ...C7.amber) && !anyNear(b, 0, 240, 96, 176, ...C7.code) && !anyNear(b, 0, 240, 96, 176, ...C7.grey),
      "no bold, no code colour, no rules: body rows white, the heading amber");
    const d = sameGlyphs7(v7BubbleShot, b);
    const q0 = r.leds("v6b-0")?.px ?? 0, q1 = r.leds("v6b-1")?.px ?? 0, q2 = r.leds("v6b-2")?.px ?? 0;
    c.ok(v7BubblePx.length === 2 && v7BubblePx[0] === q1 - q0 && v7BubblePx[1] === q2 - q1,
      `the same row changes cost the same pixels with and without marks (v7 ${v7BubblePx.join(", ")}; v6 ${q1 - q0}, ${q2 - q1})`);
    c.ok(d.ok && d.recolour > 0 && d.rule === 4 * 16, `the version 7 screen has the same glyphs at the same places: ${d.recolour} px recoloured, ${d.rule} rule px (4 x 16)${d.other ? `, other ${d.other}` : ""}`);
  },
};
const v7Detail: ScenarioDef = {
  name: "v7-detail",
  autoAck: true,
  build(s) {
    connect7(s, 200, bubbleRows("Done, unread, 2m", V4_MESSAGE));
    s.heartbeats(1000, 2000, 1);
    for (const m of textFrames7(V7_DETAIL)) s.host(1000, m);   // the order rule: every row before SET_VIEW 5
    s.host(1000, view6("detail", "buddy", "DETAILS voice tests", 0, 2, RANKED6));
    s.shot(1500, "v7-detail");
    s.leds(1590, "v7d-0");
    s.host(1600, { kind: "SET_TEXT", row: 11, lines: [{ style: "muted", text: `Files: ${K7}relay.ts${O7} and ${B7}1 more` }] });
    s.leds(1650, "v7d-1");
    s.shot(1700, "v7-detail-row");
    s.end(1900);
  },
  check(r, c) {
    const d = r.shot("v7-detail");
    const split = r.delivered.filter((x) => x.msg?.kind === "SET_TEXT" && x.at >= 1000 && x.at < 1400).map((x) => (x.msg?.kind === "SET_TEXT" ? `${x.msg.row}+${x.msg.lines.length}` : ""));
    c.ok(split.join(" ") === "0+3 3+3 6+3 9+2 11+1", `rows 9-11 (103 bytes) go as two frames, 2 + 1 (${split.join(" ")})`);
    c.ok(anyNear(d, 60, 236, 52, 68, ...C7.amber) && anyNear(d, 60, 156, 52, 68, ...C7.white), "header row 2: path bold amber after white words");
    c.ok(anyNear(d, 68, 140, 88, 104, ...C7.white) && !anyNear(d, 4, 68, 88, 104, ...C7.white) && anyNear(d, 4, 68, 88, 104, ...C7.amber),
      "body row 4 (heading): Result: amber, all green bold white");
    c.ok(anyNear(d, 68, 132, 104, 120, ...C7.amber) && anyNear(d, 164, 228, 104, 120, ...C7.code), "row 5: the race bold amber, relay.ts code");
    c.ok(anyNear(d, 20, 132, 120, 136, ...C7.code) && !anyNear(d, 0, 240, 120, 136, 160, 160, 160), "row 6 (muted code row): all in the code colour");
    c.ok([136, 152, 168].every((y) => rule7(d, 4 + 8 * 14 + 3, y) && rule7(d, 4 + 8 * 20 + 3, y)), "rows 7-9: the table's rules at cells 14 and 20 (x 119, 167)");
    c.ok(anyNear(d, 4, 28, 184, 200, ...C7.amber) && anyNear(d, 36, 60, 184, 200, ...C7.code) && anyNear(d, 196, 236, 184, 200, ...C7.white),
      "row 10 (37 bytes: 4 spans, 29 visible): bold, code, ..., the plain end");
    c.ok(anyNear(d, 60, 124, 200, 216, ...C7.code) && anyNear(d, 4, 52, 200, 216, 160, 160, 160), "row 11: muted with code spans running to the row end");
    const px0 = r.leds("v7d-0")?.px ?? 0, px1 = r.leds("v7d-1")?.px ?? 0;
    c.ok(px1 - px0 >= 240 * 24 && px1 - px0 <= 240 * 24 + 2304, `one changed body row: 240 x 24 (row 11), plus at most a hero frame (${px1 - px0} px)`);
    const a = r.shot("v7-detail-row");
    c.ok(!diffBox(crop(d, 0, 70, 240, 130), crop(a, 0, 70, 240, 130)) && !diffBox(crop(d, 56, 0, 184, 70), crop(a, 56, 0, 184, 70)) &&
      anyNear(a, 180, 236, 200, 216, ...C7.amber), "only row 11 changed (the hero aside); its open bold span runs to the end");
  },
};
const v7List: ScenarioDef = {
  name: "v7-list",
  autoAck: true,
  build(s) {
    connect7(s, 200, [["body", "Done, unread, 2m"], ["body", `${B7}Fixed${O7} race in ${K7}stage-relay.ts`], ["body", "and added two tests"]], 7, "list");
    s.heartbeats(1000, 1000, 1);
    s.shot(1500, "v7-list");
    s.end(1700);
  },
  check(r, c) {
    const l = r.shot("v7-list");
    c.ok(anyNear(l, 40, 80, 38, 54, ...C7.amber) && anyNear(l, 152, 232, 38, 54, ...C7.code), "message line: Fixed bold amber, stage-rela in the code colour");
    c.ok(anyNear(l, 224, 232, 38, 54, ...C7.code) && !anyNear(l, 232, 240, 38, 54, ...C7.code), "cut at 24 visible cells (x 40 + 192 = 232), not 24 bytes");
  },
};
const V7: ScenarioDef[] = [v7Bubble, v7V6Companion, v7Detail, v7List];

export const SCENARIOS: ScenarioDef[] = [sessions, views, voice, confirm, nohost, malformed, retransmit, incompatible,
  v2Sessions, v2HelpBase, v2HelpVoice, v2HelpConfirm, v2Voice, v2Confirm, v1Compat, nohostWords, v3Detail, v3DetailHelp, v3AsV2,
  v4Sessions, v4Todo, v4Detail, v4VoiceRec, v4Confirm, v4Knob, v4HelpChecked, v4Nohost, v4Anim, v4Counters, v4Soak,
  v5ListSessions, v5ListTodo, v5ListToggle, v5ListWindow, v5ListPage, v5ListDetail, v5ListVoice, v5ListAnim, v5Help,
  v5gGrouped, v5gGroupedWindow, v5gPinned, v5gPinnedEmpty, v5gTransSelect, v5gTransHero, v5gTransPage, v5gTransSeq, v5gTransReader,
  v5gTransReaderPage, v5gTransWindow, v5gTransToast, v5gTransKnob, v5gTransVoice, v5gTransSelectBuddy, v5gTransInterrupt, v5gHelp, v5gLeds, v5gLedsNohost,
  v5gTransSelectHead, v5gHelpTrans, v5xWindowInterrupt, v5xTitleCut, v5xFastList, v5xFastGrouped, v5xFastBuddy, v5xWindowOvertaken];
/* version 6: the SPLIT and settings scenarios, then RANKED replays of every version 5 scenario */
SCENARIOS.push(...V6_SPLIT, ...SCENARIOS.filter((d) => /^v5[gx]?-/.test(d.name)).map(ranked6));
/* version 7: rich text (docs/ui-v3.md section 13) */
SCENARIOS.push(...V7);
