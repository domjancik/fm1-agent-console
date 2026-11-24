#!/usr/bin/env bun
// Live smoke of the TUI typing route (console prompts typed into a terminal agent's Traycer terminal, operator decision
// 2026-11-19). Every command refuses agents outside reports/disposable-allowlist.json; state-changing ones also need --live.
//
//   peek    <agentId>                      read-only: attach as a `cache` viewer, render the screen, classify it
//   watch   <agentId> [--seconds 20]       read-only: screen state every 250 ms (states and timings only)
//   type    <agentId> --text T [--live]    the library route (deliverTyped): guards, bracketed paste, Enter, transcript confirm
//   raw     <agentId> --text T [--live] [--no-enter] [--force]   low-level write for experiments (--force skips the idle guard)
//   adapter <agentId> --text T [--live]    the full TraycerAgentAdapter.sendPrompt route behind the smoke guard (type, a2a fallback)
//
// Options: --label L (evidence label), --print-screen (print rendered screen lines of the disposable agent to stderr).
// Evidence: reports/evidence/tui-typing/smoke-<date>.json (appended; timings, screen states, marker presence; no tokens).
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  classifyTuiScreen,
  createStreamClient,
  deliverTyped,
  openTerminalStream,
  redactSecrets,
  TerminalScreen,
  TraycerAdapter,
  TraycerAgentAdapter,
  TYPING_DEFAULTS,
  typeableText,
  userMessages,
  type TerminalInfo,
  type TypingHarness,
  type TypingTraceEvent,
} from "@fm1/agent-adapter-traycer";
import type { AgentEvent, SessionRef } from "@fm1/agent-core";
import { Allowlist } from "./allowlist";
import { REPO_ROOT, STRIPPED } from "./context";
import { GuardedAdapter } from "./guard";

for (const l of ["log", "info", "debug", "warn"] as const) console[l] = (...p: unknown[]) => console.error(...p);
const say = (s: string): void => {
  process.stdout.write(`${s}\n`);
};

export const EVIDENCE_DIR = join(REPO_ROOT, "reports", "evidence", "tui-typing");

/** The allowlisted task holding this agent, or a refusal. */
export function allowedTask(allowlist: Allowlist, agentId: string): { epicId: string } | { refused: string } {
  const task = allowlist.all().find((t) => t.chatIds.includes(agentId));
  if (task === undefined) return { refused: `agent ${agentId} is not in the disposable allowlist; refusing` };
  return { epicId: task.epicId };
}

function appendEvidence(entry: Record<string, unknown>): string {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const path = join(EVIDENCE_DIR, `smoke-${new Date().toISOString().slice(0, 10)}.json`);
  const prior = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as { runs: unknown[] }) : { runs: [] };
  prior.runs.push(entry);
  writeFileSync(path, `${JSON.stringify(prior, null, 2)}\n`);
  return path.replace(`${REPO_ROOT}/`, "");
}

async function terminalInfo(helper: TraycerAdapter, epicId: string, agentId: string): Promise<TerminalInfo | null> {
  const r = (await helper.rpc.call("terminal.list", { scope: { kind: "epic", epicId } } as never)) as { sessions: Array<Record<string, unknown>> };
  const row = r.sessions.find((s) => s.sessionId === agentId && s.sessionKind === "terminal-agent");
  if (row === undefined) return null;
  return { sessionId: String(row.sessionId), cols: Number(row.cols), rows: Number(row.rows), status: String(row.status), sessionKind: String(row.sessionKind) };
}

async function transcript(helper: TraycerAdapter, epicId: string, agentId: string): Promise<string | null> {
  const r = (await helper.rpc.call("agent.getTranscript", { epicId, agentId } as never)) as { transcript?: unknown };
  return typeof r.transcript === "string" ? r.transcript : null;
}

interface Peeked {
  screen: TerminalScreen;
  version: string | null;
  frames: string[];
}

/** Attach as a cache viewer for `ms`, apply every frame, then close. Optionally sample the state while attached. */
async function attach(helper: TraycerAdapter, info: TerminalInfo, ms: number, sample?: (screen: TerminalScreen, t: number) => void, sampleEvery = 250): Promise<Peeked> {
  const client = createStreamClient({ endpoint: helper.endpoint, lease: await helper.credentials.getLease(), clientIdentity: helper.clientIdentity });
  const screen = new TerminalScreen(info.cols, info.rows);
  const frames: string[] = [];
  const handle = openTerminalStream(client, info.sessionId, { cols: info.cols, rows: info.rows }, {
    onFrame: (env, bin) => {
      frames.push(String(env.kind));
      if (env.kind === "snapshot" || env.kind === "binarySnapshot") {
        const s = env.session as { cols: number; rows: number };
        screen.reset();
        screen.resize(s.cols, s.rows);
      }
      if (typeof env.scrollback === "string") screen.write(env.scrollback);
      if (typeof env.chunk === "string") screen.write(env.chunk);
      if (bin) screen.write(bin);
    },
    onClosed: (why) => frames.push(`closed:${why}`),
  });
  const start = Date.now();
  while (Date.now() - start < ms) {
    await Bun.sleep(Math.min(sampleEvery, ms));
    sample?.(screen, Date.now() - start);
  }
  const v = handle.negotiated();
  handle.close();
  client.close("tui-typing-smoke");
  return { screen, version: v === null ? null : `${v.major}.${v.minor}`, frames };
}

