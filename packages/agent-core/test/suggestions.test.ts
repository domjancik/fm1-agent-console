// Suggested next prompts on the console (docs/ui-v3.md section 11): the bubble's `Next:` row, the short REC tap that
// loads a suggestion into review, PRESETS cycling, SAVE through the unchanged dispatch path, FX, and clearing on send.
import { describe, expect, test } from "bun:test";
import { REC_TAP_MS, suggestionsOf } from "../src/context";
import { parseDetails } from "../src/validate";
import type { Session } from "../src/types";
import { keyOf, REC_HOLD, refOf, rig, slotOf, type Rig } from "./helpers";

const down = (r: Rig, button: string) => r.console.handleInput({ kind: "button", button: button as never, edge: "down" });
const up = (r: Rig, button: string) => r.console.handleInput({ kind: "button", button: button as never, edge: "up" });
const turn = (r: Rig, encoder: string, delta = 1) => r.console.handleInput({ kind: "encoder", encoder: encoder as never, delta });

/** A short REC tap: down, up before REC_TAP_MS. */
async function tap(r: Rig, heldMs = 120) {
  const a = await down(r, "REC");
  r.timers.advance(heldMs);
  const b = await up(r, "REC");
  return [...a, ...b];
}

const IDLE = "s-claude-idle";
const NEXT: [string, string, string] = ["Run the full test suite", "Update the docs for the new flag", "Open a PR with the change"];

async function selected(suggestions: string[] | null = NEXT, proto = 4) {
  const r = await rig("mixed", { scope: "recent" });
  r.console.setProtocol(proto);
  await r.console.handleInput({ kind: "key", key: slotOf(r, IDLE), gesture: "single" });
  r.adapter.setSuggestions(refOf(r, IDLE), suggestions);
  return r;
}

const session = (r: Rig, id: string): Session => {
  const e = r.console.registry.get(keyOf(r, id));
  if (!e) throw new Error("missing");
  return e.session;
};

describe("Session.details.suggestions (adapter-neutral)", () => {
  test("validated: string[] kept (0..3, each <= 600), empty strings dropped, an empty list means none", () => {
    const r = parseDetails({ suggestions: ["a", "", "b", "c", "d"] });
    expect(r.ok && r.value.suggestions).toEqual(["a", "b", "c"]);
    const long = parseDetails({ suggestions: ["x".repeat(700)] });
    expect(long.ok && long.value.suggestions?.[0]?.length).toBe(600);
    const none = parseDetails({ suggestions: [] });
    expect(none.ok && none.value.suggestions).toBeUndefined();
    expect(parseDetails({ suggestions: "nope" }).ok).toBe(false);
    expect(parseDetails({ suggestions: [1] }).ok).toBe(false);
  });

  test("the mock adapter sets and clears them; a send clears them (as Traycer's host does)", async () => {
    const r = await selected();
    expect(session(r, IDLE).details?.suggestions).toEqual(NEXT);
    r.adapter.setSuggestions(refOf(r, IDLE), null);
    expect(session(r, IDLE).details?.suggestions).toBeUndefined();
    r.adapter.setSuggestions(refOf(r, IDLE), NEXT);
    await r.adapter.sendPrompt(refOf(r, IDLE), "hi", "req-x");
    expect(session(r, IDLE).details?.suggestions).toBeUndefined();
  });

  test("none offered for a stale session or one that takes no console prompts", async () => {
    const r = await selected();
    const e = r.console.registry.get(keyOf(r, IDLE));
    expect(suggestionsOf(r.console.state, e)).toEqual(NEXT);
    r.adapter.upsertSession({ ...session(r, IDLE), prompt: { acceptsPrompt: false } });
    expect(suggestionsOf(r.console.state, r.console.registry.get(keyOf(r, IDLE)))).toEqual([]);
  });
});

