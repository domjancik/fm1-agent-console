// ~/.config/fm1-console/config.json. Settings only: tokens and other secrets are never stored here.
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CANNED_MAX, CANNED_TEXT_MAX, cannedKey, cannedText, READ_ALOUD_SUMMARY_CHARS, seedCanned, sortCanned, type CannedEntry } from "@fm1/agent-core";
import { DEFAULT_KEEP_RECORDINGS, parseKeepRecordings, type KeepRecordingsConfig } from "./voice/recordings";

export type AsrEngineId = "sherpa" | "apple";
export type ProviderId = "claude" | "codex";
/** The screen of a list view with protocol version 5 (docs/ui-v3.md sections 8.7 and 9.12); Grouped: Sessions only. */
export type ScreenLayoutId = "buddy" | "list" | "grouped";
export interface LayoutsConfig {
  sessions: ScreenLayoutId;
  inbox: Exclude<ScreenLayoutId, "grouped">;
}
/** SETTINGS on the device (protocol version 6, docs/ui-v3.md section 10.2). */
export type KeysId = "ranked" | "split";
export interface SettingsConfig {
  keys: KeysId;
}
/** The SPLIT choice and task page (docs/ui-v3.md section 10.10). `task` is a task key exactly when `chosen` is "task". */
export type SplitChoiceId = "all" | "pinned" | "needs" | "task";
export interface SplitConfig {
  chosen: SplitChoiceId;
  task: string | null;
  taskPage: number;
}

export interface CompanionConfig {
  /** fm1-mic device UID; null = system default input. */
  micDeviceUid: string | null;
  asrEngine: AsrEngineId;
  language: string;
  /** Vocabulary correction JSON; null = the bundled default list. */
  vocabularyFile: string | null;
  /** Use the traycer:// deep link for focus when Desktop supports it (needs the upstream change). */
  focusDeepLink: boolean;
  /**
   * Absolute path to a side-by-side patched Traycer Desktop (.app) that handles the deep link,
   * e.g. ".../traycer-patched/out/Traycer FM1.app". With focusDeepLink on, focus sends the link to
   * this app (`open -a`) when it is running; null = stock behaviour.
   */
  focusApp: string | null;
  defaults: { provider: ProviderId; model: string | null };
  /**
   * Pinned session keys (5 parts) and, kept apart, pinned task keys (4 parts): no limit but a safety cap of
   * MAX_PINS_PER_KIND (200) each (operator decision 2026-11-19; docs/ui-v3.md section 9.6). Local only; never sent to the
   * backend. A legacy `pins` list (one mixed list, at most 9) is read and split by key shape; it is never written.
   */
  sessionPins: string[];
  taskPins: string[];
  /**
   * Buddy or List per view (SEQ, protocol version 5; docs/ui-v3.md section 8.7). Saved only when it differs from
   * DEFAULT_LAYOUTS, so a config written by this companion stays readable by an older one until a layout is changed.
   */
  layouts: LayoutsConfig;
  /**
   * Traycer a2a prompts to Claude terminal agents (operator decision 2026-11-18, option B): with no `a2aSender` for the
   * receiver's task, send as the receiver itself. Default true; saved only when false.
   */
  a2aSelfSend: boolean;
  /** Per-task sender agents for a2a prompts (`{agentId, epicId}`, an agent of the user's in that task). Default none. */
  a2aSender: A2aSenderConfig[];
  /**
   * How console prompts reach terminal (TUI) agents (operator decision 2026-11-19): `type` types them into the agent's
   * Traycer terminal (Claude and Codex; Claude falls back to a2a when nothing could be typed), `a2a` uses Traycer a2a
   * only. Default `type`; saved only when `a2a`.
   */
  tuiRoute: "type" | "a2a";
  /** SETTINGS values (Keys Ranked/Split). Saved only when they differ from DEFAULT_SETTINGS. */
  settings: SettingsConfig;
  /** The SPLIT choice and task page, restored on start. Saved only when they differ from DEFAULT_SPLIT_CONFIG. */
  split: SplitConfig;
  /** Voice diagnostics (operator decision 2026-11-19: keep the last takes, with a TTL). Saved only when not the default. */
  voice: VoiceConfig;
  /**
   * Canned responses (docs/ui-v3.md section 12): at most CANNED_MAX (50), text at most 2000 characters (trimmed,
   * ASCII-folded), sorted uses desc then createdAt desc. A config without the key gets the three seed entries; once
   * the key exists (even empty) it is never seeded again. Always written.
   */
  canned: CannedEntry[];
  /** Read aloud (hold PLAY; docs/ui-v3.md section 14). Saved only when it differs from DEFAULT_READ_ALOUD. */
  readAloud: ReadAloudConfig;
}

