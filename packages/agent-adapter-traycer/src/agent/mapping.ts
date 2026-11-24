import { sessionKey, type Project, type Provider, type Runtime, type Session, type SessionRef, type SessionStatus, type Task, type TaskRef } from "@fm1/agent-core";
import type { NormalizedAgent, NormalizedTask } from "../normalize";

export const BACKEND_ID = "traycer";

/**
 * Project mapping (Traycer has no project entity; a Task carries workspace and
 * repository associations):
 *
 *  1. `ws:<absolute path>` - the first workspace association owned by this
 *     host (sorted by path, so the choice is stable), else the first workspace
 *     of any host;
 *  2. `repo:<owner>/<repo>` - when the task has no workspace, its first
 *     repository association (sorted);
 *  3. `none` - neither.
 *
 * A task belongs to exactly one project; its project (and so its sessions'
 * composite identity) changes only if its workspace associations change.
 * Project `name` is the path's last segment / the repo name.
 */
export const NO_PROJECT_ID = "none";

export function projectIdOf(task: NormalizedTask, localHostId: string): string {
  const local = task.workspaceRefs.filter((w) => w.hostId === localHostId).map((w) => w.path).sort();
  const any = [...task.workspaces].sort();
  const path = local[0] ?? any[0];
  if (path !== undefined) return `ws:${path}`;
  const repo = [...task.repos].sort()[0];
  if (repo !== undefined) return `repo:${repo}`;
  return NO_PROJECT_ID;
}

export function projectName(projectId: string): string {
  if (projectId.startsWith("ws:")) {
    const parts = projectId.slice(3).split("/").filter((p) => p.length > 0);
    return parts[parts.length - 1] ?? projectId.slice(3);
  }
  if (projectId.startsWith("repo:")) return projectId.slice(5);
  return "No project";
}

/** Workspace path a CLI `task create --workspace` can use, or the repo for `--repo`. */
export function projectTarget(projectId: string): { workspace?: string; repo?: string } {
  if (projectId.startsWith("ws:")) return { workspace: projectId.slice(3) };
  if (projectId.startsWith("repo:")) return { repo: projectId.slice(5) };
  return {};
}

export function toProject(projectId: string, hostId: string): Project {
  return { backendId: BACKEND_ID, hostId, projectId, name: projectName(projectId) };
}

export function taskRefOf(task: NormalizedTask, hostId: string): TaskRef {
  return { backendId: BACKEND_ID, hostId, projectId: projectIdOf(task, hostId), taskId: task.epicId };
}

export function toTask(task: NormalizedTask, hostId: string): Task {
  return {
    ref: taskRefOf(task, hostId),
    title: task.title || "(untitled task)",
    updatedAt: task.updatedAt ?? task.createdAt ?? 0,
  };
}

export function providerOf(harnessId: string | null): Provider {
  if (harnessId === "claude") return "claude";
  if (harnessId === "codex") return "codex";
  return "other";
}

export function runtimeOf(agent: Pick<NormalizedAgent, "surface">): Runtime {
  return agent.surface === "gui" ? "chat" : "terminal";
}

/** Workspace shown for a session: the task's local workspace path, else any, else "". */
export function workspaceOf(task: NormalizedTask | undefined, hostId: string): string {
  if (task === undefined) return "";
  const local = task.workspaceRefs.find((w) => w.hostId === hostId);
  return local?.path ?? task.workspaces[0] ?? "";
}

export function sessionRefOf(taskRef: TaskRef, agentId: string): SessionRef {
  return { ...taskRef, sessionId: agentId };
}

export function toSession(
  agent: NormalizedAgent,
  taskRef: TaskRef,
  task: NormalizedTask | undefined,
  status: SessionStatus,
): Session {
  const title = agent.title.trim() || `${agent.harnessId ?? "agent"} ${runtimeOf(agent)}`;
  const session: Session = {
    ref: sessionRefOf(taskRef, agent.agentId),
    title,
    provider: providerOf(agent.harnessId),
    runtime: runtimeOf(agent),
    workspace: workspaceOf(task, taskRef.hostId),
    status,
    createdAt: agent.createdAt,
  };
  const parentKey = parentKeyOf(agent, taskRef);
  if (parentKey !== undefined) session.parentKey = parentKey;
  return session;
}

/**
 * The parent agent's session key (docs/ui-v3.md section 9.2): Traycer records it on both agent kinds, `parentChatId`
 * on chat records and `parentId` on TUI agents (the spawning agent, e.g. the a2a sender of `agent.create`), always in
 * the same epic. Any agent kind may be the parent; a self-reference is dropped.
 */
export function parentKeyOf(agent: Pick<NormalizedAgent, "agentId" | "parentId">, taskRef: TaskRef): string | undefined {
  const parent = agent.parentId?.trim();
  if (!parent || parent === agent.agentId) return undefined;
  const key = sessionKey(sessionRefOf(taskRef, parent));
  return key.length <= 1024 ? key : undefined;
}

/** Desktop deep-link ids must match the upstream patch's id rule. */
export const DEEP_LINK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
