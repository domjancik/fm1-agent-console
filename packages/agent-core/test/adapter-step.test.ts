// Console side of the adapter step (operator brief 2026-11-18): TO DO dismiss with undo, sessions that take no console
// prompts (session.prompt), the a2a reply in the bubble, "Queued, undelivered", and the backend name from the adapter.
import { describe, expect, test } from "bun:test";
import { DEFAULT_BACKEND, goneCaption, offlineText, QUEUED_NOT_DELIVERED, QUEUED_RUNS_NEXT, toastFor } from "../src/copy";
import type { ButtonName, EncoderName, KeyGesture } from "../src/controls";
import { bubbleInput, detailInput, newestMessage } from "../src/details";
import { DISMISS_UNDO_MS } from "../src/inbox";
import { parseSession } from "../src/validate";
import { backendName, type Session } from "../src/types";
import { keyOf, refOf, rig, slotOf, type Rig } from "./helpers";

const press = (r: Rig, button: ButtonName) => r.console.handleInput({ kind: "button", button, edge: "down" });
const key = (r: Rig, k: number, gesture: KeyGesture = "single") => r.console.handleInput({ kind: "key", key: k, gesture });
const turn = (r: Rig, encoder: EncoderName, delta = 1) => r.console.handleInput({ kind: "encoder", encoder, delta });
const inboxSlots = (r: Rig) => [...r.console.state.layouts.inbox.slots];
const session = (r: Rig, id: string): Session => {
  const e = r.console.registry.get(keyOf(r, id));
  if (!e) throw new Error(id);
  return e.session;
};

