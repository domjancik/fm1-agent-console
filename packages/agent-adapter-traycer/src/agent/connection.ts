import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { WsStreamClient } from "@traycer-clients/shared/host-transport/ws-stream-client";
import type { FirstPartyClientIdentity } from "@traycer/protocol/framework/client-identity";
import type { CredentialSource } from "../credentials";
import { discoverHostEndpoint, type HostEndpoint } from "../endpoint";
import { probeHandshake, type HandshakeResult } from "../handshake";
import { FALLBACK_CLIENT_KIND, FM1_CLIENT_KIND, makeClientIdentity } from "../identity";
import { TraycerRpc, type HostMethod, type HostRequest, type HostResponse, type RpcCaller } from "../rpc";
import { createStreamClient } from "../streams";
import { Backoff } from "./backoff";
import type { ResolvedConfig } from "./config";

export type HostLinkState = "idle" | "connecting" | "connected" | "reconnecting" | "closed";

export interface HostLinkListener {
  onConnected(endpoint: HostEndpoint, info: { readonly first: boolean; readonly urlChanged: boolean }): void;
  onDisconnected(reason: string): void;
  /** The host refused the open frame with INCOMPATIBLE: every host capability is lost until a later handshake succeeds. */
  onIncompatible(reason: string): void;
}

export class HostIncompatibleError extends Error {
  constructor(reason: string) {
    super(`host INCOMPATIBLE: ${reason}`);
    this.name = "HostIncompatibleError";
  }
}

type Probe = (url: string, token: string, identity: FirstPartyClientIdentity) => Promise<HandshakeResult>;

export interface HostLinkDeps {
  readonly discover?: () => Promise<HostEndpoint>;
  readonly probe?: Probe;
}

/**
 * Owns the connection to the local host:
 *  - every (re)connect attempt re-reads `~/.traycer/host/pid.json`, because the
 *    host binds a new port on each start;
 *  - each attempt proves the endpoint with an `open`/`openAck` probe (refreshing
 *    the bearer through `traycer whoami` once on UNAUTHORIZED);
 *  - failed attempts back off exponentially; INCOMPATIBLE is surfaced, not thrown
 *    into the event loop, and retried at the same backoff (the host may update);
 *  - one shared `WsStreamClient` reads the current endpoint before every dial,
 *    and is told to redial at once when the endpoint changed.
 */
export class HostLink {
  private state: HostLinkState = "idle";
  private current: HostEndpoint | null = null;
  private streamClient: WsStreamClient<HostStreamRpcRegistry> | null = null;
  private identity: FirstPartyClientIdentity | null = null;
  private readonly backoff: Backoff;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attemptInFlight: Promise<void> | null = null;
  private verifyInFlight: Promise<void> | null = null;
  private everConnected = false;
  readonly rpc: RpcCaller;
  lastError: string | null = null;

  constructor(
    private readonly config: ResolvedConfig,
    private readonly credentials: CredentialSource,
    private readonly listener: HostLinkListener,
    private readonly deps: HostLinkDeps = {},
  ) {
    this.backoff = new Backoff(config.backoff);
    this.rpc = new LinkRpc(this, credentials);
  }

  /** Identity chosen by the last successful handshake (fm1-console unless the host refused it). */
  get clientIdentity(): FirstPartyClientIdentity {
    return this.identity ?? makeClientIdentity(FM1_CLIENT_KIND);
  }

  get status(): HostLinkState {
    return this.state;
  }

  get endpoint(): HostEndpoint | null {
    return this.current;
  }

  get clientKind(): string | null {
    return (this.identity as { kind?: string } | null)?.kind ?? null;
  }

  requireEndpoint(): HostEndpoint {
    if (this.current === null) throw new Error("Traycer host not connected");
    return this.current;
  }

  /** The shared stream client; created after the first successful handshake. */
  async streams(): Promise<WsStreamClient<HostStreamRpcRegistry>> {
    if (this.streamClient === null) {
      const endpoint = this.requireEndpoint();
      this.streamClient = createStreamClient({
        endpoint,
        endpointSource: () => this.current ?? endpoint,
        lease: await this.credentials.getLease(),
        clientIdentity: this.clientIdentity,
        initialBackoffMs: this.config.streamBackoff.initialMs,
        maxBackoffMs: this.config.streamBackoff.maxMs,
      });
    }
    return this.streamClient;
  }

  /** One attempt now. On failure a background retry loop starts and the error is rethrown. */
  async connect(): Promise<void> {
    if (this.state === "closed") this.state = "idle";
    if (this.state === "connected") return;
    this.state = this.everConnected ? "reconnecting" : "connecting";
    try {
      await this.attempt();
    } catch (error) {
      this.scheduleRetry();
      throw error;
    }
  }

  /** A stream or RPC saw the host go away. Starts the reconnect loop if we were connected. */
  notifyDrop(reason: string): void {
    if (this.state !== "connected") return;
    this.state = "reconnecting";
    this.lastError = reason;
    this.listener.onDisconnected(reason);
    this.scheduleRetry();
  }

