// Parsing of `agent.getTranscript` text: <user_message>...</user_message> / <assistant_response>...</assistant_response>.

const USER = /<user_message>\n?([\s\S]*?)\n?<\/user_message>/g;
const ASSISTANT = /<assistant_response>\n?([\s\S]*?)\n?<\/assistant_response>/g;

function blocks(text: string, re: RegExp): string[] {
  return [...text.matchAll(re)].map((m) => m[1] ?? "");
}

export const userMessages = (text: string): string[] => blocks(text, USER);
export const assistantResponses = (text: string): string[] => blocks(text, ASSISTANT);

/** User turns that contain the marker. Exactly-once delivery means this is 1. */
export function userTurnsWith(text: string, marker: string): number {
  return userMessages(text).filter((m) => m.includes(marker)).length;
}

export function replyWith(text: string, marker: string): boolean {
  return assistantResponses(text).some((m) => m.includes(marker));
}

/** Pulls the transcript string out of the RPC response (`{transcript: string}`). */
export function transcriptText(response: unknown): string {
  if (typeof response === "object" && response !== null && typeof (response as { transcript?: unknown }).transcript === "string") {
    return (response as { transcript: string }).transcript;
  }
  throw new Error("agent.getTranscript: unexpected response shape");
}

/** A marker unique to this run: FM1_SMOKE_<TAG>_<base36 time><random>. */
export function marker(tag: string, now = Date.now()): string {
  const rand = Math.floor(Math.random() * 36 ** 3).toString(36).padStart(3, "0");
  return `FM1_SMOKE_${tag}_${now.toString(36).toUpperCase()}${rand.toUpperCase()}`;
}

/** The harmless instruction from spec section 6 (T2). */
export function markerPrompt(m: string): string {
  return `${m}\n\nRespond with exactly this marker.\nDo not modify files.`;
}
