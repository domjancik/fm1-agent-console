// reports/disposable-allowlist.json: the only Traycer tasks and chats a state-changing smoke step may touch.
import { readFileSync, renameSync, writeFileSync } from "node:fs";

export const SMOKE_WORKSPACE = "/Users/dominikj/dev/personal/fm1-agent-console-smoke";
export const SMOKE_PROJECT_ID = `ws:${SMOKE_WORKSPACE}`;

export interface AllowlistTask {
  epicId: string;
  chatIds: string[];
  createdAt: string;
  purpose: string;
  /** Optional: the allowlisted agent in this task that console prompts to its Claude TUI agents go out as (Traycer a2a). */
  a2aSenderId?: string;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function parseAllowlist(text: string): AllowlistTask[] {
  const v: unknown = JSON.parse(text);
  if (!isObj(v) || !Array.isArray(v.tasks)) throw new Error("allowlist: expected {tasks: [...]}");
  return v.tasks.map((t, i) => {
    if (!isObj(t) || typeof t.epicId !== "string" || !ID.test(t.epicId)) throw new Error(`allowlist: tasks[${i}].epicId invalid`);
    const chatIds = Array.isArray(t.chatIds) ? t.chatIds : [];
    if (!chatIds.every((c): c is string => typeof c === "string" && ID.test(c))) throw new Error(`allowlist: tasks[${i}].chatIds invalid`);
    const sender = t.a2aSenderId;
    if (sender !== undefined && (typeof sender !== "string" || !chatIds.includes(sender))) {
      throw new Error(`allowlist: tasks[${i}].a2aSenderId must be one of its chatIds`);
    }
    return {
      epicId: t.epicId,
      chatIds,
      createdAt: typeof t.createdAt === "string" ? t.createdAt : "",
      purpose: typeof t.purpose === "string" ? t.purpose : "",
      ...(typeof sender === "string" ? { a2aSenderId: sender } : {}),
    };
  });
}

/** In-memory view of the allowlist file. Every addition is written back atomically before it is used. */
export class Allowlist {
  private tasks: AllowlistTask[];

  constructor(
    private readonly path: string,
    tasks?: AllowlistTask[],
  ) {
    this.tasks = tasks ?? parseAllowlist(readFileSync(path, "utf8"));
  }

  static load(path: string): Allowlist {
    return new Allowlist(path);
  }

  all(): readonly AllowlistTask[] {
    return this.tasks;
  }

  /** Sender identities for the adapter's `a2aSender` option: one per task that names one. */
  a2aSenders(): { agentId: string; epicId: string }[] {
    return this.tasks.flatMap((t) => (t.a2aSenderId === undefined ? [] : [{ agentId: t.a2aSenderId, epicId: t.epicId }]));
  }

  hasTask(epicId: string): boolean {
    return this.tasks.some((t) => t.epicId === epicId);
  }

  /** A chat is allowed only when listed under its own task. */
  hasChat(epicId: string, chatId: string): boolean {
    return this.tasks.some((t) => t.epicId === epicId && t.chatIds.includes(chatId));
  }

  addTask(epicId: string, purpose: string, now = new Date()): void {
    if (!ID.test(epicId)) throw new Error(`allowlist: bad epic id ${epicId}`);
    if (this.hasTask(epicId)) return;
    this.tasks = [...this.tasks, { epicId, chatIds: [], createdAt: now.toISOString(), purpose }];
    this.save();
  }

  addChat(epicId: string, chatId: string, note: string): void {
    if (!ID.test(chatId)) throw new Error(`allowlist: bad chat id ${chatId}`);
    const task = this.tasks.find((t) => t.epicId === epicId);
    if (!task) throw new Error(`allowlist: task ${epicId} is not disposable; refusing to add chat`);
    if (task.chatIds.includes(chatId)) return;
    task.chatIds = [...task.chatIds, chatId];
    task.purpose = note ? `${task.purpose} ${note}`.trim() : task.purpose;
    this.save();
  }

  private save(): void {
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ tasks: this.tasks }, null, 2)}\n`);
    renameSync(tmp, this.path);
  }
}
