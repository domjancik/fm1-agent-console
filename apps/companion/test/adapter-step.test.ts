// Companion side of the adapter step: the adapter registry, the a2a config (self-send default on), and device copy that
// names the backend by the adapter's own name.
import { describe, expect, test } from "bun:test";
import { MockAdapter, fixturePath, initialController } from "@fm1/agent-core";
import { ADAPTER_KINDS, ADAPTERS, AdapterUnavailableError, DEFAULT_ADAPTER, createAdapter, loadTraycerAdapter, parseAdapterKind } from "../src/adapters";
import { ConfigError, DEFAULT_CONFIG, mergeConfig, serializable } from "../src/config";
import { feedbackFor } from "../src/feedback";
import { stageText } from "../src/stage-relay";
import { buildUiState } from "../src/ui-bridge/ui-state";

describe("adapter registry", () => {
  test("mock and traycer are registered; traycer is the default; unknown names are refused with the list", async () => {
    expect(ADAPTER_KINDS).toEqual(["mock", "traycer"]);
    expect(DEFAULT_ADAPTER).toBe("traycer");
    expect(parseAdapterKind(undefined)).toBe("traycer");
    expect(parseAdapterKind("mock")).toBe("mock");
    expect(() => parseAdapterKind("toString")).toThrow(/unknown adapter "toString" \(mock \| traycer\)/);
    expect(() => parseAdapterKind("acme")).toThrow(/mock \| traycer/);
    await expect(createAdapter("acme" as never)).rejects.toThrow(AdapterUnavailableError);
    for (const k of ADAPTER_KINDS) expect(ADAPTERS[k].description.length).toBeGreaterThan(0);
    expect(await createAdapter("mock", { mockFixture: "forty" })).toBeInstanceOf(MockAdapter);
  });

  test("the Traycer entry passes a2a options through (self-send and per-task senders)", async () => {
    const mock = MockAdapter.fromFixture(fixturePath("mixed"));
    let seen: unknown;
    class TraycerAgentAdapter {
      static create(o: unknown) {
        seen = o;
        return mock;
      }
    }
    const importer = async () => ({ TraycerAgentAdapter });
    await loadTraycerAdapter({ a2aSelfSend: true, a2aSender: [{ agentId: "a1", epicId: "e1" }] }, importer);
    expect(seen).toEqual({ focusDeepLink: false, a2aSelfSend: true, a2aSender: [{ agentId: "a1", epicId: "e1" }] });
    await loadTraycerAdapter({ a2aSelfSend: false, a2aSender: [] }, importer);
    expect(seen).toEqual({ focusDeepLink: false, a2aSelfSend: false });
    // A non-string displayName or a non-function fetchPinned is not an AgentAdapter.
    const bad = Object.assign(MockAdapter.fromFixture(fixturePath("mixed")), { fetchPinned: 3 });
    await expect(loadTraycerAdapter({}, async () => ({ TraycerAgentAdapter: class { static create = () => bad } }))).rejects.toThrow(/fetchPinned/);
  });
});

