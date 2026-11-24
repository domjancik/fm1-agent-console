import { randomUUID } from "node:crypto";
import type { FirstPartyClientIdentity } from "@traycer/protocol/framework/client-identity";
import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import { CURRENT_EPIC_VERSION, CURRENT_PHASE_VERSION } from "@traycer-clients/shared/epic/epic-version";
import { plainTextPromptContent } from "@traycer-clients/shared/epic/plain-text-content";
import type { WsStreamClient } from "@traycer-clients/shared/host-transport/ws-stream-client";
import { CredentialSource } from "./credentials";
import { discoverHostEndpoint, type HostEndpoint } from "./endpoint";
import { probeHandshake, type HandshakeResult } from "./handshake";
import { FALLBACK_CLIENT_KIND, FM1_CLIENT_KIND, makeClientIdentity } from "./identity";
import {
  normalizeChat,
  normalizeTask,
  normalizeTuiAgent,
  type ChatRunSettingsValue,
  type NormalizedAgent,
  type NormalizedTask,
} from "./normalize";
import { PromptTracker, type PromptAck, type PromptOutcome } from "./prompt-tracker";
import { TraycerRpc, type HostRequest, type RpcCaller } from "./rpc";
import {
  createStreamClient,
  subscribeChat,
  watchAgentActivity,
  type ActivityWatcher,
  type AgentActivityByEpic,
  type ChatClientFrame,
  type ChatFrame,
  type ConnectionEvent,
} from "./streams";

export interface ClientIdentityResolution {
  readonly kind: string;
  readonly tried: ReadonlyArray<{ readonly kind: string; readonly result: HandshakeResult["kind"]; readonly code?: string }>;
}

export interface SendPromptOptions {
  readonly timeoutMs?: number;
  /** Override the chat's stored run settings. Default: copy them unchanged. */
  readonly settings?: ChatRunSettingsValue;
  readonly onFrame?: (frame: ChatFrame) => void;
}

export interface SendPromptResult {
  readonly epicId: string;
  readonly chatId: string;
  readonly clientActionId: string;
  readonly messageId: string;
  readonly ack: PromptAck | null;
  readonly messageAccepted: boolean;
  readonly outcome: PromptOutcome | { readonly kind: "timeout" };
  readonly turnId: string | null;
  readonly turnStatuses: readonly string[];
  readonly assistantText: string;
  readonly usage: Record<string, number> | null;
  readonly settingsUsed: { readonly harnessId: string; readonly model: string };
  readonly negotiatedChatVersion: string | null;
}

export interface CreateChatOptions {
  readonly settings: ChatRunSettingsValue;
  readonly title?: string;
  readonly initialMessage?: string;
}

/**
 * Traycer backend for FM-1. Talks to the local host directly over the
 * vendored protocol (WS RPC + streams); never routes through an agent context.
 */
export class TraycerAdapter {
  private streamClient: WsStreamClient<HostStreamRpcRegistry> | null = null;

  constructor(
    readonly endpoint: HostEndpoint,
    readonly credentials: CredentialSource,
    readonly clientIdentity: FirstPartyClientIdentity,
    readonly rpc: RpcCaller,
    readonly identityResolution: ClientIdentityResolution | null = null,
  ) {}

  /**
   * Discover the endpoint, load the bearer, and pick a client identity:
   * `fm1-console` first, `cli` if the host refuses the open frame for any
   * reason other than auth.
   */
  static async connect(
    options: { readonly preferredKind?: string; readonly credentials?: CredentialSource } = {},
  ): Promise<TraycerAdapter> {
    const endpoint = await discoverHostEndpoint();
    const credentials = options.credentials ?? new CredentialSource();
    const resolution = await resolveClientIdentity(
      endpoint,
      credentials,
      options.preferredKind ?? FM1_CLIENT_KIND,
    );
    const clientIdentity = makeClientIdentity(resolution.kind);
    const rpc = new TraycerRpc({
      endpoint: async () => endpoint,
      credentials,
      clientIdentity,
    });
    return new TraycerAdapter(endpoint, credentials, clientIdentity, rpc, resolution);
  }

  async handshake(pick?: readonly string[]): Promise<HandshakeResult> {
    const lease = await this.credentials.getLease();
    return probeHandshake({
      websocketUrl: this.endpoint.websocketUrl,
      token: lease.getBearerToken(),
      clientIdentity: this.clientIdentity,
      ...(pick === undefined ? {} : { pick }),
    });
  }

  /** Feature flags only; values (which can include license keys) are not returned. */
  async runtimeCapabilities(): Promise<Record<string, string>> {
    const response = (await this.rpc.call("host.getRuntimeCapabilities", {})) as Record<
      string,
      { status?: unknown }
    >;
    const summary: Record<string, string> = {};
    for (const [name, value] of Object.entries(response)) {
      summary[name] = typeof value?.status === "string" ? value.status : typeof value;
    }
    return summary;
  }