/** Read aloud: the Kokoro-FastAPI TTS server and voice, when to summarize, and the Docker image started when it is down. */
export interface ReadAloudConfig {
  /** Kokoro voice id (GET /v1/audio/voices), e.g. "af_heart"; Kokoro mixes like "af_heart+af_bella" are accepted. */
  voice: string;
  /** Base URL of the OpenAI-compatible Kokoro-FastAPI server (POST /v1/audio/speech, GET /health). */
  kokoroUrl: string;
  /** Speech text longer than this is summarized on-device (fm1-summarize) before it is read. 100-2000. */
  summarizeOverChars: number;
  /** Image of the container started (`docker run`) when no container of it exists; an existing one is `docker start`ed. */
  dockerImage: string;
}

export interface VoiceConfig {
  keepRecordings: KeepRecordingsConfig;
}

export interface A2aSenderConfig {
  agentId: string;
  epicId: string;
}

export const DEFAULT_LAYOUTS: Readonly<LayoutsConfig> = { sessions: "grouped", inbox: "list" };
export const DEFAULT_SETTINGS: Readonly<SettingsConfig> = { keys: "ranked" };
export const DEFAULT_SPLIT_CONFIG: Readonly<SplitConfig> = { chosen: "all", task: null, taskPage: 0 };
export const DEFAULT_READ_ALOUD: Readonly<ReadAloudConfig> = {
  voice: "af_heart",
  kokoroUrl: "http://127.0.0.1:8880",
  summarizeOverChars: READ_ALOUD_SUMMARY_CHARS,
  dockerImage: "ghcr.io/remsky/kokoro-fastapi-cpu:latest",
};

/** Safety cap per pin kind (agent-core focus.ts MAX_PINS_PER_KIND). */
export const MAX_PINS_PER_KIND = 200;

export const DEFAULT_CONFIG: CompanionConfig = {
  micDeviceUid: null,
  asrEngine: "sherpa",
  language: "en",
  vocabularyFile: null,
  focusDeepLink: false,
  focusApp: null,
  defaults: { provider: "claude", model: null },
  sessionPins: [],
  taskPins: [],
  layouts: { ...DEFAULT_LAYOUTS },
  a2aSelfSend: true,
  a2aSender: [],
  tuiRoute: "type",
  settings: { ...DEFAULT_SETTINGS },
  split: { ...DEFAULT_SPLIT_CONFIG },
  voice: { keepRecordings: { ...DEFAULT_KEEP_RECORDINGS } },
  canned: seedCanned(),
  readAloud: { ...DEFAULT_READ_ALOUD },
};

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.FM1_CONSOLE_CONFIG) return env.FM1_CONSOLE_CONFIG;
  const base = env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "fm1-console", "config.json");
}

const SECRET_KEY = /token|secret|password|bearer|credential|apikey|api_key/i;

export class ConfigError extends Error {
  override name = "ConfigError";
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function rejectSecrets(v: unknown, path = ""): void {
  if (!isObj(v)) return;
  for (const [k, val] of Object.entries(v)) {
    if (SECRET_KEY.test(k)) throw new ConfigError(`refusing to store "${path}${k}": config must not hold secrets`);
    rejectSecrets(val, `${path}${k}.`);
  }
}

const optString = (v: unknown, what: string): string | null => {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "string") throw new ConfigError(`${what} must be a string or null`);
  return v;
};

