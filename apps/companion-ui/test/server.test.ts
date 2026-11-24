import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { parseCommand, startUiServer, type UiBackend, type UiCommand, type UiServer, type UiState } from "../src/index";

function state(transcript = ""): UiState {
  return {
    backend: { adapterId: "mock:mixed", connection: "connected", ready: true, capabilities: [{ name: "focus", supported: false, reason: "needs deep link", verified: "none" }] },
    device: { phase: "connected", transport: "loopback", proto: 1, firmware: "0.1.0", rxErrors: 0, resyncs: 1, reason: null },
    view: { name: "voice", title: "VOICE REVIEWING", legend: ["S:SEND", "F:CANC", "--", "--"], status: "", attention: 0 },
    tasks: [],
    voice: { state: "reviewing", target: "fw codec", transcript, editable: true, canSave: true, canCancel: true, level: 0, elapsedDs: 12, error: null },
    dispatch: { requestId: null, stages: [] },
    config: { micDeviceUid: null, asrEngine: "sherpa", language: "en", vocabularyFile: null, focusDeepLink: false, defaults: { provider: "claude", model: null }, layouts: { sessions: "buddy", inbox: "list" } },
    log: [],
    simulatorUrl: "http://127.0.0.1:4717/",
  };
}

class FakeBackend implements UiBackend {
  transcript = "hello";
  commands: UiCommand[] = [];
  private fns = new Set<() => void>();
  snapshot(): UiState {
    return state(this.transcript);
  }
  onChange(fn: () => void): () => void {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }
  async command(cmd: UiCommand) {
    this.commands.push(cmd);
    if (cmd.t === "edit") this.transcript = cmd.text;
    for (const f of this.fns) f();
    return cmd.t === "config" ? ({ ok: false, error: "bad key" } as const) : ({ ok: true } as const);
  }
}

let server: UiServer;
const backend = new FakeBackend();

beforeAll(async () => {
  server = await startUiServer({ backend, port: 0 });
});
afterAll(() => server.stop());

describe("companion UI server", () => {
  test("serves the page, the bundle and the state on loopback only", async () => {
    const page = await fetch(server.url);
    expect(page.status).toBe(200);
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(await page.text()).toContain("FM-1 Companion");
    const js = await fetch(`${server.url}app.js`);
    expect(js.status).toBe(200);
    expect((await js.text()).length).toBeGreaterThan(1000);
    const st = (await (await fetch(`${server.url}api/state`)).json()) as { t: string; state: UiState };
    expect(st.state.voice.transcript).toBe("hello");
    expect(server.url.startsWith("http://127.0.0.1:")).toBe(true);
  });

  test("foreign Origin and non-loopback Host are refused (CSWSH / DNS rebinding)", async () => {
    const evil = await fetch(`${server.url}api/state`, { headers: { origin: "https://evil.example" } });
    expect(evil.status).toBe(403);
    const rebind = await fetch(`${server.url}api/state`, { headers: { host: "attacker.example:4718" } });
    expect(rebind.status).toBe(403);
    const ws = await fetch(`${server.url}ws`, { headers: { origin: "https://evil.example", upgrade: "websocket", connection: "upgrade" } });
    expect(ws.status).toBe(403);
    const post = await fetch(`${server.url}api/state`, { method: "POST", headers: { origin: server.url.slice(0, -1) } });
    expect(post.status).toBe(405);
  });

  test("WebSocket upgrade refused from a sandboxed (null) origin and from another loopback port", async () => {
    const upgrade = { upgrade: "websocket", connection: "upgrade", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" };
    const sandboxed = await fetch(`${server.url}ws`, { headers: { ...upgrade, origin: "null" } });
    expect(sandboxed.status).toBe(403);
    const otherPort = await fetch(`${server.url}ws`, { headers: { ...upgrade, origin: `http://127.0.0.1:${server.port + 1}` } });
    expect(otherPort.status).toBe(403);
    const otherName = await fetch(`${server.url}ws`, { headers: { ...upgrade, origin: `http://localhost:${server.port}` } });
    expect(otherName.status).toBe(403);
    expect(backend.commands).toHaveLength(0);
  });

  test("WebSocket: state push on open, commands get replies, changes are pushed", async () => {
    const ws = new WebSocket(`${server.url.replace("http", "ws")}ws`);
    const msgs: { t: string; id?: number; reply?: { ok: boolean }; state?: UiState }[] = [];
    const next = (pred: (m: (typeof msgs)[number]) => boolean) =>
      new Promise<(typeof msgs)[number]>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("timeout")), 2000);
        const check = () => {
          const m = msgs.find(pred);
          if (m) {
            clearTimeout(t);
            resolve(m);
          } else setTimeout(check, 5);
        };
        check();
      });
    ws.onmessage = (e) => msgs.push(JSON.parse(String(e.data)));
    await new Promise((r) => (ws.onopen = r));
    expect((await next((m) => m.t === "state")).state?.voice.transcript).toBe("hello");
    ws.send(JSON.stringify({ t: "edit", text: "run the tests", id: 7 }));
    expect((await next((m) => m.t === "reply" && m.id === 7)).reply).toEqual({ ok: true });
    expect((await next((m) => m.t === "state" && m.state?.voice.transcript === "run the tests")).state?.voice.transcript).toBe("run the tests");
    ws.send(JSON.stringify({ t: "save", id: 8 }));
    await next((m) => m.id === 8);
    ws.send(JSON.stringify({ t: "rm -rf", id: 9 })); // ignored
    ws.send(JSON.stringify({ t: "config", patch: { x: 1 }, id: 10 }));
    expect((await next((m) => m.id === 10)).reply).toEqual({ ok: false, error: "bad key" } as never);
    expect(backend.commands.map((c) => c.t)).toEqual(["edit", "save", "config"]);
    ws.close();
  });
});

describe("parseCommand", () => {
  test("accepts only the known command shapes", () => {
    expect(parseCommand('{"t":"save","id":3}')).toEqual({ id: 3, cmd: { t: "save" } });
    expect(parseCommand('{"t":"edit","text":5}')).toBeNull();
    expect(parseCommand(JSON.stringify({ t: "edit", text: "x".repeat(5000) }))).toBeNull();
    expect(parseCommand('{"t":"config","patch":[1]}')).toBeNull();
    expect(parseCommand("not json")).toBeNull();
    expect(parseCommand('{"t":"cancel"}')).toEqual({ id: 0, cmd: { t: "cancel" } });
  });
});

test("config form: Sessions offers Buddy, List and Grouped; TO DO only Buddy and List (docs/ui-v3.md section 9.12)", async () => {
  const html = await Bun.file(new URL("../src/ui/index.html", import.meta.url)).text();
  const opts = (id: string): string[] => {
    const m = new RegExp(`<select id="${id}"[^>]*>([\\s\\S]*?)</select>`).exec(html);
    return [...(m?.[1] ?? "").matchAll(/value="([^"]+)"/g)].map((x) => x[1] ?? "");
  };
  expect(opts("c-layout-sessions")).toEqual(["buddy", "list", "grouped"]);
  expect(opts("c-layout-inbox")).toEqual(["buddy", "list"]);
});
