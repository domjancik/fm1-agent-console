// The GROUPED round (docs/ui-v3.md section 9.14): the firmware's v5g scenarios replayed through the real codec into the
// simulator's state and its transition engine (TransitionScreen), compared with the firmware's host-mode shots
// reports/evidence/ui-v3/after/host/v5g-*.png in RGB565, mid-transition step shots included. Skipped until the
// firmware step has produced the shots.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decode, encode, payloadToMidi, type HostMessage } from "@fm1/device-protocol";
import { applyHostMessage, initialState, KNOB_ROW_MS, type DeviceState } from "../src/state";
import { TransitionScreen } from "../src/v4/transitions";
import { readPng } from "./png";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SHOTS = `${ROOT}reports/evidence/ui-v3/after/host/`;
const SCENARIO_DIR = `${ROOT}firmware/tests/console/scenario/`;
/** SCL must be held this long before the firmware shows the help (helpScenario: no help at 350 ms, help at 500 ms). */
const HELP_HOLD_MS = 400;
/** The scenario builder's MIDI rate (builder.ts CC_PER_MS). */
const CC_PER_MS = 16;

interface Delivered {
  at: number;
  msg?: HostMessage;
}
type PanelStep = { kind: "keys"; mask: number } | { kind: "btn" | "btndown" | "btnup"; id: number } | { kind: "enc"; id: number; steps: number } | { kind: "shot"; name: string } | { kind: string };
interface ScenarioLike {
  render(): { delivered: Delivered[] };
}
interface ScenarioDefLike {
  name: string;
  build(s: ScenarioLike): void;
}

/**
 * Firmware deviations from section 9.10 that the simulator does not copy, with their exact pixel counts. Empty since
 * the firmware review of 2026-11-18 fixed fm1c_tr_hero (rows 0-5 are now cleared after the copy loop).
 */
const KNOWN_FIRMWARE_DIFFS: Record<string, number> = {};

/** The scenario names section 9.14 lists. */
export const V5G_SCENARIOS = [
  "v5g-grouped", "v5g-grouped-window", "v5g-pinned", "v5g-pinned-empty", "v5g-trans-select", "v5g-trans-hero", "v5g-trans-page", "v5g-trans-seq",
  "v5g-trans-reader", "v5g-trans-reader-page", "v5g-trans-window", "v5g-trans-toast", "v5g-trans-interrupt", "v5g-help",
] as const;

const scenarioSrc = existsSync(`${SCENARIO_DIR}scenarios.ts`) ? readFileSync(`${SCENARIO_DIR}scenarios.ts`, "utf8") : "";
const shotFiles = existsSync(SHOTS) ? readdirSync(SHOTS).filter((f) => f.startsWith("v5g-") && f.endsWith(".png")) : [];
const available = scenarioSrc.includes('"v5g-grouped"') && shotFiles.length > 0;

function diff(fb: { get(x: number, y: number): number }, shot: string): number {
  const png = readPng(readFileSync(`${SHOTS}${shot}.png`));
  const scale = png.w / 240;
  let n = 0;
  for (let y = 0; y < 240; y++)
    for (let x = 0; x < 240; x++) {
      const j = (y * scale * png.w + x * scale) * 3;
      const fw = (((png.rgb[j] ?? 0) >> 3) << 11) | (((png.rgb[j + 1] ?? 0) >> 2) << 5) | ((png.rgb[j + 2] ?? 0) >> 3);
      if (fb.get(x, y) !== fw) n++;
    }
  return n;
}

