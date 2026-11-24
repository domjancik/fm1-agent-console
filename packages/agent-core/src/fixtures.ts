// Fixture files (fixtures/sessions/*.json) -> validated Snapshot. Compact on disk, full objects in memory.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseApproval, parseProject, parseSession, parseTask } from "./validate";
import type { Result, Snapshot } from "./types";

export interface FixtureFile {
  name: string;
  backendId: string;
  hostId: string;
  connected?: boolean;
  projects: { projectId: string; name: string }[];
  tasks: { projectId: string; taskId: string; title: string; updatedAt: number }[];
  sessions: {
    projectId: string;
    taskId: string;
    sessionId: string;
    title: string;
    provider: string;
    runtime: string;
    workspace: string;
    createdAt: number;
    summary?: string;
    /** Session.details (docs/ux-v2.md section 7.1), passed through. */
    details?: unknown;
    observed: { state: string | null; at: number; detail?: string };
    inferred?: { state: string; reason: string };
    raw?: unknown;
  }[];
  approvals: { id: string; projectId: string; taskId: string; sessionId: string; summary: string; createdAt: number }[];
}

export interface LoadedFixture {
  name: string;
  backendId: string;
  hostId: string;
  connected: boolean;
  snapshot: Snapshot;
}

function collect<T>(items: unknown[], parse: (v: unknown) => Result<T>, what: string): T[] {
  return items.map((raw, i) => {
    const r = parse(raw);
    if (!r.ok) throw new Error(`fixture ${what}[${i}]: ${r.error}`);
    return r.value;
  });
}

export function fixtureToSnapshot(f: FixtureFile): LoadedFixture {
  const base = { backendId: f.backendId, hostId: f.hostId };
  const projects = collect(f.projects.map((p) => ({ ...base, ...p })), parseProject, "projects");
  const tasks = collect(
    f.tasks.map((t) => ({ ref: { ...base, projectId: t.projectId, taskId: t.taskId }, title: t.title, updatedAt: t.updatedAt })),
    parseTask,
    "tasks",
  );
  const sessions = collect(
    f.sessions.map(({ projectId, taskId, sessionId, observed, inferred, raw, ...rest }) => ({
      ...rest,
      ref: { ...base, projectId, taskId, sessionId },
      status: { observed, inferred, raw: raw ?? null },
    })),
    parseSession,
    "sessions",
  );
  const approvals = collect(
    f.approvals.map(({ projectId, taskId, sessionId, ...rest }) => ({ ...rest, sessionRef: { ...base, projectId, taskId, sessionId } })),
    parseApproval,
    "approvals",
  );
  return { name: f.name, ...base, connected: f.connected ?? true, snapshot: { projects, tasks, sessions, approvals } };
}

export function loadFixture(path: string): LoadedFixture {
  return fixtureToSnapshot(JSON.parse(readFileSync(path, "utf8")) as FixtureFile);
}

/** Absolute path of a bundled fixture by name (without extension). */
export function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../../../fixtures/sessions/${name}.json`, import.meta.url));
}
