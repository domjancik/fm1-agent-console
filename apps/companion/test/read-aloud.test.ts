// Read aloud (docs/ui-v3.md section 14): Kokoro health / Docker start-up, the on-device summary, afplay playback and
// stop, and the config. Fake runner, fetch, clock and temp files: no real Docker, afplay or network.
import { describe, expect, test } from "bun:test";
import { NOTICE } from "@fm1/agent-core";
import { DEFAULT_CONFIG, DEFAULT_READ_ALOUD, ConfigError, mergeConfig, serializable, type ReadAloudConfig } from "../src/config";
import type { RunResult } from "../src/proc";
import { BOOT_WAIT_MS, CONTAINER_NAME, imageRepo, ReadAloud, SUMMARY_TIMEOUT_MS, type ProcHandle, type SpeechDeps } from "../src/speech/read-aloud";

interface FakeOpts {
  healthy?: (call: number) => boolean;
  ps?: RunResult;
  summarize?: RunResult;
  synthStatus?: number;
  summarizer?: string | null;
}

function fake(o: FakeOpts = {}) {
  let clock = 0;
  let healthCalls = 0;
  const runs: { cmd: string[]; stdin?: string; timeoutMs?: number }[] = [];
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  const players: { cmd: string[]; killed: boolean; finish: (code: number) => void }[] = [];
  const temps = new Set<string>();
  const removed: string[] = [];
  let n = 0;
  const deps: SpeechDeps = {
    summarizer: o.summarizer === undefined ? "/bin/fm1-summarize" : o.summarizer,
    async run(cmd, opts = {}) {
      runs.push({ cmd, ...opts });
      if (cmd[0] === "docker" && cmd[1] === "ps") return o.ps ?? { code: 0, stdout: "", stderr: "" };
      if (cmd[0] === "docker") return { code: 0, stdout: "abc\n", stderr: "" };
      return o.summarize ?? { code: 0, stdout: "A short summary.\n", stderr: "" };
    },
    spawn(cmd): ProcHandle {
      let finish: (code: number) => void = () => undefined;
      const exited = new Promise<number>((r) => (finish = r));
      const p = { cmd, killed: false, finish };
      players.push(p);
      return {
        exited,
        kill: () => {
          p.killed = true;
          finish(143);
        },
      };
    },
    async fetch(url, init = {}) {
      if (url.endsWith("/health")) {
        const ok = (o.healthy ?? (() => true))(healthCalls++);
        if (!ok) throw new Error("ECONNREFUSED");
        return new Response('{"status":"healthy"}');
      }
      posts.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return o.synthStatus && o.synthStatus !== 200 ? new Response("bad", { status: o.synthStatus }) : new Response(new Uint8Array([1, 2, 3]));
    },
    async sleep(ms) {
      clock += ms;
    },
    now: () => clock,
    async writeTemp(_bytes, ext) {
      const p = `/tmp/fm1-read-${++n}/speech.${ext}`;
      temps.add(p);
      return p;
    },
    async removeTemp(p) {
      removed.push(p);
      temps.delete(p);
    },
  };
  const toasts: string[] = [];
  const cfg: ReadAloudConfig = { ...DEFAULT_READ_ALOUD };
  const ra = new ReadAloud({ config: () => cfg, toast: (t) => toasts.push(t), log: () => undefined, deps });
  /** Lets the pipeline run up to the point where afplay is playing (or it ended). */
  const settle = async () => {
    for (let i = 0; i < 50; i++) await Promise.resolve();
  };
  return { ra, deps, runs, posts, players, temps, removed, toasts, cfg, settle, get healthCalls() { return healthCalls; } };
}

const SHORT = "The agent fixed the parser.";
const LONG = "Sentence number one is here. ".repeat(40).trim();

