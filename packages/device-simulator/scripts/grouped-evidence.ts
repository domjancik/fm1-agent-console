// Evidence for docs/ui-v3.md section 9 from the simulator: the Grouped screen, PINNED empty, a strip of every transition
// (each step and the end state side by side, 2x) and the LED v2 timelines. Writes reports/evidence/ui-v3/grouped/.
// Run: bun packages/device-simulator/scripts/grouped-evidence.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { HostMessage, SlotFlags, SlotState } from "@fm1/device-protocol";
import { breathNs, buttonLeds, keyLed, type LedLevel } from "../src/leds";
import { applyHostMessage, initialState, type DeviceState } from "../src/state";
import { expand565, type Framebuffer } from "../src/v4/raster";
import { renderV4 } from "../src/v4/screen";
import { TransitionScreen, type Transition } from "../src/v4/transitions";
import { writePng } from "../test/png";

const OUT = fileURLToPath(new URL("../../../reports/evidence/ui-v3/grouped/", import.meta.url));
mkdirSync(OUT, { recursive: true });
const NO: SlotFlags = { selected: false, codex: false, stale: false, pinned: false };
const base = (): DeviceState => {
  const s = initialState(5);
  return { ...s, link: { ...s.link, phase: "connected", proto: 5 } };
};
const apply = (s: DeviceState, msgs: HostMessage[], at = 0): DeviceState => msgs.reduce((a, m) => applyHostMessage(a, m, at), s);

const TEXT: HostMessage[] = [
  { kind: "SET_TEXT", row: 0, lines: [{ style: "heading", text: "Failed, 1m" }, { style: "body", text: "Error: bun test exited 1:" }, { style: "body", text: "3 failing in codec.test" }] },
  { kind: "SET_TEXT", row: 3, lines: [{ style: "body", text: "" }, { style: "body", text: "" }, { style: "body", text: "" }] },
];

function grouped(sel: number, layout: "grouped" | "list" | "buddy" = "grouped", extra: HostMessage[] = []): DeviceState {
  const g = layout === "grouped";
  const row = (indent: 0 | 1 | 2, start = false, task = false) => (g ? { row: { indent, start, task } } : {});
  const head = (state: SlotState, title: string, count: string, pinned = false) => (g ? { head: { state, pinned, title, count } } : {});
  const slots: HostMessage[] = [
    { kind: "SET_SLOT", key: 0, state: "idle", flags: { ...NO, pinned: true, selected: sel === 0 }, label: "notes", title: "release notes", age: "9m", ...row(1, true), ...head("idle", "Pinned", "all quiet", true) },
    { kind: "SET_SLOT", key: 1, state: "waiting_input", flags: { ...NO, selected: sel === 1 }, label: "voice q", title: "which mic to use?", age: "2m", ...row(1, true), ...head("waiting_input", "Voice composer", "1 need you") },
    { kind: "SET_SLOT", key: 2, state: "failed", flags: { ...NO, selected: sel === 2 }, label: "fw build", title: "fw build failed", age: "1m", ...row(1, true), ...head("failed", "Firmware v5", "1 need you") },
    { kind: "SET_SLOT", key: 3, state: "working", flags: { ...NO, codex: true, selected: sel === 3 }, label: "fw tests", title: "host-mode shots", age: "now", ...row(1) },
    { kind: "SET_SLOT", key: 4, state: "idle", flags: { ...NO, selected: sel === 4 }, label: "lint", title: "sub agent: lint", age: "4m", ...row(2) },
    { kind: "SET_SLOT", key: 5, state: "completed_unread", flags: { ...NO, selected: sel === 5 }, label: "docs", title: "protocol.md pass", age: "6m", ...row(1, true), ...head("completed_unread", "Docs pass", "1 need you") },
    { kind: "SET_SLOT", key: 6, state: "idle", flags: NO, label: "Old task", title: "Old refactor", age: "3d", ...row(0, true, true), ...head("idle", "Old refactor", "4 quiet") },
  ];
  return apply(base(), [
    { kind: "SET_VIEW", view: "sessions", page: 0, pages: 2, title: "RECENT 6", layout },
    ...slots,
    { kind: "SET_DETAIL", provider: "claude", state: sel === 3 ? "working" : "failed", lines: ["", "", "", "PRESETS read"] },
    { kind: "SET_LEGEND", labels: ["SHOW", "REPO", "TASK", "TALK"] },
    ...TEXT,
    ...extra,
  ]);
}

