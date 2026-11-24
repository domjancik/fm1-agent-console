import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allSupported, initialComposer, initialController, MockAdapter, fixturePath, pinLists, type DeviceView, type TextRow } from "@fm1/agent-core";
import { FakeClock, LoopbackPair, type MidiPorts, type MidiTransport } from "@fm1/device-protocol";
import { assertAgentAdapter, loadTraycerAdapter, AdapterUnavailableError } from "../src/adapters";
import { DEFAULT_CONFIG, loadConfig, mergeConfig, saveConfig, ConfigError } from "../src/config";
import { DiagLog, redact } from "../src/diag-log";
import { DeviceHost } from "../src/device/device-host";
import { diffFrames, framesFor, fullFrames, textFrames } from "../src/device/render";
import { PortWatcher } from "../src/device/port-watcher";
import { AmbiguousPortError, checkExact, classifyPorts, type PortDriver } from "../src/device/ports";
import { feedbackFor } from "../src/feedback";
import { firmwareCheck, parseIoreg } from "../src/doctor/checks";
import { firmwareVerify, isAllowlisted, testTraycer } from "../src/cli/delegate";
import { StageRelay } from "../src/stage-relay";
import { levelFromRms } from "../src/voice/capture";
import { traycerEnv } from "../src/proc";

function view(over: Partial<DeviceView> = {}): DeviceView {
  return {
    view: "sessions",
    page: 0,
    pages: 1,
    title: "ACTIVE 0",
    slots: Array.from({ length: 27 }, () => ({ state: "empty" as const, label: "", selected: false, provider: null, stale: false, pinned: false })),
    detail: { provider: null, state: "empty", lines: ["", "", "", ""] },
    voice: { state: "ready", level: 0, elapsedDs: 0, target: "" },
    legend: ["SHOW", "REPO", "TASK", "TALK"],
    status: { link: "ok", attentionCount: 0, text: "" },
    text: null,
    layout: null,
    ...over,
  };
}

describe("render", () => {
  test("full resync is SET_VIEW, 27 SET_SLOT, DETAIL, LEGEND, VOICE, STATUS", () => {
    const kinds = fullFrames(view()).map((f) => f.kind);
    expect(kinds).toHaveLength(32);
    expect(kinds[0]).toBe("SET_VIEW");
    expect(kinds.slice(1, 28).every((k) => k === "SET_SLOT")).toBe(true);
    expect(kinds.slice(28)).toEqual(["SET_DETAIL", "SET_LEGEND", "SET_VOICE", "SET_STATUS"]);
  });

  test("diff sends only changed elements; codex/stale map to slot flags; degraded maps to backend_degraded", () => {
    const a = view();
    const slots = a.slots.slice();
    slots[3] = { state: "working", label: "x", selected: true, provider: "codex", stale: true, pinned: true };
    const d = diffFrames(a, { ...a, slots, status: { link: "degraded", attentionCount: 2, text: "" } });
    expect(d.slots).toEqual([{ kind: "SET_SLOT", key: 3, state: "working", flags: { selected: true, codex: true, stale: true, pinned: true }, label: "x" }]);
    expect(d.frames).toEqual([{ kind: "SET_STATUS", link: "backend_degraded", attentionCount: 2, text: "" }]);
    expect(diffFrames(a, view())).toEqual({ frames: [], slots: [] });
  });
});

