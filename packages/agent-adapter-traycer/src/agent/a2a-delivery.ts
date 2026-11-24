import type { CommandResult, DeliveryStage, PromptCapability as CorePromptCapability } from "@fm1/agent-core";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { NormalizedAgent } from "../normalize";
import { TYPING_HARNESSES } from "./tui-screen-state";

/**
 * Console prompts to Claude terminal (TUI) agents through Traycer a2a (`agent.sendMessage@1.x`).
 *
 * Live findings (reports/evidence/tui-a2a/, host 1.5.4):
 * - The host accepts any sender agent the user owns IN THE RECEIVER'S TASK (GUI or TUI, running, stopped or archived;
 *   the receiver itself too). An unknown id or a sender from another task is refused `FORBIDDEN`.
 * - The broker queues the message in the receiver's durable inbox; `traycer monitor` inside the Claude TUI prints it
 *   and Claude takes a turn. It appears in `agent.getTranscript` as a `<task-notification>` within ~1 s, and the
 *   assistant answer follows (about 3 s for a one-line haiku reply).
 * - A receiver whose Claude is blocked (for example on the folder-trust dialog) never starts its monitor: the RPC
 *   still succeeds, but nothing reaches the agent. So RPC success is `sent`, not `backend_acknowledged`.
 * - Codex and other non-Claude TUI harnesses cannot receive a2a (`TARGET_TUI_UNSUPPORTED`).
 * - Replies over a2a are not reliable (the receiver's own auto-mode classifier denied `traycer_send_message` live), and
 *   a GUI sender's inbox cannot be subscribed (`AGENT_NOT_FOUND`). The reply is read from the receiver's transcript.
 *
 * Since 2026-11-19 (operator decision) this is the FALLBACK for Claude terminals: the primary route types the prompt into
 * the agent's terminal (terminal-typing.ts, `tuiRoute: "type"`). a2a is used only when nothing was typed.
 */
export interface A2aSender {
  readonly agentId: string;
  /** The task (epic) this sender agent lives in. It can only message agents of this same task. */
  readonly epicId: string;
}

export type PromptRoute = "chat.subscribe" | "agent.sendMessage" | "terminal.write";

/** How console prompts reach terminal (TUI) agents: typed into their terminal (default) or Traycer a2a only. */
export type TuiRoute = "type" | "a2a";

/**
 * agent-core's `PromptCapability` (acceptsPrompt, reason, device `line` <= 28 and `toast` <= 20) plus the route. agent-core
 * validation keeps only the core fields, so `via` and `senderAgentId` stay inside the adapter.
 */
export interface PromptCapability extends CorePromptCapability {
  readonly via?: PromptRoute | null;
  /** For `agent.sendMessage` (or the a2a fallback of `terminal.write`): the sender agent the prompt goes out as. */
  readonly senderAgentId?: string;
  /** For `terminal.write`: the route used when nothing could be typed (Claude only). */
  readonly fallbackVia?: "agent.sendMessage";
}

/** `codex` -> `Codex`; unknown harnesses read `Agent`. */
const harnessWord = (harness: string): string => (harness === "unknown" || harness === "" ? "Agent" : harness[0]?.toUpperCase() + harness.slice(1).toLowerCase());

/** Device copy of a session that takes no console prompts (docs/ui-v3.md section 9.7): bubble line <= 28, toast <= 20. */
export const PROMPT_COPY = {
  /** Codex and other harnesses without an inbox monitor (operator wording for Codex). */
  harness: (harness: string): { line: string; toast: string } => {
    // A long harness name would be cut mid-word ("Opencode terminal: open on M"): fall back to the generic line.
    const named = `${harnessWord(harness)} terminal: open on Mac`;
    return { line: named.length <= 28 && /^[\x20-\x7e]+$/.test(named) ? named : "Terminal: open on Mac", toast: "Terminal: use Mac" };
  },
  noSender: { line: "Terminal: no FM-1 sender", toast: "No sender for task" },
  lost: { line: "Prompts unavailable here", toast: "Not supported" },
} as const;

/** Harnesses whose Traycer TUI runs the inbox monitor (Claude Code plugin `monitors/monitors.json`). */
export const A2A_HARNESSES: ReadonlySet<string> = new Set(["claude"]);

export interface A2aPolicy {
  readonly senders: readonly A2aSender[];
  /** Use the receiver as its own sender when no sender is configured for its task (works live; framed "from <its title>"). */
  readonly selfSend: boolean;
  /** Terminal prompts: `type` (default when omitted) types into the terminal with a2a as Claude's fallback; `a2a` only a2a. */
  readonly tuiRoute?: TuiRoute;
}

