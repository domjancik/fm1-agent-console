import type { Server, ServerWebSocket } from "bun";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Fake of the local Traycer host, enough for adapter contract tests.
 *
 * `/rpc`: answers `open` with an `openAck` echoing the client's manifest (so
 * every method negotiates), then answers each `request` through `handle`.
 *
 * `/stream`: answers `open` with an `openAck`, records the `subscribe` frame
 * and hands the test a {@link FakeStreamSub} to push method frames into. Client
 * frames after the subscribe (chat `send`, `approvalDecision`, pings) go to
 * `onClientFrame`; pings are answered with `pong` automatically.
 *
 * Every frame is recorded for asserts. `restart()` stops the server and binds a
 * new port, like a host respawn; `writePidFile()` publishes the current port.
 */
export interface FakeHostOptions {
  /** Return a fatal code to refuse the `/rpc` `open` frame (e.g. "UNAUTHORIZED"). */
  readonly onOpen?: (frame: OpenFrame) => string | null;
  /** Return a fatal code to refuse the `/stream` `open` frame. */
  readonly onStreamOpen?: (frame: OpenFrame) => string | null;
  readonly handle?: (method: string, params: unknown) => RpcOutcome;
  readonly onSubscribe?: (sub: FakeStreamSub) => void;
  readonly onClientFrame?: (sub: FakeStreamSub, frame: Record<string, unknown>) => void;
  /** Rewrites the `/stream` openAck manifest (e.g. an older host offering a lower `chat.subscribe` minor). */
  readonly streamManifest?: (manifest: Record<string, unknown>) => Record<string, unknown>;
}

export interface RpcOutcome {
  readonly result?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface OpenFrame {
  readonly kind: "open";
  readonly token: string;
  readonly manifest: Record<string, unknown>;
  readonly optionalManifest?: Record<string, unknown>;
  readonly clientIdentity?: { kind?: string; compatibilityEpoch?: number; appVersion?: string };
}

export interface FakeStreamSub {
  readonly method: string;
  readonly params: unknown;
  readonly schemaVersion: { major: number; minor: number };
  readonly clientFrames: Array<Record<string, unknown>>;
  /** Sends a method frame; `hasBinaryPayload:false` is added. */
  send(frame: Record<string, unknown>): void;
  /** Sends a raw text frame as-is (for malformed-frame tests). */
  sendRaw(text: string): void;
  fatal(code: string, extra?: Record<string, unknown>): void;
  close(): void;
  readonly closed: boolean;
}

interface SocketData {
  readonly path: string;
  sub: FakeStreamSubImpl | null;
}

class FakeStreamSubImpl implements FakeStreamSub {
  readonly clientFrames: Array<Record<string, unknown>> = [];
  closed = false;
  constructor(
    private readonly ws: ServerWebSocket<SocketData>,
    readonly method: string,
    readonly params: unknown,
    readonly schemaVersion: { major: number; minor: number },
  ) {}
  send(frame: Record<string, unknown>): void {
    this.sendRaw(JSON.stringify({ hasBinaryPayload: false, ...frame }));
  }
  sendRaw(text: string): void {
    if (!this.closed) this.ws.send(text);
  }
  fatal(code: string, extra: Record<string, unknown> = {}): void {
    this.sendRaw(
      JSON.stringify({
        kind: "fatalError",
        details: { code, reason: code, incompatibleMethods: null, upgradeGuidance: null, ...extra },
      }),
    );
    this.close();
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws.close(1000, "fake-close");
    } catch {
      // already closed
    }
  }
}

export interface FakeHost {
  readonly url: string;
  readonly port: number;
  readonly hostId: string;
  readonly opens: OpenFrame[];
  readonly streamOpens: OpenFrame[];
  readonly requests: Array<{ method: string; params: unknown; idempotencyKey?: unknown }>;
  readonly subs: FakeStreamSub[];
  /** Live (not closed) subscriptions to `method`. */
  live(method: string): FakeStreamSub[];
  /** Resolves with the next live subscription to `method` (or an existing one). */
  waitForSub(method: string, timeoutMs?: number): Promise<FakeStreamSub>;
  /** Stops the server; sockets drop. */
  stop(): void;
  /** Stops and rebinds on a new port (host respawn). */
  restart(): void;
  writePidFile(path?: string): string;
}

export const FAKE_HOST_ID = "0b4f2a6e-9b1d-4c1e-8f53-2f1d7b2a9c01";

