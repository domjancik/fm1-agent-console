// Suggested next prompts (docs/ui-v3.md section 11): a GUI chat's `suggestedPrompt` (chat.subscribe >= 1.20, an absent
// key clears it, clean fallback below 1.20) and a terminal agent's trailing "next steps" list in its last answer.
import { afterEach, describe, expect, test } from "bun:test";
import type { SessionRef } from "@fm1/agent-core";
import { ChatDetails, SUGGESTED_PROMPT_MINOR } from "../src/agent/chat-details";
import type { TraycerSession } from "../src/agent/session-book";
import { parseNextSteps, parseTranscript, SUGGESTION_ITEM_MAX } from "../src/agent/terminal-transcript";
import type { ChatFrame } from "../src/streams";
import { chatSnapshot, HOST, makeHarness, standardWorld, until, type Harness } from "./scenario";

let h: Harness | null = null;
afterEach(async () => {
  await h?.dispose();
  h = null;
});

const ALPHA = "ws:/Users/me/dev/alpha";
const ref = (taskId: string, sessionId: string): SessionRef => ({ backendId: "traycer", hostId: HOST, projectId: ALPHA, taskId, sessionId });
const lastUpsert = (harness: Harness, id: string): TraycerSession | undefined => {
  const e = [...harness.events].reverse().find((x) => x.type === "session_upserted" && x.session.ref.sessionId === id);
  return e?.type === "session_upserted" ? (e.session as TraycerSession) : undefined;
};

const snap = (extra: Record<string, unknown> = {}): ChatFrame => ({ kind: "snapshot", snapshot: { runStatus: "idle", activeTurn: null, tail: { messages: [], events: [] }, ...extra } });
const turn = (extra: Record<string, unknown> = {}): ChatFrame => ({ kind: "turnStateChanged", runStatus: "idle", activeTurn: null, ...extra });

describe("ChatDetails: suggestedPrompt", () => {
  test("set from the snapshot and from turnStateChanged; an absent key clears it", () => {
    const d = new ChatDetails();
    d.consume(snap({ suggestedPrompt: "Run the **tests** now" }), 0);
    expect(d.details().suggestions).toEqual(["Run the tests now"]);
    d.consume(turn({ suggestedPrompt: "Open a PR" }), 0);
    expect(d.details().suggestions).toEqual(["Open a PR"]);
    d.consume(turn({ runStatus: "running", activeTurn: { turnId: "t", status: "running" } }), 0); // run opened: key absent
    expect(d.details().suggestions).toBeUndefined();
    d.consume(turn({ suggestedPrompt: "Again" }), 0);
    d.consume(snap(), 0); // a snapshot without the key clears too
    expect(d.details().suggestions).toBeUndefined();
  });

  test("other frames leave it alone; the stream closing clears it (live-only state)", () => {
    const d = new ChatDetails();
    d.consume(turn({ suggestedPrompt: "Ship it" }), 0);
    d.consume({ kind: "blockDelta", event: { type: "usage.updated", usage: { contextTokens: 1, contextWindow: 10 } } }, 0);
    expect(d.details().suggestions).toEqual(["Ship it"]);
    d.closed();
    expect(d.details().suggestions).toBeUndefined();
  });

  test("redacted, ASCII-folded, capped at 600; empty or non-string means none", () => {
    const d = new ChatDetails();
    d.consume(turn({ suggestedPrompt: "Set API_TOKEN=abc123secretvalue — then “retry” ✓" }), 0);
    expect(d.details().suggestions).toEqual(['Set API_TOKEN=<redacted> - then "retry" ok']);
    d.consume(turn({ suggestedPrompt: "word ".repeat(300) }), 0);
    expect(d.details().suggestions?.[0]?.length).toBeLessThanOrEqual(600);
    d.consume(turn({ suggestedPrompt: "   " }), 0);
    expect(d.details().suggestions).toBeUndefined();
    d.consume(turn({ suggestedPrompt: 42 }), 0);
    expect(d.details().suggestions).toBeUndefined();
  });

  test("below chat.subscribe 1.20 the key is ignored (clean fallback)", () => {
    let minor = 19;
    const d = new ChatDetails({ suggestions: () => minor >= SUGGESTED_PROMPT_MINOR });
    d.consume(turn({ suggestedPrompt: "Not on this line" }), 0);
    expect(d.details().suggestions).toBeUndefined();
    minor = 20;
    d.consume(turn({ suggestedPrompt: "On 1.20" }), 0);
    expect(d.details().suggestions).toEqual(["On 1.20"]);
  });
});

