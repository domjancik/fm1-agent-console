// Backend adapter registry. Each entry builds one AgentAdapter from the companion's options; `--adapter <name>` picks it.
// The Traycer adapter is looked up by its export name at runtime, so this app keeps compiling (and the mock keeps
// working) while @fm1/agent-adapter-traycer evolves. Adapters fill every Session field themselves (lastActivityAt
// included): nothing here reads a backend's raw status.
import { CAPABILITY_NAMES, MockAdapter, fixturePath, type AgentAdapter } from "@fm1/agent-core";

/** Sender identity for Traycer a2a prompts to terminal agents: an agent of the user's in that task (config `a2aSender`). */
export interface A2aSenderOption {
  agentId: string;
  epicId: string;
}

export interface AdapterFactoryOptions {
  /** Fixture name for the mock (fixtures/sessions/<name>.json). */
  mockFixture?: string;
  focusDeepLink?: boolean;
  /** Patched Traycer Desktop .app for deep-link focus (config `focusApp`); null/undefined = stock. */
  focusApp?: string | null;
  /** Model for new sessions/tasks of one provider (config defaults); the adapter's cheapest defaults otherwise. */
  defaultModel?: { provider: "claude" | "codex"; model: string };
  /**
   * Traycer a2a (docs/traycer-integration.md, "Terminal (TUI) agents"): send console prompts to a Claude terminal agent
   * as the receiver itself when no `a2aSender` names a sender for its task (operator decision 2026-11-18, option B).
   * The companion passes config `a2aSelfSend` (default true).
   */
  a2aSelfSend?: boolean;
  /** Per-task sender agents (config `a2aSender`); they win over self-send for their task. */
  a2aSender?: A2aSenderOption[];
  /** Terminal prompts typed into the agent's terminal (`type`, default) or Traycer a2a only (config `tuiRoute`). */
  tuiRoute?: "type" | "a2a";
}

export class AdapterUnavailableError extends Error {
  override name = "AdapterUnavailableError";
}

export const TRAYCER_MODULE = "@fm1/agent-adapter-traycer";
export const TRAYCER_EXPORT = "TraycerAgentAdapter";

const METHODS: readonly string[] = [
  "connect", "disconnect", "getCapabilities", "listProjects", "listTasks", "listSessions", "listApprovals",
  "subscribe", "sendPrompt", "createTask", "createSession", "respondToApproval", "interrupt", "focus",
];

/** Checks at runtime that a value implements AgentAdapter (method names and a capability table). */
export function assertAgentAdapter(v: unknown, what: string): AgentAdapter {
  const o = v as Record<string, unknown> | null;
  if (typeof o !== "object" || o === null) throw new AdapterUnavailableError(`${what} is not an object`);
  const missing = METHODS.filter((m) => typeof o[m] !== "function");
  if (missing.length > 0) throw new AdapterUnavailableError(`${what} does not implement AgentAdapter (missing ${missing.join(", ")})`);
  if (typeof o.id !== "string") throw new AdapterUnavailableError(`${what} has no string id`);
  if (o.displayName !== undefined && typeof o.displayName !== "string") throw new AdapterUnavailableError(`${what} has a non-string displayName`);
  if (o.fetchPinned !== undefined && typeof o.fetchPinned !== "function") throw new AdapterUnavailableError(`${what} has a non-function fetchPinned`);
  const caps = (o.getCapabilities as () => unknown).call(o) as Record<string, unknown> | null;
  const bad = CAPABILITY_NAMES.filter((n) => typeof caps?.[n] !== "object" || typeof (caps[n] as { supported?: unknown }).supported !== "boolean");
  if (bad.length > 0) throw new AdapterUnavailableError(`${what} reports no capability for ${bad.join(", ")}`);
  return v as AgentAdapter;
}

type Ctor = { new (opts?: unknown): unknown; create?: (opts?: unknown) => unknown };

