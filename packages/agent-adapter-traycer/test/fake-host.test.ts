import { afterEach, describe, expect, test } from "bun:test";
import { TraycerAdapter } from "../src/adapter";
import { CredentialSource } from "../src/credentials";
import type { HostEndpoint } from "../src/endpoint";
import { probeHandshake } from "../src/handshake";
import { makeClientIdentity } from "../src/identity";
import { TraycerRpc } from "../src/rpc";
import { startFakeHost, type FakeHost } from "./fake-host";

let host: FakeHost | null = null;
afterEach(() => {
  host?.stop();
  host = null;
});

function endpointFor(url: string): HostEndpoint {
  return { pid: 1, hostId: "host-1", version: "1.5.4", websocketUrl: url, streamUrl: url.replace("/rpc", "/stream"), startedAt: null };
}

function credentials(tokens: string[]): { source: CredentialSource; whoamiRuns: () => number } {
  let index = 0;
  let runs = 0;
  const source = new CredentialSource({
    path: "/fake",
    readText: async () => JSON.stringify({ token: tokens[Math.min(index, tokens.length - 1)], user: { id: "u-1" } }),
    whoami: async () => {
      runs += 1;
      index += 1;
    },
  });
  return { source, whoamiRuns: () => runs };
}

describe("handshake probe", () => {
  test("sends the vendored manifest and fm1-console identity; reports the ack", async () => {
    host = startFakeHost();
    const result = await probeHandshake({ websocketUrl: host.url, token: "t", clientIdentity: makeClientIdentity("fm1-console") });
    expect(result.kind).toBe("ack");
    const open = host.opens[0]!;
    expect(open.clientIdentity).toEqual({ kind: "fm1-console", compatibilityEpoch: 2, appVersion: "0.1.0" });
    expect(Object.keys(open.manifest).length).toBeGreaterThan(50);
    const all = { ...open.manifest, ...open.optionalManifest };
    expect(all["epic.listTasks"]).toBeDefined();
    expect(all["chat.subscribe"]).toBeUndefined(); // stream methods ride /stream, not /rpc
  });

  test("reports a fatal refusal", async () => {
    host = startFakeHost({ onOpen: () => "UNAUTHORIZED" });
    const result = await probeHandshake({ websocketUrl: host.url, token: "t", clientIdentity: makeClientIdentity("cli") });
    expect(result.kind === "fatal" && result.details.code).toBe("UNAUTHORIZED");
  });
});

describe("TraycerRpc over the vendored WsRpcClient", () => {
  test("round-trips a request", async () => {
    host = startFakeHost({ handle: (method) => (method === "agent.stop" ? { result: { stoppedAgentIds: ["a-1"] } } : { result: {} }) });
    const { source } = credentials(["t-1"]);
    const rpc = new TraycerRpc({ endpoint: async () => endpointFor(host!.url), credentials: source, clientIdentity: makeClientIdentity("fm1-console") });
    const response = await rpc.call("agent.stop", { epicId: "e", agentId: "a-1", cascade: false });
    expect(response).toEqual({ stoppedAgentIds: ["a-1"] });
    expect(host.requests).toEqual([{ method: "agent.stop", params: { epicId: "e", agentId: "a-1", cascade: false }, idempotencyKey: null }]);
  });

  test("on UNAUTHORIZED: whoami refresh, rotated token, one retry", async () => {
    host = startFakeHost({ onOpen: (open) => (open.token === "stale" ? "UNAUTHORIZED" : null) });
    const { source, whoamiRuns } = credentials(["stale", "fresh"]);
    const rpc = new TraycerRpc({ endpoint: async () => endpointFor(host!.url), credentials: source, clientIdentity: makeClientIdentity("fm1-console") });
    await rpc.call("host.getRuntimeCapabilities", {});
    expect(whoamiRuns()).toBe(1);
    expect(host.opens.map((open) => open.token)).toEqual(["stale", "fresh"]);
  });
});

describe("adapter normalization against the fake host", () => {
  test("listAgents merges GUI chats (with run settings) and TUI agents", async () => {
    host = startFakeHost({
      handle: (method) => {
        switch (method) {
          case "epic.listChatRecords":
            return {
              result: {
                kind: "snapshot",
                listStamp: null,
                chats: [
                  {
                    chatId: "c-1", ownerUserId: "u-1", originHostId: "host-1", title: "Chat", isTitleEditedByUser: false,
                    parentChatId: null, createdAt: 1, updatedAt: 2, archived: false, archivedAt: null, runSettingsSummary: null,
                    revision: 1, visibility: "private", origin: "own", docResident: false,
                  },
                ],
              },
            };
          case "epic.listTuiAgents":
            return {
              result: {
                kind: "snapshot",
                listStamp: null,
                tuiAgents: [
                  {
                    origin: "foreign", tuiAgentId: "t-1", ownerUserId: "u-1", hostId: "host-1", harnessId: "claude", parentId: null,
                    title: "Term", isTitleEditedByUser: false, createdAt: 3, updatedAt: 4, archived: false, revision: 1,
                    sessionState: "running", lastExit: null,
                  },
                ],
              },
            };
          case "epic.getChatRunSettingsBatch":
            return {
              result: {
                entries: [
                  {
                    chatId: "c-1",
                    settings: { harnessId: "codex", model: "gpt-5.6-luna", permissionMode: "supervised", reasoningEffort: "low", serviceTier: null, agentMode: "regular", profileId: null, ultracode: false },
                  },
                ],
              },
            };
          default:
            return { result: {} };
        }
      },
    });
    const { source } = credentials(["t"]);
    const identity = makeClientIdentity("fm1-console");
    const endpoint = endpointFor(host.url);
    const adapter = new TraycerAdapter(endpoint, source, identity, new TraycerRpc({ endpoint: async () => endpoint, credentials: source, clientIdentity: identity }));
    const agents = await adapter.listAgents("e-1");
    expect(agents.map((agent) => [agent.agentId, agent.surface, agent.harnessId, agent.model, agent.sessionState])).toEqual([
      ["c-1", "gui", "codex", "gpt-5.6-luna", null],
      ["t-1", "tui", "claude", null, "running"],
    ]);
    expect(host.requests.find((r) => r.method === "epic.getChatRunSettingsBatch")?.params).toEqual({ epicId: "e-1", chatIds: ["c-1"] });
  });
});
