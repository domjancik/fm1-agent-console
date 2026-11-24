// The sample page of the docs/ui-v3.md mocks (reports/evidence/ui-v3/scripts/mocks.py) as simulator DeviceStates,
// so the version 4 renderer can be compared with the mock PNGs pixel for pixel.
import type { Provider, SlotState, TextRow } from "@fm1/device-protocol";
import { emptySlot, emptyText, initialState, type DeviceState } from "../src/state";

type Row = [key: number, state: SlotState, provider: "claude" | "codex", title: string, age: string, message: string];

export const SAMPLE: Row[] = [
  [0, "approval_required", "codex", "fw review of the console build", "12m", "I want to clean the build tree before the size check. Approve: rm -rf build/ && bun run build"],
  [1, "waiting_input", "claude", "Refund webhook retries on timeout", "4m", "Should retries use the existing exponential backoff (max 5) or the new jittered one from payments-core?"],
  [2, "failed", "claude", "Traycer adapter mapping cleanup", "1h", "3 tests failed in mapping.test.ts: lastActivityAt is undefined for terminal agents. I stopped here."],
  [3, "completed_unread", "claude", "Voice tests for the push-to-talk path", "2m", "Done. 51 of 51 voice tests pass. I fixed the race in stage-relay.ts where a late ACK marked a cancelled send as delivered, and added two tests for it. Nothing else changed."],
  [4, "working", "codex", "BLE notify keepalive", "now", "Reading the BLE notify path; next I will add a keepalive every 900 ms."],
  [5, "working", "claude", "Simulator draws version 2 layout", "1m", "Running bun test in packages/device-simulator after porting the keyboard strip."],
  [6, "completed_unread", "codex", "Help overlay text table", "20m", "The help tables match fm1c_help.h byte for byte; control-map.test.ts passes."],
  [7, "idle", "claude", "Session stats probe", "3h", "Probe finished; numbers are in session-stats.json."],
  [8, "completed_read", "codex", "Pins persistence in config", "5h", "Pins round-trip through config.ts."],
  [9, "unknown", "claude", "terminal: bun dev", "6h", ""],
  [10, "idle", "codex", "Copy audit follow-ups", "7h", "All copy rows are covered by copy.test.ts."],
  [11, "disconnected", "claude", "Old firmware notes", "2d", ""],
  [12, "working", "claude", "Details page pagination", "now", "Splitting pages at 12 rows."],
  [14, "failed", "codex", "Flash size check", "40m", "The BLE image grew past the budget check."],
  [16, "idle", "claude", "Docs pass on protocol v3", "8h", ""],
];

const WORDS: Record<SlotState, string> = {
  empty: "",
  working: "Working",
  waiting_input: "Needs answer",
  approval_required: "Needs approval",
  failed: "Failed",
  completed_unread: "Done, unread",
  completed_read: "Done",
  idle: "Idle",
  unknown: "No status",
  disconnected: "Offline",
};

export function cutWords(s: string, n: number): string {
  if (s.length <= n) return s;
  const i = s.lastIndexOf(" ", n);
  return (i > 0 ? s.slice(0, i) : s.slice(0, n)).trimEnd();
}

export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (let word of text.split(/\s+/).filter(Boolean)) {
    while (word.length > width) {
      if (line) out.push(line);
      line = "";
      out.push(word.slice(0, width));
      word = word.slice(width);
    }
    if (!word) continue;
    if (line && line.length + 1 + word.length > width) {
      out.push(line);
      line = "";
    }
    line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
}

const body = (text: string): TextRow => ({ style: "body", text });

/** The sessions screen of the A mock: ACTIVE 15, page 1/2, badge 4, key 3 selected and pinned, key 11 stale. */
export function sampleSessions(rows: Row[] = SAMPLE, sel = 3, title = "ACTIVE 15", pages = 2, badge = 4): DeviceState {
  const s = initialState(4);
  s.link = { ...s.link, phase: "connected", proto: 4 };
  s.view = { view: "sessions", page: 0, pages, title };
  s.status = { link: "ok", attentionCount: badge, text: "" };
  s.slots = Array.from({ length: 27 }, emptySlot);
  for (const [k, state, provider, t] of rows) {
    s.slots[k] = {
      state,
      label: cutWords(t, 11),
      flags: { selected: k === sel, codex: provider === "codex", stale: k === 11, pinned: k === 3 },
    };
  }
  const row = rows.find((r) => r[0] === sel);
  if (!row) return s;
  const [, state, provider, t, age, msg] = row;
  const head = cutWords(t, 11);
  s.detail = { provider: provider as Provider, state, lines: [cutWords(t.slice(head.length).trim(), 20), "", "", "REC reply  PLAY open"] };
  const lines = wrap(msg || "No message yet", 28);
  const text = emptyText();
  text[0] = { style: "heading", text: `${WORDS[state]}, ${age}` };
  lines.slice(0, 5).forEach((l, i) => (text[1 + i] = body(l)));
  text[6] = body(lines[5] ?? "");
  s.text = text;
  return s;
}

/** TO DO of the A mock: five items on keys 0-4, the approval selected. */
export function sampleTodo(): DeviceState {
  const find = (k: number): Row => SAMPLE.find((r) => r[0] === k) as Row;
  const items: Row[] = [find(0), find(1), find(2), [3, ...find(3).slice(1)] as Row, [4, ...find(14).slice(1)] as Row];
  const s = sampleSessions(items, 0, "TO DO 5", 1, 5);
  s.view = { ...s.view, view: "inbox" };
  s.detail = { ...s.detail, lines: [s.detail.lines[0], "", "", "SAVE approve FX deny"] };
  return s;
}

const DETAIL_MSG = (SAMPLE.find((r) => r[0] === 3) as Row)[5];

/** DETAILS of the A mock: the header beside the hero, the last message first. */
export function sampleDetail(): DeviceState {
  const s = sampleSessions();
  s.view = { view: "detail", page: 0, pages: 2, title: "DETAILS voice tests" };
  const rows: TextRow[] = [
    { style: "heading", text: "DONE, UNREAD 2m" },
    body("Voice tests for the"),
    body("push-to-talk path"),
    { style: "heading", text: "Last message 2m" },
    ...wrap(DETAIL_MSG, 29).map(body),
    { style: "muted", text: "Now: idle since 2m" },
    { style: "muted", text: "Claude opus-4.5" },
  ];
  const text = emptyText();
  rows.slice(0, 12).forEach((r, i) => (text[i] = r));
  s.text = text;
  return s;
}

/** KNOB1 just turned on RECENT 42: the knob row in place of the hint bar. */
export function sampleKnob(nowMs: number): DeviceState {
  const s = sampleSessions(SAMPLE, 3, "RECENT 42");
  s.legend = ["SHOW", "REPO", "TASK", "TALK"];
  s.local = { ...s.local, knobLit: 0, knobUntilMs: nowMs + 2000 };
  return s;
}

export function sampleHelp(): DeviceState {
  const s = sampleSessions();
  s.local = { ...s.local, help: true };
  return s;
}

export function sampleNoHost(): DeviceState {
  const s = sampleSessions();
  s.link = { ...s.link, phase: "no_host", proto: 0 };
  return s;
}
