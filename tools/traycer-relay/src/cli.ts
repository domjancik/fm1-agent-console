#!/usr/bin/env bun
/**
 * traycer-relay: send a message to any Traycer session as the user, on an explicit operator request.
 *
 * The same delivery the FM-1 console uses (TraycerAgentAdapter.sendPrompt):
 *   - GUI chat:          a user turn over `chat.subscribe` `send`, with the chat's stored run settings.
 *   - Claude/Codex TUI:  typed into the agent's Traycer terminal (bracketed paste + Enter, only at an idle prompt),
 *                        confirmed from the transcript. A Claude terminal falls back to Traycer a2a (self-send) when
 *                        nothing could be typed. Text that was typed is never re-routed (no double delivery).
 *
 *   sessions [--query <text>] [--task <epicId>] [--scan <n>] [--json]
 *   send <epicId> <sessionId> (--text <s> | --file <path> | --stdin) [--yes] [--wait] [--timeout <sec>] [--route type|a2a]
 *   reply <epicId> <agentId> [--chars <n>]
 *
 * `send` without --yes only previews the resolved target and exits 3: nothing is sent. Never prints the bearer.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { TraycerAdapter, TraycerAgentAdapter, redactSecrets } from "@fm1/agent-adapter-traycer";
import type { AgentEvent, CommandResult, Session } from "@fm1/agent-core";

const EXIT_PREVIEW = 3;
const EXIT_FAILED = 1;
const EXIT_USAGE = 2;
const DONE = new Set(["completed", "failed", "unsupported", "target_unavailable"]);

// Vendored transport code logs through console.*; keep stdout for this tool's output.
for (const level of ["log", "info", "debug", "warn"] as const) console[level] = (...parts: unknown[]) => console.error(...parts);
const out = (text: string): void => {
  process.stdout.write(`${text}\n`);
};

const USAGE = `usage: traycer-relay <command>
  sessions [--query <text>] [--task <epicId>] [--scan <n>] [--json]
  send <epicId> <sessionId> (--text <s> | --file <path> | --stdin) [--yes] [--wait] [--timeout <sec>] [--route type|a2a]
  reply <epicId> <agentId> [--chars <n>]
send without --yes previews the target and exits ${EXIT_PREVIEW}; nothing is sent.`;

interface Row {
  readonly taskId: string;
  readonly task: string;
  readonly sessionId: string;
  readonly title: string;
  readonly provider: string;
  readonly runtime: string;
  readonly state: string;
  readonly workspace: string;
  readonly lastActivityAt: number | null;
  readonly route: string;
}

function rowOf(adapter: TraycerAgentAdapter, s: Session, taskTitles: Map<string, string>): Row {
  const cap = adapter.promptCapability(s.ref);
  const route = cap === null ? "unknown" : cap.acceptsPrompt ? [cap.via, cap.fallbackVia].filter(Boolean).join(" -> ") : `none (${cap.reason ?? "no route"})`;
  return {
    taskId: s.ref.taskId,
    task: taskTitles.get(s.ref.taskId) ?? "",
    sessionId: s.ref.sessionId,
    title: s.title,
    provider: s.provider,
    runtime: s.runtime,
    state: s.status.observed.state ?? "unknown",
    workspace: s.workspace,
    lastActivityAt: s.lastActivityAt ?? null,
    route,
  };
}

function matches(row: Row, query: string): boolean {
  const q = query.toLowerCase();
  return [row.task, row.title, row.workspace, row.taskId, row.sessionId].some((v) => v.toLowerCase().includes(q));
}

async function loadRows(adapter: TraycerAgentAdapter, taskId?: string): Promise<Row[]> {
  const tasks = await adapter.listTasks();
  const titles = new Map(tasks.map((t) => [t.ref.taskId, t.title]));
  const sessions = await adapter.listSessions(taskId);
  return sessions
    .map((s) => rowOf(adapter, s, titles))
    .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
}

async function readText(f: { text?: string; file?: string; stdin?: boolean }): Promise<string> {
  const given = [f.text !== undefined, f.file !== undefined, f.stdin === true].filter(Boolean).length;
  if (given !== 1) throw new Error("send needs exactly one of --text, --file, --stdin");
  if (f.text !== undefined) return f.text;
  if (f.file !== undefined) return readFile(f.file, "utf8");
  return new Response(Bun.stdin.stream()).text();
}

/** Sends once and, with `wait`, follows progress events until the turn ends or the timeout passes. */
async function send(adapter: TraycerAgentAdapter, session: Session, text: string, wait: boolean, timeoutMs: number): Promise<CommandResult> {
  const requestId = randomUUID();
  let last: CommandResult | null = null;
  let finish: (r: CommandResult) => void = () => undefined;
  const ended = new Promise<CommandResult>((resolve) => {
    finish = resolve;
  });
  const stop = adapter.subscribe((event: AgentEvent) => {
    if (event.type !== "command_progress" || event.requestId !== requestId) return;
    out(`progress: ${event.stage}${event.message ? ` (${event.message})` : ""}`);
    last = { requestId, stage: event.stage, ...(event.message ? { message: event.message } : {}) };
    if (DONE.has(event.stage)) finish(last);
  });
  try {
    const result = await adapter.sendPrompt(session.ref, text, requestId);
    out(`result: ${result.stage}${result.message ? ` (${result.message})` : ""}`);
    if (!wait || DONE.has(result.stage)) return result;
    const timer = new Promise<CommandResult>((resolve) =>
      setTimeout(() => resolve(last ?? result), timeoutMs),
    );
    const final = await Promise.race([ended, timer]);
    if (!DONE.has(final.stage)) out(`wait: no turn end within ${Math.round(timeoutMs / 1000)}s (last stage ${final.stage})`);
    return final;
  } finally {
    stop();
  }
}

