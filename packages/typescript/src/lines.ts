import type { OutputChunk, OutputLine } from "./types.js";

type StreamName = OutputLine["stream"];

/**
 * Turns output chunks into complete lines of text. Each stream is decoded as
 * UTF-8 and split on `\n` on its own, so a character or a line cut across
 * chunks is put back together. A line's `\n` (and a `\r` before it) is
 * removed. Text left without a newline is yielded when the chunks end, or
 * when a gap shows that the bytes after it were dropped.
 */
export async function* toLines(
  chunks: AsyncIterable<OutputChunk>,
): AsyncGenerator<OutputLine, void, undefined> {
  const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  const pending = { stdout: "", stderr: "" };

  function* flush(stream: StreamName): Generator<OutputLine> {
    const text = pending[stream] + decoders[stream].decode();
    pending[stream] = "";
    if (text !== "") yield { stream, text: stripCarriageReturn(text) };
  }

  for await (const chunk of chunks) {
    if (chunk.type === "exit") continue;
    if (chunk.type === "gap") {
      yield* flush(chunk.stream);
      continue;
    }
    const stream = chunk.type;
    const parts = (pending[stream] + decoders[stream].decode(chunk.data, { stream: true })).split(
      "\n",
    );
    pending[stream] = parts.pop() ?? "";
    for (const text of parts) yield { stream, text: stripCarriageReturn(text) };
  }
  yield* flush("stdout");
  yield* flush("stderr");
}

function stripCarriageReturn(text: string): string {
  return text.endsWith("\r") ? text.slice(0, -1) : text;
}