describe("bubble and hint", () => {
  test("Buddy: one accent row `Next: <first>` before the last message, cut to 28; the hint says REC next", async () => {
    const r = await selected();
    const rows = r.console.view().text ?? [];
    const i = rows.findIndex((x) => x.text.startsWith("Next: "));
    expect(i).toBeGreaterThan(0);
    expect(rows[i]).toEqual({ style: "heading", text: "Next: Run the full test" }); // 29 > 28: cut at a word
    expect(rows.filter((x) => x.text.startsWith("Next: "))).toHaveLength(1);
    expect(r.console.view().detail.lines[3]).toBe("REC next  PLAY open");
  });

  test("a long suggestion is one row cut at a word boundary (28 Buddy, 24 List)", async () => {
    const r = await selected(["Refactor the session registry so pins survive a reconnect"]);
    const row = (r.console.view().text ?? []).find((x) => x.text.startsWith("Next: "));
    expect(row?.text).toBe("Next: Refactor the session");
    expect(row!.text.length).toBeLessThanOrEqual(28);
    r.console.setProtocol(5);
    r.console.setLayouts({ sessions: "list" });
    const head = r.console.view().text ?? [];
    expect(head[1]?.text.startsWith("Next: ")).toBe(true);
    expect(head[1]!.text.length).toBeLessThanOrEqual(24);
  });

  test("no suggestion: no Next row and the hint is unchanged (REC reply)", async () => {
    const r = await selected(null);
    expect((r.console.view().text ?? []).some((x) => x.text.startsWith("Next: "))).toBe(false);
    expect(r.console.view().detail.lines[3]).toBe("REC reply  PLAY open");
  });

  test("a session that takes no console prompts shows no Next row and no REC", async () => {
    const r = await selected();
    r.adapter.upsertSession({ ...session(r, IDLE), prompt: { acceptsPrompt: false, toast: "Terminal: use Mac" } });
    expect((r.console.view().text ?? []).some((x) => x.text.startsWith("Next: "))).toBe(false);
    expect(r.console.view().detail.lines[3]).not.toContain("REC");
  });
});

describe("REC short tap versus hold", () => {
  test("a tap loads the first suggestion into review, marked suggested; the take is dropped, nothing is sent", async () => {
    const r = await selected();
    const actions = await tap(r);
    expect(actions.map((a) => a.type)).toEqual(["voiceStart", "voiceSuggest"]);
    expect(r.console.composer.state).toMatchObject({ state: "reviewing", transcript: NEXT[0], source: "suggested", suggestion: { index: 0, count: 3 } });
    expect(r.console.composer.state.destination?.mode).toBe("continue-session");
    expect(r.console.view().view).toBe("voice");
    expect(r.adapter.deliveries).toEqual([]);
  });

  test("the review screen labels it (host text, body row 1) and keeps the dictated hint", async () => {
    const r = await selected();
    await tap(r);
    const rows = r.console.view().text ?? [];
    expect(rows[1]).toEqual({ style: "heading", text: "Suggested 1/3  PRESETS next" });
    expect(rows[2]).toEqual({ style: "body", text: "Run the full test suite" });
    expect(r.console.view().detail.lines[3]).toBe("SAVE send  FX cancel");
    expect(r.console.view().voice.state).toBe("reviewing");
  });

  test("one suggestion: label `Suggested`; dictated text has no label", async () => {
    const r = await selected(["Ship it"]);
    await tap(r);
    expect((r.console.view().text ?? [])[1]).toEqual({ style: "heading", text: "Suggested" });
    await down(r, "FX");
    await down(r, "REC");
    r.timers.advance(REC_HOLD);
    await up(r, "REC");
    r.console.voiceTranscript("my own words");
    expect(r.console.composer.state.source).toBe("voice");
    expect((r.console.view().text ?? [])[1]).toEqual({ style: "body", text: "my own words" });
  });

  test("a hold records exactly as before: up at or after REC_TAP_MS stops and transcribes", async () => {
    const r = await selected();
    const a = await down(r, "REC");
    expect(a.map((x) => x.type)).toEqual(["voiceStart"]);
    expect(r.console.composer.state.state).toBe("recording");
    r.timers.advance(REC_TAP_MS);
    const b = await up(r, "REC");
    expect(b.map((x) => x.type)).toEqual(["voiceStop"]);
    expect(r.console.composer.state.state).toBe("transcribing");
    r.console.voiceTranscript("spoken");
    expect(r.console.composer.state).toMatchObject({ state: "reviewing", transcript: "spoken", source: "voice", suggestion: null });
  });

  test("REC on the review screen does nothing: the review stays, no `Chat is gone` toast", async () => {
    const r = await selected();
    await down(r, "REC");
    r.timers.advance(REC_HOLD);
    await up(r, "REC");
    r.console.voiceTranscript("spoken");
    expect(r.console.composer.state.state).toBe("reviewing");
    await down(r, "REC");
    r.timers.advance(REC_HOLD);
    await up(r, "REC");
    expect(r.console.composer.state).toMatchObject({ state: "reviewing", transcript: "spoken" });
    expect(r.console.state.notice?.text).not.toBe("Chat is gone");
  });

  test("the tap boundary: 349 ms is a tap, 350 ms a hold", async () => {
    const r = await selected();
    await tap(r, REC_TAP_MS - 1);
    expect(r.console.composer.state.source).toBe("suggested");
    await down(r, "FX");
    await tap(r, REC_TAP_MS);
    expect(r.console.composer.state.state).toBe("transcribing");
  });

  test("no suggestion and no canned response: a tap toasts `No suggestion/canned`, records nothing, and changes nothing else", async () => {
    const r = await selected(null);
    const before = r.console.view();
    const actions = await tap(r);
    expect(actions.map((a) => a.type)).toEqual(["voiceStart", "voiceDiscard"]);
    expect(r.console.composer.state.state).toBe("ready");
    expect(r.console.state.notice).toEqual({ stage: "accepted_locally", text: "No suggestion/canned" });
    expect("No suggestion/canned".length).toBeLessThanOrEqual(20);
    const after = r.console.view();
    expect(after.view).toBe(before.view);
    expect(after.slots).toEqual(before.slots);
    expect(r.adapter.deliveries).toEqual([]);
  });

  test("a session that takes no prompts refuses REC at the down edge as before (no recording, no suggestion)", async () => {
    const r = await selected();
    r.adapter.upsertSession({ ...session(r, IDLE), prompt: { acceptsPrompt: false, toast: "Terminal: use Mac" } });
    expect(await down(r, "REC")).toEqual([]);
    expect(r.console.state.notice?.text).toBe("Terminal: use Mac");
    r.timers.advance(100);
    expect(await up(r, "REC")).toEqual([]);
    expect(r.console.composer.state.state).toBe("ready");
  });

  test("a new-chat TALK destination has no suggestion: the tap toasts and records nothing", async () => {
    const r = await selected();
    await turn(r, "K4", 1); // Claude chat
    expect(r.console.state.talk).not.toBe("reply");
    await tap(r);
    expect(r.console.composer.state.state).toBe("ready");
    expect(r.console.state.notice?.text).toBe("No suggestion/canned");
  });
});

