// The GROUPED round in the simulator (docs/ui-v3.md section 9): the Grouped list (9.3), LED language v2 (9.9, against
// fixtures/device/led-v2.json and fm1c_led.h once it carries the table) and the transitions (9.10).
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { HostMessage, SlotFlags, SlotState } from "@fm1/device-protocol";
import { BREATH_NS, breathNs, buttonLeds, keyLed, levelAt, KEY_TIMELINES, BUTTON_TIMELINES, type LedLevel } from "../src/leds";
import { applyHostMessage, initialState, type DeviceState, type Slot } from "../src/state";
import { Framebuffer, rgb565 } from "../src/v4/raster";
import { groupedWindow, LIST, renderV4, usesGrouped } from "../src/v4/screen";
import {
  detectTransition,
  FAST_MS,
  PASS_PX,
  rectPx,
  STEP_PX_MAX,
  stepPx,
  T3,
  T4,
  TRANSITION_MS,
  TRANSITION_PX_MAX,
  TransitionScreen,
  VSCROLL,
  vscrollStarts,
  type Transition,
} from "../src/v4/transitions";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const NO: SlotFlags = { selected: false, codex: false, stale: false, pinned: false };

const connected = (): DeviceState => {
  const s = initialState(5);
  return { ...s, link: { ...s.link, phase: "connected", proto: 5 } };
};
const apply = (s: DeviceState, msgs: HostMessage[], at = 0): DeviceState => msgs.reduce((acc, m) => applyHostMessage(acc, m, at), s);

/** Grouped: Pinned (k0), Firmware (k1 failed, k2 working, k3 sub-agent), Docs folded (k4). */
function grouped(selected = 1, layout: "grouped" | "list" | "buddy" = "grouped"): DeviceState {
  const row = (indent: 0 | 1 | 2, start = false, task = false) => (layout === "grouped" ? { row: { indent, start, task } } : {});
  const msgs: HostMessage[] = [
    { kind: "SET_VIEW", view: "sessions", page: 0, pages: 1, title: "RECENT 5", layout },
    { kind: "SET_SLOT", key: 0, state: "idle", flags: { ...NO, pinned: true, selected: selected === 0 }, label: "pinned", title: "pinned chat", age: "2m", ...row(1, true), ...(layout === "grouped" ? { head: { state: "idle", pinned: true, title: "Pinned", count: "all quiet" } } : {}) },
    { kind: "SET_SLOT", key: 1, state: "failed", flags: { ...NO, selected: selected === 1 }, label: "fw a", title: "fw build failed", age: "1m", ...row(1, true), ...(layout === "grouped" ? { head: { state: "failed", pinned: false, title: "Firmware v5", count: "1 need you" } } : {}) },
    { kind: "SET_SLOT", key: 2, state: "working", flags: { ...NO, selected: selected === 2 }, label: "fw b", title: "fw tests", age: "now", ...row(1) },
    { kind: "SET_SLOT", key: 3, state: "idle", flags: { ...NO, codex: true, selected: selected === 3 }, label: "sub", title: "sub agent lint", age: "3m", ...row(2) },
    { kind: "SET_SLOT", key: 4, state: "idle", flags: NO, label: "Docs pass", title: "Docs pass", age: "2d", ...row(0, true, true), ...(layout === "grouped" ? { head: { state: "idle", pinned: false, title: "Docs pass", count: "2 quiet" } } : {}) },
    { kind: "SET_DETAIL", provider: "claude", state: "failed", lines: ["", "", "", "PRESETS read"] },
  ];
  return apply(connected(), msgs);
}

