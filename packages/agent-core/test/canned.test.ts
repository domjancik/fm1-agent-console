// Canned responses (docs/ui-v3.md section 12): the REC tap list (suggestions, then canned), PRESETS cycling, SAVE
// through the unchanged dispatch path, the uses count, ARP save on a review, FX hold delete with undo.
import { describe, expect, test } from "bun:test";
import {
  addCanned,
  CANNED_DELETE_HOLD_MS,
  CANNED_MAX,
  cannedId,
  cannedList,
  cannedText,
  restoreCanned,
  seedCanned,
  sortCanned,
  useCanned,
  type CannedEntry,
} from "../src/canned";
import { DISMISS_UNDO_MS } from "../src/inbox";
import { ARP_HOLD_MS } from "../src/split";
import { keyOf, REC_HOLD, refOf, rig, slotOf, type Rig } from "./helpers";

const down = (r: Rig, button: string) => r.console.handleInput({ kind: "button", button: button as never, edge: "down" });
const up = (r: Rig, button: string) => r.console.handleInput({ kind: "button", button: button as never, edge: "up" });
const turn = (r: Rig, encoder: string, delta = 1) => r.console.handleInput({ kind: "encoder", encoder: encoder as never, delta });
async function press(r: Rig, button: string, heldMs = 60) {
  const a = await down(r, button);
  r.timers.advance(heldMs);
  return [...a, ...(await up(r, button))];
}
const tap = (r: Rig, heldMs = 120) => press(r, "REC", heldMs);
async function dictate(r: Rig, text: string) {
  await down(r, "REC");
  r.timers.advance(REC_HOLD);
  await up(r, "REC");
  r.console.voiceTranscript(text);
}

const IDLE = "s-claude-idle";
const entry = (id: string, text: string, uses = 0, createdAt = 1): CannedEntry => ({ id, text, uses, createdAt, lastUsedAt: null });
const CANNED = [entry("a", "Alpha canned", 0, 30), entry("b", "Bravo canned", 0, 20), entry("c", "Charlie canned", 0, 10)];

async function selected(opts: { suggestions?: string[] | null; canned?: CannedEntry[]; proto?: number; changed?: CannedEntry[][] } = {}) {
  const changed = opts.changed;
  const r = await rig("mixed", { scope: "recent", canned: opts.canned ?? CANNED, ...(changed ? { onCannedChanged: (c: CannedEntry[]) => void changed.push(c) } : {}) });
  r.console.setProtocol(opts.proto ?? 4);
  await r.console.handleInput({ kind: "key", key: slotOf(r, IDLE), gesture: "single" });
  r.adapter.setSuggestions(refOf(r, IDLE), opts.suggestions ?? null);
  return r;
}
const texts = (r: Rig) => r.console.state.canned.map((e) => e.text);
const rows = (r: Rig) => r.console.view().text ?? [];