describe("review controls for a suggestion", () => {
  test("PRESETS cycles the suggestions (wrapping both ways); nothing is sent", async () => {
    const r = await selected();
    await tap(r);
    await turn(r, "PRESETS", 1);
    expect(r.console.composer.state).toMatchObject({ transcript: NEXT[1], suggestion: { index: 1, count: 3 } });
    expect((r.console.view().text ?? [])[1]?.text).toBe("Suggested 2/3  PRESETS next");
    await turn(r, "PRESETS", 1);
    await turn(r, "PRESETS", 1);
    expect(r.console.composer.state.transcript).toBe(NEXT[0]);
    await turn(r, "PRESETS", -1);
    expect(r.console.composer.state.transcript).toBe(NEXT[2]);
    expect(r.adapter.deliveries).toEqual([]);
  });

  test("PRESETS on a dictated review still scrolls (no cycling)", async () => {
    const r = await selected();
    await down(r, "REC");
    r.timers.advance(REC_HOLD);
    await up(r, "REC");
    r.console.voiceTranscript("dictated");
    const actions = await turn(r, "PRESETS", 1);
    expect(actions).toEqual([]);
    expect(r.console.composer.state.transcript).toBe("dictated");
  });

  test("FX cancels: nothing sent, the suggestion stays offered", async () => {
    const r = await selected();
    await tap(r);
    await down(r, "FX");
    expect(r.console.composer.state.state).toBe("cancelled");
    expect(r.console.state.notice?.text).toBe("Cancelled");
    expect(r.adapter.deliveries).toEqual([]);
    expect((r.console.view().text ?? []).some((x) => x.text.startsWith("Next: "))).toBe(true);
  });

  test("SAVE sends the shown suggestion through the normal dispatch path, once", async () => {
    const r = await selected();
    await tap(r);
    await turn(r, "PRESETS", 1);
    const actions = await down(r, "SAVE");
    expect(actions.map((a) => a.type)).toEqual(["voiceSubmit"]);
    await r.console.idle();
    expect(r.adapter.deliveries).toEqual([{ requestId: "req-1", kind: "prompt", key: keyOf(r, IDLE), text: NEXT[1] }]);
    expect(r.console.composer.state.state).toBe("delivered");
    await down(r, "SAVE");
    await r.console.idle();
    expect(r.adapter.deliveries).toHaveLength(1);
  });

  test("suggestions are cleared on send: no Next row afterwards, a tap says No suggestion", async () => {
    const r = await selected();
    // A terminal transcript keeps reporting the same list until a newer answer: the console hides it itself.
    r.adapter.clearSuggestionsOnSend = false;
    await tap(r);
    await down(r, "SAVE");
    await r.console.idle();
    expect(session(r, IDLE).details?.suggestions).toEqual(NEXT);
    await down(r, "FX");
    expect((r.console.view().text ?? []).some((x) => x.text.startsWith("Next: "))).toBe(false);
    await tap(r);
    expect(r.console.state.notice?.text).toBe("No suggestion/canned");
    // A different list later is offered again; spent lists are forgotten once the adapter drops them.
    r.adapter.setSuggestions(refOf(r, IDLE), ["Something new"]);
    expect(r.console.state.spentSuggestions).toEqual({});
    expect((r.console.view().text ?? []).find((x) => x.text.startsWith("Next: "))?.text).toBe("Next: Something new");
  });

  test("a dictated send also uses up the suggestions", async () => {
    const r = await selected();
    r.adapter.clearSuggestionsOnSend = false;
    await down(r, "REC");
    r.timers.advance(REC_HOLD);
    await up(r, "REC");
    r.console.voiceTranscript("my own idea");
    await down(r, "SAVE");
    await r.console.idle();
    expect(r.console.state.spentSuggestions[keyOf(r, IDLE)]).toBe(JSON.stringify(NEXT));
  });

  test("the fail-early precheck still applies on SAVE: a chat gone before SAVE is not sent", async () => {
    const r = await selected();
    await tap(r);
    r.adapter.removeSession(refOf(r, IDLE));
    await down(r, "SAVE");
    await r.console.idle();
    expect(r.adapter.deliveries).toEqual([]);
    expect(r.console.composer.state.state).toBe("target_unavailable");
  });

  test("PRESETS scrolls a suggestion longer than the bubble to its end before moving on (no unseen text)", async () => {
    const long = "Refactor the session registry so that pinned chats survive a reconnect and add regression tests covering both the RANKED and the SPLIT layouts";
    const r = await selected([long, "Short one"]);
    await tap(r);
    expect(r.console.composer.state.suggestion).toEqual({ index: 0, count: 2 });
    await turn(r, "PRESETS", 1);
    // Scrolled: still the long one, its tail now visible.
    expect(r.console.composer.state.transcript).toBe(long);
    expect(r.console.state.detailScroll).toBe(1);
    await turn(r, "PRESETS", 1);
    expect(r.console.composer.state.transcript).toBe("Short one");
    await turn(r, "PRESETS", -1);
    expect(r.console.composer.state.transcript).toBe(long);
    expect(r.adapter.deliveries).toEqual([]);
  });

  test("protocol 3: a failed suggested review shows the reason and the text, not the label", async () => {
    const r = await selected(NEXT, 3);
    await tap(r);
    r.adapter.removeSession(refOf(r, IDLE));
    await down(r, "SAVE");
    await r.console.idle();
    expect(r.console.composer.state.state).toBe("target_unavailable");
    const lines = r.console.view().detail.lines;
    expect(r.console.composer.state.error).toBeTruthy();
    expect(lines[1]).toBe("Run the full test");
  });

  test("protocol 3 (no bubble): the review lines carry the label first", async () => {
    const r = await selected(NEXT, 3);
    await tap(r);
    expect(r.console.view().detail.lines[0]).toBe("Suggested 1/3");
    expect(r.console.view().detail.lines[1]).toBe("Run the full test");
  });
});