const toRgb = (fb: Framebuffer): Uint8Array => {
  const rgb = new Uint8Array(240 * 240 * 3);
  for (let i = 0; i < 240 * 240; i++) {
    const [r, g, b] = expand565(fb.px[i] ?? 0);
    rgb.set([r, g, b], i * 3);
  }
  return rgb;
};
const png = (name: string, fb: Framebuffer): void => writeFileSync(`${OUT}${name}.png`, writePng({ w: 240, h: 240, rgb: toRgb(fb) }, 2));

/** Frames side by side with a 4 px gap. */
function strip(name: string, frames: Framebuffer[]): void {
  const w = frames.length * 244 - 4;
  const rgb = new Uint8Array(w * 240 * 3).fill(60);
  frames.forEach((fb, n) => {
    const src = toRgb(fb);
    for (let y = 0; y < 240; y++) rgb.set(src.subarray(y * 720, y * 720 + 720), (y * w + n * 244) * 3);
  });
  writeFileSync(`${OUT}${name}.png`, writePng({ w, h: 240, rgb }, 2));
}

png("grouped-sessions", renderV4(grouped(2), 1000));
png("grouped-window-sub-agent", renderV4(grouped(4), 1000));
png(
  "pinned-empty",
  renderV4(
    apply(base(), [
      { kind: "SET_VIEW", view: "sessions", page: 0, pages: 1, title: "PINNED 0", layout: "grouped" },
      { kind: "SET_DETAIL", provider: "none", state: "empty", lines: ["", "", "", "SEQ buddy  SCL help"] },
      { kind: "SET_TEXT", row: 0, lines: [{ style: "heading", text: "No pins yet" }, { style: "muted", text: "hold a key to pin" }, { style: "body", text: "" }] },
    ]),
    1000,
  ),
);

const log: string[] = [];
function film(name: string, prev: DeviceState, next: DeviceState, t0 = 1000): void {
  const scr = new TransitionScreen(prev, 0);
  const t: Transition | null = scr.apply(next, t0);
  if (!t) throw new Error(`${name}: no transition`);
  const times = [...t.steps.map((s) => t0 + s.at), t0 + 300];
  strip(`trans-${name}`, times.map((x) => scr.frame(x)));
  log.push(`${name}: ${t.kind}, steps at ${t.steps.map((s) => s.at).join("/")} ms, px per step ${t.steps.map((s) => (s.content ? "content" : s.rects.reduce((a, r) => a + r.w * r.h, 0))).join("/")}`);
}

film("select", grouped(2), grouped(3));
film("hero", grouped(3), apply(grouped(3), [{ kind: "SET_DETAIL", provider: "claude", state: "completed_unread", lines: ["", "", "", ""] }]));
film("page", grouped(2), apply(grouped(2), [{ kind: "SET_VIEW", view: "sessions", page: 1, pages: 2, title: "RECENT 6", layout: "grouped" }]));
film("seq", grouped(2, "list"), grouped(2));
const reader = apply(grouped(2), [
  { kind: "SET_TEXT", row: 0, lines: [{ style: "heading", text: "Failed" }, { style: "body", text: "fw build failed" }, { style: "muted", text: "Firmware v5" }] },
  { kind: "SET_TEXT", row: 3, lines: [{ style: "heading", text: "Last message 1m" }, { style: "body", text: "bun test exited 1: three" }, { style: "body", text: "failing in codec.test.ts" }] },
  { kind: "SET_VIEW", view: "detail", page: 0, pages: 2, title: "DETAILS" },
]);
film("reader-open", grouped(2), reader);
film("reader-page", reader, apply(reader, [{ kind: "SET_TEXT", row: 3, lines: [{ style: "heading", text: "Facts" }, { style: "body", text: "opus, 41% context" }, { style: "body", text: "turns 12" }] }, { kind: "SET_VIEW", view: "detail", page: 1, pages: 2, title: "DETAILS" }]));
film("reader-close", reader, grouped(2));
const big = (sel: number): DeviceState => {
  const msgs: HostMessage[] = [{ kind: "SET_VIEW", view: "sessions", page: 0, pages: 1, title: "ALL 16", layout: "list" }];
  for (let k = 0; k < 16; k++) msgs.push({ kind: "SET_SLOT", key: k, state: k % 4 === 0 ? "failed" : "idle", flags: { ...NO, selected: k === sel }, label: `c${k}`, title: `chat number ${k}`, age: `${k}m` });
  msgs.push({ kind: "SET_DETAIL", provider: "claude", state: "idle", lines: ["", "", "", ""] });
  return apply(base(), [...msgs, ...TEXT]);
};
film("window", big(8), big(11));
film("toast", grouped(2), applyHostMessage(grouped(2), { kind: "COMMAND_RESULT", reqSeq: 1, result: "completed", text: "Approved" }, 1000));

