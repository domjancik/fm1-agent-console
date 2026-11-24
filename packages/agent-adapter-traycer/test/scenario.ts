import type { AgentEvent } from "@fm1/agent-core";
import { CredentialSource } from "../src/credentials";
import { TraycerAgentAdapter } from "../src/agent/traycer-agent-adapter";
import type { CommandRunner, TraycerAgentAdapterConfig } from "../src/agent/config";
import { FAKE_HOST_ID, startFakeHost, type FakeHost, type FakeHostOptions, type FakeStreamSub, type RpcOutcome } from "./fake-host";

/**
 * A small Traycer world served by the fake host: tasks, GUI chats, TUI agents
 * and run settings, answered through the real RPC/stream wire, plus helpers to
 * push stream frames. Frame shapes were validated against the vendored
 * host-v1.5.4 schemas (test/fixtures/chat-snapshot.json and the shapes below).
 */
export const HOST = FAKE_HOST_ID;
export const USER = "9120d28e-0000-4000-8000-000000000001";

export interface WorldTask {
  epicId: string;
  title: string;
  workspace: string | null;
  repo?: string;
  updatedAt: number;
}
export interface WorldChat {
  epicId: string;
  chatId: string;
  title: string;
  harnessId: string;
  model: string;
  archived?: boolean;
  hostId?: string;
  /** Record update time (default 2). */
  updatedAt?: number;
}
export interface WorldTui {
  epicId: string;
  tuiAgentId: string;
  title: string;
  harnessId: string;
  sessionState: string;
  /** Record update time (default 4). */
  updatedAt?: number;
}

export class World {
  tasks: WorldTask[] = [];
  chats: WorldChat[] = [];
  tuis: WorldTui[] = [];
  /** Per-method overrides (return undefined to fall through). */
  overrides: Record<string, (params: Record<string, unknown>) => RpcOutcome | undefined> = {};

  handle(method: string, params: Record<string, unknown>): RpcOutcome {
    const override = this.overrides[method]?.(params);
    if (override !== undefined) return override;
    switch (method) {
      case "epic.listTasks":
        return { result: { tasks: this.tasks.map(taskRow), hasMore: false } };
      case "epic.listChatRecords":
        return {
          result: {
            kind: "snapshot",
            listStamp: null,
            chats: this.chats.filter((c) => c.epicId === params.epicId).map(chatRow),
          },
        };
      case "epic.listTuiAgents":
        return {
          result: { kind: "snapshot", listStamp: null, tuiAgents: this.tuis.filter((t) => t.epicId === params.epicId).map(tuiRow) },
        };
      case "epic.getChatRunSettingsBatch":
        return {
          result: {
            entries: (params.chatIds as string[]).map((chatId) => {
              const chat = this.chats.find((c) => c.chatId === chatId);
              return { chatId, settings: chat ? settingsOf(chat) : null };
            }),
          },
        };
      case "epic.getChatRunSettings": {
        const chat = this.chats.find((c) => c.chatId === params.chatId && c.epicId === params.epicId);
        if (!chat) return { error: { code: "NOT_FOUND", message: "chat not found" } };
        return { result: { settings: settingsOf(chat) } };
      }
      case "agent.stop":
        return { result: { stoppedAgentIds: [params.agentId] } };
      case "epic.createChat": {
        const settings = params.settings as { harnessId: string; model: string };
        this.chats.push({ epicId: String(params.epicId), chatId: String(params.chatId), title: "", harnessId: settings.harnessId, model: settings.model });
        return { result: { chatId: params.chatId } };
      }
      case "host.getRuntimeCapabilities":
        return { result: {} };
      default:
        return { error: { code: "METHOD_NOT_FOUND", message: `fake host has no ${method}` } };
    }
  }
}

function taskRow(t: WorldTask) {
  return {
    epic: {
      light: {
        id: t.epicId,
        title: t.title,
        initialUserPrompt: "",
        ticketCount: 0,
        specCount: 0,
        storyCount: 0,
        reviewCount: 0,
        status: "active",
        createdAt: 1,
        updatedAt: t.updatedAt,
        createdBy: USER,
        version: "2.0.0",
      },
      permission: null,
      repos: t.repo ? [{ task: null, repoIdentifier: { owner: t.repo.split("/")[0], repo: t.repo.split("/")[1] }, createdAt: 1, createdBy: USER }] : [],
      workspaces: t.workspace ? [{ task: null, hostId: HOST, workspacePath: t.workspace, createdAt: 1 }] : [],
      roomInfo: null,
    },
    phase: null,
    pinned: false,
    chatHostIds: [HOST],
  };
}

export function chatRecord(c: WorldChat) {
  return {
    chatId: c.chatId,
    ownerUserId: USER,
    originHostId: c.hostId ?? HOST,
    title: c.title,
    isTitleEditedByUser: false,
    parentChatId: null,
    createdAt: 1,
    updatedAt: c.updatedAt ?? 2,
    archived: c.archived ?? false,
    archivedAt: null,
    runSettingsSummary: c.harnessId,
    revision: 1,
    visibility: "private",
    origin: "own",
    docResident: false,
  };
}
const chatRow = chatRecord;

