// Regression tests from the adversarial review of UX v2 (docs/ux-v2.md). Each test names the defect it pins.
import { describe, expect, test } from "bun:test";
import type { ButtonName, EncoderName, KeyGesture } from "../src/controls";
import { keyOf, REC_HOLD, refOf, rig, slotOf, type Rig } from "./helpers";
import { MAX_PINS_PER_KIND } from "../src/focus";
import { isSessionKey, isTaskKey } from "../src/identity";

const press = (r: Rig, button: ButtonName) => r.console.handleInput({ kind: "button", button, edge: "down" });
// REC is held past the short-tap window (docs/ui-v3.md section 11) so its release stops a real recording.
const release = (r: Rig, button: ButtonName) => {
  if (button === "REC") r.timers.advance(REC_HOLD);
  return r.console.handleInput({ kind: "button", button, edge: "up" });
};
const key = (r: Rig, k: number, gesture: KeyGesture = "single") => r.console.handleInput({ kind: "key", key: k, gesture });
const turn = (r: Rig, encoder: EncoderName, delta = 1) => r.console.handleInput({ kind: "encoder", encoder, delta });
const HOUR = 3_600_000;

describe("UX v2 review: talk targets match what the screen shows", () => {
  test("TO DO with nothing selected: REC does not reply to the hidden Sessions selection", async () => {
    const r = await rig("mixed", { scope: "recent" });
    await key(r, slotOf(r, "s-claude-idle"));
    expect(r.console.registry.selection().key).toBe(keyOf(r, "s-claude-idle"));
    await press(r, "GLO");
    expect(r.console.state.inboxCursor).toBeNull();
    expect(r.console.view().detail.state).toBe("empty"); // the screen says "nothing selected"
    const actions = await press(r, "REC");
    expect(actions.some((a) => a.type === "voiceStart")).toBe(false);
    expect(r.console.composer.state.state).not.toBe("recording");
    expect(r.console.state.notice).toEqual({ stage: "target_unavailable", text: "Select a chat first" });
  });

  test("Tasks view: REC opens a chat in the task under the cursor, not the older TASK filter", async () => {
    const r = await rig();
    await press(r, "EDIT");
    await key(r, r.console.view().slots.findIndex((x) => x.label === "Firmware app")); // Sessions filtered to it
    expect(r.console.state.taskFilter).toContain("task-fw");
    await press(r, "EDIT"); // the repo filter now lists Firmware app and Voice composer
    const voice = r.console.view().slots.findIndex((x) => x.label === "Voice");
    expect(voice).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < 5 && r.console.view().slots[voice]?.selected !== true; i++) await turn(r, "SELECT", 1);
    expect(r.console.view().slots[voice]?.selected).toBe(true);
    expect(r.console.state.taskFilter).toContain("task-fw"); // still set from the earlier tap
    await press(r, "REC");
    const dest = r.console.composer.state.destination;
    expect(dest?.label).toBe("new chat: Voice");
    if (dest?.mode === "new-session") expect(dest.task.taskId).toBe("task-voice");
    else throw new Error(`expected a new chat, got ${dest?.mode}`);
    await release(r, "REC");
    // PLAY (new chat) agrees with REC
    await press(r, "FX");
    await press(r, "PLAY");
    const c = r.console.state.confirm;
    expect(c?.type === "createSession" && c.taskKey).toContain("task-voice");
  });
});

describe("UX v2 review: dismiss", () => {
  test("FX dismiss on a question hides it from TO DO and the badge, as the toast says", async () => {
    const r = await rig();
    await press(r, "GLO");
    const q = r.console.view().slots.findIndex((s) => s.state === "waiting_input");
    await key(r, q);
    expect(r.console.view().detail.lines[3]).toBe("FX dismiss PLAY open");
    await press(r, "FX");
    expect(r.console.state.notice?.text).toBe("Dismissed, FX undo");
    await press(r, "GLO"); // re-sort
    expect(r.console.view().slots.some((s) => s.state === "waiting_input")).toBe(false);
    // a new question of the same session comes back
    r.adapter.setState(refOf(r, "s-claude-refund"), "working");
    r.adapter.setState(refOf(r, "s-claude-refund"), "waiting_input");
    await press(r, "GLO");
    expect(r.console.view().slots.some((s) => s.state === "waiting_input")).toBe(true);
  });
});

