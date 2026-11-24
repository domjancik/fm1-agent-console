import { Link, SlotStates, type Clock, type HostMessage, type MidiTransport, type SlotState } from "@fm1/device-protocol";

/**
 * A fixture host for previewing the UI without a companion: after the handshake it sends
 * one static resync showing every slot state. It makes no decisions about input.
 */
export function demoFrames(proto = 3): HostMessage[] {
  const states = SlotStates.names;
  const slots: HostMessage[] = states.map((state: SlotState, i) => ({
    kind: "SET_SLOT",
    key: i,
    state,
    flags: { selected: i === 5, codex: i % 2 === 1, stale: i === 9, pinned: i === 0 },
    label: `${state.slice(0, 8)}-${i}`,
  }));
  return [
    { kind: "SET_VIEW", view: "sessions", page: 0, pages: 2, title: "ACTIVE 20" },
    { kind: "CLEAR_SLOTS" },
    ...slots,
    {
      kind: "SET_DETAIL",
      provider: "claude",
      state: "approval_required",
      lines: ["console wants to run", "the tests", "12m bun test", "SAVE approve FX deny"],
    },
    { kind: "SET_LEGEND", labels: ["SHOW", "REPO", "TASK", "TALK"] },
    { kind: "SET_VOICE", voice: "ready", level: 0, elapsedDs: 0, target: "" },
    { kind: "SET_STATUS", link: "ok", attentionCount: 3, text: "" },
    ...(proto >= 4 ? bubbleFrames() : []),
  ];
}

/** Version 4 (docs/ui-v3.md section 5): the speech bubble in SET_TEXT rows 0-6 of a base view. */
function bubbleFrames(): HostMessage[] {
  const rows = [
    { style: "heading" as const, text: "Needs approval, 12m" },
    { style: "body" as const, text: "Approve: bun test" },
    { style: "body" as const, text: "I changed the codec and want" },
    { style: "body" as const, text: "to run the whole suite before" },
    { style: "body" as const, text: "I write the summary. It takes" },
    { style: "body" as const, text: "about 40 seconds." },
    { style: "body" as const, text: "" },
  ];
  while (rows.length < 12) rows.push({ style: "body", text: "" });
  return [0, 3, 6, 9].map((row) => ({ kind: "SET_TEXT" as const, row, lines: rows.slice(row, row + 3) }));
}

export function startDemoHost(transport: MidiTransport, clock?: Clock): Link<"host"> {
  const link = Link.host({ transport, clock });
  link.on("negotiated", ({ proto }) => {
    for (const msg of demoFrames(proto)) link.send(msg);
  });
  link.start();
  return link;
}
