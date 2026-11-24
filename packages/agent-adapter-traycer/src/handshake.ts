import {
  SERVES_EVERY_INSTALLED_MAJOR,
  splitConnectionManifest,
} from "@traycer/protocol/framework/capability-manifest";
import {
  toClientHandshakeIdentity,
  type FirstPartyClientIdentity,
} from "@traycer/protocol/framework/client-identity";
import {
  hostFrameSchema,
  type FatalErrorDetails,
} from "@traycer/protocol/framework/ws-protocol";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";

/**
 * A bare `open` / `openAck` exchange on `/rpc`, without a request.
 *
 * `WsRpcClient` does the same handshake internally but does not expose the
 * host's ack, so this probe exists for discovery: it reports the host manifest
 * size and connection capabilities, and tells whether the host admits a given
 * client identity. The manifest is built from the vendored registry exactly as
 * `WsRpcClient.buildManifest` does.
 */
export type HandshakeResult =
  | {
      readonly kind: "ack";
      readonly manifestMethods: number;
      readonly optionalManifestMethods: number;
      readonly capabilities: readonly string[];
      readonly clientManifestMethods: number;
      /** Host manifest entries for `HandshakeOptions.pick` (required or optional manifest), when asked. */
      readonly picked?: Record<string, { readonly required: unknown; readonly optional: unknown }>;
    }
  | { readonly kind: "fatal"; readonly details: FatalErrorDetails }
  | { readonly kind: "transport"; readonly message: string };

export interface HandshakeOptions {
  readonly websocketUrl: string;
  readonly token: string;
  readonly clientIdentity: FirstPartyClientIdentity;
  readonly timeoutMs?: number;
  readonly createSocket?: (url: string) => WebSocket;
  /** Method names whose host manifest entries (versions served) are returned in `picked`. */
  readonly pick?: readonly string[];
}

export function buildClientManifest() {
  return splitConnectionManifest(
    hostRpcRegistry,
    RELEASED_FLOOR_METHOD_NAMES,
    SERVES_EVERY_INSTALLED_MAJOR,
  );
}

export function probeHandshake(options: HandshakeOptions): Promise<HandshakeResult> {
  const { manifest, optionalManifest } = buildClientManifest();
  const clientManifestMethods =
    Object.keys(manifest).length + Object.keys(optionalManifest).length;
  const createSocket = options.createSocket ?? ((url: string) => new WebSocket(url));
  return new Promise((resolve) => {
    let settled = false;
    const socket = createSocket(options.websocketUrl);
    const finish = (result: HandshakeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close(1000, "probe-complete");
      } catch {
        // already closed
      }
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ kind: "transport", message: "handshake timed out" }),
      options.timeoutMs ?? 10_000,
    );
    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          kind: "open",
          token: options.token,
          manifest,
          optionalManifest,
          clientIdentity: toClientHandshakeIdentity(options.clientIdentity),
        }),
      );
    });
    socket.addEventListener("message", (event) => {
      let raw: unknown;
      try {
        raw = JSON.parse(String(event.data));
      } catch {
        finish({ kind: "transport", message: "non-JSON frame from host" });
        return;
      }
      const parsed = hostFrameSchema.safeParse(raw);
      if (!parsed.success) {
        finish({ kind: "transport", message: "unrecognized frame from host" });
        return;
      }
      const frame = parsed.data;
      if (frame.kind === "openAck") {
        const required = frame.manifest as Record<string, unknown>;
        const optional = (frame.optionalManifest ?? {}) as Record<string, unknown>;
        const picked =
          options.pick === undefined
            ? undefined
            : Object.fromEntries(options.pick.map((m) => [m, { required: required[m] ?? null, optional: optional[m] ?? null }]));
        finish({
          ...(picked === undefined ? {} : { picked }),
          kind: "ack",
          manifestMethods: Object.keys(frame.manifest).length,
          optionalManifestMethods: Object.keys(frame.optionalManifest ?? {}).length,
          capabilities: frame.capabilities ?? [],
          clientManifestMethods,
        });
      } else if (frame.kind === "fatalError") {
        finish({ kind: "fatal", details: frame.details });
      }
    });
    socket.addEventListener("error", () =>
      finish({ kind: "transport", message: "websocket error" }),
    );
    socket.addEventListener("close", (event) =>
      finish({ kind: "transport", message: `socket closed ${event.code}` }),
    );
  });
}
