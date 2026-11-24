// Canned responses in the companion (docs/ui-v3.md section 12): config storage (seed once, caps, round trip), the
// CLI, the running companion picking up CLI edits, and the device gestures over the link.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_REQ_SEQ } from "@fm1/device-protocol";
import { CANNED_SEED, seedCanned, type CannedEntry } from "@fm1/agent-core";
import { runCanned } from "../src/cli/canned";
import { main } from "../src/cli";
import { cannedReloader, ConfigError, DEFAULT_CONFIG, loadConfig, mergeConfig, saveConfig, serializable } from "../src/config";
import { rig, type Rig } from "./rig";

let dir = "";
let r: Rig | undefined;
afterEach(async () => {
  await r?.stop();
  r = undefined;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});
const tmpConfig = async (content?: unknown): Promise<string> => {
  dir = await mkdtemp(join(tmpdir(), "fm1-canned-"));
  const p = join(dir, "config.json");
  if (content !== undefined) await writeFile(p, JSON.stringify(content));
  return p;
};
const entry = (id: string, text: string, uses = 0, createdAt = 1): CannedEntry => ({ id, text, uses, createdAt, lastUsedAt: null });

describe("config `canned`", () => {
  test("seeded once: no file or no key gives the three seeds; an existing key (even empty) is never re-seeded", async () => {
    const none = await loadConfig(await tmpConfig());
    expect(none.canned.map((e) => e.text)).toEqual([...CANNED_SEED]);
    await rm(dir, { recursive: true, force: true });
    const p = await tmpConfig({ language: "en" });
    expect((await loadConfig(p)).canned.map((e) => e.text)).toEqual([...CANNED_SEED]);
    await saveConfig({ ...(await loadConfig(p)), canned: [] }, p);
    expect(JSON.parse(await readFile(p, "utf8")).canned).toEqual([]);
    expect((await loadConfig(p)).canned).toEqual([]);
  });

  test("round trip: always written, sorted (uses desc, createdAt desc), texts folded", async () => {
    const p = await tmpConfig({ canned: [entry("a", "Café  time", 0, 5), { ...entry("b", "Hot", 2, 1), lastUsedAt: 9 }] });
    const cfg = await loadConfig(p);
    expect(cfg.canned.map((e) => [e.id, e.text])).toEqual([["b", "Hot"], ["a", "Cafe time"]]);
    await saveConfig(cfg, p);
    expect(await loadConfig(p)).toEqual(cfg);
    expect(serializable(DEFAULT_CONFIG).canned).toEqual(seedCanned());
  });

  test("caps: at most 50, text at most 2000, unique ids and texts, well-formed entries", () => {
    const many = Array.from({ length: 51 }, (_, i) => entry(`e${i}`, `t${i}`));
    expect(() => mergeConfig(DEFAULT_CONFIG, { canned: many })).toThrow(ConfigError);
    expect(() => mergeConfig(DEFAULT_CONFIG, { canned: many.slice(0, 50) })).not.toThrow();
    expect(() => mergeConfig(DEFAULT_CONFIG, { canned: [entry("a", "x".repeat(2001))] })).toThrow("2000");
    expect(() => mergeConfig(DEFAULT_CONFIG, { canned: [entry("a", "x"), entry("a", "y")] })).toThrow("twice");
    expect(() => mergeConfig(DEFAULT_CONFIG, { canned: [entry("a", "Same"), entry("b", " same ")] })).toThrow("twice");
    expect(() => mergeConfig(DEFAULT_CONFIG, { canned: [entry("a", "   ")] })).toThrow("empty");
    expect(() => mergeConfig(DEFAULT_CONFIG, { canned: [{ ...entry("a", "x"), extra: 1 }] })).toThrow(ConfigError);
    expect(() => mergeConfig(DEFAULT_CONFIG, { canned: "nope" })).toThrow(ConfigError);
  });

  test("cannedReloader: reads on the first call, then only after the file changed", async () => {
    const p = await tmpConfig({ canned: [entry("a", "A")] });
    const reload = cannedReloader(p);
    expect((await reload())?.map((e) => e.text)).toEqual(["A"]);
    expect(await reload()).toBeNull();
    await Bun.sleep(5);
    await writeFile(p, JSON.stringify({ canned: [entry("b", "B")] }));
    expect((await reload())?.map((e) => e.text)).toEqual(["B"]);
  });
});

