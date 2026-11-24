// Adapter step (operator brief 2026-11-18): terminal-session details from agent.getTranscript, fetchPinned outside the
// scan, parent/child links (parentKey), device copy for sessions that take no prompts, and the backend name.
import { afterEach, describe, expect, test } from "bun:test";
import { AgentConsole, PIN_CATCHUP_MS, PIN_FETCH_TASKS, sessionKey, taskKey, type PinLists, type Session, type SessionRef } from "@fm1/agent-core";
import { PROMPT_COPY, promptCapabilityFor } from "../src/agent/a2a-delivery";
import { parentKeyOf } from "../src/agent/mapping";
import type { TraycerSession } from "../src/agent/session-book";
import { parseTranscript, TAIL_CHARS, TerminalDetails, TERMINAL_POKE_MIN_MS } from "../src/agent/terminal-transcript";
import type { NormalizedAgent } from "../src/normalize";
import { chatRecord, HOST, makeHarness, standardWorld, until, type Harness } from "./scenario";

let h: Harness | null = null;
afterEach(async () => {
  await h?.dispose();
  h = null;
});

const ALPHA = "ws:/Users/me/dev/alpha";
const ref = (taskId: string, sessionId: string, projectId = ALPHA): SessionRef => ({ backendId: "traycer", hostId: HOST, projectId, taskId, sessionId });
const transcriptCalls = (harness: Harness) => harness.host.requests.filter((r) => r.method === "agent.getTranscript");
const lastUpsert = (harness: Harness, id: string): TraycerSession | undefined => {
  const e = [...harness.events].reverse().find((x) => x.type === "session_upserted" && x.session.ref.sessionId === id);
  return e?.type === "session_upserted" ? (e.session as TraycerSession) : undefined;
};

const TRANSCRIPT = [
  "<user_message>\nFirst question?\n</user_message>\n\n<assistant_response>\nOld answer.\n</assistant_response>\n\n",
  "<user_message>\n<summary>ignored</summary>Please plan the **backlog** migration. API_TOKEN=abc123secretvalue\n</user_message>\n\n",
  "<assistant_response>\n[assistant row 7]\n## Plan\nMove the `backlog` table in 3 steps — dry run first. Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop\n</assistant_response>\n",
].join("");

describe("parseTranscript", () => {
  test("last answer and last user message, markdown stripped, secrets redacted, ASCII, capped", () => {
    const p = parseTranscript(TRANSCRIPT);
    expect(p.lastMessage).toBe("Plan Move the backlog table in 3 steps - dry run first. Bearer <redacted>");
    expect(p.lastPrompt).toBe("Please plan the backlog migration. API_TOKEN=<redacted>");
    const long = parseTranscript(`<assistant_response>${"word ".repeat(400)}</assistant_response>`);
    expect(long.lastMessage!.length).toBeLessThanOrEqual(600);
  });

  test("an a2a task notification reads as the prompt it carries", () => {
    const t =
      "<user_message>\n<task-notification>\n<task-id>x</task-id>\n<summary>Monitor event</summary>\n<event>[traycer:agent-message] from FM1 Console (agent a) [claude]\n[traycer:agent-message] No reply is required.\nReport status.\n[traycer:agent-message] --- end of message ---</event>\n</task-notification>\n</user_message>\n";
    expect(parseTranscript(t)).toEqual({ lastPrompt: "Report status." });
  });

  test("only the tail is parsed; a block cut off by the tail is ignored; empty transcript gives nothing", () => {
    const old = "<assistant_response>\nancient\n</assistant_response>";
    expect(parseTranscript(`${old}${"x".repeat(TAIL_CHARS)}`)).toEqual({});
    expect(parseTranscript(`<assistant_response>${"y".repeat(TAIL_CHARS)}</assistant_response>`)).toEqual({});
    expect(parseTranscript("")).toEqual({});
  });
});

