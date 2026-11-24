// Process wiring for `fm1-console start` and `simulate`: adapter, voice, device transport, UIs.
import { startUiServer, DEFAULT_UI_PORT, type UiServer } from "@fm1/companion-ui";
import { LoopbackPair, type MidiPorts } from "@fm1/device-protocol";
import { DEFAULT_PORT as SIM_UI_PORT, SimDevice, openVirtualMidi, startSimServer, type SimServer } from "@fm1/device-simulator";
import { createAdapter, type AdapterKind } from "./adapters";
import { Companion } from "./companion";
import { cannedReloader, configPath, loadConfig, saveConfig, type CompanionConfig } from "./config";
import { DiagLog } from "./diag-log";
import { BleMidiLink } from "./device/ble-midi";
import { bluetoothDeviceName, keepBleNotify, type BleNotifyKeeper } from "./device/ble-notify";
import { PortWatcher } from "./device/port-watcher";
import { coreMidiDriver, EMU_PORT_NAME, REAL_PORT_NAME, resolveDevicePort, SIM_PORT_NAME } from "./device/ports";
import { companionBackend } from "./ui-bridge/backend";
import { FixtureCapture, MicCaptureSource, loadFixtureAudio, type CaptureFactory } from "./voice/capture";
import { RecordingStore } from "./voice/recordings";
import { ReadAloud, realSpeechDeps } from "./speech/read-aloud";
import { SpeechTranscriber } from "./voice/transcriber";

export type DeviceMode = "real" | "sim" | "emu" | "loopback" | "simulate";

export interface RuntimeOptions {
  mode: DeviceMode;
  adapter: AdapterKind;
  mockFixture?: string;
  /** Use a WAV file instead of the microphone (demos, no mic permission needed). */
  captureFixture?: string;
  uiPort?: number;
  simUiPort?: number;
  /** Load the ASR model at start instead of on the first REC. */
  warm?: boolean;
  /** Exact MIDI port name for mode "real". CoreMIDI can keep a cached name after a reflash ("AMB-1 FM-1"). */
  devicePort?: string;
  /** Mode "real" over BT direct: our CoreBluetooth helper talks to the device with this advertised name
   * ("FM1 CONSOLE 19E2"). No CoreMIDI port is opened and fm1-ble-notify does not run. */
  bleDevice?: string;
}

export interface Runtime {
  companion: Companion;
  ui: UiServer;
  sim: SimServer | null;
  describe: string[];
  stop(): Promise<void>;
}

const echo = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

async function captureFactory(cfg: CompanionConfig, fixture: string | undefined): Promise<CaptureFactory> {
  if (!fixture) return () => new MicCaptureSource(cfg.micDeviceUid ?? undefined);
  const audio = await loadFixtureAudio(fixture);
  return () => new FixtureCapture(audio, undefined, fixture.split("/").pop());
}