describe("a2a config (operator decision 2026-11-18, option B)", () => {
  test("a2aSelfSend defaults to true and is saved only when false; a2aSender accepts one object or a list", () => {
    expect(DEFAULT_CONFIG.a2aSelfSend).toBe(true);
    expect(DEFAULT_CONFIG.a2aSender).toEqual([]);
    expect(serializable(DEFAULT_CONFIG)).not.toHaveProperty("a2aSelfSend");
    expect(serializable(DEFAULT_CONFIG)).not.toHaveProperty("a2aSender");
    const off = mergeConfig(DEFAULT_CONFIG, { a2aSelfSend: false });
    expect(serializable(off).a2aSelfSend).toBe(false);
    const one = mergeConfig(DEFAULT_CONFIG, { a2aSender: { agentId: "08488a00-d6c8-4c8f-bf4e-73c02fec81a3", epicId: "243c50b9-ac47-47d8-8254-c1292092c1bb" } });
    expect(one.a2aSender).toHaveLength(1);
    expect(serializable(one).a2aSender).toEqual(one.a2aSender);
    expect(mergeConfig(one, { a2aSender: null }).a2aSender).toEqual([]);
    expect(mergeConfig(DEFAULT_CONFIG, { a2aSender: [{ agentId: "a", epicId: "e1" }, { agentId: "b", epicId: "e2" }] }).a2aSender).toHaveLength(2);
  });

  test("bad values are refused", () => {
    expect(() => mergeConfig(DEFAULT_CONFIG, { a2aSelfSend: "yes" })).toThrow(ConfigError);
    expect(() => mergeConfig(DEFAULT_CONFIG, { a2aSender: { agentId: "a" } })).toThrow(ConfigError);
    expect(() => mergeConfig(DEFAULT_CONFIG, { a2aSender: { agentId: "a b", epicId: "e" } })).toThrow(ConfigError);
    expect(() => mergeConfig(DEFAULT_CONFIG, { a2aSender: { agentId: "a", epicId: "e", extra: 1 } })).toThrow(ConfigError);
    expect(() => mergeConfig(DEFAULT_CONFIG, { a2aSender: [{ agentId: "a", epicId: "e" }, { agentId: "b", epicId: "e" }] })).toThrow(/twice/);
  });
});

describe("tuiRoute config (operator decision 2026-11-19: typing primary)", () => {
  test("defaults to type, saved only when a2a, passed to the adapter; bad values refused", async () => {
    expect(DEFAULT_CONFIG.tuiRoute).toBe("type");
    expect(serializable(DEFAULT_CONFIG)).not.toHaveProperty("tuiRoute");
    const a2a = mergeConfig(DEFAULT_CONFIG, { tuiRoute: "a2a" });
    expect(serializable(a2a).tuiRoute).toBe("a2a");
    expect(() => mergeConfig(DEFAULT_CONFIG, { tuiRoute: "keys" })).toThrow(ConfigError);
    let seen: unknown;
    const importer = async () => ({ TraycerAgentAdapter: class { constructor(o: unknown) { seen = o; } } });
    await loadTraycerAdapter({ tuiRoute: "a2a" }, importer).catch(() => undefined);
    expect(seen).toEqual({ focusDeepLink: false, tuiRoute: "a2a" });
  });
});

describe("device copy names the adapter's backend", () => {
  test("toasts: link down says <name> offline; a sent-with-reason prompt says Queued, undelivered", () => {
    const st = { state: initialController, voice: "ready" as const };
    expect(feedbackFor([], [{ requestId: "r", stage: "failed", message: "Traycer host disconnected" }], st, st, "Traycer")).toEqual([{ stage: "failed", text: "Traycer offline" }]);
    expect(feedbackFor([], [{ requestId: "r", stage: "failed", message: "disconnected" }], st, st, "Acme")).toEqual([{ stage: "failed", text: "Acme offline" }]);
    expect(stageText("sent", "queued in the terminal agent's inbox; delivery not observed yet", "Traycer")).toBe("Queued, undelivered");
    expect(stageText("sent", null)).toBe("Sent");
    expect(stageText("failed", "disconnected", "Traycer")).toBe("Traycer offline");
  });

  test("the desktop UI shows the backend's name and the a2a self-send setting", async () => {
    const { Companion } = await import("../src/companion");
    const adapter = MockAdapter.fromFixture(fixturePath("mixed"), { displayName: "Acme" });
    const c = new Companion({
      adapter,
      capture: () => {
        throw new Error("no mic in this test");
      },
      transcriber: { transcribe: async () => ({ ok: false, reason: "none" }), warm: async () => 0, dispose: async () => undefined } as never,
      tickMs: 0,
    });
    await c.start();
    const ui = buildUiState(c, null);
    expect(ui.backend.name).toBe("Acme");
    expect(ui.config.a2aSelfSend).toBe(true);
    adapter.dropConnection();
    expect(c.console.view().status.text).toBe("Acme offline");
    await c.stop();
  });
});
