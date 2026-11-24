import type { ChatFrame } from "./streams";

/**
 * Follows one `send` through the chat stream: `actionAck` (matched by
 * clientActionId) -> `messageAccepted` (matched by messageId) ->
 * `turnStateChanged` frames until the turn that started after the send ends.
 * Pure state machine so it can be unit-tested without a host.
 */
export type TurnTerminalStatus = "completed" | "stopped" | "interrupted" | "errored";
const TERMINAL: ReadonlySet<string> = new Set(["completed", "stopped", "interrupted", "errored"]);

export interface PromptAck {
  readonly status: "accepted" | "rejected";
  readonly reason: string | null;
  readonly code: string | null;
}

export type PromptOutcome =
  | { readonly kind: "pending" }
  | { readonly kind: "rejected"; readonly ack: PromptAck }
  | { readonly kind: "finished"; readonly status: TurnTerminalStatus; readonly turnId: string };

export class PromptTracker {
  ack: PromptAck | null = null;
  messageAccepted = false;
  /** The host put our message in the chat's queue (a turn was running); it is delivered when the queue drains. */
  queued = false;
  turnId: string | null = null;
  readonly turnStatuses: string[] = [];
  readonly runStatuses: string[] = [];
  /** Last `usage.updated` / `turn.completed` usage (tokens, contextWindow, costUsd). */
  usage: Record<string, number> | null = null;
  private readonly textParts: string[] = [];
  private outcome: PromptOutcome = { kind: "pending" };

  constructor(
    readonly clientActionId: string,
    readonly messageId: string,
    /** turnId already active when the send went out (if any); it is not ours. */
    private readonly priorTurnId: string | null = null,
  ) {}

  get assistantText(): string {
    return this.textParts.join("");
  }

  get result(): PromptOutcome {
    return this.outcome;
  }

  /** Returns true once the outcome is settled. */
  consume(frame: ChatFrame): boolean {
    if (this.outcome.kind !== "pending") return true;
    switch (frame.kind) {
      case "actionAck": {
        if (frame.clientActionId !== this.clientActionId) break;
        this.ack = {
          status: frame.status === "accepted" ? "accepted" : "rejected",
          reason: (frame.reason as string | null | undefined) ?? null,
          code: (frame.code as string | null | undefined) ?? null,
        };
        if (this.ack.status === "rejected") {
          this.outcome = { kind: "rejected", ack: this.ack };
        }
        break;
      }
      case "messageAccepted": {
        const message = frame.message as { id?: unknown; messageId?: unknown } | undefined;
        if (message?.id === this.messageId || message?.messageId === this.messageId) {
          this.messageAccepted = true;
        }
        break;
      }
      case "queueChanged": {
        const items = (frame.queue as { items?: Array<{ messageId?: unknown }> } | undefined)?.items ?? [];
        if (items.some((item) => item.messageId === this.messageId)) this.queued = true;
        break;
      }
      case "turnStateChanged": {
        const runStatus = frame.runStatus as string | undefined;
        if (runStatus !== undefined) this.runStatuses.push(runStatus);
        const turn = frame.activeTurn as
          | { turnId: string; status: string; userMessageId?: string | null }
          | null
          | undefined;
        if (turn === null || turn === undefined) break;
        if (typeof turn.userMessageId === "string") {
          // Host 1.5.4 names the user message that started the turn. The turnId
          // is re-minted when the harness starts (a `turn:<uuid>` placeholder
          // during `starting`, then the harness turn id), so match on the
          // message, not the id.
          if (turn.userMessageId !== this.messageId) break;
          this.turnId = turn.turnId;
        } else {
          if (turn.turnId === this.priorTurnId) break;
          if (this.turnId === null) {
            // Only adopt a turn once our send was accepted by the host.
            if (this.ack?.status !== "accepted" && !this.messageAccepted) break;
            this.turnId = turn.turnId;
          }
          if (turn.turnId !== this.turnId) break;
        }
        this.turnStatuses.push(turn.status);
        if (TERMINAL.has(turn.status)) {
          this.outcome = {
            kind: "finished",
            status: turn.status as TurnTerminalStatus,
            turnId: turn.turnId,
          };
        }
        break;
      }
      case "blockDelta": {
        if (this.turnId === null && !this.messageAccepted) break;
        const event = frame.event as { type?: unknown; delta?: unknown; usage?: unknown } | undefined;
        if (event?.type === "text.delta" && typeof event.delta === "string") {
          this.textParts.push(event.delta);
        } else if (
          (event?.type === "usage.updated" || event?.type === "turn.completed") &&
          typeof event.usage === "object" &&
          event.usage !== null
        ) {
          this.usage = event.usage as Record<string, number>;
        }
        break;
      }
      default:
        break;
    }
    return this.outcome.kind !== "pending";
  }
}
