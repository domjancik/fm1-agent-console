// Runtime validation for anything crossing the adapter boundary. Malformed input is rejected, never coerced.
import { parseBlocks } from "./markdown";
import { isCompleteRef } from "./identity";
import { isNormalizedState } from "./status";
import {
  DELIVERY_STAGES,
  MAX_SUGGESTIONS,
  SUGGESTION_MAX,
  type AgentEvent,
  type ApprovalRequest,
  type CommandResult,
  type DeliveryStage,
  type Project,
  type PromptCapability,
  type Result,
  type Session,
  type SessionDetails,
  type SessionRef,
  type SessionStatus,
  type Snapshot,
  type Task,
  type TaskRef,
} from "./types";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isNonEmpty = (v: unknown): v is string => isStr(v) && v.length > 0;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const err = <T>(error: string): Result<T> => ({ ok: false, error });

export function parseTaskRef(v: unknown): Result<TaskRef> {
  if (!isObj(v)) return err("task ref is not an object");
  const { backendId, hostId, projectId, taskId } = v;
  if (![backendId, hostId, projectId, taskId].every(isNonEmpty)) return err("task ref has empty or missing fields");
  return ok({ backendId, hostId, projectId, taskId } as TaskRef);
}

export function parseSessionRef(v: unknown): Result<SessionRef> {
  const task = parseTaskRef(v);
  if (!task.ok) return err(task.error.replace("task", "session"));
  const sessionId = (v as Obj).sessionId;
  if (!isNonEmpty(sessionId)) return err("session ref missing sessionId");
  const ref: SessionRef = { ...task.value, sessionId };
  return isCompleteRef(ref) ? ok(ref) : err("session ref incomplete");
}

function parseStatus(v: unknown): Result<SessionStatus> {
  if (!isObj(v) || !isObj(v.observed)) return err("status.observed missing");
  const { state, at, detail } = v.observed;
  if (state !== null && !isNormalizedState(state)) return err(`unknown observed state ${String(state)}`);
  if (!isNum(at)) return err("status.observed.at not a number");
  if (detail !== undefined && !isStr(detail)) return err("status.observed.detail not a string");
  const status: SessionStatus = { observed: detail === undefined ? { state, at } : { state, at, detail }, raw: v.raw };
  if (v.inferred !== undefined) {
    const inf = v.inferred;
    if (!isObj(inf) || !isNormalizedState(inf.state) || !isStr(inf.reason)) return err("status.inferred malformed");
    status.inferred = { state: inf.state, reason: inf.reason };
  }
  return ok(status);
}

export function parseSession(v: unknown): Result<Session> {
  if (!isObj(v)) return err("session is not an object");
  const ref = parseSessionRef(v.ref);
  if (!ref.ok) return err(ref.error);
  const status = parseStatus(v.status);
  if (!status.ok) return err(status.error);
  const { title, provider, runtime, workspace, summary, createdAt, lastActivityAt, details, parentKey, prompt } = v;
  if (!isStr(title)) return err("session.title not a string");
  if (provider !== "claude" && provider !== "codex" && provider !== "other") return err("session.provider invalid");
  if (runtime !== "chat" && runtime !== "terminal") return err("session.runtime invalid");
  if (!isStr(workspace)) return err("session.workspace not a string");
  if (!isNum(createdAt)) return err("session.createdAt not a number");
  if (summary !== undefined && !isStr(summary)) return err("session.summary not a string");
  if (lastActivityAt !== undefined && !(isNum(lastActivityAt) && lastActivityAt >= 0)) return err("session.lastActivityAt invalid");
  if (parentKey !== undefined && !(isStr(parentKey) && parentKey.length > 0 && parentKey.length <= 1024)) return err("session.parentKey invalid");
  const parsedDetails = details === undefined ? undefined : parseDetails(details);
  if (parsedDetails !== undefined && !parsedDetails.ok) return err(parsedDetails.error);
  const parsedPrompt = prompt === undefined ? undefined : parsePromptCapability(prompt);
  if (parsedPrompt !== undefined && !parsedPrompt.ok) return err(parsedPrompt.error);
  const session: Session = { ref: ref.value, title, provider, runtime, workspace, status: status.value, createdAt };
  if (summary !== undefined) session.summary = summary;
  if (lastActivityAt !== undefined) session.lastActivityAt = lastActivityAt;
  if (parsedDetails !== undefined) session.details = parsedDetails.value;
  if (parentKey !== undefined) session.parentKey = parentKey as string;
  if (parsedPrompt !== undefined) session.prompt = parsedPrompt.value;
  return ok(session);
}

