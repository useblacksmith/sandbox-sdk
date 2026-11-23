import { describe, expect, it } from "vitest";
import { toLines } from "../src/lines.js";
import type { OutputChunk, OutputLine } from "../src/index.js";

const bytes = (text: string) => new TextEncoder().encode(text);
const out = (text: string | Uint8Array): OutputChunk => ({
  type: "stdout",
  offset: 0,
  data: typeof text === "string" ? bytes(text) : text,
});
const err = (text: string): OutputChunk => ({ type: "stderr", offset: 0, data: bytes(text) });
const exit: OutputChunk = {
  type: "exit",
  state: "exited",
  exitCode: 0,
  signal: undefined,
  timedOut: false,
};

async function lines(chunks: OutputChunk[]): Promise<OutputLine[]> {
  async function* source() {
    yield* chunks;
  }
  const result: OutputLine[] = [];
  for await (const line of toLines(source())) result.push(line);
  return result;
}

describe("toLines", () => {
  it("joins a line split across chunks and splits a chunk holding several", async () => {
    expect(await lines([out("he"), out("llo\nwor"), out("ld\n\nbye\n"), exit])).toEqual([
      { stream: "stdout", text: "hello" },
      { stream: "stdout", text: "world" },
      { stream: "stdout", text: "" },
      { stream: "stdout", text: "bye" },
    ]);
  });

  it("keeps stdout and stderr lines apart when their chunks interleave", async () => {
    expect(await lines([out("a"), err("x"), out("b\n"), err("y\n")])).toEqual([
      { stream: "stdout", text: "ab" },
      { stream: "stderr", text: "xy" },
    ]);
  });

  it("removes the carriage return of a CRLF line ending", async () => {
    expect(await lines([out("one\r"), out("\ntwo\r\n")])).toEqual([
      { stream: "stdout", text: "one" },
      { stream: "stdout", text: "two" },
    ]);
  });

  it("decodes a multi-byte character split across chunks", async () => {
    const euro = bytes("€\n");
    expect(await lines([out(euro.slice(0, 1)), out(euro.slice(1))])).toEqual([
      { stream: "stdout", text: "€" },
    ]);
  });

  it("yields text without a trailing newline when the output ends", async () => {
    expect(await lines([out("done\nno newline"), err("oops"), exit])).toEqual([
      { stream: "stdout", text: "done" },
      { stream: "stdout", text: "no newline" },
      { stream: "stderr", text: "oops" },
    ]);
  });

  it("does not join the text on either side of a gap", async () => {
    expect(
      await lines([
        out("before"),
        { type: "gap", stream: "stdout", from: 6, to: 100 },
        out("after\n"),
      ]),
    ).toEqual([
      { stream: "stdout", text: "before" },
      { stream: "stdout", text: "after" },
    ]);
  });
});
