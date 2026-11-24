import type { ButtonId, EncoderId } from "@fm1/device-protocol";
import { BUTTON_IDS, breathNs, type LedLevel } from "../leds";
import type { Slot } from "../state";
import { ENCODER_IDS, type ClientMessage } from "../wire";
import { BUTTON_LABEL, KEY_CHARS, keyboardGeometry, shortcutHintForButton } from "./keymap";

type Send = (msg: ClientMessage) => void;

const ENCODER_LABEL: Record<EncoderId, string> = {
  SELECT: "SELECT",
  ALGORITHM: "ALGO",
  K1: "K1",
  K2: "K2",
  K3: "K3",
  K4: "K4",
  PRESETS: "PRESETS",
};
const PX_PER_DETENT = 8;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text) e.textContent = text;
  return e;
}

function setLed(led: HTMLElement, level: LedLevel): void {
  const cls = `led led-${level === "breath" ? "full" : level}`;
  if (led.className !== cls) led.className = cls;
  // LED language v2: the selected key breathes in the backlight layer (docs/ui-v3.md section 9.9).
  const opacity = level === "breath" ? String(Math.min(1, 0.15 + breathNs(performance.now()) / 48_000)) : "";
  if (led.style.opacity !== opacity) led.style.opacity = opacity;
}

/** Calls `down`/`up` for pointer presses, releasing on pointer up, cancel or leave-with-capture loss. */
function pressable(node: HTMLElement, down: () => void, up: () => void): void {
  let held = false;
  const release = (): void => {
    if (!held) return;
    held = false;
    node.classList.remove("pressed");
    up();
  };
  node.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    node.setPointerCapture(e.pointerId);
    held = true;
    node.classList.add("pressed");
    down();
  });
  node.addEventListener("pointerup", release);
  node.addEventListener("pointercancel", release);
  node.addEventListener("lostpointercapture", release);
}

export class Panel {
  private readonly keyLeds: HTMLElement[] = [];
  private readonly keyLabels: HTMLElement[] = [];
  private readonly keyNodes: HTMLElement[] = [];
  private readonly buttonLeds = new Map<ButtonId, HTMLElement>();
  private readonly buttonNodes = new Map<ButtonId, HTMLElement>();
  private readonly pendingTurns = new Map<EncoderId, number>();

  constructor(
    root: { keyboard: HTMLElement; buttons: HTMLElement; encoders: HTMLElement; master: HTMLInputElement; masterVal: HTMLElement },
    private readonly send: Send,
  ) {
    this.buildKeyboard(root.keyboard);
    this.buildButtons(root.buttons);
    this.buildEncoders(root.encoders);
    root.master.addEventListener("input", () => {
      const value = Number(root.master.value);
      root.masterVal.textContent = String(value);
      send({ t: "pot", value });
    });
  }

  /** Sends accumulated encoder detents; call once per animation frame. */
  flushTurns(): void {
    for (const [encoder, delta] of this.pendingTurns) {
      if (delta !== 0) this.send({ t: "encoder", encoder, delta });
    }
    this.pendingTurns.clear();
  }

  turn(encoder: EncoderId, delta: number): void {
    this.pendingTurns.set(encoder, (this.pendingTurns.get(encoder) ?? 0) + delta);
  }

  /** Reflects keyboard-shortcut presses on the on-screen controls. */
  showPressed(target: { key: number } | { button: ButtonId }, pressed: boolean): void {
    const node = "key" in target ? this.keyNodes[target.key] : this.buttonNodes.get(target.button);
    node?.classList.toggle("pressed", pressed);
  }

  update(keyLevels: readonly LedLevel[], buttonLevels: Record<ButtonId, LedLevel>, slots: readonly Slot[]): void {
    keyLevels.forEach((level, k) => {
      const led = this.keyLeds[k];
      if (led) setLed(led, level);
    });
    for (const [id, led] of this.buttonLeds) setLed(led, buttonLevels[id]);
    slots.forEach((slot, k) => {
      const lbl = this.keyLabels[k];
      if (lbl && lbl.textContent !== slot.label) lbl.textContent = slot.label;
    });
  }

  private buildKeyboard(root: HTMLElement): void {
    for (const g of keyboardGeometry()) {
      const node = el("div", `key ${g.black ? "black" : "white"}`);
      node.style.left = `${g.left}px`;
      node.title = `key ${g.key}`;
      const led = el("span", "led led-off");
      const lbl = el("span", "lbl");
      node.append(led, lbl, el("span", "hint", KEY_CHARS[g.key] ?? ""));
      pressable(
        node,
        () => this.send({ t: "key", key: g.key, down: true }),
        () => this.send({ t: "key", key: g.key, down: false }),
      );
      this.keyLeds[g.key] = led;
      this.keyLabels[g.key] = lbl;
      this.keyNodes[g.key] = node;
      root.append(node);
    }
  }

  private buildButtons(root: HTMLElement): void {
    for (const id of BUTTON_IDS) {
      const node = el("div", "btn", BUTTON_LABEL[id]);
      const led = el("span", "led led-off");
      node.append(led, el("span", "hint", shortcutHintForButton(id)));
      pressable(
        node,
        () => this.send({ t: "button", button: id, down: true }),
        () => this.send({ t: "button", button: id, down: false }),
      );
      this.buttonLeds.set(id, led);
      this.buttonNodes.set(id, node);
      root.append(node);
    }
  }

  private buildEncoders(root: HTMLElement): void {
    for (const id of ENCODER_IDS) {
      const wrap = el("div", "enc");
      const knob = el("div", "knob");
      knob.title = `${id}: drag up/down or scroll`;
      let angle = 0;
      const step = (delta: number): void => {
        angle += delta * 15;
        knob.style.setProperty("--angle", `${angle}deg`);
        this.turn(id, delta);
      };
      knob.addEventListener(
        "wheel",
        (e) => {
          e.preventDefault();
          if (e.deltaY !== 0) step(e.deltaY < 0 ? 1 : -1);
        },
        { passive: false },
      );
      let lastY: number | null = null;
      let acc = 0;
      knob.addEventListener("pointerdown", (e) => {
        knob.setPointerCapture(e.pointerId);
        lastY = e.clientY;
        acc = 0;
      });
      knob.addEventListener("pointermove", (e) => {
        if (lastY === null) return;
        acc += lastY - e.clientY;
        lastY = e.clientY;
        while (Math.abs(acc) >= PX_PER_DETENT) {
          const d = acc > 0 ? 1 : -1;
          acc -= d * PX_PER_DETENT;
          step(d);
        }
      });
      const end = (): void => {
        lastY = null;
      };
      knob.addEventListener("pointerup", end);
      knob.addEventListener("pointercancel", end);
      wrap.append(knob, el("label", "", ENCODER_LABEL[id]));
      root.append(wrap);
    }
  }
}