describe("TO DO dismiss takes effect at once (docs/ux-v2.md section 3.6)", () => {
  async function inTodoOn(state: string) {
    const r = await rig();
    await press(r, "GLO");
    const k = r.console.view().slots.findIndex((s) => s.state === state);
    expect(k).toBeGreaterThanOrEqual(0);
    await key(r, k);
    return { r, k };
  }

  test("the key empties, other keys stay, the cursor moves on, title and badge update now", async () => {
    const { r, k } = await inTodoOn("failed");
    const before = inboxSlots(r);
    const dismissed = before[k] as string;
    const badgeBefore = r.console.view().status.attentionCount;
    const actions = await press(r, "FX");
    expect(actions.map((a) => a.type)).toEqual(["dismiss", "markRead", "select"]);
    expect(r.console.state.notice?.text).toBe("Dismissed, FX undo");
    const after = inboxSlots(r);
    expect(after[k] ?? null).toBeNull();
    for (let i = 0; i < before.length; i++) if (i !== k) expect(after[i] ?? null).toBe(before[i] ?? null);
    const v = r.console.view();
    expect(v.slots[k]?.state).toBe("empty");
    expect(r.console.state.inboxCursor).not.toBe(dismissed);
    expect(r.console.state.inboxCursor).toBe(before.find((id, i) => i > k && id !== null) ?? null);
    expect(v.status.attentionCount).toBeLessThan(badgeBefore);
    expect(v.title).toBe(`TO DO ${v.status.attentionCount}`);
    expect(r.console.inbox.todo().some((i) => i.id === dismissed)).toBe(false);
  });

  test("FX within 3 s restores the item to its key and selects it; later FX dismisses the next one", async () => {
    const { r, k } = await inTodoOn("failed");
    const id = inboxSlots(r)[k] as string;
    await press(r, "FX");
    r.timers.advance(DISMISS_UNDO_MS - 500);
    const actions = await press(r, "FX");
    expect(actions[0]).toEqual({ type: "undismiss", itemId: id });
    expect(r.console.state.notice?.text).toBe("Restored");
    expect(inboxSlots(r)[k]).toBe(id);
    expect(r.console.state.inboxCursor).toBe(id);
    expect(r.console.inbox.get(id)?.dismissed).toBe(false);
    expect(r.console.view().slots[k]?.state).toBe("failed");
    // A second dismiss, then FX after the window: it acts on the item now under the cursor instead of undoing.
    await press(r, "FX");
    r.timers.advance(DISMISS_UNDO_MS + 1);
    const later = await press(r, "FX");
    expect(later.some((a) => a.type === "undismiss")).toBe(false);
    expect(r.console.inbox.get(id)?.dismissed).toBe(true);
    expect(inboxSlots(r)[k] ?? null).toBeNull();
  });

  test("FX inside the window after the dismissed item changed or left: nothing to undo, and no second item is dismissed", async () => {
    const { r, k } = await inTodoOn("failed");
    const id = inboxSlots(r)[k] as string;
    const item = r.console.inbox.get(id);
    if (!item) throw new Error("missing item");
    await press(r, "FX");
    const next = r.console.state.inboxCursor;
    // The dismissed session runs again and fails again: the old occurrence leaves, a new one (new id) arrives.
    r.adapter.setState(item.sessionRef, "working");
    r.adapter.setState(item.sessionRef, "failed");
    r.timers.advance(DISMISS_UNDO_MS - 1_000);
    const acts = await press(r, "FX");
    expect(acts.some((a) => a.type === "dismiss" || a.type === "undismiss")).toBe(false);
    expect(r.console.state.notice?.text).toBe("Nothing to undo");
    expect(r.console.state.inboxCursor).toBe(next);
    if (next !== null) expect(r.console.inbox.get(next)?.dismissed ?? false).toBe(false);
    // The window is spent: the next FX acts normally.
    const again = await press(r, "FX");
    expect(again.some((a) => a.type === "dismiss")).toBe(next !== null);
  });

  test("any other input ends the undo window; approvals are unchanged (FX = deny with confirm)", async () => {
    const { r } = await inTodoOn("waiting_input");
    await press(r, "FX");
    await turn(r, "SELECT", 1);
    const acts = await press(r, "FX");
    expect(acts.some((a) => a.type === "undismiss")).toBe(false);
    const r2 = await rig();
    await press(r2, "GLO");
    await key(r2, r2.console.view().slots.findIndex((s) => s.state === "approval_required"));
    await press(r2, "FX");
    expect(r2.console.state.confirm?.type).toBe("deny");
    expect(r2.adapter.approvalCalls).toEqual([]);
  });

  test("dismissing the last item leaves no cursor; a new occurrence of the session comes back", async () => {
    const r = await rig();
    await press(r, "GLO");
    for (let i = 0; i < 6; i++) {
      const item = r.console.state.inboxCursor === null ? undefined : r.console.inbox.get(r.console.state.inboxCursor);
      if (item === undefined) {
        const k = r.console.view().slots.findIndex((s) => s.state !== "empty" && s.state !== "approval_required");
        if (k < 0) break;
        await key(r, k);
        continue;
      }
      if (item.kind === "approval") break;
      await press(r, "FX");
      r.timers.advance(DISMISS_UNDO_MS + 1);
    }
    const left = r.console.inbox.todo().filter((i) => i.kind !== "approval");
    expect(left).toEqual([]);
    r.adapter.setState(refOf(r, "s-claude-voice"), "working");
    r.adapter.setState(refOf(r, "s-claude-voice"), "failed");
    expect(r.console.inbox.todo().some((i) => i.kind === "failure")).toBe(true);
  });
});

