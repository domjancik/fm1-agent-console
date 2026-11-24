// Shared between the server and the browser bundle: plain data, no runtime imports.

export interface UiCapability {
  name: string;
  supported: boolean;
  reason: string | null;
  verified: string;
}

export interface UiSession {
  key: string;
  title: string;
  provider: string;
  runtime: string;
  state: string;
  inferred: boolean;
  stale: boolean;
  selected: boolean;
  summary: string;
  /** The suggested next prompts the console offers (docs/ui-v3.md section 11). Optional: older companions omit it. */
  next?: string[];
}

export interface UiTask {
  key: string;
  title: string;
  sessions: UiSession[];
}

export interface UiStage {
  stage: string;
  at: number;
  message: string | null;
}

export interface UiConfig {
  micDeviceUid: string | null;
  asrEngine: string;
  language: string;
  vocabularyFile: string | null;
  focusDeepLink: boolean;
  defaults: { provider: string; model: string | null };
  /** Buddy or List per view (SEQ on the device, protocol version 5; docs/ui-v3.md section 8.7). */
  layouts: { sessions: string; inbox: string };
  /** Traycer a2a self-send for terminal agents (applies at the next start). Optional: older companions omit it. */
  a2aSelfSend?: boolean;
  /** Per-task a2a sender agents (edited in config.json only). */
  a2aSender?: Array<{ agentId: string; epicId: string }>;
  /** Terminal prompts: typed into the agent's terminal (`type`, default) or Traycer a2a only (edited in config.json only). */
  tuiRoute?: "type" | "a2a";
  /** SETTINGS on the device (protocol 6, docs/ui-v3.md section 10.2): Keys Ranked or Split. Optional: older companions omit it. */
  settings?: { keys: string };
  /** The SPLIT choice and task page the device restores (read-only here). */
  split?: { chosen: string; task: string | null; taskPage: number };
}

export interface UiLogEntry {
  at: number;
  level: string;
  source: string;
  text: string;
}

export interface UiState {
  /** `name`: the backend's name in copy (the adapter's displayName, else its id). */
  backend: { adapterId: string; name?: string; connection: string; ready: boolean; capabilities: UiCapability[] };
  device: { phase: string; transport: string | null; proto: number | null; firmware: string | null; rxErrors: number; resyncs: number; reason: string | null };
  /** `details`: the DETAILS page rows while the device shows it (docs/ux-v2.md section 7). */
  view: { name: string; title: string; legend: string[]; status: string; attention: number; details?: string[] };
  tasks: UiTask[];
  voice: {
    state: string;
    target: string | null;
    transcript: string;
    editable: boolean;
    canSave: boolean;
    canCancel: boolean;
    level: number;
    elapsedDs: number;
    error: string | null;
    /** `suggested` when the text under review is a session's suggested next prompt (a REC tap). Optional. */
    source?: string;
  };
  dispatch: { requestId: string | null; stages: UiStage[] };
  config: UiConfig;
  log: UiLogEntry[];
  simulatorUrl: string | null;
}

export type UiCommand =
  | { t: "edit"; text: string }
  | { t: "save" }
  | { t: "cancel" }
  | { t: "config"; patch: Record<string, unknown> };

export type CommandReply = { ok: true } | { ok: false; error: string };

/** What the companion provides to the UI server. */
export interface UiBackend {
  snapshot(): UiState;
  onChange(fn: () => void): () => void;
  command(cmd: UiCommand): Promise<CommandReply>;
}

export type ServerPush = { t: "state"; state: UiState } | { t: "reply"; id: number; reply: CommandReply };

export const MAX_TRANSCRIPT = 4000;

/** Validates a browser message; anything unexpected is dropped. */
export function parseCommand(raw: string): { id: number; cmd: UiCommand } | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const id = typeof o.id === "number" && Number.isInteger(o.id) ? o.id : 0;
  switch (o.t) {
    case "edit":
      return typeof o.text === "string" && o.text.length <= MAX_TRANSCRIPT ? { id, cmd: { t: "edit", text: o.text } } : null;
    case "save":
    case "cancel":
      return { id, cmd: { t: o.t } };
    case "config":
      return typeof o.patch === "object" && o.patch !== null && !Array.isArray(o.patch)
        ? { id, cmd: { t: "config", patch: o.patch as Record<string, unknown> } }
        : null;
    default:
      return null;
  }
}
