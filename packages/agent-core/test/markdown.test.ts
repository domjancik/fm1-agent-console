// Markdown on the console screen (docs/ui-v3.md section 13): the shared reader and layout, and the bubble / DETAILS rows
// built from it.
import { describe, expect, test } from "bun:test";
import { BUBBLE_COLS, bubbleLines, bubbleRows, LIST_HEAD_COLS, listHeadRows, type BubbleInput } from "../src/copy";
import { DETAIL_COLS, messageRows, padPage } from "../src/details";
import {
  blocksPlain,
  clipRow,
  layoutMarkdown,
  markdownBlocks,
  MARKDOWN_ROWS_MAX,
  MARKDOWN_SOURCE_MAX,
  parseBlocks,
  parseInline,
  SPANS_PER_ROW_MAX,
  type MarkdownRow,
} from "../src/markdown";
import type { SessionDetails } from "../src/types";
import { parseDetails } from "../src/validate";
import { keyOf, rig, RIG_EPOCH, slotOf, type Rig } from "./helpers";

const lay = (md: string, width = 28): MarkdownRow[] => layoutMarkdown(markdownBlocks(md), width);
const texts = (md: string, width = 28): string[] => lay(md, width).map((r) => r.text);
const styled = (md: string, width = 28): string[] => lay(md, width).map((r) => `${r.style[0]}|${r.text}`);
const ascii = /^[\x20-\x7e]*$/;

/** Every row fits, is ASCII, and its spans lie inside it, never overlap, and stay within the per-row limit. */
function wellFormed(rows: readonly MarkdownRow[], width: number): void {
  for (const r of rows) {
    expect(r.text.length).toBeLessThanOrEqual(width);
    expect(r.text).toMatch(ascii);
    const spans = r.spans ?? [];
    expect(spans.filter((s) => s.mark !== "rule").length).toBeLessThanOrEqual(SPANS_PER_ROW_MAX);
    let end = 0;
    for (const s of [...spans].sort((a, b) => a.start - b.start)) {
      expect(s.start).toBeGreaterThanOrEqual(end);
      expect(s.end).toBeGreaterThan(s.start);
      expect(s.end).toBeLessThanOrEqual(r.text.length);
      end = s.end;
    }
  }
}

const MIXED = [
  "# Summary",
  "",
  "I fixed **the bug** in `view.ts` (see [the docs](https://x.y/z)). ![shot](a.png)",
  "",
  "**Changes**",
  "- first item that is long enough to wrap onto the next row",
  "  - nested *item*",
  "    - deeper still",
  "1. one",
  "2. two",
  "",
  "```ts",
  "const x = someVeryLongFunctionName(argumentOne, argumentTwo);",
  "```",
  "",
  "| File | Lines |",
  "|------|------:|",
  "| a.ts | 12 |",
  "",
  "> a quoted line",
  "",
  "    indented code",
].join("\n");

describe("inline (docs/ui-v3.md section 13.2)", () => {
  test("code spans and bold kept as marks; italics, links, images, tags and escapes reduced", () => {
    expect(parseInline("a **b c** `d e` *f* _g_ [h](u) ![i](j) <br> \\*k\\* ~~l~~ snake_case_name")).toEqual([
      { text: "a " },
      { text: "b c", mark: "bold" },
      { text: " " },
      { text: "d e", mark: "code" },
      { text: " f g h    *k* l snake_case_name" },
    ]);
  });
  test("bold around a code span stays bold on both sides; code wins inside", () => {
    expect(parseInline("**see `x.ts` now**")).toEqual([
      { text: "see ", mark: "bold" },
      { text: "x.ts", mark: "code" },
      { text: " now", mark: "bold" },
    ]);
  });
  test("only common HTML tags are dropped: `<redacted>`, generics and placeholders stay; an image-only line is no row", () => {
    expect(parseInline("TOKEN=<redacted> Array<string> <b>x</b> <details>")).toEqual([{ text: "TOKEN=<redacted> Array<string> x " }]);
    expect(texts("before\n![shot](a.png)\nafter")).toEqual(["before", "after"]);
  });
  test("unmatched markers stay literal", () => {
    expect(parseInline("2 * 3 = 6 and a ** b")).toEqual([{ text: "2 * 3 = 6 and a ** b" }]);
  });
});