describe("UX v2 review: auto re-sort and periodic refresh", () => {
  test("tick pushes the view when only time changed it (a result ages out of the badge)", async () => {
    const r = await rig();
    const seen: number[] = [];
    r.console.onView((v) => seen.push(v.status.attentionCount));
    const before = r.console.view().status.attentionCount;
    r.timers.advance(73 * HOUR);
    await turn(r, "PRESETS", 1); // recent input: no auto re-sort
    seen.length = 0;
    r.timers.advance(5000);
    r.console.tick();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)).toBeLessThan(before);
  });

  test("no auto re-sort while SCL is held (the firmware shows the help overlay)", async () => {
    const r = await rig("mixed", { scope: "recent" });
    await press(r, "SEL");
    const layout = JSON.stringify(r.console.state.layouts.sessions.slots);
    r.adapter.setState(refOf(r, "s-claude-idle"), "failed"); // arrival placed, order would change
    r.timers.advance(10 * 60_000);
    expect(r.console.tick()).toBe(false);
    expect(JSON.stringify(r.console.state.layouts.sessions.slots)).not.toBe("");
    await release(r, "SEL");
    r.timers.advance(61_000);
    expect(r.console.tick()).toBe(true);
    expect(JSON.stringify(r.console.state.layouts.sessions.slots)).not.toBe(layout);
  });
});

describe("UX v2 review: hint names the control that does it here", () => {
  test("a stale TO DO item says GLO re-sorts (HOME would leave TO DO)", async () => {
    const r = await rig();
    await press(r, "GLO");
    const failed = r.console.view().slots.findIndex((s) => s.state === "failed");
    await key(r, failed);
    r.adapter.removeSession(refOf(r, "s-claude-voice"));
    const v = r.console.view();
    expect(v.view).toBe("inbox");
    expect(v.detail.lines[3]).toBe("GLO re-sorts");
  });

  test("a stale Sessions item still says HOME re-sorts", async () => {
    const r = await rig();
    await key(r, slotOf(r, "s-claude-voice"));
    r.adapter.removeSession(refOf(r, "s-claude-voice"));
    expect(r.console.view().detail.lines[3]).toBe("HOME re-sorts");
  });

  test("Tasks view with TALK on Claude task: the new task goes to the cursor task's repo", async () => {
    const r = await rig();
    await key(r, slotOf(r, "s-claude-fw")); // Sessions selection in proj-console
    await press(r, "EDIT");
    const refund = r.console.view().slots.findIndex((x) => x.label === "Refund");
    expect(refund).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < 5 && r.console.view().slots[refund]?.selected !== true; i++) await turn(r, "SELECT", 1);
    expect(r.console.view().slots[refund]?.selected).toBe(true);
    while (r.console.state.talk !== "claude-task") await turn(r, "K4", 1);
    await press(r, "REC");
    const dest = r.console.composer.state.destination;
    if (dest?.mode === "new-task") expect(dest.project.projectId).toBe("proj-api");
    else throw new Error(`expected a new task, got ${dest?.mode}`);
    await release(r, "REC");
  });
});

describe("UX v2 review: TO DO keys stay put between re-sorts", () => {
  test("a TO DO item whose session disappears keeps its key, crossed, and stays selected", async () => {
    const r = await rig();
    await press(r, "GLO");
    const failed = r.console.view().slots.findIndex((s) => s.state === "failed");
    await key(r, failed);
    const before = [...r.console.state.layouts.inbox.slots];
    r.adapter.removeSession(refOf(r, "s-claude-voice"));
    const v = r.console.view();
    expect(r.console.state.layouts.inbox.slots).toEqual(before);
    expect(v.slots[failed]).toMatchObject({ stale: true, selected: true, label: "voice tests" });
    expect(v.detail.lines[3]).toBe("GLO re-sorts");
    expect((await press(r, "FX")).some((a) => a.type === "dismiss")).toBe(false);
    await press(r, "GLO"); // re-sort drops it, and the detail no longer shows it
    expect(r.console.view().slots.some((s) => s.label === "voice tests")).toBe(false);
    expect(r.console.view().detail.state).toBe("empty");
  });

  test("an answered approval keeps its TO DO key with the session's new state", async () => {
    const r = await rig();
    await press(r, "GLO");
    expect(r.console.view().slots[0]?.state).toBe("approval_required");
    await key(r, 0);
    await press(r, "SAVE"); // approve? -> confirm
    await press(r, "SAVE"); // yes
    expect(r.console.registry.approval("appr-1")).toBeUndefined();
    const v = r.console.view();
    expect(v.slots[0]?.label).toBe("fw review");
    expect(v.slots[0]?.state).not.toBe("approval_required");
    expect(v.slots[0]?.stale).toBe(false);
    await press(r, "SAVE"); // nothing pending any more: no second decision
    expect(r.adapter.approvalCalls).toHaveLength(1);
  });
});

