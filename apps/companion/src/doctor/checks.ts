// `fm1-console doctor`: read-only environment checks (spec section 10). Nothing here opens a device
// port, records audio, sends a prompt or writes a file.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir, release } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CAPABILITY_NAMES, type AgentAdapter } from "@fm1/agent-core";
import { HOST_VERSIONS, listMidiPorts } from "@fm1/device-protocol";
import { locateParakeetModel, micPermission } from "@fm1/speech";
import { createAdapter, type AdapterKind } from "../adapters";
import { configPath, loadConfig } from "../config";
import { classifyPorts, REAL_PORT_NAME, SIM_PORT_NAME } from "../device/ports";
import { traycerEnv, run } from "../proc";

export type CheckStatus = "ok" | "warn" | "fail" | "info";

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

export const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/** FM-1 USB identity (pid.codes test VID), docs/discovery/connected-device.md. */
export const FM1_USB = { vendorId: 0x1209, productId: 0x0001 } as const;

export async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const check = (name: string, status: CheckStatus, detail: string): Check => ({ name, status, detail });

async function guard(name: string, fn: () => Promise<Check | Check[]>): Promise<Check[]> {
  try {
    const r = await fn();
    return Array.isArray(r) ? r : [r];
  } catch (e) {
    return [check(name, "fail", e instanceof Error ? e.message : String(e))];
  }
}

export function osCheck(): Check {
  return check("os", process.platform === "darwin" ? "ok" : "warn", `${process.platform} ${release()} ${process.arch}, bun ${Bun.version}`);
}

export async function traycerCliCheck(): Promise<Check> {
  const r = await run(["traycer", "--version"], { env: traycerEnv(), timeoutMs: 8000 });
  if (r.code !== 0) return check("traycer cli", "fail", r.error ?? `exit ${r.code}: ${r.stderr.trim().slice(0, 200)}`);
  return check("traycer cli", "ok", r.stdout.trim().split("\n")[0] ?? "");
}

export function traycerHostCheck(pidFile = join(homedir(), ".traycer", "host", "pid.json")): Check {
  if (!existsSync(pidFile)) return check("traycer host", "fail", `${pidFile} missing (host not running?)`);
  const meta = JSON.parse(readFileSync(pidFile, "utf8")) as { pid?: unknown; version?: unknown; websocketUrl?: unknown };
  const pid = typeof meta.pid === "number" ? meta.pid : NaN;
  let alive = false;
  try {
    process.kill(pid, 0); // signal 0: existence check only
    alive = true;
  } catch (e) {
    alive = (e as NodeJS.ErrnoException).code === "EPERM";
  }
  const url = typeof meta.websocketUrl === "string" ? meta.websocketUrl : "";
  const loopback = /^wss?:\/\/127\.0\.0\.1:\d+\/rpc$/.test(url);
  const detail = `pid ${pid} ${alive ? "alive" : "not running"}, version ${String(meta.version)}, ${loopback ? url : "non-loopback URL refused"}`;
  return check("traycer host", alive && loopback ? "ok" : "fail", detail);
}

export function capabilityChecks(adapter: AgentAdapter): Check[] {
  const caps = adapter.getCapabilities();
  return CAPABILITY_NAMES.map((n) => {
    const c = caps[n];
    return check(`capability ${n}`, c.supported ? "ok" : "warn", c.supported ? `supported (verified: ${c.verified})` : `unsupported: ${c.reason ?? "no reason given"}`);
  });
}

export async function adapterChecks(kind: AdapterKind, connectTimeoutMs = 8000): Promise<Check[]> {
  let adapter: AgentAdapter;
  try {
    adapter = await createAdapter(kind);
  } catch (e) {
    return [check(`adapter ${kind}`, "fail", e instanceof Error ? e.message : String(e))];
  }
  const out: Check[] = [];
  // connect() is a read-only handshake (endpoint discovery, auth, manifest negotiation).
  try {
    await withTimeout(adapter.connect(), connectTimeoutMs, "connect");
    out.push(check(`adapter ${kind}`, "ok", `${adapter.id} connected`));
  } catch (e) {
    out.push(check(`adapter ${kind}`, "fail", `${adapter.id}: ${e instanceof Error ? e.message : String(e)}`));
  }
  out.push(...capabilityChecks(adapter));
  await adapter.disconnect().catch(() => undefined);
  return out;
}

export async function midiChecks(): Promise<Check[]> {
  const ports = await listMidiPorts(); // enumeration only; no port is opened
  const cls = classifyPorts(ports);
  const list = (xs: string[]): string => (xs.length ? xs.map((x) => `"${x}"`).join(", ") : "none");
  const out = [
    check("midi inputs", "info", list(ports.inputs)),
    check("midi outputs", "info", list(ports.outputs)),
    check("console port", cls.real ? "ok" : "warn", cls.real ? `"${REAL_PORT_NAME}" present (console firmware)` : `"${REAL_PORT_NAME}" not present (console firmware not running)`),
    check("simulator port", "info", cls.sim ? `"${SIM_PORT_NAME}" present` : `"${SIM_PORT_NAME}" not present`),
    check(
      "protocol",
      "info",
      cls.real
        ? `host speaks FM1C v${HOST_VERSIONS.min}-${HOST_VERSIONS.max}; the device's range is checked by HELLO when \`fm1-console start\` binds the port (doctor never opens device ports)`
        : `host speaks FM1C v${HOST_VERSIONS.min}-${HOST_VERSIONS.max}; no console firmware port to check against`,
    ),
  ];
  if (cls.other.length) out.push(check("other FM1 ports", "warn", `${list(cls.other)} (never opened: not an exact match)`));
  return out;
}

