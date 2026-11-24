// DeviceView (agent-core) -> FM1C SET_* frames (docs/protocol.md section 4). Pure.
import type { DeliveryStage, DeviceView, SlotView } from "@fm1/agent-core";
import {
  DETAIL_VERSION,
  LIST_VERSION,
  MAX_BODY,
  RICH_TEXT_VERSION,
  SLOT_COUNT,
  spansToWire,
  stripSpans,
  SPLIT_VERSION,
  TEXT_ROWS,
  TEXT_ROWS_PER_FRAME,
  type CommandResultCode,
  type HostMessage,
  type LinkState,
  type Provider,
  type SetDetail,
  type SetLegend,
  type SetSlot,
  type SetStatus,
  type SetText,
  type SetView,
  type SetVoice,
} from "@fm1/device-protocol";

const LINK: Record<DeviceView["status"]["link"], LinkState> = { ok: "ok", degraded: "backend_degraded", down: "backend_down" };

const STAGE: Record<DeliveryStage, CommandResultCode> = {
  accepted_locally: "accepted_locally",
  sent: "sent",
  backend_acknowledged: "acknowledged",
  completed: "completed",
  failed: "failed",
  unsupported: "unsupported",
  target_unavailable: "target_unavailable",
};

export const stageCode = (stage: DeliveryStage): CommandResultCode => STAGE[stage];

const provider = (p: SlotView["provider"]): Provider => p ?? "none";

const EMPTY: SlotView = { state: "empty", label: "", selected: false, provider: null, stale: false, pinned: false };

/** SET_SLOT; with protocol version 5 (the view carries row fields) also the list row's title and age. */
export function slotFrame(key: number, s: SlotView | undefined, list = false): SetSlot {
  const v = s ?? EMPTY;
  const f: SetSlot = {
    kind: "SET_SLOT",
    key,
    state: v.state,
    // (`chosen` only when set, version 6 SPLIT: every earlier frame stays exactly as it was)
    flags: { selected: v.selected, codex: v.provider === "codex", stale: v.stale, pinned: v.pinned, ...(v.chosen && !v.selected ? { chosen: true } : {}) },
    label: v.label,
  };
  if (list || v.title !== undefined || v.age !== undefined || v.row !== undefined) {
    f.title = v.title ?? "";
    f.age = v.age ?? "";
  }
  // Version 5 GROUPED (docs/ui-v3.md section 9.5): the row byte, and the header on a group's first key.
  if (v.row !== undefined) {
    f.row = { ...v.row };
    if (v.row.start && v.head) f.head = { ...v.head };
  }
  return f;
}

/** SET_VIEW; with protocol version 5 (`layout` not null) the trailing layout byte (docs/ui-v3.md section 8.6). */
export function viewFrame(v: DeviceView): SetView {
  const f: SetView = {
    kind: "SET_VIEW",
    view: v.view,
    page: Math.min(127, v.page),
    pages: Math.min(127, Math.max(1, v.pages)),
    title: v.title,
  };
  if (v.layout !== null && v.layout !== undefined) {
    f.layout = v.layout;
    // Version 6 (docs/ui-v3.md section 10.6): the keys byte; SPLIT adds the task page and the task page count.
    if (v.keys === "split") {
      const pages = Math.min(127, Math.max(1, v.taskPages ?? 1));
      Object.assign(f, { keys: "split", taskPage: Math.max(0, Math.min(pages - 1, v.taskPage ?? 0)), taskPages: pages });
    } else if (v.keys === "ranked") f.keys = "ranked";
  }
  return f;
}

/** Version 5 views carry the row fields on every slot (empty slots: "" and ""). */
const isList = (v: DeviceView): boolean => v.layout !== null && v.layout !== undefined;

export const detailFrame = (v: DeviceView): SetDetail => ({
  kind: "SET_DETAIL",
  provider: provider(v.detail.provider),
  state: v.detail.state,
  lines: v.detail.lines,
});

export const voiceFrame = (v: DeviceView): SetVoice => ({
  kind: "SET_VOICE",
  voice: v.voice.state,
  level: v.voice.level,
  elapsedDs: v.voice.elapsedDs,
  target: v.voice.target,
});