describe("canned list helpers", () => {
  test("text is ASCII-folded, whitespace-collapsed, trimmed and capped at 2000", () => {
    expect(cannedText("  Café  naïve\n\tok ☃ ")).toBe("Cafe naive ok");
    expect(cannedText("x".repeat(2100))).toHaveLength(2000);
  });

  test("order: uses desc, then createdAt desc; a use re-sorts and stamps lastUsedAt", () => {
    const list = sortCanned([entry("old", "old", 0, 1), entry("new", "new", 0, 5), entry("hot", "hot", 2, 0)]);
    expect(list.map((e) => e.id)).toEqual(["hot", "new", "old"]);
    const used = useCanned(useCanned(useCanned(list, "old", 77), "old", 78), "old", 99);
    expect(used.map((e) => e.id)).toEqual(["old", "hot", "new"]);
    expect(used[0]).toMatchObject({ uses: 3, lastUsedAt: 99 });
  });

  test("add refuses empty, duplicates (trimmed, case-insensitive) and a full list; ids stay unique", () => {
    const base = [entry("a", "Continue where you stopped.")];
    expect(addCanned(base, "   ", 5)).toEqual({ ok: false, reason: "empty" });
    expect(addCanned(base, "  continue WHERE you stopped.  ", 5)).toEqual({ ok: false, reason: "duplicate" });
    const full = Array.from({ length: CANNED_MAX }, (_, i) => entry(`e${i}`, `text ${i}`));
    expect(addCanned(full, "one more", 5)).toEqual({ ok: false, reason: "full" });
    const r = addCanned(base, "New one", 5);
    expect(r.ok && r.list.map((e) => e.text)).toEqual(["New one", "Continue where you stopped."]);
    const id = cannedId([entry(cannedId([], 5), "x")], 5);
    expect(id).toBe(`${cannedId([], 5)}-2`);
  });

  test("seed: three entries in the listed order; restore puts a deleted entry back once", () => {
    const seed = sortCanned(seedCanned());
    expect(seed.map((e) => e.text)).toEqual([
      "Status update? What's done, what's left, and any blockers.",
      "Rebase on main, fix CI, push, and tell me when it's green.",
      "Continue where you stopped.",
    ]);
    const gone = seed.slice(1);
    const back = restoreCanned(gone, seed[0]!);
    expect(back?.map((e) => e.id)).toEqual(seed.map((e) => e.id));
    expect(restoreCanned(back!, seed[0]!)).toBeNull();
  });

  test("cannedList keeps well-formed entries only (folded, no duplicates, at most 50)", () => {
    const list = cannedList([entry("a", "A"), { id: "", text: "x" }, entry("b", " a "), { id: "c", text: "C", uses: -1 }, "junk"]);
    expect(list.map((e) => [e.id, e.text, e.uses])).toEqual([["a", "A", 0], ["c", "C", 0]]);
  });
});

describe("REC tap: suggestions first, then canned", () => {
  test("no suggestions: the tap opens the canned list (labelled, nothing sent)", async () => {
    const r = await selected();
    const actions = await tap(r);
    expect(actions.map((a) => a.type)).toEqual(["voiceStart", "voiceSuggest"]);
    expect(r.console.composer.state).toMatchObject({ state: "reviewing", transcript: "Alpha canned", source: "canned", cannedId: "a", suggestion: { index: 0, count: 3 } });
    expect(rows(r)[1]).toEqual({ style: "heading", text: "Canned 1/3  PRESETS next" });
    expect(rows(r)[2]).toEqual({ style: "body", text: "Alpha canned" });
    expect(r.adapter.deliveries).toEqual([]);
  });

  test("one canned entry: label `Canned`; protocol 3 lines carry the label", async () => {
    const r = await selected({ canned: [entry("only", "Just this")] });
    await tap(r);
    expect(rows(r)[1]).toEqual({ style: "heading", text: "Canned" });
    const r3 = await selected({ proto: 3 });
    await tap(r3);
    expect(r3.console.view().detail.lines[0]).toBe("Canned 1/3");
  });

  test("combined order and PRESETS wrap: suggestions (Suggested i/n) then canned (Canned i/n)", async () => {
    const r = await selected({ suggestions: ["Sugg one", "Sugg two"] });
    await tap(r);
    const seen: [string, string][] = [];
    for (let i = 0; i < 5; i++) {
      seen.push([r.console.composer.state.transcript, rows(r)[1]!.text]);
      await turn(r, "PRESETS", 1);
    }
    expect(seen).toEqual([
      ["Sugg one", "Suggested 1/2  PRESETS next"],
      ["Sugg two", "Suggested 2/2  PRESETS next"],
      ["Alpha canned", "Canned 1/3  PRESETS next"],
      ["Bravo canned", "Canned 2/3  PRESETS next"],
      ["Charlie canned", "Canned 3/3  PRESETS next"],
    ]);
    expect(r.console.composer.state.transcript).toBe("Sugg one"); // wrapped
    await turn(r, "PRESETS", -1);
    expect(r.console.composer.state.transcript).toBe("Charlie canned");
    expect(r.adapter.deliveries).toEqual([]);
  });

  test("a new-chat TALK destination (no suggestions there) offers the canned list", async () => {
    const r = await selected({ suggestions: ["ignored for a new chat"] });
    await turn(r, "K4", 1);
    expect(r.console.state.talk).not.toBe("reply");
    await tap(r);
    expect(r.console.composer.state).toMatchObject({ state: "reviewing", source: "canned", transcript: "Alpha canned" });
    expect(r.console.composer.state.destination?.mode).toBe("new-session");
  });

  test("empty canned list and no suggestions: `No suggestion/canned`, nothing recorded", async () => {
    const r = await selected({ canned: [] });
    expect((await tap(r)).map((a) => a.type)).toEqual(["voiceStart", "voiceDiscard"]);
    expect(r.console.state.notice?.text).toBe("No suggestion/canned");
    expect(r.console.composer.state.state).toBe("ready");
  });
});