import { AgentConsole } from "../src/console";
import { BUTTONS, ENCODERS } from "../src/controls";
import { fixtureToSnapshot, type FixtureFile } from "../src/fixtures";
import { MockAdapter } from "../src/mock-adapter";
import { toastFor } from "../src/copy";
import { LIMITS } from "../src/view";

const STATES = ["approval_required", "waiting_input", "failed", "completed_unread", "completed_read", "working", "idle", null] as const;
const WEIRD = ["Ünïcødé tîtle with ✓ marks", "日本語のタイトル", "a", "", "x".repeat(55), "fix: the_thing -- now => ok", "  spaced   out  ", "emoji 🚀🚀 rocket build"];

function rng(seed: number): () => number {
  let x = seed >>> 0 || 1;
  return () => ((x = (x * 1103515245 + 12345) >>> 0) / 2 ** 32);
}

function fuzzFixture(n: number, r: () => number, epoch: number): FixtureFile {
  const projects = [0, 1, 2].map((i) => ({ projectId: `p${i}`, name: WEIRD[(i * 3) % WEIRD.length] || `repo ${i}` }));
  const tasks = Array.from({ length: 6 }, (_, i) => ({ projectId: `p${i % 3}`, taskId: `t${i}`, title: WEIRD[(i + 1) % WEIRD.length] ?? "", updatedAt: epoch - i }));
  const sessions = Array.from({ length: n }, (_, i) => {
    const t = tasks[Math.floor(r() * tasks.length)] ?? tasks[0]!;
    const st = STATES[Math.floor(r() * STATES.length)] ?? null;
    return {
      projectId: t.projectId, taskId: t.taskId, sessionId: `s${i}`, title: WEIRD[Math.floor(r() * WEIRD.length)] ?? "", provider: r() < 0.5 ? "claude" : "codex",
      runtime: "chat", workspace: "/w", createdAt: epoch - Math.floor(r() * 30 * 24) * 3_600_000, summary: r() < 0.5 ? WEIRD[Math.floor(r() * WEIRD.length)] : undefined,
      observed: { state: st, at: epoch - 1000 },
    };
  });
  const approvals = sessions.filter((s) => s.observed.state === "approval_required").map((s, i) => ({ id: `a${i}`, projectId: s.projectId, taskId: s.taskId, sessionId: s.sessionId, summary: WEIRD[i % WEIRD.length] ?? "", createdAt: s.createdAt }));
  return { name: "fuzz", backendId: "b", hostId: "h", projects, tasks, sessions, approvals };
}

const ascii = (s: string): boolean => /^[\x20-\x7e]*$/.test(s);

describe("UX v2 review: fuzzed views stay inside the protocol limits", () => {
  for (const n of [0, 1, 30, 279]) {
    test(`${n} sessions, random input: ASCII, limits, no duplicate keys, one selection`, async () => {
      const r = rng(n + 7);
      const epoch = 1_800_000_000_000;
      let clock = epoch;
      const adapter = new MockAdapter(fixtureToSnapshot(fuzzFixture(n, r, epoch)));
      const c = new AgentConsole({ adapter, now: () => clock });
      await c.start();
      for (let i = 0; i < 400; i++) {
        const pick = r();
        if (pick < 0.35) await c.handleInput({ kind: "encoder", encoder: ENCODERS[Math.floor(r() * ENCODERS.length)]!, delta: r() < 0.5 ? 1 : -1 });
        else if (pick < 0.6) {
          const b = BUTTONS[Math.floor(r() * BUTTONS.length)]!;
          await c.handleInput({ kind: "button", button: b, edge: "down" });
          await c.handleInput({ kind: "button", button: b, edge: "up" });
        } else if (pick < 0.85) await c.handleInput({ kind: "key", key: Math.floor(r() * 27), gesture: (["single", "double", "long"] as const)[Math.floor(r() * 3)]! });
        else if (pick < 0.95 && n > 0) adapter.setState({ backendId: "b", hostId: "h", projectId: "p0", taskId: "t0", sessionId: `s${Math.floor(r() * n)}` }, STATES[Math.floor(r() * STATES.length)] ?? null);
        else {
          clock += Math.floor(r() * 10 * 3_600_000);
          c.tick(clock);
        }
        await c.idle();
        const v = c.view();
        const strings = [v.title, v.status.text, v.voice.target, ...v.legend, ...v.detail.lines, ...v.slots.map((s) => s.label)];
        for (const s of strings) expect(ascii(s)).toBe(true);
        // our own copy (user titles may contain anything ASCII): legend, status text, the hint line
        const ours = [...v.legend, v.status.text, ...(v.view === "confirm" ? [] : [v.detail.lines[3]])];
        for (const s of ours) expect(`${v.view}:${s}`).not.toMatch(/--|_|=|->|\b[SFRP]:/);
        expect(v.title.length).toBeLessThanOrEqual(LIMITS.title);
        expect(v.status.text.length).toBeLessThanOrEqual(LIMITS.status);
        for (const l of v.detail.lines) expect(l.length).toBeLessThanOrEqual(LIMITS.line);
        for (const l of v.legend) expect(l.length).toBeLessThanOrEqual(LIMITS.legend);
        for (const s of v.slots) expect(s.label.length).toBeLessThanOrEqual(LIMITS.label);
        expect(v.slots.filter((s) => s.selected).length).toBeLessThanOrEqual(1);
        expect(v.page).toBeLessThan(v.pages);
        const n0 = c.state.notice?.text ?? "";
        expect(ascii(n0) && n0.length <= 20).toBe(true);
        for (const res of c.results) {
          const t = toastFor(res.stage, res.message, res.action);
          expect(ascii(t) && t.length <= 20).toBe(true);
        }
        for (const view of ["sessions", "tasks", "inbox"] as const) {
          const keys = c.state.layouts[view].slots.filter((k) => k !== null);
          expect(new Set(keys).size).toBe(keys.length);
        }
        expect(c.state.pins.filter(isSessionKey).length).toBeLessThanOrEqual(MAX_PINS_PER_KIND);
        expect(c.state.pins.filter(isTaskKey).length).toBeLessThanOrEqual(MAX_PINS_PER_KIND);
      }
    });
  }
});

