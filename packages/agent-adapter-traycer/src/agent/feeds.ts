import { hostNotificationsSubscribeServerFrameSchemaV10 } from "@traycer/protocol/host/notifications/host-notifications";
import type { NormalizedAgent } from "../normalize";
import type { ChatFrame } from "../streams";

/**
 * Pure parsers for the three host-wide feeds. Anything that does not match is
 * reported as `malformed` and dropped by the caller (counted in diagnostics);
 * a bad frame never throws into the adapter.
 */
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export type RecordEvent =
  | { readonly kind: "upsert"; readonly agent: NormalizedAgent }
  | { readonly kind: "remove"; readonly epicId: string; readonly agentId: string; readonly reason: string }
  | { readonly kind: "ignored" }
  | { readonly kind: "malformed"; readonly why: string };

/** `host.chatRecords.subscribe` frames (GUI chats and, from 1.1, TUI agents). */
export function parseChatRecordFrame(frame: ChatFrame): RecordEvent {
  switch (frame.kind) {
    case "upsert":
    case "tuiUpsert": {
      const tui = frame.kind === "tuiUpsert";
      const { epicId, record } = frame;
      const agentId = tui ? frame.tuiAgentId : frame.chatId;
      if (!str(epicId) || !str(agentId) || !isObj(record)) return { kind: "malformed", why: `${frame.kind} envelope` };
      if (typeof record.title !== "string" || typeof record.archived !== "boolean" || !num(record.createdAt) || !num(record.updatedAt)) {
        return { kind: "malformed", why: `${frame.kind} record` };
      }
      const hostId = tui ? record.hostId : record.originHostId;
      const agent: NormalizedAgent = {
        epicId,
        agentId,
        surface: tui ? "tui" : "gui",
        harnessId: tui && str(record.harnessId) ? record.harnessId : str(record.runSettingsSummary) ? record.runSettingsSummary : null,
        model: null,
        reasoningEffort: null,
        permissionMode: null,
        profileId: null,
        title: record.title,
        parentId: str(tui ? record.parentId : record.parentChatId) ? ((tui ? record.parentId : record.parentChatId) as string) : null,
        hostId: str(hostId) ? hostId : null,
        ownerUserId: str(record.ownerUserId) ? record.ownerUserId : "",
        archived: record.archived,
        sessionState: tui && str(record.sessionState) ? record.sessionState : null,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      };
      return { kind: "upsert", agent };
    }
    case "remove":
    case "tuiRemove": {
      const agentId = frame.kind === "tuiRemove" ? frame.tuiAgentId : frame.chatId;
      if (!str(frame.epicId) || !str(agentId) || !str(frame.reason)) return { kind: "malformed", why: `${frame.kind} envelope` };
      return { kind: "remove", epicId: frame.epicId, agentId, reason: frame.reason };
    }
    case "pong":
      return { kind: "ignored" };
    default:
      return typeof frame.kind === "string" ? { kind: "ignored" } : { kind: "malformed", why: "no kind" };
  }
}

/** `agent.activity.subscribe` arrives already validated by the vendored client; this re-checks shape. */
export function isActivityByEpic(v: unknown): v is Record<string, { working: string[]; turn: string[] }> {
  if (!isObj(v)) return false;
  return Object.values(v).every(
    (b) => isObj(b) && Array.isArray(b.working) && Array.isArray(b.turn) && [...b.working, ...b.turn].every((id) => typeof id === "string"),
  );
}

export type NotificationKind = "approval.requested" | "interview.requested" | "agent.stopped" | "agent.stalled" | "other";

export interface NotificationRow {
  readonly id: string;
  readonly kind: NotificationKind;
  readonly epicId: string | null;
  readonly chatId: string | null;
  readonly updatedAt: number;
  readonly readAt: number | null;
  readonly resolvedAt: number | null;
  readonly outcome: string | null;
  readonly approvalId: string | null;
  readonly interviewBlockId: string | null;
  readonly title: string;
  readonly detail: string | null;
}

export type NotificationEvent =
  | { readonly kind: "rows"; readonly rows: readonly NotificationRow[]; readonly snapshot: boolean }
  | { readonly kind: "readState"; readonly ids: readonly string[]; readonly readAt: number | null; readonly resolvedAt: number | null }
  | { readonly kind: "cleared"; readonly beforeUpdatedAt: number }
  | { readonly kind: "ignored" }
  | { readonly kind: "malformed"; readonly why: string };

const KNOWN: ReadonlySet<string> = new Set(["approval.requested", "interview.requested", "agent.stopped", "agent.stalled"]);

function toRow(entry: Obj): NotificationRow {
  const payload = isObj(entry.payload) ? entry.payload : {};
  const kind = (KNOWN.has(String(entry.kind)) ? entry.kind : "other") as NotificationKind;
  const title = [payload.taskTitle, payload.chatTitle ?? payload.agentName].filter((t) => typeof t === "string" && t.length > 0).join(" / ");
  return {
    id: String(entry.id),
    kind,
    epicId: str(entry.epicId) ? entry.epicId : null,
    chatId: str(entry.chatId) ? entry.chatId : null,
    updatedAt: num(entry.updatedAt) ? entry.updatedAt : 0,
    readAt: num(entry.readAt) ? entry.readAt : null,
    resolvedAt: num(entry.resolvedAt) ? entry.resolvedAt : null,
    outcome: typeof entry.outcome === "string" ? entry.outcome : null,
    approvalId: str(payload.approvalId) ? payload.approvalId : null,
    interviewBlockId: str(payload.interviewBlockId) ? payload.interviewBlockId : null,
    title,
    detail: typeof payload.message === "string" ? payload.message : typeof payload.reason === "string" ? payload.reason : null,
  };
}

/** `host.notifications.subscribe@1.0` frames, validated against the vendored frozen schema. */
export function parseNotificationFrame(frame: ChatFrame): NotificationEvent {
  const parsed = hostNotificationsSubscribeServerFrameSchemaV10.safeParse(frame);
  if (!parsed.success) return { kind: "malformed", why: `notification ${String(frame.kind)}` };
  const f = parsed.data;
  switch (f.kind) {
    case "snapshot":
      return { kind: "rows", rows: f.entries.map((e) => toRow(e as unknown as Obj)), snapshot: true };
    case "upserted":
      return { kind: "rows", rows: [toRow(f.entry as unknown as Obj)], snapshot: false };
    case "channelEmission":
      return { kind: "rows", rows: f.rows.map((e) => toRow(e as unknown as Obj)), snapshot: false };
    case "readStateChanged":
      return { kind: "readState", ids: f.ids, readAt: f.readAt, resolvedAt: f.resolvedAt };
    case "cleared":
      return { kind: "cleared", beforeUpdatedAt: f.beforeUpdatedAt };
    case "pong":
      return { kind: "ignored" };
  }
}
