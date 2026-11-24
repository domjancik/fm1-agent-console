// Protocol version 4 screen (docs/ui-v3.md sections 3.A, 6.4): parity with the A mocks, the sprite asset, animation
// boxes, and the device-local help and knob row.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FakeClock, Link, LoopbackPair } from "@fm1/device-protocol";
import { HELP_TEXT, HELP_WORDS4, helpKnobLines4 as hostKnobLines } from "../../agent-core/src/control-map";
import { SimDevice } from "../src/device";
import { emptyText, initialState, type DeviceState } from "../src/state";
import { animFrame, expand565, SPRITES } from "../src/v4/raster";
import { animatedBoxes, HELP4, helpKnobLines4, keyBox4, renderV4, usesV4 } from "../src/v4/screen";
import { readPng } from "./png";
import { sampleDetail, sampleHelp, sampleKnob, sampleNoHost, sampleSessions, sampleTodo } from "./v4-scenes";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const MOCKS = `${ROOT}reports/evidence/ui-v3/a-buddy-bubble/1x/`;

/** Pixels where the simulator and a mock PNG differ, as [x, y]. */
function diff(s: DeviceState, mock: string, nowMs = 0): [number, number][] {
  const png = readPng(readFileSync(`${MOCKS}${mock}.png`));
  const fb = renderV4(s, nowMs);
  const out: [number, number][] = [];
  for (let i = 0; i < 240 * 240; i++) {
    const [r, g, b] = expand565(fb.px[i] ?? 0);
    if (r !== png.rgb[i * 3] || g !== png.rgb[i * 3 + 1] || b !== png.rgb[i * 3 + 2]) out.push([i % 240, Math.floor(i / 240)]);
  }
  return out;
}

/**
 * The mocks were drawn from the procedural first-pass sprites; the firmware's sprite PNGs got a hand pass on the 12x12
 * Claude ears (docs/ui-v3.md section 7). So a difference is allowed only inside a Claude mini box.
 */
function insideClaudeMini(s: DeviceState, [x, y]: [number, number]): boolean {
  const boxes: { x: number; y: number }[] = [];
  s.slots.forEach((slot, k) => {
    if (slot.state !== "empty" && !slot.flags.codex) boxes.push({ x: keyBox4(k).x + 1, y: keyBox4(k).y + 1 });
  });
  if (s.local.help) for (let i = 0; i < 8; i += 2) boxes.push({ x: 4, y: 20 + 16 * 8 + 6 + Math.floor(i / 2) * 16 + 2 });
  // The mock prints the knob lines in lower case; the firmware builds them from SET_LEGEND (`KNOB1 SHOW`).
  if (s.local.help && y >= 116 && y < 148) return true;
  return boxes.some((b) => x >= b.x && x < b.x + 12 && y >= b.y && y < b.y + 12);
}

describe("version 4 screen matches the docs/ui-v3.md A mocks (firmware fonts, RGB565)", () => {
  const cases: [string, () => DeviceState][] = [
    ["sessions", sampleSessions],
    ["todo-approval", sampleTodo],
    ["detail", sampleDetail],
    ["knob-touched", () => sampleKnob(0)],
    ["help", sampleHelp],
    ["no-companion", sampleNoHost],
  ];
  for (const [name, make] of cases) {
    // The firmware is the reference (v4-firmware-parity.test.ts: byte-identical to its screenshots). The mocks predate
    // it and differ in known details the firmware settled: the hand-edited Claude minis, upper-case knob lines in
    // help, white text on the amber badge (fm1c_dark), one tail diagonal, no tick under the selected key, the 80 %
    // frame per RGB565 channel, and a top bar that dims with the screen. So here: close to the mock, not equal.
    test.if(existsSync(`${MOCKS}${name}.png`))(`${name}: within 1.5 % of the mock (firmware-settled details only)`, () => {
      const s = make();
      const d = diff(s, name);
      expect(d.filter((p) => !insideClaudeMini(s, p)).length).toBeLessThanOrEqual(864);
    });
  }

  test("the hero, the caption, the key name and the 5 body rows are drawn; row 6 draws the more wedge", () => {
    const s = sampleSessions();
    const fb = renderV4(s, 0);
    const ink = (x0: number, y0: number, w: number, h: number): number => {
      let n = 0;
      for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (fb.get(x, y) !== 0) n++;
      return n;
    };
    expect(ink(4, 20, 48, 48)).toBeGreaterThan(400);
    let white = 0;
    for (let y = 178; y < 182; y++) for (let x = 224; x < 231; x++) if (fb.get(x, y) === 0xffff) white++;
    expect(white).toBe(16);
    const quiet = { ...s, text: s.text.map((r, i) => (i === 6 ? { style: "body" as const, text: "" } : r)) };
    const fb2 = renderV4(quiet, 0);
    let wedge = 0;
    for (let y = 178; y < 182; y++) for (let x = 224; x < 231; x++) if (fb2.get(x, y) === 0xffff) wedge++;
    expect(wedge).toBe(0);
  });
});

