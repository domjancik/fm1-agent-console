/**
 * Converts spoken punctuation ("comma", "full stop", "new line", "open paren") into symbols.
 * Parakeet transcribes these words literally and often adds its own punctuation around them
 * ("tests, period."), so ASR punctuation adjacent to a spoken mark is absorbed.
 * Saying "literal" before a mark keeps the word ("literal comma" -> "comma").
 */

type MarkKind = "close" | "open" | "break";

interface Mark {
  symbol: string;
  kind: MarkKind;
  endsSentence?: boolean;
}

const MARKS: ReadonlyArray<readonly [readonly string[], Mark]> = [
  [["comma"], { symbol: ",", kind: "close" }],
  [["period", "full stop"], { symbol: ".", kind: "close", endsSentence: true }],
  [["question mark"], { symbol: "?", kind: "close", endsSentence: true }],
  [["exclamation mark", "exclamation point"], { symbol: "!", kind: "close", endsSentence: true }],
  [["colon"], { symbol: ":", kind: "close" }],
  [["semicolon", "semi colon"], { symbol: ";", kind: "close" }],
  [["close paren", "close parenthesis", "right paren", "right parenthesis"], { symbol: ")", kind: "close" }],
  [["close bracket", "right bracket"], { symbol: "]", kind: "close" }],
  [["close brace", "right brace", "close curly brace"], { symbol: "}", kind: "close" }],
  [["close quote", "end quote", "unquote"], { symbol: '"', kind: "close" }],
  [["open paren", "open parenthesis", "left paren", "left parenthesis"], { symbol: "(", kind: "open" }],
  [["open bracket", "left bracket"], { symbol: "[", kind: "open" }],
  [["open brace", "left brace", "open curly brace"], { symbol: "{", kind: "open" }],
  [["open quote", "begin quote"], { symbol: '"', kind: "open" }],
  [["new paragraph"], { symbol: "\n\n", kind: "break" }],
  [["new line", "newline", "next line"], { symbol: "\n", kind: "break" }],
];

const LOOKUP = new Map<string, Mark>();
for (const [phrases, mark] of MARKS) for (const p of phrases) LOOKUP.set(p, mark);

const PHRASES = [...LOOKUP.keys()].sort((a, b) => b.length - a.length).map((p) => p.replace(/ /g, "\\s+"));
const ASR_PUNCT = "[,.;:!?]";
const SPOKEN = new RegExp(
  `(\\bliteral\\s+)?${ASR_PUNCT}*\\s*\\b(${PHRASES.join("|")})\\b(${ASR_PUNCT}*)`,
  "gi",
);

const SENTINEL = "\u0001";

/** Replaces spoken marks with sentinel tokens; returns the token list. */
function tokenize(text: string): Array<string | Mark> {
  const marked = text.replace(SPOKEN, (match, literal: string | undefined, phrase: string) => {
    if (literal) return match.slice(literal.length).trimStart();
    const key = phrase.toLowerCase().replace(/\s+/g, " ");
    return ` ${SENTINEL}${key}${SENTINEL} `;
  });
  const tokens: Array<string | Mark> = [];
  for (const part of marked.split(new RegExp(`(${SENTINEL}[^${SENTINEL}]+${SENTINEL})`))) {
    if (part.startsWith(SENTINEL)) {
      const mark = LOOKUP.get(part.slice(1, -1));
      if (mark) tokens.push(mark);
      continue;
    }
    for (const word of part.split(/\s+/)) if (word) tokens.push(word);
  }
  return tokens;
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function appendClose(out: string, mark: Mark): string {
  const trimmed = out.replace(/[ \t]+$/, "");
  const last = trimmed.slice(-1);
  if (last === mark.symbol && mark.symbol !== ")" && mark.symbol !== "]" && mark.symbol !== "}") return trimmed;
  // A sentence end replaces a dangling soft mark: "frame," + "." -> "frame."
  if (mark.endsSentence && /[,;:.]/.test(last)) return trimmed.slice(0, -1) + mark.symbol;
  return trimmed + mark.symbol;
}

export function applySpokenPunctuation(text: string): string {
  let out = "";
  let glueNext = false;
  let capitalizeNext = false;
  for (const token of tokenize(text)) {
    if (typeof token === "string") {
      if (out && !glueNext && !out.endsWith("\n")) out += " ";
      out += capitalizeNext ? capitalize(token) : token;
      glueNext = false;
      capitalizeNext = false;
    } else if (token.kind === "close") {
      out = appendClose(out, token);
      glueNext = false;
      if (token.endsSentence) capitalizeNext = true;
    } else if (token.kind === "open") {
      if (out && !glueNext && !out.endsWith("\n")) out += " ";
      out += token.symbol;
      glueNext = true;
    } else {
      out = out.replace(/[ \t]+$/, "") + token.symbol;
      glueNext = true;
      capitalizeNext = true;
    }
  }
  return out.replace(/[ \t]+\n/g, "\n").trim();
}