describe("TerminalDetails (fake clock)", () => {
  function rig(text: () => string | null) {
    let now = 1_000;
    const timers: Array<() => void> = [];
    const applied: Array<{ id: string; lastMessage?: string; lastBlocks?: unknown; lastMessageAt?: number; lastPrompt?: string }> = [];
    let calls = 0;
    const t = new TerminalDetails(
      {
        transcript: async () => {
          calls++;
          return text();
        },
        apply: (_e, id, d) => applied.push({ id, ...d }),
        updatedAt: () => 500,
        now: () => now,
        setInterval: (fn) => {
          timers.push(fn);
          return timers.length - 1;
        },
        clearInterval: (i) => {
          timers[i as number] = () => undefined;
        },
      },
      15_000,
    );
    return { t, applied, timers, calls: () => calls, advance: (ms: number) => (now += ms) };
  }

  test("fetch on start; refresh tick; first answer dated by the record, a changed answer by now; unchanged keeps its time", async () => {
    let text = "<assistant_response>A</assistant_response>";
    const r = rig(() => text);
    const release = r.t.start("e", "t");
    await Bun.sleep(0);
    expect(r.applied.at(-1)).toEqual({ id: "t", lastMessage: "A", lastBlocks: [{ kind: "para", inline: [{ text: "A" }] }], lastMessageAt: 500 });
    r.advance(15_000);
    r.timers[0]?.();
    await Bun.sleep(0);
    expect(r.applied.at(-1)?.lastMessageAt).toBe(500);
    text = "<assistant_response>B</assistant_response>";
    r.timers[0]?.();
    await Bun.sleep(0);
    expect(r.applied.at(-1)).toEqual({ id: "t", lastMessage: "B", lastBlocks: [{ kind: "para", inline: [{ text: "B" }] }], lastMessageAt: 16_000 });
    release();
    expect(r.t.watching).toBeNull();
    const n = r.calls();
    r.timers[0]?.();
    await Bun.sleep(0);
    expect(r.calls()).toBe(n);
  });

  test("poke fetches the watched session only, at most once per window; a null transcript applies nothing", async () => {
    const r = rig(() => null);
    r.t.start("e", "t");
    await Bun.sleep(0);
    expect(r.calls()).toBe(1);
    r.t.poke("e", "other");
    r.t.poke("e", "t");
    r.t.poke("e", "t");
    await Bun.sleep(0);
    expect(r.calls()).toBe(2);
    r.advance(TERMINAL_POKE_MIN_MS);
    r.t.poke("e", "t");
    await Bun.sleep(0);
    expect(r.calls()).toBe(3);
    expect(r.applied).toEqual([]);
  });
});