describe("sprite asset (fm1-v4.json) follows the firmware", () => {
  const python = spawnSync("python3", ["--version"]).status === 0;
  test.if(python)("the committed JSON equals a fresh export (fm1c_sprites.h if present, else sprites.py)", () => {
    const r = spawnSync("python3", ["-I", `${ROOT}packages/device-simulator/scripts/export_assets.py`, "--check"], { encoding: "utf8" });
    expect(r.stdout.trim()).toBe("fm1-v4.json is current");
    expect(r.status).toBe(0);
  });

  test("every state has a pose; Claude and Codex both have every pose; frames are 24x24 / 12x12 at 4 bpp", () => {
    for (const st of ["disconnected", "idle", "working", "waiting_input", "approval_required", "completed_unread", "completed_read", "failed", "unknown"]) {
      expect(SPRITES.poseOfState[st]).toBeDefined();
      expect(SPRITES.statePal[st]?.length).toBe(3);
    }
    for (const [pose, a] of Object.entries(SPRITES.anim)) {
      for (const sp of ["claude", "codex"] as const) {
        const hero = SPRITES.hero[pose as keyof typeof SPRITES.hero][sp];
        const mini = SPRITES.mini[pose as keyof typeof SPRITES.mini][sp];
        expect(hero.length).toBe(a.heroFrames);
        expect(mini.length).toBe(a.miniFrames);
        for (const f of hero) expect(f.length).toBe(288);
        for (const f of mini) expect(f.length).toBe(72);
      }
      expect(a.heroFps).toBeLessThanOrEqual(8);
    }
  });

  test("animation frames: ((now + 60) * fps / 1000) % frames, as fm1c_anim.h; calm minis never move", () => {
    // work at 8 fps, 4 frames: with the 60 ms phase its edges are at 65, 190, 315, 440 ms (anim_test.c)
    expect([0, 64, 65, 189, 190, 314, 315, 439, 440].map((t) => animFrame("work", "hero", t))).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 0]);
    for (const pose of ["sleep", "huh", "ghost"] as const) for (const t of [0, 300, 900, 4000]) expect(animFrame(pose, "mini", t)).toBe(0);
    expect(animFrame("happy", "mini", 250)).toBe(1);
  });
});

describe("animation touches only the hero box and attention minis", () => {
  test("between frames (0 -> 125 ms) nothing outside the animated boxes changes", () => {
    const s = sampleSessions();
    const a = renderV4(s, 0);
    const b = renderV4(s, 125);
    const { keys } = animatedBoxes(s);
    const boxes = [{ x: 4, y: 20, w: 48, h: 48 }, ...keys.map((k) => keyBox4(k))];
    let changed = 0;
    for (let y = 0; y < 240; y++) {
      for (let x = 0; x < 240; x++) {
        if (a.get(x, y) === b.get(x, y)) continue;
        changed++;
        expect(boxes.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)).toBe(true);
      }
    }
    expect(changed).toBeGreaterThan(0);
    // 9 attention keys on the sample page: 0-6, 12 and 14 (the stale key 11 is a ghost and stays still)
    expect(keys).toEqual([0, 1, 2, 3, 4, 5, 6, 12, 14]);
  });

  test("a page of calm chats: no key moves, only the hero breathes", () => {
    const s = sampleSessions();
    s.slots = s.slots.map((slot) => (slot.state === "empty" ? slot : { ...slot, state: "idle" }));
    s.detail = { ...s.detail, state: "idle" };
    expect(animatedBoxes(s).keys).toEqual([]);
    const a = renderV4(s, 0);
    const b = renderV4(s, 250);
    for (let y = 0; y < 240; y++) for (let x = 0; x < 240; x++) if (a.get(x, y) !== b.get(x, y)) expect(x >= 4 && x < 52 && y >= 20 && y < 68).toBe(true);
  });
});

