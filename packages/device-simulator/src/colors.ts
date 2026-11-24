import type { SlotState } from "@fm1/device-protocol";

/** Shared LCD state colours (docs/firmware-ui.md); firmware converts these to RGB565. */
export const STATE_COLOR: Record<SlotState, string> = {
  empty: "#000000",
  disconnected: "#202020",
  idle: "#606060",
  working: "#2F7DF6",
  waiting_input: "#A050F0",
  approval_required: "#FFB000",
  completed_unread: "#20C060",
  completed_read: "#2A5A3A",
  failed: "#F03030",
  unknown: "#404040",
};

export const EMPTY_OUTLINE = "#303030";

export const UI = {
  background: "#000000",
  text: "#FFFFFF",
  dimText: "#A0A0A0",
  border: "#303030",
  selected: "#FFFFFF",
  stale: "#FFFFFF",
  bannerBg: "#C00000",
  dim: "rgba(0,0,0,0.6)",
  ok: "#20C060",
  warn: "#FFB000",
  bad: "#F03030",
  badge: "#FFB000",
} as const;

/** Converts #RRGGBB to the RGB565 word the firmware would draw. */
export function toRgb565(hex: string): number {
  const v = Number.parseInt(hex.slice(1), 16);
  const r = (v >> 16) & 0xff;
  const g = (v >> 8) & 0xff;
  const b = v & 0xff;
  return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
}
