// Application-level abstractions (spec section 4). These are not Traycer API names.
import type { MdBlock } from "./markdown";

export type Provider = "claude" | "codex" | "other";
export type Runtime = "chat" | "terminal";

export const NORMALIZED_STATES = [
  "disconnected",
  "idle",
  "working",
  "waiting_input",
  "approval_required",
  "completed_unread",
  "completed_read",
  "failed",
  "unknown",
] as const;
export type NormalizedState = (typeof NORMALIZED_STATES)[number];

/** Composite identity. Never route by label, slot, title or agent name. */
export interface SessionRef {
  backendId: string;
  hostId: string;
  projectId: string;
  taskId: string;
  sessionId: string;
}
export type TaskRef = Omit<SessionRef, "sessionId">;
export type ProjectRef = Omit<TaskRef, "taskId">;

/** What the backend reported, verbatim in meaning. `state` is null when the backend said nothing usable. */
export interface ObservedFacts {
  state: NormalizedState | null;
  at: number;
  detail?: string;
}

/** A heuristic guess. Never presented as a backend fact. */
export interface InferredFacts {
  state: NormalizedState;
  reason: string;
}

export interface SessionStatus {
  observed: ObservedFacts;
  inferred?: InferredFacts;
  /** Backend's raw state for diagnostics. */
  raw: unknown;
}

export interface Project extends ProjectRef {
  name: string;
}

export interface Task {
  ref: TaskRef;
  title: string;
  updatedAt: number;
}

/**
 * What the chat stream says about a session beyond its state (docs/ux-v2.md section 7.1). Every field is optional
 * and ASCII; adapters fill what they can observe (the Traycer adapter: chats whose stream is open).
 */
export interface SessionDetails {
  /** Plain text of the last completed assistant message, <= 600 characters. */
  lastMessage?: string;
  /**
   * The same message's Markdown structure (markdown.ts `markdownBlocks`, docs/ui-v3.md section 13): from at most
   * MARKDOWN_SOURCE_MAX (2000) characters of redacted, ASCII-folded source. When present the bubble and DETAILS lay
   * it out (headings, lists, code, tables) instead of wrapping `lastMessage` as one line.
   */
  lastBlocks?: MdBlock[];
  lastMessageAt?: number;
  /** The tool call in progress, verb + target: `editing view.ts`, `running bun test`. <= 60 characters. */
  activity?: string;
  /** Error text of a failed turn, <= 200 characters. */
  failure?: string;
  /** The pending approval: the command or file, and what it does. */
  approval?: { target: string; summary?: string };
  /** Context window usage of the last usage report, 0..100. */
  contextPct?: number;
  /** Short model name (`opus-4.5`, `haiku`). */
  model?: string;
  /** Turns (user messages) in the chat. */
  turns?: number;
  /** Files changed in the last turn: count and up to 3 base names. */
  files?: { count: number; names: string[] };
  /** The last prompt the session received (terminal transcripts), for context. <= 200 characters. */
  lastPrompt?: string;
  /**
   * The answer to the last console prompt, when the adapter can tell it apart (Traycer: a terminal agent's reply to an
   * a2a prompt). The bubble shows it as the last message when it is the newest thing the session said.
   */
  reply?: PromptReply;
  /**
   * Suggested next prompts for this session, best first, 0..3 (docs/ui-v3.md section 11): ASCII, redacted, each at most
   * SUGGESTION_MAX characters. Absent or empty means none. Traycer: a GUI chat's `suggestedPrompt` (chat.subscribe
   * >= 1.20), or a terminal agent's trailing "next steps" list. The console offers the first on a short REC tap and
   * sends one only after SAVE on the review screen.
   */
  suggestions?: string[];
}

/** Most suggestions a session carries, and the longest one (characters). */
export const MAX_SUGGESTIONS = 3;
export const SUGGESTION_MAX = 600;

/** The answer to one console prompt (`requestId` of the sendPrompt call). `text` is ASCII, <= 600 characters. */
export interface PromptReply {
  requestId: string;
  text: string;
  at: number;
  /** The reply's Markdown structure (as `SessionDetails.lastBlocks`). */
  blocks?: MdBlock[];
}

/**
 * Whether a session takes console prompts at all, known before any send (docs/ui-v3.md section 9.7). Absent means yes
 * (as far as the adapter knows). With `acceptsPrompt: false` the console shows no REC in the hint, refuses REC with
 * `toast`, and never records. `reason` is for logs and the desktop UI; `line` (<= 28) and `toast` (<= 20) are device
 * copy the adapter may give (ASCII; agent-core falls back to its own words).
 */
export interface PromptCapability {
  acceptsPrompt: boolean;
  reason?: string;
  line?: string;
  toast?: string;
}

export interface Session {
  ref: SessionRef;
  title: string;
  provider: Provider;
  runtime: Runtime;
  workspace: string;
  status: SessionStatus;
  summary?: string;
  createdAt: number;
  /** Last activity (ms since epoch): max of agent record update, last turn outcome and creation. Optional. */
  lastActivityAt?: number;
  /** Chat details (docs/ux-v2.md section 7.1). Optional. */
  details?: SessionDetails;
  /**
   * The session key of the parent agent (a sub-agent's spawner, same task; docs/ui-v3.md section 9.2). Optional; the
   * GROUPED list indents a child under its parent (Traycer: the agent record's parent link).
   */
  parentKey?: string;
  /** Whether this session takes console prompts (see PromptCapability). Optional; absent = yes. */
  prompt?: PromptCapability;
}

