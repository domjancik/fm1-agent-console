import type { FirstPartyClientIdentity } from "@traycer/protocol/framework/client-identity";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import type { AgentActivityByEpic } from "@traycer/protocol/host/agent/activity";
import type { ChatSubscribeClientFrame } from "@traycer/protocol/host/agent/gui/subscribe";
import { hostStreamRpcRegistry, type HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type {
  StreamCloseReason,
  StreamConnectionStatus,
} from "@traycer/protocol/host-transport/stream-session";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { AgentActivityStreamClient } from "@traycer-clients/shared/host-transport/agent-activity-stream-client";
import {
  ChatStreamClient,
  type ChatStreamCallbacks,
} from "@traycer-clients/shared/host-transport/chat-stream-client";
import {
  DEFAULT_DIAL_TIMEOUT_MS,
  DEFAULT_INITIAL_BACKOFF_MS,
  DEFAULT_MAX_BACKOFF_MS,
  DEFAULT_OPEN_ACK_TIMEOUT_MS,
  DEFAULT_PING_INTERVAL_MS,
  DEFAULT_PONG_TIMEOUT_MS,
} from "@traycer-clients/shared/host-transport/transport-config";
import { createWhatwgStreamWebSocketFactory } from "@traycer-clients/shared/host-transport/whatwg-stream-ws-factory";
import { WsStreamClient } from "@traycer-clients/shared/host-transport/ws-stream-client";
import type { MutableBearerLease } from "@traycer-clients/shared/auth/bearer-source";
import type { HostEndpoint } from "./endpoint";

export type { AgentActivityByEpic };
export type ChatClientFrame = ChatSubscribeClientFrame;

export interface StreamClientOptions {
  readonly endpoint: HostEndpoint;
  /**
   * Read before every dial. Lets a supervisor point live sessions at a
   * re-discovered endpoint (host respawned on a new port). Default: `endpoint`.
   */
  readonly endpointSource?: () => HostEndpoint;
  readonly lease: MutableBearerLease;
  readonly clientIdentity: FirstPartyClientIdentity;
  readonly initialBackoffMs?: number;
  readonly maxBackoffMs?: number;
}

/**
 * One `WsStreamClient` per adapter. Built-in stream auth recovery, host
 * credential minting and clock tracking are all off: FM-1 must not provision
 * host credentials or change host state as a side effect of watching it.
 */
export function createStreamClient(options: StreamClientOptions): WsStreamClient<HostStreamRpcRegistry> {
  const source = options.endpointSource ?? (() => options.endpoint);
  return new WsStreamClient<HostStreamRpcRegistry>({
    registry: hostStreamRpcRegistry,
    hostId: options.endpoint.hostId,
    endpoint: () => {
      const current = source();
      return { hostId: current.hostId, websocketUrl: current.websocketUrl };
    },
    bearer: () => options.lease,
    auth: null,
    clock: null,
    hostCredentialMint: null,
    onHostCredentialState: null,
    evidence: NO_TRANSPORT_EVIDENCE,
    webSocketFactory: createWhatwgStreamWebSocketFactory(),
    dialTimeoutMs: DEFAULT_DIAL_TIMEOUT_MS,
    openAckTimeoutMs: DEFAULT_OPEN_ACK_TIMEOUT_MS,
    pingIntervalMs: DEFAULT_PING_INTERVAL_MS,
    pongTimeoutMs: DEFAULT_PONG_TIMEOUT_MS,
    initialBackoffMs: options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS,
    maxBackoffMs: options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
    clientIdentity: options.clientIdentity,
  });
}

export interface ConnectionEvent {
  readonly status: StreamConnectionStatus;
  readonly reason: StreamCloseReason | null;
  readonly retryCause: FatalErrorDetails | null;
}

export interface ActivityWatcher {
  close(): void;
}

export function watchAgentActivity(
  client: WsStreamClient<HostStreamRpcRegistry>,
  onState: (byEpic: AgentActivityByEpic, servedBy: string) => void,
  onConnection: (event: ConnectionEvent) => void = () => undefined,
): ActivityWatcher {
  const activity = new AgentActivityStreamClient({
    wsStreamClient: client,
    plane: null,
    callbacks: {
      onState: (servedBy, byEpic) => onState(byEpic, servedBy),
      onConnectionStatus: (status, reason, retryCause) =>
        onConnection({ status, reason, retryCause }),
    },
  });
  return { close: () => activity.close() };
}

/** Every chat server frame, flattened into one discriminated stream. */
export interface ChatFrame {
  readonly kind: string;
  readonly [key: string]: unknown;
}

const FRAME_CALLBACKS = [
  "onSnapshot",
  "onActionAck",
  "onMessageAccepted",
  "onMessageDeliveryChanged",
  "onQueueChanged",
  "onTurnStateChanged",
  "onBlockDelta",
  "onApprovalRequested",
  "onApprovalResolved",
  "onFileEditApprovalRequested",
  "onFileEditApprovalResolved",
  "onInterviewRequested",
  "onInterviewAnswered",
  "onInterviewErrored",
  "onEventAppended",
  "onRestoreStarted",
  "onRestoreProgress",
  "onRestoreCompleted",
  "onErrorNotice",
  "onWorktreeStateChanged",
  "onManagedCommandsChanged",
  "onPortForwardsChanged",
  "onHeldUpdatesChanged",
  "onThinkingTokens",
  "onWindowedSnapshot",
  "onSkeletonChunk",
  "onIndexChanged",
  "onRange",
  "onAccumulatedChanges",
] as const satisfies readonly (keyof ChatStreamCallbacks)[];

/**
 * Adapts `ChatStreamClient`'s per-kind callback table (which the vendored
 * client parses and version-normalizes) into a single frame listener.
 */
export function chatCallbacks(
  onFrame: (frame: ChatFrame) => void,
  onConnection: (event: ConnectionEvent) => void,
): ChatStreamCallbacks {
  const table: Record<string, unknown> = {
    onConnectionStatus: (
      status: StreamConnectionStatus,
      reason: StreamCloseReason | null,
      retryCause: FatalErrorDetails | null,
    ) => onConnection({ status, reason, retryCause }),
    readSkeletonResume: () => null,
  };
  for (const name of FRAME_CALLBACKS) {
    table[name] = (frame: ChatFrame) => onFrame(frame);
  }
  return table as unknown as ChatStreamCallbacks;
}

export interface ChatSubscription {
  readonly client: ChatStreamClient;
  close(): void;
}

export function subscribeChat(
  streamClient: WsStreamClient<HostStreamRpcRegistry>,
  epicId: string,
  chatId: string,
  onFrame: (frame: ChatFrame) => void,
  onConnection: (event: ConnectionEvent) => void,
): ChatSubscription {
  const client = new ChatStreamClient({
    wsStreamClient: streamClient,
    epicId,
    chatId,
    callbacks: chatCallbacks(onFrame, onConnection),
  });
  return { client, close: () => client.close() };
}

/** A raw stream session for methods without a vendored typed wrapper. */
export interface RawStream {
  close(): void;
}

/**
 * Opens `method` on the shared stream client and forwards every envelope
 * unparsed; the caller validates. Used for `host.chatRecords.subscribe` and
 * `host.notifications.subscribe`, which have no client wrapper in clients/shared.
 */
export function openRawStream<M extends keyof HostStreamRpcRegistry & string>(
  client: WsStreamClient<HostStreamRpcRegistry>,
  method: M,
  params: Record<string, unknown>,
  onFrame: (frame: ChatFrame) => void,
  onConnection: (event: ConnectionEvent) => void,
): RawStream {
  const session = client.subscribe(method, params as never);
  session.onServerFrame((envelope) => onFrame(envelope as unknown as ChatFrame));
  session.onStatusChange((status, reason, retryCause) => onConnection({ status, reason, retryCause }));
  return { close: () => session.close() };
}

/**
 * `terminal.subscribe` as a `cache` viewer (`@1.6+`: holds no grid size and no reap claim) for the typing route
 * (agent/terminal-typing.ts). Opened at the terminal's current size, so a host that ignored `viewer` would not shrink
 * the operator's view either. A `reconnecting` or `closed` status counts as closed: frames sent while reconnecting
 * are dropped by the transport, so the typing route must stop there.
 */
export function openTerminalStream(
  client: WsStreamClient<HostStreamRpcRegistry>,
  sessionId: string,
  size: { readonly cols: number; readonly rows: number },
  events: {
    onFrame(envelope: Record<string, unknown>, binary: Uint8Array | null): void;
    onClosed(reason: string): void;
  },
): { send(frame: Record<string, unknown>): void; close(): void; negotiated(): { major: number; minor: number } | null } {
  const session = client.subscribe("terminal.subscribe", { sessionId, cols: size.cols, rows: size.rows, viewer: "cache" } as never);
  let closed = false;
  session.onServerFrame((envelope, binary) => {
    if (!closed) events.onFrame(envelope as unknown as Record<string, unknown>, binary ?? null);
  });
  session.onStatusChange((status, reason) => {
    if (closed || (status !== "closed" && status !== "reconnecting")) return;
    const why = reason === null ? status : reason.kind === "fatalError" ? `${reason.details.code}: ${reason.details.reason}` : `${status} (${reason.kind})`;
    events.onClosed(why);
  });
  return {
    send: (frame) => session.sendClientFrame(frame as never, null),
    close: () => {
      closed = true;
      session.close();
    },
    negotiated: () => {
      const v = session.getNegotiatedSchemaVersion();
      return v === null ? null : { major: v.major, minor: v.minor };
    },
  };
}
