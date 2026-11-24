#!/usr/bin/env bun
// fm1-smoke-traycer: spec section 6 live smoke tests against the installed Traycer host.
//   --read-only            T0 only (no prompts, no mutations)
//   --live                 T0-T9 and TUI-A2A; state changes only on reports/disposable-allowlist.json targets
//   --only T2,T3           subset (e.g. --only TUI-A2A)
//   --no-report            do not append to reports/traycer-smoke.md
//   --a2a-self             TUI-A2A sends as the receiver itself (a2aSelfSend, no a2aSender), the companion's default
import { join } from "node:path";
import { parseArgs } from "node:util";
import { REPO_ROOT, SmokeContext } from "./context";
import { summaryLine } from "./record";
import { report, runTests, selectTests } from "./runner";

for (const l of ["log", "info", "debug", "warn"] as const) console[l] = (...p: unknown[]) => console.error(...p);
const say = (s: string): void => {
  process.stdout.write(`${s}\n`);
};

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      live: { type: "boolean", default: false },
      "read-only": { type: "boolean", default: false },
      only: { type: "string" },
      "no-report": { type: "boolean", default: false },
      out: { type: "string" },
      "a2a-self": { type: "boolean", default: false },
    },
  });
  if (values.live === values["read-only"]) {
    say("usage: fm1-smoke-traycer --read-only | --live [--only T0,T2] [--no-report]");
    return 2;
  }
  const mode = values.live ? "--live" : "--read-only";
  const tests = selectTests(values.live, values.only ? values.only.split(",") : null);
  if (tests.length === 0) {
    say("no tests selected (state-changing tests need --live)");
    return 2;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = values.out ?? join(REPO_ROOT, "reports", "evidence", "e2e", "smoke", stamp);
  const ctx = new SmokeContext(values.live, dir, values["a2a-self"] ? { a2aSender: [], a2aSelfSend: true } : {});
  say(`smoke-traycer ${mode}${ctx.a2aSelf ? " (a2a self-send)" : ""}: ${tests.map((t) => t.id).join(", ")}; evidence ${dir}`);
  await ctx.start();
  say(`traycer CLI ${ctx.versions.cli}, host ${ctx.versions.host}`);
  try {
    const records = await runTests(ctx, tests, say);
    say(summaryLine(records));
    if (!values["no-report"]) {
      const { json, leak } = report(ctx, records, mode);
      say(`records: ${json}; credential hits in evidence: ${leak}`);
    }
    return records.every((r) => r.result === "PASS") ? 0 : 1;
  } finally {
    await ctx.stop();
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    process.stderr.write(`smoke-traycer: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
  },
);
