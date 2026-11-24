// Read aloud (docs/ui-v3.md section 14): hold PLAY vs tap, stop via PLAY / FX, and the speech text.
import { describe, expect, test } from "bun:test";
import type { ReadAloudPort } from "../src/console";
import { NOTICE } from "../src/copy";
import { markdownBlocks } from "../src/markdown";
import { blocksSpeech, clipSpeech, CODE_OMITTED, READ_ALOUD_HOLD_MS, speechText } from "../src/speech";
import type { ButtonName } from "../src/controls";
import { keyOf, rig, slotOf, type Rig } from "./helpers";

class FakeSpeech implements ReadAloudPort {
  spoken: { text: string; key: string }[] = [];
  stops = 0;
  busy = false;
  speak(text: string, key: string): void {
    this.spoken.push({ text, key });
    this.busy = true;
  }
  stop(): void {
    this.stops++;
    this.busy = false;
  }
  speaking(): boolean {
    return this.busy;
  }
}

const down = (r: Rig, button: ButtonName) => r.console.handleInput({ kind: "button", button, edge: "down" });
const up = (r: Rig, button: ButtonName) => r.console.handleInput({ kind: "button", button, edge: "up" });

async function speechRig(message: string | null = "## Done\n\nAll **tests** pass.") {
  const speech = new FakeSpeech();
  const r = await rig("mixed", { scope: "recent", readAloud: speech });
  const e = r.console.registry.get(keyOf(r, "s-claude-idle"));
  if (!e) throw new Error("missing");
  r.adapter.upsertSession({ ...e.session, details: message === null ? {} : { lastMessage: message, lastMessageAt: 1 } });
  await r.console.handleInput({ kind: "key", key: slotOf(r, "s-claude-idle"), gesture: "single" });
  r.adapter.focusCalls.length = 0;
  return { r, speech };
}

describe("hold PLAY reads aloud; a tap opens on Mac (no double action)", () => {
  test("a tap opens the chat on release, never reads", async () => {
    const { r, speech } = await speechRig();
    await down(r, "PLAY");
    expect(r.adapter.focusCalls).toHaveLength(0);
    r.timers.advance(READ_ALOUD_HOLD_MS - 1);
    await up(r, "PLAY");
    expect(r.adapter.focusCalls).toHaveLength(1);
    expect(speech.spoken).toHaveLength(0);
    r.timers.advance(5000);
    expect(speech.spoken).toHaveLength(0);
  });

  test("a hold reads at READ_ALOUD_HOLD_MS while still down; the release does nothing", async () => {
    const { r, speech } = await speechRig();
    await down(r, "PLAY");
    r.timers.advance(READ_ALOUD_HOLD_MS);
    expect(speech.spoken).toEqual([{ text: "Done. All tests pass.", key: keyOf(r, "s-claude-idle") }]);
    await up(r, "PLAY");
    expect(r.adapter.focusCalls).toHaveLength(0);
    expect(speech.spoken).toHaveLength(1);
  });

  test("a late up edge (timer missed) still reads, once", async () => {
    const { r, speech } = await speechRig();
    await down(r, "PLAY");
    // The clock moves without the timer firing (FakeTimers.now only).
    r.timers.now += READ_ALOUD_HOLD_MS + 50;
    await up(r, "PLAY");
    expect(speech.spoken).toHaveLength(1);
    expect(r.adapter.focusCalls).toHaveLength(0);
    r.timers.advance(0);
    expect(speech.spoken).toHaveLength(1);
  });

  test("works on the DETAILS page too", async () => {
    const { r, speech } = await speechRig();
    r.console.setProtocol(4);
    await down(r, "LFO");
    expect(r.console.view().view).toBe("detail");
    await down(r, "PLAY");
    r.timers.advance(READ_ALOUD_HOLD_MS);
    expect(speech.spoken).toHaveLength(1);
  });

  test("nothing to read: a toast, no speech", async () => {
    const { r, speech } = await speechRig(null);
    let toast: string | undefined;
    r.console.onTimerStep = (s) => (toast = s.state.notice?.text);
    await down(r, "PLAY");
    r.timers.advance(READ_ALOUD_HOLD_MS);
    expect(speech.spoken).toHaveLength(0);
    expect(toast).toBe(NOTICE.nothingToRead);
  });

  test("Tasks keeps PLAY new chat on the down edge", async () => {
    const { r, speech } = await speechRig();
    await down(r, "EDIT");
    await r.console.handleInput({ kind: "encoder", encoder: "SELECT", delta: 1 });
    await down(r, "PLAY");
    expect(r.console.view().view).toBe("confirm");
    r.timers.advance(READ_ALOUD_HOLD_MS);
    expect(speech.spoken).toHaveLength(0);
  });
});

describe("stop while speaking", () => {
  test("PLAY stops (its release does not open the chat)", async () => {
    const { r, speech } = await speechRig();
    speech.busy = true;
    await down(r, "PLAY");
    expect(speech.stops).toBe(1);
    expect(r.console.state.notice?.text).toBe(NOTICE.readStopped);
    r.timers.advance(READ_ALOUD_HOLD_MS);
    await up(r, "PLAY");
    expect(r.adapter.focusCalls).toHaveLength(0);
    expect(speech.spoken).toHaveLength(0);
  });

  test("FX stops; with nothing speaking FX keeps its meaning", async () => {
    const { r, speech } = await speechRig();
    speech.busy = true;
    await down(r, "FX");
    expect(r.console.state.notice?.text).toBe(NOTICE.readStopped);
    await up(r, "FX");
    expect(speech.stops).toBe(1);
    await down(r, "FX");
    expect(speech.stops).toBe(1);
  });

  test("REC (voice start) stops playback so the microphone never hears it", async () => {
    const { r, speech } = await speechRig();
    await down(r, "PLAY");
    r.timers.advance(READ_ALOUD_HOLD_MS);
    await up(r, "PLAY");
    await down(r, "REC");
    expect(speech.stops).toBe(1);
  });
});

describe("speech text", () => {
  test("headings as sentences, list items, code omitted, tables row by row, links by label", () => {
    const md = [
      "# Summary",
      "I fixed the [parser](https://example.com/x) and ran the tests",
      "",
      "- renamed `decode`",
      "- added tests",
      "1. review",
      "",
      "```ts",
      "const a = 1;",
      "```",
      "```sh",
      "bun test",
      "```",
      "",
      "| File | Status |",
      "| --- | --- |",
      "| view.ts | done |",
      "| copy.ts | |",
      "",
      "> careful here",
    ].join("\n");
    const s = blocksSpeech(markdownBlocks(md));
    expect(s).toBe(
      `Summary. I fixed the parser and ran the tests. renamed decode. added tests. 1, review. ${CODE_OMITTED} File view.ts, Status done. File copy.ts. Quote: careful here.`,
    );
    expect(/^[\x20-\x7e]*$/.test(s)).toBe(true);
  });

  test("plain text without blocks; bare URLs and leftovers dropped", () => {
    expect(speechText({ text: "See https://x.y/z for **more**" })).toBe("See link for more.");
    expect(speechText({ text: "" })).toBe("");
  });

  test("clipSpeech cuts at a sentence end, else a word", () => {
    const t = "First sentence here. Second sentence is a lot longer than the first one.";
    expect(clipSpeech(t, 40)).toBe("First sentence here.");
    expect(clipSpeech("word ".repeat(40).trim(), 23)).toBe("word word word word.");
    expect(clipSpeech("short", 40)).toBe("short");
  });
});
