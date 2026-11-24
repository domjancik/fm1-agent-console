import { describe, expect, test } from "bun:test";
import { gate } from "../src/gate";
import { applySpokenPunctuation, applyVocabulary, parseVocabulary, postprocess, type VocabularyEntry } from "../src/postprocess";
import { DEFAULT_VOCABULARY, loadVocabulary } from "../src/text/vocabulary-config";
import { loadWavFor16k } from "../src/audio/load";
import { existsSync } from "node:fs";

describe("spoken punctuation", () => {
  const cases: Array<[string, string]> = [
    ["run the tests period", "run the tests."],
    ["run the tests full stop", "run the tests."],
    ["first comma second", "first, second"],
    ["is it done question mark", "is it done?"],
    ["wow exclamation mark", "wow!"],
    ["note colon this", "note: this"],
    ["a semicolon b", "a; b"],
    ["call foo open paren x comma y close paren", "call foo (x, y)"],
    ["list open bracket one close bracket", "list [one]"],
    ["map open brace key close brace", "map {key}"],
    ["he said open quote hi close quote", 'he said "hi"'],
    ["line one new line line two", "line one\nLine two"],
    ["para one new paragraph para two", "para one\n\nPara two"],
  ];
  for (const [input, expected] of cases) {
    test(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
      expect(applySpokenPunctuation(input)).toBe(expected);
    });
  }

  test("absorbs Parakeet's own punctuation around a spoken mark", () => {
    expect(applySpokenPunctuation("send message, comma, and log it")).toBe("send message, and log it");
    expect(applySpokenPunctuation("then run the tests, period.")).toBe("then run the tests.");
    expect(applySpokenPunctuation("the voice composer question mark?")).toBe("the voice composer?");
  });

  test("capitalizes after a spoken sentence end", () => {
    expect(applySpokenPunctuation("done period next step")).toBe("done. Next step");
  });

  test("is case-insensitive and tolerates extra spaces", () => {
    expect(applySpokenPunctuation("Done. Period. Next")).toBe("Done. Next");
    expect(applySpokenPunctuation("a  question   mark")).toBe("a?");
  });

  test("'literal' keeps the word", () => {
    expect(applySpokenPunctuation("type the word literal comma here")).toBe("type the word comma here");
  });

  test("does not touch words that merely contain a mark", () => {
    expect(applySpokenPunctuation("commander periodic colonel")).toBe("commander periodic colonel");
  });

  test("leaves text without marks unchanged", () => {
    expect(applySpokenPunctuation("  Fix the bug, then ship.  ")).toBe("Fix the bug, then ship.");
  });
});

describe("vocabulary correction", () => {
  test("default entries fix Traycer and Claude Code", () => {
    expect(applyVocabulary("In the tracer adapter", DEFAULT_VOCABULARY)).toBe("In the Traycer adapter");
    expect(applyVocabulary("ask Cloud Code to do it", DEFAULT_VOCABULARY)).toBe("ask Claude Code to do it");
    expect(applyVocabulary("ask cloud code", DEFAULT_VOCABULARY)).toBe("ask Claude Code");
  });

  test("word boundaries: no partial matches", () => {
    expect(applyVocabulary("tracers and retracer and tracer-like", DEFAULT_VOCABULARY)).toBe("tracers and retracer and tracer-like");
    expect(applyVocabulary("cloud coder", DEFAULT_VOCABULARY)).toBe("cloud coder");
  });

  test("preserves all-caps", () => {
    expect(applyVocabulary("the TRACER test", DEFAULT_VOCABULARY)).toBe("the TRAYCER test");
  });

  test("Codex only with agent context and not for media codecs", () => {
    expect(applyVocabulary("ask codecs to review the diff", DEFAULT_VOCABULARY)).toBe("ask Codex to review the diff");
    expect(applyVocabulary("send it to the codecs session", DEFAULT_VOCABULARY)).toBe("send it to the Codex session");
    expect(applyVocabulary("which codecs does it support", DEFAULT_VOCABULARY)).toBe("which codecs does it support");
    expect(applyVocabulary("ask about audio codecs", DEFAULT_VOCABULARY)).toBe("ask about audio codecs");
  });

  test("tracer kept in tracing context", () => {
    expect(applyVocabulary("the OpenTelemetry tracer emits a span", DEFAULT_VOCABULARY)).toBe("the OpenTelemetry tracer emits a span");
  });

  test("custom entries and validation", () => {
    const entries: VocabularyEntry[] = parseVocabulary([{ from: ["fm one", "f m one"], to: "FM1" }]);
    expect(applyVocabulary("open the fm one console", entries)).toBe("open the FM1 console");
    expect(() => parseVocabulary({})).toThrow();
    expect(() => parseVocabulary([{ from: "x", to: "y" }])).toThrow();
    expect(() => parseVocabulary([{ from: ["x"], to: "y", requireAny: "z" }])).toThrow();
  });

  test("loadVocabulary reads a JSON file and fails clearly on a missing one", async () => {
    const path = `${process.env.TMPDIR ?? "/tmp"}/fm1-vocab-${process.pid}.json`;
    await Bun.write(path, JSON.stringify([{ from: ["kube"], to: "Kubernetes" }]));
    const entries = await loadVocabulary(path);
    expect(applyVocabulary("deploy to kube", entries)).toBe("deploy to Kubernetes");
    await expect(loadVocabulary("/nonexistent/vocab.json")).rejects.toThrow("not found");
  });
});

describe("postprocess", () => {
  test("punctuation then vocabulary on real Parakeet output", () => {
    expect(postprocess("In the tracer adapter add a retry to send message, comma and log the session ID period.")).toBe(
      "In the Traycer adapter add a retry to send message, and log the session ID.",
    );
  });

  test("spoken punctuation can be disabled", () => {
    expect(postprocess("tests period", { spokenPunctuation: false, vocabulary: [] })).toBe("tests period");
  });
});

describe("silence gate", () => {
  const rate = 16000;
  const tone = (seconds: number, amplitude: number): Int16Array => {
    const out = new Int16Array(Math.round(rate * seconds));
    for (let i = 0; i < out.length; i++) out[i] = Math.round(amplitude * Math.sin((2 * Math.PI * 220 * i) / rate));
    return out;
  };

  test("rejects empty, too short and silent audio", () => {
    expect(gate(new Int16Array(0), rate).reason).toBe("empty");
    expect(gate(tone(0.1, 8000), rate).reason).toBe("too_short");
    expect(gate(tone(2, 0), rate).reason).toBe("silent");
    expect(gate(tone(2, 100), rate).reason).toBe("silent"); // about -50 dBFS
  });

  test("accepts audible speech-level audio", () => {
    const verdict = gate(tone(1, 6000), rate);
    expect(verdict.accepted).toBe(true);
    expect(verdict.stats.voicedMs).toBeGreaterThan(900);
  });

  test("a short burst inside silence is still silent", () => {
    const pcm = tone(2, 0);
    pcm.set(tone(0.09, 10000), 8000);
    expect(gate(pcm, rate).reason).toBe("silent");
  });

  const sample = "/Users/dominikj/dev/personal/voice-processor/recorded_audio.wav";
  test.skipIf(!existsSync(sample))("rejects the -47 dBFS voice-processor recording as silent", async () => {
    const audio = await loadWavFor16k(sample);
    const verdict = gate(audio.pcm, audio.sampleRate);
    expect(verdict.stats.rmsDbfs).toBeLessThan(-45);
    expect(verdict.reason).toBe("silent");
  });
});