function tuiRow(t: WorldTui) {
  return {
    origin: "own",
    tuiAgentId: t.tuiAgentId,
    ownerUserId: USER,
    hostId: HOST,
    harnessId: t.harnessId,
    parentId: null,
    title: t.title,
    isTitleEditedByUser: false,
    createdAt: 3,
    updatedAt: t.updatedAt ?? 4,
    archived: false,
    revision: 1,
    sessionState: t.sessionState,
    lastExit: null,
  };
}

export function settingsOf(c: WorldChat) {
  return {
    harnessId: c.harnessId,
    model: c.model,
    permissionMode: "supervised",
    reasoningEffort: "low",
    serviceTier: null,
    agentMode: "regular",
    profileId: null,
    ultracode: false,
  };
}

const SNAPSHOT = (await Bun.file(new URL("./fixtures/chat-snapshot.json", import.meta.url)).json()) as {
  snapshot: Record<string, unknown>;
};

export function chatSnapshot(epicId: string, chatId: string, extra: Record<string, unknown> = {}) {
  return {
    kind: "snapshot",
    epicId,
    chatId,
    snapshot: { ...SNAPSHOT.snapshot, chat: { ...(SNAPSHOT.snapshot.chat as object), id: chatId, hostId: HOST, userId: USER }, ...extra },
  };
}

export function turnFrame(sub: FakeStreamSub, status: string, userMessageId: string, turnId = "turn-1") {
  const params = sub.params as { epicId: string; chatId: string };
  return {
    kind: "turnStateChanged",
    epicId: params.epicId,
    chatId: params.chatId,
    runStatus: status === "completed" || status === "errored" ? "idle" : "running",
    activeTurn: {
      turnId,
      status,
      harnessId: "codex",
      model: "gpt-5.6-luna",
      reasoningEffort: "low",
      serviceTier: null,
      agentMode: "regular",
      profileId: null,
      userMessageId,
      startedAt: 1,
      updatedAt: 2,
      sameTurnSteeringSupported: true,
    },
  };
}

export const listRevision = { epoch: "ep1", revision: 1 };

export interface Harness {
  readonly host: FakeHost;
  readonly world: World;
  readonly adapter: TraycerAgentAdapter;
  readonly events: AgentEvent[];
  readonly commands: Array<{ program: string; args: readonly string[]; env: Record<string, string | undefined> }>;
  dispose(): Promise<void>;
}

export function makeHarness(
  options: {
    world?: World;
    host?: Omit<FakeHostOptions, "handle">;
    config?: TraycerAgentAdapterConfig;
    commandOutput?: (program: string, args: readonly string[]) => { code: number; stdout: string };
  } = {},
): Harness {
  const world = options.world ?? new World();
  const host = startFakeHost({ ...options.host, handle: (method, params) => world.handle(method, params as Record<string, unknown>) });
  const pidFilePath = host.writePidFile();
  const commands: Harness["commands"] = [];
  const runCommand: CommandRunner = async (program, args, opts) => {
    commands.push({ program, args, env: opts.env });
    return options.commandOutput?.(program, args) ?? { code: 0, stdout: "" };
  };
  const credentials = new CredentialSource({
    path: "/fake",
    readText: async () => JSON.stringify({ token: "fake-token", user: { id: USER } }),
    whoami: async () => undefined,
  });
  const adapter = new TraycerAgentAdapter({
    pidFilePath,
    isAlive: () => true,
    credentials,
    runCommand,
    backoff: { initialMs: 20, maxMs: 200, factor: 2 },
    streamBackoff: { initialMs: 20, maxMs: 200 },
    pollBackoff: { initialMs: 30, maxMs: 120, factor: 2 },
    ackTimeoutMs: 1_500,
    turnTimeoutMs: 5_000,
    firstActivityWaitMs: 0,
    // The background full scan is off unless a test turns it on (its extra reads would skew request counts).
    fullScanIntervalMs: 0,
    ...options.config,
  });
  const events: AgentEvent[] = [];
  adapter.subscribe((e) => events.push(e));
  return {
    host,
    world,
    adapter,
    events,
    commands,
    dispose: async () => {
      await adapter.disconnect();
      host.stop();
    },
  };
}

export async function until(check: () => boolean, timeoutMs = 3_000, what = "condition"): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

/** The common two-task world: one workspace task with a codex chat, a claude chat and a TUI agent. */
export function standardWorld(): World {
  const world = new World();
  world.tasks = [
    { epicId: "e1", title: "Task one", workspace: "/Users/me/dev/alpha", updatedAt: 20 },
    { epicId: "e2", title: "Task two", workspace: null, repo: "acme/beta", updatedAt: 10 },
  ];
  world.chats = [
    { epicId: "e1", chatId: "c1", title: "Codex chat", harnessId: "codex", model: "gpt-5.6-luna" },
    { epicId: "e1", chatId: "c2", title: "Claude chat", harnessId: "claude", model: "haiku" },
    { epicId: "e2", chatId: "c3", title: "", harnessId: "claude", model: "haiku" },
  ];
  world.tuis = [{ epicId: "e1", tuiAgentId: "t1", title: "Terminal", harnessId: "claude", sessionState: "running" }];
  return world;
}