describe("blocks and layout (docs/ui-v3.md section 13.2)", () => {
  test("headings (#..######, setext) and an entirely bold line are heading rows without markers", () => {
    expect(styled("# One\n###### Six ##\nTwo\n===\n**Three**\n**not** all bold")).toEqual(["h|One", "h|Six", "h|Two", "h|Three", "b|not all bold"]);
    expect(lay("**not** all bold")[0]?.spans).toEqual([{ start: 0, end: 3, mark: "bold" }]);
  });

  test("paragraphs: line breaks kept, one blank row per run of blank lines, none at the ends", () => {
    expect(texts("\n\nfirst line\nsecond line\n\n\n\nnext para\n\n")).toEqual(["first line", "second line", "", "next para"]);
  });

  test("CRLF and CR line ends read as LF; tabs as 4 spaces", () => {
    expect(texts("a\r\nb\rc\r\n\r\n- d")).toEqual(["a", "b", "c", "", "- d"]);
    expect(lay("x\n\n\tcode")[2]).toEqual({ style: "muted", text: "code", spans: [{ start: 0, end: 4, mark: "code" }] });
  });

  test("lists: '-' bullets (no U+2022 in FONT_S), ordered markers kept, hanging indent, nesting by 2", () => {
    expect(texts("- first item that is long enough to wrap\n  - nested item\n    - deeper\n* star\n+ plus\n1. one\n10) ten")).toEqual([
      "- first item that is long",
      "  enough to wrap",
      "  - nested item",
      "    - deeper",
      "- star",
      "- plus",
      "1. one",
      "10) ten",
    ]);
  });

  test("a wrapped list item line joins its item; a blank line between items adds no gap row", () => {
    expect(texts("- alpha\n  continues here\n\n- beta")).toEqual(["- alpha continues here", "- beta"]);
  });

  test("fenced code: muted rows, no joining, a long line cut with '~', blank runs collapsed, a code span per row", () => {
    const rows = lay("```\nshort\n\n\n  indented\nabcdefghijklmnopqrstuvwxyz0123456789\n```", 20);
    expect(rows.map((r) => r.text)).toEqual(["short", "", "  indented", "abcdefghijklmnopqrs~"]);
    expect(rows.every((r) => r.style === "muted")).toBe(true);
    expect(rows[2]?.spans).toEqual([{ start: 2, end: 10, mark: "code" }]);
    expect(rows[1]?.spans).toBeUndefined();
    // An unclosed fence runs to the end; ~~~ fences too.
    expect(texts("~~~\na\nb")).toEqual(["a", "b"]);
  });

  test("indented code after a blank line; not inside a paragraph", () => {
    expect(styled("para\n\n    code line\n    second")).toEqual(["b|para", "b|", "m|code line", "m|second"]);
    expect(styled("para\n    still para")).toEqual(["b|para", "b|still para"]);
  });

  test("narrow table: aligned columns, header row heading, a rule span on every column gap, separator dropped", () => {
    const rows = lay("| File | Lines | Ok |\n|---|---:|:-:|\n| a.ts | 12 | y |\n| bb.ts | 3 |  |");
    expect(rows.map((r) => `${r.style[0]}|${r.text}`)).toEqual(["h|File  Lines Ok", "b|a.ts  12    y", "b|bb.ts 3     "]);
    expect(rows[0]?.spans).toEqual([{ start: 5, end: 6, mark: "rule" }, { start: 11, end: 12, mark: "rule" }]);
    expect(rows[2]?.spans).toEqual(rows[0]?.spans);
  });

  test("wide table: one record per row, the first cell as a heading, then `header: value` rows (hanging indent 2)", () => {
    const rows = lay("| Name | Description | Owner |\n|--|--|--|\n| alpha | the first thing in the long list | dom |\n| beta | short |  |");
    expect(rows.map((r) => `${r.style[0]}|${r.text}`)).toEqual([
      "h|alpha",
      "b|Description: the first thing",
      "b|  in the long list",
      "b|Owner: dom",
      "h|beta",
      "b|Description: short",
    ]);
  });

  test("blockquote: muted rows with a '| ' bar on every row", () => {
    expect(styled("> a quoted line that wraps at twenty", 20)).toEqual(["m|| a quoted line that", "m|| wraps at twenty"]);
  });

  test("a word longer than the row is split at the row width", () => {
    expect(texts(`x ${"a".repeat(30)} y`, 12)).toEqual(["x", "aaaaaaaaaaaa", "aaaaaaaaaaaa", "aaaaaa y"]);
    expect(texts(`- ${"b".repeat(14)}`, 10)).toEqual(["- bbbbbbbb", "  bbbbbb"]);
  });

  test("empty and blank sources give no blocks and no rows", () => {
    expect(markdownBlocks("")).toEqual([]);
    expect(markdownBlocks(" \n\n\t\n")).toEqual([]);
    expect(layoutMarkdown([], 28)).toEqual([]);
  });

  test("source capped at 2000 characters (at a line break), rows at 96", () => {
    const long = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
    const blocks = markdownBlocks(long);
    expect(blocksPlain(blocks).length).toBeLessThanOrEqual(MARKDOWN_SOURCE_MAX);
    expect(blocks.at(-1)).toEqual({ kind: "para", inline: [{ text: `line ${blocks.length - 1}` }] });
    expect(layoutMarkdown(blocks, 28).length).toBe(MARKDOWN_ROWS_MAX);
  });

  test("mixed message at the bubble width", () => {
    expect(styled(MIXED)).toEqual([
      "h|Summary",
      "b|",
      "b|I fixed the bug in view.ts",
      "b|(see the docs).",
      "b|",
      "h|Changes",
      "b|- first item that is long",
      "b|  enough to wrap onto the",
      "b|  next row",
      "b|  - nested item",
      "b|    - deeper still",
      "b|1. one",
      "b|2. two",
      "b|",
      "m|const x = someVeryLongFunct~",
      "b|",
      "h|File Lines",
      "b|a.ts 12",
      "b|",
      "m|| a quoted line",
      "b|",
      "m|indented code",
    ]);
    expect(lay(MIXED)[2]?.spans).toEqual([{ start: 8, end: 15, mark: "bold" }, { start: 19, end: 26, mark: "code" }]);
  });

  test("width never exceeded, spans well formed, at every row width the screen uses", () => {
    const nasty = `${MIXED}\n\n**${"x".repeat(40)}** ${"`a` ".repeat(12)}\n- ${"**b** ".repeat(10)}\n| ${"c | ".repeat(9)}\n|${"-|".repeat(9)}\n| ${"long cell | ".repeat(9)}`;
    for (const w of [20, 22, 24, 26, 28, 29]) wellFormed(lay(nasty, w), w);
  });

  test("at most 4 bold/code spans per row; later ones drawn plain", () => {
    const row = lay("`a` **b** `c` **d** `e` **f**")[0];
    expect(row?.text).toBe("a b c d e f");
    expect(row?.spans).toEqual([
      { start: 0, end: 1, mark: "code" },
      { start: 2, end: 3, mark: "bold" },
      { start: 4, end: 5, mark: "code" },
      { start: 6, end: 7, mark: "bold" },
    ]);
    // Neighbouring words with the same mark share one span (the space between them is invisible either way).
    expect(lay("`a` `b`")[0]?.spans).toEqual([{ start: 0, end: 3, mark: "code" }]);
  });

  test("clipRow cuts text and spans together", () => {
    expect(clipRow({ style: "body", text: "abcdef", spans: [{ start: 1, end: 3, mark: "bold" }, { start: 4, end: 6, mark: "code" }] }, 5)).toEqual({
      style: "body",
      text: "abcde",
      spans: [{ start: 1, end: 3, mark: "bold" }, { start: 4, end: 5, mark: "code" }],
    });
    const row: MarkdownRow = { style: "body", text: "abcdef", spans: [{ start: 4, end: 6, mark: "code" }] };
    expect(clipRow(row, 3)).toEqual({ style: "body", text: "abc" });
  });
});