/** Loads TraycerAgentAdapter; prefers a static `create(options)` and falls back to `new (options)`. */
export async function loadTraycerAdapter(opts: AdapterFactoryOptions, importer: (s: string) => Promise<unknown> = (s) => import(s)): Promise<AgentAdapter> {
  let mod: Record<string, unknown>;
  try {
    mod = (await importer(TRAYCER_MODULE)) as Record<string, unknown>;
  } catch (e) {
    throw new AdapterUnavailableError(`cannot load ${TRAYCER_MODULE}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const Cls = mod[TRAYCER_EXPORT] as Ctor | undefined;
  if (typeof Cls !== "function") {
    throw new AdapterUnavailableError(`${TRAYCER_MODULE} does not export ${TRAYCER_EXPORT} yet (use --adapter mock)`);
  }
  // Process-wide in the adapter module (focus.ts), so the constructor options stay unchanged.
  if (typeof mod.configureFocusApp === "function") (mod.configureFocusApp as (p: string | null) => void)(opts.focusApp ?? null);
  const options: Record<string, unknown> = { focusDeepLink: opts.focusDeepLink ?? false };
  if (opts.defaultModel) {
    // The adapter replaces (not merges) its model table, so keep its defaults for the other provider.
    const { provider, model } = opts.defaultModel;
    const defaults = (mod.DEFAULT_MODELS ?? {}) as Record<string, Record<string, unknown> | undefined>;
    options.models = { ...defaults, [provider]: { ...defaults[provider], harnessId: provider, model } };
  }
  if (opts.a2aSelfSend !== undefined) options.a2aSelfSend = opts.a2aSelfSend;
  if (opts.tuiRoute !== undefined) options.tuiRoute = opts.tuiRoute;
  if (opts.a2aSender !== undefined && opts.a2aSender.length > 0) options.a2aSender = opts.a2aSender.map((s) => ({ agentId: s.agentId, epicId: s.epicId }));
  const instance = typeof Cls.create === "function" ? await Cls.create(options) : new Cls(options);
  return assertAgentAdapter(instance, TRAYCER_EXPORT);
}

/** One registry entry: a short description for `--help`/doctor and the factory. */
export interface AdapterEntry {
  readonly description: string;
  create(opts: AdapterFactoryOptions): Promise<AgentAdapter>;
}

/**
 * The backends the companion can drive. Adding one is one entry here (and its package); nothing else in the companion
 * names a backend. `traycer` is the default.
 */
export const ADAPTERS = {
  mock: {
    description: "fixture-backed mock (fixtures/sessions/<name>.json), no backend",
    create: async (opts) => MockAdapter.fromFixture(fixturePath(opts.mockFixture ?? "mixed")),
  },
  traycer: {
    description: "the local Traycer host (WebSocket RPC, docs/traycer-integration.md)",
    create: (opts) => loadTraycerAdapter(opts),
  },
} as const satisfies Record<string, AdapterEntry>;

export type AdapterKind = keyof typeof ADAPTERS;
export const ADAPTER_KINDS = Object.keys(ADAPTERS) as AdapterKind[];
export const DEFAULT_ADAPTER: AdapterKind = "traycer";

export async function createAdapter(kind: AdapterKind, opts: AdapterFactoryOptions = {}): Promise<AgentAdapter> {
  const entry: AdapterEntry | undefined = (ADAPTERS as Record<string, AdapterEntry>)[kind];
  if (entry === undefined) throw new AdapterUnavailableError(`unknown adapter "${String(kind)}" (${ADAPTER_KINDS.join(" | ")})`);
  return entry.create(opts);
}

export function parseAdapterKind(v: string | undefined): AdapterKind {
  if (v === undefined) return DEFAULT_ADAPTER;
  if (Object.hasOwn(ADAPTERS, v)) return v as AdapterKind;
  throw new Error(`unknown adapter "${v}" (${ADAPTER_KINDS.join(" | ")})`);
}