export function startFakeHost(options: FakeHostOptions = {}): FakeHost {
  const opens: OpenFrame[] = [];
  const streamOpens: OpenFrame[] = [];
  const requests: Array<{ method: string; params: unknown; idempotencyKey?: unknown }> = [];
  const subs: FakeStreamSubImpl[] = [];
  const waiters: Array<{ method: string; resolve: (s: FakeStreamSub) => void }> = [];
  let pidPath: string | null = null;

  const refuse = (ws: ServerWebSocket<SocketData>, code: string): void => {
    ws.send(
      JSON.stringify({ kind: "fatalError", details: { code, reason: code, incompatibleMethods: null, upgradeGuidance: null } }),
    );
    ws.close(1008, code);
  };

  const onRpc = (ws: ServerWebSocket<SocketData>, frame: Record<string, unknown>): void => {
    if (frame.kind === "open") {
      const open = frame as unknown as OpenFrame;
      opens.push(open);
      const fatal = options.onOpen?.(open) ?? null;
      if (fatal !== null) return refuse(ws, fatal);
      ws.send(
        JSON.stringify({
          kind: "openAck",
          manifest: open.manifest,
          optionalManifest: open.optionalManifest ?? {},
          capabilities: ["unary.idempotencyKey"],
        }),
      );
      return;
    }
    if (frame.kind === "request") {
      const method = frame.method as string;
      requests.push({ method, params: frame.params, idempotencyKey: frame.idempotencyKey });
      const outcome = options.handle?.(method, frame.params) ?? { result: {} };
      ws.send(
        JSON.stringify({
          kind: "response",
          requestId: frame.requestId,
          method,
          schemaVersion: frame.schemaVersion,
          result: outcome.error ? null : (outcome.result ?? null),
          error: outcome.error ?? null,
        }),
      );
    }
  };

  const onStream = (ws: ServerWebSocket<SocketData>, frame: Record<string, unknown>): void => {
    if (frame.kind === "open") {
      const open = frame as unknown as OpenFrame;
      streamOpens.push(open);
      const fatal = options.onStreamOpen?.(open) ?? null;
      if (fatal !== null) return refuse(ws, fatal);
      const manifest = options.streamManifest ? options.streamManifest(open.manifest) : open.manifest;
      ws.send(JSON.stringify({ kind: "openAck", manifest, capabilities: [], hostCredentialState: null }));
      return;
    }
    if (frame.kind === "subscribe") {
      const sub = new FakeStreamSubImpl(
        ws,
        frame.method as string,
        frame.params,
        frame.schemaVersion as { major: number; minor: number },
      );
      ws.data.sub = sub;
      subs.push(sub);
      options.onSubscribe?.(sub);
      for (const waiter of [...waiters]) {
        if (waiter.method === sub.method && !sub.closed) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(sub);
        }
      }
      return;
    }
    const sub = ws.data.sub;
    if (sub === null) return;
    sub.clientFrames.push(frame);
    if (frame.kind === "ping") {
      sub.send({ kind: "pong" });
      return;
    }
    options.onClientFrame?.(sub, frame);
  };

  const serve = (port: number): Server<SocketData> =>
    Bun.serve<SocketData, never>({
      port,
      hostname: "127.0.0.1",
      fetch(request: Request, srv) {
        const path = new URL(request.url).pathname;
        if (srv.upgrade(request, { data: { path, sub: null } })) return undefined;
        return new Response("not found", { status: 404 });
      },
      websocket: {
        message(ws: ServerWebSocket<SocketData>, data: string | Buffer) {
          let frame: Record<string, unknown>;
          try {
            frame = JSON.parse(String(data)) as Record<string, unknown>;
          } catch {
            return;
          }
          if (ws.data.path === "/stream") onStream(ws, frame);
          else onRpc(ws, frame);
        },
        close(ws: ServerWebSocket<SocketData>) {
          if (ws.data.sub !== null) ws.data.sub.closed = true;
        },
      },
    });

  let server = serve(0);

  const host: FakeHost = {
    get url() {
      return `ws://127.0.0.1:${server.port}/rpc`;
    },
    get port() {
      return server.port ?? 0;
    },
    hostId: FAKE_HOST_ID,
    opens,
    streamOpens,
    requests,
    subs,
    live: (method) => subs.filter((s) => s.method === method && !s.closed),
    waitForSub: (method, timeoutMs = 3000) => {
      const existing = subs.find((s) => s.method === method && !s.closed);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no ${method} subscription within ${timeoutMs}ms`)), timeoutMs);
        waiters.push({
          method,
          resolve: (s) => {
            clearTimeout(timer);
            resolve(s);
          },
        });
      });
    },
    stop: () => {
      for (const s of subs) s.closed = true;
      server.stop(true);
    },
    restart: () => {
      const oldPort = server.port;
      host.stop();
      let next = serve(0);
      // A respawned host gets a fresh port; make sure it differs.
      if (next.port === oldPort) {
        const again = serve(0);
        next.stop(true);
        next = again;
      }
      server = next;
      if (pidPath !== null) host.writePidFile(pidPath);
    },
    writePidFile: (path) => {
      pidPath = path ?? pidPath ?? join(mkdtempSync(join(tmpdir(), "fm1-fake-host-")), "pid.json");
      writeFileSync(
        pidPath,
        JSON.stringify({
          pid: process.pid,
          hostId: FAKE_HOST_ID,
          version: "1.5.4",
          websocketUrl: host.url,
          startedAt: new Date(0).toISOString(),
        }),
      );
      return pidPath;
    },
  };
  return host;
}