/** Applies a partial, validated patch. Unknown keys are rejected so typos surface. */
export function mergeConfig(base: CompanionConfig, patch: unknown): CompanionConfig {
  if (!isObj(patch)) throw new ConfigError("config must be a JSON object");
  rejectSecrets(patch);
  const out: CompanionConfig = {
    ...base,
    defaults: { ...base.defaults },
    sessionPins: [...base.sessionPins],
    taskPins: [...base.taskPins],
    layouts: { ...base.layouts },
    a2aSender: base.a2aSender.map((s) => ({ ...s })),
    settings: { ...base.settings },
    split: { ...base.split },
    voice: { keepRecordings: { ...(base.voice?.keepRecordings ?? DEFAULT_KEEP_RECORDINGS) } },
    canned: (base.canned ?? []).map((e) => ({ ...e })),
    readAloud: { ...(base.readAloud ?? DEFAULT_READ_ALOUD) },
  };
  let legacyPins: string[] | null = null;
  for (const [k, v] of Object.entries(patch)) {
    switch (k) {
      case "micDeviceUid":
        out.micDeviceUid = optString(v, k);
        break;
      case "asrEngine":
        if (v !== "sherpa" && v !== "apple") throw new ConfigError(`asrEngine must be "sherpa" or "apple"`);
        out.asrEngine = v;
        break;
      case "language":
        if (typeof v !== "string" || !/^[a-zA-Z]{2,3}([-_][a-zA-Z0-9]{2,8})*$/.test(v)) throw new ConfigError("language must be a BCP-47 tag");
        out.language = v;
        break;
      case "vocabularyFile":
        out.vocabularyFile = optString(v, k);
        break;
      case "focusDeepLink":
        if (typeof v !== "boolean") throw new ConfigError("focusDeepLink must be a boolean");
        out.focusDeepLink = v;
        break;
      case "focusApp": {
        const app = optString(v, k);
        if (app !== null && (!app.startsWith("/") || !app.replace(/\/+$/, "").endsWith(".app"))) {
          throw new ConfigError("focusApp must be an absolute path to a .app bundle");
        }
        out.focusApp = app === null ? null : app.replace(/\/+$/, "");
        break;
      }
      case "defaults": {
        if (!isObj(v)) throw new ConfigError("defaults must be an object");
        for (const [dk, dv] of Object.entries(v)) {
          if (dk === "provider") {
            if (dv !== "claude" && dv !== "codex") throw new ConfigError(`defaults.provider must be "claude" or "codex"`);
            out.defaults.provider = dv;
          } else if (dk === "model") out.defaults.model = optString(dv, "defaults.model");
          else throw new ConfigError(`unknown key defaults.${dk}`);
        }
        break;
      }
      case "pins":
        // Legacy (one mixed list, written by companions before 2026-11-19): split by key shape below, every pin kept.
        legacyPins = pinStrings(v, "pins", "session or task key strings");
        break;
      case "sessionPins": {
        const list = pinStrings(v, "sessionPins", "session key strings");
        if (list.some(isTaskPin)) throw new ConfigError("sessionPins holds session keys (5 parts); task keys go in taskPins");
        out.sessionPins = list;
        break;
      }
      case "taskPins": {
        const list = pinStrings(v, "taskPins", "task key strings");
        if (list.some((p) => !isTaskPin(p))) throw new ConfigError("taskPins holds task keys (4 parts)");
        out.taskPins = list;
        break;
      }
      case "layouts": {
        if (!isObj(v)) throw new ConfigError("layouts must be an object");
        for (const [lk, lv] of Object.entries(v)) {
          if (lk === "sessions") {
            if (lv !== "buddy" && lv !== "list" && lv !== "grouped") throw new ConfigError(`layouts.sessions must be "buddy", "list" or "grouped"`);
            out.layouts.sessions = lv;
          } else if (lk === "inbox") {
            if (lv !== "buddy" && lv !== "list") throw new ConfigError(`layouts.inbox must be "buddy" or "list"`);
            out.layouts.inbox = lv;
          } else throw new ConfigError(`unknown key layouts.${lk}`);
        }
        break;
      }
      case "a2aSelfSend":
        if (typeof v !== "boolean") throw new ConfigError("a2aSelfSend must be a boolean");
        out.a2aSelfSend = v;
        break;
      case "a2aSender":
        out.a2aSender = parseSenders(v);
        break;
      case "tuiRoute":
        if (v !== "type" && v !== "a2a") throw new ConfigError(`tuiRoute must be "type" or "a2a"`);
        out.tuiRoute = v;
        break;
      case "settings": {
        if (!isObj(v)) throw new ConfigError("settings must be an object");
        for (const [sk, sv] of Object.entries(v)) {
          if (sk === "keys") {
            if (sv !== "ranked" && sv !== "split") throw new ConfigError(`settings.keys must be "ranked" or "split"`);
            out.settings.keys = sv;
          } else throw new ConfigError(`unknown key settings.${sk}`);
        }
        break;
      }
      case "split":
        out.split = parseSplit(v, out.split);
        break;
      case "voice":
        if (!isObj(v)) throw new ConfigError("voice must be an object");
        for (const [vk, vv] of Object.entries(v)) {
          if (vk !== "keepRecordings") throw new ConfigError(`unknown key voice.${vk}`);
          out.voice.keepRecordings = parseKeepRecordings(vv, out.voice.keepRecordings, (msg) => {
            throw new ConfigError(msg);
          });
        }
        break;
      case "canned":
        out.canned = parseCanned(v);
        break;
      case "readAloud":
        out.readAloud = parseReadAloud(v, out.readAloud);
        break;
      default:
        throw new ConfigError(`unknown config key "${k}"`);
    }
  }
  if (legacyPins !== null) {
    out.sessionPins = [...new Set([...out.sessionPins, ...legacyPins.filter((p) => !isTaskPin(p))])];
    out.taskPins = [...new Set([...out.taskPins, ...legacyPins.filter(isTaskPin)])];
  }
  for (const [name, list] of [["sessionPins", out.sessionPins], ["taskPins", out.taskPins]] as const) {
    if (list.length > MAX_PINS_PER_KIND) throw new ConfigError(`${name} holds at most ${MAX_PINS_PER_KIND} entries`);
  }
  return out;
}

