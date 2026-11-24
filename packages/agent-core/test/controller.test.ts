import { describe, expect, test } from "bun:test";
import { capabilitiesFrom } from "../src/capabilities";
import { BACKEND_ACTIONS } from "../src/controller";
import type { ButtonName, EncoderName, KeyGesture } from "../src/controls";
import { LIMITS } from "../src/view";
import { keyOf, REC_HOLD, refOf, rig, slotOf, type Rig } from "./helpers";
import { MAX_PINS_PER_KIND, rank } from "../src/focus";
import { isTaskKey, taskKey, taskOf } from "../src/identity";

const press = (r: Rig, button: ButtonName) => r.console.handleInput({ kind: "button", button, edge: "down" });
// REC is held past the short-tap window (docs/ui-v3.md section 11) so its release stops a real recording.
const release = (r: Rig, button: ButtonName) => {
  if (button === "REC") r.timers.advance(REC_HOLD);
  return r.console.handleInput({ kind: "button", button, edge: "up" });
};
const key = (r: Rig, k: number, gesture: KeyGesture = "single") => r.console.handleInput({ kind: "key", key: k, gesture });
const turn = (r: Rig, encoder: EncoderName, delta = 1) => r.console.handleInput({ kind: "encoder", encoder, delta });
const label = (r: Rig, k: number) => r.console.view().slots[k]?.label;

const without = (...names: ("focus" | "interrupt" | "respondToApproval" | "createSession" | "createTask" | "sendPrompt")[]) =>
  capabilitiesFrom({ supported: true, verified: "code" }, Object.fromEntries(names.map((n) => [n, { supported: false, reason: "n/a", verified: "none" }])));