  async listTasks(options: { readonly limit?: number; readonly maxPages?: number } = {}): Promise<NormalizedTask[]> {
    const tasks: NormalizedTask[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < (options.maxPages ?? 10); page += 1) {
      const params: HostRequest<"epic.listTasks"> = {
        limit: options.limit ?? 50,
        filters: null,
        sort: "recent",
        // gui-app passes String(CURRENT_PHASE_VERSION)/String(CURRENT_EPIC_VERSION)
        // (clients/gui-app/src/lib/cloud-epic-tasks-query/query.ts).
        extensionPhaseVersion: String(CURRENT_PHASE_VERSION),
        extensionEpicVersion: String(CURRENT_EPIC_VERSION),
        ...(cursor === undefined ? {} : { cursor }),
      };
      const response = await this.rpc.call("epic.listTasks", params);
      for (const row of response.tasks) {
        const task = normalizeTask(row);
        if (task !== null) tasks.push(task);
      }
      if (!response.hasMore || !response.nextCursor) break;
      cursor = response.nextCursor;
    }
    return tasks;
  }

  /**
   * Every chat record and TUI agent of one task. A non-snapshot answer reads as an empty list, unless `requireSnapshot`
   * (fetchPinned: a missing agent drops a pin, so an answer that lists nothing for another reason must throw instead).
   */
  async listAgents(epicId: string, requireSnapshot = false): Promise<NormalizedAgent[]> {
    const [chatResponse, tuiResponse] = await Promise.all([
      this.rpc.call("epic.listChatRecords", { epicId, hasDocReplica: false, knownRevision: null }),
      this.rpc.call("epic.listTuiAgents", { epicId, hasDocReplica: false, knownRevision: null }),
    ]);
    if (requireSnapshot && (chatResponse?.kind !== "snapshot" || tuiResponse?.kind !== "snapshot")) {
      throw new Error(`agent listing of ${epicId} is not a full snapshot`);
    }
    const chats = chatResponse.kind === "snapshot" ? chatResponse.chats : [];
    const tuiAgents = tuiResponse.kind === "snapshot" ? tuiResponse.tuiAgents : [];
    const settings = await this.chatRunSettings(epicId, chats.map((chat) => chat.chatId));
    return [
      ...chats.map((chat) => normalizeChat(epicId, chat, settings.get(chat.chatId) ?? null)),
      ...tuiAgents.map((agent) => normalizeTuiAgent(epicId, agent)),
    ];
  }

  async chatRunSettings(epicId: string, chatIds: readonly string[]): Promise<Map<string, ChatRunSettingsValue | null>> {
    const result = new Map<string, ChatRunSettingsValue | null>();
    for (let index = 0; index < chatIds.length; index += 50) {
      const batch = chatIds.slice(index, index + 50);
      const response = await this.rpc.call("epic.getChatRunSettingsBatch", { epicId, chatIds: batch });
      for (const entry of response.entries) result.set(entry.chatId, entry.settings);
    }
    return result;
  }

  async getTranscript(epicId: string, agentId: string): Promise<unknown> {
    return this.rpc.call("agent.getTranscript", { epicId, agentId });
  }

  async stop(epicId: string, agentId: string, cascade = false): Promise<unknown> {
    return this.rpc.call("agent.stop", { epicId, agentId, cascade });
  }

  watchActivity(
    onState: (byEpic: AgentActivityByEpic, servedBy: string) => void,
    onConnection?: (event: ConnectionEvent) => void,
  ): Promise<ActivityWatcher> {
    return this.streams().then((client) => watchAgentActivity(client, onState, onConnection));
  }

  /** Creates a GUI chat in an existing task (used for disposable smoke chats). */
  async createChat(epicId: string, options: CreateChatOptions): Promise<{ chatId: string; response: unknown }> {
    const chatId = randomUUID();
    const userId = await this.credentials.userId();
    const params = {
      epicId,
      parentId: null,
      hostId: this.endpoint.hostId,
      title: options.title ?? "",
      workspaceMode: "inherit",
      chatId,
      settings: options.settings,
      worktreeIntent: null,
      ...(options.initialMessage === undefined
        ? {}
        : {
            initialMessage: {
              messageId: randomUUID(),
              clientActionId: randomUUID(),
              content: plainTextPromptContent(options.initialMessage),
              sender: { type: "user", userId },
              settings: options.settings,
              accountContext: { type: "PERSONAL" },
              sentFromHostId: this.endpoint.hostId,
            },
          }),
    } as HostRequest<"epic.createChat">;
    const response = await this.rpc.call("epic.createChat", params, { idempotencyKey: chatId });
    return { chatId, response };
  }