describe("every layout and mode", () => {
  for (const [name, proto, layout] of [
    ["Buddy", 5, "buddy"],
    ["List", 5, "list"],
    ["Grouped", 5, "grouped"],
  ] as const) {
    test(`RANKED ${name}: tap loads the suggestion`, async () => {
      const r = await selected(NEXT, proto);
      r.console.setLayouts({ sessions: layout });
      r.adapter.setSuggestions(refOf(r, IDLE), NEXT);
      expect(r.console.view().detail.lines[3]).toContain("REC next");
      await tap(r);
      expect(r.console.composer.state.transcript).toBe(NEXT[0]);
    });
  }

  test("SPLIT keys (protocol 6): the bubble row, the hint and the tap work on the selected white key", async () => {
    const r = await rig("mixed", { scope: "recent" });
    r.console.setProtocol(6);
    r.console.setSettings({ keys: "split" });
    expect(r.console.view().keys).toBe("split");
    await turn(r, "SELECT", 1);
    const key = r.console.registry.selection().key;
    const e = key === null ? undefined : r.console.registry.get(key);
    if (!e) throw new Error("nothing selected");
    r.adapter.upsertSession({ ...e.session, status: { ...e.session.status }, details: { ...e.session.details, suggestions: ["Try split"] } });
    const sel = r.console.registry.get(key!)!;
    const accepts = sel.session.prompt?.acceptsPrompt !== false && !["working", "approval_required"].includes(r.console.inbox.displayState(sel));
    if (accepts) expect(r.console.view().detail.lines[3]).toContain("REC next");
    expect((r.console.view().text ?? []).some((x) => x.text === "Next: Try split")).toBe(true);
    await tap(r);
    expect(r.console.composer.state).toMatchObject({ state: "reviewing", transcript: "Try split", source: "suggested" });
  });

  test("the reader (DETAILS) is open: the tap works on the shown chat", async () => {
    const r = await selected(NEXT, 5);
    await turn(r, "PRESETS", 1); // opens the reader (protocol 5)
    expect(r.console.view().view).toBe("detail");
    await tap(r);
    expect(r.console.composer.state.transcript).toBe(NEXT[0]);
    expect(r.console.view().view).toBe("voice");
  });
});