describe("views and navigation", () => {
  test("HOME/EDIT/GLO switch views; view model has fixed shapes and limits", async () => {
    const r = await rig();
    expect(r.console.view()).toMatchObject({ view: "sessions", title: "ACTIVE 6" });
    await press(r, "EDIT");
    expect(r.console.view()).toMatchObject({ view: "tasks", title: "TASKS 3" });
    await press(r, "GLO");
    const v = r.console.view();
    expect(v).toMatchObject({ view: "inbox", title: "TO DO 4" });
    expect(v.status.attentionCount).toBe(4);
    await press(r, "HOME");
    const s = r.console.view();
    expect(s.slots).toHaveLength(27);
    expect(s.legend).toEqual(["SHOW", "REPO", "TASK", "TALK"]);
    expect(s.detail.lines).toHaveLength(4);
    for (const slot of s.slots) expect(slot.label.length).toBeLessThanOrEqual(LIMITS.label);
    // ACTIVE, actionable first: approval, question, failure, unread result, then working (newest first)
    expect(s.slots.slice(0, 7).map((x) => x.state)).toEqual(["approval_required", "waiting_input", "failed", "completed_unread", "working", "working", "empty"]);
    expect(s.slots[5]).toMatchObject({ state: "working", provider: "claude", label: "fw codec" });
  });

  test("key single selects by identity; selection persists while others change; keys never move", async () => {
    const r = await rig("mixed", { scope: "recent" });
    const k = slotOf(r, "s-claude-idle");
    await key(r, k);
    expect(r.console.registry.selection().key).toBe(keyOf(r, "s-claude-idle"));
    const before = [...r.console.state.layouts.sessions.slots];
    r.adapter.setState(refOf(r, "s-claude-fw"), "failed");
    r.adapter.removeSession(refOf(r, "s-codex-tui"));
    const v = r.console.view();
    expect(r.console.state.layouts.sessions.slots).toEqual(before);
    expect(v.slots[k]?.selected).toBe(true);
    expect(v.slots.filter((s) => s.selected)).toHaveLength(1);
    expect(v.slots[slotOf(r, "s-codex-tui")]?.stale).toBe(true);
  });

  test("key double and PLAY open on Mac; key long press pins", async () => {
    const r = await rig();
    await key(r, slotOf(r, "s-claude-fw"), "double");
    expect(r.adapter.focusCalls).toEqual([keyOf(r, "s-claude-fw")]);
    // docs/ui-v3.md section 14: on a session PLAY acts on release (a hold reads aloud instead).
    await press(r, "PLAY");
    expect(r.adapter.focusCalls).toHaveLength(1);
    await release(r, "PLAY");
    expect(r.adapter.focusCalls).toHaveLength(2);
    expect(r.console.results.at(-1)).toMatchObject({ stage: "completed", action: "focus" });
    await key(r, slotOf(r, "s-claude-fw"), "long");
    expect(r.console.state.pins).toEqual([keyOf(r, "s-claude-fw")]);
    expect(r.console.state.notice?.text).toBe("Pinned");
    // Sessions that need you first, then the pins (operator decision 2026-11-19).
    const at = slotOf(r, "s-claude-fw");
    const tiers = r.console.state.layouts.sessions.slots.map((k) => (k === null ? 9 : rank(r.console.registry.get(k)!, r.console.world()).tier));
    expect(tiers.slice(0, at).every((t) => t <= 3)).toBe(true);
    expect(r.console.view().slots[at]?.pinned).toBe(true);
    await key(r, at, "long");
    expect(r.console.state.pins).toEqual([]);
    expect(r.console.state.notice?.text).toBe("Unpinned");
  });

  test("pins: no limit below the safety cap; first, before the sessions that need you and the rest, in every scope", async () => {
    const r = await rig("forty", { scope: "all" });
    const quiet = (k: string | null): boolean => k !== null && rank(r.console.registry.get(k)!, r.console.world()).tier > 3;
    // Pin 12 quiet sessions (more than the old limit of 9): each pin re-sorts, so pin the last quiet key each time.
    for (let i = 0; i < 12; i++) {
      const slots = r.console.state.layouts.sessions.slots;
      const k = [...slots.keys()].reverse().find((j) => quiet(slots[j] ?? null) && !r.console.state.pins.includes(slots[j]!))!;
      while (r.console.view().page < Math.floor(k / 27)) await press(r, "OCT_UP");
      await key(r, k % 27, "long");
    }
    expect(r.console.state.pins).toHaveLength(12);
    expect(r.console.state.notice?.text).toBe("Pinned");
    const check = (): void => {
      const slots = r.console.state.layouts.sessions.slots.filter((k): k is string => k !== null);
      const part = (k: string): number => (r.console.state.pins.includes(k) ? 0 : !quiet(k) ? 1 : 2);
      const parts = slots.map(part);
      expect([...parts].sort()).toEqual(parts); // pins, then need you, then the rest
      expect(parts.slice(0, 12)).toEqual(Array(12).fill(0));
      expect(parts).toContain(1);
      expect(slots.filter((k) => r.console.state.pins.includes(k))).toHaveLength(12);
    };
    check();
    await turn(r, "K1", -1);
    await turn(r, "K1", -1);
    expect(r.console.state.scope).toBe("active");
    check(); // pins show whatever SHOW says
  });

  test("pins: the safety cap is 200 per kind, counted apart; Pins full only at the cap", async () => {
    const r = await rig("forty", { scope: "all" });
    const k = r.console.state.layouts.sessions.slots[10]!;
    const tk = taskKey(taskOf(r.console.registry.get(k)!.session.ref));
    const fakeSessions = Array.from({ length: MAX_PINS_PER_KIND }, (_, i) => `b/h/p/t/fake${i}`);
    r.console.state = { ...r.console.state, pins: fakeSessions };
    await key(r, 10, "long");
    expect(r.console.state.notice).toEqual({ stage: "failed", text: "Pins full (200)" });
    expect(r.console.state.pins).toHaveLength(MAX_PINS_PER_KIND);
    // Task pins have their own 200: a task still pins with 200 session pins.
    await press(r, "EDIT");
    const tSlot = r.console.state.layouts.tasks.slots.indexOf(tk);
    await key(r, tSlot, "long");
    expect(r.console.state.notice?.text).toBe("Task pinned");
    expect(r.console.state.pins.filter(isTaskKey)).toEqual([tk]);
    const fakeTasks = Array.from({ length: MAX_PINS_PER_KIND }, (_, i) => `b/h/p/fake${i}`);
    r.console.state = { ...r.console.state, pins: [...fakeSessions, ...fakeTasks] };
    await key(r, tSlot, "long");
    expect(r.console.state.notice).toEqual({ stage: "failed", text: "Task pins full (200)" });
    expect("Task pins full (200)".length).toBeLessThanOrEqual(20);
  });

  test("pressing a stale slot is rejected as target_unavailable", async () => {
    const r = await rig();
    const k = slotOf(r, "s-claude-fw");
    r.adapter.removeSession(refOf(r, "s-claude-fw"));
    const actions = await key(r, k);
    expect(actions).toEqual([{ type: "rejected", stage: "target_unavailable", reason: "session is stale" }]);
    expect(r.console.results.at(-1)?.stage).toBe("target_unavailable");
  });

  test("OCT paging and SELECT navigation across two pages; paging never re-sorts", async () => {
    const r = await rig("forty", { scope: "all" });
    expect(r.console.view()).toMatchObject({ page: 0, pages: 2 });
    expect(r.console.view().slots.slice(24).every((s) => s.state === "empty")).toBe(true);
    const layout = r.console.state.layouts.sessions;
    await press(r, "OCT_UP");
    expect(r.console.view().page).toBe(1);
    expect(r.console.view().slots.filter((s) => s.state !== "empty")).toHaveLength(16);
    await press(r, "OCT_UP");
    expect(r.console.view().page).toBe(1);
    await press(r, "OCT_DOWN");
    expect(r.console.state.layouts.sessions).toBe(layout);
    await turn(r, "SELECT");
    const first = r.console.state.layouts.sessions.slots[0];
    expect(r.console.registry.selection().key).toBe(first ?? "");
    await turn(r, "SELECT", -1);
    expect(r.console.view().page).toBe(1);
  });

  test("EDIT lists tasks by tier; a task tap opens Sessions filtered to it", async () => {
    const r = await rig();
    await press(r, "EDIT");
    expect(r.console.view().slots.slice(0, 3).map((s) => s.state)).toEqual(["approval_required", "waiting_input", "failed"]);
    await turn(r, "K2"); // REPO: the repo holding the most urgent session first
    expect(r.console.view().title).toBe("TASKS 2 fm1-console");
    await turn(r, "K2");
    expect(r.console.view().title).toBe("TASKS 1 billing-api");
    await key(r, 0);
    const v = r.console.view();
    expect(v).toMatchObject({ view: "sessions", title: "ACTIVE 2 Refund" });
    expect(v.slots.filter((s) => s.state !== "empty").map((s) => s.label)).toEqual(["refund spec", "refund tui"]);
  });

  test("HOME in Sessions re-sorts and returns to page 1; EDIT/GLO likewise", async () => {
    const r = await rig("forty", { scope: "all" });
    await press(r, "OCT_UP");
    const actions = await press(r, "HOME");
    expect(actions).toEqual([{ type: "resort", view: "sessions" }]);
    expect(r.console.state.notice?.text).toBe("Sorted");
    expect(r.console.view().page).toBe(0);
    await press(r, "EDIT");
    expect(r.console.state.notice).toBeNull();
    await press(r, "EDIT");
    expect(r.console.state.notice?.text).toBe("Sorted");
    await press(r, "GLO");
    await press(r, "GLO");
    expect(r.console.state.notice?.text).toBe("Sorted");
  });

  test("ALGORITHM jumps across pages to the next item that needs you", async () => {
    const r = await rig("forty", { scope: "all" });
    const slots = r.console.state.layouts.sessions.slots;
    const attention = slots.filter((k): k is string => {
      const e = k === null ? undefined : r.console.registry.get(k);
      const st = e?.session.status.observed.state;
      return st === "waiting_input" || st === "approval_required" || st === "failed" || st === "completed_unread";
    });
    expect(attention.length).toBeGreaterThan(1);
    await turn(r, "ALGORITHM");
    expect(r.console.registry.selection().key).toBe(attention[0] ?? "");
    await turn(r, "ALGORITHM", -1);
    expect(r.console.registry.selection().key).toBe(attention.at(-1) ?? "");
    // a scope narrowed to one repo and a page-2 attention item: the jump crosses pages
    const second = slots.findIndex((k, i) => i >= 27 && k !== null && attention.includes(k));
    if (second >= 0) {
      for (let i = 0; i < attention.length && r.console.registry.selection().key !== slots[second]; i++) await turn(r, "ALGORITHM");
      expect(r.console.view().page).toBe(1);
    }
  });
});