function lastAnswer(transcript: string): string | null {
  const re = /<assistant_response\b[^>]*>([\s\S]*?)<\/assistant_response>/g;
  let found: string | null = null;
  for (let m = re.exec(transcript); m !== null; m = re.exec(transcript)) found = m[1] ?? null;
  return found === null ? null : found.replace(/^\s*\[assistant row[^\]]*\]\s*/, "").trim();
}

async function main(argv: string[]): Promise<number> {
  const { values: f, positionals: pos } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      query: { type: "string" },
      task: { type: "string" },
      scan: { type: "string" },
      json: { type: "boolean" },
      text: { type: "string" },
      file: { type: "string" },
      stdin: { type: "boolean" },
      yes: { type: "boolean" },
      wait: { type: "boolean" },
      timeout: { type: "string" },
      route: { type: "string" },
      chars: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, epicId, sessionId] = pos;
  if (f.help || cmd === undefined) {
    out(USAGE);
    return cmd === undefined ? EXIT_USAGE : 0;
  }

  if (cmd === "reply") {
    if (!epicId || !sessionId) throw new Error("reply needs <epicId> <agentId>");
    const low = await TraycerAdapter.connect();
    const r = (await low.rpc.call("agent.getTranscript", { epicId, agentId: sessionId })) as { transcript?: unknown };
    const answer = typeof r.transcript === "string" ? lastAnswer(r.transcript) : null;
    if (answer === null) {
      out("(no assistant answer in the transcript)");
      return EXIT_FAILED;
    }
    const cap = Number(f.chars ?? 4000);
    const text = redactSecrets(answer);
    out(text.length > cap ? `${text.slice(-cap)}\n(trimmed to the last ${cap} chars)` : text);
    return 0;
  }

  if (cmd !== "sessions" && cmd !== "send") throw new Error(`unknown command "${cmd}"`);
  if (f.route !== undefined && f.route !== "type" && f.route !== "a2a") throw new Error("--route must be type or a2a");
  const adapter = new TraycerAgentAdapter({
    a2aSelfSend: true,
    tuiRoute: (f.route as "type" | "a2a" | undefined) ?? "type",
    sessionScanLimit: Number(f.scan ?? 40),
  });
  await adapter.connect();
  try {
    if (cmd === "sessions") {
      let rows = await loadRows(adapter, f.task);
      if (f.query) rows = rows.filter((r) => matches(r, f.query as string));
      if (f.json) {
        out(JSON.stringify(rows, null, 2));
      } else {
        for (const r of rows) {
          const when = r.lastActivityAt === null ? "-" : new Date(r.lastActivityAt).toISOString().slice(0, 16).replace("T", " ");
          out(`${r.taskId} ${r.sessionId}  [${r.provider}/${r.runtime} ${r.state}] ${when}\n    task: ${r.task}\n    session: ${r.title}\n    route: ${r.route}`);
        }
        out(`${rows.length} session(s)`);
      }
      return 0;
    }

    if (!epicId || !sessionId) throw new Error("send needs <epicId> <sessionId>");
    const self = process.env.TRAYCER_AGENT_ID;
    if (self !== undefined && self === sessionId) throw new Error("refusing: the target is the calling agent itself");
    const text = (await readText(f)).trim();
    if (text.length === 0) throw new Error("empty message");
    const rows = await adapter.listSessions(epicId);
    const session = rows.find((s) => s.ref.sessionId === sessionId);
    if (session === undefined) throw new Error(`session ${sessionId} not found in task ${epicId}`);
    const tasks = await adapter.listTasks();
    const row = rowOf(adapter, session, new Map(tasks.map((t) => [t.ref.taskId, t.title])));
    out(`target: ${row.task} / ${row.title}\n  ids: ${row.taskId} ${row.sessionId}\n  kind: ${row.provider}/${row.runtime}, state ${row.state}\n  route: ${row.route}\n  message: ${text.length} chars`);
    if (!f.yes) {
      out("preview only: nothing sent (add --yes to send)");
      return EXIT_PREVIEW;
    }
    const result = await send(adapter, session, text, f.wait === true, Number(f.timeout ?? 600) * 1000);
    return result.stage === "failed" || result.stage === "unsupported" || result.stage === "target_unavailable" ? EXIT_FAILED : 0;
  } finally {
    await adapter.disconnect();
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stderr.write(`traycer-relay: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(EXIT_USAGE);
    },
  );
}
