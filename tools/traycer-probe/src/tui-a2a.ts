#!/usr/bin/env bun
/**
 * tui-a2a: live discovery of agent.sendMessage (Traycer a2a) as the FM-1 prompt path to terminal (TUI) agents.
 *
 * Read-only:  manifest | list <epicId> | transcript <epicId> <agentId>
 * Mutating (needs --live AND reports/disposable-allowlist.json):
 *   create-tui <epicId> --sender <agentId> --name <title> [--harness claude] [--model haiku]
 *   send <epicId> <receiverId> --sender <agentId|unknown> [--sender-epic <E>] [--expect-reply] [--response-id <id>] --text <t>
 *   inbox <epicId> <agentId> [--seconds 60]     (subscribes to that agent's inbox; allowlisted agents only)
 *   stop <epicId> <agentId>
 *
 * Every call writes a sanitized JSON record under reports/evidence/tui-a2a/. The bearer never leaves memory.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createStreamClient, openRawStream, TraycerAdapter } from "@fm1/agent-adapter-traycer";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const ALLOWLIST_PATH = join(REPO_ROOT, "reports", "disposable-allowlist.json");
const EVIDENCE_DIR = join(REPO_ROOT, "reports", "evidence", "tui-a2a");

for (const level of ["log", "info", "debug", "warn"] as const) console[level] = (...parts: unknown[]) => console.error(...parts);
for (const k of ["TRAYCER_AGENT_ID", "TRAYCER_EPIC_ID", "TRAYCER_TERMINAL_SPAWN_TOKEN"]) delete process.env[k];

interface AllowTask {
  epicId: string;
  chatIds: string[];
  createdAt: string;
  purpose: string;
}

function allowlist(): AllowTask[] {
  return (JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8")) as { tasks: AllowTask[] }).tasks;
}

function allowed(epicId: string, agentId: string | null): boolean {
  const task = allowlist().find((t) => t.epicId === epicId);
  return task !== undefined && (agentId === null || task.chatIds.includes(agentId));
}

function addToAllowlist(epicId: string, agentId: string, note: string): void {
  const tasks = allowlist();
  const task = tasks.find((t) => t.epicId === epicId);
  if (task === undefined) throw new Error(`refusing: epic ${epicId} is not disposable`);
  if (!task.chatIds.includes(agentId)) task.chatIds.push(agentId);
  task.purpose = `${task.purpose} ${note}`.trim();
  const tmp = `${ALLOWLIST_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ tasks }, null, 2)}\n`);
  renameSync(tmp, ALLOWLIST_PATH);
}

function evidence(name: string, data: unknown): string {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(EVIDENCE_DIR, `${stamp}-${name}.json`);
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
  return path.replace(`${REPO_ROOT}/`, "");
}

function errorOf(e: unknown): { code: string | null; message: string; method?: string } {
  if (e instanceof Error) {
    const x = e as Error & { code?: unknown; method?: unknown };
    return { code: typeof x.code === "string" ? x.code : null, message: e.message, ...(typeof x.method === "string" ? { method: x.method } : {}) };
  }
  return { code: null, message: String(e) };
}

function transcriptOf(v: unknown): string {
  const t = (v as { transcript?: unknown } | null)?.transcript;
  return typeof t === "string" ? t : "";
}

function flag(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const v = args[i + 1] ?? null;
  args.splice(i, v === null ? 1 : 2);
  return v;
}

function has(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

function out(v: unknown): void {
  process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
}

const METHODS = ["agent.sendMessage", "agent.create", "agent.getTranscript", "agent.inbox.read", "agent.inbox.ack", "agent.list", "agent.stop", "agent.archive", "epic.listTuiAgents", "terminal.list"];

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const live = has(args, "--live");
  const cmd = args.shift();
  const adapter = await TraycerAdapter.connect();
  const need = (cond: boolean, why: string): void => {
    if (!live) throw new Error("refusing: state-changing command needs --live");
    if (!cond) throw new Error(`refusing: ${why}`);
  };
  try {
    switch (cmd) {
      case "manifest": {
        const hs = await adapter.handshake(METHODS);
        const rec = { at: new Date().toISOString(), hostVersion: adapter.endpoint.version, clientKind: adapter.clientIdentity.kind, handshake: hs };
        out({ ...rec, evidence: evidence("manifest", rec) });
        return;
      }
      case "list": {
        const epicId = args[0] ?? "";
        const agents = await adapter.listAgents(epicId);
        out(agents.map((a) => ({ agentId: a.agentId, surface: a.surface, harnessId: a.harnessId, model: a.model, title: a.title, archived: a.archived, sessionState: a.sessionState, parentId: a.parentId })));
        return;
      }
      case "terminals": {
        const epicId = args[0] ?? "";
        const r = (await adapter.rpc.call("terminal.list", { scope: { kind: "epic", epicId } } as never)) as { sessions: Array<Record<string, unknown>> };
        // shellArgs carry the agent's per-session MCP bearer: never print or store them.
        out(r.sessions.map(({ shellArgs: _drop, ...rest }) => rest));
        return;
      }
      case "read-terminal": {
        // Read-only: the host writes the scrollback to a file and returns its path; we copy a tail into evidence.
        const [epicId, sessionId] = [args[0] ?? "", args[1] ?? ""];
        need(allowed(epicId, null), `epic ${epicId} is not disposable`);
        const r = (await adapter.rpc.call("terminal.readOutput", { epicId, sessionId } as never)) as { path: string };
        const text = readFileSync(r.path, "utf8");
        const tail = text.slice(-6000);
        out({ evidence: evidence(`terminal-${sessionId.slice(0, 8)}`, { at: new Date().toISOString(), epicId, sessionId, bytes: text.length, tail }), tail });
        return;
      }
      case "peek": {
        // Read-only screen peek: terminal.subscribe as a `cache` viewer (holds no size, no reap claim), never writes.
        const seconds = Number(flag(args, "--seconds") ?? 3);
        const label = flag(args, "--label") ?? "peek";
        const [epicId, agentId] = [args[0] ?? "", args[1] ?? ""];
        need(allowed(epicId, agentId), `agent ${agentId} in ${epicId} is not in the disposable allowlist`);
        const client = createStreamClient({ endpoint: adapter.endpoint, lease: await adapter.credentials.getLease(), clientIdentity: adapter.clientIdentity });
        let text = "";
        const kinds: string[] = [];
        const session = client.subscribe("terminal.subscribe", { sessionId: agentId, cols: 120, rows: 40, viewer: "cache" } as never);
        session.onServerFrame((envelope: unknown, binary?: Uint8Array | null) => {
          const v = envelope as Record<string, unknown>;
          kinds.push(String(v.kind));
          if (typeof v.scrollback === "string") text += v.scrollback;
          if (typeof v.chunk === "string") text += v.chunk;
          if (binary instanceof Uint8Array) text += new TextDecoder().decode(binary);
        });
        const stream = { close: () => session.close() };
        await Bun.sleep(seconds * 1000);
        stream.close();
        client.close("probe-done");
        // eslint-disable-next-line no-control-regex
        const plain = text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b[()][A-Z0-9]/g, "").replace(/\r/g, "");
        const lines = plain.split("\n").map((l) => l.trimEnd()).filter((l) => l.length > 0);
        const tail = lines.slice(-60).join("\n");
        out({ kinds, bytes: text.length, evidence: evidence(`peek-${label}`, { at: new Date().toISOString(), epicId, agentId, kinds, bytes: text.length, tail }), tail });
        return;
      }
      case "transcript": {
        const [epicId, agentId] = [args[0] ?? "", args[1] ?? ""];
        const started = Date.now();
        try {
          const t = await adapter.getTranscript(epicId, agentId);
          const rec = { at: new Date().toISOString(), epicId, agentId, ms: Date.now() - started, transcript: t };
          out({ evidence: evidence(`transcript-${agentId.slice(0, 8)}`, rec), transcript: t });
        } catch (e) {
          out({ error: errorOf(e) });
        }
        return;
      }
      case "create-tui": {
        const sender = flag(args, "--sender") ?? "";
        const name = flag(args, "--name") ?? "FM1 a2a receiver (disposable)";
        const harnessId = flag(args, "--harness") ?? "claude";
        const model = flag(args, "--model") ?? "haiku";
        const workspace = flag(args, "--workspace") ?? "/Users/dominikj/dev/personal/fm1-agent-console-smoke";
        const surface = (flag(args, "--surface") ?? "tui") as "tui" | "gui";
        const epicId = args[0] ?? "";
        need(allowed(epicId, sender), `sender ${sender} in ${epicId} is not in the disposable allowlist`);
        const params = {
          senderAgentId: sender,
          epicId,
          name,
          surface,
          harnessId,
          model,
          agentMode: "regular",
          reasoningEffort: harnessId === "codex" ? "low" : null,
          fastMode: null,
          workspace: { entries: [{ path: workspace, workspacePath: null }] },
          profileSelection: { kind: "ambient" },
          permissionMode: "supervised",
          routing: surface === "gui" ? "hold" : null,
        };
        const started = Date.now();
        try {
          const response = await adapter.rpc.call("agent.create", params as never);
          const agentId = (response as { agentId: string }).agentId;
          addToAllowlist(epicId, agentId, `Agent ${agentId} (${surface} ${harnessId}/${model}, '${name}') created ${new Date().toISOString()} by tools/traycer-probe tui-a2a create-tui for the TUI a2a discovery.`);
          const rec = { at: new Date().toISOString(), method: "agent.create", params, ms: Date.now() - started, response };
          out({ ...rec, evidence: evidence(`create-${surface}-${agentId.slice(0, 8)}`, rec) });
        } catch (e) {
          const rec = { at: new Date().toISOString(), method: "agent.create", params, ms: Date.now() - started, error: errorOf(e) };
          out({ ...rec, evidence: evidence("create-error", rec) });
        }
        return;
      }
      case "send": {
        const senderArg = flag(args, "--sender") ?? "";
        const senderEpic = flag(args, "--sender-epic");
        const text = flag(args, "--text") ?? "";
        const responseId = flag(args, "--response-id");
        const label = flag(args, "--label") ?? "send";
        const expectReply = has(args, "--expect-reply");
        const waitSec = Number(flag(args, "--wait") ?? 0);
        const [epicId, receiverId] = [args[0] ?? "", args[1] ?? ""];
        need(allowed(epicId, receiverId), `receiver ${receiverId} in ${epicId} is not in the disposable allowlist`);
        const sender = senderArg === "unknown" ? randomUUID() : senderArg;
        if (senderArg !== "unknown") need(allowed(senderEpic ?? epicId, sender), `sender ${sender} is not in the disposable allowlist`);
        const params = { senderAgentId: sender, epicId, receiverAgentId: receiverId, prompt: text, responseId, expectReply, workspace: null };
        const started = Date.now();
        try {
          const before = waitSec > 0 ? transcriptOf(await adapter.getTranscript(epicId, receiverId).catch(() => null)) : "";
          const sendAt = Date.now();
          const response = await adapter.rpc.call("agent.sendMessage", params as never);
          const ms = Date.now() - started;
          // Optional: poll agent.getTranscript to time delivery (our prompt shows up) and completion (an assistant reply follows it).
          let deliveredMs: number | null = null;
          let completedMs: number | null = null;
          let reply: string | null = null;
          while (waitSec > 0 && Date.now() - sendAt < waitSec * 1000 && completedMs === null) {
            await Bun.sleep(1000);
            const now = transcriptOf(await adapter.getTranscript(epicId, receiverId).catch(() => null));
            const fresh = now.startsWith(before) ? now.slice(before.length) : now;
            const at = fresh.lastIndexOf(text);
            if (at >= 0 && deliveredMs === null) deliveredMs = Date.now() - sendAt;
            const after = at >= 0 ? fresh.slice(at) : "";
            const m = /<assistant_response>\n?([\s\S]*?)<\/assistant_response>/.exec(after);
            if (m) {
              completedMs = Date.now() - sendAt;
              reply = (m[1] ?? "").trim();
            }
          }
          const rec = { at: new Date().toISOString(), label, method: "agent.sendMessage", senderKind: senderArg === "unknown" ? "unknown-random" : "allowlisted", senderEpic: senderEpic ?? epicId, params, ms, response, ...(waitSec > 0 ? { pollEveryMs: 1000, deliveredInTranscriptMs: deliveredMs, completedMs, reply } : {}) };
          out({ ...rec, evidence: evidence(`send-${label}`, rec) });
        } catch (e) {
          const rec = { at: new Date().toISOString(), label, method: "agent.sendMessage", senderKind: senderArg === "unknown" ? "unknown-random" : "allowlisted", senderEpic: senderEpic ?? epicId, params, ms: Date.now() - started, error: errorOf(e) };
          out({ ...rec, evidence: evidence(`send-${label}`, rec) });
        }
        return;
      }
      case "inbox": {
        const seconds = Number(flag(args, "--seconds") ?? 60);
        const label = flag(args, "--label") ?? "inbox";
        const [epicId, agentId] = [args[0] ?? "", args[1] ?? ""];
        need(allowed(epicId, agentId), `agent ${agentId} in ${epicId} is not in the disposable allowlist`);
        const client = createStreamClient({ endpoint: adapter.endpoint, lease: await adapter.credentials.getLease(), clientIdentity: adapter.clientIdentity });
        const frames: unknown[] = [];
        const connection: unknown[] = [];
        const started = Date.now();
        const stream = openRawStream(
          client,
          "agent.inbox.subscribe",
          { agentId, epicId },
          (f) => {
            frames.push({ t: Date.now() - started, frame: f });
            console.error(JSON.stringify({ t: Date.now() - started, kind: f.kind }));
          },
          (ev) => connection.push({ t: Date.now() - started, status: ev.status, reason: ev.reason, retryCause: ev.retryCause }),
        );
        await Bun.sleep(seconds * 1000);
        stream.close();
        client.close("probe-done");
        const rec = { at: new Date().toISOString(), label, method: "agent.inbox.subscribe", epicId, agentId, seconds, connection, frames };
        out({ ...rec, evidence: evidence(`inbox-${label}`, rec) });
        return;
      }
      case "archive": {
        // Self-archive (senderAgentId = the agent itself) on an allowlisted agent only.
        const [epicId, agentId] = [args[0] ?? "", args[1] ?? ""];
        need(allowed(epicId, agentId), `agent ${agentId} in ${epicId} is not in the disposable allowlist`);
        try {
          const response = await adapter.rpc.call("agent.archive", { epicId, agentId, senderAgentId: agentId } as never);
          out({ response, evidence: evidence(`archive-${agentId.slice(0, 8)}`, { at: new Date().toISOString(), epicId, agentId, response }) });
        } catch (e) {
          out({ error: errorOf(e), evidence: evidence(`archive-${agentId.slice(0, 8)}-error`, { at: new Date().toISOString(), epicId, agentId, error: errorOf(e) }) });
        }
        return;
      }
      case "stop": {
        const [epicId, agentId] = [args[0] ?? "", args[1] ?? ""];
        need(allowed(epicId, agentId), `agent ${agentId} in ${epicId} is not in the disposable allowlist`);
        try {
          const response = await adapter.stop(epicId, agentId);
          out({ response, evidence: evidence(`stop-${agentId.slice(0, 8)}`, { at: new Date().toISOString(), epicId, agentId, response }) });
        } catch (e) {
          out({ error: errorOf(e) });
        }
        return;
      }
      default:
        throw new Error("usage: tui-a2a manifest | list <E> | transcript <E> <A> | create-tui <E> --sender <A> --live | send <E> <R> --sender <A|unknown> --text <t> --live | inbox <E> <A> --live | stop <E> <A> --live");
    }
  } finally {
    adapter.close();
  }
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  },
);
