// Protocol version 4: the simulator's screen against the firmware's own screenshots (docs/ui-v3.md section 6.4).
// The firmware scenarios (firmware/tests/console/scenario/scenarios.ts) say what the host sent and when; the firmware
// host harness drew them into reports/evidence/ui-v3/after/host/*.png (2x, RGB565 expanded by << 3). Each frame goes
// through the real codec (so the strings are clipped as on the wire), into the simulator's state, and is drawn at the
// shot's device time. The target is byte equality in RGB565.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { decode, encode, type HostMessage } from "@fm1/device-protocol";
import { applyHostMessage, initialState, type DeviceState } from "../src/state";
import { renderV4 } from "../src/v4/screen";
import { readPng } from "./png";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SHOTS = `${ROOT}reports/evidence/ui-v3/after/host/`;
const SCENARIO_DIR = `${ROOT}firmware/tests/console/scenario/`;

interface Delivered {
  at: number;
  msg?: HostMessage;
}
interface ScenarioLike {
  render(): { delivered: Delivered[] };
}
interface ScenarioDefLike {
  name: string;
  build(s: ScenarioLike): void;
}

type Local = (s: DeviceState) => DeviceState;
const connected: Local = (s) => ({ ...s, link: { ...s.link, phase: "connected", proto: 4 } });
const knob: Local = (s) => ({ ...connected(s), local: { ...s.local, knobLit: 0, knobUntilMs: 1100 + 2000 } }); // K1 at 1100 ms
const help: Local = (s) => ({ ...connected(s), local: { ...s.local, help: true } });
const lost: Local = (s) => ({ ...s, local: { ...s.local, dimSinceMs: 7500 } }); // silent from 4 s, lost at 7.5 s

/** scenario -> [shot name, device time of the shot, the device-local state the panel input made] */
const CASES: Record<string, [string, number, Local][]> = {
  "v4-sessions": [["v4-sessions", 1500, connected]],
  "v4-todo-approval": [["v4-todo-approval", 1700, connected]],
  "v4-detail": [["v4-detail-before", 900, connected], ["v4-detail", 1500, connected]],
  "v4-voice": [["v4-voice-recording", 4500, connected], ["v4-voice-reviewing", 5500, connected]],
  "v4-confirm": [["v4-confirm", 1500, connected]],
  "v4-knob-touch": [["v4-knob-before", 1000, connected], ["v4-knob-touch", 1500, knob], ["v4-knob-gone", 3500, knob]],
  "v4-help": [["v4-help", 1600, help]],
  "v4-anim": [["v4-anim-0", 2000, connected], ["v4-anim-125", 2125, connected], ["v4-anim-250", 2250, connected]],
  "v4-nohost": [["v4-nohost-boot", 1500, (s) => s], ["v4-nohost", 8000, lost], ["v4-nohost-float", 8250, lost]],
};

const available = existsSync(`${SCENARIO_DIR}scenarios.ts`) && existsSync(`${SHOTS}v4-sessions.png`);

async function loadScenarios(): Promise<{ Scenario: new (name: string) => ScenarioLike; SCENARIOS: ScenarioDefLike[] }> {
  // (computed paths: the firmware's GPL test harness is run, not type-checked, from here)
  const builder = await import(`${SCENARIO_DIR}builder.ts`);
  const scenarios = await import(`${SCENARIO_DIR}scenarios.ts`);
  return { Scenario: builder.Scenario, SCENARIOS: scenarios.SCENARIOS };
}

/** Pixels where the simulator differs from a firmware screenshot, in RGB565. */
function diff(state: DeviceState, nowMs: number, shot: string): number {
  const png = readPng(readFileSync(`${SHOTS}${shot}.png`));
  const scale = png.w / 240;
  const fb = renderV4(state, nowMs);
  let n = 0;
  for (let y = 0; y < 240; y++)
    for (let x = 0; x < 240; x++) {
      const j = (y * scale * png.w + x * scale) * 3;
      const fw = (((png.rgb[j] ?? 0) >> 3) << 11) | (((png.rgb[j + 1] ?? 0) >> 2) << 5) | ((png.rgb[j + 2] ?? 0) >> 3);
      if (fb.get(x, y) !== fw) n++;
    }
  return n;
}

describe("version 4 simulator screen equals the firmware host screenshots (RGB565)", () => {
  test.if(available)("every v4 scenario shot is pixel-identical", async () => {
    const { Scenario, SCENARIOS } = await loadScenarios();
    const results: Record<string, number> = {};
    for (const [name, shots] of Object.entries(CASES)) {
      const def = SCENARIOS.find((d) => d.name === name);
      expect(def, name).toBeDefined();
      if (!def) continue;
      const sc = new Scenario(name);
      def.build(sc);
      const { delivered } = sc.render();
      for (const [shot, at, local] of shots) {
        if (!existsSync(`${SHOTS}${shot}.png`)) continue;
        let s = initialState(4);
        for (const d of delivered) {
          if (!d.msg || d.at > at) continue;
          const r = decode(encode(d.msg, 1));
          if (r.ok) s = applyHostMessage(s, r.value.message as HostMessage, d.at);
        }
        results[shot] = diff(local(s), at, shot);
      }
    }
    expect(Object.keys(results).length).toBeGreaterThanOrEqual(17);
    expect(results).toEqual(Object.fromEntries(Object.keys(results).map((k) => [k, 0])));
  }, 60_000);
});
