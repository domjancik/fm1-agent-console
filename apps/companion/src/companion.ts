// The companion process core: AgentConsole (agent-core) + DeviceHost (FM1C link) + voice pipeline.
// Device frames and UI buttons go through the same path, so the UI only mirrors the device.
import {
  AgentConsole,
  backendName,
  offlineText,
  type AgentAdapter,
  type ButtonName,
  type CannedEntry,
  type DeviceInput,
  type DeliveryStage,
  type DeviceView,
  type PinLists,
  type ReadAloudPort,
  type Timers,
} from "@fm1/agent-core";
import { NO_REQ_SEQ, type Clock, type LinkTiming } from "@fm1/device-protocol";
import { DEFAULT_CONFIG, DEFAULT_READ_ALOUD, type CompanionConfig, type ReadAloudConfig } from "./config";
import { describeInput } from "./device/inputs";
import { DeviceHost } from "./device/device-host";
import { stageCode } from "./device/render";
import { DiagLog } from "./diag-log";
import { feedbackFor } from "./feedback";
import { SelectionWatcher } from "./session-watch";
import { StageRelay } from "./stage-relay";
import type { CaptureFactory } from "./voice/capture";
import type { Transcriber } from "./voice/transcriber";
import { VoiceController } from "./voice/voice-controller";

export interface CompanionOptions {
  adapter: AgentAdapter;
  capture: CaptureFactory;
  transcriber: Transcriber;
  config?: CompanionConfig;
  /** Device link clock (FakeClock in tests). */
  clock?: Clock;
  /** Composer timers (ack timeout). */
  timers?: Timers;
  now?: () => number;
  log?: DiagLog;
  deviceTiming?: Partial<LinkTiming>;
  maxFramesPerSecond?: number;
  hostSession?: number;
  newRequestId?: () => string;
  ackTimeoutMs?: number;
  /** Persists a changed config (pins); omitted in tests, where changes stay in memory. */
  saveConfig?: (cfg: CompanionConfig) => Promise<void>;
  /** Housekeeping period for auto re-sort and arrivals (default 5 s; 0 disables, e.g. in tests). */
  tickMs?: number;
  /**
   * Re-reads the canned responses from the config file when it changed since the last call (else null). Called before
   * every device input, so a `fm1-console canned ...` edit made while the companion runs is picked up before the next
   * press can change (and save) the list (docs/ui-v3.md section 12). Omitted in tests: the list stays in memory.
   */
  reloadCanned?: () => Promise<CannedEntry[] | null>;
  /**
   * Read aloud (hold PLAY; docs/ui-v3.md section 14): builds the speech pipeline. `toast` shows a device toast tied to
   * the last device input; `config` is the current `readAloud` config. Omitted in tests: hold PLAY reads nothing.
   */
  readAloud?: (toast: (text: string, stage: DeliveryStage) => void, config: () => ReadAloudConfig) => ReadAloudPort;
}

export class Companion {
  readonly console: AgentConsole;
  readonly device: DeviceHost;
  readonly voice: VoiceController;
  readonly log: DiagLog;
  readonly relay: StageRelay;
  readonly adapter: AgentAdapter;
  readonly watcher: SelectionWatcher;
  config: CompanionConfig;
  /** Every COMMAND_RESULT the companion decided on (also sent when a device is connected). */
  readonly feedback: { reqSeq: number; stage: string; text: string }[] = [];
  private listeners = new Set<() => void>();
  private offs: (() => void)[] = [];
  private inputQueue: Promise<unknown> = Promise.resolve();
  private ticker: ReturnType<typeof setInterval> | null = null;
  private readonly tickMs: number;
  private readonly now: () => number;
  private readonly persist?: (cfg: CompanionConfig) => Promise<void>;
  private readonly reloadCanned?: () => Promise<CannedEntry[] | null>;
  /** SEQ of the device frame handled last: read aloud's later toasts are reported against it. */
  private lastReqSeq = NO_REQ_SEQ;

