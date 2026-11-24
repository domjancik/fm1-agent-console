// In-memory diagnostics log shown in the UI. Redacts anything that looks like a credential.

export type LogLevel = "info" | "warn" | "error";
export type LogSource = "device" | "backend" | "voice" | "ui" | "app";

export interface LogEntry {
  at: number;
  level: LogLevel;
  source: LogSource;
  text: string;
}

// JWTs, bearer headers and long opaque tokens never reach a log line.
const WHOLE: RegExp[] = [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)?/g, /bearer\s+[A-Za-z0-9._~+/=-]+/gi];
const KEYED = /\b(token|secret|password|refreshToken|accessToken)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi;

export function redact(text: string): string {
  let out = text;
  for (const p of WHOLE) out = out.replace(p, "[redacted]");
  return out.replace(KEYED, (_m: string, key: string, sep: string) => `${key}${sep}[redacted]`);
}

export class DiagLog {
  private entries: LogEntry[] = [];
  private listeners = new Set<(e: LogEntry) => void>();

  constructor(
    private readonly keep = 500,
    private readonly now: () => number = Date.now,
    private readonly echo?: (e: LogEntry) => void,
  ) {}

  add(level: LogLevel, source: LogSource, text: string): void {
    const e: LogEntry = { at: this.now(), level, source, text: redact(text) };
    this.entries.push(e);
    if (this.entries.length > this.keep) this.entries.splice(0, this.entries.length - this.keep);
    this.echo?.(e);
    for (const l of this.listeners) l(e);
  }

  info(source: LogSource, text: string): void {
    this.add("info", source, text);
  }
  warn(source: LogSource, text: string): void {
    this.add("warn", source, text);
  }
  error(source: LogSource, text: string): void {
    this.add("error", source, text);
  }

  recent(n = 100): LogEntry[] {
    return this.entries.slice(-n);
  }

  onEntry(fn: (e: LogEntry) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