/** The a2a sender for a Claude terminal agent, or null (no sender for its task and no self-send, or not Claude). */
function a2aSenderFor(agent: NormalizedAgent, policy: A2aPolicy): string | null {
  if (!A2A_HARNESSES.has(agent.harnessId ?? "unknown")) return null;
  const sender = policy.senders.find((s) => s.epicId === agent.epicId);
  if (sender !== undefined) return sender.agentId;
  return policy.selfSend ? agent.agentId : null;
}

export function promptCapabilityFor(agent: NormalizedAgent, policy: A2aPolicy): PromptCapability {
  if (agent.surface === "gui") return { acceptsPrompt: true, via: "chat.subscribe" };
  const harness = agent.harnessId ?? "unknown";
  const sender = a2aSenderFor(agent, policy);
  if ((policy.tuiRoute ?? "type") === "type" && TYPING_HARNESSES.has(harness)) {
    return { acceptsPrompt: true, via: "terminal.write", ...(sender !== null ? { fallbackVia: "agent.sendMessage" as const, senderAgentId: sender } : {}) };
  }
  if (!A2A_HARNESSES.has(harness)) {
    const typing = (policy.tuiRoute ?? "type") === "type";
    return {
      acceptsPrompt: false,
      via: null,
      reason: typing
        ? `terminal session (${harness}): its terminal prompt is not recognized for typing and it cannot receive Traycer agent messages`
        : `terminal session (${harness}): this harness cannot receive Traycer agent messages, and typing into terminals is off (tuiRoute "a2a")`,
      ...PROMPT_COPY.harness(harness),
    };
  }
  if (sender !== null) return { acceptsPrompt: true, via: "agent.sendMessage", senderAgentId: sender };
  return {
    acceptsPrompt: false,
    via: null,
    reason:
      "terminal session: no FM-1 sender agent configured for this task (agent.sendMessage needs a sender agent in the receiver's own task; set a2aSender)",
    ...PROMPT_COPY.noSender,
  };
}

export interface A2aReply {
  readonly requestId: string;
  readonly text: string;
  readonly at: number;
}

export interface A2aArgs {
  readonly requestId: string;
  readonly epicId: string;
  readonly receiverAgentId: string;
  readonly senderAgentId: string;
  readonly text: string;
  readonly expectReply: boolean;
  /** How long the call waits to see the prompt reach the receiver's transcript before resolving `sent`. */
  readonly ackTimeoutMs: number;
  /** How long the trailing `completed` watch runs. */
  readonly turnTimeoutMs: number;
  readonly pollMs: number;
}

export interface A2aDeps {
  sendMessage(params: {
    senderAgentId: string;
    epicId: string;
    receiverAgentId: string;
    prompt: string;
    responseId: string | null;
    expectReply: boolean;
    workspace: string | null;
  }, idempotencyKey: string): Promise<{ responseId: string | null }>;
  /** `agent.getTranscript` text, or null when unreadable. */
  transcript(epicId: string, agentId: string): Promise<string | null>;
  progress(requestId: string, stage: DeliveryStage, message?: string): void;
  onReply(reply: A2aReply): void;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** False once the adapter disconnects: the background watch stops. */
  active(): boolean;
}

const FORBIDDEN = /FORBIDDEN/;
const TARGET_GONE = /NOT_FOUND|AGENT_NOT_FOUND|not found|no such|deleted/i;
const TUI_UNSUPPORTED = /TARGET_TUI_UNSUPPORTED|cannot receive agent-to-agent/i;
const INCOMPATIBLE = /INCOMPATIBLE|DOWNGRADE_UNSUPPORTED/;

/** Thrown by `A2aDeps.sendMessage` when the request provably never left the adapter (for example the link was down). */
export class A2aNotSentError extends Error {
  override readonly name = "A2aNotSentError";
}

/** Maps an `agent.sendMessage` failure. A HostRpcError is a definite host answer: nothing was queued. */
export function a2aError(requestId: string, error: unknown, senderAgentId: string): CommandResult {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof A2aNotSentError) return { requestId, stage: "failed", message: `${message}; agent.sendMessage not sent` };
  if (!(error instanceof HostRpcError)) {
    // The request may have reached the host before the socket failed.
    return { requestId, stage: "sent", message: `agent.sendMessage outcome unknown (${message}); delivery uncertain, not resent` };
  }
  const text = `${error.code} ${message}`;
  if (INCOMPATIBLE.test(error.code)) return { requestId, stage: "unsupported", message: `host INCOMPATIBLE on agent.sendMessage: ${message}` };
  if (TUI_UNSUPPORTED.test(text)) return { requestId, stage: "unsupported", message: "this terminal harness cannot receive Traycer agent messages" };
  if (FORBIDDEN.test(error.code)) {
    return { requestId, stage: "failed", message: `host refused sender ${senderAgentId} for this task (FORBIDDEN); nothing delivered` };
  }
  if (TARGET_GONE.test(text)) return { requestId, stage: "target_unavailable", message };
  return { requestId, stage: "failed", message: `${error.code}: ${message}; nothing delivered` };
}