/** Replays one scenario: host frames (through the codec) and panel input in time order; shots read at their times. */
function replay(sc: ScenarioLike): Record<string, number> {
  const { delivered } = sc.render();
  const panel = ((sc as unknown as { panel?: { t: number; step: PanelStep }[] }).panel ?? []).slice().sort((a, b) => a.t - b.t);
  type Ev = { at: number; msg?: HostMessage; step?: PanelStep };
  // The firmware opens the help only after SCL has been held HELP_HOLD_MS (fm1c "SCL held 400 ms"): a synthetic event.
  const helpOn: Ev[] = [];
  panel.forEach((p, i) => {
    if (p.step.kind !== "btndown" || !("id" in p.step) || p.step.id !== 3) return;
    const up = panel.slice(i + 1).find((q) => q.step.kind === "btnup" && "id" in q.step && q.step.id === 3);
    if (!up || up.t >= p.t + HELP_HOLD_MS) helpOn.push({ at: p.t + HELP_HOLD_MS, step: { kind: "helpon" } });
  });
  const evs: Ev[] = [...delivered.filter((d) => d.msg).map((d) => ({ at: d.at, msg: d.msg })), ...panel.map((p) => ({ at: p.t, step: p.step })), ...helpOn].sort((a, b) => a.at - b.at);
  let s: DeviceState = initialState(5);
  s = { ...s, link: { ...s.link, phase: "connected", proto: 5 } };
  const scr = new TransitionScreen(s, 0);
  const out: Record<string, number> = {};
  let mask = 0; // the keys held (a "keys" step with a new bit is a key down: a press, section 9.10.1)
  for (const e of evs) {
    if (e.msg) {
      const payload = encode(e.msg, 1);
      const r = decode(payload);
      if (!r.ok) continue;
      s = applyHostMessage(s, r.value.message as HostMessage, e.at);
      // The frame's CCs stream in at CC_PER_MS: its first byte arrived this much before it was complete.
      scr.apply(s, e.at, e.at - Math.ceil(payloadToMidi(payload, "host").length / CC_PER_MS) + 1);
      continue;
    }
    const st = e.step;
    if (!st) continue;
    if (st.kind === "shot" && "name" in st) {
      if (existsSync(`${SHOTS}${st.name}.png`)) out[st.name] = diff(scr.frame(e.at), st.name);
      continue;
    }
    if (st.kind === "helpon") s = { ...s, local: { ...s.local, help: true } };
    else if (st.kind === "btnup" && "id" in st && st.id === 3) s = { ...s, local: { ...s.local, help: false } };
    else if (s.local.help) continue; // under the help only SCL's edges count (the firmware drops every other input)
    else if (st.kind === "enc" && "id" in st && st.id >= 2 && st.id <= 5) s = { ...s, local: { ...s.local, knobLit: st.id - 2, knobUntilMs: e.at + KNOB_ROW_MS } };
    else {
      const m = st.kind === "keys" && "mask" in st ? st.mask : mask;
      scr.input(e.at, st.kind === "enc" || (m & ~mask) !== 0);
      mask = m;
      continue;
    }
    scr.input(e.at, st.kind === "enc");
    scr.apply(s, e.at);
  }
  return out;
}

describe("GROUPED round (section 9): the simulator equals the firmware host shots, transitions included (RGB565)", () => {
  test("every scenario section 9.14 names exists in the spec list", () => {
    expect(V5G_SCENARIOS.length).toBe(14);
  });

  test.if(available)("every v5g shot is pixel-identical", async () => {
    const builder = await import(`${SCENARIO_DIR}builder.ts`);
    const scenarios = await import(`${SCENARIO_DIR}scenarios.ts`);
    const results: Record<string, number> = {};
    for (const def of scenarios.SCENARIOS as ScenarioDefLike[]) {
      if (!def.name.startsWith("v5g-")) continue;
      const sc = new builder.Scenario(def.name) as ScenarioLike;
      def.build(sc);
      Object.assign(results, replay(sc));
    }
    expect(Object.keys(results).length).toBeGreaterThan(0);
    // Exact counts, so a firmware fix shows up here (then the entry goes).
    expect(results).toEqual(Object.fromEntries(Object.keys(results).map((k) => [k, KNOWN_FIRMWARE_DIFFS[k] ?? 0])));
  }, 120_000);
});
