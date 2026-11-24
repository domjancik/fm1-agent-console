// Local companion UI: Bun.serve on 127.0.0.1 only, one WebSocket for state pushes and commands.
import type { Server, ServerWebSocket } from "bun";
import { parseCommand, type ServerPush, type UiBackend } from "./contract";
import { isTrustedRequest } from "./trust";

export const DEFAULT_UI_PORT = 4718;
const TOPIC = "ui";
const PUSH_COALESCE_MS = 50;

export interface UiServerOptions {
  backend: UiBackend;
  port?: number;
  hostname?: string;
}

export interface UiServer {
  url: string;
  port: number;
  stop(): void;
}

/** Bundles the browser app (plain TS + DOM) into one script. */
export async function buildUiScript(): Promise<string> {
  const result = await Bun.build({ entrypoints: [new URL("./ui/app.ts", import.meta.url).pathname], target: "browser" });
  const out = result.outputs[0];
  if (!result.success || !out) throw new Error(`UI build failed: ${result.logs.map((l) => String(l)).join("\n")}`);
  return out.text();
}

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
  "cache-control": "no-store",
};

export async function startUiServer(opts: UiServerOptions): Promise<UiServer> {
  const { backend } = opts;
  const [script, html] = await Promise.all([buildUiScript(), Bun.file(new URL("./ui/index.html", import.meta.url).pathname).text()]);
  const statePush = (): string => JSON.stringify({ t: "state", state: backend.snapshot() } satisfies ServerPush);

  const server: Server<undefined> = Bun.serve<undefined>({
    port: opts.port ?? DEFAULT_UI_PORT,
    hostname: opts.hostname ?? "127.0.0.1",
    fetch(req, srv) {
      if (!isTrustedRequest(req)) return new Response("forbidden", { status: 403 });
      const { pathname } = new URL(req.url);
      if (pathname === "/ws") return srv.upgrade(req, { data: undefined }) ? undefined : new Response("upgrade failed", { status: 400 });
      if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
      if (pathname === "/") return new Response(html, { headers: { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8" } });
      if (pathname === "/app.js") return new Response(script, { headers: { ...SECURITY_HEADERS, "content-type": "text/javascript; charset=utf-8" } });
      if (pathname === "/api/state") return new Response(statePush(), { headers: { ...SECURITY_HEADERS, "content-type": "application/json" } });
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws: ServerWebSocket<undefined>) {
        ws.subscribe(TOPIC);
        ws.send(statePush());
      },
      async message(ws, raw) {
        const parsed = parseCommand(typeof raw === "string" ? raw : raw.toString());
        if (!parsed) return;
        const reply = await backend.command(parsed.cmd);
        ws.send(JSON.stringify({ t: "reply", id: parsed.id, reply } satisfies ServerPush));
      },
    },
  });

  let timer: ReturnType<typeof setTimeout> | null = null;
  const off = backend.onChange(() => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      server.publish(TOPIC, statePush());
    }, PUSH_COALESCE_MS);
  });

  return {
    url: `http://${server.hostname}:${server.port}/`,
    port: server.port ?? opts.port ?? DEFAULT_UI_PORT,
    stop() {
      off();
      if (timer) clearTimeout(timer);
      server.stop(true);
    },
  };
}