describe("Kokoro health and Docker start-up", () => {
  test("healthy: no docker call; afplay plays a 0600 temp file which is removed afterwards", async () => {
    const f = fake();
    f.ra.speak(SHORT, "k");
    await f.settle();
    expect(f.runs).toHaveLength(0);
    expect(f.posts[0]?.url).toBe("http://127.0.0.1:8880/v1/audio/speech");
    expect(f.posts[0]?.body).toMatchObject({ model: "kokoro", input: SHORT, voice: "af_heart", response_format: "mp3" });
    expect(f.players[0]?.cmd).toEqual(["afplay", "/tmp/fm1-read-1/speech.mp3"]);
    expect(f.toasts).toEqual([NOTICE.reading]);
    expect(f.ra.speaking()).toBe(true);
    f.players[0]?.finish(0);
    await f.ra.idle();
    expect(f.ra.speaking()).toBe(false);
    expect(f.temps.size).toBe(0);
  });

  test("down + an exited container of the image: docker start <name>, poll until healthy", async () => {
    const f = fake({
      healthy: (i) => i >= 4,
      ps: { code: 0, stdout: "other\tpostgres:16\texited\namazing_x\tghcr.io/remsky/kokoro-fastapi-cpu:latest\texited\n", stderr: "" },
    });
    f.ra.speak(SHORT, "k");
    await f.settle();
    expect(f.runs.map((r) => r.cmd)).toEqual([
      ["docker", "ps", "-a", "--format", "{{.Names}}\t{{.Image}}\t{{.State}}"],
      ["docker", "start", "amazing_x"],
    ]);
    expect(f.healthCalls).toBe(5);
    expect(f.toasts).toEqual([NOTICE.voiceStarting, NOTICE.reading]);
    expect(f.players).toHaveLength(1);
  });

  test("down + no container: docker run -d --name fm1-kokoro on the URL's port (loopback only)", async () => {
    const f = fake({ healthy: (i) => i >= 2 });
    f.ra.speak(SHORT, "k");
    await f.settle();
    expect(f.runs[1]?.cmd).toEqual(["docker", "run", "-d", "--name", CONTAINER_NAME, "-p", "127.0.0.1:8880:8880", "ghcr.io/remsky/kokoro-fastapi-cpu:latest"]);
    expect(f.players).toHaveLength(1);
  });

  test("a running container that is still booting is only polled", async () => {
    const f = fake({ healthy: (i) => i >= 3, ps: { code: 0, stdout: "k\tghcr.io/remsky/kokoro-fastapi-cpu:v0.2\trunning\n", stderr: "" } });
    f.ra.speak(SHORT, "k");
    await f.settle();
    expect(f.runs).toHaveLength(1);
    expect(f.players).toHaveLength(1);
  });

  test("Docker missing or not running: Voice offline, nothing played", async () => {
    const f = fake({ healthy: () => false, ps: { code: -1, stdout: "", stderr: "", error: "cannot run docker: ENOENT" } });
    f.ra.speak(SHORT, "k");
    await f.ra.idle();
    expect(f.toasts).toEqual([NOTICE.voiceOffline]);
    expect(f.players).toHaveLength(0);
    expect(f.ra.speaking()).toBe(false);
  });

  test("never healthy: polling stops after BOOT_WAIT_MS with Voice offline", async () => {
    const f = fake({ healthy: () => false, ps: { code: 0, stdout: "kk\tghcr.io/remsky/kokoro-fastapi-cpu:latest\texited\n", stderr: "" } });
    f.ra.speak(SHORT, "k");
    await f.ra.idle();
    expect(f.deps.now()).toBe(BOOT_WAIT_MS);
    expect(f.toasts).toEqual([NOTICE.voiceStarting, NOTICE.voiceOffline]);
    expect(f.players).toHaveLength(0);
  });

  test("Kokoro speech error: Voice offline", async () => {
    const f = fake({ synthStatus: 400 });
    f.ra.speak(SHORT, "k");
    await f.ra.idle();
    expect(f.toasts).toEqual([NOTICE.voiceOffline]);
  });

  test("imageRepo strips the tag, not a registry port", () => {
    expect(imageRepo("ghcr.io/remsky/kokoro-fastapi-cpu:latest")).toBe("ghcr.io/remsky/kokoro-fastapi-cpu");
    expect(imageRepo("localhost:5000/kokoro")).toBe("localhost:5000/kokoro");
  });
});

describe("summary of long text", () => {
  test("long text goes to fm1-summarize on stdin (20 s limit); the summary is read", async () => {
    const f = fake();
    f.ra.speak(LONG, "k");
    await f.settle();
    const s = f.runs.find((r) => r.cmd[0] === "/bin/fm1-summarize");
    expect(s?.stdin).toBe(LONG);
    expect(s?.timeoutMs).toBe(SUMMARY_TIMEOUT_MS);
    expect(f.posts[0]?.body.input).toBe("A short summary.");
    expect(f.toasts).toEqual([NOTICE.readingSummary]);
  });

  test("model unavailable: the first ~600 characters are read, toast Summary unavailable", async () => {
    const f = fake({ summarize: { code: 2, stdout: "", stderr: "unavailable: Apple Intelligence is off\n" } });
    f.ra.speak(LONG, "k");
    await f.settle();
    const input = String(f.posts[0]?.body.input);
    expect(input.length).toBeLessThanOrEqual(600);
    expect(input.length).toBeGreaterThan(300);
    expect(input.endsWith(".")).toBe(true);
    expect(f.toasts).toEqual([NOTICE.summaryUnavailable]);
  });

  test("timeout and a missing helper behave the same", async () => {
    const t = fake({ summarize: { code: -1, stdout: "", stderr: "", error: "fm1-summarize timed out after 20000 ms" } });
    t.ra.speak(LONG, "k");
    await t.settle();
    expect(t.toasts).toEqual([NOTICE.summaryUnavailable]);
    const m = fake({ summarizer: null });
    m.ra.speak(LONG, "k");
    await m.settle();
    expect(m.runs).toHaveLength(0);
    expect(m.toasts).toEqual([NOTICE.summaryUnavailable]);
  });

  test("short text is never summarized; the threshold is configurable", async () => {
    const f = fake();
    f.cfg.summarizeOverChars = 10;
    f.ra.speak(SHORT, "k");
    await f.settle();
    expect(f.runs.some((r) => r.cmd[0] === "/bin/fm1-summarize")).toBe(true);
    const g = fake();
    g.ra.speak(SHORT, "k");
    await g.settle();
    expect(g.runs).toHaveLength(0);
  });
});

