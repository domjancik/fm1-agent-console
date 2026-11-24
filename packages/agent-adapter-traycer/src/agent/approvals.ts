import { randomUUID } from "node:crypto";
import type { CommandResult } from "@fm1/agent-core";
import type { ChatClientFrame, ChatFrame } from "../streams";
import type { ChatChannel, PendingApproval } from "./chat-channel";
import { redactSecrets } from "./chat-details";
import type { NotificationRow } from "./feeds";

/**
 * Pending approvals across all chats. Two sources:
 *  - `host.notifications.subscribe` `approval.requested` rows (every chat on this host);
 *  - the selected chat's `chat.subscribe` snapshot / approvalRequested / approvalResolved.
 * An approval id that was ever seen resolved stays resolved, so a late or
 * replayed request frame cannot resurrect it.
 */
export interface ApprovalEntry {
  readonly approvalId: string;
  readonly epicId: string;
  readonly chatId: string;
  readonly summary: string;
  readonly createdAt: number;
  readonly source: "notification" | "chat";
}

export interface ApprovalListener {
  onRequested(entry: ApprovalEntry): void;
  onResolved(entry: ApprovalEntry | null, approvalId: string): void;
}

export class ApprovalStore {
  private readonly entries = new Map<string, ApprovalEntry>();
  private readonly resolved = new Set<string>();
  private readonly byNotification = new Map<string, string>();

  constructor(private readonly listener: ApprovalListener) {}

  list(): ApprovalEntry[] {
    return [...this.entries.values()];
  }

  get(approvalId: string): ApprovalEntry | undefined {
    return this.entries.get(approvalId);
  }

  isResolved(approvalId: string): boolean {
    return this.resolved.has(approvalId);
  }

  pendingFor(epicId: string, chatId: string): Set<string> {
    const ids = new Set<string>();
    for (const e of this.entries.values()) if (e.epicId === epicId && e.chatId === chatId) ids.add(e.approvalId);
    return ids;
  }

  add(entry: ApprovalEntry): void {
    if (this.resolved.has(entry.approvalId) || this.entries.has(entry.approvalId)) return;
    this.entries.set(entry.approvalId, entry);
    this.listener.onRequested(entry);
  }

  resolve(approvalId: string): void {
    if (this.resolved.has(approvalId)) return;
    this.resolved.add(approvalId);
    const entry = this.entries.get(approvalId) ?? null;
    this.entries.delete(approvalId);
    // Only announce approvals that were announced as pending (old resolved rows stay silent).
    if (entry !== null) this.listener.onResolved(entry, approvalId);
  }

  applyNotifications(rows: readonly NotificationRow[], snapshot: boolean): void {
    const seen = new Set<string>();
    for (const row of rows) {
      if (row.kind !== "approval.requested" || row.approvalId === null || row.epicId === null || row.chatId === null) continue;
      this.byNotification.set(row.id, row.approvalId);
      seen.add(row.approvalId);
      if (row.resolvedAt !== null) this.resolve(row.approvalId);
      else
        this.add({
          approvalId: row.approvalId,
          epicId: row.epicId,
          chatId: row.chatId,
          summary: row.title ? `Approval: ${row.title}` : "Approval requested",
          createdAt: row.updatedAt,
          source: "notification",
        });
    }
    if (snapshot) {
      // A notification-sourced approval missing from a fresh snapshot is no longer pending.
      for (const entry of [...this.entries.values()]) {
        if (entry.source === "notification" && !seen.has(entry.approvalId)) this.resolve(entry.approvalId);
      }
    }
  }

  applyReadState(ids: readonly string[], resolvedAt: number | null): void {
    if (resolvedAt === null) return;
    for (const id of ids) {
      const approvalId = this.byNotification.get(id);
      if (approvalId !== undefined) this.resolve(approvalId);
    }
  }

