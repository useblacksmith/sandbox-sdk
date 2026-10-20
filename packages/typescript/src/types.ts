import type {
  Disk,
  DiskAttachRequest,
  FileInfo,
  OutputEvent,
  PortExposure,
  Process,
  ProcessSpec,
  ProcessState,
} from "./generated/types.gen.js";
import { SandboxError } from "./errors.js";

/** camelCase mirror of the wire `ProcessSpec`; exactly one of `cmd` / `shell`. */
export interface ProcessSpecInput {
  cmd?: string[];
  shell?: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutSeconds?: number;
}

export function toProcessSpec(input: ProcessSpecInput): ProcessSpec {
  const spec: ProcessSpec = {};
  if (input.cmd !== undefined) spec.cmd = input.cmd;
  if (input.shell !== undefined) spec.shell = input.shell;
  if (input.cwd !== undefined) spec.cwd = input.cwd;
  if (input.env !== undefined) spec.env = input.env;
  if (input.timeoutSeconds !== undefined) spec.timeout_seconds = input.timeoutSeconds;
  return spec;
}

export interface RequestOptions {
  activity?: "active";
  signal?: AbortSignal;
  /** Overrides the client's per-request timeout (ms). `0` disables it. */
  timeoutMs?: number;
}

export interface StreamRequestOptions extends RequestOptions {
  /**
   * Fails the stream with `SandboxTransportError` when a body read waits this
   * long (ms) for the next bytes; a slow consumer never counts as idle. Unset or
   * `0` leaves the stream open indefinitely (the runtime's own idle timeout is
   * disabled for streams).
   */
  idleTimeoutMs?: number;
}

export interface ExecOptions extends RequestOptions {
  /**
   * Id of the process the command runs under; defaults to a fresh `exec-<uuid>`.
   * A caller that replays `exec` itself passes the same id again so the command
   * still runs once.
   */
  processId?: string;
}

export interface StartProcessResult {
  process: Process;
  /** `true` for 201 (started now), `false` for 200 (same spec already running). */
  created: boolean;
}

export interface ExposePortResult {
  exposure: PortExposure;
  /** `true` for 201 (exposed now), `false` for 200 (already exposed; same `hostname` and `rand`). */
  created: boolean;
}

/** camelCase mirror of the wire `DiskAttachRequest`. */
export interface DiskAttachInput {
  entityId: number;
  /** Storage-agent JWT scoped to `entityId`, minted by the control plane. */
  entityJwt: string;
  /** Formats a bare disk as ext4 and mounts it here in the guest; omitted, the disk stays a bare block device. */
  mountPath?: string;
}

export function toDiskAttachRequest(input: DiskAttachInput): DiskAttachRequest {
  const request: DiskAttachRequest = { entity_id: input.entityId, entity_jwt: input.entityJwt };
  if (input.mountPath !== undefined) request.mount_path = input.mountPath;
  return request;
}

export interface AttachDiskResult {
  disk: Disk;
  /** `true` for 201 (attached now), `false` for 200 (the entity was already attached). */
  created: boolean;
}

export interface StreamOutputOptions extends StreamRequestOptions {
  stream?: "stdout" | "stderr" | "both";
  stdoutFrom?: number;
  stderrFrom?: number;
  /** Keep the stream open until the process exits. */
  follow?: boolean;
}

export interface OutputDataChunk {
  type: "stdout" | "stderr";
  /** Byte offset of `data[0]` within that stream. */
  offset: number;
  data: Uint8Array;
}

/** Bytes `[from, to)` of `stream` were evicted before delivery. */
export interface OutputGapChunk {
  type: "gap";
  stream: "stdout" | "stderr";
  from: number;
  to: number;
}

export interface OutputExitChunk {
  type: "exit";
  state: ProcessState;
  exitCode: number | undefined;
  signal: string | undefined;
  timedOut: boolean;
}

export type OutputChunk = OutputDataChunk | OutputGapChunk | OutputExitChunk;

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

/** Metadata from the `GET /fs/file` response headers. */
export interface FileMetadata {
  path: string;
  /** Octal permission bits, e.g. `"0644"`. */
  mode: string | undefined;
  /** Advisory size from stat; the body may differ if the file changed mid-read. */
  size: number | undefined;
  lastModified: Date | undefined;
  requestId: string | undefined;
}

export interface FileContent extends FileMetadata {
  data: Uint8Array;
}

export interface FileStream extends FileMetadata {
  stream: ReadableStream<Uint8Array>;
}

export type WriteFileBody = Uint8Array | string | ReadableStream<Uint8Array>;

export interface WriteFileOptions extends RequestOptions {
  /** Octal permission bits for a newly created file, e.g. `"0644"` or `0o644`. */
  mode?: string | number;
  mkdirParents?: boolean;
}

export type { FileInfo, PortExposure, Process, ProcessSpec, ProcessState };
