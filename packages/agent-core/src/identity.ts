import type { ProjectRef, SessionRef, TaskRef } from "./types";

const SESSION_FIELDS = ["backendId", "hostId", "projectId", "taskId", "sessionId"] as const;

// Components are percent-encoded so a "/" inside an id cannot forge another key.
const enc = (part: string): string => encodeURIComponent(part);

export function sessionKey(ref: SessionRef): string {
  return SESSION_FIELDS.map((f) => enc(ref[f])).join("/");
}

export function taskKey(ref: TaskRef): string {
  return [ref.backendId, ref.hostId, ref.projectId, ref.taskId].map(enc).join("/");
}

export function projectKey(ref: ProjectRef): string {
  return [ref.backendId, ref.hostId, ref.projectId].map(enc).join("/");
}

export function parseSessionKey(key: string): SessionRef | null {
  const parts = key.split("/");
  if (parts.length !== SESSION_FIELDS.length) return null;
  try {
    const [backendId, hostId, projectId, taskId, sessionId] = parts.map(decodeURIComponent) as [
      string, string, string, string, string,
    ];
    const ref = { backendId, hostId, projectId, taskId, sessionId };
    return isCompleteRef(ref) ? ref : null;
  } catch {
    return null;
  }
}

export function isCompleteRef(ref: SessionRef): boolean {
  return SESSION_FIELDS.every((f) => ref[f].length > 0);
}

export function sameSession(a: SessionRef, b: SessionRef): boolean {
  return sessionKey(a) === sessionKey(b);
}

export function taskOf(ref: SessionRef): TaskRef {
  return { backendId: ref.backendId, hostId: ref.hostId, projectId: ref.projectId, taskId: ref.taskId };
}

export function projectOf(ref: TaskRef): ProjectRef {
  return { backendId: ref.backendId, hostId: ref.hostId, projectId: ref.projectId };
}

/** A pin or layout key that names a task (4 components) rather than a session (5). */
export const isTaskKey = (key: string): boolean => key.split("/").length === 4;
export const isSessionKey = (key: string): boolean => key.split("/").length === 5;