  constructor(opts: CompanionOptions) {
    const now = opts.now ?? Date.now;
    this.now = now;
    this.tickMs = opts.tickMs ?? 5000;
    this.persist = opts.saveConfig;
    this.reloadCanned = opts.reloadCanned;
    this.adapter = opts.adapter;
    this.config = opts.config ?? DEFAULT_CONFIG;
    this.log = opts.log ?? new DiagLog(500, now);
    const readAloud = opts.readAloud?.(
      (text, stage) => {
        this.log.info("voice", `read aloud: ${text}`);
        this.report(this.lastReqSeq, stageCode(stage), text);
      },
      () => this.config.readAloud ?? DEFAULT_READ_ALOUD,
    );
    this.console = new AgentConsole({
      adapter: opts.adapter,
      now,
      timers: opts.timers,
      ackTimeoutMs: opts.ackTimeoutMs,
      newRequestId: opts.newRequestId,
      pins: { sessions: this.config.sessionPins, tasks: this.config.taskPins },
      onPinsChanged: (pins) => this.savePins(pins),
      layouts: this.config.layouts,
      onLayoutsChanged: (layouts) => this.saveLayouts(layouts),
      settings: this.config.settings,
      onSettingsChanged: (settings) => this.saveSettings(settings),
      split: this.config.split,
      onSplitChanged: (split) => this.saveSplit(split),
      canned: this.config.canned,
      onCannedChanged: (canned) => this.saveCanned(canned),
      ...(readAloud ? { readAloud } : {}),
    });
    // The PLAY hold resolves on a timer, outside any input: its notice (`Nothing to read`) is a toast all the same.
    this.console.onTimerStep = (st) => {
      const n = st.state.notice;
      if (n) this.report(this.lastReqSeq, stageCode(n.stage), n.text);
      if (st.actions.length > 0) this.log.info("device", `PLAY hold -> ${st.actions.map((a) => a.type).join(", ")}`);
      this.notify();
    };
    this.device = new DeviceHost((input, seq) => this.serial(() => this.handleInput(input, seq)), {
      clock: opts.clock,
      timing: opts.deviceTiming,
      maxFramesPerSecond: opts.maxFramesPerSecond,
      hostSession: opts.hostSession,
      log: (level, text) => this.log.add(level, "device", text),
    });
    this.voice = new VoiceController(this.console, opts.capture, opts.transcriber, this.log);
    this.watcher = new SelectionWatcher(opts.adapter, this.console.registry);
    this.relay = new StageRelay((reqSeq, stage, text) => this.report(reqSeq, stageCode(stage), text), now, backendName(this.adapter));
  }

  async start(): Promise<void> {
    this.offs.push(
      this.console.onView((v) => this.onView(v)),
      this.console.composer.onChange((s) => this.relay.observe(s)),
      this.device.onStatus((s) => {
        // The DETAILS page needs protocol version 3 (docs/ux-v2.md section 7), the UI v3 bubble layout version 4
        // (docs/ui-v3.md section 5); a lost link keeps the last answer.
        if (s.phase === "connected" && s.proto !== null) this.console.setProtocol(s.proto);
        this.notify();
      }),
      this.log.onEntry(() => this.notify()),
      this.adapter.subscribe((e) => {
        if (e.type === "connection") this.log.add(e.state === "connected" ? "info" : "warn", "backend", `backend ${e.state}${e.reason ? `: ${e.reason}` : ""}`);
      }),
    );
    await this.console.start();
    const conn = this.console.registry.connection();
    if (conn === "disconnected") this.log.warn("backend", `backend ${this.adapter.id} unavailable (${offlineText(backendName(this.adapter))})`);
    else this.log.info("backend", `backend ${this.adapter.id} ${conn}, ${this.console.registry.sessions().length} sessions`);
    this.onView(this.console.view());
    if (this.tickMs > 0) this.ticker = setInterval(() => void this.serial(async () => void this.console.tick(this.now())), this.tickMs);
  }

  /** Pins live in the companion config; a write failure is logged and the in-memory pins stay. */
  private savePins(pins: PinLists): void {
    this.config = { ...this.config, sessionPins: [...pins.sessions], taskPins: [...pins.tasks] };
    this.log.info("device", `pins: ${pins.sessions.length} sessions, ${pins.tasks.length} tasks`);
    this.persist?.(this.config).catch((e: unknown) => this.log.warn("app", `saving pins failed: ${e instanceof Error ? e.message : String(e)}`));
    this.notify();
  }

  /** Buddy / List / Grouped per view (SEQ, protocol version 5) lives in the companion config, like the pins. */
  private saveLayouts(layouts: { sessions: "buddy" | "list" | "grouped"; inbox: "buddy" | "list" | "grouped" }): void {
    this.config = { ...this.config, layouts: { sessions: layouts.sessions, inbox: layouts.inbox === "grouped" ? "list" : layouts.inbox } };
    this.log.info("device", `layouts: sessions ${layouts.sessions}, to do ${layouts.inbox}`);
    this.persist?.(this.config).catch((e: unknown) => this.log.warn("app", `saving layouts failed: ${e instanceof Error ? e.message : String(e)}`));
    this.notify();
  }

  /** SETTINGS values (Keys Ranked/Split, protocol 6) live in the companion config, like the layouts. */
  private saveSettings(settings: { keys: "ranked" | "split" }): void {
    this.config = { ...this.config, settings: { keys: settings.keys } };
    this.log.info("device", `settings: keys ${settings.keys}`);
    this.persist?.(this.config).catch((e: unknown) => this.log.warn("app", `saving settings failed: ${e instanceof Error ? e.message : String(e)}`));
    this.notify();
  }

