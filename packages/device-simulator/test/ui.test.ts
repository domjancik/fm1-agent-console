import { describe, expect, test } from "bun:test";
import { Link, LoopbackPair } from "@fm1/device-protocol";
import { SimDevice } from "../src/device";
import { isTrustedRequest, startSimServer } from "../src/server";
import { KEY_CHARS, keyboardGeometry, shortcutFor } from "../src/ui/keymap";
import { formatEntry } from "../src/ui/log-panel";
import { parseClientMessage, type ServerMessage } from "../src/wire";

describe("keymap", () => {
  test("27 distinct key shortcuts that leave h/e/g for views", () => {
    expect(KEY_CHARS.length).toBe(27);
    expect(new Set(KEY_CHARS).size).toBe(27);
    for (const c of "heg") expect(KEY_CHARS.includes(c)).toBe(false);
    expect(shortcutFor("q")).toEqual({ kind: "key", key: 10 });
    expect(shortcutFor(";")).toEqual({ kind: "key", key: 26 });
    expect(shortcutFor(" ")).toEqual({ kind: "button", button: "REC" });
    expect(shortcutFor("Enter")).toEqual({ kind: "button", button: "SAVE" });
    expect(shortcutFor("Escape")).toEqual({ kind: "button", button: "FX" });
    expect(shortcutFor("H")).toEqual({ kind: "button", button: "HOME" });
    expect(shortcutFor("e")).toEqual({ kind: "button", button: "EDIT" });
    expect(shortcutFor("g")).toEqual({ kind: "button", button: "GLO" });
    expect(shortcutFor("ArrowRight")).toEqual({ kind: "encoder", encoder: "SELECT", delta: 1 });
    expect(shortcutFor("F5")).toBeNull();
  });

  test("keyboard F3..G5: 16 white and 11 black keys", () => {
    const g = keyboardGeometry();
    expect(g.filter((k) => !k.black).length).toBe(16);
    expect(g.filter((k) => k.black).map((k) => k.key)).toEqual([1, 3, 5, 8, 10, 13, 15, 17, 20, 22, 25]);
  });
});

describe("wire parsing", () => {
  test("accepts valid and rejects malformed client messages", () => {
    expect(parseClientMessage('{"t":"key","key":3,"down":true}')).toEqual({ t: "key", key: 3, down: true });
    expect(parseClientMessage('{"t":"button","button":"REC","down":false}')).toEqual({ t: "button", button: "REC", down: false });
    expect(parseClientMessage('{"t":"encoder","encoder":"K2","delta":-3}')).toEqual({ t: "encoder", encoder: "K2", delta: -3 });
    expect(parseClientMessage('{"t":"pot","value":1023}')).toEqual({ t: "pot", value: 1023 });
    for (const bad of [
      "nope",
      "null",
      '{"t":"key","key":27,"down":true}',
      '{"t":"key","key":1.5,"down":true}',
      '{"t":"button","button":"BOOT","down":true}',
      '{"t":"encoder","encoder":"K9","delta":1}',
      '{"t":"encoder","encoder":"K1","delta":0}',
      '{"t":"pot","value":2000}',
      '{"t":"sysex"}',
    ]) {
      expect(parseClientMessage(bad)).toBeNull();
    }
  });

  test("log formatting", () => {
    expect(formatEntry({ atMs: 1500, dir: "rx", seq: 4, kind: "SET_VIEW", summary: "view=inbox" })).toBe(
      "    1.500 <- host #  4 SET_VIEW view=inbox",
    );
  });
});