describe("SAVE and the uses count", () => {
  test("SAVE sends the canned text exactly like dictated text; uses and lastUsedAt go up; the list re-sorts and is saved", async () => {
    const changed: CannedEntry[][] = [];
    const r = await selected({ changed });
    await tap(r);
    await turn(r, "PRESETS", 1);
    await turn(r, "PRESETS", 1);
    expect(r.console.composer.state.transcript).toBe("Charlie canned");
    const actions = await down(r, "SAVE");
    expect(actions.map((a) => a.type)).toEqual(["voiceSubmit"]);
    await r.console.idle();
    expect(r.adapter.deliveries).toEqual([{ requestId: "req-1", kind: "prompt", key: keyOf(r, IDLE), text: "Charlie canned" }]);
    const c = r.console.state.canned[0];
    expect(c).toMatchObject({ id: "c", uses: 1 });
    expect(c?.lastUsedAt).toBeGreaterThan(0);
    expect(texts(r)).toEqual(["Charlie canned", "Alpha canned", "Bravo canned"]);
    expect(changed.at(-1)?.map((e) => e.id)).toEqual(["c", "a", "b"]);

    // The same chat, dictated: the identical delivery shape.
    await dictate(r, "Charlie canned");
    await down(r, "SAVE");
    await r.console.idle();
    expect(r.adapter.deliveries[1]).toEqual({ requestId: "req-2", kind: "prompt", key: keyOf(r, IDLE), text: "Charlie canned" });
    expect(r.console.state.canned[0]?.uses).toBe(1); // a dictated send is not a canned use
  });

  test("a new-task destination: SAVE asks first, the confirming SAVE sends and counts the use", async () => {
    const r = await selected();
    for (let i = 0; i < 4 && !r.console.state.talk.endsWith("task"); i++) await turn(r, "K4", 1);
    expect(r.console.state.talk.endsWith("task")).toBe(true);
    await tap(r);
    expect(r.console.composer.state.destination?.mode).toBe("new-task");
    await down(r, "SAVE");
    expect(r.console.state.confirm?.type).toBe("voiceSubmit");
    expect(r.console.state.canned.every((e) => e.uses === 0)).toBe(true);
    expect((await down(r, "SAVE")).map((a) => a.type)).toEqual(["voiceSubmit"]);
    expect(r.console.state.canned.find((e) => e.id === "a")?.uses).toBe(1);
  });

  test("PRESETS after a re-sort follows the shown entry by id", async () => {
    const r = await selected({ canned: [entry("a", "A", 0, 3), entry("b", "B", 0, 2)] });
    await tap(r);
    await turn(r, "PRESETS", 1);
    await down(r, "SAVE");
    await r.console.idle();
    await down(r, "FX");
    expect(texts(r)).toEqual(["B", "A"]);
    await tap(r);
    expect(r.console.composer.state.transcript).toBe("B");
    await turn(r, "PRESETS", 1);
    expect(r.console.composer.state.transcript).toBe("A");
  });

  test("nothing is counted without SAVE (FX cancels)", async () => {
    const r = await selected();
    await tap(r);
    await press(r, "FX");
    expect(r.console.composer.state.state).toBe("cancelled");
    expect(r.console.state.canned.every((e) => e.uses === 0)).toBe(true);
    expect(r.adapter.deliveries).toEqual([]);
  });
});