describe("render: protocol version 4 (docs/ui-v3.md section 5)", () => {
  const rows = (tag: string): TextRow[] => Array.from({ length: 12 }, (_, i) => ({ style: "body", text: i < 7 ? `${tag} ${i}` : "" }));
  const base = (tag = "bubble") => view({ text: rows(tag) });
  const detail = (tag = "page") => view({ view: "detail", title: "DETAILS fw codec", legend: ["", "", "", ""], text: rows(tag) });
  const order = (fs: { kind: string }[]) => fs.map((f) => f.kind);

  test("base views carry the bubble: four SET_TEXT groups at the end of a resync", () => {
    const frames = fullFrames(base());
    expect(frames.slice(32).map((f) => (f.kind === "SET_TEXT" ? f.row : -1))).toEqual([0, 3, 6, 9]);
  });

  test("every base <-> DETAILS switch sends all four groups before SET_VIEW, even groups that look unchanged", () => {
    const same = rows("same");
    const into = diffFrames(view({ text: same }), view({ view: "detail", title: "DETAILS x", text: same })).frames;
    expect(order(into)).toEqual(["SET_TEXT", "SET_TEXT", "SET_TEXT", "SET_TEXT", "SET_VIEW"]);
    const out = diffFrames(view({ view: "detail", title: "DETAILS x", text: same }), view({ text: same })).frames;
    expect(order(out)).toEqual(["SET_TEXT", "SET_TEXT", "SET_TEXT", "SET_TEXT", "SET_VIEW"]);
  });

  test("within the same kind of view only changed groups go out, still before SET_VIEW", () => {
    const next = rows("bubble");
    next[1] = { style: "body", text: "new message" };
    const d = diffFrames(base(), view({ text: next, title: "ACTIVE 1" })).frames;
    expect(order(d)).toEqual(["SET_TEXT", "SET_VIEW"]);
    expect(diffFrames(base(), base()).frames).toEqual([]);
    expect(diffFrames(detail(), detail()).frames).toEqual([]);
  });

  test("version 3 behaviour is unchanged: closing DETAILS into a view without rows sends no SET_TEXT", () => {
    expect(diffFrames(detail(), view()).frames.some((f) => f.kind === "SET_TEXT")).toBe(false);
    expect(framesFor(3, fullFrames(base()))).toEqual(fullFrames(base()));
    expect(framesFor(2, fullFrames(base())).some((f) => f.kind === "SET_TEXT")).toBe(false);
  });
});

describe("render: DETAILS page (protocol version 3)", () => {
  const rows = (n: number): TextRow[] => Array.from({ length: 12 }, (_, i) => ({ style: i === 0 ? "heading" : "body", text: i < n ? `row ${i}` : "" }));
  const detail = (over: Partial<DeviceView> = {}) => view({ view: "detail", title: "DETAILS fw codec", legend: ["", "", "", ""], text: rows(12), ...over });

  test("no SET_TEXT outside the detail view", () => {
    expect(textFrames(view())).toEqual([]);
    expect(fullFrames(view()).some((f) => f.kind === "SET_TEXT")).toBe(false);
  });

  test("four SET_TEXT frames, rows 0-2, 3-5, 6-8, 9-11, after the rest of the resync", () => {
    const frames = fullFrames(detail());
    expect(frames).toHaveLength(36);
    const text = frames.slice(32);
    expect(text.map((f) => (f.kind === "SET_TEXT" ? f.row : -1))).toEqual([0, 3, 6, 9]);
    expect(text[0]).toEqual({ kind: "SET_TEXT", row: 0, lines: [{ style: "heading", text: "row 0" }, { style: "body", text: "row 1" }, { style: "body", text: "row 2" }] });
  });

  test("the diff sends every group when the page opens, then only changed groups, nothing when it closes", () => {
    const opened = diffFrames(view(), detail()).frames.filter((f) => f.kind === "SET_TEXT");
    expect(opened).toHaveLength(4);
    const next = rows(12);
    next[7] = { style: "muted", text: "changed" };
    const changed = diffFrames(detail(), detail({ text: next })).frames;
    expect(changed).toEqual([{ kind: "SET_TEXT", row: 6, lines: [{ style: "body", text: "row 6" }, { style: "muted", text: "changed" }, { style: "body", text: "row 8" }] }]);
    expect(diffFrames(detail(), view()).frames.some((f) => f.kind === "SET_TEXT")).toBe(false);
  });

  test("review: opening or switching the page sends SET_TEXT before SET_VIEW (no previous chat's rows drawn)", () => {
    const opened = diffFrames(view(), detail()).frames.map((f) => f.kind);
    expect(opened.indexOf("SET_VIEW")).toBeGreaterThan(opened.lastIndexOf("SET_TEXT"));
    const other = rows(12).map((r, i) => (i === 1 ? { ...r, text: "another chat" } : r));
    const switched = diffFrames(detail(), detail({ title: "DETAILS other", text: other })).frames.map((f) => f.kind);
    expect(switched).toEqual(["SET_TEXT", "SET_VIEW"]);
  });

  test("below version 3 the guard drops SET_TEXT and the detail SET_VIEW", () => {
    const frames = fullFrames(detail());
    expect(framesFor(2, frames).some((f) => f.kind === "SET_TEXT" || (f.kind === "SET_VIEW" && f.view === "detail"))).toBe(false);
    expect(framesFor(null, frames).length).toBe(31);
    expect(framesFor(3, frames)).toEqual(frames);
  });

  test("a version 2 device never receives SET_TEXT; a version 3 device gets the page", async () => {
    const { Link } = await import("@fm1/device-protocol");
    for (const max of [2, 3]) {
      const clock = new FakeClock(0);
      const pair = new LoopbackPair();
      const host = new DeviceHost(async () => undefined, { clock, maxFramesPerSecond: Infinity });
      const kinds: string[] = [];
      host.attach(pair.host, "t");
      const dev = Link.device({ transport: pair.device, clock, identity: { versions: { min: 1, max }, fw: { major: 0, minor: 3, patch: 0 }, bootId: 7 } });
      dev.on("message", ({ message }) => kinds.push(message.kind === "SET_VIEW" ? `SET_VIEW:${message.view}` : message.kind));
      dev.start();
      host.render(detail());
      clock.advance(10);
      expect(host.status.proto).toBe(max);
      expect(kinds.filter((k) => k === "SET_TEXT")).toHaveLength(max === 3 ? 4 : 0);
      expect(kinds.includes("SET_VIEW:detail")).toBe(max === 3);
      host.detach();
    }
  });
});