const escapeXml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A stable piece of the prompt to find in the transcript (long prompts are truncated by the monitor). */
export function promptNeedles(text: string): string[] {
  const head = text.trim().split("\n")[0]?.slice(0, 120) ?? "";
  return head.length === 0 ? [] : [...new Set([head, escapeXml(head)])];
}

function occurrences(haystack: string, needle: string): number[] {
  const out: number[] = [];
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + needle.length)) out.push(at);
  return out;
}

/**
 * Where the (baseline+1)-th occurrence of our prompt starts, and the first assistant answer after it.
 * `baseline` counts occurrences seen before the send, so an identical earlier prompt never matches.
 */
export function locateTurn(transcript: string, needles: readonly string[], baseline: number): { delivered: boolean; reply: string | null } {
  for (const needle of needles) {
    const hits = occurrences(transcript, needle);
    if (hits.length <= baseline) continue;
    const at = hits[baseline] as number;
    const m = /<assistant_response>\n?([\s\S]*?)<\/assistant_response>/.exec(transcript.slice(at));
    if (m === null) return { delivered: true, reply: null };
    const reply = (m[1] ?? "").replace(/^\[assistant row[^\]]*\]\n?/, "").trim();
    return { delivered: true, reply };
  }
  return { delivered: false, reply: null };
}

function baselineCount(transcript: string | null, needles: readonly string[]): number {
  if (transcript === null) return 0;
  return Math.max(0, ...needles.map((n) => occurrences(transcript, n).length));
}

/**
 * Sends once and reports stages:
 *   sent                 `agent.sendMessage` returned (queued in the receiver's inbox)
 *   backend_acknowledged the prompt is in the receiver's transcript (the monitor delivered it) -> the call resolves here
 *   completed            an assistant answer follows it in the transcript (later `command_progress`; reply captured)
 * If delivery is not observed within `ackTimeoutMs` the call resolves `sent` and the watch continues in the background.
 */
export async function deliverA2a(deps: A2aDeps, args: A2aArgs): Promise<CommandResult> {
  const { requestId } = args;
  const needles = promptNeedles(args.text);
  const read = (): Promise<string | null> => deps.transcript(args.epicId, args.receiverAgentId).catch(() => null);
  // Without a baseline an identical earlier prompt (and its old answer) would pass for this delivery. Retry once; if the
  // transcript is still unreadable, the first readable transcript after the send becomes the baseline (conservative:
  // a delivery already in it is not acknowledged, so the result stays `sent`, never a stale `completed`).
  const before = (await read()) ?? (await read());
  let baseline: number | null = before === null ? null : baselineCount(before, needles);
  try {
    await deps.sendMessage(
      {
        senderAgentId: args.senderAgentId,
        epicId: args.epicId,
        receiverAgentId: args.receiverAgentId,
        prompt: args.text,
        responseId: null,
        expectReply: args.expectReply,
        workspace: null,
      },
      `fm1-a2a-${requestId}`,
    );
  } catch (error) {
    return a2aError(requestId, error, args.senderAgentId);
  }
  deps.progress(requestId, "sent");
  const started = deps.now();

  return new Promise<CommandResult>((resolve) => {
    let settled = false;
    const settle = (r: CommandResult): void => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    void (async () => {
      let acked = false;
      let interval = args.pollMs;
      while (deps.now() - started < args.turnTimeoutMs && deps.active()) {
        if (!acked && deps.now() - started >= args.ackTimeoutMs) {
          settle({
            requestId,
            stage: "sent",
            message: "queued in the terminal agent's inbox; delivery not observed yet (the agent may be blocked or its monitor not running)",
          });
        }
        await deps.sleep(interval);
        // Fast until delivery is seen, then back off (a turn can run for minutes): at most one read per 5 s.
        if (acked) interval = Math.min(interval * 2, Math.max(args.pollMs, 5_000));
        const transcript = await read();
        if (transcript === null) continue;
        if (baseline === null) {
          baseline = baselineCount(transcript, needles);
          continue;
        }
        const turn = locateTurn(transcript, needles, baseline);
        if (turn.delivered && !acked) {
          acked = true;
          deps.progress(requestId, "backend_acknowledged");
          settle({ requestId, stage: "backend_acknowledged" });
        }
        if (turn.reply !== null) {
          deps.onReply({ requestId, text: turn.reply, at: deps.now() });
          deps.progress(requestId, "completed");
          return;
        }
      }
      settle({ requestId, stage: "sent", message: "queued in the terminal agent's inbox; delivery not observed (no transcript entry)" });
    })();
  });
}