describe("Grouped screen (docs/ui-v3.md section 9.3)", () => {
  test("entries: a header before each start key, no session row for a folded task; the window follows the selection", () => {
    const s = grouped();
    expect(usesGrouped(s)).toBe(true);
    const w = groupedWindow(s);
    expect(w.entries.map((e) => `${e.k}${e.kind}`)).toEqual(["0H", "0S", "1H", "1S", "2S", "3S", "4H"]);
    expect(w.top).toBe(0);
  });

  test("header rows: rule, title, count in the caption colour; session rows indented 8 px per level", () => {
    const fb = renderV4(grouped(), 1000);
    const y0 = LIST.rowsY;
    expect(fb.get(100, y0)).toBe(rgb565([48, 48, 48])); // the rule of the Pinned header
    expect(fb.get(16, y0 + 1)).toBe(rgb565([255, 255, 255])); // its pin dot
    // row 3 (Firmware's first session, selected) is filled; row 5 (the sub-agent) has its mini 16 px in
    expect(fb.get(230, y0 + 3 * 16 + 8)).toBe(rgb565([48, 48, 48]));
    const blankAt = (row: number, x: number): boolean => {
      for (let y = 2; y < 14; y++) if (fb.get(x, y0 + row * 16 + y) !== 0) return false;
      return true;
    };
    expect(blankAt(5, 4)).toBe(true); // indent 2: nothing at the List mini x
    expect(blankAt(5, 21)).toBe(false); // the mini at 4 + 16
  });

  test("layout 2 in view 2 draws the List; with protocol 4 the Buddy screen", () => {
    const s = apply(grouped(), [{ kind: "SET_VIEW", view: "inbox", page: 0, pages: 1, title: "TO DO", layout: "grouped" }]);
    expect(usesGrouped(s)).toBe(false);
    const p4 = { ...grouped(), link: { ...grouped().link, proto: 4 } };
    expect(usesGrouped(p4)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------

const slot = (state: SlotState, selected = false, stale = false): Slot => ({ state, flags: { ...NO, selected, stale }, label: "" });
const at = (s: Slot, ts: number[]): LedLevel[] => ts.map((t) => keyLed(s, t, true, 5));

describe("LED language v2 (docs/ui-v3.md section 9.9)", () => {
  test("unselected timelines per state", () => {
    expect(at(slot("approval_required"), [0, 249, 250, 499, 500])).toEqual(["full", "full", "off", "off", "full"]);
    expect(at(slot("waiting_input"), [0, 119, 120, 240, 360, 1259, 1260])).toEqual(["full", "full", "glow", "full", "glow", "glow", "full"]);
    expect(at(slot("failed"), [0, 1499, 1500, 2999, 3000])).toEqual(["glow", "glow", "off", "off", "glow"]);
    expect(at(slot("completed_unread"), [0, 149, 150, 2499, 2500])).toEqual(["full", "full", "glow", "glow", "full"]);
    expect(at(slot("working"), [0, 777])).toEqual(["full", "full"]);
    expect(at(slot("idle"), [0])).toEqual(["glow"]);
    expect(at(slot("unknown"), [0, 149, 150, 2999, 3000])).toEqual(["off", "off", "glow", "glow", "off"]);
    expect(at(slot("idle", false, true), [0, 149, 150, 3999])).toEqual(["glow", "glow", "off", "off"]);
    expect(at(slot("empty"), [0])).toEqual(["off"]);
  });

  test("selected: breathing, the L windows of approval/question break through, failed dips", () => {
    expect(at(slot("idle", true), [0, 500])).toEqual(["breath", "breath"]);
    expect(at(slot("approval_required", true), [0, 260])).toEqual(["full", "breath"]);
    expect(at(slot("failed", true), [0, 149, 150, 2849, 2850])).toEqual(["off", "off", "breath", "breath", "off"]);
    expect(at(slot("completed_unread", true), [0])).toEqual(["breath"]);
    expect(keyLed(slot("working", true), 0, false, 5)).toBe("breath");
    expect(keyLed(slot("working"), 0, false, 5)).toBe("glow");
  });

  test("breathing: the raised-cosine table of the spec, mirrored over 3,000 ms, one step every 20 ms, never dark", () => {
    const doc = readFileSync(`${ROOT}docs/ui-v3.md`, "utf8");
    const m = /FM1C_BREATH_NS\[76\] = \{([\s\S]*?)\};/.exec(doc.slice(doc.indexOf("## 9.")));
    const table = (m?.[1] ?? "").split(",").map((x) => x.trim()).filter(Boolean).map(Number);
    expect(table).toEqual([...BREATH_NS]);
    expect([breathNs(0), breathNs(1500), breathNs(3000), breathNs(19), breathNs(20)]).toEqual([12000, 48000, 12000, 12000, BREATH_NS[1] ?? -1]);
    for (let t = 0; t < 3000; t += 20) expect(breathNs(t)).toBe(breathNs(t + 3000));
    expect(Math.min(...BREATH_NS)).toBe(12000);
  });

  test("buttons: SEQ glows in List/Grouped, SAVE double-blinks for an approval, GLO ticks, REC blinks sharp", () => {
    const g = grouped();
    expect(buttonLeds(g, 0).SEQ).toBe("glow");
    const approval = apply(g, [{ kind: "SET_DETAIL", provider: "claude", state: "approval_required", lines: ["", "", "", ""] }]);
    expect([0, 130, 240, 400].map((t) => buttonLeds(approval, t).SAVE)).toEqual(["full", "off", "full", "off"]);
    const att = apply(g, [{ kind: "SET_STATUS", link: "ok", attentionCount: 3, text: "" }]);
    expect([0, 150, 2500].map((t) => buttonLeds(att, t).GLO)).toEqual(["full", "off", "full"]);
    const tr = apply(g, [{ kind: "SET_VOICE", voice: "transcribing", level: 0, elapsedDs: 0, target: "" }]);
    expect([0, 250].map((t) => buttonLeds(tr, t).REC)).toEqual(["full", "off"]);
  });

  test("fixtures/device/led-v2.json matches the simulator (the firmware's host-mode LED checks read the same file)", () => {
    const f = JSON.parse(readFileSync(`${ROOT}fixtures/device/led-v2.json`, "utf8")) as {
      breathNs: number[];
      keys: { name: string; state: SlotState; selected: boolean; stale: boolean; samples: [number, LedLevel][] }[];
      buttons: { name: string; samples: [number, LedLevel][] }[];
    };
    expect(f.breathNs).toEqual([...BREATH_NS]);
    for (const k of f.keys) for (const [t, l] of k.samples) expect(`${k.name}@${t}:${keyLed(slot(k.state, k.selected, k.stale), t, true, 5)}`).toBe(`${k.name}@${t}:${l}`);
    const tl = { ...BUTTON_TIMELINES } as Record<string, Parameters<typeof levelAt>[0]>;
    for (const b of f.buttons) for (const [t, l] of b.samples) expect(`${b.name}@${t}:${levelAt(tl[b.name] ?? "off", t)}`).toBe(`${b.name}@${t}:${l}`);
    expect(Object.keys(KEY_TIMELINES).length).toBeGreaterThan(5);
  });

  test("buttons: active controls glow dim steady per view / voice / SET_DETAIL.state (section 9.9); patterns unchanged", () => {
    const s0 = initialState(6);
    const st = (view: DeviceState["view"]["view"], voice: DeviceState["voice"]["voice"], d: SlotState): DeviceState => ({
      ...s0,
      link: { ...s0.link, phase: "connected", proto: 6 },
      view: { ...s0.view, view },
      voice: { ...s0.voice, voice },
      detail: { ...s0.detail, state: d },
    });
    const lit = (s: DeviceState, t = 130): string => Object.entries(buttonLeds(s, t)).filter(([, l]) => l !== "off").map(([b, l]) => `${b}:${l}`).sort().join(" ");
    expect(lit(st("voice", "recording", "idle"))).toBe("FX:glow REC:full");
    expect(lit(st("voice", "transcribing", "idle"), 300)).toBe("FX:glow");
    expect(lit(st("voice", "reviewing", "idle"), 0)).toBe("ARP:glow FX:glow SAVE:full");
    expect(lit(st("voice", "reviewing", "working"), 130)).toBe("ARP:glow FX:glow"); // the double's dark phase stays off; no REC, no ENV
    expect(lit(st("voice", "failed", "idle"))).toBe("FX:glow PLAY:glow");
    expect(lit(st("voice", "target_unavailable", "idle"))).toBe("FX:glow");
    expect(lit(st("voice", "submitting", "approval_required"))).toBe("");
    expect(lit(st("confirm", "reviewing", "idle"), 0)).toBe("FX:glow SAVE:full");
    expect(lit(st("detail", "ready", "idle"))).toBe("HOME:glow LFO:full PLAY:glow");
    expect(lit(st("detail", "ready", "approval_required"), 0)).toBe("ENV:glow FX:glow HOME:glow LFO:full PLAY:glow SAVE:full");
    expect(lit(st("detail", "ready", "disconnected"))).toBe("HOME:glow LFO:full");
    expect(lit(st("settings", "ready", "empty"))).toBe("ARP:full HOME:glow LFO:glow SAVE:glow");
    expect(lit(st("sessions", "ready", "empty"))).toBe("HOME:full");
    expect(lit(st("sessions", "ready", "idle"))).toBe("HOME:full PLAY:glow");
    expect(lit(st("sessions", "ready", "working"))).toBe("ENV:glow HOME:full PLAY:glow");
    expect(lit(st("sessions", "ready", "approval_required"), 0)).toBe("ENV:glow FX:glow HOME:full PLAY:glow SAVE:full");
    expect(lit(st("inbox", "ready", "completed_unread"))).toBe("FX:glow GLO:full PLAY:glow");
    expect(lit(st("inbox", "ready", "waiting_input"))).toBe("ENV:glow FX:glow GLO:full PLAY:glow");
    expect(lit(st("tasks", "ready", "empty"))).toBe("EDIT:full");
    expect(lit(st("tasks", "ready", "working"))).toBe("EDIT:full PLAY:glow");
    // never breathing; protocol <= 4 and no host unchanged
    for (const v of ["sessions", "tasks", "inbox", "voice", "confirm", "detail", "settings"] as const)
      for (const t of [0, 130, 250, 400]) expect(Object.values(buttonLeds(st(v, "reviewing", "approval_required"), t))).not.toContain("breath");
    const v4 = { ...st("sessions", "ready", "working"), link: { ...s0.link, phase: "connected" as const, proto: 4 } };
    expect(Object.values(buttonLeds(v4, 0))).not.toContain("glow");
    const nohost = { ...st("detail", "ready", "working"), link: { ...s0.link, phase: "no_host" as const } };
    expect(lit(nohost, 0)).toBe("OCT_UP:full");
  });

  test("fixtures/device/led-v2.json buttonMatrix matches buttonLedsV2 (the firmware's led_test.c reads the same rows)", () => {
    const f = JSON.parse(readFileSync(`${ROOT}fixtures/device/led-v2.json`, "utf8")) as {
      buttonMatrix: { times: number[]; buttons: string[]; rows: { view: DeviceState["view"]["view"]; voice: DeviceState["voice"]["voice"]; dstate: SlotState; levels: string[] }[] };
    };
    const ch: Record<LedLevel, string> = { off: ".", glow: "g", full: "F", breath: "B" };
    const s0 = initialState(6);
    expect(f.buttonMatrix.rows.length).toBe(7 * 9 * 10);
    for (const r of f.buttonMatrix.rows) {
      const s: DeviceState = { ...s0, link: { ...s0.link, phase: "connected", proto: 6 }, view: { ...s0.view, view: r.view }, voice: { ...s0.voice, voice: r.voice }, detail: { ...s0.detail, state: r.dstate } };
      const got = f.buttonMatrix.times.map((t) => { const b = buttonLeds(s, t); return f.buttonMatrix.buttons.map((id) => ch[b[id as keyof typeof b]]).join(""); });
      expect(`${r.view}/${r.voice}/${r.dstate}: ${got.join(" ")}`).toBe(`${r.view}/${r.voice}/${r.dstate}: ${r.levels.join(" ")}`);
    }
  });

  const LED_H = `${ROOT}firmware/firmware/src/fm1c_led.h`;
  const led = existsSync(LED_H) ? readFileSync(LED_H, "utf8") : "";
  test.if(led.includes("FM1C_BREATH_NS"))("firmware fm1c_led.h carries the same FM1C_BREATH_NS", () => {
    const m = /FM1C_BREATH_NS\s*\[\s*\d*\s*\]\s*=\s*\{([\s\S]*?)\};/.exec(led);
    expect((m?.[1] ?? "").split(",").map((x) => x.trim()).filter(Boolean).map((x) => Number(x.replace(/u$/i, "")))).toEqual([...BREATH_NS]);
  });
});

// ---------------------------------------------------------------------------------------------------------------

/** Every step paints only inside its own rectangles; budgets and schedules hold. */
function checkTransition(t: Transition, prev: DeviceState, next: DeviceState): void {
  const budgeted = t.steps.filter((s) => !s.content);
  expect([3, 4]).toContain(budgeted.length);
  expect(budgeted.map((s) => s.at)).toEqual(budgeted.length === 3 ? [...T3] : [...T4]);
  let total = 0;
  for (const s of budgeted) {
    for (const r of s.rects) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(240);
      expect(r.y + r.h).toBeLessThanOrEqual(240);
    }
    expect(stepPx(s)).toBeLessThanOrEqual(STEP_PX_MAX);
    total += stepPx(s);
  }
  expect(total).toBeLessThanOrEqual(TRANSITION_PX_MAX);
  expect(t.end - t.t0).toBe(TRANSITION_MS);
  // paint containment
  const old = renderV4(prev, t.t0);
  const fb = new Framebuffer();
  fb.px.set(old.px);
  for (const s of t.steps) {
    const before = fb.px.slice();
    s.paint(fb, { old, fresh: renderV4(next, t.t0 + s.at), plain: () => renderV4(next, t.t0 + s.at, undefined, { noHighlight: true }), state: next, t: t.t0 + s.at });
    for (let i = 0; i < before.length; i++) {
      if (before[i] === fb.px[i]) continue;
      const x = i % 240;
      const y = Math.floor(i / 240);
      const inside = (r: { x: number; y: number; w: number; h: number }): boolean => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
      expect(s.rects.some(inside) || (s.scroll !== undefined && inside(s.scroll))).toBe(true);
    }
  }
  // the last step leaves the panel as the new state draws it, inside the regions the transition touched
  const fresh = renderV4(next, t.t0 + (t.steps.at(-1)?.at ?? 0));
  const last = t.steps.at(-1);
  if (last && !last.content) for (const r of last.rects) for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) expect(fb.get(x, y)).toBe(fresh.get(x, y));
  expect(PASS_PX).toBe(2400);
}

const many = (n: number, selected: number, layout: "list" | "buddy" = "list", page = 0): DeviceState => {
  const msgs: HostMessage[] = [{ kind: "SET_VIEW", view: "sessions", page, pages: 3, title: "ALL", layout }];
  for (let k = 0; k < n; k++) msgs.push({ kind: "SET_SLOT", key: k, state: k % 3 === 0 ? "failed" : "idle", flags: { ...NO, selected: k === selected }, label: `c${k}`, title: `chat ${k}`, age: `${k}m` });
  msgs.push({ kind: "SET_DETAIL", provider: "claude", state: "idle", lines: ["", "", "", "hint"] });
  return apply(connected(), msgs);
};

describe("transitions (docs/ui-v3.md section 9.10)", () => {
  test("selection inside the window slides (List and Grouped); across windows the list scrolls in hardware", () => {
    const a = many(14, 1);
    const b = many(14, 6);
    const t = detectTransition(a, b, 1000);
    expect(t?.kind).toBe("select-list");
    if (t) checkTransition(t, a, b);
    const c = many(14, 12);
    const w = detectTransition(b, c, 1000);
    expect(w?.kind).toBe("window-scroll");
    if (w) checkTransition(w, b, c);
    const gs = detectTransition(grouped(1), grouped(3), 0);
    expect(gs?.kind).toBe("select-list");
    if (gs) checkTransition(gs, grouped(1), grouped(3));
  });

  test("Buddy strip slide, hero pop, page wipe, layout wipe", () => {
    const a = many(14, 1, "buddy");
    const b = many(14, 9, "buddy");
    const s = detectTransition(a, b, 0);
    expect(s?.kind).toBe("select-strip");
    if (s) checkTransition(s, a, b);
    const hero = apply(a, [{ kind: "SET_DETAIL", provider: "claude", state: "working", lines: ["", "", "", ""] }]);
    const h = detectTransition(a, hero, 0);
    expect(h?.kind).toBe("hero");
    if (h) checkTransition(h, a, hero);
    const p2 = apply(a, [{ kind: "SET_VIEW", view: "sessions", page: 1, pages: 3, title: "ALL", layout: "buddy" }]);
    const pw = detectTransition(a, p2, 0);
    expect(pw?.kind).toBe("page-wipe");
    if (pw) checkTransition(pw, a, p2);
    const lp = apply(many(14, 1), [{ kind: "SET_VIEW", view: "sessions", page: 1, pages: 3, title: "ALL", layout: "list" }]);
    const lw = detectTransition(many(14, 1), lp, 0);
    expect(lw?.kind).toBe("page-wipe");
    if (lw) checkTransition(lw, many(14, 1), lp);
    const lay = detectTransition(many(14, 1), grouped(1), 0);
    expect(lay?.kind).toBe("layout-wipe");
    if (lay) checkTransition(lay, many(14, 1), grouped(1));
  });

  test("reader open/close outlines then the content; reader pages scroll in hardware back to the identity mapping", () => {
    const base = many(5, 1);
    const reader = apply(base, [{ kind: "SET_VIEW", view: "detail", page: 0, pages: 3, title: "DETAILS" }]);
    const o = detectTransition(base, reader, 0);
    expect(o?.kind).toBe("reader-open");
    expect(o?.steps.at(-1)?.content).toBe(true);
    if (o) checkTransition(o, base, reader);
    const c = detectTransition(reader, base, 0);
    expect(c?.kind).toBe("reader-close");
    if (c) checkTransition(c, reader, base);
    const p1 = apply(reader, [{ kind: "SET_VIEW", view: "detail", page: 1, pages: 3, title: "DETAILS" }]);
    const sc = detectTransition(reader, p1, 0);
    expect(sc?.kind).toBe("reader-scroll");
    if (sc) checkTransition(sc, reader, p1);
    expect(vscrollStarts(VSCROLL.reader, true)).toEqual([110, 148, 186, 72]);
    expect(vscrollStarts(VSCROLL.reader, false)).toEqual([186, 148, 110, 72]);
    expect(vscrollStarts(VSCROLL.list, true).at(-1)).toBe(62);
    expect(VSCROLL.reader.tfa + VSCROLL.reader.vsa + 96).toBe(320);
    expect(VSCROLL.list.tfa + VSCROLL.list.vsa + 98).toBe(320);
  });

  test("hardware scroll frames: halfway the old area has moved up by half, the new half below", () => {
    const reader = apply(many(5, 1), [{ kind: "SET_VIEW", view: "detail", page: 0, pages: 3, title: "DETAILS" }, { kind: "SET_TEXT", row: 3, lines: [{ style: "body", text: "page zero line" }] }]);
    const p1 = apply(reader, [{ kind: "SET_TEXT", row: 3, lines: [{ style: "body", text: "page one line" }] }, { kind: "SET_VIEW", view: "detail", page: 1, pages: 3, title: "DETAILS" }]);
    const scr = new TransitionScreen(reader, 0);
    scr.apply(p1, 1000);
    const oldFb = renderV4(reader, 1000);
    const newFb = renderV4(p1, 1020);
    const mid = scr.frame(1020); // step 2: shift 76
    for (const y of [72, 100, 140]) for (const x of [10, 60, 120]) expect(mid.get(x, y)).toBe(oldFb.get(x, y + 76));
    for (const y of [148, 180, 223]) for (const x of [10, 60, 120]) expect(mid.get(x, y)).toBe(newFb.get(x, y - 76));
    expect(scr.frame(1200).px).toEqual(renderV4(p1, 1200).px);
  });

  test("toast slides in and out; the knob row slides in; input completes a running transition at once", () => {
    const a = many(5, 1);
    const scr = new TransitionScreen(a, 0);
    const toast = applyHostMessage(a, { kind: "COMMAND_RESULT", reqSeq: 1, result: "completed", text: "Done" }, 1000);
    expect(scr.apply(toast, 1000)?.kind).toBe("toast-in");
    expect(scr.log.at(-1) && scr.log.at(-1)?.steps.every((s) => s.rects.every((r) => rectPx(r) === 3840))).toBe(true);
    scr.frame(3010);
    expect(scr.log.map((l) => l.kind)).toEqual(["toast-in", "toast-out"]);
    expect(scr.log.at(-1)?.t0).toBe(3000);
    const knob = { ...toast, local: { ...toast.local, knobLit: 0, knobUntilMs: 6000 } };
    expect(scr.apply(knob, 4000)?.kind).toBe("knob-in");
    // interruption: a page wipe, a key press 40 ms in
    const b = many(14, 1);
    const wipe = new TransitionScreen(b, 0);
    const p = apply(b, [{ kind: "SET_VIEW", view: "sessions", page: 1, pages: 3, title: "ALL", layout: "list" }]);
    expect(wipe.apply(p, 1000)?.kind).toBe("page-wipe");
    expect(wipe.frame(1030).px).not.toEqual(renderV4(p, 1030).px);
    wipe.input(1040);
    expect(wipe.frame(1040).px).toEqual(renderV4(p, 1040).px);
  });

  test("a change during a transition starts none (drawn after the end); version 4 never animates", () => {
    const a = many(14, 1);
    const scr = new TransitionScreen(a, 0);
    const b = many(14, 6);
    expect(scr.apply(b, 1000)?.kind).toBe("select-list");
    const c = many(14, 8);
    expect(scr.apply(c, 1050)).toBeNull();
    expect(scr.frame(1130).px).toEqual(renderV4(c, 1130).px);
    const v4a = { ...a, link: { ...a.link, proto: 4 } };
    const v4b = { ...b, link: { ...b.link, proto: 4 } };
    expect(detectTransition(v4a, v4b, 0)).toBeNull();
  });
});

describe("fast scroll (docs/ui-v3.md section 9.10.1, the firmware's FM1C_TR_FAST_MS)", () => {
  test("presses closer than 150 ms draw every change at once; a slow single move still slides", () => {
    expect(FAST_MS).toBe(150);
    const scr = new TransitionScreen(many(14, 1), 0);
    scr.input(990, true);
    expect(scr.apply(many(14, 2), 1000)?.kind).toBe("select-list"); // (the first press: nothing before it)
    let t = 1020;
    for (const k of [3, 4, 5, 6, 7, 12, 11, 10]) {
      scr.input(t, true); // a SELECT step 20-60 ms after the previous one
      expect(scr.apply(many(14, k), t + 6)).toBeNull();
      expect(scr.frame(t + 7).px).toEqual(renderV4(many(14, k), t + 7).px);
      t += 20 + ((k * 13) % 41);
    }
    expect(scr.log.map((l) => l.kind)).toEqual(["select-list"]);
    // a release is no press; FAST_MS after the last press transitions start again
    scr.input(t, false);
    scr.input(t + 400, true);
    expect(scr.apply(many(14, 11), t + 406)?.kind).toBe("select-list");
  });

  test("a key down counts, its release does not: a tap-tap 100 ms apart is a fast scroll, one tap is not", () => {
    const scr = new TransitionScreen(many(14, 1), 0);
    scr.input(1000, true);
    scr.input(1060, false);
    expect(scr.apply(many(14, 2), 1010)?.kind).toBe("select-list");
    scr.input(1100, true);
    expect(scr.apply(many(14, 4), 1110)).toBeNull();
    expect(scr.frame(1111).px).toEqual(renderV4(many(14, 4), 1111).px);
  });
});

describe("review fixes: transitions and toast as the firmware draws them (docs/ui-v3.md section 9.10)", () => {
  test("the toast fills the hint bar with the result colour (fm1c_toast_in), dark text on a light bar", () => {
    const a = many(5, 1);
    const done = applyHostMessage(a, { kind: "COMMAND_RESULT", reqSeq: 1, result: "completed", text: "Pinned" }, 1000);
    const fb = renderV4(done, 1100);
    expect(fb.get(236, 230)).toBe(rgb565([32, 192, 96]));
    const failed = renderV4(applyHostMessage(a, { kind: "COMMAND_RESULT", reqSeq: 2, result: "failed", text: "" }, 1000), 1100);
    expect(failed.get(236, 230)).toBe(rgb565([240, 48, 48]));
  });

  test("a slide-out starts from the panel that still shows the toast", () => {
    const a = many(5, 1);
    const scr = new TransitionScreen(a, 0);
    const toast = applyHostMessage(a, { kind: "COMMAND_RESULT", reqSeq: 1, result: "completed", text: "Done" }, 1000);
    scr.apply(toast, 1000);
    const step1 = scr.frame(3010); // toast drawn 5 px lower: its bar colour still fills y 229-239
    expect(step1.get(236, 236)).toBe(rgb565([32, 192, 96]));
  });

  test("frames of one burst: a later trigger replaces an earlier one; old content is the panel before the burst", () => {
    const a = many(14, 1);
    const scr = new TransitionScreen(a, 0);
    const hero = apply(a, [{ kind: "SET_DETAIL", provider: "claude", state: "working", lines: ["", "", "", ""] }]);
    expect(scr.apply(hero, 998)?.kind).toBe("hero");
    const page = apply(hero, [{ kind: "SET_VIEW", view: "sessions", page: 1, pages: 3, title: "ALL", layout: "list" }]);
    expect(scr.apply(page, 1000)?.kind).toBe("page-wipe");
    expect(scr.log.map((l) => l.kind)).toEqual(["page-wipe"]);
    // outside the first step's columns the panel is still the pre-burst one (the hero not yet redrawn)
    expect(scr.frame(1010).px.slice(0, 240 * 60)).toEqual(renderV4(a, 997).px.slice(0, 240 * 60));
    // with an idle link between them they are two transitions: the second waits for the end of the first
    const scr2 = new TransitionScreen(a, 0);
    scr2.apply(hero, 900, 900);
    expect(scr2.apply(page, 1000, 990)).toBeNull();
  });
});