describe("ARP on a review saves a canned response", () => {
  test("dictated text: `Saved as canned N`, nothing sent, the review stays; a repeat says `Already canned`", async () => {
    const changed: CannedEntry[][] = [];
    const r = await selected({ changed });
    await dictate(r, "  Please  run the linter ");
    const a = await press(r, "ARP");
    expect(a).toEqual([]);
    expect(r.console.state.notice?.text).toBe("Saved as canned 4");
    expect(texts(r)).toContain("Please run the linter");
    expect(texts(r)[0]).toBe("Please run the linter"); // newest first among equal uses
    expect(changed).toHaveLength(1);
    expect(r.console.composer.state).toMatchObject({ state: "reviewing", source: "voice" });
    await press(r, "ARP");
    expect(r.console.state.notice?.text).toBe("Already canned");
    expect(changed).toHaveLength(1);
    await dictate(r, "PLEASE RUN THE LINTER");
    await press(r, "ARP");
    expect(r.console.state.notice?.text).toBe("Already canned");
    expect(r.adapter.deliveries).toEqual([]);
    await down(r, "SAVE");
    await r.console.idle();
    expect(r.adapter.deliveries).toHaveLength(1);
  });

  test("a suggested text can be saved too", async () => {
    const r = await selected({ suggestions: ["Ship the fix"] });
    await tap(r);
    await press(r, "ARP");
    expect(r.console.state.notice?.text).toBe("Saved as canned 4");
    expect(texts(r)).toContain("Ship the fix");
  });

  test("a full list refuses: `Canned list full`", async () => {
    const full = Array.from({ length: CANNED_MAX }, (_, i) => entry(`e${i}`, `text ${i}`, 0, i));
    const r = await selected({ canned: full });
    await dictate(r, "one more");
    await press(r, "ARP");
    expect(r.console.state.notice?.text).toBe("Canned list full");
    expect(r.console.state.canned).toHaveLength(CANNED_MAX);
  });

  test("protocol 6: ARP on a review never opens SETTINGS (tap saves, a hold does nothing); base views keep the SETTINGS gesture", async () => {
    const r = await selected({ proto: 6 });
    await dictate(r, "hold test");
    await down(r, "ARP");
    r.timers.advance(ARP_HOLD_MS + 200);
    await up(r, "ARP");
    expect(r.console.state.settingsFrom).toBeNull();
    expect(r.console.view().view).toBe("voice");
    expect(texts(r)).not.toContain("hold test");
    await press(r, "ARP");
    expect(r.console.state.settingsFrom).toBeNull();
    expect(r.console.state.notice?.text).toBe("Saved as canned 4");
    await down(r, "FX");
    // Base view: a tap toasts, a hold opens SETTINGS, as before.
    await press(r, "ARP");
    expect(r.console.state.notice?.text).toBe("Hold ARP: settings");
    await down(r, "ARP");
    r.timers.advance(ARP_HOLD_MS);
    expect(r.console.view().view).toBe("settings");
  });

  test("the review bubble hints the gesture when the text leaves a row free", async () => {
    const r = await selected();
    await dictate(r, "short text");
    expect(rows(r)[5]).toEqual({ style: "muted", text: "ARP save canned" });
    expect(r.console.view().detail.lines[3]).toBe("SAVE send  FX cancel");
    await down(r, "FX");
    await tap(r);
    expect(rows(r)[5]).toEqual({ style: "muted", text: "Hold FX: delete canned" });
    await press(r, "FX");
    await dictate(r, "a much longer dictated text that wraps over several rows of the speech bubble on the device screen");
    expect(rows(r).some((x) => x.text === "ARP save canned")).toBe(false);
  });
});