export interface ApprovalRequest {
  id: string;
  sessionRef: SessionRef;
  summary: string;
  createdAt: number;
}

export const DELIVERY_STAGES = [
  "accepted_locally",
  "sent",
  "backend_acknowledged",
  "completed",
  "failed",
  "unsupported",
  "target_unavailable",
] as const;
export type DeliveryStage = (typeof DELIVERY_STAGES)[number];

export interface CommandResult {
  requestId: string;
  stage: DeliveryStage;
  message?: string;
}

export const CAPABILITY_NAMES = [
  "listProjects",
  "listTasks",
  "listSessions",
  "subscribe",
  "sendPrompt",
  "createTask",
  "createSession",
  "respondToApproval",
  "interrupt",
  "focus",
] as const;
export type CapabilityName = (typeof CAPABILITY_NAMES)[number];

export interface Capability {
  supported: boolean;
  reason?: string;
  /** How support was established: exercised live, read from code, or not verified. */
  verified: "live" | "code" | "none";
}
export type AdapterCapabilities = Record<CapabilityName, Capability>;

export interface CreateTaskRequest {
  requestId: string;
  project: ProjectRef;
  title: string;
  provider: Provider;
  prompt?: string;
}

export interface CreateSessionRequest {
  requestId: string;
  task: TaskRef;
  provider: Provider;
  prompt?: string;
}

export interface ApprovalDecision {
  requestId: string;
  approvalId: string;
  sessionRef: SessionRef;
  decision: "approve" | "deny";
}

export type CreateTaskResult = CommandResult & { task?: Task };
export type CreateSessionResult = CommandResult & { session?: Session };

export type ConnectionState = "connected" | "degraded" | "disconnected";

export type AgentEvent =
  | { type: "session_upserted"; session: Session }
  | { type: "session_removed"; ref: SessionRef }
  | { type: "task_upserted"; task: Task }
  | { type: "task_removed"; ref: TaskRef }
  | { type: "approval_requested"; approval: ApprovalRequest }
  | { type: "approval_resolved"; approvalId: string }
  | { type: "command_progress"; requestId: string; stage: DeliveryStage; message?: string }
  | { type: "connection"; state: ConnectionState; reason?: string };

export type Unsubscribe = () => void;

/** What the console asks an adapter for outside its normal scan (docs/ui-v3.md section 9.7). */
export interface PinnedRequest {
  sessions: SessionRef[];
  tasks: TaskRef[];
}

/** The pinned sessions and tasks found, and the pins Traycer reports deleted or archived (session or task keys). */
export interface PinnedResult {
  sessions: Session[];
  tasks: Task[];
  gone: string[];
}

export interface AgentAdapter {
  readonly id: string;
  /**
   * The backend's name in device copy (`<name> offline`, `Gone from <name>`): short, ASCII, e.g. "Traycer". Optional;
   * agent-core falls back to `id`.
   */
  readonly displayName?: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getCapabilities(): AdapterCapabilities;
  listProjects(): Promise<Project[]>;
  listTasks(projectId?: string): Promise<Task[]>;
  listSessions(taskId?: string): Promise<Session[]>;
  listApprovals(): Promise<ApprovalRequest[]>;
  subscribe(listener: (event: AgentEvent) => void): Unsubscribe;
  sendPrompt(target: SessionRef, text: string, requestId: string): Promise<CommandResult>;
  createTask(request: CreateTaskRequest): Promise<CreateTaskResult>;
  createSession(request: CreateSessionRequest): Promise<CreateSessionResult>;
  respondToApproval(decision: ApprovalDecision): Promise<CommandResult>;
  interrupt(session: SessionRef, requestId: string): Promise<CommandResult>;
  focus(session: SessionRef, requestId: string): Promise<CommandResult>;
  /**
   * Optional (docs/ui-v3.md section 9.7): fetch pinned sessions and every session of pinned tasks even when they lie
   * outside the adapter's scan, and say which pins are gone. Without it, a pin missing from a snapshot is dropped. The
   * console asks only for pins outside the last snapshot, the pins of at most 25 tasks per call, at a slow cadence
   * (console.ts PIN_FETCH_TASKS, PIN_CATCHUP_MS, PIN_REFRESH_MS; docs/traycer-integration.md).
   */
  fetchPinned?(request: PinnedRequest): Promise<PinnedResult>;
}

/** Full enumeration used on connect and reconnect. */
export interface Snapshot {
  projects: Project[];
  tasks: Task[];
  sessions: Session[];
  approvals: ApprovalRequest[];
}

export type Result<T, E = string> = { ok: true; value: T } | { ok: false; error: E };

/** The name device copy uses for an adapter's backend: its displayName, else its id; ASCII, at most 12 characters. */
export function backendName(adapter: Pick<AgentAdapter, "id" | "displayName">): string {
  const raw = (typeof adapter.displayName === "string" && adapter.displayName.trim() ? adapter.displayName : adapter.id) ?? "";
  const ascii = raw.replace(/[^\x20-\x7e]/g, " ").replace(/\s+/g, " ").trim();
  return ascii.slice(0, 12).trim() || "Backend";
}