export async function startRuntime(opts: RuntimeOptions): Promise<Runtime> {
  const cfgPath = configPath();
  const config = await loadConfig(cfgPath);
  const log = new DiagLog(500, Date.now, (e) => echo(`${new Date(e.at).toISOString()} ${e.level} ${e.source}: ${e.text}`));
  const defaultModel = config.defaults.model ? { provider: config.defaults.provider, model: config.defaults.model } : undefined;
  const adapter = await createAdapter(opts.adapter, {
    mockFixture: opts.mockFixture,
    focusDeepLink: config.focusDeepLink,
    focusApp: config.focusApp,
    defaultModel,
    a2aSelfSend: config.a2aSelfSend,
    a2aSender: config.a2aSender,
    tuiRoute: config.tuiRoute,
  });
  const speechDeps = await realSpeechDeps();
  const transcriber = new SpeechTranscriber({ engine: config.asrEngine, language: config.language, vocabularyFile: config.vocabularyFile });
  const companion = new Companion({
    adapter,
    capture: await captureFactory(config, opts.captureFixture),
    transcriber,
    config,
    log,
    saveConfig: (cfg) => saveConfig(cfg, cfgPath),
    reloadCanned: cannedReloader(cfgPath),
    readAloud: (toast, config) => new ReadAloud({ config, toast, log: (level, text) => log[level]("voice", text), deps: speechDeps }),
  });
  await companion.start();
  const recordings = new RecordingStore(config.voice.keepRecordings, { log: (level, text) => log[level]("voice", text) });
  companion.voice.setRecordings(recordings);
  void recordings.start();

  const describe: string[] = [`backend: ${adapter.id}`, `capture: ${opts.captureFixture ? `fixture ${opts.captureFixture}` : "microphone (fm1-mic, opened only while REC is held)"}`];
  let sim: SimServer | null = null;
  let simDevice: SimDevice | null = null;
  let watcher: PortWatcher | null = null;
  let bleNotify: BleNotifyKeeper | null = null;
  let bleLink: BleMidiLink | null = null;
  const watch = (name: string, resolve?: (ports: MidiPorts, name: string) => string): void => {
    watcher = new PortWatcher(name, coreMidiDriver, companion.device, { log: (t) => log.info("device", t), ...(resolve ? { resolve } : {}) });
    void watcher.start();
    describe.push(`device: MIDI port "${name}" (exact match, polled with backoff)`);
  };

  switch (opts.mode) {
    case "real":
      if (opts.bleDevice) {
        // BT direct: one GATT client (ours) carries the MIDI; the macOS Bluetooth MIDI port is never opened.
        bleLink = new BleMidiLink(opts.bleDevice, companion.device, { log: (level, text) => log[level]("device", text) });
        describe.push(
          bleLink.start()
            ? `device: bluetooth direct "${opts.bleDevice}" (fm1-ble-midi, no CoreMIDI port)`
            : `device: bluetooth direct "${opts.bleDevice}" unavailable: fm1-ble-midi missing (bash apps/companion/scripts/build-native.sh)`,
        );
      } else {
        const port = opts.devicePort ? resolveDevicePort(await coreMidiDriver.list(), opts.devicePort) : REAL_PORT_NAME;
        // Re-resolved on every poll: a Bluetooth device connected after start appears as "<name> Bluetooth".
        watch(opts.devicePort ?? port, opts.devicePort ? resolveDevicePort : undefined);
        // A Bluetooth port, or a --port that is not there yet (a Bluetooth device not connected so far).
        const bt = bluetoothDeviceName(port) ?? (opts.devicePort && port === opts.devicePort && !(await coreMidiDriver.list()).inputs.includes(port) ? opts.devicePort : null);
        if (bt) {
          bleNotify = keepBleNotify(bt, (level, text) => log[level]("device", text));
          if (bleNotify) describe.push(`bluetooth: fm1-ble-notify keeps "${bt}" notifications on`);
        }
      }
      break;
    case "sim":
      watch(SIM_PORT_NAME);
      break;
    case "emu":
      watch(EMU_PORT_NAME);
      break;
    case "loopback": {
      const pair = new LoopbackPair();
      simDevice = new SimDevice({ transport: pair.device });
      sim = await startSimServer({ device: simDevice, port: opts.simUiPort ?? SIM_UI_PORT });
      simDevice.start();
      companion.device.attach(pair.host, "in-process simulator (loopback)");
      describe.push(`device: in-process simulator, UI ${sim.url}`);
      break;
    }
    case "simulate": {
      simDevice = new SimDevice({ transport: await openVirtualMidi(SIM_PORT_NAME) });
      sim = await startSimServer({ device: simDevice, port: opts.simUiPort ?? SIM_UI_PORT });
      simDevice.start();
      describe.push(`simulator: virtual MIDI "${SIM_PORT_NAME}", UI ${sim.url}`);
      watch(SIM_PORT_NAME);
      break;
    }
  }

  const ui = await startUiServer({
    backend: companionBackend(companion, { simulatorUrl: sim?.url ?? null, configPath: cfgPath }),
    port: opts.uiPort ?? DEFAULT_UI_PORT,
  });
  describe.push(`companion UI: ${ui.url}`);
  if (opts.warm) {
    void transcriber.warm().then(
      (ms) => log.info("voice", `ASR model ready (${ms} ms)`),
      (e: unknown) => log.warn("voice", `ASR warm-up failed: ${e instanceof Error ? e.message : String(e)}`),
    );
  }

  return {
    companion,
    ui,
    sim,
    describe,
    async stop() {
      ui.stop();
      (watcher as PortWatcher | null)?.stop();
      (bleNotify as BleNotifyKeeper | null)?.stop();
      (bleLink as BleMidiLink | null)?.stop();
      sim?.stop();
      recordings.stop();
      await companion.stop();
      simDevice?.stop();
      await transcriber.dispose();
    },
  };
}
