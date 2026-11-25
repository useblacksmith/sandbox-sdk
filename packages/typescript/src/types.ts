import type {
  Disk,
  FileInfo,
  PortExposure,
  Process,
  ProcessSpec,
  ProcessState,
} from "./generated/types.gen.js";

/** camelCase mirror of the wire `ProcessSpec`; exactly one of `cmd` / `shell`. */
export interface ProcessSpecInput {
  cmd?: string[];
  shell?: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutSeconds?: number;
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

export interface StartProcessOptions extends RequestOptions {
  /**
   * Id of the process; defaults to a fresh `proc-<uuid>`. A caller that replays
   * `startProcess` itself passes the same id again so the command still starts once.
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
