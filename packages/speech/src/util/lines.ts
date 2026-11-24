/** Yields newline-delimited text lines from a byte stream; the final unterminated line is yielded too. */
export async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        yield buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
      }
    }
    buffered += decoder.decode();
    if (buffered) yield buffered;
  } finally {
    reader.releaseLock();
  }
}