describe("device host", () => {
  test("SET_SLOT bursts are coalesced per 50 ms to the newest state per key", async () => {
    const clock = new FakeClock(0);
    const pair = new LoopbackPair();
    const host = new DeviceHost(async () => undefined, { clock, maxFramesPerSecond: Infinity });
    const sent: string[] = [];
    pair.device.onMessage(() => undefined);
    host.attach(pair.host, "t");
    // Drive the handshake by hand: a device Link on the other end.
    const { Link } = await import("@fm1/device-protocol");
    const dev = Link.device({ transport: pair.device, clock, identity: { versions: { min: 1, max: 1 }, fw: { major: 0, minor: 1, patch: 0 }, bootId: 5 } });
    dev.on("message", ({ message }) => {
      if (message.kind === "SET_SLOT") sent.push(`${message.key}:${message.label}`);
    });
    dev.start();
    host.render(view());
    clock.advance(10);
    expect(host.status.phase).toBe("connected");
    expect(sent).toHaveLength(27); // resync
    sent.length = 0;
    const withLabel = (label: string): DeviceView => {
      const v = view();
      const s = v.slots.slice();
      s[0] = { state: "idle", label, selected: false, provider: "claude", stale: false, pinned: false };
      return { ...v, slots: s };
    };
    host.render(withLabel("a")); // first after quiet: immediate
    host.render(withLabel("b"));
    host.render(withLabel("c"));
    clock.advance(5);
    expect(sent).toEqual(["0:a"]);
    clock.advance(60);
    expect(sent).toEqual(["0:a", "0:c"]);
    host.detach();
    dev.close();
  });
});

