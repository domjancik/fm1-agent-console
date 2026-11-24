// A check result list: "fail" makes `verify` exit non-zero; "warn" and "info" never do.

export type CheckStatus = "pass" | "fail" | "warn" | "info";

export interface Check {
  id: string;
  status: CheckStatus;
  detail: string;
}

export class Checks {
  readonly list: Check[] = [];

  add(id: string, status: CheckStatus, detail: string): void {
    this.list.push({ id, status, detail });
  }

  /** pass when `ok`, else fail; returns `ok`. */
  expect(id: string, ok: boolean, passDetail: string, failDetail = passDetail): boolean {
    this.add(id, ok ? "pass" : "fail", ok ? passDetail : failDetail);
    return ok;
  }

  get failed(): Check[] {
    return this.list.filter((c) => c.status === "fail");
  }
}
