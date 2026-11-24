// `fm1-console test voice --fixture <wav>`: the real speech pipeline into the composer's review state.
// No dispatch unless --dispatch, and then only to an allowlisted (or mock) target.
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { NO_REQ_SEQ } from "@fm1/device-protocol";
import { createAdapter, type AdapterKind } from "../adapters";
import { Companion } from "../companion";
import { loadConfig } from "../config";
import { DiagLog } from "../diag-log";
import { FixtureCapture, loadFixtureAudio } from "../voice/capture";
import { SpeechTranscriber } from "../voice/transcriber";
import { EXIT_UNAVAILABLE, isAllowlisted } from "./delegate";

export interface TestVoiceOptions {
  fixture: string;
  adapter: AdapterKind;
  dispatch: boolean;
  /** mock: a sessionId; traycer: <epicId>/<chatId> from the disposable allowlist. */
  target?: string;
  engine?: "sherpa" | "apple";
  language?: string;
}

interface Expected {
  file: string;
  expected: string;
  rejected?: string;
}

function expectedFor(wav: string): Expected | undefined {
  const path = join(dirname(wav), "expected.json");
  if (!existsSync(path)) return undefined;
  const v = JSON.parse(readFileSync(path, "utf8")) as { fixtures?: Expected[] };
  return v.fixtures?.find((f) => f.file === basename(wav));
}

const out = (s: string): void => {
  process.stdout.write(`${s}\n`);
};

export async function testVoice(o: TestVoiceOptions): Promise<number> {
  if (!existsSync(o.fixture)) {
    out(`fixture not found: ${o.fixture}`);
    return EXIT_UNAVAILABLE;
  }
  const cfg = await loadConfig();
  const engine = o.engine ?? cfg.asrEngine;
  const language = o.language ?? cfg.language;
  let epicChat: [string, string] | null = null;
  if (o.adapter === "traycer") {
    const [epicId, chatId] = (o.target ?? "").split("/");
    if (!epicId || !chatId) {
      out("--adapter traycer needs --target <epicId>/<chatId>");
      return EXIT_UNAVAILABLE;
    }
    if (o.dispatch && !isAllowlisted(epicId, chatId)) {
      out(`refusing --dispatch: ${epicId}/${chatId} is not in reports/disposable-allowlist.json`);
      return EXIT_UNAVAILABLE;
    }
    epicChat = [epicId, chatId];
  }

  const log = new DiagLog(200, Date.now, (e) => process.stderr.write(`${e.level} ${e.source}: ${e.text}\n`));
  const adapter = await createAdapter(o.adapter);
  const audio = await loadFixtureAudio(o.fixture);
  const transcriber = new SpeechTranscriber({ engine, language, vocabularyFile: cfg.vocabularyFile });
  const companion = new Companion({ adapter, capture: () => new FixtureCapture(audio, undefined, basename(o.fixture)), transcriber, config: cfg, log });
  try {
    await companion.start();
    const sessions = companion.console.registry.sessions().filter((e) => !e.stale);
    const entry = epicChat
      ? sessions.find((e) => e.session.ref.taskId === epicChat[0] && e.session.ref.sessionId === epicChat[1])
      : sessions.find((e) => (o.target ? e.session.ref.sessionId === o.target : e.session.runtime === "chat"));
    if (!entry) {
      out(`target session not found (${o.target ?? "first chat session"}); backend ${companion.console.registry.connection()}`);
      return EXIT_UNAVAILABLE;
    }
    companion.console.registry.select(entry.key);
    const t0 = performance.now();
    await companion.handleInput({ kind: "button", button: "REC", edge: "down" }, NO_REQ_SEQ);
    await companion.handleInput({ kind: "button", button: "REC", edge: "up" }, NO_REQ_SEQ);
    await companion.idle();
    const c = companion.console.composer.state;
    out(`fixture:     ${o.fixture} (${audio.sampleRate} Hz, ${(audio.pcm.length / audio.sampleRate).toFixed(2)} s)`);
    out(`engine:      ${engine} / ${language}  (${Math.round(performance.now() - t0)} ms incl. model load)`);
    out(`destination: ${c.destination?.label ?? "-"} (${entry.key})`);
    out(`state:       ${c.state}${c.error ? ` (${c.error})` : ""}`);
    out(`transcript:  ${c.transcript}`);

    const exp = expectedFor(o.fixture);
    let verdict = c.state === "reviewing";
    if (exp?.rejected) verdict = c.state === "failed";
    else if (exp) {
      const match = c.transcript === exp.expected;
      out(`expected:    ${exp.expected}  -> ${match ? "MATCH" : "MISMATCH"}`);
      verdict &&= match;
    }

    if (o.dispatch && c.state === "reviewing") {
      await companion.pressButton("SAVE");
      const deadline = Date.now() + 15_000;
      while (companion.console.composer.state.state === "submitting" && Date.now() < deadline) await Bun.sleep(100);
      await companion.idle();
      const after = companion.console.composer.state;
      out(`dispatch:    ${companion.relay.stages().map((s) => s.stage).join(" -> ")} => ${after.state}${after.error ? ` (${after.error})` : ""}`);
      verdict &&= after.state === "delivered";
    } else if (c.state === "reviewing") {
      await companion.pressButton("FX");
      out("dispatch:    none (review only; pass --dispatch to send)");
    }
    out(verdict ? "RESULT: PASS" : "RESULT: FAIL");
    return verdict ? 0 : 1;
  } finally {
    await companion.stop();
    await transcriber.dispose();
  }
}