describe("playback: one at a time, stop kills afplay", () => {
  test("stop() kills afplay and removes the temp file", async () => {
    const f = fake();
    f.ra.speak(SHORT, "k");
    await f.settle();
    f.ra.stop();
    expect(f.players[0]?.killed).toBe(true);
    expect(f.ra.speaking()).toBe(false);
    await f.ra.idle();
    expect(f.temps.size).toBe(0);
  });

  test("a new request stops the current one", async () => {
    const f = fake();
    f.ra.speak(SHORT, "k");
    await f.settle();
    f.ra.speak("Second one.", "k2");
    expect(f.players[0]?.killed).toBe(true);
    await f.settle();
    expect(f.players).toHaveLength(2);
    expect(f.posts[1]?.body.input).toBe("Second one.");
    expect(f.ra.speaking()).toBe(true);
  });

  test("stopped while preparing: nothing is played", async () => {
    const f = fake({ healthy: (i) => i >= 3, ps: { code: 0, stdout: "k\tghcr.io/remsky/kokoro-fastapi-cpu:latest\texited\n", stderr: "" } });
    f.ra.speak(SHORT, "k");
    f.ra.stop();
    await f.ra.idle();
    expect(f.players).toHaveLength(0);
    expect(f.posts).toHaveLength(0);
  });
});

describe("config readAloud", () => {
  test("defaults are not written; a change round-trips", () => {
    expect(serializable(DEFAULT_CONFIG).readAloud).toBeUndefined();
    const cfg = mergeConfig(DEFAULT_CONFIG, { readAloud: { voice: "bf_emma", kokoroUrl: "http://127.0.0.1:9000/", summarizeOverChars: 800 } });
    expect(cfg.readAloud).toEqual({ ...DEFAULT_READ_ALOUD, voice: "bf_emma", kokoroUrl: "http://127.0.0.1:9000", summarizeOverChars: 800 });
    const back = mergeConfig(DEFAULT_CONFIG, JSON.parse(JSON.stringify(serializable(cfg))));
    expect(back.readAloud).toEqual(cfg.readAloud);
  });

  test("validation", () => {
    for (const bad of [
      { voice: "" },
      { voice: "a b" },
      { kokoroUrl: "ftp://x" },
      { kokoroUrl: "http://u:p@x" },
      { summarizeOverChars: 50 },
      { summarizeOverChars: 600.5 },
      { dockerImage: "-v /:/x" },
      { other: 1 },
    ]) {
      expect(() => mergeConfig(DEFAULT_CONFIG, { readAloud: bad })).toThrow(ConfigError);
    }
    expect(() => mergeConfig(DEFAULT_CONFIG, { readAloud: "x" })).toThrow(ConfigError);
  });
});

describe("companion wiring", () => {
  test("hold PLAY reaches the port; the timer's toast is reported against the PLAY frame", async () => {
    const { Companion } = await import("../src/companion");
    const { MockAdapter, loadFixture, fixturePath, READ_ALOUD_HOLD_MS } = await import("@fm1/agent-core");
    const tasks: { at: number; fn: () => void }[] = [];
    let now = 1_800_000_100_000;
    const timers = {
      setTimeout: (fn: () => void, ms: number) => tasks.push({ at: now + ms, fn }),
      clearTimeout: (h: unknown) => {
        const t = tasks[(h as number) - 1];
        if (t) t.fn = () => undefined;
      },
    };
    const spoken: string[] = [];
    let busy = false;
    const c = new Companion({
      adapter: new MockAdapter(loadFixture(fixturePath("mixed"))),
      capture: (() => {
        throw new Error("no capture");
      }) as never,
      transcriber: {} as never,
      timers,
      now: () => now,
      tickMs: 0,
      readAloud: () => ({ speak: (t) => (spoken.push(t), (busy = true)), stop: () => (busy = false), speaking: () => busy }),
    });
    await c.start();
    await c.handleInput({ kind: "encoder", encoder: "SELECT", delta: 1 }, 5);
    await c.handleInput({ kind: "button", button: "PLAY", edge: "down" }, 6);
    now += READ_ALOUD_HOLD_MS;
    for (const t of tasks.splice(0)) if (t.at <= now) t.fn();
    // The fixture sessions carry no message: the hold says so, tied to SEQ 6.
    expect(spoken).toHaveLength(0);
    expect(c.feedback.at(-1)).toMatchObject({ reqSeq: 6, text: NOTICE.nothingToRead });
    busy = true;
    await c.handleInput({ kind: "button", button: "FX", edge: "down" }, 7);
    expect(busy).toBe(false);
    expect(c.feedback.at(-1)).toMatchObject({ reqSeq: 7, text: NOTICE.readStopped });
    await c.stop();
  });
});
