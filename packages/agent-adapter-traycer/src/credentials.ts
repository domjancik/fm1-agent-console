import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { MutableBearerLease } from "@traycer-clients/shared/auth/bearer-source";

/**
 * Bearer handling for the local host.
 *
 * The host bearer is the user's Traycer cloud access token, owned by the
 * Traycer CLI/Desktop in `~/.traycer/cli/credentials`. Rules:
 *  - the token stays in memory and is never logged or returned to callers
 *    other than the transport;
 *  - this module never refreshes the token itself (that would race the CLI's
 *    locked refresh-token rotation); on UNAUTHORIZED it runs
 *    `traycer whoami --json`, which validates and rotates under the CLI's own
 *    lock, then re-reads the file.
 */
export function defaultCredentialsPath(): string {
  return join(homedir(), ".traycer", "cli", "credentials");
}

export class CredentialsError extends Error {
  constructor(
    readonly code: "CREDENTIALS_MISSING" | "CREDENTIALS_INVALID" | "WHOAMI_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "CredentialsError";
  }
}

export interface StoredCredential {
  readonly token: string;
  readonly userId: string;
}

/** Parses only the two fields we need; the refresh token is never read into a variable. */
export function parseCredentials(raw: string): StoredCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CredentialsError("CREDENTIALS_INVALID", "credentials file is not JSON");
  }
  const record = (parsed ?? {}) as { token?: unknown; user?: { id?: unknown } };
  if (typeof record.token !== "string" || record.token.length === 0) {
    throw new CredentialsError("CREDENTIALS_INVALID", "credentials file has no token");
  }
  if (typeof record.user?.id !== "string") {
    throw new CredentialsError("CREDENTIALS_INVALID", "credentials file has no user.id");
  }
  return { token: record.token, userId: record.user.id };
}

export type WhoamiRunner = () => Promise<void>;

/**
 * Runs `traycer whoami --json` with the agent-context variables removed, so
 * the CLI validates (and if needed rotates) the stored credential. Output is
 * discarded except for the status, so nothing sensitive is echoed.
 */
export function createCliWhoamiRunner(traycerBin = "traycer"): WhoamiRunner {
  return () =>
    new Promise<void>((resolve, reject) => {
      const env = { ...process.env };
      delete env.TRAYCER_AGENT_ID;
      delete env.TRAYCER_EPIC_ID;
      delete env.TRAYCER_TERMINAL_SPAWN_TOKEN;
      const child = spawn(traycerBin, ["whoami", "--json"], {
        env,
        stdio: ["ignore", "pipe", "ignore"],
      });
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.on("error", (error) =>
        reject(new CredentialsError("WHOAMI_FAILED", `whoami spawn failed: ${error.message}`)),
      );
      child.on("close", (code) => {
        const ok = code === 0 && /"status"\s*:\s*"valid"/.test(stdout);
        if (ok) resolve();
        else reject(new CredentialsError("WHOAMI_FAILED", `traycer whoami exited ${code}`));
      });
    });
}

export interface CredentialSourceOptions {
  readonly path?: string;
  readonly whoami?: WhoamiRunner;
  readonly readText?: (path: string) => Promise<string>;
}

export class CredentialSource {
  private readonly path: string;
  private readonly whoami: WhoamiRunner;
  private readonly readText: (path: string) => Promise<string>;
  private lease: MutableBearerLease | null = null;
  private refreshInFlight: Promise<void> | null = null;

  constructor(options: CredentialSourceOptions = {}) {
    this.path = options.path ?? defaultCredentialsPath();
    this.whoami = options.whoami ?? createCliWhoamiRunner();
    this.readText = options.readText ?? ((p) => readFile(p, "utf8"));
  }

  /** The lease the transport reads on every open frame. Loads on first call. */
  async getLease(): Promise<MutableBearerLease> {
    if (this.lease === null) {
      const credential = await this.load();
      this.lease = new MutableBearerLease(credential.token, credential.userId);
    }
    return this.lease;
  }

  async userId(): Promise<string> {
    return (await this.getLease()).identity.userId;
  }

  /**
   * Single-flight: concurrent UNAUTHORIZED handlers share one whoami run.
   * Rotates the existing lease in place so live streams pick it up.
   */
  async refresh(): Promise<void> {
    if (this.refreshInFlight === null) {
      this.refreshInFlight = (async () => {
        try {
          await this.whoami();
          const credential = await this.load();
          const lease = await this.getLease();
          lease.rotate(credential.token);
        } finally {
          this.refreshInFlight = null;
        }
      })();
    }
    return this.refreshInFlight;
  }

  private async load(): Promise<StoredCredential> {
    let raw: string;
    try {
      raw = await this.readText(this.path);
    } catch {
      throw new CredentialsError("CREDENTIALS_MISSING", `no credentials at ${this.path}`);
    }
    return parseCredentials(raw);
  }
}