/** Parses `ioreg -p IOUSB -l -w0` into devices with vendor/product ids and names. */
export function parseIoreg(text: string): { name: string; vendorId: number; productId: number }[] {
  const out: { name: string; vendorId: number; productId: number }[] = [];
  for (const block of text.split(/\n(?=[ |]*\+-o )/)) {
    const vid = /"idVendor" = (\d+)/.exec(block);
    const pid = /"idProduct" = (\d+)/.exec(block);
    if (!vid || !pid) continue;
    const name = /"USB Product Name" = "([^"]*)"/.exec(block)?.[1] ?? /\+-o ([^@<]+)/.exec(block)?.[1]?.trim() ?? "?";
    out.push({ name, vendorId: Number(vid[1]), productId: Number(pid[1]) });
  }
  return out;
}

export async function usbCheck(): Promise<Check> {
  if (process.platform !== "darwin") return check("fm-1 usb", "info", "USB scan implemented for macOS only");
  const r = await run(["ioreg", "-p", "IOUSB", "-l", "-w0"], { timeoutMs: 8000 });
  if (r.code !== 0) return check("fm-1 usb", "fail", r.error ?? `ioreg exit ${r.code}`);
  const hits = parseIoreg(r.stdout).filter((d) => d.vendorId === FM1_USB.vendorId && d.productId === FM1_USB.productId);
  if (hits.length === 0) return check("fm-1 usb", "warn", "no USB device 1209:0001 found");
  return check("fm-1 usb", "ok", hits.map((h) => `"${h.name}" (1209:0001)`).join(", "));
}

export async function micCheck(): Promise<Check> {
  const p = await micPermission(); // `fm1-mic status`: never prompts, never opens the microphone
  return check("microphone", p.authorized ? "ok" : "warn", `permission ${p.status}`);
}

export function asrChecks(engine: string): Check[] {
  const out: Check[] = [check("asr engine", "info", `configured: ${engine}`)];
  try {
    const m = locateParakeetModel();
    out.push(check("parakeet model", engine === "sherpa" ? "ok" : "info", m.dir));
  } catch (e) {
    out.push(check("parakeet model", engine === "sherpa" ? "fail" : "info", e instanceof Error ? e.message : String(e)));
  }
  const speechDir = dirname(fileURLToPath(import.meta.resolve("@fm1/speech")));
  const dictate = process.env.FM1_DICTATE_BIN ?? join(speechDir, "..", "bin", "fm1-dictate");
  out.push(check("apple dictation helper", existsSync(dictate) ? (engine === "apple" ? "ok" : "info") : engine === "apple" ? "fail" : "info", existsSync(dictate) ? dictate : `${dictate} missing`));
  return out;
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Firmware candidate in firmware/dist and whether its SHA-256 matches reports/firmware-validation.md. */
export function firmwareCheck(root = REPO_ROOT): Check {
  const dist = join(root, "firmware", "dist");
  const pkgs = existsSync(dist) ? readdirSync(dist).filter((f) => f.endsWith(".fwsc")) : [];
  if (pkgs.length === 0) return check("firmware candidate", "warn", `no .fwsc in ${dist}`);
  const report = join(root, "reports", "firmware-validation.md");
  const documented = existsSync(report) ? [...readFileSync(report, "utf8").matchAll(/\b[0-9a-f]{64}\b/g)].map((m) => m[0]) : [];
  const details = pkgs.map((f) => {
    const sha = sha256File(join(dist, f));
    return { f, sha, known: documented.includes(sha) };
  });
  const allKnown = details.every((d) => d.known);
  return check(
    "firmware candidate",
    allKnown ? "ok" : "warn",
    details.map((d) => `${d.f} sha256 ${d.sha} (${d.known ? "matches firmware-validation.md" : "NOT in firmware-validation.md"})`).join("; "),
  );
}

export interface DoctorOptions {
  adapter: AdapterKind;
}

export async function runDoctor(opts: DoctorOptions): Promise<Check[]> {
  const cfgPath = configPath();
  const cfg = await loadConfig(cfgPath).catch((e: unknown) => {
    throw new Error(`config ${cfgPath}: ${e instanceof Error ? e.message : String(e)}`);
  });
  const groups = await Promise.all([
    guard("os", async () => osCheck()),
    guard("config", async () => check("config", "info", `${cfgPath}${existsSync(cfgPath) ? "" : " (defaults; file absent)"}: engine ${cfg.asrEngine}, language ${cfg.language}`)),
    guard("traycer cli", traycerCliCheck),
    guard("traycer host", async () => traycerHostCheck()),
    guard(`adapter ${opts.adapter}`, () => adapterChecks(opts.adapter)),
    guard("midi", midiChecks),
    guard("fm-1 usb", usbCheck),
    guard("microphone", micCheck),
    guard("asr", async () => asrChecks(cfg.asrEngine)),
    guard("firmware candidate", async () => firmwareCheck()),
  ]);
  return groups.flat();
}

export function formatChecks(checks: readonly Check[]): string {
  const tag: Record<CheckStatus, string> = { ok: " ok ", warn: "warn", fail: "FAIL", info: "info" };
  const width = Math.max(...checks.map((c) => c.name.length));
  return checks.map((c) => `[${tag[c.status]}] ${c.name.padEnd(width)}  ${c.detail}`).join("\n");
}