describe("terminal session details through the adapter", () => {
  function world(transcript: () => string) {
    const w = standardWorld();
    w.overrides["agent.getTranscript"] = () => ({ result: { transcript: transcript() } });
    return w;
  }

  test("watchSession on a terminal agent reads its transcript and fills details and summary; GUI chats never call it", async () => {
    h = makeHarness({ world: world(() => TRANSCRIPT), config: { terminalRefreshMs: 60_000 } });
    await h.adapter.connect();
    await h.adapter.listSessions("e1");
    const release = h.adapter.watchSession(ref("e1", "t1"));
    await until(() => lastUpsert(h!, "t1")?.details?.lastMessage !== undefined, 2_000, "terminal details");
    const s = lastUpsert(h, "t1")!;
    expect(s.details?.lastMessage).toStartWith("Plan Move the backlog table");
    expect(s.details?.lastPrompt).toContain("backlog migration");
    expect(s.summary).toStartWith("Plan Move the backlog");
    expect(h.adapter.diagnostics().lastTranscript).toEqual({ session: "e1/t1", chars: TRANSCRIPT.length });
    expect(transcriptCalls(h).map((r) => r.params)).toEqual([{ epicId: "e1", agentId: "t1" }]);
    release();
    h.adapter.watchSession(ref("e1", "c2"));
    await Bun.sleep(30);
    expect(transcriptCalls(h)).toHaveLength(1);
  });

  test("an a2a reply is raw transcript text: it is redacted, ASCII and capped before it leaves the adapter", async () => {
    h = makeHarness({ world: standardWorld() });
    await h.adapter.connect();
    await h.adapter.listSessions("e1");
    const raw = `## Done\nAPI_TOKEN=abc123secretvalue — “quoted” FM1_SMOKE_A2A_MI5ABCDEF ${"word ".repeat(400)}`;
    (h.adapter as unknown as { book: { setReply(e: string, a: string, r: { requestId: string; text: string; at: number }): void } }).book.setReply("e1", "t1", { requestId: "rq", text: raw, at: 9 });
    const d = lastUpsert(h, "t1")?.details;
    expect(d?.reply?.requestId).toBe("rq");
    expect(d?.reply?.text).toStartWith('Done API_TOKEN=<redacted> - "quoted" FM1_SMOKE_A2A_MI5ABCDEF word');
    expect(d?.reply?.text.length).toBeLessThanOrEqual(600);
    expect(d?.reply?.text).toMatch(/^[\x20-\x7e]*$/);
    expect(d?.lastMessage).toBe(d?.reply?.text);
    expect(JSON.stringify(d)).not.toContain("abc123secretvalue");
  });

  test("refreshes while selected (terminalRefreshMs) and stops when the selection moves", async () => {
    let n = 0;
    h = makeHarness({ world: world(() => `<assistant_response>answer ${++n}</assistant_response>`), config: { terminalRefreshMs: 40 } });
    await h.adapter.connect();
    await h.adapter.listSessions("e1");
    h.adapter.watchSession(ref("e1", "t1"));
    await until(() => transcriptCalls(h!).length >= 3, 2_000, "refreshes");
    expect(lastUpsert(h, "t1")?.details?.lastMessage).toMatch(/^answer \d+$/);
    h.adapter.watchSession(ref("e1", "c1"));
    const calls = transcriptCalls(h).length;
    await Bun.sleep(120);
    expect(transcriptCalls(h).length).toBeLessThanOrEqual(calls + 1);
  });

  test("a state change of the watched terminal re-reads at once", async () => {
    h = makeHarness({ world: world(() => TRANSCRIPT), config: { terminalRefreshMs: 60_000 } });
    await h.adapter.connect();
    await h.adapter.listSessions("e1");
    h.adapter.watchSession(ref("e1", "t1"));
    await until(() => transcriptCalls(h!).length === 1, 2_000, "first read");
    await Bun.sleep(TERMINAL_POKE_MIN_MS + 50);
    // The record feed reports the TUI stopped: a state change of the watched session.
    h.world.tuis[0]!.sessionState = "stopped";
    await (h.adapter as unknown as { loadAgents(e: string, a: boolean): Promise<boolean> }).loadAgents("e1", true);
    await until(() => transcriptCalls(h!).length >= 2, 2_000, "re-read on state change");
  }, 10_000);
});

