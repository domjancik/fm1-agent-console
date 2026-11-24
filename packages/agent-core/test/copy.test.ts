import { describe, expect, test } from "bun:test";
import {
  ageText,
  ageWhatLine,
  APPROVAL_GONE,
  cutWords,
  hintLine,
  HINT,
  knobToast,
  listTitle,
  resultReason,
  SCOPES,
  TALK_LABEL,
  TALKS,
  titleSplit,
  toastFor,
  whatText,
  wrapWords,
} from "../src/copy";
import { DELIVERY_STAGES, NORMALIZED_STATES } from "../src/types";

const S = 1000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;
const ASCII = /^[\x20-\x7e]*$/;

describe("ageText", () => {
  test("boundaries", () => {
    expect(ageText(59 * S)).toBe("now");
    expect(ageText(60 * S)).toBe("1m");
    expect(ageText(59 * M)).toBe("59m");
    expect(ageText(60 * M)).toBe("1h");
    expect(ageText(47 * H)).toBe("47h");
    expect(ageText(48 * H)).toBe("2d");
    expect(ageText(13 * D)).toBe("13d");
    expect(ageText(14 * D)).toBe("2w");
    expect(ageText(-5 * S)).toBe("now");
  });
});

describe("titleSplit", () => {
  test("a 13-character title: head at a word boundary, the rest on line 1", () => {
    expect(titleSplit("fix the codec")).toEqual({ head: "fix the", rest: ["codec", ""], remainder: "codec" });
  });

  test("a 55-character title fills head + two lines, cut at word boundaries", () => {
    const t = "Refactor firmware console drawing for keyboard strip v2";
    expect(t.length).toBe(55);
    const { head, rest } = titleSplit(t);
    expect(head).toBe("Refactor");
    expect(rest[0]).toBe("firmware console");
    expect(rest[1]).toBe("drawing for keyboard");
    for (const x of [head, ...rest]) expect(t).toContain(x);
    expect(head.length).toBeLessThanOrEqual(12);
    for (const l of rest) expect(l.length).toBeLessThanOrEqual(20);
  });

  test("a first word longer than 12 is cut at 12 and continues on line 1", () => {
    expect(titleSplit("internationalisation of strings")).toEqual({
      head: "internationa",
      rest: ["lisation of strings", ""],
      remainder: "lisation of strings",
    });
  });

  test("non-ASCII becomes a space and runs collapse", () => {
    const { head, rest } = titleSplit("Fix  — café \u{1F680} build");
    expect(head).toBe("Fix caf");
    expect(rest[0]).toBe("build");
    expect(head + rest.join("")).toMatch(ASCII);
  });

  test("empty title", () => {
    expect(titleSplit("   ")).toEqual({ head: "", rest: ["", ""], remainder: "" });
  });
});

describe("cutting and wrapping", () => {
  test("cutWords cuts at the last space at or before the limit, no ellipsis", () => {
    expect(cutWords("timed out waiting for backend", 20)).toBe("timed out waiting");
    expect(cutWords("abcdefghijklmnopqrstuvwxyz", 20)).toBe("abcdefghijklmnopqrst");
    expect(cutWords("short", 20)).toBe("short");
  });

  test("wrapWords never exceeds the width", () => {
    for (const l of wrapWords("a supercalifragilisticexpialidocious word list here", 20)) expect(l.length).toBeLessThanOrEqual(20);
  });
});

describe("hintLine", () => {
  test("two spaces, then one space, then drop the last pair", () => {
    expect(hintLine([["REC", "reply"], ["PLAY", "open"]])).toBe("REC reply  PLAY open");
    expect(hintLine([["SAVE", "approve"], ["FX", "deny"]])).toBe("SAVE approve FX deny");
    expect(hintLine([["FX", "dismiss"], ["PLAY", "open"]])).toBe("FX dismiss PLAY open");
    expect(hintLine([["REC", "new chat"], ["PLAY", "open"]])).toBe("REC new chat");
    expect(hintLine([])).toBe("");
  });

  test("every output fits 20", () => {
    const verbs = ["approve", "deny", "reply", "new chat", "new task", "open", "stop", "dismiss", "re-sorts"];
    const buttons = ["SAVE", "FX", "REC", "PLAY", "ENV", "HOME"];
    for (const a of buttons) for (const b of buttons) for (const v of verbs) for (const u of verbs) {
      const h = hintLine([[a, v], [b, u], ["PLAY", "open"]]);
      expect(h.length).toBeLessThanOrEqual(20);
      expect(h).toMatch(ASCII);
    }
  });
});