/** How many a2a `<task-notification>` user messages carry the marker (a typed prompt must add none). */
export function notificationHits(transcript: string, marker: string): number {
  let n = 0;
  for (const m of transcript.matchAll(/<user_message>([\s\S]*?)<\/user_message>/g)) {
    const body = m[1] ?? "";
    if (/<task-notification>|\[traycer:agent-message\]/.test(body) && body.includes(marker)) n++;
  }
  return n;
}

function printScreen(screen: TerminalScreen): void {
  screen.lines().forEach((l, i) => process.stderr.write(`${String(i).padStart(2)}|${redactSecrets(l)}\n`));
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      live: { type: "boolean", default: false },
      text: { type: "string" },
      label: { type: "string" },
      seconds: { type: "string" },
      harness: { type: "string" },
      "no-enter": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      "print-screen": { type: "boolean", default: false },
      "confirm-ms": { type: "string" },
      "turn-ms": { type: "string" },
    },
  });
  const [cmd, agentId] = [positionals[0] ?? "", positionals[1] ?? ""];
  if (!["peek", "watch", "type", "raw", "adapter"].includes(cmd) || agentId === "") {
    say("usage: tui-typing.ts peek|watch|type|raw|adapter <agentId> [--text T] [--live]");
    return 2;
  }
  for (const k of STRIPPED) delete process.env[k];
  const allowlist = Allowlist.load(join(REPO_ROOT, "reports", "disposable-allowlist.json"));
  const allowed = allowedTask(allowlist, agentId);
  if ("refused" in allowed) {
    say(allowed.refused);
    return 3;
  }
  const { epicId } = allowed;
  const mutating = cmd === "type" || cmd === "raw" || cmd === "adapter";
  if (mutating && !values.live) {
    say(`refusing: ${cmd} writes to the terminal and needs --live`);
    return 3;
  }
  if (mutating && (values.text ?? "").length === 0) {
    say("--text is required");
    return 2;
  }
  const label = values.label ?? cmd;
  const helper = await TraycerAdapter.connect();
  try {
    const agents = await helper.listAgents(epicId);
    const agent = agents.find((a) => a.agentId === agentId);
    if (agent === undefined || agent.surface !== "tui") {
      say(`agent ${agentId} is not a terminal agent in ${epicId}`);
      return 2;
    }
    const harness = (values.harness ?? agent.harnessId ?? "claude") as TypingHarness;
    const info = await terminalInfo(helper, epicId, agentId);
    const base = { at: new Date().toISOString(), cmd, label, epicId, agentId, harness, hostVersion: helper.endpoint.version };

    if (cmd === "peek") {
      if (info === null) {
        say(JSON.stringify({ ...base, terminal: null }));
        return 1;
      }
      const t0 = Date.now();
      const peeked = await attach(helper, info, 1500);
      const verdict = classifyTuiScreen(peeked.screen.lines(), harness, peeked.screen.cells());
      if (values["print-screen"]) printScreen(peeked.screen);
      const rec = { ...base, terminal: { cols: info.cols, rows: info.rows, status: info.status }, version: peeked.version, frames: peeked.frames, bracketedPaste: peeked.screen.bracketedPaste, verdict, ms: Date.now() - t0 };
      say(JSON.stringify({ ...rec, evidence: appendEvidence(rec) }, null, 2));
      return 0;
    }

    if (cmd === "watch") {
      if (info === null) return 1;
      const samples: Array<{ t: number; state: string }> = [];
      await attach(helper, info, Number(values.seconds ?? 20) * 1000, (screen, t) => {
        const state = classifyTuiScreen(screen.lines(), harness, screen.cells()).state;
        if (samples.at(-1)?.state !== state) {
          samples.push({ t, state });
          say(`${t}ms ${state}`);
          if (values["print-screen"]) printScreen(screen);
        }
      });
      const rec = { ...base, samples };
      say(JSON.stringify({ evidence: appendEvidence(rec) }));
      return 0;
    }

    const text = values.text as string;
    const before = await transcript(helper, epicId, agentId);

    if (cmd === "raw") {
      if (info === null) return 1;
      const client = createStreamClient({ endpoint: helper.endpoint, lease: await helper.credentials.getLease(), clientIdentity: helper.clientIdentity });
      const screen = new TerminalScreen(info.cols, info.rows);
      const acks = new Map<string, string>();
      let snapshot = false;
      const handle = openTerminalStream(client, info.sessionId, info, {
        onFrame: (env, bin) => {
          if (env.kind === "binarySnapshot" || env.kind === "snapshot") snapshot = true;
          if (typeof env.scrollback === "string") screen.write(env.scrollback);
          if (typeof env.chunk === "string") screen.write(env.chunk);
          if (bin) screen.write(bin);
          if (env.kind === "actionAck") acks.set(String(env.clientActionId), `${String(env.status)}${env.code ? ` ${String(env.code)}` : ""}`);
        },
        onClosed: () => undefined,
      });
      const t0 = Date.now();
      while (!snapshot && Date.now() - t0 < 5000) await Bun.sleep(20);
      await Bun.sleep(400);
      const pre = classifyTuiScreen(screen.lines(), harness, screen.cells());
      if (pre.state !== "idle" && !values.force) {
        handle.close();
        client.close("raw");
        say(`refusing: screen is ${pre.state} (${pre.reason}); pass --force to write anyway (disposable agent only)`);
        return 1;
      }
      const timeline: Array<{ t: number; step: string; state?: string; ack?: string }> = [{ t: Date.now() - t0, step: "pre", state: pre.state }];
      const pasteId = randomUUID();
      // Same cleaning as the library route: no control characters (paste end, key injection), no input-mode prefix.
      const typeable = typeableText(text);
      if ("error" in typeable) {
        handle.close();
        client.close("raw");
        say(`refusing: ${typeable.error}`);
        return 2;
      }
      const clean = typeable.text;
      handle.send({ kind: "write", hasBinaryPayload: false, sessionId: info.sessionId, clientActionId: pasteId, data: `\x1b[200~${clean}\x1b[201~` });
      timeline.push({ t: Date.now() - t0, step: "paste" });
      await Bun.sleep(400);
      timeline.push({ t: Date.now() - t0, step: "after-paste", state: classifyTuiScreen(screen.lines(), harness, screen.cells()).state, ack: acks.get(pasteId) ?? "none" });
      if (values["print-screen"]) printScreen(screen);
      if (!values["no-enter"]) {
        const enterId = randomUUID();
        handle.send({ kind: "write", hasBinaryPayload: false, sessionId: info.sessionId, clientActionId: enterId, data: "\r" });
        await Bun.sleep(600);
        timeline.push({ t: Date.now() - t0, step: "after-enter", state: classifyTuiScreen(screen.lines(), harness, screen.cells()).state, ack: acks.get(enterId) ?? "none" });
      }
      // Watch the screen for a while (states only).
      for (let i = 0; i < 40; i++) {
        await Bun.sleep(250);
        const state = classifyTuiScreen(screen.lines(), harness, screen.cells()).state;
        if (timeline.at(-1)?.state !== state) timeline.push({ t: Date.now() - t0, step: "screen", state });
      }
      if (values["print-screen"]) printScreen(screen);
      handle.close();
      client.close("raw");
      const marker = clean.split("\n")[0]?.slice(0, 120) ?? "";
      let confirmedMs: number | null = null;
      let after: string | null = null;
      for (let i = 0; i < 30 && confirmedMs === null; i++) {
        after = await transcript(helper, epicId, agentId);
        if (after !== null && userMessages(after, [marker]).length > userMessages(before ?? "", [marker]).length) confirmedMs = Date.now() - t0;
        else await Bun.sleep(1000);
      }
      const rec = { ...base, text: { chars: clean.length, lines: clean.split("\n").length, marker }, forced: values.force, enter: !values["no-enter"], timeline, confirmedMs, inTaskNotification: notificationHits(after ?? "", marker) - notificationHits(before ?? "", marker) };
      say(JSON.stringify({ ...rec, evidence: appendEvidence(rec) }, null, 2));
      return 0;
    }

    if (cmd === "type") {
      const traceLog: TypingTraceEvent[] = [];
      const progress: Array<{ t: number; stage: string; message?: string }> = [];
      const t0 = Date.now();
      let reply: string | null = null;
      const client = createStreamClient({ endpoint: helper.endpoint, lease: await helper.credentials.getLease(), clientIdentity: helper.clientIdentity });
      const outcome = await deliverTyped(
        {
          terminal: (e, a) => terminalInfo(helper, e, a),
          open: (sessionId, size, events) => openTerminalStream(client, sessionId, size, events),
          transcript: (e, a) => transcript(helper, e, a),
          progress: (_id, stage, message) => progress.push({ t: Date.now() - t0, stage, ...(message ? { message } : {}) }),
          onReply: (r) => {
            reply = r.text;
          },
          now: Date.now,
          sleep: (ms) => Bun.sleep(ms),
          active: () => true,
          trace: (e) => traceLog.push(e),
        },
        {
          requestId: `fm1-type-${randomUUID()}`,
          epicId,
          agentId,
          harness,
          text,
          ...TYPING_DEFAULTS,
          confirmTimeoutMs: Number(values["confirm-ms"] ?? TYPING_DEFAULTS.confirmTimeoutMs),
          turnTimeoutMs: Number(values["turn-ms"] ?? 60_000),
          pollMs: 500,
        },
      );
      // Wait for the trailing `completed` (background watch) up to turn-ms.
      const until = Date.now() + Number(values["turn-ms"] ?? 60_000);
      while (outcome.written && !progress.some((p) => p.stage === "completed") && Date.now() < until) await Bun.sleep(250);
      client.close("type");
      const marker = text.split("\n")[0]?.slice(0, 120) ?? "";
      const rec = {
        ...base,
        text: { chars: text.length, lines: text.split("\n").length, marker },
        outcome: outcome.written ? { written: true, stage: outcome.result.stage, message: outcome.result.message ?? null } : outcome,
        trace: traceLog,
        progress,
        replyHasMarker: reply === null ? null : (reply as string).includes(marker.split(" ").find((w) => /^FM1_/.test(w)) ?? "\u0000"),
        replyChars: reply === null ? null : (reply as string).length,
      };
      say(JSON.stringify({ ...rec, evidence: appendEvidence(rec) }, null, 2));
      return 0;
    }

    // adapter: the full route through TraycerAgentAdapter behind the smoke guard (allowlisted receiver; a2a fallback self-send).
    const raw = new TraycerAgentAdapter({ sessionScanLimit: 25, a2aSelfSend: true, tuiRoute: "type", ackTimeoutMs: 15_000 });
    const guarded = new GuardedAdapter(raw, allowlist, true);
    const events: Array<{ t: number; stage: string; message?: string }> = [];
    const t0 = Date.now();
    let replyText: string | null = null;
    raw.subscribe((e: AgentEvent) => {
      if (e.type === "command_progress") events.push({ t: Date.now() - t0, stage: e.stage, ...(e.message ? { message: e.message } : {}) });
      if (e.type === "session_upserted" && e.session.ref.sessionId === agentId) {
        const r = (e.session as { details?: { reply?: { text?: string } } }).details?.reply?.text;
        if (typeof r === "string") replyText = r;
      }
    });
    await guarded.connect();
    try {
      const sessions = await guarded.listSessions(epicId);
      const session = sessions.find((s) => s.ref.sessionId === agentId);
      if (session === undefined) {
        say("session not listed");
        return 1;
      }
      const capability = raw.promptCapability(session.ref as SessionRef);
      const requestId = `fm1-smoke-type-${randomUUID()}`;
      const result = await guarded.sendPrompt(session.ref, text, requestId);
      const until = Date.now() + Number(values["turn-ms"] ?? 60_000);
      while (!events.some((e) => e.stage === "completed" || e.stage === "failed") && Date.now() < until) await Bun.sleep(250);
      const after = await transcript(helper, epicId, agentId);
      const marker = text.split("\n")[0]?.slice(0, 120) ?? "";
      const typedCount = userMessages(after ?? "", [marker]).length - userMessages(before ?? "", [marker]).length;
      const notifCount = ((after ?? "").split(marker).length - 1) - ((before ?? "").split(marker).length - 1) - typedCount;
      const reply = replyText as string | null;
      const rec = {
        ...base,
        capability: { acceptsPrompt: capability?.acceptsPrompt, via: capability?.via ?? null, fallback: (capability as { fallbackVia?: string } | null)?.fallbackVia ?? null },
        text: { chars: text.length, lines: text.split("\n").length, marker },
        result: { stage: result.stage, message: result.message ?? null },
        progress: events,
        typedUserMessages: typedCount,
        otherOccurrences: notifCount,
        replyChars: reply?.length ?? null,
        mutations: guarded.mutations,
        refusals: guarded.refusals,
      };
      say(JSON.stringify({ ...rec, evidence: appendEvidence(rec) }, null, 2));
      return 0;
    } finally {
      await guarded.disconnect();
    }
  } finally {
    helper.close();
  }
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stderr.write(`tui-typing: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(2);
    },
  );
}