describe("FX hold deletes a canned entry", () => {
  test("held 1 s: deleted, the next entry shown; FX within 3 s restores it", async () => {
    const changed: CannedEntry[][] = [];
    const r = await selected({ changed });
    await tap(r);
    expect(await down(r, "FX")).toEqual([]);
    expect(r.console.composer.state.state).toBe("reviewing"); // the up edge decides
    r.timers.advance(CANNED_DELETE_HOLD_MS);
    await up(r, "FX");
    expect(r.console.state.notice?.text).toBe("Canned deleted");
    expect(texts(r)).toEqual(["Bravo canned", "Charlie canned"]);
    expect(r.console.composer.state).toMatchObject({ state: "reviewing", transcript: "Bravo canned", source: "canned" });
    expect(changed).toHaveLength(1);
    r.timers.advance(DISMISS_UNDO_MS - 500);
    await down(r, "FX");
    expect(r.console.state.notice?.text).toBe("Canned restored");
    expect(texts(r)).toEqual(["Alpha canned", "Bravo canned", "Charlie canned"]);
    expect(r.console.composer.state.transcript).toBe("Alpha canned");
    await up(r, "FX");
    expect(r.console.composer.state.state).toBe("reviewing"); // the restoring press does not cancel
    expect(r.adapter.deliveries).toEqual([]);
  });

  test("a plain FX tap still cancels and keeps the entry; FX after the window does not restore", async () => {
    const r = await selected();
    await tap(r);
    await press(r, "FX", CANNED_DELETE_HOLD_MS - 1);
    expect(r.console.composer.state.state).toBe("cancelled");
    expect(r.console.state.notice?.text).toBe("Cancelled");
    expect(texts(r)).toHaveLength(3);
    await tap(r);
    await press(r, "FX", CANNED_DELETE_HOLD_MS);
    expect(texts(r)).toHaveLength(2);
    r.timers.advance(DISMISS_UNDO_MS + 1);
    await press(r, "FX");
    expect(texts(r)).toHaveLength(2);
    expect(r.console.composer.state.state).toBe("cancelled");
  });

  test("any other input ends the undo window", async () => {
    const r = await selected();
    await tap(r);
    await press(r, "FX", CANNED_DELETE_HOLD_MS);
    await turn(r, "PRESETS", 1);
    await press(r, "FX");
    expect(texts(r)).toHaveLength(2);
  });

  test("deleting the last entry closes the review; FX then restores it from the base view", async () => {
    const r = await selected({ canned: [entry("only", "Only one")] });
    await tap(r);
    await press(r, "FX", CANNED_DELETE_HOLD_MS);
    expect(r.console.state.canned).toEqual([]);
    expect(r.console.composer.state.state).toBe("cancelled");
    expect(r.console.view().view).toBe("sessions");
    await down(r, "FX");
    expect(r.console.state.notice?.text).toBe("Canned restored");
    await up(r, "FX");
    expect(texts(r)).toEqual(["Only one"]);
  });

  test("FX hold on a suggested or dictated review cancels at the down edge as before (no delete)", async () => {
    const r = await selected({ suggestions: ["Sugg"] });
    await tap(r);
    await down(r, "FX");
    expect(r.console.composer.state.state).toBe("cancelled");
    r.timers.advance(CANNED_DELETE_HOLD_MS);
    await up(r, "FX");
    expect(texts(r)).toHaveLength(3);
  });
});

describe("outside the device", () => {
  test("setCanned replaces the list (a CLI edit) without reporting it back", async () => {
    const changed: CannedEntry[][] = [];
    const r = await selected({ changed });
    r.console.setCanned([entry("z", "From the CLI", 0, 99)]);
    expect(texts(r)).toEqual(["From the CLI"]);
    expect(changed).toEqual([]);
    await tap(r);
    expect(r.console.composer.state.transcript).toBe("From the CLI");
  });
});
