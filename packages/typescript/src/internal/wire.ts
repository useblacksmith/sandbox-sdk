import { SandboxError } from "../errors.js";
import type {
  DiskAttachRequest,
  OutputEvent,
  ProcessSpec,
  ProcessState,
} from "../generated/types.gen.js";
import type { DiskAttachInput, OutputChunk, ProcessSpecInput } from "../types.js";

export function toProcessSpec(input: ProcessSpecInput): ProcessSpec {
  const spec: ProcessSpec = {};
  if (input.cmd !== undefined) spec.cmd = input.cmd;
  if (input.shell !== undefined) spec.shell = input.shell;
  if (input.cwd !== undefined) spec.cwd = input.cwd;
  if (input.env !== undefined) spec.env = input.env;
  if (input.timeoutSeconds !== undefined) spec.timeout_seconds = input.timeoutSeconds;
  return spec;
}

export function toDiskAttachRequest(input: DiskAttachInput): DiskAttachRequest {
  const request: DiskAttachRequest = { entity_id: input.entityId, entity_jwt: input.entityJwt };
  if (input.mountPath !== undefined) request.mount_path = input.mountPath;
  return request;
}

const OUTPUT_EVENT_TYPES: ReadonlyArray<OutputEvent["type"]> = ["stdout", "stderr", "gap", "exit"];
const OUTPUT_STREAMS: ReadonlyArray<"stdout" | "stderr"> = ["stdout", "stderr"];
const PROCESS_STATES: ReadonlyArray<ProcessState> = ["running", "exited", "killed", "lost"];

function oneOf<T extends string>(values: ReadonlyArray<T>): (value: unknown) => value is T {
  return (value): value is T => values.some((v) => v === value);
}
const isNumber = (value: unknown): value is number => typeof value === "number";
const isString = (value: unknown): value is string => typeof value === "string";
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";

/** Validates one decoded NDJSON line against the vendored `OutputEvent` shape. */
export function parseOutputEvent(value: unknown): OutputEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SandboxError(`malformed output event: ${JSON.stringify(value)}`);
  }
  const raw: Record<string, unknown> = { ...value };
  const field = <T>(key: string, check: (v: unknown) => v is T): T | undefined => {
    const v = raw[key];
    if (v === undefined || v === null) return undefined;
    if (!check(v))
      throw new SandboxError(`malformed output event: bad ${key} ${JSON.stringify(v)}`);
    return v;
  };
  const type = field("type", oneOf(OUTPUT_EVENT_TYPES));
  if (type === undefined) throw new SandboxError("malformed output event: missing type");
  return {
    type,
    offset: field("offset", isNumber),
    data: field("data", isString),
    stream: field("stream", oneOf(OUTPUT_STREAMS)),
    from: field("from", isNumber),
    to: field("to", isNumber),
    state: field("state", oneOf(PROCESS_STATES)),
    exit_code: field("exit_code", isNumber),
    signal: field("signal", isString),
    timed_out: field("timed_out", isBoolean),
  };
}

export function toOutputChunk(value: unknown): OutputChunk {
  const event = parseOutputEvent(value);
  switch (event.type) {
    case "stdout":
    case "stderr":
      return {
        type: event.type,
        offset: event.offset ?? 0,
        data: new Uint8Array(Buffer.from(event.data ?? "", "base64")),
      };
    case "gap":
      return {
        type: "gap",
        stream: event.stream ?? "stdout",
        from: event.from ?? 0,
        to: event.to ?? 0,
      };
    case "exit":
      return {
        type: "exit",
        state: event.state ?? "lost",
        exitCode: event.exit_code,
        signal: event.signal,
        timedOut: event.timed_out ?? false,
      };
  }
}