describe("terminal transcripts: next steps", () => {
  const answer = (body: string) => `<user_message>\nDo it\n</user_message>\n<assistant_response>\n${body}\n</assistant_response>\n`;

  test("heading variants (case-insensitive), bullets and numbers, up to 3 items", () => {
    const cases: Array<[string, string[]]> = [
      ["Done.\n\nNext steps:\n- Run the tests\n- Update docs", ["Run the tests", "Update docs"]],
      ["Done.\n\n## Suggested next steps\n1. First\n2. Second\n3. Third\n4. Fourth", ["First", "Second", "Third"]],
      ["**Next steps:**\n* one\n* two", ["one", "two"]],
      ["**Next steps**:\n+ alpha", ["alpha"]],
      ["SUGGESTED NEXT\n1) go", ["go"]],
      ["### Recommended next steps\n- [ ] check CI", ["check CI"]],
      ["Possible next actions (optional):\n- a", ["a"]],
    ];
    for (const [body, want] of cases) expect(parseNextSteps(body)).toEqual(want);
  });

  test("the last heading wins; continuation lines join; the list ends at the first other line", () => {
    const body = ["Next steps:", "- old", "", "More text.", "", "Next steps:", "- Refactor the registry", "  so pins survive reconnects", "", "- Add tests", "Let me know which one."].join("\n");
    expect(parseNextSteps(body)).toEqual(["Refactor the registry so pins survive reconnects", "Add tests"]);
  });

  test("none: no heading, a heading with no list, inline prose, or a bare `Next:`", () => {
    expect(parseNextSteps("All done. Tests pass.")).toEqual([]);
    expect(parseNextSteps("Next steps:\nI will wait for your review.")).toEqual([]);
    expect(parseNextSteps("Next steps are to run the tests and deploy.")).toEqual([]);
    expect(parseNextSteps("Next:\n- something")).toEqual([]);
  });

  test("fenced code is never a heading or an item: a README or script shown in the answer has no suggestions", () => {
    expect(parseNextSteps("Wrote the README:\n\n```md\n## Next steps\n- Deploy to prod\n- Rotate keys\n```\n\nDone.")).toEqual([]);
    expect(parseNextSteps("~~~\n# Next steps\n- foo\n~~~")).toEqual([]);
    // The real list outside a later code block still wins.
    expect(parseNextSteps("Next steps:\n- Ship it\n\n```sh\n# Next steps\n- not this\n```")).toEqual(["Ship it"]);
    // Code under an item is dropped (secrets in it never join the item); a fence at the margin ends the list.
    const out = parseNextSteps("Next steps:\n- Set the key\n  ```bash\n  export API_KEY=sk-abc123456789\n  ```\n- Deploy\n```\nmore\n```\n- after");
    expect(out).toEqual(["Set the key", "Deploy"]);
  });

  test("nested sub-items are detail of their parent, not suggestions of their own", () => {
    expect(parseNextSteps("## Next steps\n- Add tests\n  - unit for the parser\n  - e2e\n- Ship it")).toEqual(["Add tests", "Ship it"]);
    expect(parseNextSteps("Next steps:\n1. Add tests\n   - unit\n     more unit\n2. Ship")).toEqual(["Add tests", "Ship"]);
  });

  test("items are markdown-reduced, redacted, ASCII-folded and capped", () => {
    const long = `Investigate ${"really ".repeat(40)}slow builds`;
    const out = parseNextSteps(`Next steps:\n- Run \`bun test\` with **care**\n- Export API_TOKEN=abc123secretvalue — “now”\n- ${long}`);
    expect(out[0]).toBe("Run bun test with care");
    expect(out[1]).toBe('Export API_TOKEN=<redacted> - "now"');
    expect(out[2]!.length).toBeLessThanOrEqual(SUGGESTION_ITEM_MAX);
    for (const x of out) expect(x).toMatch(/^[\x20-\x7e]*$/);
    expect(JSON.stringify(out)).not.toContain("abc123secretvalue");
  });

  test("parseTranscript: suggestions come from the last answer only; a newer user message clears them", () => {
    expect(parseTranscript(answer("Done.\n\nNext steps:\n- A\n- B")).suggestions).toEqual(["A", "B"]);
    const moved = `${answer("Next steps:\n- A")}<user_message>\nA\n</user_message>\n`;
    expect(parseTranscript(moved).suggestions).toBeUndefined();
    const newer = `${answer("Next steps:\n- A")}<user_message>\nA\n</user_message>\n<assistant_response>\nDid A. No more.\n</assistant_response>\n`;
    expect(parseTranscript(newer).suggestions).toBeUndefined();
    expect(parseTranscript(answer("Nothing to suggest.")).suggestions).toBeUndefined();
  });

  test("through the adapter: a watched terminal agent's details carry the suggestions", async () => {
    const w = standardWorld();
    let text = answer("Built it.\n\nSuggested next steps:\n1. Run the full suite\n2. Open a PR");
    w.overrides["agent.getTranscript"] = () => ({ result: { transcript: text } });
    h = makeHarness({ world: w, config: { terminalRefreshMs: 40 } });
    await h.adapter.connect();
    await h.adapter.listSessions("e1");
    h.adapter.watchSession(ref("e1", "t1"));
    await until(() => lastUpsert(h!, "t1")?.details?.suggestions !== undefined, 2_000, "terminal suggestions");
    expect(lastUpsert(h, "t1")?.details?.suggestions).toEqual(["Run the full suite", "Open a PR"]);
    text = answer("Opened the PR.");
    await until(() => lastUpsert(h!, "t1")?.details?.lastMessage === "Opened the PR.", 2_000, "newer answer");
    expect(lastUpsert(h, "t1")?.details?.suggestions).toBeUndefined();
  });

  test("unwatched, a terminal agent's suggestions are dropped (nothing keeps them current), its last message kept", async () => {
    const w = standardWorld();
    w.overrides["agent.getTranscript"] = () => ({ result: { transcript: answer("Built it.\n\nNext steps:\n- Run the suite") } });
    h = makeHarness({ world: w, config: { terminalRefreshMs: 40 } });
    await h.adapter.connect();
    await h.adapter.listSessions("e1");
    const release = h.adapter.watchSession(ref("e1", "t1"));
    await until(() => lastUpsert(h!, "t1")?.details?.suggestions !== undefined, 2_000, "terminal suggestions");
    release();
    await until(() => lastUpsert(h!, "t1")?.details?.suggestions === undefined, 2_000, "dropped on unwatch");
    expect(lastUpsert(h, "t1")?.details?.lastMessage).toContain("Built it.");
  });
});

