// Logical device input. Ids follow the HAL order used by docs/protocol.md section 4.

export const BUTTONS = [
  "OCT_DOWN", "OCT_UP", "FX", "SEL", "ENV", "LFO", "EDIT", "GLO", "HOME", "SAVE", "ARP", "SEQ", "PLAY", "REC",
] as const;
export type ButtonName = (typeof BUTTONS)[number];

export const ENCODERS = ["SELECT", "ALGORITHM", "K1", "K2", "K3", "K4", "PRESETS"] as const;
export type EncoderName = (typeof ENCODERS)[number];

export type KeyGesture = "single" | "double" | "long" | "down" | "up";

export type DeviceInput =
  | { kind: "button"; button: ButtonName; edge: "down" | "up" }
  | { kind: "key"; key: number; gesture: KeyGesture }
  | { kind: "encoder"; encoder: EncoderName; delta: number };

export const buttonById = (id: number): ButtonName | undefined => BUTTONS[id];
export const encoderById = (id: number): EncoderName | undefined => ENCODERS[id];
