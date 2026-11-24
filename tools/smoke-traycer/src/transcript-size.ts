#!/usr/bin/env bun
// Read-only check of terminal-session details (agent.getTranscript) on one real terminal session, through the adapter's
// own path (watchSession -> TerminalDetails). Prints SIZES ONLY: never a title, a message or any transcript text.
//   bun tools/smoke-traycer/src/transcript-size.ts --agent <agent id or prefix> [--epic <epic id>]
// Calls made: the adapter's connect/listing calls and agent.getTranscript. No prompt, no stop, no focus, no mark-read.
import { parseArgs } from "node:util";
import { TraycerAgentAdapter, type TraycerSession } from "@fm1/agent-adapter-traycer";
import { STRIPPED } from "./context";

for (const l of ["log", "info", "debug", "warn"] as const) console[l] = (...p: unknown[]) => console.error(...p);
const say = (s: string): void => {
  process.stdout.write(`${s}\n`);
};

export interface SizeReport {
  epic: string;
  agent: string;
  runtime: string;
  transcriptChars: number;
  fetchMs: number;
  lastMessageChars: number | null;
  lastPromptChars: number | null;
  summaryChars: number | null;
}

/** The sizes of what the adapter derived from one session's transcript. Pure: used by the CLI and its unit test. */
export function sizeReport(session: TraycerSession, transcriptChars: number, fetchMs: number): SizeReport {
  const d = session.details;
  return {
    epic: session.ref.taskId.slice(0, 8),
    agent: session.ref.sessionId.slice(0, 8),
    runtime: session.runtime,
    transcriptChars,
    fetchMs,
    lastMessageChars: d?.lastMessage?.length ?? null,
    lastPromptChars: d?.lastPrompt?.length ?? null,
    summaryChars: session.summary?.length ?? null,
  };
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { agent: { type: "string" }, epic: { type: "string" } } });
  const prefix = values.agent?.trim();
  if (!prefix) {
    say("usage: transcript-size.ts --agent <agent id or prefix> [--epic <epic id>]");
    return 2;
  }
  for (const k of STRIPPED) delete process.env[k];
  const adapter = new TraycerAgentAdapter({ sessionScanLimit: 25, terminalRefreshMs: 600_000 });
  let latest: TraycerSession | undefined;
  adapter.subscribe((e) => {
    if (e.type === "session_upserted" && e.session.ref.sessionId.startsWith(prefix)) latest = e.session as TraycerSession;
  });
  try {
    await adapter.connect();
    const sessions = (await adapter.listSessions(values.epic)) as TraycerSession[];
    const hits = sessions.filter((s) => s.ref.sessionId.startsWith(prefix));
    if (hits.length !== 1) {
      say(`${hits.length} sessions match ${prefix} in the scan${values.epic ? ` of ${values.epic.slice(0, 8)}` : ""}; give a longer id or --epic`);
      return 2;
    }
    const target = hits[0] as TraycerSession;
    if (target.runtime !== "terminal") {
      say(`${target.ref.sessionId.slice(0, 8)} is a ${target.runtime} session, not a terminal session`);
      return 2;
    }
    const t0 = performance.now();
    const release = adapter.watchSession(target.ref);
    const deadline = Date.now() + 30_000;
    while (adapter.diagnostics().lastTranscript === null && Date.now() < deadline) await Bun.sleep(50);
    const fetchMs = Math.round(performance.now() - t0);
    await Bun.sleep(100); // the upsert follows the read
    release();
    const read = adapter.diagnostics().lastTranscript;
    if (read === null) {
      say("no transcript read within 30 s");
      return 1;
    }
    const report = sizeReport(latest ?? target, read.chars, fetchMs);
    say(JSON.stringify(report));
    return report.lastMessageChars !== null ? 0 : 1;
  } finally {
    await adapter.disconnect();
  }
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stderr.write(`transcript-size: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(2);
    },
  );
}
