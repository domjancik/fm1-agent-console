// Stand-in for the fm1-mic Swift helper in tests. Mode comes from FAKE_MIC_MODE.
//   ok | silent | denied | nodevice | crash | noise   (record)
// "status" and "devices" print canned JSON.
import { appendFileSync } from "node:fs";

const mode = process.env.FAKE_MIC_MODE ?? "ok";
const [command, ...args] = Bun.argv.slice(2);
const emit = (event: Record<string, unknown>): void => {
  process.stderr.write(`${JSON.stringify(event)}\n`);
};
const argValue = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

if (command === "status") {
  console.log(JSON.stringify({ status: mode === "denied" ? "denied" : "authorized", authorized: mode !== "denied" }));
  process.exit(0);
}
if (command === "devices") {
  console.log(JSON.stringify([{ id: 1, uid: "BuiltInMicrophoneDevice", name: "Fake Mic", inputChannels: 1, sampleRate: 48000, transport: "builtin", default: true }]));
  process.exit(0);
}
if (command !== "record") process.exit(1);

if (mode === "denied") {
  emit({ type: "error", code: "permission_denied", message: "denied in System Settings" });
  process.exit(3);
}
if (mode === "nodevice") {
  emit({ type: "error", code: "no_device", message: "no default input device" });
  process.exit(4);
}
if (process.env.FAKE_MIC_ARGS_OUT) await Bun.write(process.env.FAKE_MIC_ARGS_OUT, JSON.stringify(args));

const rate = Number(argValue("--rate") ?? 16000);
const device = argValue("--device") ?? "BuiltInMicrophoneDevice";
// FM1_MIC_RAW_OUT (like the real helper): raw stereo 48 kHz, left = the tone, right = silent.
// FAKE_MIC_OLD_HELPER=1 ignores it, as a helper built before the raw output existed does.
const rawOut = process.env.FAKE_MIC_OLD_HELPER === "1" ? undefined : process.env.FM1_MIC_RAW_OUT;
const RAW_RATE = 48000;
if (rawOut) {
  const { closeSync, openSync } = await import("node:fs");
  closeSync(openSync(rawOut, "w", 0o600));
}
await Bun.sleep(Number(process.env.FAKE_MIC_START_DELAY_MS ?? 20));
emit({
  type: "started",
  sampleRate: rate,
  inputSampleRate: 48000,
  inputChannels: rawOut ? 2 : 1,
  ...(process.env.FAKE_MIC_OLD_HELPER === "1" ? {} : { rawOut: rawOut !== undefined }),
  device: { uid: device, name: "Fake Mic" },
});
if (process.env.FAKE_MIC_RAW_PATH_OUT && rawOut) await Bun.write(process.env.FAKE_MIC_RAW_PATH_OUT, rawOut);

let frames = 0;
let stopped = false;
const stop = (reason: string): void => {
  if (stopped) return;
  stopped = true;
  emit({ type: "stopped", reason, frames });
  process.exit(0);
};
process.on("SIGTERM", () => stop("sigterm"));
process.on("SIGINT", () => stop("sigint"));
void (async () => {
  const reader = Bun.stdin.stream().getReader();
  while (!(await reader.read()).done) {
    // drain until EOF
  }
  stop("stdin_eof");
})();

const chunk = rate / 20; // 50 ms
const amplitude = mode === "silent" ? 0 : 8000;
let ticks = 0;
const timer = setInterval(() => {
  const pcm = new Int16Array(chunk);
  for (let i = 0; i < chunk; i++) pcm[i] = Math.round(amplitude * Math.sin((2 * Math.PI * 440 * (frames + i)) / rate));
  if (rawOut) {
    const rawFrames = RAW_RATE / 20;
    const raw = new Int16Array(rawFrames * 2);
    const start = (frames * RAW_RATE) / rate;
    for (let i = 0; i < rawFrames; i++) raw[i * 2] = Math.round(amplitude * Math.sin((2 * Math.PI * 440 * (start + i)) / RAW_RATE));
    appendFileSync(rawOut, new Uint8Array(raw.buffer));
  }
  frames += chunk;
  process.stdout.write(new Uint8Array(pcm.buffer));
  emit({ type: "level", rms: amplitude / 32768 / Math.SQRT2, peak: amplitude / 32768 });
  ticks++;
  if (mode === "crash" && ticks === 3) process.exit(9);
  if (mode === "device_change" && ticks === 3) {
    clearInterval(timer);
    emit({ type: "device_changed" });
    stop("device_changed");
  }
}, 50);