describe("GUI chats through the adapter (fake host, real vendored client)", () => {
  async function watchGui(streamManifest?: (m: Record<string, unknown>) => Record<string, unknown>) {
    const subs: Array<{ send(f: Record<string, unknown>): void }> = [];
    h = makeHarness({
      world: standardWorld(),
      host: {
        ...(streamManifest ? { streamManifest } : {}),
        onSubscribe: (sub) => {
          if (sub.method !== "chat.subscribe") return;
          subs.push(sub);
          sub.send(chatSnapshot("e1", "c1", { suggestedPrompt: "Run the tests" }));
        },
      },
    });
    await h.adapter.connect();
    await h.adapter.listSessions("e1");
    h.adapter.watchSession(ref("e1", "c1"));
    await until(() => subs.length > 0 && lastUpsert(h!, "c1")?.details !== undefined, 3_000, "chat details");
    return subs;
  }

  test("negotiated >= 1.20: the snapshot's suggestedPrompt reaches Session.details.suggestions", async () => {
    await watchGui();
    await until(() => lastUpsert(h!, "c1")?.details?.suggestions !== undefined, 3_000, "suggestion");
    expect(lastUpsert(h!, "c1")?.details?.suggestions).toEqual(["Run the tests"]);
    const v = h!.adapter.diagnostics().chatSubscribe;
    expect(v).not.toBeNull();
    expect(Number(v!.split(".")[1])).toBeGreaterThanOrEqual(SUGGESTED_PROMPT_MINOR);
  });

  test("below 1.20 (an older host): no suggestion, nothing breaks", async () => {
    await watchGui((m) => ({ ...m, "chat.subscribe": { major: 1, minor: 19 } }));
    expect(h!.adapter.diagnostics().chatSubscribe).toBe("1.19");
    await Bun.sleep(150);
    expect(lastUpsert(h!, "c1")?.details).toBeDefined(); // the snapshot was read
    expect(lastUpsert(h!, "c1")?.details?.suggestions).toBeUndefined();
  });
});