/** A pin list: an array of non-empty strings of at most 1024 characters, duplicates dropped (first kept). */
function pinStrings(v: unknown, name: string, what: string): string[] {
  if (!Array.isArray(v) || v.some((p) => typeof p !== "string" || p.length === 0 || p.length > 1024)) {
    throw new ConfigError(`${name} must be an array of non-empty ${what}`);
  }
  return [...new Set(v as string[])];
}

/**
 * A pin is a task pin when it has 4 parts, the console's own rule (agent-core identity.ts isTaskKey). The stricter
 * TASK_KEY below would file a malformed 4-part legacy pin (an empty part, a space) under sessionPins, the console would
 * save it back under taskPins, and the next load would refuse the whole config.
 */
const isTaskPin = (p: string): boolean => p.split("/").length === 4;

/** A task key: 4 non-empty percent-encoded parts (agent-core identity.ts taskKey). */
const TASK_KEY = /^[^/\s]+\/[^/\s]+\/[^/\s]+\/[^/\s]+$/;

/** `split`: `{chosen, task, taskPage}`; `task` a task key exactly when chosen is "task", else null; taskPage 0-126. */
function parseSplit(v: unknown, base: SplitConfig): SplitConfig {
  if (!isObj(v)) throw new ConfigError("split must be an object");
  const out: SplitConfig = { ...base };
  for (const [k, val] of Object.entries(v)) {
    if (k === "chosen") {
      if (val !== "all" && val !== "pinned" && val !== "needs" && val !== "task") throw new ConfigError(`split.chosen must be "all", "pinned", "needs" or "task"`);
      out.chosen = val;
    } else if (k === "task") {
      if (val !== null && (typeof val !== "string" || val.length > 1024 || !TASK_KEY.test(val))) throw new ConfigError("split.task must be a task key or null");
      out.task = val;
    } else if (k === "taskPage") {
      if (typeof val !== "number" || !Number.isInteger(val) || val < 0 || val > 126) throw new ConfigError("split.taskPage must be an integer 0-126");
      out.taskPage = val;
    } else throw new ConfigError(`unknown key split.${k}`);
  }
  if ((out.chosen === "task") !== (out.task !== null)) throw new ConfigError(`split.task must be a task key exactly when split.chosen is "task"`);
  return out;
}

const CANNED_KEYS = new Set(["id", "text", "uses", "createdAt", "lastUsedAt"]);