describe("sessions that take no console prompts (docs/ui-v3.md section 9.7)", () => {
  const codexTui = { acceptsPrompt: false, reason: "terminal session (codex): cannot receive agent messages", line: "Codex terminal: open on Mac", toast: "Terminal: use Mac" };

  async function withPrompt(prompt: Session["prompt"]) {
    const r = await rig("mixed", { scope: "recent" });
    r.adapter.upsertSession({ ...session(r, "s-claude-idle"), ...(prompt === undefined ? {} : { prompt }) });
    await key(r, slotOf(r, "s-claude-idle"));
    return r;
  }

  test("no REC in the hint, REC refused with the adapter's toast, nothing recorded or sent", async () => {
    const r = await withPrompt(codexTui);
    expect(r.console.view().detail.lines[3]).not.toContain("REC");
    const actions = await press(r, "REC");
    expect(actions.some((a) => a.type === "voiceStart")).toBe(false);
    expect(r.console.composer.state.state).toBe("ready");
    expect(r.console.state.notice).toEqual({ stage: "unsupported", text: "Terminal: use Mac" });
    expect(r.adapter.deliveries).toEqual([]);
  });

  test("the bubble leads with the adapter's line; DETAILS shows it too", async () => {
    const r = await withPrompt(codexTui);
    r.console.setProtocol(4);
    const rows = r.console.view().text ?? [];
    expect(rows[1]).toEqual({ style: "muted", text: "Codex terminal: open on Mac" });
  });

  test("without adapter copy the console uses its own words", async () => {
    const r = await withPrompt({ acceptsPrompt: false });
    await press(r, "REC");
    expect(r.console.state.notice?.text).toBe("Can't take prompts");
    r.console.setProtocol(4);
    expect(r.console.view().text?.[1]).toEqual({ style: "muted", text: "No prompts from the console" });
  });

  test("acceptsPrompt true (or absent) keeps REC", async () => {
    const r = await withPrompt({ acceptsPrompt: true });
    expect(r.console.view().detail.lines[3]).toContain("REC");
  });

  test("the dispatcher refuses such a target even when asked directly", async () => {
    const r = await withPrompt(codexTui);
    const res = r.console.dispatcher.precheck({ mode: "continue-session", target: refOf(r, "s-claude-idle"), label: "x" }, "rq");
    expect(res).toEqual({ requestId: "rq", stage: "unsupported", message: codexTui.reason });
  });

  test("validation keeps acceptsPrompt/reason/line/toast, folds and cuts device copy, drops adapter extras", () => {
    const base = { ref: { backendId: "b", hostId: "h", projectId: "p", taskId: "t", sessionId: "s" }, title: "x", provider: "claude", runtime: "terminal", workspace: "/w", createdAt: 1, status: { observed: { state: "idle", at: 1 }, raw: null } };
    const ok = parseSession({ ...base, prompt: { acceptsPrompt: false, via: null, senderAgentId: "a", reason: "r", line: "Codex terminal: open on Mac -- extra words", toast: "Terminal: use the Mac now" } });
    expect(ok.ok && ok.value.prompt).toEqual({ acceptsPrompt: false, reason: "r", line: "Codex terminal: open on Mac", toast: "Terminal: use the Ma" });
    expect(parseSession({ ...base, prompt: { acceptsPrompt: "no" } }).ok).toBe(false);
    expect(parseSession({ ...base, prompt: { acceptsPrompt: true, line: 3 } }).ok).toBe(false);
    const d = parseSession({ ...base, details: { lastPrompt: "hi", reply: { requestId: "r1", text: "pong", at: 5 } } });
    expect(d.ok && d.value.details).toEqual({ lastPrompt: "hi", reply: { requestId: "r1", text: "pong", at: 5 } });
    expect(parseSession({ ...base, details: { reply: { requestId: "r1", text: "pong" } } }).ok).toBe(false);
    const long = parseSession({ ...base, details: { reply: { requestId: "r1", text: "x".repeat(5_000), at: 5 } } });
    expect(long.ok && long.value.details?.reply?.text.length).toBe(600);
  });
});

