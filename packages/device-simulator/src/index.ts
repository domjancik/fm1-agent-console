export { SimDevice, incompatibleTitle, POT_HYSTERESIS, SIM_FIRMWARE, SIM_VERSIONS, SIM_VERSIONS_V6, SIM_VERSIONS_V7, type SimDeviceEvents, type SimDeviceOptions } from "./device";
export { GestureTracker, GESTURE_TIMING } from "./gestures";
export {
  applyHostMessage,
  emptySlot,
  initialState,
  KEY_COUNT,
  KNOB_ROW_MS,
  selectedKey,
  type LocalUi,
  type DeviceState,
  type HostPhase,
  type LastResult,
  type LinkView,
  type Slot,
} from "./state";
export {
  changedRegions,
  FONT,
  keyCell,
  layoutScreen,
  REGION_RECT,
  RESULT_SHOW_MS,
  SCREEN,
  type DrawOp,
  type Region,
  type RegionId,
  type ScreenModel,
} from "./layout";
export { BREATH_NS, BUTTON_IDS, BUTTON_TIMELINES, breathNs, buttonLeds, KEY_TIMELINES, keyLed, keyLedV2, keyLeds, ledProto, levelAt, LIT_NS, type LedLevel, type Timeline } from "./leds";
export { EMPTY_OUTLINE, STATE_COLOR, toRgb565 } from "./colors";
export { logEntry, summarize, TappedTransport } from "./frame-log";
export { ScriptedDriver, fakeSleeper, realSleeper, WaitTimeoutError, type PressKind, type Sleeper } from "./scripted";
export { loopback, openVirtualMidi, VIRTUAL_PORT_NAME } from "./transports";
export { DEFAULT_PORT, startSimServer, buildUi, type SimServer, type SimServerOptions } from "./server";
export { demoFrames, startDemoHost } from "./demo-host";
export { parseClientMessage, type ClientMessage, type LogEntry, type ServerMessage } from "./wire";
export { animFrame, expand565, Framebuffer, FONT_L, FONT_S, rgb565, SPRITES, spritePalette, textWidth, type Pose, type Species } from "./v4/raster";
export { animatedBoxes, blackRow, chipBox, drawHero, drawKey, drawMini, groupedWindow, HELP4, keyBox4, listWindow, NOTE, renderV4, SPLIT, usesGrouped, usesSplit, usesV4, V4 } from "./v4/screen";
export {
  detectTransition,
  STEP_PX_MAX,
  T3,
  T4,
  TRANSITION_MS,
  TRANSITION_PX_MAX,
  TransitionScreen,
  VSCROLL,
  vscrollStarts,
  type Step as TransitionStep,
  type Transition,
  type TransitionKind,
} from "./v4/transitions";