/**
 * Session.prompt (docs/ui-v3.md section 9.7): `acceptsPrompt` boolean; `reason` any string (cut to 300); `line` and
 * `toast` device copy, folded to ASCII and cut to 28 / 20. Extra adapter fields (Traycer: `via`, `senderAgentId`) are
 * dropped.
 */
export function parsePromptCapability(v: unknown): Result<PromptCapability> {
  if (!isObj(v) || typeof v.acceptsPrompt !== "boolean") return err("session.prompt invalid");
  const { reason, line, toast } = v;
  if (!optStr(reason) || !optStr(line) || !optStr(toast)) return err("session.prompt text invalid");
  const fold = (s: string, n: number): string => s.replace(/[^\x20-\x7e]/g, " ").replace(/\s+/g, " ").trim().slice(0, n).trim();
  const out: PromptCapability = { acceptsPrompt: v.acceptsPrompt };
  if (typeof reason === "string") out.reason = reason.slice(0, 300);
  if (typeof line === "string" && fold(line, 28)) out.line = fold(line, 28);
  if (typeof toast === "string" && fold(toast, 20)) out.toast = fold(toast, 20);
  return ok(out);
}

const optStr = (v: unknown): boolean => v === undefined || isStr(v);
const optNum = (v: unknown, max = Number.MAX_SAFE_INTEGER): boolean => v === undefined || (isNum(v) && v >= 0 && v <= max);

/** Session.details: every field optional and typed; anything else is rejected. */
export function parseDetails(v: unknown): Result<SessionDetails> {
  if (!isObj(v)) return err("session.details is not an object");
  const { lastMessage, lastMessageAt, lastBlocks, activity, failure, approval, contextPct, model, turns, files, lastPrompt, reply, suggestions } = v;
  if (!optStr(lastMessage) || !optStr(activity) || !optStr(failure) || !optStr(model) || !optStr(lastPrompt)) return err("session.details text invalid");
  if (!optNum(lastMessageAt) || !optNum(contextPct, 100) || !optNum(turns)) return err("session.details number invalid");
  const out: SessionDetails = {};
  if (approval !== undefined) {
    if (!isObj(approval) || !isStr(approval.target) || !optStr(approval.summary)) return err("session.details.approval invalid");
    out.approval = approval.summary === undefined ? { target: approval.target } : { target: approval.target, summary: approval.summary as string };
  }
  if (files !== undefined) {
    if (!isObj(files) || !isNum(files.count) || files.count < 0 || !Array.isArray(files.names) || !files.names.every(isStr)) return err("session.details.files invalid");
    out.files = { count: files.count, names: [...(files.names as string[])] };
  }
  if (reply !== undefined) {
    if (!isObj(reply) || !isStr(reply.requestId) || !isStr(reply.text) || !isNum(reply.at) || reply.at < 0) return err("session.details.reply invalid");
    // PromptReply.text is <= 600: an adapter that sends more is cut here, never shown or kept whole.
    out.reply = { requestId: reply.requestId, text: reply.text.slice(0, 600), at: reply.at };
    if (reply.blocks !== undefined) {
      const blocks = parseBlocks(reply.blocks);
      if (blocks === null) return err("session.details.reply.blocks invalid");
      out.reply.blocks = blocks;
    }
  }
  if (lastBlocks !== undefined) {
    // Markdown structure (docs/ui-v3.md section 13): well-formed blocks only, text folded to ASCII.
    const blocks = parseBlocks(lastBlocks);
    if (blocks === null) return err("session.details.lastBlocks invalid");
    out.lastBlocks = blocks;
  }
  if (suggestions !== undefined) {
    if (!Array.isArray(suggestions) || !suggestions.every(isStr)) return err("session.details.suggestions invalid");
    // At most MAX_SUGGESTIONS, each cut to SUGGESTION_MAX; empty strings dropped (an empty list means none).
    const list = (suggestions as string[]).map((x) => x.slice(0, SUGGESTION_MAX)).filter((x) => x.trim() !== "").slice(0, MAX_SUGGESTIONS);
    if (list.length > 0) out.suggestions = list;
  }
  if (lastPrompt !== undefined) out.lastPrompt = lastPrompt as string;
  if (lastMessage !== undefined) out.lastMessage = lastMessage as string;
  if (lastMessageAt !== undefined) out.lastMessageAt = lastMessageAt as number;
  if (activity !== undefined) out.activity = activity as string;
  if (failure !== undefined) out.failure = failure as string;
  if (contextPct !== undefined) out.contextPct = contextPct as number;
  if (model !== undefined) out.model = model as string;
  if (turns !== undefined) out.turns = turns as number;
  return ok(out);
}