describe("toasts (section 1.5)", () => {
  test("knob toasts", () => {
    expect(knobToast.show("active", 20)).toBe("Show: active (20)");
    expect(knobToast.show("recent", 42)).toBe("Show: recent (42)");
    expect(knobToast.show("all", 279)).toBe("Show: all (279)");
    expect(knobToast.repo("fm1-agent-console")).toBe("Repo: fm1-agent-cons");
    expect(knobToast.repo(null)).toBe("Repo: all");
    expect(knobToast.task("Refund webhook handler")).toBe("Task: Refund webhook");
    expect(knobToast.task(null)).toBe("Task: all");
    expect(TALKS.map(knobToast.talk)).toEqual(["Talk: reply", "Talk: Claude chat", "Talk: Codex chat", "Talk: Claude task", "Talk: Codex task"]);
  });

  test("success wording per action", () => {
    expect(toastFor("completed", undefined, "focus")).toBe("Opened on Mac");
    expect(toastFor("sent", undefined, "interrupt")).toBe("Stop sent");
    expect(toastFor("backend_acknowledged", undefined, "interrupt")).toBe("Stopping");
    expect(toastFor("completed", undefined, "interrupt")).toBe("Stopped");
    expect(toastFor("backend_acknowledged", undefined, "approve")).toBe("Approved");
    expect(toastFor("completed", undefined, "deny")).toBe("Denied");
    expect(toastFor("completed", undefined, "createSession")).toBe("Chat created");
    expect(["accepted_locally", "sent", "backend_acknowledged", "completed"].map((s) => toastFor(s as never))).toEqual(["Queued", "Sent", "Delivered", "Done"]);
    expect(toastFor("unsupported", "focus unsupported", "focus")).toBe("Not supported");
  });

  test("every resultReason row", () => {
    const rows: [string, string][] = [
      ["session is stale", "Chat is gone"],
      ["stale", "Chat is gone"],
      ["unknown", "Chat is gone"],
      ["target stale", "Chat is gone"],
      ["target unknown", "Chat is gone"],
      [APPROVAL_GONE, "Already answered"],
      ["approval already answered", "Already answered"],
      ["approval a-1 already resolved", "Already answered"],
      ["task gone", "Task is gone"],
      ["task unavailable", "Task is gone"],
      ["project unavailable", "Repo is gone"],
      ["target not accepting prompts", "Chat can't take it"],
      ["timed out waiting for backend acknowledgement", "No reply - retry?"],
      ["transcript is empty", "Nothing heard"],
      ["focus unsupported", "Not supported"],
      ["websocket error", "Failed - see Mac"],
      ["", "Failed - see Mac"],
    ];
    for (const [m, t] of rows) expect([m, resultReason(m)]).toEqual([m, t]);
    // Link down: the adapter's backend name, else the generic one.
    for (const m of ["disconnected", "target disconnected", "Traycer host disconnected"]) {
      expect([m, resultReason(m, "Traycer")]).toEqual([m, "Traycer offline"]);
      expect([m, resultReason(m)]).toEqual([m, "Backend offline"]);
    }
    expect(resultReason("Acme host disconnected", "Acme")).toBe("Acme offline");
    expect(toastFor("failed", "Traycer host disconnected", "focus", "Traycer")).toBe("Traycer offline");
    expect(toastFor("failed", "task gone")).toBe("Task is gone");
    expect(toastFor("target_unavailable", "session is stale")).toBe("Chat is gone");
  });
});

describe("property: every produced string is ASCII and within its limit", () => {
  test("toasts, titles, detail lines", () => {
    const messages = ["session is stale", "x".repeat(300), "café failed \u{1F680}", "approval z already resolved", ""];
    for (const stage of DELIVERY_STAGES) {
      for (const m of messages) {
        for (const a of ["focus", "interrupt", "approve", "deny", "createSession", "voice"] as const) {
          const t = toastFor(stage, m, a);
          expect(t.length).toBeLessThanOrEqual(20);
          expect(t).toMatch(ASCII);
        }
      }
    }
    for (const scope of SCOPES) for (const n of [0, 7, 279, 12345]) {
      expect(knobToast.show(scope, n).length).toBeLessThanOrEqual(20);
      const title = listTitle("ACTIVE", n, 3, "A very long task title é here");
      expect(title.length).toBeLessThanOrEqual(20);
      expect(title).toMatch(ASCII);
    }
    for (const t of Object.values(TALK_LABEL)) expect(`Talk: ${t}`.length).toBeLessThanOrEqual(20);
    for (const state of NORMALIZED_STATES) {
      for (const summary of [undefined, "café — summary that is very very long indeed"]) {
        const w = whatText({ state, stale: false, summary, taskTitle: "Firmware app" });
        const line = ageWhatLine(3 * H, w, true);
        expect(line.length).toBeLessThanOrEqual(20);
        expect(line).toMatch(ASCII);
        expect(line).not.toMatch(/_|--|=|->/);
      }
    }
    for (const h of Object.values(HINT)) for (const l of typeof h === "string" ? [h] : h) expect(l.length).toBeLessThanOrEqual(20);
  });

  test("titles carry the scope, count, new arrivals and filter", () => {
    expect(listTitle("ACTIVE", 20, 0)).toBe("ACTIVE 20");
    expect(listTitle("ACTIVE", 20, 2)).toBe("ACTIVE 20 +2 new");
    expect(listTitle("TO DO", 16, 0)).toBe("TO DO 16");
    expect(listTitle("ACTIVE", 3, 0, "Refund webhook")).toBe("ACTIVE 3 Refund");
  });

  test("line 3: age, what, guess marker, stale", () => {
    expect(ageWhatLine(12 * M, "rm -rf build/", false)).toBe("12m rm -rf build/");
    expect(ageWhatLine(2 * H, "idle", true)).toBe("2h idle (guess)");
    expect(ageWhatLine(2 * H, "gone from Traycer", false, true)).toBe("gone from Traycer");
    expect(whatText({ state: "idle", stale: false, taskTitle: "Firmware app" })).toBe("in Firmware app");
    expect(whatText({ state: "failed", stale: false })).toBe("failed");
  });
});