describe("UX v2 review: legend cells match the knob bindings", () => {
  const strip = (s: object) => JSON.stringify({ ...s, lastInputAt: 0, notice: null });
  for (const view of ["sessions", "tasks", "inbox"] as const) {
    test(`${view}: an empty cell's knob does nothing; a labelled knob changes its setting`, async () => {
      const r = await rig("mixed", { scope: "recent" });
      await press(r, view === "sessions" ? "HOME" : view === "tasks" ? "EDIT" : "GLO");
      const legend = r.console.view().legend;
      for (let i = 0; i < 4; i++) {
        const enc = (["K1", "K2", "K3", "K4"] as const)[i]!;
        const before = strip(r.console.state);
        const actions = await turn(r, enc, 1);
        expect(actions).toEqual([]);
        const changed = strip(r.console.state) !== before;
        expect(`${view} ${enc} ${legend[i]}: ${changed}`).toBe(`${view} ${enc} ${legend[i]}: ${legend[i] !== ""}`);
        await turn(r, enc, -1);
      }
    });
  }
});

describe("UX v2 review: every button the hint names acts", () => {
  const ids = ["s-claude-fw", "s-codex-fw", "s-claude-voice", "s-codex-voice", "s-claude-refund", "s-claude-idle", "s-codex-tui"];
  for (const view of ["sessions", "inbox"] as const) {
    for (const id of ids) {
      test(`${view} ${id}`, async () => {
        const r = await rig("mixed", { scope: "recent" });
        if (view === "inbox") {
          await press(r, "GLO");
          const k = r.console.state.layouts.inbox.slots.findIndex((x) => x !== null && r.console.inbox.known(x)?.sessionKey === keyOf(r, id));
          if (k < 0) return; // not a TO DO item
          await key(r, k);
        } else await key(r, slotOf(r, id));
        const hint = r.console.view().detail.lines[3] ?? "";
        const buttons = hint.split(" ").filter((t) => /^[A-Z][A-Z0-9+/-]+$/.test(t)) as ButtonName[];
        expect(buttons.length).toBeGreaterThan(0);
        for (const b of buttons) {
          const snap = JSON.stringify({ ...r.console.state, lastInputAt: 0 });
          const actions = await press(r, b);
          const acted = actions.length > 0 || JSON.stringify({ ...r.console.state, lastInputAt: 0 }) !== snap || r.console.composer.state.state === "recording";
          expect(`${hint}: ${b} ${acted}`).toBe(`${hint}: ${b} true`);
          // back to the base view
          if (r.console.composer.state.state === "recording") await release(r, "REC");
          if (r.console.state.confirm) await press(r, "FX");
          if (r.console.composer.state.state !== "ready") await press(r, "FX");
        }
      });
    }
  }
});
