import type { ButtonId } from "@fm1/device-protocol";
import type { Server, ServerWebSocket } from "bun";
import type { SimDevice } from "./device";
import { parseClientMessage, type ClientMessage, type LogEntry, type ServerMessage } from "./wire";

/** Keys and buttons a browser tab holds down, released if the tab goes away mid-press. */
interface Held {
  keys: Set<number>;
  buttons: Set<ButtonId>;
}

export const DEFAULT_PORT = 4717;
const LOG_KEEP = 300;
const LOG_FLUSH_MS = 50;
const TOPIC = "sim";

export interface SimServerOptions {
  device: SimDevice;
  port?: number;
  hostname?: string;
}

export interface SimServer {
  url: string;
  stop(): void;
}

/** Bundles the browser UI (plain TS + DOM) into one script. */
export async function buildUi(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [new URL("./ui/app.ts", import.meta.url).pathname],
    target: "browser",
    external: ["@julusian/midi"],
  });
  const out = result.outputs[0];
  if (!result.success || !out) {
    throw new Error(`UI build failed: ${result.logs.map((l) => String(l)).join("\n")}`);
  }
  return out.text();
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Only the simulator's own page may drive it. Browsers always send Origin on a WebSocket
 * upgrade, so a foreign Origin is another site (cross-site WebSocket hijacking) and a
 * non-loopback Host is DNS rebinding; either could press keys the companion acts on.
 */
export function isTrustedRequest(req: Request): boolean {
  const host = req.headers.get("host");
  if (!host) return false;
  let hostname: string;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    return false;
  }
  if (!LOOPBACK_HOSTS.has(hostname)) return false;
  const origin = req.headers.get("origin");
  if (origin === null) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function track(held: Held, msg: ClientMessage): void {
  if (msg.t === "key") {
    if (msg.down) held.keys.add(msg.key);
    else held.keys.delete(msg.key);
  } else if (msg.t === "button") {
    if (msg.down) held.buttons.add(msg.button);
    else held.buttons.delete(msg.button);
  }
}

function releaseAll(device: SimDevice, held: Held): void {
  for (const key of held.keys) device.keyUp(key);
  for (const button of held.buttons) device.button(button, false);
  held.keys.clear();
  held.buttons.clear();
}

export function applyClientMessage(device: SimDevice, msg: ClientMessage): void {
  switch (msg.t) {
    case "key":
      return msg.down ? device.keyDown(msg.key) : device.keyUp(msg.key);
    case "button":
      return device.button(msg.button, msg.down);
    case "encoder":
      return device.turn(msg.encoder, msg.delta);
    case "pot":
      return device.setMaster(msg.value);
  }
}

/** Serves the UI on localhost and bridges it to the SimDevice over a WebSocket. */
export async function startSimServer(options: SimServerOptions): Promise<SimServer> {
  const { device } = options;
  const [script, html] = await Promise.all([
    buildUi(),
    Bun.file(new URL("./ui/index.html", import.meta.url).pathname).text(),
  ]);
  const log: LogEntry[] = [];
  let unsent: LogEntry[] = [];
  const stateMsg = (): ServerMessage => ({ t: "state", state: device.state, deviceMs: device.nowMs });

  const server: Server<Held> = Bun.serve<Held>({
    port: options.port ?? DEFAULT_PORT,
    hostname: options.hostname ?? "127.0.0.1",
    fetch(req, srv) {
      if (!isTrustedRequest(req)) return new Response("forbidden", { status: 403 });
      const { pathname } = new URL(req.url);
      if (pathname === "/ws") {
        const data: Held = { keys: new Set(), buttons: new Set() };
        return srv.upgrade(req, { data }) ? undefined : new Response("upgrade failed", { status: 400 });
      }
      if (pathname === "/") return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
      if (pathname === "/app.js") {
        return new Response(script, { headers: { "content-type": "text/javascript; charset=utf-8" } });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws: ServerWebSocket<Held>) {
        ws.subscribe(TOPIC);
        ws.send(JSON.stringify(stateMsg()));
        ws.send(JSON.stringify({ t: "log", entries: log } satisfies ServerMessage));
      },
      message(ws, raw) {
        const msg = parseClientMessage(typeof raw === "string" ? raw : raw.toString());
        if (!msg) return;
        try {
          applyClientMessage(device, msg);
          track(ws.data, msg);
        } catch (err) {
          // A stopped device or a rejected value must not take the server down.
          process.stderr.write(`sim input rejected: ${err instanceof Error ? err.message : String(err)}\n`);
        }
      },
      close(ws) {
        try {
          releaseAll(device, ws.data);
        } catch {
          // Device already stopped: nothing is held any more.
        }
      },
    },
  });

  const publish = (m: ServerMessage): void => {
    server.publish(TOPIC, JSON.stringify(m));
  };
  const offState = device.on("state", () => publish(stateMsg()));
  const offFrame = device.on("frame", (e) => {
    log.push(e);
    if (log.length > LOG_KEEP) log.splice(0, log.length - LOG_KEEP);
    unsent.push(e);
  });
  const flush = setInterval(() => {
    if (unsent.length === 0) return;
    publish({ t: "log", entries: unsent });
    unsent = [];
  }, LOG_FLUSH_MS);

  return {
    url: `http://${server.hostname}:${server.port}/`,
    stop() {
      clearInterval(flush);
      offState();
      offFrame();
      server.stop(true);
    },
  };
}
