import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = new URL("../src/", import.meta.url);
const importsInternal = (file: string) =>
  /from "\.\/internal\//.test(readFileSync(new URL(file, src), "utf8"));

describe("main entry", () => {
  it("exports nothing straight from internal/", () => {
    expect(importsInternal("index.ts")).toBe(false);
  });

  it("is reached from internal/ only through the Blacksmith facade", () => {
    const publicFiles = readdirSync(src).filter((name) => name.endsWith(".ts"));
    expect(publicFiles.filter(importsInternal)).toEqual(["blacksmith.ts"]);
  });
});