/** `canned`: `[{id, text, uses, createdAt, lastUsedAt}]`, at most 50, unique ids and texts; texts folded and trimmed. */
function parseCanned(v: unknown): CannedEntry[] {
  if (!Array.isArray(v)) throw new ConfigError("canned must be an array");
  if (v.length > CANNED_MAX) throw new ConfigError(`canned holds at most ${CANNED_MAX} entries`);
  const out: CannedEntry[] = [];
  for (const e of v) {
    if (!isObj(e) || Object.keys(e).some((k) => !CANNED_KEYS.has(k))) throw new ConfigError("canned entries are {id, text, uses, createdAt, lastUsedAt}");
    if (typeof e.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(e.id)) throw new ConfigError("canned id must be 1-64 letters, digits, - or _");
    if (typeof e.text !== "string" || e.text.trim().length > CANNED_TEXT_MAX) throw new ConfigError(`canned text must be a string of at most ${CANNED_TEXT_MAX} characters`);
    const text = cannedText(e.text);
    if (!text) throw new ConfigError("canned text must not be empty");
    const uses = e.uses ?? 0;
    if (typeof uses !== "number" || !Number.isInteger(uses) || uses < 0) throw new ConfigError("canned uses must be a non-negative integer");
    if (typeof e.createdAt !== "number" || !Number.isFinite(e.createdAt)) throw new ConfigError("canned createdAt must be a number");
    const last = e.lastUsedAt ?? null;
    if (last !== null && (typeof last !== "number" || !Number.isFinite(last))) throw new ConfigError("canned lastUsedAt must be a number or null");
    if (out.some((o) => o.id === e.id)) throw new ConfigError(`canned id ${e.id} appears twice`);
    if (out.some((o) => cannedKey(o.text) === cannedKey(text))) throw new ConfigError(`canned text appears twice: ${text.slice(0, 40)}`);
    out.push({ id: e.id, text, uses, createdAt: e.createdAt, lastUsedAt: last });
  }
  return sortCanned(out);
}

/** `readAloud`: `{voice, kokoroUrl, summarizeOverChars, dockerImage}`, each optional (the rest keep their values). */
function parseReadAloud(v: unknown, base: ReadAloudConfig): ReadAloudConfig {
  if (!isObj(v)) throw new ConfigError("readAloud must be an object");
  const out: ReadAloudConfig = { ...base };
  for (const [k, val] of Object.entries(v)) {
    if (k === "voice") {
      if (typeof val !== "string" || !/^[A-Za-z0-9_.+()-]{1,128}$/.test(val)) throw new ConfigError("readAloud.voice must be a Kokoro voice id like af_heart");
      out.voice = val;
    } else if (k === "kokoroUrl") {
      let u: URL | null = null;
      try {
        u = typeof val === "string" ? new URL(val) : null;
      } catch {
        u = null;
      }
      if (!u || (u.protocol !== "http:" && u.protocol !== "https:") || u.search || u.hash || u.username || u.password) {
        throw new ConfigError("readAloud.kokoroUrl must be an http(s) URL without query, fragment or credentials");
      }
      out.kokoroUrl = (val as string).replace(/\/+$/, "");
    } else if (k === "summarizeOverChars") {
      if (typeof val !== "number" || !Number.isInteger(val) || val < 100 || val > 2000) throw new ConfigError("readAloud.summarizeOverChars must be an integer 100-2000");
      out.summarizeOverChars = val;
    } else if (k === "dockerImage") {
      if (typeof val !== "string" || val.length > 200 || !/^[a-z0-9][a-z0-9._\/:-]*$/.test(val)) throw new ConfigError("readAloud.dockerImage must be a Docker image reference");
      out.dockerImage = val;
    } else throw new ConfigError(`unknown key readAloud.${k}`);
  }
  return out;
}

const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** `a2aSender`: one `{agentId, epicId}` or a list (at most 64, one per task), Traycer-style ids. */
function parseSenders(v: unknown): A2aSenderConfig[] {
  const list = v === null ? [] : Array.isArray(v) ? v : [v];
  if (list.length > 64) throw new ConfigError("a2aSender holds at most 64 entries");
  const out: A2aSenderConfig[] = [];
  for (const s of list) {
    if (!isObj(s) || Object.keys(s).some((k) => k !== "agentId" && k !== "epicId")) throw new ConfigError("a2aSender entries are {agentId, epicId}");
    if (typeof s.agentId !== "string" || !AGENT_ID.test(s.agentId) || typeof s.epicId !== "string" || !AGENT_ID.test(s.epicId)) {
      throw new ConfigError("a2aSender agentId and epicId must be Traycer ids");
    }
    if (out.some((o) => o.epicId === s.epicId)) throw new ConfigError(`a2aSender names task ${s.epicId} twice`);
    out.push({ agentId: s.agentId, epicId: s.epicId });
  }
  return out;
}