  /** The SPLIT choice and task page (the console coalesces these to at most one a second). */
  private saveSplit(split: { chosen: "all" | "pinned" | "needs" | "task"; task: string | null; taskPage: number }): void {
    this.config = { ...this.config, split: { chosen: split.chosen, task: split.chosen === "task" ? split.task : null, taskPage: split.taskPage } };
    this.persist?.(this.config).catch((e: unknown) => this.log.warn("app", `saving the split choice failed: ${e instanceof Error ? e.message : String(e)}`));
    this.notify();
  }

  /** Canned responses (docs/ui-v3.md section 12) live in the companion config; saved on every change. */
  private saveCanned(canned: CannedEntry[]): void {
    this.config = { ...this.config, canned: canned.map((e) => ({ ...e })) };
    this.log.info("device", `canned: ${canned.length} entries`);
    this.persist?.(this.config).catch((e: unknown) => this.log.warn("app", `saving canned responses failed: ${e instanceof Error ? e.message : String(e)}`));
    this.notify();
  }

  /** Picks up a canned list edited on disk (the CLI) before an input may change it; a read failure keeps the list. */
  private async syncCanned(): Promise<void> {
    if (!this.reloadCanned) return;
    let list: CannedEntry[] | null = null;
    try {
      list = await this.reloadCanned();
    } catch (e) {
      this.log.warn("app", `re-reading canned responses failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (list === null) return;
    this.config = { ...this.config, canned: list.map((e) => ({ ...e })) };
    this.console.setCanned(list);
  }

  async stop(): Promise<void> {
    if (this.ticker !== null) clearInterval(this.ticker);
    this.ticker = null;
    for (const off of this.offs.splice(0)) off();
    this.voice.cancel();
    this.watcher.stop();
    this.device.detach();
    await this.console.stop();
    await this.voice.idle();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** One device input (or a mirrored UI press). Serialized by DeviceHost / uiQueue. */
  async handleInput(input: DeviceInput, reqSeq: number): Promise<void> {
    this.lastReqSeq = reqSeq;
    await this.syncCanned();
    const before = { state: this.console.state, voice: this.console.composer.state.state };
    const resultsBefore = this.console.results.length;
    const actions = await this.console.handleInput(input);
    for (const a of actions) {
      if (a.type === "voiceStart") this.voice.begin();
      else if (a.type === "voiceStop") this.voice.finish();
      // A short REC tap (docs/ui-v3.md section 11) drops the take untranscribed, like FX: a suggestion or nothing.
      else if (a.type === "voiceCancel" || a.type === "voiceSuggest" || a.type === "voiceDiscard") this.voice.cancel();
    }
    const after = { state: this.console.state, voice: this.console.composer.state.state };
    const results = this.console.results.slice(resultsBefore);
    for (const f of feedbackFor(actions, results, before, after, backendName(this.adapter))) this.report(reqSeq, stageCode(f.stage), f.text);
    if (actions.some((a) => a.type === "voiceSubmit")) {
      const id = this.console.composer.state.requestId;
      if (id) this.relay.bind(id, reqSeq);
    }
    if (actions.length > 0) this.log.info("device", `${describeInput(input)} -> ${actions.map((a) => a.type).join(", ")}`);
    this.notify();
  }

  /** UI mirror of a device button press (down then up), e.g. SAVE / FX. */
  pressButton(button: ButtonName): Promise<void> {
    return this.serial(async () => {
      await this.handleInput({ kind: "button", button, edge: "down" }, NO_REQ_SEQ);
      await this.handleInput({ kind: "button", button, edge: "up" }, NO_REQ_SEQ);
    });
  }

  /** Device frames and UI presses share one queue, so they are handled strictly one at a time. */
  private serial(fn: () => Promise<void>): Promise<void> {
    const p = this.inputQueue.then(fn, fn);
    this.inputQueue = p.catch(() => undefined);
    return p;
  }

  editTranscript(text: string): { ok: boolean; error?: string } {
    const r = this.console.editTranscript(text);
    this.notify();
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }

  setConfig(cfg: CompanionConfig): void {
    this.config = cfg;
    this.console.setLayouts(cfg.layouts);
    this.console.setSettings(cfg.settings);
    this.console.setCanned(cfg.canned);
    this.notify();
  }

  /** Settles device inputs, voice work and in-flight dispatches (tests, shutdown). */
  async idle(): Promise<void> {
    await this.device.idle();
    await this.inputQueue;
    await this.voice.idle();
    await this.console.idle();
  }

  private report(reqSeq: number, result: Parameters<DeviceHost["sendResult"]>[1], text: string): void {
    this.feedback.push({ reqSeq, stage: result, text });
    this.device.sendResult(reqSeq, result, text);
  }

  private onView(v: DeviceView): void {
    this.watcher.sync();
    this.device.render(v);
    this.notify();
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }
}