describe("ports", () => {
  const ports = (names: string[]): MidiPorts => ({ inputs: names, outputs: names });

  test("the real port is an exact name match; the simulator never counts as hardware", () => {
    expect(classifyPorts(ports(["FM1 CONSOLE (sim)"]))).toEqual({ real: false, sim: true, other: [] });
    expect(classifyPorts(ports(["FM1 CONSOLE", "FM1 CONSOLE Bluetooth"]))).toEqual({ real: true, sim: false, other: ["FM1 CONSOLE Bluetooth"] });
  });

  test("checkExact refuses when the substring match would pick another port", () => {
    expect(() => checkExact(ports(["FM1 CONSOLE (sim)", "FM1 CONSOLE"]), "FM1 CONSOLE")).toThrow(AmbiguousPortError);
    expect(() => checkExact(ports(["FM1 CONSOLE", "FM1 CONSOLE (sim)"]), "FM1 CONSOLE")).not.toThrow();
    expect(() => checkExact(ports(["IAC Driver Bus 1"]), "FM1 CONSOLE")).toThrow(/not present/);
  });
});

describe("port watcher", () => {
  test("backs off while absent, attaches on plug, detaches on unplug, re-attaches on replug", async () => {
    const clock = new FakeClock(0);
    let present = false;
    const opened: string[] = [];
    const closed: string[] = [];
    const driver: PortDriver = {
      list: async () => ({ inputs: present ? ["FM1 CONSOLE"] : [], outputs: present ? ["FM1 CONSOLE"] : [] }),
      open: async (name) => {
        opened.push(name);
        const t = new LoopbackPair().host;
        const close = t.close.bind(t);
        t.close = () => (closed.push(name), close());
        return t;
      },
    };
    const events: string[] = [];
    const target = { attach: (_t: MidiTransport, n: string) => events.push(`attach ${n}`), detach: () => events.push("detach") };
    const w = new PortWatcher("FM1 CONSOLE", driver, target, { clock, backoff: { minMs: 100, maxMs: 400, presentMs: 50 } });
    const flush = async (ms: number) => {
      for (let i = 0; i < ms; i += 10) {
        clock.advance(10);
        await new Promise((r) => setImmediate(r));
      }
    };
    await w.start();
    expect(w.retryDelayMs).toBe(200);
    await flush(100);
    expect(w.retryDelayMs).toBe(400);
    await flush(1000);
    expect(w.retryDelayMs).toBe(400); // capped
    present = true;
    await flush(450);
    expect(events).toEqual(["attach FM1 CONSOLE"]);
    present = false;
    await flush(100);
    expect(events).toEqual(["attach FM1 CONSOLE", "detach"]);
    expect(closed).toEqual(["FM1 CONSOLE"]);
    present = true;
    await flush(500);
    expect(events).toEqual(["attach FM1 CONSOLE", "detach", "attach FM1 CONSOLE"]);
    w.stop();
    expect(events.at(-1)).toBe("detach");
    expect(opened).toHaveLength(2);
  });

  test("a Bluetooth port that appears after start is found by re-resolving on every poll", async () => {
    const clock = new FakeClock(0);
    let names: string[] = [];
    const driver: PortDriver = { list: async () => ({ inputs: names, outputs: names }), open: async () => new LoopbackPair().host };
    const events: string[] = [];
    const target = { attach: (_t: MidiTransport, n: string) => events.push(`attach ${n}`), detach: () => events.push("detach") };
    const w = new PortWatcher("FM1 CONSOLE 19E2", driver, target, { clock, backoff: { minMs: 100, maxMs: 400, presentMs: 50 }, resolve: resolveDevicePort });
    const flush = async (ms: number) => {
      for (let i = 0; i < ms; i += 10) {
        clock.advance(10);
        await new Promise((r) => setImmediate(r));
      }
    };
    await w.start();
    await flush(500);
    expect(events).toEqual([]);
    names = ["FM1 CONSOLE 19E2 Bluetooth"];
    await flush(500);
    expect(events).toEqual(["attach FM1 CONSOLE 19E2 Bluetooth"]);
    names = [];
    await flush(100);
    expect(events).toEqual(["attach FM1 CONSOLE 19E2 Bluetooth", "detach"]);
    w.stop();
  });
});