describe("browser server", () => {
  test("serves the page and bundle; WebSocket streams state and log and accepts input", async () => {
    const pair = new LoopbackPair();
    const host = Link.host({ transport: pair.host, maxFramesPerSecond: Infinity });
    const keys: string[] = [];
    host.on("message", ({ message }) => {
      if (message.kind === "KEY") keys.push(`${message.key}:${message.gesture}`);
    });
    host.start();
    const device = new SimDevice({ transport: pair.device });
    const server = await startSimServer({ device, port: 0 });
    device.start();
    try {
      const page = await fetch(server.url);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('<canvas id="lcd"');
      const js = await fetch(new URL("app.js", server.url));
      expect(js.status).toBe(200);
      const bundle = await js.text();
      expect(bundle).toContain("layoutScreen");
      expect(bundle).not.toContain("@julusian/midi");
      expect((await fetch(new URL("nope", server.url))).status).toBe(404);

      const ws = new WebSocket(server.url.replace("http", "ws") + "ws");
      const got: ServerMessage[] = [];
      ws.onmessage = (ev) => got.push(JSON.parse(String(ev.data)) as ServerMessage);
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error("ws error"));
      });
      ws.send(JSON.stringify({ t: "key", key: 2, down: true }));
      ws.send(JSON.stringify({ t: "key", key: 2, down: false }));
      ws.send("garbage");
      await Bun.sleep(500);
      ws.close();
      expect(keys).toEqual(["2:down", "2:up", "2:single"]);
      const states = got.filter((m) => m.t === "state");
      expect(states.at(-1)?.t === "state" && states.at(-1)?.state.link.phase).toBe("connected");
      const logged = got.flatMap((m) => (m.t === "log" ? m.entries.map((e) => e.kind) : []));
      expect(logged).toContain("HELLO");
      expect(logged).toContain("HELLO_ACK");
      expect(logged).toContain("KEY");
    } finally {
      server.stop();
      device.stop();
      host.close();
    }
  });
});

describe("browser server hardening", () => {
  const req = (host: string | null, origin?: string): Request => {
    const headers = new Headers();
    if (host !== null) headers.set("host", host);
    if (origin !== undefined) headers.set("origin", origin);
    return new Request("http://127.0.0.1:4717/ws", { headers });
  };

  test("only loopback Hosts and same-origin pages are trusted", () => {
    expect(isTrustedRequest(req("127.0.0.1:4717"))).toBe(true);
    expect(isTrustedRequest(req("localhost:4717", "http://localhost:4717"))).toBe(true);
    expect(isTrustedRequest(req("[::1]:4717", "http://[::1]:4717"))).toBe(true);
    expect(isTrustedRequest(req("127.0.0.1:4717", "https://evil.example"))).toBe(false);
    expect(isTrustedRequest(req("127.0.0.1:4717", "http://127.0.0.1:9999"))).toBe(false);
    expect(isTrustedRequest(req("127.0.0.1:4717", "null"))).toBe(false);
    expect(isTrustedRequest(req("evil.example:4717"))).toBe(false);
    expect(isTrustedRequest(req(null))).toBe(false);
  });

  test("a foreign page cannot open the socket; a tab closed mid-press releases its keys", async () => {
    const pair = new LoopbackPair();
    const host = Link.host({ transport: pair.host, maxFramesPerSecond: Infinity });
    const got: string[] = [];
    host.on("message", ({ message }) => {
      if (message.kind === "KEY") got.push(`K${message.key}:${message.gesture}`);
      if (message.kind === "BUTTON") got.push(`${message.button}:${message.edge}`);
    });
    host.start();
    const device = new SimDevice({ transport: pair.device });
    const server = await startSimServer({ device, port: 0 });
    device.start();
    try {
      const wsUrl = new URL("ws", server.url).href;
      const forbidden = await fetch(wsUrl, {
        headers: { origin: "https://evil.example", upgrade: "websocket", connection: "Upgrade" },
      });
      expect(forbidden.status).toBe(403);

      await Bun.sleep(50);
      const ws = new WebSocket(wsUrl.replace("http", "ws"));
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error("ws error"));
      });
      ws.send(JSON.stringify({ t: "button", button: "REC", down: true }));
      ws.send(JSON.stringify({ t: "key", key: 4, down: true }));
      await Bun.sleep(100);
      ws.close();
      await Bun.sleep(150);
      // REC push-to-talk and the key are released instead of staying held forever.
      expect(got).toEqual(["REC:down", "K4:down", "K4:up", "REC:up"]);
      expect(device.state.link.phase).toBe("connected");
    } finally {
      server.stop();
      device.stop();
      host.close();
    }
  });
});
