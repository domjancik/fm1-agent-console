/**
 * Reads a terminal (TUI) agent's screen and says whether typed text would land as a normal user message:
 *
 *   idle    the TUI shows its input prompt, empty, with no dialog and no turn running -> safe to type
 *   busy    a turn is running (spinner / "esc to interrupt" right above the prompt)
 *   draft   the input box already holds text (the operator's own draft on the Mac): typing would merge with it
 *   dialog  a permission prompt, trust dialog, menu or selection list is showing: keystrokes would answer it
 *   unknown no input prompt was recognized (starting up, exited, a harness layout we do not know)
 *
 * `idle` and `busy` may be typed into (a prompt submitted during a turn is queued by the TUI). Everything else is
 * refused before anything is written.
 *
 * Claude Code (observed live on host 1.5.4, Claude Code 2.1.311): the input box is a `❯` line between two rules of `─`,
 * status lines below; the trust dialog shows `❯ No, exit` / `Yes, I trust this folder` / `Enter to confirm · Esc to
 * cancel` with no input box. Codex CLI (pattern only, no live Codex TUI was available): the composer is a `›` line,
 * footer hints such as `⏎ send` or `? for shortcuts`; approvals show `Would you like to run the following command?` and
 * a `› 1. Yes, proceed` list. Unknown layouts are refused (`unknown`), never guessed.
 */
import type { ScreenCell } from "./terminal-screen";

export type TuiScreenState = "idle" | "busy" | "draft" | "dialog" | "unknown";

export interface TuiScreenVerdict {
  readonly state: TuiScreenState;
  /** Short reason, safe to log (no screen text). */
  readonly reason: string;
  /** Row of the recognized input prompt, or -1. */
  readonly promptRow: number;
  /**
   * A turn-running marker (spinner / "esc to interrupt") sits above the input prompt, whatever the state. `draft` wins
   * over `busy` in `state`, so after a paste this is what tells "our text in the box of an idle TUI" from "our text in
   * the box while a turn runs" (Enter then queues it behind the turn).
   */
  readonly turnRunning?: boolean;
}

export type TypingHarness = "claude" | "codex";

/** Harnesses whose TUI input prompt this module recognizes, i.e. the ones the typing route serves. */
export const TYPING_HARNESSES: ReadonlySet<string> = new Set<TypingHarness>(["claude", "codex"]);

interface HarnessRules {
  /** The input prompt glyph at the start of the input line. */
  readonly glyph: string;
  /** A rule line must sit right above the prompt (Claude's box) within this many rows; 0 = no rule needed. */
  readonly ruleAbove: number;
  readonly busy: readonly RegExp[];
  readonly dialog: readonly RegExp[];
}

const RULE = /^[\s]*[─━]{8,}/u;
/** A numbered option selected by a menu cursor: `❯ 1. Yes`, `› 2. No`. */
const SELECTED_OPTION = /^\s*[❯›>]\s*\d+[.)]\s/u;

const COMMON_DIALOG: readonly RegExp[] = [
  SELECTED_OPTION,
  /\bdo you want to\b/i,
  /\bwould you like to\b/i,
  /\benter to (confirm|select|continue)\b/i,
  /\bpress enter to\b/i,
  /\besc to (cancel|exit|go back|close)\b/i,
  /\btrust (this|the) (folder|files|directory)\b/i,
  /\byes, (and|i trust|allow|proceed)\b/i,
  /\bno, and tell\b/i,
  /\b(allow|approve|deny) (this|command|once|always)\b/i,
  /\(y\/n\)/i,
];

const RULES: Record<TypingHarness, HarnessRules> = {
  claude: {
    glyph: "❯",
    ruleAbove: 2,
    busy: [/esc to interrupt/i, /^\s*[·✢✳✶✻✽*⏺●◐◓◑◒]\s+[A-Z][a-zé]+(ing)?…/u],
    dialog: COMMON_DIALOG,
  },
  codex: {
    glyph: "›",
    ruleAbove: 0,
    busy: [/esc to interrupt/i, /^\s*[•◦·]\s+Working\b/u],
    dialog: [...COMMON_DIALOG, /\bAllow command\?/i, /\bApprove\b.*\?/],
  },
};