describe("config", () => {
  test("round-trips through disk with mode 0600; secrets and unknown keys are refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fm1cfg-"));
    const path = join(dir, "sub", "config.json");
    expect(await loadConfig(path)).toEqual(DEFAULT_CONFIG);
    const cfg = mergeConfig(DEFAULT_CONFIG, { language: "de", asrEngine: "apple", defaults: { provider: "codex", model: "gpt-5.6-luna" }, pins: ["traycer/h/ws%3A%2Fr/t1/a1", "traycer/h/ws%3A%2Fr/t1/a2"] });
    await saveConfig(cfg, path);
    expect(await loadConfig(path)).toEqual(cfg);
    expect((await loadConfig(path)).sessionPins).toEqual(["traycer/h/ws%3A%2Fr/t1/a1", "traycer/h/ws%3A%2Fr/t1/a2"]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(() => mergeConfig(DEFAULT_CONFIG, { traycerToken: "abc" })).toThrow(ConfigError);
    expect(() => mergeConfig(DEFAULT_CONFIG, { defaults: { apiKey: "x" } })).toThrow(/secrets/);
    expect(() => mergeConfig(DEFAULT_CONFIG, { lang: "en" })).toThrow(/unknown config key/);
    expect(() => mergeConfig(DEFAULT_CONFIG, { language: "en; rm -rf" })).toThrow(/BCP-47/);
    // No limit of 9 any more (operator decision 2026-11-19): only the safety cap of 200 per kind.
    expect(mergeConfig(DEFAULT_CONFIG, { pins: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"] }).sessionPins).toHaveLength(10);
    expect(() => mergeConfig(DEFAULT_CONFIG, { sessionPins: Array.from({ length: 201 }, (_, i) => `b/h/p/t/s${i}`) })).toThrow(/sessionPins holds at most 200/);
    expect(() => mergeConfig(DEFAULT_CONFIG, { taskPins: Array.from({ length: 201 }, (_, i) => `b/h/p/t${i}`) })).toThrow(/taskPins holds at most 200/);
    expect(mergeConfig(DEFAULT_CONFIG, { sessionPins: Array.from({ length: 200 }, (_, i) => `b/h/p/t/s${i}`), taskPins: Array.from({ length: 200 }, (_, i) => `b/h/p/t${i}`) }).taskPins).toHaveLength(200);
    expect(() => mergeConfig(DEFAULT_CONFIG, { sessionPins: ["b/h/p/t"] })).toThrow(/task keys go in taskPins/);
    expect(() => mergeConfig(DEFAULT_CONFIG, { taskPins: ["b/h/p/t/s"] })).toThrow(/taskPins holds task keys/);
    expect(() => mergeConfig(DEFAULT_CONFIG, { pins: ["a", 7] })).toThrow(/pins must be/);
    expect(() => mergeConfig(DEFAULT_CONFIG, { pins: "a" })).toThrow(/pins must be/);
    expect(() => mergeConfig(DEFAULT_CONFIG, { pins: [""] })).toThrow(/pins must be/);
    expect(mergeConfig(DEFAULT_CONFIG, { pins: ["a", "a", "b"] }).sessionPins).toEqual(["a", "b"]);
    expect(DEFAULT_CONFIG.sessionPins).toEqual([]);
    expect(DEFAULT_CONFIG.taskPins).toEqual([]);
    // A malformed 4-part legacy pin (empty part, space) is filed the console's way (pinLists: a task pin), so the
    // config the companion saves back after any pin change still loads, and no pin is lost on the way.
    const odd = ["b/h//t", "b/h/p/t x", "b/h/p/t/s"];
    const migrated = mergeConfig(DEFAULT_CONFIG, { pins: odd });
    const split = pinLists({ sessions: migrated.sessionPins, tasks: migrated.taskPins });
    expect(split).toEqual({ sessions: migrated.sessionPins, tasks: migrated.taskPins });
    await saveConfig({ ...migrated, sessionPins: split.sessions, taskPins: split.tasks }, path);
    const reloaded = await loadConfig(path);
    expect([...reloaded.sessionPins, ...reloaded.taskPins].sort()).toEqual([...odd].sort());
    writeFileSync(path, "{ nope");
    await expect(loadConfig(path)).rejects.toThrow(/invalid JSON/);
  });
});

describe("diagnostics", () => {
  test("redacts JWTs, bearer headers and token fields", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk";
    expect(redact(`auth ${jwt} done`)).toBe("auth [redacted] done");
    expect(redact("Authorization: Bearer abc.def-123")).toBe("Authorization: [redacted]");
    expect(redact('{"token":"s3cr3t","x":1}')).toBe('{"token":"[redacted]","x":1}');
    const log = new DiagLog(2, () => 1);
    log.info("app", "a");
    log.info("app", `refreshToken=${jwt}`);
    log.info("app", "c");
    expect(log.recent().map((e) => e.text)).toEqual(["refreshToken=[redacted]", "c"]);
  });

  test("mic level scale", () => {
    expect(levelFromRms(0)).toBe(0);
    expect(levelFromRms(1)).toBe(100);
    expect(levelFromRms(0.001)).toBe(0);
    expect(levelFromRms(0.1)).toBe(67);
  });

  test("traycer env strips agent context", () => {
    const env = traycerEnv({ PATH: "/bin", TRAYCER_AGENT_ID: "a", TRAYCER_EPIC_ID: "e", TRAYCER_TERMINAL_SPAWN_TOKEN: "t", HOME: "/h" });
    expect(env).toEqual({ PATH: "/bin", HOME: "/h" });
  });
});

