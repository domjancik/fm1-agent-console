import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where the local Traycer host listens, as published in `~/.traycer/host/pid.json`.
 *
 * The port changes on every host start, so callers re-read this on every
 * reconnect instead of caching it.
 */
export interface HostEndpoint {
  readonly pid: number;
  readonly hostId: string;
  readonly version: string;
  /** The unary endpoint, `ws://127.0.0.1:<port>/rpc`. */
  readonly websocketUrl: string;
  /** The stream endpoint, the same URL with `/stream` in place of `/rpc`. */
  readonly streamUrl: string;
  readonly startedAt: string | null;
}

export class HostEndpointError extends Error {
  constructor(
    readonly code: "PID_FILE_MISSING" | "PID_FILE_INVALID" | "HOST_NOT_RUNNING" | "INVALID_URL",
    message: string,
  ) {
    super(message);
    this.name = "HostEndpointError";
  }
}

export function defaultPidFilePath(): string {
  return join(homedir(), ".traycer", "host", "pid.json");
}

/**
 * Same rule as the CLI's `isValidLocalHostWebsocketUrl`: `ws`/`wss`, loopback
 * `127.0.0.1`, path `/rpc`, no query string. Anything else is refused so a
 * tampered pid file cannot point the bearer at a foreign server.
 */
export function isValidLocalHostWebsocketUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    (url.protocol === "ws:" || url.protocol === "wss:") &&
    url.hostname === "127.0.0.1" &&
    url.pathname === "/rpc" &&
    url.search === "" &&
    url.hash === "" &&
    url.username === "" &&
    url.password === ""
  );
}

export function toStreamUrl(websocketUrl: string): string {
  const url = new URL(websocketUrl);
  url.pathname = "/stream";
  return url.toString();
}

export type ProcessAliveCheck = (pid: number) => boolean;

export const defaultProcessAliveCheck: ProcessAliveCheck = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

export function parsePidMetadata(raw: string, isAlive: ProcessAliveCheck): HostEndpoint {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HostEndpointError("PID_FILE_INVALID", "pid.json is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new HostEndpointError("PID_FILE_INVALID", "pid.json is not an object");
  }
  const record = parsed as Record<string, unknown>;
  const { pid, hostId, version, websocketUrl, startedAt } = record;
  if (
    typeof pid !== "number" ||
    typeof hostId !== "string" ||
    typeof version !== "string" ||
    typeof websocketUrl !== "string"
  ) {
    throw new HostEndpointError(
      "PID_FILE_INVALID",
      "pid.json lacks pid/hostId/version/websocketUrl",
    );
  }
  if (!isValidLocalHostWebsocketUrl(websocketUrl)) {
    throw new HostEndpointError(
      "INVALID_URL",
      `pid.json websocketUrl is not a loopback /rpc URL: ${websocketUrl}`,
    );
  }
  if (!isAlive(pid)) {
    throw new HostEndpointError("HOST_NOT_RUNNING", `host pid ${pid} is not running`);
  }
  return {
    pid,
    hostId,
    version,
    websocketUrl,
    streamUrl: toStreamUrl(websocketUrl),
    startedAt: typeof startedAt === "string" ? startedAt : null,
  };
}

export async function discoverHostEndpoint(
  options: { readonly pidFilePath?: string; readonly isAlive?: ProcessAliveCheck } = {},
): Promise<HostEndpoint> {
  const path = options.pidFilePath ?? defaultPidFilePath();
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new HostEndpointError("PID_FILE_MISSING", `no host pid file at ${path}`);
  }
  return parsePidMetadata(raw, options.isAlive ?? defaultProcessAliveCheck);
}
