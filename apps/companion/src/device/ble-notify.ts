// Runs native/fm1-ble-notify while the device is on a Bluetooth MIDI port. macOS's BLE-MIDI driver never
// turns the FM-1's notifications on, so without a subscriber the CoreMIDI port receives nothing.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BT_SUFFIX = " Bluetooth";
const RESTART_MS = 2000;

export const BLE_NOTIFY_BUILD_HINT = "build it with: bash apps/companion/scripts/build-native.sh";

/** The Bluetooth device name behind a CoreMIDI port name, or null for a non-Bluetooth port. */
export function bluetoothDeviceName(port: string): string | null {
  return port.endsWith(BT_SUFFIX) && port.length > BT_SUFFIX.length ? port.slice(0, -BT_SUFFIX.length) : null;
}

export function bleNotifyPath(): string {
  return process.env.FM1_BLE_NOTIFY_BIN ?? fileURLToPath(new URL("../../bin/fm1-ble-notify", import.meta.url));
}

export interface BleNotifyKeeper {
  stop(): void;
}

/** Keeps the helper running for `device`; restarts it if it exits. Lines it prints go to `log`. */
export function keepBleNotify(device: string, log: (level: "info" | "warn", text: string) => void, bin = bleNotifyPath()): BleNotifyKeeper | null {
  if (!existsSync(bin)) {
    log("warn", `fm1-ble-notify missing (${bin}): the Bluetooth port will stay silent; ${BLE_NOTIFY_BUILD_HINT}`);
    return null;
  }
  let stopped = false;
  let child: ReturnType<typeof Bun.spawn> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = (): void => {
    if (stopped) return;
    const proc = Bun.spawn([bin, device], { stdout: "pipe", stderr: "inherit" });
    child = proc;
    void (async () => {
      const reader = proc.stdout.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line) log(line.startsWith("error") ? "warn" : "info", `ble notify: ${line}`);
        }
      }
    })();
    void proc.exited.then((code) => {
      child = null;
      if (stopped) return;
      if (code === 2 || code === 3) return log("warn", `fm1-ble-notify exited ${code}; not restarting`);
      timer = setTimeout(run, RESTART_MS);
    });
  };
  run();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      child?.kill();
    },
  };
}
