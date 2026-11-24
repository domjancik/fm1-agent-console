// Read aloud (docs/ui-v3.md section 14): a session's latest message as speech-friendly text. Pure, ASCII only.
// The companion speaks it (Kokoro TTS) and summarizes it first when it is long; this module only shapes the words.
import { inlineText, parseInline, type MdBlock } from "./markdown";

/** PLAY held this long (or longer) on a selected session reads its latest message aloud; a shorter press acts as before. */
export const READ_ALOUD_HOLD_MS = 1000;
/** Speech text longer than this is summarized first (companion config `readAloud.summarizeOverChars` overrides it). */
export const READ_ALOUD_SUMMARY_CHARS = 600;
/** What a code block is read as (consecutive code blocks are read once). */
export const CODE_OMITTED = "Code omitted.";

/** Printable ASCII, single spaces; Markdown leftovers (emphasis marks, pipes, heading hashes) and bare URLs dropped. */
function clean(s: string): string {
  return s
    .replace(/[^\x20-\x7e]/g, " ")
    .replace(/\bhttps?:\/\/\S+/gi, "link")
    .replace(/[*_`~|#<>]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A sentence ends with punctuation; one that does not gets a period. Empty stays empty. */
function sentence(s: string): string {
  const t = clean(s);
  if (!t) return "";
  return /[.!?:;]$/.test(t) ? t : `${t}.`;
}

/** One table row as `header value` phrases: `Name parser, Status done.` Empty cells are skipped. */
function tableRow(header: readonly string[], row: readonly string[]): string {
  const parts: string[] = [];
  row.forEach((cell, i) => {
    const v = clean(cell);
    if (!v) return;
    const h = clean(header[i] ?? "");
    parts.push(h && h.toLowerCase() !== v.toLowerCase() ? `${h} ${v}` : v);
  });
  return parts.length > 0 ? sentence(parts.join(", ")) : "";
}

/**
 * The blocks as speech: headings as sentences, list items one sentence each (ordered ones keep their number), quotes
 * prefixed `Quote:`, code blocks `Code omitted.`, tables row by row as `header value` phrases, links by their label
 * (markdown.ts already keeps only the label). Consecutive paragraph lines join into one paragraph.
 */
export function blocksSpeech(blocks: readonly MdBlock[]): string {
  const out: string[] = [];
  let para: string[] = [];
  const flush = (): void => {
    if (para.length > 0) out.push(sentence(para.join(" ")));
    para = [];
  };
  for (const b of blocks) {
    if (b.kind === "para") {
      para.push(inlineText(b.inline));
      continue;
    }
    flush();
    switch (b.kind) {
      case "gap":
        break;
      case "heading":
        out.push(sentence(inlineText(b.inline)));
        break;
      case "item": {
        const n = /^(\d{1,9})[.)]$/.exec(b.marker);
        out.push(sentence(n ? `${n[1]}, ${inlineText(b.inline)}` : inlineText(b.inline)));
        break;
      }
      case "quote":
        out.push(sentence(`Quote: ${inlineText(b.inline)}`));
        break;
      case "code":
        if (out.at(-1) !== CODE_OMITTED) out.push(CODE_OMITTED);
        break;
      case "table":
        for (const row of b.rows) out.push(tableRow(b.header, row));
        break;
    }
  }
  flush();
  return out.filter(Boolean).join(" ");
}

/** The speech text of a message: from its Markdown blocks when the adapter gave them, else its plain text. */
export function speechText(message: { text: string; blocks?: readonly MdBlock[] }): string {
  if (message.blocks && message.blocks.length > 0) {
    const s = blocksSpeech(message.blocks);
    if (s) return s;
  }
  return sentence(inlineText(parseInline(message.text)));
}

/**
 * At most `max` characters for reading without a summary: cut after the last sentence end past the first third,
 * else at the last space past the middle, else hard.
 */
export function clipSpeech(text: string, max: number = READ_ALOUD_SUMMARY_CHARS): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const end = Math.max(head.lastIndexOf(". "), head.lastIndexOf("? "), head.lastIndexOf("! "));
  if (end > max / 3) return head.slice(0, end + 1);
  const sp = head.lastIndexOf(" ");
  return sentence(sp > max / 2 ? head.slice(0, sp) : head);
}