describe("knobs only change settings", () => {
  test("no knob turn produces a backend action, in any view", async () => {
    const r = await rig();
    const knobs: EncoderName[] = ["K1", "K2", "K3", "K4"];
    const setups: (() => Promise<unknown>)[] = [
      () => key(r, slotOf(r, "s-claude-fw")),
      () => press(r, "EDIT").then(() => turn(r, "SELECT")),
      () => press(r, "GLO").then(() => key(r, 0)),
      async () => {
        r.console.state = { ...r.console.state, repoFilter: null, taskFilter: null };
        await press(r, "HOME");
        await key(r, slotOf(r, "s-claude-fw"));
        await press(r, "ENV"); // confirm view
      },
    ];
    let turns = 0;
    for (const setup of setups) {
      await setup();
      for (const k of knobs) {
        for (const d of [1, -1, 3]) {
          const actions = await turn(r, k, d);
          turns++;
          expect(actions.filter((a) => BACKEND_ACTIONS.has(a.type))).toEqual([]);
        }
      }
      if (r.console.state.confirm) await press(r, "FX");
    }
    expect(turns).toBe(48);
    expect(r.adapter.focusCalls).toEqual([]);
    expect(r.adapter.interruptCalls).toEqual([]);
    expect(r.adapter.approvalCalls).toEqual([]);
  });

  test("KNOB1 SHOW cycles ACTIVE -> RECENT -> ALL with a toast", async () => {
    const r = await rig("forty");
    const active = r.console.view().title;
    await turn(r, "K1");
    expect(r.console.state.scope).toBe("recent");
    expect(r.console.state.notice?.text).toMatch(/^Show: recent \(\d+\)$/);
    await turn(r, "K1");
    expect(r.console.view().title).toBe("ALL 40");
    expect(active).toMatch(/^ACTIVE \d+$/);
  });

  test("KNOB4 TALK cycles the supported modes and names the REC verb in the hint", async () => {
    const r = await rig("mixed", { scope: "recent" });
    await key(r, slotOf(r, "s-claude-idle"));
    expect(r.console.view().detail.lines[3]).toBe("REC reply  PLAY open");
    await turn(r, "K4");
    expect(r.console.state.talk).toBe("claude-chat");
    expect(r.console.state.notice?.text).toBe("Talk: Claude chat");
    expect(r.console.view().detail.lines[3]).toBe("REC new chat");
    const r2 = await rig("mixed", { capabilities: without("createSession") });
    await turn(r2, "K4");
    expect(r2.console.state.talk).toBe("claude-task");
  });
});