describe("CLI `fm1-console canned`", () => {
  test("add (words or --file), list, edit, rm by number or id; refusals", async () => {
    const p = await tmpConfig({ canned: [] });
    const lines: string[] = [];
    const out = (l: string) => void lines.push(l);
    let t = 1000;
    const opts = { path: p, out, now: () => t++ };
    await runCanned("add", ["Run", "the", "linter"], opts);
    const f = join(dir, "msg.txt");
    await writeFile(f, "  Deploy to staging\nplease \n");
    await runCanned("add", [], { ...opts, file: f });
    await expect(runCanned("add", ["run THE linter"], opts)).rejects.toThrow("already canned");
    lines.length = 0;
    await runCanned("list", [], opts);
    expect(lines).toEqual([expect.stringContaining("Deploy to staging please"), expect.stringContaining("Run the linter")]);
    expect(lines[0]).toMatch(/^ 1\. \[c[0-9a-z]+\] \(0 uses\) /);
    await runCanned("edit", ["2", "Run", "all", "tests"], opts);
    const cfg = await loadConfig(p);
    expect(cfg.canned.map((e) => e.text)).toEqual(["Deploy to staging please", "Run all tests"]);
    await runCanned("rm", [cfg.canned[0]!.id], opts);
    await runCanned("rm", ["1"], opts);
    expect((await loadConfig(p)).canned).toEqual([]);
    await expect(runCanned("rm", ["3"], opts)).rejects.toThrow("no entry");
    const full = Array.from({ length: 50 }, (_, i) => entry(`e${i}`, `t${i}`));
    await writeFile(p, JSON.stringify({ canned: full }));
    await expect(runCanned("add", ["one more"], opts)).rejects.toThrow("full");
  });

  test("main() routes `canned` to the config file named by FM1_CONSOLE_CONFIG; USAGE lists it", async () => {
    const p = await tmpConfig();
    const prev = process.env.FM1_CONSOLE_CONFIG;
    process.env.FM1_CONSOLE_CONFIG = p;
    const write = process.stdout.write.bind(process.stdout);
    let printed = "";
    process.stdout.write = ((s: string) => {
      printed += s;
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(await main(["canned", "add", "From", "main"])).toBe(0);
      expect(await main(["canned", "--help"])).toBe(0);
    } finally {
      process.stdout.write = write;
      if (prev === undefined) delete process.env.FM1_CONSOLE_CONFIG;
      else process.env.FM1_CONSOLE_CONFIG = prev;
    }
    // No key before: the seeds were loaded, the new entry joins them (newest first among equal uses).
    expect((await loadConfig(p)).canned.map((e) => e.text)).toEqual(["From main", ...CANNED_SEED]);
    expect(printed).toContain("canned add <text...>");
  });
});

describe("on the device", () => {
  const select = async (x: Rig) => {
    await x.driver.press(x.slotOf("s-claude-idle"));
    await x.driver.waitFor((s) => s.slots[x.slotOf("s-claude-idle")]?.flags.selected === true);
  };

  test("REC tap opens the seeded canned list; PRESETS cycles; SAVE sends it and counts the use", async () => {
    r = await rig({ layouts: { sessions: "buddy", inbox: "list" } });
    const x = r;
    await select(x);
    await x.driver.tap("REC");
    await x.driver.waitFor((s) => s.voice.voice === "reviewing", 2000);
    expect(x.device.state.text[1]).toEqual({ style: "heading", text: "Canned 1/3  PRESETS next" });
    x.driver.turn("PRESETS", 1);
    await x.driver.waitFor((s) => s.text[1]?.text === "Canned 2/3  PRESETS next");
    expect(x.transcriber.calls).toBe(0);
    expect(x.adapter.deliveries).toHaveLength(0);
    await x.driver.tap("SAVE");
    await x.driver.waitFor((s) => s.voice.voice === "delivered", 3000);
    await x.companion.idle();
    expect(x.adapter.deliveries.map((d) => d.text)).toEqual([CANNED_SEED[1] as string]);
    expect(x.companion.config.canned[0]).toMatchObject({ text: CANNED_SEED[1], uses: 1 });
  });

  test("ARP tap on a dictated review saves it (toast), never opens SETTINGS; FX held 1 s deletes a canned entry", async () => {
    r = await rig({ layouts: { sessions: "buddy", inbox: "list" }, canned: [entry("a", "Alpha", 0, 2), entry("b", "Bravo", 0, 1)] });
    const x = r;
    await select(x);
    await x.driver.hold("REC", 1200);
    await x.driver.waitFor((s) => s.voice.voice === "reviewing", 3000);
    await x.driver.tap("ARP");
    await x.driver.waitFor((s) => s.lastResult?.text === "Saved as canned 3", 2000);
    expect(x.companion.config.canned).toHaveLength(3);
    expect(x.device.state.view.view).toBe("voice");
    expect(x.adapter.deliveries).toHaveLength(0);
    await x.driver.tap("FX");
    await x.driver.waitFor((s) => s.voice.voice !== "reviewing", 2000);

    await x.driver.tap("REC");
    await x.driver.waitFor((s) => s.voice.voice === "reviewing", 2000);
    const first = x.companion.console.composer.state.transcript;
    await x.driver.hold("FX", 1100);
    await x.driver.waitFor((s) => s.lastResult?.text === "Canned deleted", 2000);
    expect(x.companion.config.canned.map((e) => e.text)).not.toContain(first);
    await x.driver.tap("FX");
    await x.driver.waitFor((s) => s.lastResult?.text === "Canned restored", 2000);
    expect(x.companion.config.canned.map((e) => e.text)).toContain(first);
  });

  test("a CLI edit made while the companion runs is picked up before the next input", async () => {
    const p = await tmpConfig({ canned: [entry("a", "Before")] });
    r = await rig({ layouts: { sessions: "buddy", inbox: "list" }, reloadCanned: cannedReloader(p) });
    const x = r;
    await x.companion.handleInput({ kind: "encoder", encoder: "K1", delta: 0 }, NO_REQ_SEQ);
    expect(x.companion.console.state.canned.map((e) => e.text)).toEqual(["Before"]);
    await Bun.sleep(5);
    await runCanned("add", ["Added", "by", "CLI"], { path: p, out: () => undefined, now: () => 5 });
    // Awaited directly: the re-read is real file I/O, which the fake-clock driver waits do not wait for.
    await x.companion.handleInput({ kind: "key", key: x.slotOf("s-claude-idle"), gesture: "single" }, NO_REQ_SEQ);
    expect(x.companion.console.state.canned.map((e) => e.text)).toEqual(["Added by CLI", "Before"]);
    expect(x.companion.config.canned).toHaveLength(2);
  });
});