export const legendFrame = (v: DeviceView): SetLegend => ({ kind: "SET_LEGEND", labels: v.legend });

export const statusFrame = (v: DeviceView): SetStatus => ({
  kind: "SET_STATUS",
  link: LINK[v.status.link],
  attentionCount: v.status.attentionCount,
  text: v.status.text,
});

/**
 * The SET_TEXT rows as frames, rows 0-2, 3-5, 6-8, 9-11 (docs/protocol.md section 4): the DETAILS page (version 3),
 * and with version 4 also the speech bubble of the base views and voice (docs/ui-v3.md section 5). Empty when the
 * view carries no rows.
 */
export function textFrames(v: DeviceView): SetText[] {
  if (v.text === null) return [];
  const out: SetText[] = [];
  for (let row = 0; row < TEXT_ROWS; row += TEXT_ROWS_PER_FRAME) {
    const lines = Array.from({ length: TEXT_ROWS_PER_FRAME }, (_, i) => v.text?.[row + i] ?? { style: "body" as const, text: "" });
    // Version 7 highlights (docs/ui-v3.md section 13) as control bytes; framesFor strips them for older devices.
    out.push({ kind: "SET_TEXT", row, lines: lines.map((l) => ({ style: l.style, text: spansToWire(l.text, l.spans) })) });
  }
  return out;
}

/** SET_TEXT body bytes: row, count, then per row style, length and the text bytes. */
const textBody = (lines: SetText["lines"]): number => 2 + lines.reduce((n, l) => n + 2 + l.text.length, 0);

/**
 * Version 7: a group whose rows carry enough control bytes to pass MAX_BODY (three 37-byte rows are 119 bytes) goes as
 * consecutive frames of fewer rows, in row order (docs/protocol.md section 4, SET_TEXT rules). Below version 7 the
 * control bytes are stripped (a rule becomes a space), so the rows keep their columns and the group stays one frame.
 */
export function richText(proto: number | null, f: SetText): SetText[] {
  if (proto === null || proto < RICH_TEXT_VERSION) return [{ ...f, lines: f.lines.map((l) => ({ style: l.style, text: stripSpans(l.text) })) }];
  if (textBody(f.lines) <= MAX_BODY) return [f];
  const out: SetText[] = [];
  let lines: SetText["lines"][number][] = [];
  let row = f.row;
  for (const l of f.lines) {
    if (lines.length > 0 && textBody([...lines, l]) > MAX_BODY) {
      out.push({ kind: "SET_TEXT", row, lines });
      row += lines.length;
      lines = [];
    }
    lines.push(l);
  }
  if (lines.length > 0) out.push({ kind: "SET_TEXT", row, lines });
  return out;
}

/** Full resync in the order protocol section 3 prescribes (SET_TEXT last: version 3 in `detail`, version 4 always). */
export function fullFrames(v: DeviceView): HostMessage[] {
  const slots = Array.from({ length: SLOT_COUNT }, (_, k) => slotFrame(k, v.slots[k], isList(v)));
  return [viewFrame(v), ...slots, detailFrame(v), legendFrame(v), voiceFrame(v), statusFrame(v), ...textFrames(v)];
}

/**
 * A device below version 3 never gets SET_TEXT or the `detail` view (docs/protocol.md section 3): its codec would
 * refuse them. The console keeps the DETAILS page closed for such a device; this is the wire-level guard.
 */
