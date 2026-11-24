// Physical layout and keyboard shortcuts for the virtual panel. Pure, so it is unit-tested.
import type { ButtonId, EncoderId } from "@fm1/device-protocol";

/** Key 0 is F3, key 26 is G5 (firmware discovery: `fm1_in.notes` bits 0..26). */
const FIRST_NOTE = 5; // F in a C-based octave
const BLACK = new Set([1, 3, 6, 8, 10]);

export const WHITE_W = 34;
export const BLACK_W = 22;

export interface KeyGeometry {
  key: number;
  black: boolean;
  left: number;
}

export function keyboardGeometry(count = 27): KeyGeometry[] {
  const out: KeyGeometry[] = [];
  let whites = 0;
  for (let key = 0; key < count; key++) {
    const black = BLACK.has((FIRST_NOTE + key) % 12);
    if (black) out.push({ key, black, left: whites * WHITE_W - BLACK_W / 2 });
    else out.push({ key, black, left: whites++ * WHITE_W });
  }
  return out;
}

/** Shortcut characters for keys 0..26; e, g and h are left free for the view buttons. */
export const KEY_CHARS = "1234567890qwrtyuiopasdfjkl;";

export type Shortcut =
  | { kind: "key"; key: number }
  | { kind: "button"; button: ButtonId }
  | { kind: "encoder"; encoder: EncoderId; delta: number };

const BUTTON_KEYS: Record<string, ButtonId> = {
  " ": "REC",
  Enter: "SAVE",
  Escape: "FX",
  h: "HOME",
  e: "EDIT",
  g: "GLO",
  "-": "OCT_DOWN",
  "=": "OCT_UP",
  z: "ENV",
  x: "PLAY",
};

const ENCODER_KEYS: Record<string, { encoder: EncoderId; delta: number }> = {
  ArrowLeft: { encoder: "SELECT", delta: -1 },
  ArrowRight: { encoder: "SELECT", delta: 1 },
  ArrowUp: { encoder: "ALGORITHM", delta: 1 },
  ArrowDown: { encoder: "ALGORITHM", delta: -1 },
};

/** Maps a `KeyboardEvent.key` value to a panel action. */
export function shortcutFor(eventKey: string): Shortcut | null {
  const k = eventKey.length === 1 ? eventKey.toLowerCase() : eventKey;
  const index = k.length === 1 ? KEY_CHARS.indexOf(k) : -1;
  if (index >= 0) return { kind: "key", key: index };
  const button = BUTTON_KEYS[k];
  if (button) return { kind: "button", button };
  const enc = ENCODER_KEYS[k];
  return enc ? { kind: "encoder", ...enc } : null;
}

export const shortcutHintForButton = (button: ButtonId): string => {
  const entry = Object.entries(BUTTON_KEYS).find(([, b]) => b === button);
  if (!entry) return "";
  const [key] = entry;
  return key === " " ? "spc" : key === "Escape" ? "esc" : key === "Enter" ? "ent" : key;
};

export const BUTTON_LABEL: Record<ButtonId, string> = {
  OCT_DOWN: "OCT−",
  OCT_UP: "OCT+",
  FX: "FX",
  SEL: "SEL",
  ENV: "ENV",
  LFO: "LFO",
  EDIT: "EDIT",
  GLO: "GLO",
  HOME: "HOME",
  SAVE: "SAVE",
  ARP: "ARP",
  SEQ: "SEQ",
  PLAY: "PLAY",
  REC: "REC",
};
