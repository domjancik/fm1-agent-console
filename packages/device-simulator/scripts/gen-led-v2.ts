// Writes fixtures/device/led-v2.json (docs/ui-v3.md section 9.9): the breathing table and sampled timelines of every key
// condition and button pattern, from the declarative timelines in src/leds.ts. The firmware's host-mode LED checks and
// the simulator tests read the same file. Run: bun packages/device-simulator/scripts/gen-led-v2.ts
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SlotStates, Views, VoiceStates, type SlotState } from "@fm1/device-protocol";
import { BREATH_NS, BUTTON_IDS, BUTTON_TIMELINES, buttonLedsV2, keyLed, levelAt, type LedLevel } from "../src/leds";
import { initialState } from "../src/state";

const OUT = fileURLToPath(new URL("../../../fixtures/device/led-v2.json", import.meta.url));
const NO = { selected: false, codex: false, stale: false, pinned: false };
/** Every segment edge of every timeline, the instant before it, and a full period later. */
const TIMES = [0, 59, 60, 100, 119, 120, 149, 150, 179, 180, 239, 240, 249, 250, 299, 300, 359, 360, 499, 500, 999, 1000, 1259, 1260, 1499, 1500, 1799, 1800, 1999, 2000, 2499, 2500, 2849, 2850, 2999, 3000, 3999, 4000];

const KEYS: { name: string; state: SlotState; selected: boolean; stale: boolean }[] = [
  ...(["empty", "disconnected", "idle", "working", "waiting_input", "approval_required", "completed_unread", "completed_read", "failed", "unknown"] as const).map((state) => ({ name: state, state, selected: false, stale: false })),
  { name: "stale", state: "idle", selected: false, stale: true },
  ...(["idle", "working", "waiting_input", "approval_required", "failed", "completed_unread"] as const).map((state) => ({ name: `selected_${state}`, state, selected: true, stale: false })),
];

/** Protocol 6 SPLIT (docs/ui-v3.md section 10.8): the chosen black key over every state it can carry; its own sample times. */
const CHOSEN_TIMES = [0, 350, 699, 700, 999, 1000, 1699, 1700, 2000];
const CHOSEN_STATES = ["empty", "idle", "working", "waiting_input", "approval_required", "completed_unread", "failed", "unknown"] as const;

/**
 * The button matrix (docs/ui-v3.md section 9.9, "active controls"): every view x voice state x SET_DETAIL.state, the
 * buddy layout, no attention; each row the 14 button levels (BUTTON_IDS order; "." off, "g" glow, "F" full) at
 * BUTTON_TIMES (the SAVE double blink's lit and dark phases and the REC sharp blink's).
 */
const BUTTON_TIMES = [0, 130, 250, 400];
const CH: Record<LedLevel, string> = { off: ".", glow: "g", full: "F", breath: "B" };
function buttonRow(view: (typeof Views.names)[number], voice: (typeof VoiceStates.names)[number], dstate: SlotState): string[] {
  const s0 = initialState(6);
  const s = { ...s0, link: { ...s0.link, phase: "connected" as const, proto: 6 }, view: { ...s0.view, view }, voice: { ...s0.voice, voice }, detail: { ...s0.detail, state: dstate } };
  return BUTTON_TIMES.map((t) => {
    const b = buttonLedsV2(s, t);
    return BUTTON_IDS.map((id) => CH[b[id]]).join("");
  });
}
const BUTTON_ROWS = Views.names.flatMap((view) => VoiceStates.names.flatMap((voice) => SlotStates.names.map((dstate) => ({ view, voice, dstate, levels: buttonRow(view, voice, dstate) }))));

const sample = (f: (t: number) => LedLevel, times: readonly number[] = TIMES): [number, LedLevel][] => times.map((t) => [t, f(t)]);
const file = {
  spec: "docs/ui-v3.md section 9.9",
  generatedBy: "packages/device-simulator/scripts/gen-led-v2.ts",
  levels: "off | glow (FM1_GLOW_NS) | full (lit) | breath (the backlight layer, fm1_led_bg_ns = breathNs)",
  breath: { stepMs: 20, periodMs: 3000, index: "p = (ms / 20) % 150; i = p <= 75 ? p : 150 - p" },
  breathNs: [...BREATH_NS],
  keys: KEYS.map((k) => ({ ...k, samples: sample((t) => keyLed({ state: k.state, flags: { ...NO, selected: k.selected, stale: k.stale }, label: "" }, t, true, 5)) })),
  buttons: Object.entries(BUTTON_TIMELINES).map(([name, tl]) => ({ name, samples: sample((t) => levelAt(tl, t)) })),
  buttonMatrix: { times: BUTTON_TIMES, buttons: BUTTON_IDS, rows: BUTTON_ROWS },
  chosen: CHOSEN_STATES.map((state) => ({ name: `chosen_${state}`, state, chosen: true, samples: sample((t) => keyLed({ state, flags: { ...NO, chosen: true }, label: "" }, t, true, 6), CHOSEN_TIMES) })),
};
const rows = (xs: readonly object[]): string => xs.map((x) => `    ${JSON.stringify(x)}`).join(",\n");
writeFileSync(
  OUT,
  [
    "{",
    `  "spec": ${JSON.stringify(file.spec)},`,
    `  "generatedBy": ${JSON.stringify(file.generatedBy)},`,
    `  "levels": ${JSON.stringify(file.levels)},`,
    `  "breath": ${JSON.stringify(file.breath)},`,
    `  "breathNs": ${JSON.stringify(file.breathNs)},`,
    `  "keys": [\n${rows(file.keys)}\n  ],`,
    `  "buttons": [\n${rows(file.buttons)}\n  ],`,
    `  "chosen": [\n${rows(file.chosen)}\n  ],`,
    `  "buttonMatrix": {"times": ${JSON.stringify(file.buttonMatrix.times)}, "buttons": ${JSON.stringify(file.buttonMatrix.buttons)}, "rows": [\n${rows(file.buttonMatrix.rows)}\n  ]}`,
    "}",
    "",
  ].join("\n"),
);
console.log(`wrote ${file.keys.length} key, ${file.buttons.length} button and ${file.chosen.length} chosen timelines and ${BUTTON_ROWS.length} button matrix rows to ${OUT}`);