describe("stage relay and feedback", () => {
  test("stages before binding are replayed once; later ones stream; a retry rebind adds no repeats", () => {
    const out: string[] = [];
    const relay = new StageRelay((seq, stage, text) => out.push(`${seq}:${stage}:${text}`), () => 0);
    const s = { ...initialComposer, state: "submitting" as const, requestId: "r1" };
    relay.observe({ ...s, stage: "accepted_locally" });
    relay.bind("r1", 9);
    relay.observe({ ...s, stage: "accepted_locally" });
    relay.observe({ ...s, state: "failed", stage: "failed", error: "boom" });
    relay.bind("r1", 12);
    relay.observe({ ...s, stage: "accepted_locally" });
    relay.observe({ ...s, state: "delivered", stage: "backend_acknowledged" });
    expect(out).toEqual(["9:accepted_locally:Queued", "9:failed:Failed - see Mac", "12:accepted_locally:Queued", "12:backend_acknowledged:Delivered"]);
  });

  test("feedback: recorded results win; no-op input gets nothing; refusals map to stages", () => {
    const st = { state: initialController, voice: "ready" as const };
    expect(feedbackFor([], [], st, st)).toEqual([]);
    expect(feedbackFor([], [{ requestId: "x", stage: "unsupported", message: "focus unsupported" }], st, st)).toEqual([{ stage: "unsupported", text: "Not supported" }]);
    expect(feedbackFor([], [{ requestId: "x", stage: "completed", action: "focus" }], st, st)).toEqual([{ stage: "completed", text: "Opened on Mac" }]);
    expect(feedbackFor([], [{ requestId: "x", stage: "target_unavailable", message: "session is stale" }], st, st)).toEqual([{ stage: "target_unavailable", text: "Chat is gone" }]);
    const said = { ...st, state: { ...initialController, notice: { stage: "target_unavailable" as const, text: "Select a chat first" } } };
    expect(feedbackFor([], [], st, said)).toEqual([{ stage: "target_unavailable", text: "Select a chat first" }]);
    expect(feedbackFor([{ type: "voiceSubmit" }], [], st, st)).toEqual([]);
  });

  test("feedback: no toast for select, mark read, view switch, opened confirm, voice start/stop", () => {
    const st = { state: initialController, voice: "ready" as const };
    const tasks = { ...st, state: { ...initialController, view: "tasks" as const } };
    const confirm = { ...st, state: { ...initialController, confirm: { type: "interrupt" as const, key: "k", label: "x" } } };
    expect(feedbackFor([{ type: "select", key: "k" }, { type: "markRead", itemId: "i" }], [], st, st)).toEqual([]);
    expect(feedbackFor([{ type: "resort", view: "tasks" }], [], st, tasks)).toEqual([]);
    expect(feedbackFor([], [], st, confirm)).toEqual([]);
    expect(feedbackFor([{ type: "voiceStop" }], [], st, { ...st, voice: "transcribing" })).toEqual([]);
    for (const t of ["Pinned", "Sorted", "Dismissed", "Cancelled", "Talk: Codex chat"]) {
      const n = { ...st, state: { ...initialController, notice: { stage: "accepted_locally" as const, text: t } } };
      expect(feedbackFor([], [], st, n)).toEqual([{ stage: "accepted_locally", text: t }]);
    }
  });
});

