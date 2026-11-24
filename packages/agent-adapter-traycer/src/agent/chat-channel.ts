import type { HostStreamRpcRegistry } from "@traycer/protocol/host/registry";
import type { WsStreamClient } from "@traycer-clients/shared/host-transport/ws-stream-client";
import { subscribeChat, type ChatClientFrame, type ChatFrame, type ChatSubscription, type ConnectionEvent } from "../streams";
import { ChatDetails, SUGGESTED_PROMPT_MINOR } from "./chat-details";

/**
 * One `chat.subscribe` for one GUI chat, shared by everything that needs it
 * (the selected-session watch, an in-flight prompt, an approval decision).
 * Reference-counted: the subscription closes when the last user releases it.
 *
 * Tracks the bits of chat state the adapter reads synchronously: run status,
 * the active turn, and pending approvals/interviews (seeded by the snapshot,
 * maintained by the request/resolve frames).
 */
/**
 * `command`: `approvalRequested` / `approvalDecision` (tool and shell calls).
 * `fileEdit`: `fileEditApprovalRequested` / `fileEditApprovalDecision` (host 1.5.4 uses this
 * separate card for file writes; observed live in T7).
 */
export type ApprovalKind = "command" | "fileEdit";

export interface PendingApproval {
  readonly approvalId: string;
  readonly kind: ApprovalKind;
  readonly toolName: string;
  readonly description: string;
  readonly paths: readonly string[];
  readonly requestedAt: number;
}

export interface ActiveTurn {
  readonly turnId: string;
  readonly status: string;
  readonly userMessageId: string | null;
}

export type ChannelClose =
  | { readonly kind: "caller" }
  | { readonly kind: "fatal"; readonly code: string; readonly reason: string; readonly methods: readonly string[] };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function toApproval(v: unknown, kind: ApprovalKind): PendingApproval | null {
  if (!isObj(v) || typeof v.approvalId !== "string") return null;
  return {
    approvalId: v.approvalId,
    kind,
    toolName: typeof v.toolName === "string" ? v.toolName : "tool",
    description: typeof v.description === "string" ? v.description : "",
    paths: Array.isArray(v.paths) ? v.paths.filter((p): p is string => typeof p === "string") : [],
    requestedAt: typeof v.requestedAt === "number" ? v.requestedAt : 0,
  };
}

export function toActiveTurn(v: unknown): ActiveTurn | null {
  if (!isObj(v) || typeof v.turnId !== "string" || typeof v.status !== "string") return null;
  return { turnId: v.turnId, status: v.status, userMessageId: typeof v.userMessageId === "string" ? v.userMessageId : null };
}

export class ChatChannel {
  readonly pendingApprovals = new Map<string, PendingApproval>();
  readonly resolvedApprovals = new Set<string>();
  readonly pendingInterviews = new Set<string>();
  /** Last message, activity, usage and the rest of docs/ux-v2.md section 7.1, derived from the frames below. */
  readonly details: ChatDetails;
  runStatus: string | null = null;
  activeTurn: ActiveTurn | null = null;
  closeReason: ChannelClose | null = null;
  private refs = 0;
  private snapshotSeen = false;
  private readonly frameListeners = new Set<(frame: ChatFrame) => void>();
  private readonly closeListeners = new Set<() => void>();
  private readonly readyWaiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  private readonly subscription: ChatSubscription;

  constructor(
    private readonly client: WsStreamClient<HostStreamRpcRegistry>,
    readonly epicId: string,
    readonly chatId: string,
    private readonly onChange: (channel: ChatChannel, frame: ChatFrame | null) => void,
    private readonly onConnection: (channel: ChatChannel, event: ConnectionEvent) => void,
    private readonly now: () => number = Date.now,
  ) {
    // suggestedPrompt is on chat.subscribe >= 1.20 (the vendored client offers up to its newest minor and the host
    // picks the highest both know); unknown (null, e.g. a test transport) counts as carried, since the key is optional.
    this.details = new ChatDetails({ suggestions: () => this.chatMinor() === null || (this.chatMinor() ?? 0) >= SUGGESTED_PROMPT_MINOR });
    this.subscription = subscribeChat(
      client,
      epicId,
      chatId,
      (frame) => this.consume(frame),
      (event) => this.connection(event),
    );
  }

  /** The negotiated `chat.subscribe` version, `major.minor`, or null before the handshake (or without one). */
  chatVersion(): string | null {
    const v = this.negotiated();
    return v === null ? null : `${v.major}.${v.minor}`;
  }

  private chatMinor(): number | null {
    const v = this.negotiated();
    return v === null ? null : v.major === 1 ? v.minor : 0;
  }

  private negotiated(): { major: number; minor: number } | null {
    try {
      return this.client.getMethodSchemaVersion("chat.subscribe") ?? null;
    } catch {
      return null;
    }
  }

