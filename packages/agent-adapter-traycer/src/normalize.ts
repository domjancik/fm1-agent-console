import type { HostResponse } from "./rpc";

/**
 * Normalized rows FM-1 consumes. Field names follow the CLI's `agent list`
 * row where an equivalent exists (`surface`, `harnessId`, `sessionState`) so
 * both pathways produce comparable data. Secrets carried by host rows (for
 * example `roomInfo.token` on tasks) are dropped here and never leave the
 * adapter.
 */
export type AgentSurface = "gui" | "tui";

export interface NormalizedTask {
  readonly epicId: string;
  readonly kind: "epic" | "phase";
  readonly title: string;
  readonly status: string | null;
  readonly createdAt: number | null;
  readonly updatedAt: number | null;
  readonly pinned: boolean;
  readonly chatHostIds: readonly string[];
  readonly workspaces: readonly string[];
  /** Workspace associations with the host that owns each path. */
  readonly workspaceRefs: ReadonlyArray<{ readonly hostId: string; readonly path: string }>;
  /** Repository associations as `owner/repo`. */
  readonly repos: readonly string[];
}

export interface NormalizedAgent {
  readonly epicId: string;
  /** chatId for GUI chats, tuiAgentId for terminal agents. */
  readonly agentId: string;
  readonly surface: AgentSurface;
  readonly harnessId: string | null;
  readonly model: string | null;
  readonly reasoningEffort: string | null;
  readonly permissionMode: string | null;
  readonly profileId: string | null;
  readonly title: string;
  readonly parentId: string | null;
  readonly hostId: string | null;
  readonly ownerUserId: string;
  readonly archived: boolean;
  /** TUI only: running | sleeping | stopped | null. GUI chats report null. */
  readonly sessionState: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

type ListTasksResponse = HostResponse<"epic.listTasks">;
type TaskRow = ListTasksResponse["tasks"][number];

export function normalizeTask(row: TaskRow): NormalizedTask | null {
  const body = row.epic ?? row.phase;
  if (body === undefined || body === null) return null;
  const light = body.light as {
    id: string;
    title?: string;
    status?: string;
    createdAt?: number;
    updatedAt?: number;
  };
  return {
    epicId: light.id,
    kind: row.epic ? "epic" : "phase",
    title: light.title ?? "",
    status: typeof light.status === "string" ? light.status : null,
    createdAt: typeof light.createdAt === "number" ? light.createdAt : null,
    updatedAt: typeof light.updatedAt === "number" ? light.updatedAt : null,
    pinned: row.pinned === true,
    chatHostIds: [...(row.chatHostIds ?? [])],
    workspaces: (body.workspaces ?? []).map((w: { workspacePath: string }) => w.workspacePath),
    workspaceRefs: (body.workspaces ?? []).map((w: { hostId: string; workspacePath: string }) => ({
      hostId: w.hostId,
      path: w.workspacePath,
    })),
    repos: (body.repos ?? []).flatMap((r: { repoIdentifier: { owner: string; repo: string } | null }) =>
      r.repoIdentifier === null ? [] : [`${r.repoIdentifier.owner}/${r.repoIdentifier.repo}`],
    ),
  };
}

type ChatRecordsResponse = HostResponse<"epic.listChatRecords">;
type ChatRecordRow = Extract<ChatRecordsResponse, { kind: "snapshot" }>["chats"][number];
type TuiAgentsResponse = HostResponse<"epic.listTuiAgents">;
type TuiAgentRow = Extract<TuiAgentsResponse, { kind: "snapshot" }>["tuiAgents"][number];
type RunSettingsBatch = HostResponse<"epic.getChatRunSettingsBatch">;
export type ChatRunSettingsValue = NonNullable<RunSettingsBatch["entries"][number]["settings"]>;

export function normalizeChat(
  epicId: string,
  chat: ChatRecordRow,
  settings: ChatRunSettingsValue | null,
): NormalizedAgent {
  return {
    epicId,
    agentId: chat.chatId,
    surface: "gui",
    harnessId: settings?.harnessId ?? null,
    model: settings?.model ?? null,
    reasoningEffort: settings?.reasoningEffort ?? null,
    permissionMode: settings?.permissionMode ?? null,
    profileId: settings?.profileId ?? null,
    title: chat.title,
    parentId: chat.parentChatId,
    hostId: chat.originHostId,
    ownerUserId: chat.ownerUserId,
    archived: chat.archived,
    sessionState: null,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
  };
}

export function normalizeTuiAgent(epicId: string, agent: TuiAgentRow): NormalizedAgent {
  const full = agent as TuiAgentRow & {
    model?: string | null;
    reasoningEffort?: string | null;
    profileId?: string | null;
  };
  return {
    epicId,
    agentId: agent.tuiAgentId,
    surface: "tui",
    harnessId: agent.harnessId ?? null,
    model: typeof full.model === "string" ? full.model : null,
    reasoningEffort: typeof full.reasoningEffort === "string" ? full.reasoningEffort : null,
    permissionMode: null,
    profileId: typeof full.profileId === "string" ? full.profileId : null,
    title: agent.title,
    parentId: agent.parentId,
    hostId: agent.hostId,
    ownerUserId: agent.ownerUserId,
    archived: agent.archived,
    sessionState: agent.sessionState ?? null,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  };
}