describe("a2a reply and delivery wording", () => {
  test("details.reply is the newest message when it is at least as new as lastMessage", () => {
    expect(newestMessage({ lastMessage: "old", lastMessageAt: 10, reply: { requestId: "r", text: "pong", at: 20 } })).toEqual({ text: "pong", at: 20 });
    expect(newestMessage({ lastMessage: "newer", lastMessageAt: 30, reply: { requestId: "r", text: "pong", at: 20 } })).toEqual({ text: "newer", at: 30 });
    expect(newestMessage({ reply: { requestId: "r", text: "pong", at: 20 } })).toEqual({ text: "pong", at: 20 });
    expect(newestMessage({})).toBeUndefined();
  });

  test("the bubble shows the reply; DETAILS shows the last prompt for context", async () => {
    const r = await rig("mixed", { scope: "recent" });
    const s = session(r, "s-claude-idle");
    r.adapter.upsertSession({ ...s, details: { lastMessage: "older text", lastMessageAt: 1, lastPrompt: "Report status.", reply: { requestId: "req-9", text: "All green, 3 files changed.", at: 2 } } });
    await key(r, slotOf(r, "s-claude-idle"));
    r.console.setProtocol(4);
    expect(r.console.view().text?.[1]?.text).toBe("All green, 3 files changed.");
    const e = r.console.registry.get(keyOf(r, "s-claude-idle"));
    if (!e) throw new Error("missing");
    expect(bubbleInput(detailInput(e, "idle", r.console.world())).lastMessage).toBe("All green, 3 files changed.");
    await press(r, "LFO");
    const rows = (r.console.view().text ?? []).map((x) => x.text);
    expect(rows.some((t) => t.startsWith("Prompt: Report status."))).toBe(true);
  });

  test("a voice prompt that ends `sent` with a reason says Queued, undelivered (<= 20)", () => {
    expect(QUEUED_NOT_DELIVERED.length).toBeLessThanOrEqual(20);
    expect(toastFor("sent", "queued in the terminal agent's inbox; delivery not observed yet", "voice")).toBe(QUEUED_NOT_DELIVERED);
    expect(toastFor("sent", undefined, "voice")).toBe("Sent");
    expect(toastFor("sent", "x", "focus")).toBe("Sent");
  });

  test("a voice prompt queued behind a running turn is delivered: Queued, runs next (<= 20)", () => {
    expect(QUEUED_RUNS_NEXT.length).toBeLessThanOrEqual(20);
    expect(toastFor("backend_acknowledged", "queued behind the running turn", "voice")).toBe(QUEUED_RUNS_NEXT);
    expect(toastFor("backend_acknowledged", undefined, "voice")).toBe(toastFor("backend_acknowledged", null, "voice"));
  });
});

describe("the backend name comes from the adapter", () => {
  test("backendName: displayName, else id; ASCII, <= 12", () => {
    expect(backendName({ id: "traycer", displayName: "Traycer" })).toBe("Traycer");
    expect(backendName({ id: "acme" })).toBe("acme");
    expect(backendName({ id: "x", displayName: "  " })).toBe("x");
    expect(backendName({ id: "", displayName: "Ünïcode Backend Name" })).toBe("n code Backe");
    expect(backendName({ id: "" })).toBe(DEFAULT_BACKEND);
  });

  test("offline status and stale wording use the adapter's name", async () => {
    const r = await rig("mixed", { scope: "recent", displayName: "Acme" });
    await key(r, slotOf(r, "s-claude-idle"));
    const selected = keyOf(r, "s-claude-idle");
    r.adapter.dropConnection();
    expect(r.console.view().status.text).toBe("Acme offline");
    r.adapter.mutateOffline(({ sessions }) => sessions.delete(selected));
    await r.console.reconnect();
    expect(r.console.view().detail.lines[2]).toBe("gone from Acme");
    r.console.setProtocol(4);
    expect(r.console.view().text?.[0]?.text).toBe(goneCaption("Acme"));
    expect(offlineText("Traycer")).toBe("Traycer offline");
  });

  test("the mock replays Traycer-shaped fixtures and says Traycer by default", async () => {
    const r = await rig();
    expect(r.console.world().backend).toBe("Traycer");
  });
});
