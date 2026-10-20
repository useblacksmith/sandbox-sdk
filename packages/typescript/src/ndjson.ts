/**
 * Yields one parsed JSON value per line as bytes arrive; never waits for the
 * whole body. Blank lines are skipped. A trailing line without `\n` is
 * parsed when the stream ends.
 */
export async function* parseNdjson(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<unknown, void, undefined> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffered = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let newline = buffered.indexOf("\n");
      while (newline !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line.trim() !== "") yield JSON.parse(line) as unknown;
        newline = buffered.indexOf("\n");
      }
    }
    buffered += decoder.decode();
    if (buffered.trim() !== "") yield JSON.parse(buffered) as unknown;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
