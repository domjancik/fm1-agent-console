import { describe, expect, test } from "bun:test";
import { CredentialSource, parseCredentials } from "../src/credentials";
import { HostEndpointError, isValidLocalHostWebsocketUrl, parsePidMetadata, toStreamUrl } from "../src/endpoint";

const pid = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    pid: 42,
    hostId: "host-1",
    version: "1.5.4",
    websocketUrl: "ws://127.0.0.1:52330/rpc",
    startedAt: "2026-11-15T08:56:03.646Z",
    ...overrides,
  });

describe("endpoint discovery", () => {
  test("parses a valid pid file and derives the stream URL", () => {
    const endpoint = parsePidMetadata(pid(), () => true);
    expect(endpoint).toMatchObject({ pid: 42, hostId: "host-1", version: "1.5.4" });
    expect(endpoint.streamUrl).toBe("ws://127.0.0.1:52330/stream");
  });

  test("rejects non-loopback or non-/rpc URLs", () => {
    expect(isValidLocalHostWebsocketUrl("ws://127.0.0.1:1/rpc")).toBe(true);
    expect(isValidLocalHostWebsocketUrl("ws://localhost:1/rpc")).toBe(false);
    expect(isValidLocalHostWebsocketUrl("ws://127.0.0.1:1/rpc?x=1")).toBe(false);
    expect(isValidLocalHostWebsocketUrl("http://127.0.0.1:1/rpc")).toBe(false);
    expect(() => parsePidMetadata(pid({ websocketUrl: "ws://10.0.0.1:1/rpc" }), () => true)).toThrow(HostEndpointError);
  });

  test("rejects a dead host pid", () => {
    expect(() => parsePidMetadata(pid(), () => false)).toThrow(/not running/);
  });

  test("toStreamUrl swaps the path", () => {
    expect(toStreamUrl("ws://127.0.0.1:9/rpc")).toBe("ws://127.0.0.1:9/stream");
  });
});

describe("credentials", () => {
  const file = (token: string) => JSON.stringify({ token, refreshToken: "r", user: { id: "u-1" } });

  test("parses token and user id only", () => {
    expect(parseCredentials(file("t-1"))).toEqual({ token: "t-1", userId: "u-1" });
    expect(() => parseCredentials("{}")).toThrow(/no token/);
  });

  test("refresh delegates to whoami, re-reads, rotates the same lease, single-flight", async () => {
    let current = "t-1";
    let whoamiRuns = 0;
    const source = new CredentialSource({
      path: "/fake",
      readText: async () => file(current),
      whoami: async () => {
        whoamiRuns += 1;
        await Bun.sleep(5);
        current = "t-2";
      },
    });
    const lease = await source.getLease();
    expect(lease.getBearerToken()).toBe("t-1");
    await Promise.all([source.refresh(), source.refresh()]);
    expect(whoamiRuns).toBe(1);
    expect(lease.getBearerToken()).toBe("t-2");
    expect(await source.getLease()).toBe(lease);
  });
});