describe("validation (validate.ts parseDetails)", () => {
  test("well-formed lastBlocks pass (text folded to ASCII); malformed are rejected", () => {
    const blocks = markdownBlocks(MIXED);
    expect(parseBlocks(JSON.parse(JSON.stringify(blocks)))).toEqual(blocks);
    expect(parseBlocks([{ kind: "para", inline: [{ text: "café" }] }])).toEqual([{ kind: "para", inline: [{ text: "caf " }] }]);
    expect(parseBlocks([{ kind: "item", depth: 0, marker: "*", inline: [] }])).toBeNull();
    expect(parseBlocks([{ kind: "nope" }])).toBeNull();
    expect(parseBlocks([{ kind: "para", inline: [{ text: "x", mark: "italic" }] }])).toBeNull();
    const ok = parseDetails({ lastMessage: "x", lastBlocks: blocks, reply: { requestId: "r", text: "y", at: 1, blocks } });
    expect(ok.ok && ok.value.lastBlocks).toEqual(blocks);
    expect(ok.ok && ok.value.reply?.blocks).toEqual(blocks);
    expect(parseDetails({ lastBlocks: [{ kind: "code", lines: [1] }] }).ok).toBe(false);
  });
});

describe("bubble and DETAILS rows from Markdown (docs/ui-v3.md section 13.4)", () => {
  const base: BubbleInput = { state: "completed_unread", stale: false, inferred: false, ageMs: 60_000 };

  test("bubbleLines lays the structure out; without blocks the plain message wraps as before", () => {
    const blocks = markdownBlocks(MIXED);
    const lines = bubbleLines({ ...base, lastMessage: blocksPlain(blocks), lastBlocks: blocks });
    expect(lines.slice(0, 3).map((r) => `${r.style[0]}|${r.text}`)).toEqual(["h|Summary", "b|", "b|I fixed the bug in view.ts"]);
    expect(lines[2]?.spans?.length).toBe(2);
    const plain = bubbleLines({ ...base, lastMessage: "# Summary\n\nplain" });
    expect(plain.map((r) => r.text)).toEqual(["# Summary plain"]);
  });

  test("bubble rows keep the spans, never exceed 28 columns; the 'more' row is non-empty when a blank row follows", () => {
    const blocks = markdownBlocks("# Title\n\n**bold words here** and more\n- a\n- b\n\nlast");
    const lines = bubbleLines({ ...base, lastMessage: "x", lastBlocks: blocks });
    const rows = bubbleRows("Done, 1m", lines, 0);
    expect(rows.length).toBe(7);
    expect(rows[3]).toEqual({ style: "body", text: "bold words here and more", spans: [{ start: 0, end: 15, mark: "bold" }] });
    expect(rows[6]?.text).toBe(" ");
    for (const r of rows) expect(r.text.length).toBeLessThanOrEqual(BUBBLE_COLS);
    // SPLIT Buddy: 4 body rows, row 5 the "more" row (docs/ui-v3.md section 10.7), unchanged.
    expect(bubbleRows("Done, 1m", lines, 0, 4).length).toBe(6);
  });

  test("List header rows clip spans to 24", () => {
    const rows = listHeadRows("Done", [{ style: "body", text: "x".repeat(20) + "abcdefgh", spans: [{ start: 18, end: 28, mark: "code" }] }], 0);
    expect(rows[1]).toEqual({ style: "body", text: "x".repeat(20) + "abcd", spans: [{ start: 18, end: 24, mark: "code" }] });
    expect(rows[1]?.text.length).toBe(LIST_HEAD_COLS);
  });

  test("DETAILS message rows: Markdown at 29 columns, padPage keeps spans", () => {
    const rows = messageRows({ text: "x", blocks: markdownBlocks("## Plan\n1. **first** step") }, 96);
    expect(rows).toEqual([
      { style: "heading", text: "Plan" },
      { style: "body", text: "1. first step", spans: [{ start: 3, end: 8, mark: "bold" }] },
    ]);
    const page = padPage(rows);
    expect(page[1]).toEqual(rows[1] as never);
    for (const r of page) expect(r.text.length).toBeLessThanOrEqual(DETAIL_COLS);
  });
});

