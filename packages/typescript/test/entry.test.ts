import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { ErrorCode } from "../src/errors.js";
import type {
  ErrorCode as WireErrorCode,
  ProcessState as WireProcessState,
} from "../src/generated/types.gen.js";
import type { ProcessState } from "../src/types.js";

const src = new URL("../src/", import.meta.url);
const read = (file: string) => readFileSync(new URL(file, src), "utf8");
const importsInternal = (file: string) => /from "\.\/internal\//.test(read(file));

const isGenerated = (node: ts.Node | undefined): boolean =>
  node !== undefined && ts.isStringLiteralLike(node) && node.text.includes("generated/");

/**
 * Every reference one file makes to the generated folder: the generated name for a named
 * import, and the statement's own text for any other form, so that form can never match
 * the list of names below.
 */
function generatedReferences(file: string): string[] {
  const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.ESNext, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && isGenerated(node.moduleSpecifier)) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings) && node.importClause?.name === undefined) {
        for (const element of bindings.elements)
          found.push((element.propertyName ?? element.name).text);
      } else {
        found.push(node.getText(source));
      }
    } else if (ts.isExportDeclaration(node) && isGenerated(node.moduleSpecifier)) {
      found.push(node.getText(source));
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      isGenerated(node.argument.literal)
    ) {
      found.push(node.getText(source));
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
      isGenerated(node.arguments[0])
    ) {
      found.push(node.getText(source));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found.sort();
}

/** Keyed by path under `src/`; files with no reference are left out. */
function generatedImports(): Record<string, string[]> {
  const files = readdirSync(src, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts") && !name.startsWith("generated/"))
    .sort();
  const found: Record<string, string[]> = {};
  for (const file of files) {
    const references = generatedReferences(file);
    if (references.length > 0) found[file] = references;
  }
  return found;
}

describe("main entry", () => {
  it("exports nothing straight from internal/", () => {
    expect(importsInternal("index.ts")).toBe(false);
  });

  it("is reached from internal/ only through the Blacksmith facade", () => {
    const publicFiles = readdirSync(src).filter((name) => name.endsWith(".ts"));
    expect(publicFiles.filter(importsInternal)).toEqual(["blacksmith.ts"]);
  });
});

describe("generated types", () => {
  // The types callers see are handwritten, so a spec or generator change cannot rename them.
  // A generated type is needed only where agent JSON is read or a request body is written.
  // Add a name here only for such a use, and only in a file under internal/.
  it("are imported only where the wire is read or written", () => {
    expect(generatedImports()).toEqual({
      "internal/wire.ts": [
        "Disk",
        "DiskAttachRequest",
        "DiskList",
        "FileInfo",
        "OutputEvent",
        "PortExposure",
        "PortExposureList",
        "Process",
        "ProcessList",
        "ProcessSpec",
      ],
    });
  });

  it("agree with the handwritten unions", () => {
    expectTypeOf<ErrorCode>().toEqualTypeOf<WireErrorCode>();
    expectTypeOf<ProcessState>().toEqualTypeOf<WireProcessState>();
  });
});
