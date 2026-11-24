// A second, passive TraycerAgentAdapter: no chat watch, no commands. It sees state only through the host-wide
// feeds (activity, chat records, notifications), as an unselected device slot would.
import { effectiveState, type AgentEvent, type NormalizedState, type SessionRef } from "@fm1/agent-core";
import { TraycerAgentAdapter } from "@fm1/agent-adapter-traycer";
import { sameChat } from "../context";

export interface ObservedChange {
  t: number;
  sessionId: string;
  state: NormalizedState;
  observed: boolean;
}

export class Observer {
  readonly adapter: TraycerAgentAdapter;
  readonly changes: ObservedChange[] = [];

  constructor() {
    const refuse = async (): Promise<{ code: number; stdout: string }> => {
      throw new Error("observer: commands disabled");
    };
    this.adapter = new TraycerAgentAdapter({ sessionScanLimit: 5, runCommand: refuse });
    this.adapter.subscribe((e: AgentEvent) => {
      if (e.type !== "session_upserted") return;
      const state = effectiveState(e.session.status);
      const last = [...this.changes].reverse().find((c) => c.sessionId === e.session.ref.sessionId);
      if (last?.state !== state) this.changes.push({ t: performance.now(), sessionId: e.session.ref.sessionId, state, observed: e.session.status.observed.state !== null });
    });
  }

  async start(epicId: string): Promise<void> {
    await this.adapter.connect();
    await this.adapter.listSessions(epicId);
  }

  stop(): Promise<void> {
    return this.adapter.disconnect();
  }

  first(ref: SessionRef, states: readonly NormalizedState[], after: number): ObservedChange | undefined {
    return this.changes.find((c) => c.t >= after && sameChat({ taskId: ref.taskId, sessionId: c.sessionId }, ref) && states.includes(c.state));
  }

  async waitFor(ref: SessionRef, states: readonly NormalizedState[], after: number, timeoutMs: number): Promise<ObservedChange | undefined> {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      const hit = this.first(ref, states, after);
      if (hit) return hit;
      await Bun.sleep(25);
    }
    return undefined;
  }
}