const NBSP = / /g;

function promptText(row: readonly ScreenCell[] | undefined, line: string, glyph: string): string {
  const at = line.indexOf(glyph);
  if (row === undefined) return line.slice(at + glyph.length).replace(NBSP, " ").trim();
  // Cells after the glyph that are not faint (placeholder / hint text is drawn faint or gray).
  let seen = false;
  let out = "";
  for (const cell of row) {
    if (!seen) seen = cell.ch === glyph;
    else if (!cell.faint) out += cell.ch;
  }
  return out.replace(NBSP, " ").trim();
}

/**
 * Classifies the visible screen. `cells` (same rows as `lines`) lets faint placeholder text count as empty; without
 * it, any text after the prompt glyph counts as a draft.
 */
export function classifyTuiScreen(lines: readonly string[], harness: TypingHarness, cells?: readonly (readonly ScreenCell[])[]): TuiScreenVerdict {
  const rules = RULES[harness];
  let prompt = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? "").replace(NBSP, " ");
    const trimmed = line.trimStart();
    if (!trimmed.startsWith(rules.glyph)) continue;
    if (SELECTED_OPTION.test(line)) continue;
    const after = trimmed.slice(rules.glyph.length);
    if (after.length > 0 && !after.startsWith(" ")) continue;
    if (rules.ruleAbove > 0) {
      let ok = false;
      for (let k = 1; k <= rules.ruleAbove; k++) if (RULE.test(lines[i - k] ?? "")) ok = true;
      if (!ok) continue;
    }
    prompt = i;
    break;
  }
  const tail = (from: number): string[] => lines.slice(Math.max(0, from)).map((l) => l.replace(NBSP, " "));
  if (prompt < 0) {
    // The 16 rows up to the last non-blank one (a dialog may sit at the top of a mostly empty screen).
    let last = lines.length - 1;
    while (last > 0 && (lines[last] ?? "").trim() === "") last--;
    const bottom = lines.slice(Math.max(0, last - 15), last + 1).map((l) => l.replace(NBSP, " "));
    if (bottom.some((l) => rules.dialog.some((re) => re.test(l)))) return { state: "dialog", reason: "a dialog or menu is showing (no input prompt)", promptRow: -1 };
    return { state: "unknown", reason: "no input prompt recognized on the screen", promptRow: -1 };
  }
  // A dialog drawn below the input line (menus, pickers) also takes the keystrokes.
  if (tail(prompt + 1).some((l) => rules.dialog.some((re) => re.test(l)))) {
    return { state: "dialog", reason: "a dialog or menu is showing below the input prompt", promptRow: prompt };
  }
  const text = promptText(cells?.[prompt], (lines[prompt] ?? "").replace(NBSP, " "), rules.glyph);
  // Claude's box can hold more lines before its closing rule.
  let more = "";
  if (rules.ruleAbove > 0) {
    for (let i = prompt + 1; i < lines.length && !RULE.test(lines[i] ?? ""); i++) {
      const row = cells?.[i];
      more += row === undefined ? (lines[i] ?? "").trim() : row.filter((c) => !c.faint).map((c) => c.ch).join("").replace(NBSP, " ").trim();
    }
  }
  const above = lines.slice(Math.max(0, prompt - 8), prompt).map((l) => l.replace(NBSP, " "));
  const turnRunning = above.some((l) => rules.busy.some((re) => re.test(l)));
  if (text.length > 0 || more.length > 0) return { state: "draft", reason: "the input box already holds text", promptRow: prompt, turnRunning };
  if (turnRunning) return { state: "busy", reason: "a turn is running", promptRow: prompt, turnRunning };
  return { state: "idle", reason: "input prompt is empty and no turn is running", promptRow: prompt, turnRunning };
}
