import type { Destination } from "./composer-state";
import { projectKey, taskKey } from "./identity";
import type { SessionRegistry } from "./registry";
import { acceptsPrompt, effectiveState } from "./status";
import type { AgentAdapter, CapabilityName, CommandResult, DeliveryStage } from "./types";
import { checkedResult } from "./validate";

// "sent" is uncertain (may have reached the backend), so it is never re-sent; but an explicit
// backend failure may supersede it. Only an acknowledgement is sticky.
const FINAL_OK: readonly DeliveryStage[] = ["sent", "backend_acknowledged", "completed"];
const ACKED: readonly DeliveryStage[] = ["backend_acknowledged", "completed"];

const CAPABILITY_FOR: Record<Destination["mode"], CapabilityName> = {
  "continue-session": "sendPrompt",
  "new-session": "createSession",
  "new-task": "createTask",
};

/**
 * Sends prompts with at-most-once semantics per requestId: concurrent calls share one in-flight promise,
 * and a request that already reached the backend is never re-sent.
 */
export class PromptDispatcher {
  private inflight = new Map<string, Promise<CommandResult>>();
  private settled = new Map<string, CommandResult>();
  private sendCount = 0;

  constructor(
    private readonly adapter: AgentAdapter,
    private readonly registry: SessionRegistry,
  ) {}

  /** Number of adapter calls actually made (for diagnostics and tests). */
  get adapterCalls(): number {
    return this.sendCount;
  }

  /** Checks capability and target liveness without sending anything. */
  precheck(dest: Destination, requestId: string): CommandResult | null {
    const cap = this.adapter.getCapabilities()[CAPABILITY_FOR[dest.mode]];
    if (!cap.supported) return { requestId, stage: "unsupported", message: cap.reason ?? "unsupported" };
    if (dest.mode === "continue-session") {
      const r = this.registry.resolve(dest.target);
      if (!r.ok) return { requestId, stage: "target_unavailable", message: `target ${r.error}` };
      const prompt = r.value.prompt;
      if (prompt?.acceptsPrompt === false) return { requestId, stage: "unsupported", message: prompt.reason ?? "session takes no console prompts" };
      if (!acceptsPrompt(effectiveState(r.value.status))) return { requestId, stage: "target_unavailable", message: "target not accepting prompts" };
    } else if (dest.mode === "new-session") {
      if (!this.registry.ready() || !this.registry.task(taskKey(dest.task))) {
        return { requestId, stage: "target_unavailable", message: "task unavailable" };
      }
    } else if (!this.registry.ready() || !this.registry.projects().some((p) => projectKey(p) === projectKey(dest.project))) {
      return { requestId, stage: "target_unavailable", message: "project unavailable" };
    }
    return null;
  }

  dispatch(requestId: string, dest: Destination, text: string): Promise<CommandResult> {
    const prior = this.settled.get(requestId);
    if (prior && FINAL_OK.includes(prior.stage)) return Promise.resolve(prior);
    const running = this.inflight.get(requestId);
    if (running) return running;
    const blocked = this.precheck(dest, requestId);
    if (blocked) return Promise.resolve(blocked);
    const p = this.send(requestId, dest, text)
      .then((r) => checkedResult(r, requestId))
      .catch((e: unknown): CommandResult => ({ requestId, stage: "failed", message: e instanceof Error ? e.message : String(e) }))
      .then((r) => {
        this.inflight.delete(requestId);
        this.settled.set(requestId, { ...r, requestId });
        return { ...r, requestId };
      });
    this.inflight.set(requestId, p);
    return p;
  }

  /** Progress reported later by the backend (e.g. an ack event) also counts as settled. */
  record(requestId: string, stage: DeliveryStage, message?: string): void {
    const prior = this.settled.get(requestId);
    if (prior && ACKED.includes(prior.stage) && !ACKED.includes(stage)) return;
    if (prior && FINAL_OK.includes(prior.stage) && (stage === "accepted_locally" || stage === "sent")) return;
    this.settled.set(requestId, message === undefined ? { requestId, stage } : { requestId, stage, message });
  }

  private async send(requestId: string, dest: Destination, text: string): Promise<CommandResult> {
    this.sendCount++;
    switch (dest.mode) {
      case "continue-session":
        return this.adapter.sendPrompt(dest.target, text, requestId);
      case "new-session":
        return this.adapter.createSession({ requestId, task: dest.task, provider: dest.provider, prompt: text });
      case "new-task":
        return this.adapter.createTask({ requestId, project: dest.project, provider: dest.provider, title: titleFrom(text), prompt: text });
    }
  }
}

function titleFrom(text: string): string {
  const firstLine = text.trim().split("\n")[0] ?? "";
  return firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine;
}