export async function loadConfig(path = configPath()): Promise<CompanionConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_CONFIG;
    throw e;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`${path}: invalid JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  return mergeConfig(DEFAULT_CONFIG, raw);
}

/**
 * The running companion's view of `canned` on disk (docs/ui-v3.md section 12): returns the list when the config file
 * changed (mtime) since the last call, else null. The CLI edits the file directly; the companion calls this before
 * every device input, so its next save (which writes the whole config) carries the CLI's edit instead of undoing it.
 * The first call always reads. A missing file gives null.
 */
export function cannedReloader(path = configPath()): () => Promise<CannedEntry[] | null> {
  let seen: number | null = null;
  return async () => {
    let mtime: number;
    try {
      mtime = (await stat(path)).mtimeMs;
    } catch {
      return null;
    }
    if (seen !== null && mtime === seen) return null;
    seen = mtime;
    return (await loadConfig(path)).canned;
  };
}

/** Atomic write (temp file + rename), mode 0600. */
export async function saveConfig(cfg: CompanionConfig, path = configPath()): Promise<void> {
  const clean = mergeConfig(DEFAULT_CONFIG, cfg);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(serializable(clean), null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

/**
 * What saveConfig writes: `layouts`, `a2aSelfSend`, `a2aSender` and `tuiRoute` only when they differ from the defaults (docs/ui-v3.md
 * section 8.7), so a config written by this companion stays readable by an older one until one of them is changed.
 */
export function serializable(cfg: CompanionConfig): Partial<CompanionConfig> {
  const { layouts, a2aSelfSend, a2aSender, tuiRoute, settings, split, sessionPins, taskPins, voice, canned, readAloud, ...rest } = cfg;
  const out: Partial<CompanionConfig> = { ...rest };
  // Canned responses (docs/ui-v3.md section 12): always written, even empty, so a removed seed never comes back.
  out.canned = (canned ?? []).map((e) => ({ ...e }));
  // Pins: two lists, each written only when not empty (the legacy `pins` is never written; an older companion refuses
  // these keys, so a config with pins saved by this companion needs this companion or later).
  if (sessionPins.length > 0) out.sessionPins = [...sessionPins];
  if (taskPins.length > 0) out.taskPins = [...taskPins];
  // (docs/ui-v3.md sections 10.2 and 10.10: an older companion refuses unknown keys, so the defaults are not written)
  if (settings.keys !== DEFAULT_SETTINGS.keys) out.settings = { ...settings };
  if (split.chosen !== DEFAULT_SPLIT_CONFIG.chosen || split.task !== DEFAULT_SPLIT_CONFIG.task || split.taskPage !== DEFAULT_SPLIT_CONFIG.taskPage) out.split = { ...split };
  if (layouts.sessions !== DEFAULT_LAYOUTS.sessions || layouts.inbox !== DEFAULT_LAYOUTS.inbox) out.layouts = { ...layouts };
  if (a2aSelfSend !== DEFAULT_CONFIG.a2aSelfSend) out.a2aSelfSend = a2aSelfSend;
  if (a2aSender.length > 0) out.a2aSender = a2aSender.map((s) => ({ ...s }));
  if (tuiRoute !== DEFAULT_CONFIG.tuiRoute) out.tuiRoute = tuiRoute;
  const keep = voice?.keepRecordings ?? DEFAULT_KEEP_RECORDINGS;
  const ra = readAloud ?? DEFAULT_READ_ALOUD;
  if ((Object.keys(DEFAULT_READ_ALOUD) as (keyof ReadAloudConfig)[]).some((k) => ra[k] !== DEFAULT_READ_ALOUD[k])) out.readAloud = { ...ra };
  if (keep.count !== DEFAULT_KEEP_RECORDINGS.count || keep.ttlHours !== DEFAULT_KEEP_RECORDINGS.ttlHours || keep.dir !== DEFAULT_KEEP_RECORDINGS.dir) out.voice = { keepRecordings: { ...keep } };
  return out;
}