describe("adapter factory", () => {
  test("mock fixture adapter passes the runtime AgentAdapter check", () => {
    expect(() => assertAgentAdapter(MockAdapter.fromFixture(fixturePath("mixed")), "mock")).not.toThrow();
    expect(() => assertAgentAdapter({ id: "x" }, "bad")).toThrow(/missing connect/);
  });

  test("TraycerAgentAdapter is resolved by export name; missing export is a clear error", async () => {
    await expect(loadTraycerAdapter({}, async () => ({ TraycerAdapter: class {} }))).rejects.toThrow(AdapterUnavailableError);
    await expect(loadTraycerAdapter({}, async () => {
      throw new Error("boom");
    })).rejects.toThrow(/cannot load/);
    const mock = MockAdapter.fromFixture(fixturePath("mixed"));
    let seen: unknown;
    class TraycerAgentAdapter {
      static create(o: unknown) {
        seen = o;
        return mock;
      }
    }
    expect(await loadTraycerAdapter({ focusDeepLink: true }, async () => ({ TraycerAgentAdapter }))).toBe(mock);
    expect(seen).toEqual({ focusDeepLink: true });
    expect(mock.getCapabilities()).toEqual(allSupported("code"));
  });
});

describe("doctor parsers and delegation", () => {
  test("parseIoreg finds the FM-1 by VID/PID", () => {
    const text = [
      "+-o Root  <class IORegistryEntry>",
      "  +-o CoralFlower FM-1@01100000  <class IOUSBHostDevice>",
      '      "USB Product Name" = "CoralFlower FM-1"',
      '      "idVendor" = 4617',
      '      "idProduct" = 1',
      "  +-o Keyboard@02100000  <class IOUSBHostDevice>",
      '      "idVendor" = 1452',
      '      "idProduct" = 641',
    ].join("\n");
    expect(parseIoreg(text)).toEqual([
      { name: "CoralFlower FM-1", vendorId: 4617, productId: 1 },
      { name: "Keyboard", vendorId: 1452, productId: 641 },
    ]);
  });

  test("firmware check hashes candidates against the validation report", () => {
    const root = mkdtempSync(join(tmpdir(), "fm1root-"));
    mkdirSync(join(root, "firmware", "dist"), { recursive: true });
    mkdirSync(join(root, "reports"));
    writeFileSync(join(root, "firmware", "dist", "a.fwsc"), "abc");
    writeFileSync(join(root, "reports", "firmware-validation.md"), "sha `ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad`");
    expect(firmwareCheck(root)).toMatchObject({ status: "ok" });
    writeFileSync(join(root, "firmware", "dist", "b.fwsc"), "x");
    expect(firmwareCheck(root)).toMatchObject({ status: "warn" });
  });

  test("firmware verify and live smoke refuse honestly when their tools are absent", async () => {
    const root = mkdtempSync(join(tmpdir(), "fm1empty-"));
    expect(await firmwareVerify("x.fwsc", root)).toBe(2);
    expect(await testTraycer("live", [], root)).toBe(2);
    expect(await testTraycer("read-only", [], root)).toBe(2);
    mkdirSync(join(root, "reports"));
    writeFileSync(join(root, "reports", "disposable-allowlist.json"), JSON.stringify({ tasks: [{ epicId: "e1", chatIds: ["c1"] }] }));
    expect(isAllowlisted("e1", "c1", root)).toBe(true);
    expect(isAllowlisted("e1", "c2", root)).toBe(false);
    expect(isAllowlisted("e2", null, root)).toBe(false);
    expect(await testTraycer("live", [], root)).toBe(2); // allowlisted, but no runner
    expect(readFileSync(join(root, "reports", "disposable-allowlist.json"), "utf8")).toContain("e1");
  });
});