// LED v2 timelines: one row per condition, 4 s at 10 ms a pixel, off/glow/full/breath as black/dim/amber/breathing.
const LED_ROWS: [string, SlotState, boolean, boolean][] = [
  ["approval_required", "approval_required", false, false], ["waiting_input", "waiting_input", false, false], ["failed", "failed", false, false],
  ["completed_unread", "completed_unread", false, false], ["working", "working", false, false], ["idle", "idle", false, false], ["unknown", "unknown", false, false],
  ["stale", "idle", false, true], ["selected idle", "idle", true, false], ["selected approval", "approval_required", true, false], ["selected failed", "failed", true, false],
];
const W = 400;
const rgb = new Uint8Array(W * LED_ROWS.length * 12 * 3);
const colour = (l: LedLevel, t: number): [number, number, number] => {
  if (l === "full") return [255, 179, 71];
  if (l === "glow") return [107, 74, 30];
  if (l === "breath") {
    const f = breathNs(t) / 48000;
    return [Math.round(107 + 148 * f), Math.round(74 + 105 * f), Math.round(30 + 41 * f)];
  }
  return [20, 20, 22];
};
LED_ROWS.forEach(([, state, selected, stale], r) => {
  for (let x = 0; x < W; x++) {
    const t = x * 10;
    const c = colour(keyLed({ state, flags: { ...NO, selected, stale }, label: "" }, t, true, 5), t);
    for (let y = r * 12 + 1; y < r * 12 + 11; y++) rgb.set(c, (y * W + x) * 3);
  }
});
writeFileSync(`${OUT}led-v2-timelines.png`, writePng({ w: W, h: LED_ROWS.length * 12, rgb }, 2));
const sample = buttonLeds(grouped(2), 0);
writeFileSync(
  `${OUT}README.md`,
  [
    "# GROUPED round: simulator evidence (docs/ui-v3.md section 9)",
    "",
    "Generated by `bun packages/device-simulator/scripts/grouped-evidence.ts` from hand-built device states (the same",
    "shapes the host sends). 2x PNGs. Transition strips show each step at its start time, then the state at t0 + 300 ms.",
    "",
    "- `grouped-sessions.png`, `grouped-window-sub-agent.png`: the Grouped list (section 9.3).",
    "- `pinned-empty.png`: PINNED with no pins (section 9.4).",
    "- `trans-*.png`: one strip per transition (section 9.10):",
    ...log.map((l) => `  - ${l}`),
    `- \`led-v2-timelines.png\`: rows ${LED_ROWS.map((r) => r[0]).join(", ")}; 4 s, 10 ms per pixel (section 9.9).`,
    `- Buttons in the Grouped screen at t = 0: ${Object.entries(sample).filter(([, v]) => v !== "off").map(([k, v]) => `${k} ${v}`).join(", ")}.`,
    "",
  ].join("\n"),
);
console.log(`wrote evidence to ${OUT}\n${log.join("\n")}`);
