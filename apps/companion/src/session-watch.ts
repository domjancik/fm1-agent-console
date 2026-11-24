// Keeps the backend watching the session selected on the device. Adapters that can stream one session in
// detail (Traycer: chat.subscribe) expose an optional `watchSession(ref) => release`; others are left alone.
import type { AgentAdapter, SessionRef, SessionRegistry } from "@fm1/agent-core";

type Watchable = { watchSession(ref: SessionRef): () => void };

export function canWatch(adapter: AgentAdapter): adapter is AgentAdapter & Watchable {
  return typeof (adapter as Partial<Watchable>).watchSession === "function";
}

export class SelectionWatcher {
  private key: string | null = null;
  private release: (() => void) | null = null;

  constructor(
    private readonly adapter: AgentAdapter,
    private readonly registry: SessionRegistry,
  ) {}

  /** Call after any registry change; (re)binds the watch when the live selection changed. */
  sync(): void {
    if (!canWatch(this.adapter)) return;
    const sel = this.registry.selection();
    const key = sel.status === "ok" ? sel.key : null;
    if (key === this.key) return;
    this.stop();
    const entry = key === null ? undefined : this.registry.get(key);
    if (entry === undefined || key === null) return;
    this.key = key;
    try {
      this.release = this.adapter.watchSession(entry.session.ref);
    } catch {
      this.release = null;
    }
  }

  get watching(): string | null {
    return this.key;
  }

  stop(): void {
    const release = this.release;
    this.release = null;
    this.key = null;
    release?.();
  }
}
