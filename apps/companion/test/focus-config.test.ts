import { describe, expect, test } from "bun:test";
import { MockAdapter, fixturePath } from "@fm1/agent-core";
import { loadTraycerAdapter } from "../src/adapters";
import { ConfigError, DEFAULT_CONFIG, mergeConfig } from "../src/config";

const APP = "/Users/x/traycer-patched/out/Traycer FM1.app";

describe("focusApp config", () => {
  test("defaults to null, accepts an absolute .app path, strips a trailing slash, null clears it", () => {
    expect(DEFAULT_CONFIG.focusApp).toBeNull();
    expect(mergeConfig(DEFAULT_CONFIG, { focusApp: `${APP}/` }).focusApp).toBe(APP);
    expect(mergeConfig({ ...DEFAULT_CONFIG, focusApp: APP }, { focusApp: null }).focusApp).toBeNull();
    expect(mergeConfig(DEFAULT_CONFIG, { focusApp: "" }).focusApp).toBeNull();
  });

  test("rejects relative paths, non-.app paths and non-strings", () => {
    expect(() => mergeConfig(DEFAULT_CONFIG, { focusApp: "Traycer FM1.app" })).toThrow(ConfigError);
    expect(() => mergeConfig(DEFAULT_CONFIG, { focusApp: "/usr/bin/open" })).toThrow(ConfigError);
    expect(() => mergeConfig(DEFAULT_CONFIG, { focusApp: 3 })).toThrow(ConfigError);
  });

  test("loadTraycerAdapter hands focusApp to the adapter module and keeps constructor options unchanged", async () => {
    const mock = MockAdapter.fromFixture(fixturePath("mixed"));
    const configured: unknown[] = [];
    let seen: unknown;
    class TraycerAgentAdapter {
      static create(o: unknown) {
        seen = o;
        return mock;
      }
    }
    const mod = { TraycerAgentAdapter, configureFocusApp: (p: string | null) => configured.push(p) };
    await loadTraycerAdapter({ focusDeepLink: true, focusApp: APP }, async () => mod);
    await loadTraycerAdapter({ focusDeepLink: true }, async () => mod);
    expect(configured).toEqual([APP, null]);
    expect(seen).toEqual({ focusDeepLink: true });
    // A module without configureFocusApp (older adapter) still loads.
    expect(await loadTraycerAdapter({ focusApp: APP }, async () => ({ TraycerAgentAdapter }))).toBe(mock);
  });
});
