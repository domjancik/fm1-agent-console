import { readFileSync } from "node:fs";
import { CAPABILITY_NAMES, type AdapterCapabilities, type Capability, type CapabilityName } from "@fm1/agent-core";

/** agent-core's Capability plus the focus level this adapter can reach. */
export type TraycerCapability = Capability & { readonly level?: "window" | "tile" };
export type TraycerCapabilities = Record<CapabilityName, TraycerCapability>;

type ReportStatus = "verified-live" | "code-only" | "unsupported";

/** Which report operation(s) establish each adapter operation. All listed must be live for `live`. */
const REPORT_KEYS: Record<CapabilityName, readonly string[]> = {
  listProjects: ["listTasks"],
  listTasks: ["listTasks"],
  listSessions: ["listAgents"],
  subscribe: ["activityAcrossEpics", "chatEvents"],
  sendPrompt: ["sendPromptGuiChat"],
  createTask: ["createTask"],
  createSession: ["createGuiChatInTask"],
  respondToApproval: ["approvalsRespond"],
  interrupt: ["stop"],
  focus: [],
};

const NOTES: Partial<Record<CapabilityName, string>> = {
  sendPrompt:
    "GUI chats via chat.subscribe; Claude and Codex terminal (TUI) agents typed into their Traycer terminal (terminal.subscribe write, tuiRoute type, the default), Claude with Traycer a2a (agent.sendMessage) as the fallback when nothing could be typed; other terminals never (see session.prompt / promptCapability)",
  respondToApproval: "GUI chats only (command and file-edit approval cards); live status comes from reports/traycer-capabilities.json approvalsRespond",
  listProjects: "projects derived from task workspaces / repo identifiers",
};

export const FOCUS_CAPABILITY: TraycerCapability = {
  supported: true,
  level: "window",
  verified: "live",
  reason: "tile selection needs upstream deep link (docs/upstream/traycer-deep-link.diff)",
};

export const FOCUS_DEEP_LINK_CAPABILITY: TraycerCapability = {
  supported: true,
  level: "tile",
  verified: "code",
  reason: "deep link opens the tile only on a Desktop build with docs/upstream/traycer-deep-link.diff; stock 1.5.4 activates the window only",
};

export function readCapabilityReport(path: string | null): Record<string, ReportStatus> {
  if (path === null) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { operations?: Record<string, { status?: unknown }> };
    const out: Record<string, ReportStatus> = {};
    for (const [key, op] of Object.entries(parsed.operations ?? {})) {
      if (op.status === "verified-live" || op.status === "code-only" || op.status === "unsupported") out[key] = op.status;
    }
    return out;
  } catch {
    return {};
  }
}

/** Static capabilities: what the report says each operation was verified by. */
export function baseCapabilities(report: Record<string, ReportStatus>, focusDeepLink: boolean): TraycerCapabilities {
  const entries = CAPABILITY_NAMES.map((name): [CapabilityName, TraycerCapability] => {
    if (name === "focus") return [name, focusDeepLink ? FOCUS_DEEP_LINK_CAPABILITY : FOCUS_CAPABILITY];
    const statuses = REPORT_KEYS[name].map((key) => report[key]);
    const note = NOTES[name];
    if (statuses.some((s) => s === "unsupported")) {
      return [name, { supported: false, verified: "live", reason: note ?? "unsupported by the host" }];
    }
    const verified: Capability["verified"] =
      statuses.length > 0 && statuses.every((s) => s === "verified-live")
        ? "live"
        : statuses.every((s) => s !== undefined)
          ? "code"
          : "none";
    return [name, note === undefined ? { supported: true, verified } : { supported: true, verified, reason: note }];
  });
  return Object.fromEntries(entries) as TraycerCapabilities;
}

/** Host methods each capability depends on; an INCOMPATIBLE verdict on one removes the capability. */
export const METHOD_CAPABILITIES: Record<string, readonly CapabilityName[]> = {
  "epic.listTasks": ["listTasks", "listProjects"],
  "epic.listChatRecords": ["listSessions"],
  "epic.listTuiAgents": ["listSessions"],
  "epic.getChatRunSettingsBatch": ["listSessions"],
  "epic.getChatRunSettings": ["sendPrompt"],
  "chat.subscribe": ["sendPrompt", "respondToApproval"],
  "epic.createChat": ["createSession"],
  "agent.stop": ["interrupt"],
};

/** Capabilities with runtime losses applied. Losses persist until the next successful handshake. */
export class CapabilityState {
  private readonly lost = new Map<CapabilityName, string>();
  private hostIncompatible: string | null = null;

  constructor(private readonly base: TraycerCapabilities) {}

  loseMethod(method: string, reason: string): CapabilityName[] {
    const names = METHOD_CAPABILITIES[method] ?? [];
    for (const name of names) this.lost.set(name, `host INCOMPATIBLE on ${method}: ${reason}`);
    return [...names];
  }

  loseSubscribe(reason: string): void {
    this.lost.set("subscribe", reason);
  }

  setHostIncompatible(reason: string | null): void {
    this.hostIncompatible = reason;
  }

  /** Called after a fresh successful handshake against a (possibly upgraded) host. */
  reset(): void {
    this.lost.clear();
    this.hostIncompatible = null;
  }

  isLost(name: CapabilityName): boolean {
    return this.hostIncompatible !== null || this.lost.has(name);
  }

  snapshot(): TraycerCapabilities {
    const out = {} as TraycerCapabilities;
    for (const name of CAPABILITY_NAMES) {
      const base = this.base[name];
      const reason = this.hostIncompatible ?? this.lost.get(name);
      out[name] = reason === undefined || name === "focus" ? base : { ...base, supported: false, reason };
    }
    return out;
  }

  asAdapterCapabilities(): AdapterCapabilities {
    return this.snapshot();
  }
}
