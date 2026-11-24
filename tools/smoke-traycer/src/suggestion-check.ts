#!/usr/bin/env bun
// Read-only check of suggested next prompts (docs/ui-v3.md section 11) on ONE allowlisted GUI chat: opens the adapter's
// own chat.subscribe for it (watchSession), reports the negotiated chat.subscribe version (suggestedPrompt needs >= 1.20)
// and whether the chat carries a suggestion. Prints SIZES ONLY, never the suggestion, a title or a message.
//   bun tools/smoke-traycer/src/suggestion-check.ts --chat <chat id> [--wait-ms 8000]
// Refuses any chat that is not in reports/disposable-allowlist.json. Calls made: the adapter's connect/listing calls and
// chat.subscribe (a read stream). No send, no stop, no focus, no mark-read, no approval.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { TraycerAgentAdapter, type TraycerSession } from "@fm1/agent-adapter-traycer";
import { parseAllowlist } from "./allowlist";
import { STRIPPED } from "./context";

for (const l of ["log", "info", "debug", "warn"] as const) console[l] = (...p: unknown[]) => console.error(...p);
const say = (s: string): void => {
  process.stdout.write(`${s}\n`);
};
const ALLOWLIST = new URL("../../../reports/disposable-allowlist.json", import.meta.url);

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { chat: { type: "string" }, "wait-ms": { type: "string" } } });
  const chatId = values.chat?.trim();
  if (!chatId) {
    say("usage: suggestion-check.ts --chat <allowlisted GUI chat id> [--wait-ms 8000]");
    return 2;
  }
  const task = parseAllowlist(readFileSync(ALLOWLIST, "utf8")).find((t) => t.chatIds.includes(chatId));
  if (!task) {
    say(`${chatId.slice(0, 8)} is not in reports/disposable-allowlist.json: refused`);
    return 2;
  }
  for (const k of STRIPPED) delete process.env[k];
  const adapter = new TraycerAgentAdapter({ sessionScanLimit: 25, terminalRefreshMs: 600_000 });
  let latest: TraycerSession | undefined;
  adapter.subscribe((e) => {
    if (e.type === "session_upserted" && e.session.ref.sessionId === chatId) latest = e.session as TraycerSession;
  });
  try {
    await adapter.connect();
    const sessions = (await adapter.listSessions(task.epicId)) as TraycerSession[];
    const target = sessions.find((s) => s.ref.sessionId === chatId);
    if (!target) {
      say(`${chatId.slice(0, 8)} not found in task ${task.epicId.slice(0, 8)}`);
      return 2;
    }
    if (target.runtime !== "chat") {
      say(`${chatId.slice(0, 8)} is a ${target.runtime} session, not a GUI chat`);
      return 2;
    }
    const release = adapter.watchSession(target.ref);
    const deadline = Date.now() + Number(values["wait-ms"] ?? 8000);
    while (adapter.diagnostics().chatSubscribe === null && Date.now() < deadline) await Bun.sleep(50);
    while (latest?.details === undefined && Date.now() < deadline) await Bun.sleep(50);
    await Bun.sleep(300); // a turnStateChanged after the snapshot may still carry or clear it
    const version = adapter.diagnostics().chatSubscribe;
    release();
    const list = latest?.details?.suggestions ?? [];
    const minor = version === null ? null : Number(version.split(".")[1]);
    say(
      JSON.stringify({
        chat: chatId.slice(0, 8),
        epic: task.epicId.slice(0, 8),
        chatSubscribe: version,
        carriesSuggestedPrompt: minor === null ? null : minor >= 20,
        detailsSeen: latest?.details !== undefined,
        suggestions: list.length,
        suggestionChars: list.map((x) => x.length),
      }),
    );
    return version === null ? 1 : 0;
  } finally {
    await adapter.disconnect();
  }
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (e: unknown) => {
      process.stderr.write(`suggestion-check: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(2);
    },
  );
}