describe("fetchPinned outside the 25-task scan", () => {
  function pinWorld() {
    const w = standardWorld();
    w.tasks.push({ epicId: "e3", title: "Old task", workspace: "/Users/me/dev/alpha", updatedAt: 1 });
    w.chats.push({ epicId: "e3", chatId: "c9", title: "Old chat", harnessId: "claude", model: "haiku" });
    w.chats.push({ epicId: "e3", chatId: "c10", title: "Archived chat", harnessId: "claude", model: "haiku", archived: true });
    return w;
  }

  test("pinned sessions and every session of a pinned task come back; deleted/archived pins are gone; unknown stays", async () => {
    h = makeHarness({ world: pinWorld(), config: { sessionScanLimit: 1 } });
    await h.adapter.connect();
    const scanned = await h.adapter.listSessions();
    expect(scanned.some((s) => s.ref.taskId === "e3")).toBe(false);
    const r = await h.adapter.fetchPinned({
      sessions: [ref("e3", "c9"), ref("e3", "c10"), ref("e3", "deleted-chat"), { ...ref("e3", "x"), hostId: "other-host" }],
      tasks: [{ backendId: "traycer", hostId: HOST, projectId: "repo:acme/beta", taskId: "e2" }],
    });
    expect(r.sessions.map((s) => s.ref.sessionId).sort()).toEqual(["c3", "c9"]);
    expect(r.tasks.map((t) => t.ref.taskId)).toEqual(["e2"]);
    expect(r.gone.sort()).toEqual([sessionKey(ref("e3", "c10")), sessionKey(ref("e3", "deleted-chat"))].sort());
  });

  test("a task missing from a complete task listing is gone (its session and task pins); a read failure keeps pins", async () => {
    const w = pinWorld();
    h = makeHarness({ world: w, config: { sessionScanLimit: 1 } });
    await h.adapter.connect();
    await h.adapter.listSessions();
    w.tasks = w.tasks.filter((t) => t.epicId !== "e3");
    await h.adapter.listTasks(); // the console's resync lists tasks right before it asks for pins
    const gone = await h.adapter.fetchPinned({ sessions: [ref("e3", "c9")], tasks: [{ backendId: "traycer", hostId: HOST, projectId: ALPHA, taskId: "e3" }] });
    expect(gone.gone.sort()).toEqual([sessionKey(ref("e3", "c9")), taskKey({ backendId: "traycer", hostId: HOST, projectId: ALPHA, taskId: "e3" })].sort());
    w.overrides["epic.listChatRecords"] = (p) => (p.epicId === "e1" ? { error: { code: "INTERNAL", message: "busy" } } : undefined);
    const kept = await h.adapter.fetchPinned({ sessions: [ref("e1", "c1")], tasks: [] });
    expect(kept).toEqual({ sessions: [], tasks: [], gone: [] });
    // An answer that is not a full snapshot lists nothing for some other reason: the pins stay.
    w.overrides["epic.listChatRecords"] = (p) => (p.epicId === "e1" ? { result: { kind: "unchanged", listStamp: null } as never } : undefined);
    const notSnapshot = await h.adapter.fetchPinned({ sessions: [ref("e1", "c1")], tasks: [] });
    expect(notSnapshot).toEqual({ sessions: [], tasks: [], gone: [] });
  });

  test("rejects while disconnected, so the console keeps every pin", async () => {
    h = makeHarness({ world: pinWorld() });
    await expect(h.adapter.fetchPinned({ sessions: [ref("e3", "c9")], tasks: [] })).rejects.toThrow("disconnected");
  });

  test("end to end with AgentConsole: a pin outside the scan is shown and kept; a deleted one is dropped", async () => {
    h = makeHarness({ world: pinWorld(), config: { sessionScanLimit: 1, firstActivityWaitMs: 0 } });
    const pins = [sessionKey(ref("e3", "c9")), sessionKey(ref("e3", "deleted-chat"))];
    const changed: PinLists[] = [];
    const c = new AgentConsole({ adapter: h.adapter, pins, onPinsChanged: (p) => changed.push(p) });
    await c.start();
    expect(c.registry.get(pins[0]!)?.stale).toBe(false);
    expect(c.state.pins).toEqual([pins[0]]);
    expect(changed).toEqual([{ sessions: [pins[0]!], tasks: [] }]);
    await c.stop();
  });

  /** 30 tasks outside the scan (f00..f29), 3 chats each. */
  function farWorld() {
    const w = pinWorld();
    for (let i = 0; i < 30; i++) {
      const epicId = `f${String(i).padStart(2, "0")}`;
      w.tasks.push({ epicId, title: `Far ${i}`, workspace: "/Users/me/dev/alpha", updatedAt: 0 });
      for (let j = 0; j < 3; j++) w.chats.push({ epicId, chatId: `${epicId}c${j}`, title: `Far chat ${i}.${j}`, harnessId: "claude", model: "haiku" });
    }
    return w;
  }
  const reads = (harness: Harness, method: string, from = 0) => harness.host.requests.slice(from).filter((r) => r.method === method);
  const epicOf = (r: { params?: unknown }) => (r.params as { epicId?: string } | undefined)?.epicId ?? "";

  test("many pins, one batch: each task is read once, whatever the number of pins in it (fake host)", async () => {
    h = makeHarness({ world: farWorld(), config: { sessionScanLimit: 1 } });
    await h.adapter.connect();
    await h.adapter.listSessions();
    const from = h.host.requests.length;
    const sessions = Array.from({ length: 90 }, (_, n) => ref(`f${String(Math.floor(n / 3)).padStart(2, "0")}`, `f${String(Math.floor(n / 3)).padStart(2, "0")}c${n % 3}`));
    const tasks = Array.from({ length: 30 }, (_, i) => ({ backendId: "traycer", hostId: HOST, projectId: ALPHA, taskId: `f${String(i).padStart(2, "0")}` }));
    const r = await h.adapter.fetchPinned({ sessions, tasks });
    expect(r.sessions).toHaveLength(90);
    expect(r.gone).toEqual([]);
    // 120 pins in 30 tasks: 30 chat listings and 30 terminal listings, one per task (not one per pin)
    expect(reads(h, "epic.listChatRecords", from)).toHaveLength(30);
    expect(reads(h, "epic.listTuiAgents", from)).toHaveLength(30);
    expect(new Set(reads(h, "epic.listChatRecords", from).map(epicOf)).size).toBe(30);
    expect(h.host.requests.length - from).toBeLessThanOrEqual(30 * 3 + 1); // + run settings per task, + at most one task listing
  });

  test("pinned tasks outside the scan do not join the fallback poll (its cost does not grow with pins)", async () => {
    h = makeHarness({ world: farWorld(), config: { sessionScanLimit: 1 } });
    await h.adapter.connect();
    await h.adapter.listSessions();
    const tasks = Array.from({ length: 30 }, (_, i) => ({ backendId: "traycer", hostId: HOST, projectId: ALPHA, taskId: `f${String(i).padStart(2, "0")}` }));
    await h.adapter.fetchPinned({ sessions: [], tasks });
    const from = h.host.requests.length;
    // the fallback poller (live feeds dead) re-reads every polled task each round
    await (h.adapter as unknown as { pollOnce(): Promise<boolean> }).pollOnce();
    const polled = reads(h, "epic.listChatRecords", from).map(epicOf);
    expect(polled.length).toBeGreaterThan(0);
    expect(polled.filter((e) => e.startsWith("f"))).toEqual([]);
  });

  test("end to end: the console asks for at most 25 tasks per refresh and catches up on its slow cadence", async () => {
    h = makeHarness({ world: farWorld(), config: { sessionScanLimit: 1 } });
    let now = 1_900_000_000_000;
    const pins = Array.from({ length: 90 }, (_, n) => sessionKey(ref(`f${String(Math.floor(n / 3)).padStart(2, "0")}`, `f${String(Math.floor(n / 3)).padStart(2, "0")}c${n % 3}`)));
    const c = new AgentConsole({ adapter: h.adapter, pins, now: () => now });
    const from = h.host.requests.length;
    await c.start();
    await c.idle();
    const farReads = () => reads(h!, "epic.listChatRecords", from).filter((r) => epicOf(r).startsWith("f"));
    const afterStart = farReads().length;
    // every resync of the start asks for one batch of at most 25 tasks
    expect(afterStart).toBeGreaterThan(0);
    expect(afterStart % PIN_FETCH_TASKS).toBe(0);
    expect(afterStart).toBeLessThanOrEqual(2 * PIN_FETCH_TASKS);
    c.tick(now);
    await c.idle();
    expect(farReads()).toHaveLength(afterStart); // not due yet
    now += PIN_CATCHUP_MS;
    c.tick(now);
    await c.idle();
    expect(farReads().length - afterStart).toBe(5); // the last 5 tasks
    expect(new Set(farReads().map(epicOf)).size).toBe(30);
    expect(pins.every((k) => c.registry.get(k)?.stale === false)).toBe(true);
    expect(c.state.pins).toHaveLength(90);
    await c.stop();
  });
});