describe("UX v2 companion wiring", () => {
  test("the companion never reads a backend's raw status: sessions pass through as the adapter made them", async () => {
    const { createAdapter } = await import("../src/adapters");
    const adapter = await createAdapter("mock");
    expect(adapter).toBeInstanceOf(MockAdapter);
    await adapter.connect();
    const one = (await adapter.listSessions())[0]!;
    // A raw `outcome.at` (the old Traycer-specific fallback) no longer becomes lastActivityAt anywhere in the companion.
    const s = { ...one, status: { ...one.status, raw: { outcome: { at: one.createdAt + 5000 } } } };
    (adapter as MockAdapter).upsertSession(s);
    expect((await adapter.listSessions()).find((x) => x.ref.sessionId === one.ref.sessionId)?.lastActivityAt).toBe(one.lastActivityAt);
  });

  test("pins persist through the config callback; no SysEx or backend call is made for a pin", async () => {
    const { Companion } = await import("../src/companion");
    const adapter = MockAdapter.fromFixture(fixturePath("mixed"));
    const saved: { sessionPins: string[]; taskPins: string[] }[] = [];
    const c = new Companion({
      adapter,
      capture: () => {
        throw new Error("no mic in this test");
      },
      transcriber: { transcribe: async () => ({ ok: false, reason: "none" }), warm: async () => 0, dispose: async () => undefined } as never,
      saveConfig: async (cfg) => void saved.push({ sessionPins: cfg.sessionPins, taskPins: cfg.taskPins }),
      tickMs: 0,
    });
    await c.start();
    await c.handleInput({ kind: "key", key: 0, gesture: "long" }, 3);
    expect(saved).toEqual([{ sessionPins: [c.console.state.pins[0]!], taskPins: [] }]);
    expect(c.config.sessionPins).toHaveLength(1);
    expect(c.feedback.at(-1)).toMatchObject({ reqSeq: 3, text: "Pinned" });
    expect(adapter.focusCalls).toEqual([]);
    await c.stop();
  });
});

import { resolveDevicePort } from "../src/device/ports";
test("resolveDevicePort accepts the Audio MIDI Setup name of a Bluetooth device", () => {
  const ports = { inputs: ["IAC Driver Bus 1", "FM1 CONSOLE 19E2 Bluetooth"], outputs: ["IAC Driver Bus 1", "FM1 CONSOLE 19E2 Bluetooth"] };
  expect(resolveDevicePort(ports, "FM1 CONSOLE 19E2")).toBe("FM1 CONSOLE 19E2 Bluetooth");
  expect(resolveDevicePort(ports, "FM1 CONSOLE 19E2 Bluetooth")).toBe("FM1 CONSOLE 19E2 Bluetooth");
  expect(resolveDevicePort(ports, "AMB-1 FM-1")).toBe("AMB-1 FM-1");
});

import { bluetoothDeviceName } from "../src/device/ble-notify";
test("bluetoothDeviceName strips the CoreMIDI Bluetooth suffix only", () => {
  expect(bluetoothDeviceName("FM1 CONSOLE 19E2 Bluetooth")).toBe("FM1 CONSOLE 19E2");
  expect(bluetoothDeviceName("AMB-1 FM-1")).toBeNull();
  expect(bluetoothDeviceName(" Bluetooth")).toBeNull();
});