describe("console views with a Markdown message (mock adapter)", () => {
  const MSG = "## Done\n\nAll **412** tests pass.\n\n- `bun test`\n- `bun run typecheck`";
  const DETAILS: SessionDetails = { lastMessage: MSG, lastMessageAt: RIG_EPOCH - 60_000 };
  async function at(proto: number, screen: "buddy" | "list" = "buddy"): Promise<Rig> {
    const r = await rig("mixed", { scope: "recent" });
    r.console.setProtocol(proto);
    r.console.state = { ...r.console.state, screen: { ...r.console.state.screen, sessions: screen } };
    const e = r.console.registry.get(keyOf(r, "s-claude-fw"));
    if (!e) throw new Error("missing");
    r.adapter.upsertSession({ ...e.session, details: DETAILS });
    await r.console.handleInput({ kind: "key", key: slotOf(r, "s-claude-fw"), gesture: "single" });
    return r;
  }

  test("the mock reads lastMessage as Markdown: the bubble (version 4+) shows the structure with spans", async () => {
    const r = await at(7);
    const rows = r.console.view().text ?? [];
    const body = rows.slice(1, 6).map((x) => `${x.style[0]}|${x.text}`);
    expect(body).toEqual(["h|Done", "b|", "b|All 412 tests pass.", "b|", "b|- bun test"]);
    expect(rows[3]?.spans).toEqual([{ start: 4, end: 7, mark: "bold" }]);
    expect(rows[5]?.spans).toEqual([{ start: 2, end: 10, mark: "code" }]);
    // The hint line and the legend do not depend on the message's Markdown (a plain message that also has more rows).
    const hint = r.console.view().detail.lines[3];
    const legend = r.console.view().legend;
    const e = r.console.registry.get(keyOf(r, "s-claude-fw"));
    if (!e) throw new Error("missing");
    r.adapter.upsertSession({ ...e.session, details: { lastMessage: "plain words ".repeat(20), lastMessageAt: RIG_EPOCH - 60_000 } });
    expect(r.console.view().detail.lines[3]).toBe(hint);
    expect(r.console.view().legend).toEqual(legend);
    expect(hint).toMatch(ascii);
  });

  test("the List header (24) shows the structure line by line, with no blank message line", async () => {
    const r = await at(5, "list");
    const rows = r.console.view().text ?? [];
    expect(r.console.view().layout).toBe("list");
    expect(rows[1]).toEqual({ style: "heading", text: "Done" });
    expect(rows[2]).toEqual({ style: "body", text: "All 412 tests pass.", spans: [{ start: 4, end: 7, mark: "bold" }] });
  });

  test("version 3 DETAILS page lays the message out at 29", async () => {
    const r = await at(3);
    await r.console.handleInput({ kind: "button", button: "LFO", edge: "down" });
    const rows = (r.console.view().text ?? []).map((x) => x.text);
    const i = rows.findIndex((t) => t.startsWith("Last message"));
    expect(rows.slice(i + 1, i + 6)).toEqual(["Done", "", "All 412 tests pass.", "", "- bun test"]);
  });
});