describe("dangerous actions require a confirm view", () => {
  test("approve: first SAVE shows confirm, second SAVE executes", async () => {
    const r = await rig();
    await key(r, slotOf(r, "s-codex-fw"));
    expect(r.console.view().detail.lines[3]).toBe("SAVE approve FX deny");
    await press(r, "SAVE");
    expect(r.console.view()).toMatchObject({ view: "confirm", title: "CHECK BEFORE DOING" });
    expect(r.console.view().detail.lines.slice(0, 2)).toEqual(["Approve?", "fw review"]);
    expect(r.adapter.approvalCalls).toHaveLength(0);
    await press(r, "SAVE");
    expect(r.adapter.approvalCalls).toMatchObject([{ approvalId: "appr-1", decision: "approve" }]);
    expect(r.console.view().view).toBe("sessions");
    expect(r.console.results.at(-1)).toMatchObject({ stage: "completed", action: "approve" });
  });

  test("FX cancels a confirm; FX in context asks to deny", async () => {
    const r = await rig();
    await press(r, "GLO");
    await key(r, 0);
    await press(r, "FX");
    expect(r.console.state.confirm?.type).toBe("deny");
    await press(r, "FX");
    expect(r.console.view().view).toBe("inbox");
    expect(r.console.state.notice?.text).toBe("Cancelled");
    await press(r, "FX");
    await press(r, "SAVE");
    expect(r.adapter.approvalCalls).toMatchObject([{ decision: "deny" }]);
  });

  test("FX on a non-approval TO DO item dismisses it; a new occurrence comes back", async () => {
    const r = await rig();
    await press(r, "GLO");
    const failed = r.console.view().slots.findIndex((s) => s.state === "failed");
    await key(r, failed);
    expect(r.console.view().detail.lines[3]).toBe("FX dismiss PLAY open");
    const actions = await press(r, "FX");
    expect(actions[0]?.type).toBe("dismiss");
    expect(r.console.state.notice?.text).toBe("Dismissed, FX undo");
    // The cursor moved on to the next item, which is now shown and so read (as SELECT would): 4 -> 2.
    expect(r.console.view().status.attentionCount).toBe(2);
    await press(r, "GLO");
    expect(r.console.view().slots.some((s) => s.state === "failed")).toBe(false);
    r.adapter.setState(refOf(r, "s-claude-voice"), "working");
    r.adapter.setState(refOf(r, "s-claude-voice"), "failed");
    expect(r.console.view().status.attentionCount).toBe(3);
    expect(r.adapter.approvalCalls).toEqual([]);
  });

  test("ENV interrupt goes through confirm and only for running sessions", async () => {
    const r = await rig("mixed", { scope: "recent" });
    await key(r, slotOf(r, "s-claude-idle"));
    await press(r, "ENV");
    expect(r.console.view().view).toBe("sessions");
    expect(r.console.state.notice).toEqual({ stage: "failed", text: "Nothing to stop" });
    await key(r, slotOf(r, "s-claude-fw"));
    expect(r.console.view().detail.lines[3]).toBe("ENV stop  PLAY open");
    await press(r, "ENV");
    expect(r.console.view().view).toBe("confirm");
    expect(r.console.view().detail.lines[0]).toBe("Stop this agent?");
    await press(r, "SAVE");
    expect(r.adapter.interruptCalls).toEqual([keyOf(r, "s-claude-fw")]);
  });

  test("confirm re-validates: a target that went stale is not acted on", async () => {
    const r = await rig();
    await key(r, slotOf(r, "s-claude-fw"));
    await press(r, "ENV");
    r.adapter.removeSession(refOf(r, "s-claude-fw"));
    await press(r, "SAVE");
    expect(r.adapter.interruptCalls).toEqual([]);
    expect(r.console.results.at(-1)?.stage).toBe("target_unavailable");
  });

  test("approval resolved elsewhere before confirm -> target_unavailable", async () => {
    const r = await rig();
    await key(r, slotOf(r, "s-codex-fw"));
    await press(r, "SAVE");
    r.adapter.emit({ type: "approval_resolved", approvalId: "appr-1" });
    await press(r, "SAVE");
    expect(r.adapter.approvalCalls).toHaveLength(0);
    expect(r.console.results.at(-1)?.stage).toBe("target_unavailable");
  });

  test("PLAY in tasks view creates a chat only after confirm", async () => {
    const r = await rig();
    await press(r, "EDIT");
    await turn(r, "SELECT");
    expect(r.console.view().detail.lines[3]).toBe("PLAY new chat");
    await press(r, "PLAY");
    expect(r.console.view().view).toBe("confirm");
    expect(r.console.view().detail.lines[0]).toBe("Start new chat?");
    const before = r.console.registry.sessions().length;
    await press(r, "SAVE");
    expect(r.console.registry.sessions().length).toBe(before + 1);
  });
});

