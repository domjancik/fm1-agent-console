// The help overlay text (docs/ux-v2.md sections 2.5 and 7.6). The firmware draws the same lines from fm1c_help.h;
// test/control-map.test.ts requires byte equality so the two cannot drift.

export const HELP_TEXT = {
  base: [
    "HELP - let go of SCL",
    "key tap   select / open task",
    "key 2x    open on Mac",
    "key hold  pin or unpin",
    "SELECT move  PRESETS scroll",
    "ALGORITHM next needing you",
    "OCT-/OCT+ page  LFO details",
    "SAVE approve  FX deny/dismiss",
    "PLAY open/new chat  ENV stop",
    "REC hold to talk  HOME sort",
    "EDIT tasks  GLO to do",
  ],
  voice: [
    "HELP - let go of SCL",
    "REC hold    record",
    "REC let go  stop, transcribe",
    "SAVE        send",
    "FX          cancel",
    "PLAY        retry after fail",
    "PRESETS     scroll text",
  ],
  confirm: ["HELP - let go of SCL", "SAVE  yes, do it", "FX    no, go back", "Nothing else acts here."],
  detail: [
    "HELP - let go of SCL",
    "PRESETS   next/prev page",
    "OCT-/OCT+ next/prev page",
    "SELECT    next/prev chat",
    "ALGORITHM next needing you",
    "key tap   show that chat",
    "LFO/HOME  close details",
    "SAVE approve  FX deny",
    "ENV stop  PLAY open on Mac",
    "REC hold to talk",
  ],
  // Protocol version 4 (docs/ui-v3.md sections 3.A and 6.1, fm1c_help.h FM1C_HELP_BASE4 / FM1C_HELP_DETAIL4). The
  // permanent knob legend is gone: the device follows these six lines with the two knob lines built from SET_LEGEND
  // (helpKnobLines4 below), then the "who is who" grid.
  base4: [
    "HELP - let go of SCL",
    "SELECT move  PRESETS scroll",
    "key tap select  2x open",
    "LFO details  ALGORITHM next",
    "SAVE approve  FX deny",
    "REC hold to talk  ENV stop",
  ],
  // Protocol version 5 (docs/ui-v3.md section 9.11, fm1c_help.h FM1C_HELP_BASE5; replaces the never-flashed section
  // 8.8 table): the SEQ cycle first (the v4 hint bar already says "let go of SCL to close"), PRESETS opens the reader,
  // the key line names the pin. Used in every base view when proto >= 5.
  base5: [
    "HELP - SEQ buddy/list/group",
    "SELECT move  PRESETS read",
    "key tap sel 2x open hold pin",
    "LFO details  ALGORITHM next",
    "SAVE approve  FX deny",
    "REC hold to talk  ENV stop",
  ],
  // Protocol version 6 (docs/ui-v3.md section 10.11, fm1c_help.h FM1C_HELP_BASE6 / FM1C_HELP_SPLIT6 / FM1C_HELP_SETTINGS6).
  // base6: every base view with proto >= 6 while the keys are RANKED (and in TO DO and Tasks): base5 with the first line
  // naming the settings entry (hold ARP). split6: Sessions with SPLIT keys. Both are followed by the two knob lines and
  // the who-is-who grid as in version 4. settings6: the SETTINGS view (view 6); no knob lines, no grid.
  base6: [
    "HELP - SEQ view  ARP settings",
    "SELECT move  PRESETS read",
    "key tap sel 2x open hold pin",
    "LFO details  ALGORITHM next",
    "SAVE approve  FX deny",
    "REC hold to talk  ENV stop",
  ],
  split6: [
    "HELP - SEQ view  ARP settings",
    "white sel 2x open hold pin",
    "black filter/task hold pin",
    "OCT page/2x task  REC talk",
    "SELECT move  PRESETS read",
    "LFO details  ALGORITHM next",
  ],
  settings6: ["HELP - let go of SCL", "SELECT    move", "SAVE      change", "HOME/LFO/ARP  close"],
  detail4: [
    "HELP - let go of SCL",
    "PRESETS   older/newer page",
    "OCT-/OCT+ next/prev page",
    "SELECT    next/prev chat",
    "ALGORITHM next needing you",
    "key tap   show that chat",
    "LFO/HOME  close details",
    "SAVE approve  FX deny",
    "ENV stop  PLAY open on Mac",
    "REC hold to talk",
  ],
} as const satisfies Record<"base" | "voice" | "confirm" | "detail" | "base4" | "base5" | "base6" | "split6" | "settings6" | "detail4", readonly string[]>;

/** The "who is who" grid of the version 4 help: one word per character, in this order (fm1c_help.h FM1C_HELP_WORDS4). */
export const HELP_WORDS4 = ["Working", "Needs answer", "Approve?", "Failed", "Done, unread", "Asleep", "No status", "Offline"] as const;
/** The state each HELP_WORDS4 entry shows. */
export const HELP_WORDS4_STATES = ["working", "waiting_input", "approval_required", "failed", "completed_unread", "idle", "unknown", "disconnected"] as const;

/**
 * Lines 7-8 of the version 4 base help, as the firmware builds them from the SET_LEGEND labels it holds
 * (fm1c_draw4.h fm1c_v4_help_into): `KNOB1 SHOW  KNOB2 REPO`, `-` for a knob with no label.
 */
export function helpKnobLines4(legend: readonly string[]): [string, string] {
  const cell = (k: number): string => `KNOB${k + 1} ${legend[k] ? legend[k] : "-"}`;
  return [`${cell(0)}  ${cell(1)}`, `${cell(2)}  ${cell(3)}`];
}

/** Help lines are drawn in FONT_S at x = 4: 29 characters fit. */
export const HELP_LINE_MAX = 29;

/** SET_LEGEND per context: knobs only, KNOB1..KNOB4 (docs/ux-v2.md section 2.3). */
export const LEGEND = {
  sessions: ["SHOW", "REPO", "TASK", "TALK"],
  tasks: ["SHOW", "REPO", "", "TALK"],
  inbox: ["", "", "", "TALK"],
  voice: ["", "", "", ""],
  confirm: ["", "", "", ""],
  detail: ["", "", "", ""],
  /** SETTINGS (protocol 6, docs/ui-v3.md section 10.2): no knob acts. */
  settings: ["", "", "", ""],
} as const satisfies Record<string, readonly [string, string, string, string]>;
