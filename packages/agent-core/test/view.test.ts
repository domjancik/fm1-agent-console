import { describe, expect, test } from "bun:test";
import { LEGEND } from "../src/control-map";
import type { DeviceView } from "../src/view";
import { keyOf, REC_HOLD, refOf, rig, slotOf, type Rig } from "./helpers";

const press = (r: Rig, button: "HOME" | "EDIT" | "GLO" | "REC" | "SAVE" | "FX" | "ENV" | "PLAY" | "OCT_UP") =>
  r.console.handleInput({ kind: "button", button, edge: "down" });
const key = (r: Rig, k: number, gesture: "single" | "double" | "long" = "single") => r.console.handleInput({ kind: "key", key: k, gesture });

/** Every device-visible string of a view. */
const strings = (v: DeviceView): string[] => [v.title, ...v.slots.map((s) => s.label), ...v.detail.lines, ...v.legend, v.voice.target, v.status.text];

function assertClean(v: DeviceView): void {
  for (const s of strings(v)) {
    expect(s).toMatch(/^[\x20-\x7e]*$/);
    expect(s).not.toContain("--");
    expect(s).not.toContain("_");
    expect(s).not.toContain("=");
    expect(s).not.toContain("->");
    expect(s).not.toMatch(/\b[SFRP]:/);
  }
}

describe("legend per context (section 2.3)", () => {
  test("sessions, tasks, TO DO, voice, confirm", async () => {
    const r = await rig("mixed", { scope: "recent" });
    expect(r.console.view().legend).toEqual([...LEGEND.sessions]);
    expect(LEGEND.sessions).toEqual(["SHOW", "REPO", "TASK", "TALK"]);
    await press(r, "EDIT");
    expect(r.console.view().legend).toEqual(["SHOW", "REPO", "", "TALK"]);
    await press(r, "GLO");
    expect(r.console.view().legend).toEqual(["", "", "", "TALK"]);
    await press(r, "HOME");
    await key(r, slotOf(r, "s-claude-fw"));
    await press(r, "ENV");
    expect(r.console.view().view).toBe("confirm");
    expect(r.console.view().legend).toEqual(["", "", "", ""]);
    await press(r, "FX");
    await key(r, slotOf(r, "s-claude-idle"));
    await press(r, "REC");
    expect(r.console.view().view).toBe("voice");
    expect(r.console.view().legend).toEqual(["", "", "", ""]);
  });
});

describe("no cryptic strings anywhere", () => {
  test("no --, _, =, -> or one-letter button codes in any title, line or legend", async () => {
    const r = await rig("mixed", { scope: "all" });
    const seen: DeviceView[] = [];
    const snap = () => {
      const v = r.console.view();
      seen.push(v);
      assertClean(v);
    };
    snap();
    for (let k = 0; k < 8; k++) {
      await key(r, k);
      snap();
    }
    await press(r, "EDIT");
    snap();
    for (let k = 0; k < 3; k++) {
      await r.console.handleInput({ kind: "encoder", encoder: "SELECT", delta: 1 });
      snap();
    }
    await press(r, "GLO");
    snap();
    for (let k = 0; k < 4; k++) {
      await key(r, k);
      snap();
    }
    await press(r, "SAVE");
    snap();
    await press(r, "FX");
    await press(r, "HOME");
    await key(r, slotOf(r, "s-claude-idle"));
    await press(r, "REC");
    snap();
    r.adapter.dropConnection();
    snap();
    expect(seen.length).toBeGreaterThan(15);
  });
});

describe("detail lines", () => {
  test("line 1-2 continue the title, line 3 is age + what, line 4 the hint", async () => {
    const r = await rig();
    await key(r, slotOf(r, "s-codex-fw"));
    const v = r.console.view();
    expect(v.slots[slotOf(r, "s-codex-fw")]?.label).toBe("fw review");
    expect(v.detail.lines).toEqual(["Firmware app", "", "1m rm -rf build/", "SAVE approve FX deny"]);
  });

  test("inferred state is marked (guess); nothing selected explains what to do", async () => {
    const r = await rig();
    expect(r.console.view().detail.lines).toEqual(["Turn SELECT or tap a", "key.", "", "Hold SCL for help"]);
    await key(r, slotOf(r, "s-codex-tui"));
    expect(r.console.view().detail.lines[2]).toBe("1m working (guess)");
  });

  test("the voice view carries the transcript on lines 1-2 and the hint on line 4", async () => {
    const r = await rig("mixed", { scope: "recent" });
    await key(r, slotOf(r, "s-claude-idle"));
    await press(r, "REC");
    r.timers.advance(REC_HOLD);
    await r.console.handleInput({ kind: "button", button: "REC", edge: "up" });
    r.console.voiceTranscript("please add a currency check");
    expect(r.console.view().detail.lines).toEqual(["please add a", "currency check", "", "SAVE send  FX cancel"]);
    expect(r.console.view().voice.target).toBe("refund impl");
  });

  test("TO DO puts the approval summary on line 3 with its age; the slot label is the session head", async () => {
    const r = await rig();
    await press(r, "GLO");
    await key(r, 0);
    const v = r.console.view();
    expect(v.slots[0]?.label).toBe("fw review");
    expect(v.detail.lines[2]).toBe("1m rm -rf build/");
  });

  test("tasks: chats summary and PLAY hint", async () => {
    const r = await rig();
    await press(r, "EDIT");
    await r.console.handleInput({ kind: "encoder", encoder: "SELECT", delta: 1 });
    expect(r.console.view().detail.lines.slice(2)).toEqual(["2 chats, 1 needs you", "PLAY new chat"]);
  });
});

describe("titles (section 1.3)", () => {
  test("ACTIVE n, ACTIVE n +2 new, TO DO n", async () => {
    const r = await rig("forty");
    const active = r.console.view().title;
    expect(active).toMatch(/^ACTIVE \d+$/);
    // fill every free key of page 1, then two more arrivals
    const free = Array.from({ length: 27 }, (_, i) => r.console.state.layouts.sessions.slots[i] ?? null).filter((k) => k === null).length;
    const quiet = r.console.registry.sessions().filter((e) => !r.console.state.layouts.sessions.slots.includes(e.key));
    for (const e of quiet.slice(0, free + 2)) r.adapter.setState(e.session.ref, "waiting_input");
    const title = r.console.view().title;
    expect(title).toMatch(/^ACTIVE \d+ \+2 new$/);
    await press(r, "GLO");
    expect(r.console.view().title).toMatch(/^TO DO \d+$/);
    const m = await rig();
    await press(m, "GLO");
    expect(m.console.view().title).toBe("TO DO 4");
    expect(keyOf(m, "s-codex-fw")).toContain("s-codex-fw");
    expect(refOf(m, "s-codex-fw").sessionId).toBe("s-codex-fw");
  });
});
