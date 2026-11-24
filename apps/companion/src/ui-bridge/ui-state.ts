// Companion state -> the companion-ui contract (plain data for the browser).
import { backendName, CAPABILITY_NAMES, isInferred, suggestionsOf, taskKey, taskOf, type SessionEntry } from "@fm1/agent-core";
import type { UiState, UiTask, UiSession } from "@fm1/companion-ui";
import type { Companion } from "../companion";

const EDITABLE = new Set(["reviewing"]);
const SAVEABLE = new Set(["reviewing"]);
const CANCELLABLE = new Set(["recording", "transcribing", "reviewing", "failed", "target_unavailable"]);

function sessionRow(e: SessionEntry, selected: string | null, c: Companion): UiSession {
  const s = e.session;
  return {
    key: e.key,
    title: s.title,
    provider: s.provider,
    runtime: s.runtime,
    state: c.console.registry.connection() === "disconnected" ? "disconnected" : c.console.inbox.displayState(e),
    inferred: isInferred(s.status),
    stale: e.stale,
    selected: e.key === selected,
    summary: s.summary ?? "",
    next: suggestionsOf(c.console.state, e),
  };
}

export function groupSessions(c: Companion): UiTask[] {
  const reg = c.console.registry;
  const selected = reg.selection().key;
  const groups = new Map<string, UiTask>();
  for (const t of reg.tasks()) groups.set(taskKey(t.ref), { key: taskKey(t.ref), title: t.title, sessions: [] });
  for (const e of reg.sessions()) {
    const k = taskKey(taskOf(e.session.ref));
    let g = groups.get(k);
    if (!g) {
      g = { key: k, title: `(task ${e.session.ref.taskId})`, sessions: [] };
      groups.set(k, g);
    }
    g.sessions.push(sessionRow(e, selected, c));
  }
  return [...groups.values()];
}

export function buildUiState(c: Companion, simulatorUrl: string | null): UiState {
  const caps = c.adapter.getCapabilities();
  const view = c.console.view();
  const comp = c.console.composer.state;
  const dev = c.device.status;
  return {
    backend: {
      adapterId: c.adapter.id,
      name: backendName(c.adapter),
      connection: c.console.registry.connection(),
      ready: c.console.registry.ready(),
      capabilities: CAPABILITY_NAMES.map((name) => ({
        name,
        supported: caps[name].supported,
        reason: caps[name].reason ?? null,
        verified: caps[name].verified,
      })),
    },
    device: { ...dev },
    view: {
      name: view.view,
      title: view.title,
      legend: [...view.legend],
      status: view.status.text,
      attention: view.status.attentionCount,
      ...(view.text ? { details: view.text.map((t) => t.text) } : {}),
    },
    tasks: groupSessions(c),
    voice: {
      state: comp.state,
      target: comp.destination?.label ?? null,
      transcript: comp.transcript,
      editable: EDITABLE.has(comp.state),
      canSave: SAVEABLE.has(comp.state) || (comp.state === "failed" && comp.retryable),
      canCancel: CANCELLABLE.has(comp.state),
      level: comp.level,
      elapsedDs: comp.elapsedDs,
      error: comp.error,
      source: comp.source,
    },
    dispatch: {
      requestId: c.relay.currentRequest,
      stages: c.relay.stages().map((s) => ({ stage: s.stage, at: s.at, message: s.message })),
    },
    config: { ...c.config, defaults: { ...c.config.defaults }, layouts: { ...c.config.layouts }, settings: { ...c.config.settings }, split: { ...c.config.split }, a2aSender: c.config.a2aSender.map((s) => ({ ...s })) },
    log: c.log.recent(200),
    simulatorUrl,
  };
}