describe("capability gating", () => {
  test("unsupported actions leave the hint out and report unsupported without calling the adapter", async () => {
    const r = await rig("mixed", { capabilities: without("focus", "interrupt", "respondToApproval") });
    await key(r, slotOf(r, "s-codex-fw"));
    expect(r.console.view().legend).toEqual(["SHOW", "REPO", "TASK", "TALK"]);
    expect(r.console.view().detail.lines[3]).toBe("Hold SCL for help");
    await press(r, "SAVE");
    expect(r.console.view().view).toBe("sessions");
    expect(r.console.results.at(-1)?.stage).toBe("unsupported");
    await key(r, slotOf(r, "s-claude-fw"), "double");
    expect(r.adapter.focusCalls).toEqual([]);
    await press(r, "ENV");
    expect(r.adapter.interruptCalls).toEqual([]);
    expect(r.console.results.map((x) => x.stage)).toEqual(["unsupported", "unsupported", "unsupported"]);
  });

  test("no talk capability: TALK cell empty and REC is rejected", async () => {
    const r = await rig("mixed", { capabilities: without("createSession", "sendPrompt", "createTask") });
    expect(r.console.view().legend).toEqual(["SHOW", "REPO", "TASK", ""]);
    const r2 = await rig("mixed", { capabilities: without("sendPrompt") });
    await key(r2, slotOf(r2, "s-claude-fw"));
    const actions = await press(r2, "REC");
    expect(actions[0]).toMatchObject({ type: "rejected", stage: "unsupported" });
    expect(r2.console.composer.state.state).toBe("ready");
  });
});

