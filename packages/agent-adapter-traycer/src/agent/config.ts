import type { Provider } from "@fm1/agent-core";
import type { CredentialSource } from "../credentials";
import type { ProcessAliveCheck } from "../endpoint";
import type { A2aSender, TuiRoute } from "./a2a-delivery";
import { DEFAULT_BACKOFF, type BackoffPolicy } from "./backoff";
import { TERMINAL_REFRESH_MS } from "./terminal-transcript";

/** Harness + model used when the console asks for a new task/session by provider only. */
export interface ProviderModel {
  readonly harnessId: string;
  readonly model: string;
  readonly reasoningEffort?: string;
  /** Default `supervised`, so agent tool calls surface approvals on the FM-1. */
  readonly permissionMode?: string;
}

/** Runs a program with arguments; resolves with exit code and stdout (stderr is discarded). */
export type CommandRunner = (
  program: string,
  args: readonly string[],
  options: { readonly env: Record<string, string | undefined>; readonly timeoutMs: number },
) => Promise<{ readonly code: number | null; readonly stdout: string }>;

export interface TraycerAgentAdapterConfig {
  readonly pidFilePath?: string;
  readonly isAlive?: ProcessAliveCheck;
  readonly credentials?: CredentialSource;
  readonly traycerBin?: string;
  /** Path to reports/traycer-capabilities.json. `null` disables loading (verified:'none'). */
  readonly capabilityReportPath?: string | null;
  /** Reconnect policy for endpoint re-discovery after a drop. */
  readonly backoff?: BackoffPolicy;
  /** Stream-level redial backoff inside the vendored WsStreamClient. */
  readonly streamBackoff?: { readonly initialMs: number; readonly maxMs: number };
  /** Default model per provider for createTask/createSession. Missing provider => unsupported. */
  readonly models?: Partial<Record<Provider, ProviderModel>>;
  /**
   * Off by default. When on, `focus` opens
   * `traycer://open/epic/<E>/chat/<C>?focus=composer`, which only selects the
   * tile on a Desktop build carrying docs/upstream/traycer-deep-link.diff.
   */
  readonly focusDeepLink?: boolean;
  /** listSessions() without a task id scans at most this many tasks with chats on this host, ranked by agent activity (plus every busy task). */
  readonly sessionScanLimit?: number;
  /**
   * Background full scan period (default FULL_SCAN_INTERVAL_MS, 120 s): the agents of every task with chats on this host
   * are read at connect and then this often, so `listSessions` ranks tasks by real agent activity. 0 disables it.
   */
  readonly fullScanIntervalMs?: number;
  readonly includeArchived?: boolean;
  readonly listTasksMaxPages?: number;
  /** Turn completion wait for sendPrompt's trailing `completed` progress. */
  readonly turnTimeoutMs?: number;
  /**
   * listSessions waits at most this long for the first `agent.activity.subscribe`
   * state frame, so a fresh connect does not list every chat as `unknown`. 0 disables.
   */
  readonly firstActivityWaitMs?: number;
  /** How long sendPrompt/respondToApproval wait for the host's ack frames. */
  readonly ackTimeoutMs?: number;
  /** Fallback polling interval bounds, used only while event streams are unavailable. */
  readonly pollBackoff?: BackoffPolicy;
  readonly runCommand?: CommandRunner;
  readonly now?: () => number;
  /**
   * Sender identity for prompts to Claude terminal (TUI) sessions over Traycer a2a (`agent.sendMessage`). The host
   * accepts only a sender agent in the receiver's own task, so give one per task (a single object or a list). A TUI
   * session in a task with no configured sender reports `acceptsPrompt:false`. The adapter never creates agents.
   */
  readonly a2aSender?: A2aSender | readonly A2aSender[];
  /** With no sender for a task, send as the receiver itself (accepted live; the agent sees "from <its own title>"). Off by default. */
  readonly a2aSelfSend?: boolean;
  /** `expectReply` on a2a prompts. Off: the reply is read from the receiver's transcript instead. */
  readonly a2aExpectReply?: boolean;
  /** Transcript poll interval while waiting for a2a delivery (backs off to 5 s after delivery). */
  readonly a2aPollMs?: number;
  /** While a terminal session is selected, its transcript is re-read this often (default 15 s; terminal-transcript.ts). */
  readonly terminalRefreshMs?: number;
  /**
   * How console prompts reach terminal (TUI) agents (operator decision 2026-11-19). `type` (default): typed into the
   * agent's Traycer terminal (terminal-typing.ts) for Claude and Codex terminals, with Traycer a2a as the fallback for
   * Claude when nothing could be typed. `a2a`: Traycer a2a only (Claude terminals; others take no prompts).
   */
  readonly tuiRoute?: TuiRoute;
  /** Typing route: how long the transcript is watched for the typed user message (default: ackTimeoutMs). */
  readonly typeConfirmTimeoutMs?: number;
  /** Typing route: the terminal output must be quiet this long before the screen is read (default 300 ms). */
  readonly typeQuietMs?: number;
}