  /**
   * Submit a user prompt to an existing GUI chat - the same `chat.subscribe`
   * `send` action the Desktop composer uses. Run settings are copied from
   * `epic.getChatRunSettings`, so the model/profile do not change.
   */
  async sendPrompt(epicId: string, chatId: string, text: string, options: SendPromptOptions = {}): Promise<SendPromptResult> {
    const settings =
      options.settings ?? (await this.rpc.call("epic.getChatRunSettings", { epicId, chatId })).settings;
    if (settings === null) {
      throw new Error(`chat ${chatId} has no stored run settings; pass settings explicitly`);
    }
    const userId = await this.credentials.userId();
    const client = await this.streams();
    const clientActionId = randomUUID();
    const messageId = randomUUID();

    return new Promise<SendPromptResult>((resolve, reject) => {
      let tracker: PromptTracker | null = null;
      let priorTurnId: string | null = null;
      let sent = false;
      let finished = false;
      const timer = setTimeout(() => finish({ kind: "timeout" }), options.timeoutMs ?? 180_000);

      const finish = (outcome: SendPromptResult["outcome"]): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        const negotiated = client.getMethodSchemaVersion("chat.subscribe");
        subscription.close();
        resolve({
          epicId,
          chatId,
          clientActionId,
          messageId,
          ack: tracker?.ack ?? null,
          messageAccepted: tracker?.messageAccepted ?? false,
          outcome,
          turnId: tracker?.turnId ?? null,
          turnStatuses: tracker?.turnStatuses ?? [],
          assistantText: tracker?.assistantText ?? "",
          usage: tracker?.usage ?? null,
          settingsUsed: { harnessId: settings.harnessId, model: settings.model },
          negotiatedChatVersion: negotiated === null ? null : `${negotiated.major}.${negotiated.minor}`,
        });
      };

      const sendOnce = (): void => {
        if (sent) return;
        sent = true;
        tracker = new PromptTracker(clientActionId, messageId, priorTurnId);
        const frame: ChatClientFrame = {
          kind: "send",
          hasBinaryPayload: false,
          epicId,
          chatId,
          clientActionId,
          messageId,
          content: plainTextPromptContent(text),
          sender: { type: "user", userId },
          settings,
          accountContext: { type: "PERSONAL" },
          sentFromHostId: this.endpoint.hostId,
          deliveryPolicy: "auto",
          worktreeIntent: null,
          browserAnnotations: [],
        };
        subscription.client.sendAction(frame);
      };

      const subscription = subscribeChat(
        client,
        epicId,
        chatId,
        (frame) => {
          options.onFrame?.(frame);
          if (!sent && (frame.kind === "snapshot" || frame.kind === "windowedSnapshot")) {
            priorTurnId = extractActiveTurnId(frame);
            sendOnce();
            return;
          }
          if (tracker !== null && tracker.consume(frame)) {
            finish(tracker.result);
          }
        },
        (event) => {
          if (event.status === "closed" && event.reason?.kind === "fatalError" && !finished) {
            clearTimeout(timer);
            finished = true;
            subscription.close();
            reject(new Error(`chat.subscribe closed: ${event.reason.details.code} ${event.reason.details.reason}`));
          }
        },
      );
    });
  }

  close(): void {
    this.streamClient?.close("adapter-closed");
    this.streamClient = null;
  }

  private async streams(): Promise<WsStreamClient<HostStreamRpcRegistry>> {
    if (this.streamClient === null) {
      this.streamClient = createStreamClient({
        endpoint: this.endpoint,
        lease: await this.credentials.getLease(),
        clientIdentity: this.clientIdentity,
      });
    }
    return this.streamClient;
  }
}

function extractActiveTurnId(frame: ChatFrame): string | null {
  const candidates = [frame.activeTurn, (frame.snapshot as { activeTurn?: unknown } | undefined)?.activeTurn];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object" && typeof (candidate as { turnId?: unknown }).turnId === "string") {
      return (candidate as { turnId: string }).turnId;
    }
  }
  return null;
}

export async function resolveClientIdentity(
  endpoint: HostEndpoint,
  credentials: CredentialSource,
  preferredKind: string,
): Promise<ClientIdentityResolution> {
  const tried: Array<{ kind: string; result: HandshakeResult["kind"]; code?: string }> = [];
  const kinds = preferredKind === FALLBACK_CLIENT_KIND ? [preferredKind] : [preferredKind, FALLBACK_CLIENT_KIND];
  for (const kind of kinds) {
    let token = (await credentials.getLease()).getBearerToken();
    let result = await probeHandshake({ websocketUrl: endpoint.websocketUrl, token, clientIdentity: makeClientIdentity(kind) });
    if (result.kind === "fatal" && result.details.code === "UNAUTHORIZED") {
      await credentials.refresh();
      token = (await credentials.getLease()).getBearerToken();
      result = await probeHandshake({ websocketUrl: endpoint.websocketUrl, token, clientIdentity: makeClientIdentity(kind) });
    }
    tried.push({ kind, result: result.kind, ...(result.kind === "fatal" ? { code: result.details.code } : {}) });
    if (result.kind === "ack") return { kind, tried };
    if (result.kind === "transport") break;
  }
  throw new Error(`host refused every client identity: ${JSON.stringify(tried)}`);
}