export function parseTask(v: unknown): Result<Task> {
  if (!isObj(v)) return err("task is not an object");
  const ref = parseTaskRef(v.ref);
  if (!ref.ok) return err(ref.error);
  if (!isStr(v.title) || !isNum(v.updatedAt)) return err("task.title/updatedAt invalid");
  return ok({ ref: ref.value, title: v.title, updatedAt: v.updatedAt });
}

export function parseProject(v: unknown): Result<Project> {
  if (!isObj(v)) return err("project is not an object");
  const { backendId, hostId, projectId, name } = v;
  if (![backendId, hostId, projectId].every(isNonEmpty) || !isStr(name)) return err("project fields invalid");
  return ok({ backendId, hostId, projectId, name } as Project);
}

export function parseApproval(v: unknown): Result<ApprovalRequest> {
  if (!isObj(v)) return err("approval is not an object");
  const ref = parseSessionRef(v.sessionRef);
  if (!ref.ok) return err(ref.error);
  if (!isNonEmpty(v.id) || !isStr(v.summary) || !isNum(v.createdAt)) return err("approval fields invalid");
  return ok({ id: v.id, sessionRef: ref.value, summary: v.summary, createdAt: v.createdAt });
}

const isStage = (v: unknown): v is DeliveryStage => isStr(v) && (DELIVERY_STAGES as readonly string[]).includes(v);

export function parseEvent(v: unknown): Result<AgentEvent> {
  if (!isObj(v) || !isStr(v.type)) return err("event has no type");
  switch (v.type) {
    case "session_upserted": {
      const s = parseSession(v.session);
      return s.ok ? ok({ type: v.type, session: s.value }) : err(s.error);
    }
    case "session_removed": {
      const r = parseSessionRef(v.ref);
      return r.ok ? ok({ type: v.type, ref: r.value }) : err(r.error);
    }
    case "task_upserted": {
      const t = parseTask(v.task);
      return t.ok ? ok({ type: v.type, task: t.value }) : err(t.error);
    }
    case "task_removed": {
      const r = parseTaskRef(v.ref);
      return r.ok ? ok({ type: v.type, ref: r.value }) : err(r.error);
    }
    case "approval_requested": {
      const a = parseApproval(v.approval);
      return a.ok ? ok({ type: v.type, approval: a.value }) : err(a.error);
    }
    case "approval_resolved":
      return isNonEmpty(v.approvalId) ? ok({ type: v.type, approvalId: v.approvalId }) : err("approvalId missing");
    case "command_progress": {
      if (!isNonEmpty(v.requestId) || !isStage(v.stage)) return err("command_progress malformed");
      const e: AgentEvent = { type: v.type, requestId: v.requestId, stage: v.stage };
      if (isStr(v.message)) e.message = v.message;
      return ok(e);
    }
    case "connection": {
      if (v.state !== "connected" && v.state !== "degraded" && v.state !== "disconnected") return err("connection state invalid");
      return ok(isStr(v.reason) ? { type: v.type, state: v.state, reason: v.reason } : { type: v.type, state: v.state });
    }
    default:
      return err(`unknown event type ${v.type}`);
  }
}

/** Adapter command results are untrusted too; an unrecognised one counts as a failure. */
export function checkedResult(v: unknown, requestId: string): CommandResult {
  if (!isObj(v) || !isStage(v.stage)) return { requestId, stage: "failed", message: "invalid adapter result" };
  return isStr(v.message) ? { requestId, stage: v.stage, message: v.message } : { requestId, stage: v.stage };
}

/** Validates each list from a re-enumeration, keeping valid items and reporting the rest. */
export function parseSnapshot(raw: {
  projects: unknown[];
  tasks: unknown[];
  sessions: unknown[];
  approvals: unknown[];
}): { snapshot: Snapshot; rejected: string[] } {
  const rejected: string[] = [];
  const keep = <T>(items: unknown[], parse: (v: unknown) => Result<T>, what: string): T[] =>
    (Array.isArray(items) ? items : []).flatMap((item, i) => {
      const r = parse(item);
      if (r.ok) return [r.value];
      rejected.push(`snapshot ${what}[${i}]: ${r.error}`);
      return [];
    });
  const snapshot: Snapshot = {
    projects: keep(raw.projects, parseProject, "project"),
    tasks: keep(raw.tasks, parseTask, "task"),
    sessions: keep(raw.sessions, parseSession, "session"),
    approvals: keep(raw.approvals, parseApproval, "approval"),
  };
  if (!Array.isArray(raw.sessions)) rejected.push("snapshot sessions: not an array");
  return { snapshot, rejected };
}