describe("voice through the device", () => {
  test("REC down/up, SAVE submits reviewed prompt to the target captured at REC down", async () => {
    const r = await rig("mixed", { scope: "recent" });
    await key(r, slotOf(r, "s-claude-idle"));
    await press(r, "REC");
    expect(r.console.view()).toMatchObject({ view: "voice", title: "TALK", voice: { state: "recording", target: "refund impl" } });
    expect(r.console.view().detail.lines[3]).toBe("release REC to stop");
    await key(r, slotOf(r, "s-claude-fw"));
    r.timers.advance(2000);
    r.console.voiceLevel(40);
    expect(r.console.view().voice).toMatchObject({ level: 40, elapsedDs: 20 });
    await release(r, "REC");
    expect(r.console.view().voice.state).toBe("transcribing");
    r.console.voiceTranscript("add currency validation to the refund webhook handler");
    const v = r.console.view();
    expect(v.legend).toEqual(["", "", "", ""]);
    expect(v.detail.lines).toEqual(["add currency", "validation to the", "", "SAVE send  FX cancel"]);
    await turn(r, "PRESETS");
    expect(r.console.view().detail.lines[0]).toBe("validation to the");
    await press(r, "SAVE");
    await r.console.idle();
    expect(r.console.composer.state.state).toBe("delivered");
    expect(r.adapter.deliveries).toMatchObject([{ key: keyOf(r, "s-claude-idle"), text: "add currency validation to the refund webhook handler" }]);
    expect(r.console.view().view).toBe("sessions");
  });

  test("REC without a selected session asks to select a chat", async () => {
    const r = await rig();
    await press(r, "REC");
    expect(r.console.state.notice).toEqual({ stage: "target_unavailable", text: "Select a chat first" });
    expect(r.console.composer.state.state).toBe("ready");
  });

  test("FX cancels recording; a new-task prompt requires confirm", async () => {
    const r = await rig("mixed", { scope: "recent" });
    await key(r, slotOf(r, "s-claude-idle"));
    await press(r, "REC");
    await press(r, "FX");
    expect(r.console.composer.state.state).toBe("cancelled");
    expect(r.console.state.notice?.text).toBe("Cancelled");
    for (let i = 0; i < 3; i++) await turn(r, "K4");
    expect(r.console.state.talk).toBe("claude-task");
    await press(r, "REC");
    expect(r.console.composer.state.destination?.label).toBe("new task: billing-ap");
    await release(r, "REC");
    r.console.voiceTranscript("New billing audit");
    await press(r, "SAVE");
    expect(r.console.view().view).toBe("confirm");
    expect(r.console.view().detail.lines[0]).toBe("Create new task?");
    expect(r.adapter.deliveries).toHaveLength(0);
    await press(r, "SAVE");
    await r.console.idle();
    expect(r.adapter.deliveries.map((d) => d.kind)).toEqual(["createTask"]);
  });

  test("PLAY retries a failed dispatch with the same requestId", async () => {
    const r = await rig("mixed", { ackMode: "fail", scope: "recent" });
    await key(r, slotOf(r, "s-claude-idle"));
    await press(r, "REC");
    await release(r, "REC");
    r.console.voiceTranscript("retry me");
    await press(r, "SAVE");
    await r.console.idle();
    expect(r.console.view().detail.lines[3]).toBe("PLAY retry  FX close");
    r.adapter.ackMode = "immediate";
    await press(r, "PLAY");
    await r.console.idle();
    expect(r.console.composer.state).toMatchObject({ state: "delivered", requestId: "req-1", attempts: 2 });
    expect(r.adapter.deliveries).toHaveLength(1);
  });

  test("double SAVE on reviewing does not double-send", async () => {
    const r = await rig("mixed", { ackMode: "hang", scope: "recent" });
    await key(r, slotOf(r, "s-claude-idle"));
    await press(r, "REC");
    await release(r, "REC");
    r.console.voiceTranscript("once only");
    await press(r, "SAVE");
    await press(r, "SAVE");
    r.adapter.release("req-1");
    await r.console.idle();
    expect(r.console.dispatcher.adapterCalls).toBe(1);
    expect(r.adapter.deliveries).toHaveLength(1);
  });
});

test("labels are word heads, never mid-word cuts", async () => {
  const r = await rig();
  expect(label(r, 0)).toBe("fw review");
});