describe("geometry and local UI", () => {
  test("mini boxes: key 0, 1 and 26 at the docs/ui-v3.md section 3.A positions, all 27 disjoint", () => {
    expect(keyBox4(0)).toEqual({ x: 8, y: 202, w: 14, h: 14 });
    expect(keyBox4(1)).toEqual({ x: 15, y: 184, w: 14, h: 14 });
    expect(keyBox4(26)).toEqual({ x: 218, y: 202, w: 14, h: 14 });
    const boxes = Array.from({ length: 27 }, (_, k) => keyBox4(k));
    for (let i = 0; i < 27; i++) {
      for (let j = i + 1; j < 27; j++) {
        const a = boxes[i];
        const b = boxes[j];
        if (!a || !b) throw new Error("box");
        const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
        expect(apart).toBe(true);
      }
    }
  });

  test("version 4 only when agreed; a version 3 link keeps the region layout", () => {
    const s = initialState(4);
    expect(usesV4(s)).toBe(true); // no host on a version 4 firmware: the v4 banner
    expect(usesV4({ ...s, link: { ...s.link, phase: "connected", proto: 3 } })).toBe(false);
    expect(usesV4({ ...s, link: { ...s.link, phase: "connected", proto: 4 } })).toBe(true);
    expect(usesV4(initialState(3))).toBe(false);
  });

  test("the knob row shows for 2 s after a turn, then the hint bar is back", () => {
    const s = sampleKnob(1000);
    const lit = renderV4(s, 1000);
    const later = renderV4(s, 3000);
    expect(lit.get(1, 225)).not.toBe(later.get(1, 225));
    expect(renderV4({ ...s, local: { ...s.local, knobLit: -1 } }, 3000).px).toEqual(later.px);
  });

  test("help tables equal agent-core HELP_TEXT (fm1c_help.h is checked there)", () => {
    expect([...HELP4.base]).toEqual([...HELP_TEXT.base4]);
    expect([...HELP4.detail]).toEqual([...HELP_TEXT.detail4]);
    expect([...HELP4.voice]).toEqual([...HELP_TEXT.voice]);
    expect([...HELP4.confirm]).toEqual([...HELP_TEXT.confirm]);
    expect([...HELP4.words]).toEqual([...HELP_WORDS4]);
    for (const legend of [["SHOW", "REPO", "TASK", "TALK"], ["SHOW", "REPO", "", "TALK"], ["", "", "", ""]]) {
      expect(helpKnobLines4(legend)).toEqual(hostKnobLines(legend));
    }
    expect(helpKnobLines4(["SHOW", "REPO", "", "TALK"])).toEqual(["KNOB1 SHOW  KNOB2 REPO", "KNOB3 -  KNOB4 TALK"]);
  });

  test("DETAILS rows 0-2 beside the hero, rows 3-11 below; voice reviewing draws the transcript rows", () => {
    const d = sampleDetail();
    const fb = renderV4(d, 0);
    let header = 0;
    for (let y = 20; y < 68; y++) for (let x = 60; x < 236; x++) if (fb.get(x, y) !== 0) header++;
    expect(header).toBeGreaterThan(300);
    const v = sampleSessions();
    v.view = { view: "voice", page: 0, pages: 1, title: "TALK" };
    v.voice = { ...v.voice, voice: "reviewing", level: 0, elapsedDs: 34, target: "voice tests" };
    const text = emptyText();
    text[1] = { style: "body", text: "please rerun the voice tests" };
    v.text = text;
    const a = renderV4(v, 0);
    v.text = emptyText();
    const b = renderV4(v, 0);
    let rows = 0;
    for (let y = 96; y < 112; y++) for (let x = 8; x < 232; x++) if (a.get(x, y) !== b.get(x, y)) rows++;
    expect(rows).toBeGreaterThan(100);
  });
});

describe("SimDevice speaks version 5 (including every version 4 rule)", () => {
  test("negotiates 5 with a 1..5 host; SCL shows help locally; a K1 turn lights the knob row", async () => {
    const clock = new FakeClock();
    const pair = new LoopbackPair();
    const host = Link.host({ transport: pair.host, clock, hostSession: 9 });
    host.start();
    const dev = new SimDevice({ transport: pair.device, clock });
    dev.start();
    for (let i = 0; i < 20 && dev.state.link.phase !== "connected"; i++) {
      clock.advance(50);
      await new Promise((r) => setImmediate(r));
    }
    // (the simulator and the host both speak 1..5 now: version 5 includes every version 4 rule)
    expect(dev.state.link.proto).toBe(5);
    expect(dev.state.local.maxProto).toBe(5);
    dev.button("SEL", true);
    expect(dev.state.local.help).toBe(true);
    dev.button("SEL", false);
    expect(dev.state.local.help).toBe(false);
    dev.turn("K1", 1);
    expect(dev.state.local.knobLit).toBe(0);
    expect(dev.state.local.knobUntilMs - dev.nowMs).toBe(2000);
    dev.turn("PRESETS", 1);
    expect(dev.state.local.knobLit).toBe(0);
    dev.stop();
    host.close();
  });

  test("a version 3 identity negotiates 3 and never draws the v4 layout", async () => {
    const clock = new FakeClock();
    const pair = new LoopbackPair();
    const host = Link.host({ transport: pair.host, clock, hostSession: 9 });
    host.start();
    const dev = new SimDevice({ transport: pair.device, clock, identity: { versions: { min: 1, max: 3 } } });
    dev.start();
    for (let i = 0; i < 20 && dev.state.link.phase !== "connected"; i++) {
      clock.advance(50);
      await new Promise((r) => setImmediate(r));
    }
    expect(dev.state.link.proto).toBe(3);
    expect(usesV4(dev.state)).toBe(false);
    dev.turn("K1", 1);
    expect(dev.state.local.knobLit).toBe(-1);
    dev.stop();
    host.close();
  });
});