  get ready(): boolean {
    return this.snapshotSeen;
  }

  get closed(): boolean {
    return this.closeReason !== null;
  }

  retain(): () => void {
    this.refs += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.refs -= 1;
      if (this.refs <= 0) this.close();
    };
  }

  /** Resolves on the first snapshot; rejects if the subscription closes first or the timeout passes. */
  waitReady(timeoutMs: number): Promise<void> {
    if (this.snapshotSeen) return Promise.resolve();
    if (this.closeReason !== null) return Promise.reject(this.closeError());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.readyWaiters.indexOf(waiter);
        if (index >= 0) this.readyWaiters.splice(index, 1);
        reject(new Error(`chat ${this.chatId}: no snapshot within ${timeoutMs}ms`));
      }, timeoutMs);
      const waiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      this.readyWaiters.push(waiter);
    });
  }

  onFrame(listener: (frame: ChatFrame) => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  /** Called once when the subscription closes (caller or fatal). */
  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  send(frame: ChatClientFrame): void {
    this.subscription.client.sendAction(frame);
  }

  close(): void {
    if (this.closeReason === null) this.closeReason = { kind: "caller" };
    this.details.closed();
    this.subscription.close();
    this.failWaiters();
  }

  closeError(): Error {
    const reason = this.closeReason;
    if (reason === null || reason.kind === "caller") return new Error(`chat ${this.chatId}: subscription closed`);
    return new Error(`chat ${this.chatId}: ${reason.code} ${reason.reason}`);
  }

  private consume(frame: ChatFrame): void {
    this.details.consume(frame, this.now());
    switch (frame.kind) {
      case "snapshot": {
        const snap = isObj(frame.snapshot) ? frame.snapshot : {};
        this.runStatus = typeof snap.runStatus === "string" ? snap.runStatus : this.runStatus;
        this.activeTurn = toActiveTurn(snap.activeTurn);
        this.pendingApprovals.clear();
        const lists: [unknown, ApprovalKind][] = [
          [snap.pendingApprovals, "command"],
          [snap.pendingFileEditApprovals, "fileEdit"],
        ];
        for (const [list, kind] of lists) {
          for (const a of Array.isArray(list) ? list : []) {
            const approval = toApproval(a, kind);
            if (approval !== null) this.pendingApprovals.set(approval.approvalId, approval);
          }
        }
        this.pendingInterviews.clear();
        for (const i of Array.isArray(snap.pendingInterviews) ? snap.pendingInterviews : []) {
          const id = isObj(i) ? (i.blockId ?? i.interviewBlockId) : undefined;
          if (typeof id === "string") this.pendingInterviews.add(id);
        }
        if (!this.snapshotSeen) {
          this.snapshotSeen = true;
          for (const w of this.readyWaiters.splice(0)) w.resolve();
        }
        break;
      }
      case "turnStateChanged":
        if (typeof frame.runStatus === "string") this.runStatus = frame.runStatus;
        this.activeTurn = toActiveTurn(frame.activeTurn);
        break;
      case "approvalRequested":
      case "fileEditApprovalRequested": {
        const approval = toApproval(frame.approval, frame.kind === "approvalRequested" ? "command" : "fileEdit");
        if (approval !== null && !this.resolvedApprovals.has(approval.approvalId)) {
          this.pendingApprovals.set(approval.approvalId, approval);
        }
        break;
      }
      case "approvalResolved":
      case "fileEditApprovalResolved":
        if (typeof frame.approvalId === "string") {
          this.pendingApprovals.delete(frame.approvalId);
          this.resolvedApprovals.add(frame.approvalId);
        }
        break;
      case "interviewRequested": {
        const id = isObj(frame.interview) ? frame.interview.blockId : frame.blockId;
        if (typeof id === "string") this.pendingInterviews.add(id);
        break;
      }
      case "interviewAnswered":
      case "interviewErrored":
        if (typeof frame.blockId === "string") this.pendingInterviews.delete(frame.blockId);
        break;
      default:
        break;
    }
    for (const listener of [...this.frameListeners]) listener(frame);
    this.onChange(this, frame);
  }

  private connection(event: ConnectionEvent): void {
    if (event.status === "closed" && event.reason?.kind === "fatalError" && this.closeReason === null) {
      const details = event.reason.details;
      this.closeReason = {
        kind: "fatal",
        code: details.code,
        reason: details.reason,
        methods: (details.incompatibleMethods ?? []).map((m) => m.method),
      };
      this.details.closed();
      this.failWaiters();
      this.onChange(this, null);
    }
    this.onConnection(this, event);
  }

  private failWaiters(): void {
    const error = this.closeError();
    for (const w of this.readyWaiters.splice(0)) w.reject(error);
    for (const l of [...this.closeListeners]) l();
    this.closeListeners.clear();
  }
}