describe("parentKey from Traycer parent links", () => {
  test("chat parentChatId and TUI parentId become the parent's session key in the same task", async () => {
    const w = standardWorld();
    w.overrides["epic.listChatRecords"] = (p) =>
      p.epicId === "e1"
        ? {
            result: {
              kind: "snapshot",
              listStamp: null,
              chats: w.chats.filter((c) => c.epicId === "e1").map((c) => ({ ...chatRecord(c), parentChatId: c.chatId === "c2" ? "c1" : null })),
            },
          }
        : undefined;
    w.overrides["epic.listTuiAgents"] = (p) =>
      p.epicId === "e1"
        ? {
            result: {
              kind: "snapshot",
              listStamp: null,
              tuiAgents: [{ origin: "own", tuiAgentId: "t1", ownerUserId: "u", hostId: HOST, harnessId: "claude", parentId: "c2", title: "Terminal", isTitleEditedByUser: false, createdAt: 3, updatedAt: 4, archived: false, revision: 1, sessionState: "running", lastExit: null }],
            },
          }
        : undefined;
    h = makeHarness({ world: w });
    await h.adapter.connect();
    const sessions = await h.adapter.listSessions("e1");
    const by = (id: string): Session | undefined => sessions.find((s) => s.ref.sessionId === id);
    expect(by("c1")?.parentKey).toBeUndefined();
    expect(by("c2")?.parentKey).toBe(sessionKey(ref("e1", "c1")));
    expect(by("t1")?.parentKey).toBe(sessionKey(ref("e1", "c2")));
  });

  test("parentKeyOf drops a missing or self parent", () => {
    const tr = { backendId: "traycer", hostId: HOST, projectId: ALPHA, taskId: "e1" };
    expect(parentKeyOf({ agentId: "a", parentId: null }, tr)).toBeUndefined();
    expect(parentKeyOf({ agentId: "a", parentId: "a" }, tr)).toBeUndefined();
    expect(parentKeyOf({ agentId: "a", parentId: " p " }, tr)).toBe(sessionKey(ref("e1", "p")));
  });
});