  /** Reconciles one chat against its stream's authoritative pending set. */
  applyChannel(channel: ChatChannel): void {
    for (const id of channel.resolvedApprovals) this.resolve(id);
    for (const pending of channel.pendingApprovals.values()) {
      this.add({
        approvalId: pending.approvalId,
        epicId: channel.epicId,
        chatId: channel.chatId,
        summary: approvalSummary(pending),
        createdAt: pending.requestedAt,
        source: "chat",
      });
    }
    if (!channel.ready) return;
    for (const entry of [...this.entries.values()]) {
      if (entry.epicId === channel.epicId && entry.chatId === channel.chatId && !channel.pendingApprovals.has(entry.approvalId)) {
        this.resolve(entry.approvalId);
      }
    }
  }
}

/** Short action summary for the device: tool, then what it does (file edits name their paths). */
export function approvalSummary(p: PendingApproval): string {
  const what = p.kind === "fileEdit" && p.paths.length > 0 ? `${p.description ? `${p.description} ` : ""}${p.paths.join(", ")}` : p.description;
  // The summary reaches the device (confirm view, DETAILS page): secret-looking values are masked first.
  return redactSecrets(`${p.toolName}: ${what}`).trim().slice(0, 200);
}

const STALE_APPROVAL = /not[_ ]?found|resolved|stale|unknown|expired|no[_ ]?pending|gone/i;

/**
 * Sends one `approvalDecision` for an approval the chat stream currently lists
 * as pending. Exact approvalId only; anything not pending is `target_unavailable`.
 */
export function decideApproval(
  channel: ChatChannel,
  args: { readonly requestId: string; readonly approvalId: string; readonly approved: boolean; readonly ackTimeoutMs: number },
): Promise<CommandResult> {
  const { requestId, approvalId } = args;
  const pending = channel.pendingApprovals.get(approvalId);
  if (pending === undefined) {
    return Promise.resolve({ requestId, stage: "target_unavailable", message: `approval ${approvalId} is not pending (stale or already resolved)` });
  }
  if (channel.closed) {
    return Promise.resolve({ requestId, stage: "failed", message: `chat stream closed before the decision; nothing sent (${channel.closeError().message})` });
  }
  const decisionKind = pending.kind === "fileEdit" ? "fileEditApprovalDecision" : "approvalDecision";
  const clientActionId = randomUUID();
  return new Promise<CommandResult>((resolve) => {
    let ack: "accepted" | null = null;
    let finished = false;
    const done = (result: CommandResult): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      stopFrames();
      stopClose();
      resolve(result);
    };
    const timer = setTimeout(
      () =>
        done(
          ack === "accepted"
            ? { requestId, stage: "backend_acknowledged", message: "decision accepted; resolution not yet reported" }
            : { requestId, stage: "sent", message: `no host ack within ${args.ackTimeoutMs}ms; not resent` },
        ),
      args.ackTimeoutMs,
    );
    const stopFrames = channel.onFrame((frame: ChatFrame) => {
      if (frame.kind === "actionAck" && frame.clientActionId === clientActionId) {
        if (frame.status === "accepted") {
          ack = "accepted";
          return;
        }
        const why = [frame.code, frame.reason].filter((v) => typeof v === "string" && v.length > 0).join(": ") || "rejected by host";
        const stale = channel.resolvedApprovals.has(approvalId) || STALE_APPROVAL.test(why);
        done({ requestId, stage: stale ? "target_unavailable" : "failed", message: why });
      } else if ((frame.kind === "approvalResolved" || frame.kind === "fileEditApprovalResolved") && frame.approvalId === approvalId) {
        done({ requestId, stage: "completed" });
      }
    });
    // The decision frame was already written: a close is never a retryable `failed` (a retry would decide twice).
    const stopClose = channel.onClose(() =>
      done(
        ack === "accepted"
          ? { requestId, stage: "backend_acknowledged", message: `decision accepted; stream closed before resolution (${channel.closeError().message})` }
          : { requestId, stage: "sent", message: `stream closed before the host ack (${channel.closeError().message}); outcome uncertain, not resent` },
      ),
    );
    const frame = {
      kind: decisionKind,
      hasBinaryPayload: false,
      epicId: channel.epicId,
      chatId: channel.chatId,
      clientActionId,
      approvalId,
      decision: { approved: args.approved },
    } as ChatClientFrame;
    channel.send(frame);
  });
}
