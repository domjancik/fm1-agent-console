// Spec section 6 "Smoke test reporting" fields, plus rendering for reports/traycer-smoke.md.

export type Verdict = "PASS" | "FAIL" | "BLOCKED" | "SKIPPED";

export interface SmokeRecord {
  id: string;
  timestamp: string;
  cliVersion: string;
  hostVersion: string;
  provider: string;
  sessionType: string;
  /** Redacted (first 8 characters). Full ids live in reports/disposable-allowlist.json. */
  target: string;
  operation: string;
  expected: string;
  observed: string;
  result: Verdict;
  evidence: string[];
  metrics?: Record<string, number | string | null>;
}

export interface Versions {
  cli: string;
  host: string;
}

/** Builds a record; `checks` decide PASS/FAIL, `blocked` overrides with BLOCKED. */
export class RecordBuilder {
  private readonly failures: string[] = [];
  private readonly notes: string[] = [];
  private readonly evidence: string[] = [];
  private readonly metrics: Record<string, number | string | null> = {};
  private blockedWhy: string | null = null;

  constructor(
    private readonly base: Pick<SmokeRecord, "id" | "provider" | "sessionType" | "target" | "operation" | "expected">,
    private readonly versions: Versions,
    private readonly started = new Date(),
  ) {}

  check(ok: boolean, what: string): boolean {
    (ok ? this.notes : this.failures).push(ok ? what : `FAILED: ${what}`);
    return ok;
  }

  note(text: string): void {
    this.notes.push(text);
  }

  metric(name: string, value: number | string | null): void {
    this.metrics[name] = value;
  }

  addEvidence(path: string): void {
    this.evidence.push(path);
  }

  blocked(why: string): void {
    this.blockedWhy = why;
  }

  get failed(): boolean {
    return this.failures.length > 0;
  }

  build(): SmokeRecord {
    const result: Verdict = this.blockedWhy !== null ? "BLOCKED" : this.failures.length > 0 ? "FAIL" : "PASS";
    const observed = [...(this.blockedWhy ? [`BLOCKED: ${this.blockedWhy}`] : []), ...this.failures, ...this.notes].join("; ");
    const rec: SmokeRecord = {
      ...this.base,
      timestamp: this.started.toISOString(),
      cliVersion: this.versions.cli,
      hostVersion: this.versions.host,
      observed,
      result,
      evidence: this.evidence,
    };
    if (Object.keys(this.metrics).length > 0) rec.metrics = { ...this.metrics };
    return rec;
  }
}

const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function markdownTable(records: readonly SmokeRecord[]): string {
  const head =
    "| Test ID | Timestamp (UTC) | CLI | Host | Provider | Session type | Target session | Operation | Expected result | Observed result | Result | Evidence |\n" +
    "|---|---|---|---|---|---|---|---|---|---|---|---|";
  const rows = records.map((r) =>
    [r.id, r.timestamp, r.cliVersion, r.hostVersion, r.provider, r.sessionType, r.target, r.operation, r.expected, r.observed, r.result, r.evidence.join(", ")]
      .map((v) => cell(String(v)))
      .join(" | "),
  );
  return [head, ...rows.map((r) => `| ${r} |`)].join("\n");
}

export function summaryLine(records: readonly SmokeRecord[]): string {
  const count = (v: Verdict) => records.filter((r) => r.result === v).length;
  return `${records.length} tests: ${count("PASS")} PASS, ${count("FAIL")} FAIL, ${count("BLOCKED")} BLOCKED, ${count("SKIPPED")} SKIPPED`;
}