describe("device copy and backend name", () => {
  const agent = (over: Partial<NormalizedAgent>): NormalizedAgent => ({
    epicId: "e1", agentId: "t", surface: "tui", harnessId: "claude", model: null, reasoningEffort: null, permissionMode: null, profileId: null,
    title: "T", parentId: null, hostId: HOST, ownerUserId: "u", archived: false, sessionState: "running", createdAt: 1, updatedAt: 2, ...over,
  });

  test("typing route (default): Claude and Codex terminals take prompts; Claude keeps the a2a fallback", () => {
    expect(promptCapabilityFor(agent({ harnessId: "codex" }), { senders: [], selfSend: true })).toEqual({ acceptsPrompt: true, via: "terminal.write" });
    expect(promptCapabilityFor(agent({}), { senders: [], selfSend: true })).toEqual({ acceptsPrompt: true, via: "terminal.write", fallbackVia: "agent.sendMessage", senderAgentId: "t" });
    expect(promptCapabilityFor(agent({}), { senders: [], selfSend: false, tuiRoute: "type" })).toEqual({ acceptsPrompt: true, via: "terminal.write" });
    // Other harnesses: no recognized prompt, no a2a -> still no prompts, with the harness copy.
    expect(promptCapabilityFor(agent({ harnessId: "opencode" }), { senders: [], selfSend: true })).toMatchObject({ acceptsPrompt: false, line: "Terminal: open on Mac" });
  });

  test("a2a route: Codex terminal: 'Codex terminal: open on Mac' (<= 28) and a toast <= 20; no sender: its own copy", () => {
    const a2a = { tuiRoute: "a2a" as const };
    const codex = promptCapabilityFor(agent({ harnessId: "codex" }), { senders: [], selfSend: true, ...a2a });
    expect(codex).toMatchObject({ acceptsPrompt: false, line: "Codex terminal: open on Mac", toast: "Terminal: use Mac" });
    expect(codex.line!.length).toBeLessThanOrEqual(28);
    expect(promptCapabilityFor(agent({ harnessId: null }), { senders: [], selfSend: true, ...a2a }).line).toBe("Agent terminal: open on Mac");
    // A harness name too long for 28 columns falls back to the generic line instead of a mid-word cut.
    expect(promptCapabilityFor(agent({ harnessId: "opencode" }), { senders: [], selfSend: true, ...a2a }).line).toBe("Terminal: open on Mac");
    const none = promptCapabilityFor(agent({}), { senders: [], selfSend: false, ...a2a });
    expect(none).toMatchObject({ acceptsPrompt: false, ...PROMPT_COPY.noSender });
    for (const c of [PROMPT_COPY.noSender, PROMPT_COPY.lost]) {
      expect(c.line.length).toBeLessThanOrEqual(28);
      expect(c.toast.length).toBeLessThanOrEqual(20);
    }
    expect(promptCapabilityFor(agent({}), { senders: [], selfSend: true, ...a2a })).toEqual({ acceptsPrompt: true, via: "agent.sendMessage", senderAgentId: "t" });
  });

  test("displayName is Traycer; lastActivityAt is filled by the adapter itself", async () => {
    h = makeHarness({ world: standardWorld() });
    expect(h.adapter.displayName).toBe("Traycer");
    await h.adapter.connect();
    const sessions = await h.adapter.listSessions("e1");
    for (const s of sessions) expect(typeof s.lastActivityAt).toBe("number");
  });
});
