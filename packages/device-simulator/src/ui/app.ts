// Browser entry: renders the SimDevice state pushed over /ws and sends panel input back.
import { layoutScreen } from "../layout";
import { buttonLeds, keyLeds } from "../leds";
import { initialState, type DeviceState } from "../state";
import type { ClientMessage, ServerMessage } from "../wire";
import { Framebuffer } from "../v4/raster";
import { renderV4, usesV4 } from "../v4/screen";
import { TransitionScreen } from "../v4/transitions";
import { LcdRenderer } from "./canvas";
import { shortcutFor, type Shortcut } from "./keymap";
import { LogPanel } from "./log-panel";
import { Panel } from "./panel";

const $ = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
};

let state: DeviceState = initialState();
/** device time = performance.now() + offset, so LED phases follow the device clock. */
let offset = 0;
let socket: WebSocket | null = null;

const send = (msg: ClientMessage): void => {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
};

const lcd = new LcdRenderer($<HTMLCanvasElement>("lcd"));
const panel = new Panel(
  {
    keyboard: $("keyboard"),
    buttons: $("buttons"),
    encoders: $("encoders"),
    master: $<HTMLInputElement>("master"),
    masterVal: $("masterVal"),
  },
  send,
);
const log = new LogPanel($("log"), $<HTMLInputElement>("hideNoise"));
const wsLabel = $("ws");
const phaseLabel = $("phase");

function connect(): void {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  socket = ws;
  ws.onopen = () => (wsLabel.textContent = "connected");
  ws.onclose = () => {
    wsLabel.textContent = "disconnected, retrying";
    socket = null;
    setTimeout(connect, 1000);
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data)) as ServerMessage;
    if (msg.t === "state") {
      state = msg.state;
      offset = msg.deviceMs - performance.now();
      // Transitions (docs/ui-v3.md section 9.10) run on the device clock, like the firmware's.
      if (!screen) screen = new TransitionScreen(state, msg.deviceMs);
      else screen.apply(state, msg.deviceMs);
      phaseLabel.textContent = state.link.phase.replace("_", " ");
    } else {
      log.add(msg.entries);
    }
  };
}

const fb = new Framebuffer();
let screen: TransitionScreen | null = null;
/** A cheap per-frame signature: FNV-1a over the RGB565 words, so an unchanged frame is not re-blitted. */
function signature(px: Uint16Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < px.length; i++) h = Math.imul(h ^ (px[i] ?? 0), 0x01000193);
  return String(h >>> 0);
}

function frame(): void {
  const t = performance.now() + offset;
  if (usesV4(state)) {
    const shown = screen ? screen.frame(t) : renderV4(state, t, fb);
    lcd.renderPixels(shown.rgba(), signature(shown.px));
  } else lcd.render(layoutScreen(state, t));
  panel.update(keyLeds(state, t), buttonLeds(state, t), state.slots);
  panel.flushTurns();
  requestAnimationFrame(frame);
}

// Keyboard shortcuts: physical-style press/release, ignoring auto-repeat.
const held = new Map<string, Shortcut>();

function press(sc: Shortcut, down: boolean): void {
  screen?.input(performance.now() + offset); // input completes a running transition at once
  if (sc.kind === "key") {
    send({ t: "key", key: sc.key, down });
    panel.showPressed({ key: sc.key }, down);
  } else if (sc.kind === "button") {
    send({ t: "button", button: sc.button, down });
    panel.showPressed({ button: sc.button }, down);
  } else if (down) {
    panel.turn(sc.encoder, sc.delta);
  }
}

window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
  const sc = shortcutFor(e.key);
  if (!sc) return;
  e.preventDefault();
  if (sc.kind === "encoder") return press(sc, true);
  if (e.repeat || held.has(e.code)) return;
  held.set(e.code, sc);
  press(sc, true);
});

window.addEventListener("keyup", (e) => {
  const sc = held.get(e.code);
  if (!sc) return;
  held.delete(e.code);
  press(sc, false);
});

window.addEventListener("blur", () => {
  for (const sc of held.values()) press(sc, false);
  held.clear();
});

connect();
requestAnimationFrame(frame);
