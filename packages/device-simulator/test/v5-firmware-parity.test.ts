// Protocol version 5, the LIST layout (docs/ui-v3.md section 8): the simulator's screen against the firmware's own
// screenshots, as v4-firmware-parity.test.ts does for version 4. The firmware's v5 scenarios
// (firmware/tests/console/scenario/scenarios.ts) are replayed through the real codec into the simulator's state and
// drawn at each shot's device time; reports/evidence/ui-v3/after/host/v5-*.png must match byte for byte in RGB565.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
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
const connected: Local = (s) => ({ ...s, link: { ...s.link, phase: "connected", proto: 5 } });
const help: Local = (s) => ({ ...connected(s), local: { ...s.local, help: true } });

/** scenario -> [shot name, device time of the shot, the device-local state the panel input made] */
const CASES: Record<string, [string, number, Local][]> = {
  "v5-list-sessions": [["v5-list-sessions", 1500, connected]],
  "v5-list-todo": [["v5-list-todo", 1700, connected]],
  "v5-list-toggle": [["v5-list-toggle-buddy", 1000, connected], ["v5-list-toggle-list", 1500, connected], ["v5-list-toggle-back", 2500, connected]],
  "v5-list-window": [["v5-list-window", 1500, connected], ["v5-list-window-top", 2000, connected]],
  "v5-list-page": [["v5-list-page", 1500, connected]],
  "v5-list-detail": [["v5-list-detail-before", 900, connected], ["v5-list-detail", 1500, connected], ["v5-list-detail-closed", 2900, connected]],
  "v5-list-voice": [["v5-list-voice-before", 900, connected], ["v5-list-voice", 2000, connected], ["v5-list-voice-back", 2900, connected]],
  "v5-list-anim": [["v5-list-anim-0", 2000, connected], ["v5-list-anim-125", 2125, connected], ["v5-list-anim-250", 2250, connected]],
  "v5-help": [["v5-help-before", 1000, connected], ["v5-help-not-yet", 1450, connected], ["v5-help", 1600, help], ["v5-help-held", 1900, help], ["v5-help-closed", 2300, connected]],
};

// docs/ui-v3.md section 9.11 replaced FM1C_HELP_BASE5; the help shots are compared only once the firmware carries the
// new table and the shots were taken after it (the firmware step regenerates them).
const HELP_H = `${ROOT}firmware/firmware/src/fm1c_help.h`;
const helpIsNew = existsSync(HELP_H) && readFileSync(HELP_H, "utf8").includes("HELP - SEQ buddy/list/group");
const shotIsFresh = (shot: string): boolean => existsSync(`${SHOTS}${shot}.png`) && statSync(`${SHOTS}${shot}.png`).mtimeMs >= statSync(HELP_H).mtimeMs;
const STALE_HELP = new Set(["v5-help", "v5-help-held"].filter((s) => !helpIsNew || !shotIsFresh(s)));

const scenariosHaveV5 = existsSync(`${SCENARIO_DIR}scenarios.ts`) && readFileSync(`${SCENARIO_DIR}scenarios.ts`, "utf8").includes('"v5-list-sessions"');
const available = scenariosHaveV5 && existsSync(`${SHOTS}v5-list-sessions.png`);

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

describe("version 5 (LIST) simulator screen equals the firmware host screenshots (RGB565)", () => {
  test.if(available)("every v5 scenario shot is pixel-identical", async () => {
    const { Scenario, SCENARIOS } = await loadScenarios();
    const results: Record<string, number> = {};
    for (const [name, shots] of Object.entries(CASES)) {
      const def = SCENARIOS.find((d) => d.name === name);
      if (!def) continue;
      const sc = new Scenario(name);
      def.build(sc);
      const { delivered } = sc.render();
      for (const [shot, at, local] of shots) {
        if (!existsSync(`${SHOTS}${shot}.png`) || STALE_HELP.has(shot)) continue;
        let s = initialState(5);
        for (const d of delivered) {
          if (!d.msg || d.at > at) continue;
          const r = decode(encode(d.msg, 1));
          if (r.ok) s = applyHostMessage(s, r.value.message as HostMessage, d.at);
        }
        results[shot] = diff(local(s), at, shot);
      }
    }
    expect(Object.keys(results).length).toBeGreaterThanOrEqual(22 - STALE_HELP.size);
    expect(results).toEqual(Object.fromEntries(Object.keys(results).map((k) => [k, 0])));
  }, 60_000);
});
