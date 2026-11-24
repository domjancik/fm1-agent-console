// Runs a selection of smoke tests in order, isolating failures, and writes the evidence and report.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, type SmokeContext } from "./context";
import { markdownTable, summaryLine, type SmokeRecord } from "./record";
import { scanForSecrets, secretNeedles } from "./redact";
import { t0 } from "./tests/t0-discovery";
import { t1 } from "./tests/t1-state-sync";
import { t2, t3 } from "./tests/t2-t3-delivery";
import { t4 } from "./tests/t4-switching";
import { t5 } from "./tests/t5-new-task";
import { t6 } from "./tests/t6-interrupt";
import { t7 } from "./tests/t7-approvals";
import { t8 } from "./tests/t8-recovery";
import { t9 } from "./tests/t9-isolation";
import { tuiA2a } from "./tests/t10-tui-a2a";
import type { SmokeTest } from "./tests/types";

export const ALL_TESTS: readonly SmokeTest[] = [t0, t1, t2, t3, t4, t5, t6, t7, t8, t9, tuiA2a];

export function selectTests(live: boolean, only: readonly string[] | null): SmokeTest[] {
  const wanted = only?.map((x) => x.toUpperCase());
  return ALL_TESTS.filter((t) => (wanted ? wanted.includes(t.id) : true)).filter((t) => live || !t.live);
}

export async function runTests(ctx: SmokeContext, tests: readonly SmokeTest[], log: (s: string) => void): Promise<SmokeRecord[]> {
  const records: SmokeRecord[] = [];
  for (const t of tests) {
    log(`--- ${t.id} ${t.title}`);
    const started = new Date();
    let rec: SmokeRecord;
    try {
      rec = await t.run(ctx);
    } catch (e) {
      rec = {
        id: t.id,
        timestamp: started.toISOString(),
        cliVersion: ctx.versions.cli,
        hostVersion: ctx.versions.host,
        provider: "-",
        sessionType: "-",
        target: "-",
        operation: t.title,
        expected: "-",
        observed: `runner error: ${e instanceof Error ? e.message : String(e)}`,
        result: "FAIL",
        evidence: [],
      };
    }
    records.push(rec);
    log(`${rec.id} ${rec.result}: ${rec.observed}`);
  }
  return records;
}

/** Writes records.json and appends a dated section to reports/traycer-smoke.md. */
export function report(ctx: SmokeContext, records: readonly SmokeRecord[], mode: string): { json: string; leak: number } {
  const json = ctx.writeEvidence("records.json", { mode, refusals: ctx.adapter.refusals, mutations: ctx.adapter.mutations, records });
  const leak = scanForSecrets([ctx.evidenceDir], secretNeedles()).hits.length;
  const section = [
    "",
    `## Automated run (tools/smoke-traycer ${mode}), ${new Date().toISOString()}`,
    "",
    `Runner: \`bun tools/smoke-traycer/src/cli.ts ${mode}\` (also \`fm1-console test traycer ${mode}\`). ${summaryLine(records)}. Evidence: \`${json}\` and the other files in that directory. Credential scan of the evidence directory: ${leak} hit(s).`,
    "",
    markdownTable(records),
    "",
  ].join("\n");
  appendFileSync(join(REPO_ROOT, "reports", "traycer-smoke.md"), section);
  return { json, leak };
}