export function framesFor(proto: number | null, frames: readonly HostMessage[]): HostMessage[] {
  const v5 = proto !== null && proto >= LIST_VERSION;
  const v6 = proto !== null && proto >= SPLIT_VERSION;
  // Below version 6 the version 6 forms never go out (docs/ui-v3.md section 10.6): no keys/task bytes, no chosen flag,
  // no view 6. Below version 5 the version 5 fields never go out (a version 1-4 codec refuses the longer bodies).
  const strip6 = (f: HostMessage): HostMessage => {
    if (v6) return f;
    if (f.kind === "SET_VIEW" && (f.keys !== undefined || f.taskPage !== undefined || f.taskPages !== undefined)) {
      const { keys: _k, taskPage: _p, taskPages: _n, ...rest } = f;
      return rest;
    }
    if (f.kind === "SET_SLOT" && f.flags.chosen !== undefined) {
      const { chosen: _c, ...flags } = f.flags;
      return { ...f, flags };
    }
    return f;
  };
  const strip = (f0: HostMessage): HostMessage => {
    const f = strip6(f0);
    if (v5) return f;
    if (f.kind === "SET_VIEW" && f.layout !== undefined) {
      const { layout: _l, ...rest } = f;
      return rest;
    }
    if (f.kind === "SET_SLOT" && (f.title !== undefined || f.age !== undefined || f.row !== undefined)) {
      const { title: _t, age: _a, row: _r, head: _h, ...rest } = f;
      return rest;
    }
    return f;
  };
  const settings = (f: HostMessage): boolean => f.kind === "SET_VIEW" && f.view === "settings";
  if (!v6) frames = frames.filter((f) => !settings(f));
  if (proto !== null && proto >= DETAIL_VERSION) return frames.flatMap((f) => (f.kind === "SET_TEXT" ? richText(proto, f) : [strip(f)]));
  return frames.filter((f) => f.kind !== "SET_TEXT" && !(f.kind === "SET_VIEW" && f.view === "detail")).map(strip);
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export interface FrameDiff {
  /** Non-slot frames, in resync order. */
  frames: HostMessage[];
  /** Changed slots, to be coalesced. */
  slots: SetSlot[];
}

/** Only the elements that changed between two views (SET_* are full replacements, so this is safe). */
export function diffFrames(prev: DeviceView, next: DeviceView): FrameDiff {
  const frames: HostMessage[] = [];
  // DETAILS rows: every group when the page appears, else only the groups that changed. They go BEFORE SET_VIEW:
  // the device keeps the rows of the last DETAILS page in every view, so a SET_VIEW(detail) sent first would draw
  // the previous chat's rows until the new ones arrive (docs/protocol.md section 4, SET_TEXT rules).
  // Version 4 order rule (docs/ui-v3.md section 5): the rows mean different things in the base views and in DETAILS,
  // so every switch between them sends all four groups, still before SET_VIEW. Same view: only changed groups.
  // Version 5: a layout change (SEQ) is such a switch too - rows 1-2 are 24 wide in List, 28 in Buddy.
  // Version 6 (docs/ui-v3.md section 10.6): a keys change, entering or leaving SETTINGS, and in SPLIT every view switch
  // (the bubble has 4 body rows in view 0, 5 in voice and confirm) are such switches too.
  const keysChanged = (prev.keys ?? null) !== (next.keys ?? null);
  const switched =
    (prev.view === "detail") !== (next.view === "detail") ||
    (prev.layout ?? null) !== (next.layout ?? null) ||
    keysChanged ||
    (prev.view === "settings") !== (next.view === "settings") ||
    (next.keys === "split" && prev.view !== next.view);
  const before = switched ? [] : textFrames(prev);
  for (const f of textFrames(next)) if (!same(before.find((b) => b.row === f.row), f)) frames.push(f);
  const nv = viewFrame(next);
  if (!same(viewFrame(prev), nv)) frames.push(nv);
  const slots: SetSlot[] = [];
  for (let k = 0; k < SLOT_COUNT; k++) {
    const f = slotFrame(k, next.slots[k], isList(next));
    // A keys change re-sends all 27 slots in one flush (docs/ui-v3.md section 10.6).
    if (keysChanged || !same(slotFrame(k, prev.slots[k], isList(prev)), f)) slots.push(f);
  }
  const pairs: [HostMessage, HostMessage][] = [
    [detailFrame(prev), detailFrame(next)],
    [legendFrame(prev), legendFrame(next)],
    [voiceFrame(prev), voiceFrame(next)],
    [statusFrame(prev), statusFrame(next)],
  ];
  for (const [a, b] of pairs) if (!same(a, b)) frames.push(b);
  return { frames, slots };
}