  /**
   * Liveness check after a stream drop or failed RPC: has pid.json moved, did
   * the host die, does it still answer an `open`? A single stream reconnecting
   * (e.g. after a corrupt frame) does not by itself mean the host is gone.
   */
  async verify(): Promise<void> {
    if (this.state !== "connected" || this.current === null) return;
    this.verifyInFlight ??= this.runVerify().finally(() => {
      this.verifyInFlight = null;
    });
    return this.verifyInFlight;
  }

  private async runVerify(): Promise<void> {
    const before = this.current;
    if (before === null) return;
    try {
      const fresh = await this.discover();
      if (fresh.websocketUrl !== before.websocketUrl || fresh.pid !== before.pid) {
        this.notifyDrop(`host endpoint changed (${fresh.websocketUrl})`);
        return;
      }
      await this.handshake(fresh);
    } catch (error) {
      this.notifyDrop(error instanceof Error ? error.message : String(error));
    }
  }

  close(): void {
    this.state = "closed";
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.streamClient?.close("fm1-adapter-disconnect");
    this.streamClient = null;
    this.current = null;
  }

  private scheduleRetry(): void {
    if (this.state === "closed" || this.timer !== null) return;
    const delay = this.backoff.next();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.state === "closed" || this.state === "connected") return;
      this.attempt().catch(() => this.scheduleRetry());
    }, delay);
  }

  private attempt(): Promise<void> {
    this.attemptInFlight ??= this.runAttempt().finally(() => {
      this.attemptInFlight = null;
    });
    return this.attemptInFlight;
  }

  private async runAttempt(): Promise<void> {
    let endpoint: HostEndpoint;
    try {
      endpoint = await this.discover();
      this.identity = await this.handshake(endpoint);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      if (error instanceof HostIncompatibleError) this.listener.onIncompatible(this.lastError);
      throw error;
    }
    if (this.state === "closed") return;
    const urlChanged = this.current !== null && this.current.websocketUrl !== endpoint.websocketUrl;
    const first = !this.everConnected;
    this.current = endpoint;
    this.state = "connected";
    this.everConnected = true;
    this.lastError = null;
    this.backoff.reset();
    if (!first) {
      // Drop sockets still dialing the old port; redial the current endpoint now.
      this.streamClient?.reconnectAll(urlChanged ? "host-endpoint-changed" : "host-reconnected", {
        probeFirst: !urlChanged,
        wakeProbe: null,
      });
    }
    this.listener.onConnected(endpoint, { first, urlChanged });
  }

  private discover(): Promise<HostEndpoint> {
    if (this.deps.discover) return this.deps.discover();
    return discoverHostEndpoint({
      ...(this.config.pidFilePath === undefined ? {} : { pidFilePath: this.config.pidFilePath }),
      ...(this.config.isAlive === undefined ? {} : { isAlive: this.config.isAlive }),
    });
  }

  /** `fm1-console` first; `cli` if the host refuses for a non-auth, non-compat reason. */
  private async handshake(endpoint: HostEndpoint): Promise<FirstPartyClientIdentity> {
    const probe: Probe =
      this.deps.probe ?? ((url, token, clientIdentity) => probeHandshake({ websocketUrl: url, token, clientIdentity }));
    const kinds = [FM1_CLIENT_KIND, FALLBACK_CLIENT_KIND];
    let lastCode = "unknown";
    for (const kind of kinds) {
      const identity = makeClientIdentity(kind);
      let result = await probe(endpoint.websocketUrl, (await this.credentials.getLease()).getBearerToken(), identity);
      if (result.kind === "fatal" && result.details.code === "UNAUTHORIZED") {
        await this.credentials.refresh();
        result = await probe(endpoint.websocketUrl, (await this.credentials.getLease()).getBearerToken(), identity);
      }
      if (result.kind === "ack") return identity;
      if (result.kind === "transport") throw new Error(`host unreachable at ${endpoint.websocketUrl}: ${result.message}`);
      lastCode = result.details.code;
      if (lastCode === "INCOMPATIBLE") throw new HostIncompatibleError(result.details.reason);
      if (lastCode === "UNAUTHORIZED") break;
    }
    throw new Error(`host refused the open frame: ${lastCode}`);
  }
}

/** Unary RPC that always dials the link's current endpoint with the negotiated identity. */
class LinkRpc implements RpcCaller {
  private client: TraycerRpc | null = null;
  private kind: string | null = null;

  constructor(
    private readonly link: HostLink,
    private readonly credentials: CredentialSource,
  ) {}

  call<M extends HostMethod>(
    method: M,
    params: HostRequest<M>,
    options?: { readonly idempotencyKey?: string | null; readonly timeoutMs?: number },
  ): Promise<HostResponse<M>> {
    const identity = this.link.clientIdentity;
    const kind = (identity as { kind?: string }).kind ?? null;
    if (this.client === null || kind !== this.kind) {
      this.kind = kind;
      this.client = new TraycerRpc({
        endpoint: async () => this.link.requireEndpoint(),
        credentials: this.credentials,
        clientIdentity: identity,
      });
    }
    return this.client.call(method, params, options);
  }
}