export interface ResolvedConfig {
  readonly pidFilePath: string | undefined;
  readonly isAlive: ProcessAliveCheck | undefined;
  readonly traycerBin: string;
  readonly capabilityReportPath: string | null;
  readonly backoff: BackoffPolicy;
  readonly streamBackoff: { readonly initialMs: number; readonly maxMs: number };
  readonly models: Partial<Record<Provider, ProviderModel>>;
  readonly focusDeepLink: boolean;
  readonly sessionScanLimit: number;
  readonly fullScanIntervalMs: number;
  readonly includeArchived: boolean;
  readonly listTasksMaxPages: number;
  readonly turnTimeoutMs: number;
  readonly firstActivityWaitMs: number;
  readonly ackTimeoutMs: number;
  readonly pollBackoff: BackoffPolicy;
  readonly now: () => number;
  readonly a2aSenders: readonly A2aSender[];
  readonly a2aSelfSend: boolean;
  readonly a2aExpectReply: boolean;
  readonly a2aPollMs: number;
  readonly terminalRefreshMs: number;
  readonly tuiRoute: TuiRoute;
  readonly typeConfirmTimeoutMs: number;
  readonly typeQuietMs: number;
}

/**
 * Background full session scan period (operator decision 2026-11-22). Task `updatedAt` barely moves while agents work,
 * so the quick `sessionScanLimit` scan ranks tasks by the agent activity this scan collects.
 */
export const FULL_SCAN_INTERVAL_MS = 120_000;

/** Cheapest models, per the project's Traycer safety rules. */
export const DEFAULT_MODELS: Partial<Record<Provider, ProviderModel>> = {
  claude: { harnessId: "claude", model: "haiku" },
  codex: { harnessId: "codex", model: "gpt-5.6-luna", reasoningEffort: "low" },
};

export function defaultCapabilityReportPath(): string {
  return new URL("../../../../reports/traycer-capabilities.json", import.meta.url).pathname;
}

export function resolveConfig(config: TraycerAgentAdapterConfig): ResolvedConfig {
  return {
    pidFilePath: config.pidFilePath,
    isAlive: config.isAlive,
    traycerBin: config.traycerBin ?? "traycer",
    capabilityReportPath:
      config.capabilityReportPath === undefined ? defaultCapabilityReportPath() : config.capabilityReportPath,
    backoff: config.backoff ?? DEFAULT_BACKOFF,
    streamBackoff: config.streamBackoff ?? { initialMs: 1_000, maxMs: 30_000 },
    models: config.models ?? DEFAULT_MODELS,
    focusDeepLink: config.focusDeepLink ?? false,
    sessionScanLimit: config.sessionScanLimit ?? 25,
    fullScanIntervalMs: config.fullScanIntervalMs ?? FULL_SCAN_INTERVAL_MS,
    includeArchived: config.includeArchived ?? false,
    listTasksMaxPages: config.listTasksMaxPages ?? 10,
    turnTimeoutMs: config.turnTimeoutMs ?? 30 * 60_000,
    firstActivityWaitMs: config.firstActivityWaitMs ?? 2_000,
    ackTimeoutMs: config.ackTimeoutMs ?? 15_000,
    pollBackoff: config.pollBackoff ?? { initialMs: 5_000, maxMs: 60_000, factor: 2 },
    now: config.now ?? Date.now,
    a2aSenders: config.a2aSender === undefined ? [] : Array.isArray(config.a2aSender) ? [...(config.a2aSender as readonly A2aSender[])] : [config.a2aSender as A2aSender],
    a2aSelfSend: config.a2aSelfSend ?? false,
    a2aExpectReply: config.a2aExpectReply ?? false,
    a2aPollMs: config.a2aPollMs ?? 1_000,
    terminalRefreshMs: config.terminalRefreshMs ?? TERMINAL_REFRESH_MS,
    tuiRoute: config.tuiRoute === "a2a" ? "a2a" : "type",
    typeConfirmTimeoutMs: config.typeConfirmTimeoutMs ?? config.ackTimeoutMs ?? 15_000,
    typeQuietMs: config.typeQuietMs ?? 300,
  };
}
