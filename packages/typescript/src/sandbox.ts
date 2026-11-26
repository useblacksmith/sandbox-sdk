import { SandboxError } from "./errors.js";
import type { SandboxFailure, SandboxRecord } from "./resources.js";
import type {
  ExecResult,
  FileContent,
  FileInfo,
  FileStream,
  OutputChunk,
  PortExposure,
  Process,
  ProcessSpec,
  RequestOptions,
  StreamOutputOptions,
  StreamRequestOptions,
  WriteFileBody,
  WriteFileOptions,
} from "./types.js";

/** The control plane reports the sandbox is not `running`, so the agent is unreachable by design. */
export class SandboxNotRunningError extends SandboxError {
  readonly id: string;
  readonly state: string;
  readonly lastError: string | SandboxFailure | undefined;
  readonly code: string | undefined;

  constructor(record: SandboxRecord, options?: ErrorOptions) {
    const failure = record.lastError;
    const reason = typeof failure === "string" ? failure : failure?.message;
    const stateMessage = `sandbox ${record.id} is ${record.state}, not running`;
    super(reason === undefined ? stateMessage : `${stateMessage}: ${reason}`, options);
    this.id = record.id;
    this.state = record.state;
    this.lastError = failure;
    this.code = typeof failure === "string" ? undefined : failure?.code;
  }
}

export interface SandboxOptions {
  /** How long `create`/`connect` wait for `GET /health` to succeed. Default 120s. */
  readyTimeoutMs?: number;
  /**
   * Sends this sandbox's requests to the sandbox itself, in place of the `fetch` given to
   * `Blacksmith`: for a proxy, tracing, custom TLS or a test. Requests to the Blacksmith
   * API do not go through it.
   */
  fetch?: typeof globalThis.fetch;
}

/**
 * One sandbox: lifecycle calls go to the Blacksmith API, everything else to the sandbox
 * itself. A call to the sandbox that fails at the transport level re-checks the sandbox's
 * state: one that is not `running` raises `SandboxNotRunningError`; a running one gets the
 * call retried once.
 */
export interface Sandbox {
  readonly id: string;
  /** Last state seen from the Blacksmith API; `refresh()` updates it. */
  readonly state: SandboxRecord["state"];
  readonly lastError: SandboxRecord["lastError"];

  refresh(): Promise<SandboxRecord>;
  /**
   * Resolves once the sandbox is `paused`, its boot disk kept. Throws `SandboxError` when it
   * is not `paused` within `timeoutMs` (default 30s) or leaves the pause for another state.
   * The last state read starts at `timeoutMs`, so the call settles up to one request after
   * it, and a `paused` that read reports resolves the call.
   */
  pause(timeoutMs?: number): Promise<SandboxRecord>;
  /**
   * Resolves once the sandbox is `running` and answers `GET /health`, so the next call to it
   * does not wait. Throws `SandboxNotRunningError` when it is not `running` within
   * `timeoutMs` (default 30s), and `SandboxTransportError` when it is `running` but does not answer in time.
   * The last state read starts at `timeoutMs`, as for `pause()`.
   */
  resume(timeoutMs?: number): Promise<SandboxRecord>;
  delete(): Promise<SandboxRecord>;
  /**
   * Asks the sandbox whether it is healthy, without re-checking its state: the caller
   * decides what a failure means. The request itself is retried like any other call to
   * the sandbox, so some failures (a dropped connection, a `sandbox_paused` answer from
   * an old host) are retried before they are thrown.
   */
  health(options?: RequestOptions): Promise<void>;

  /**
   * Replay-safe: the process id is fixed before the first attempt and the process
   * stays in place after a transport failure, so the replay finds it and the
   * command runs once. The call's own deadline is final.
   */
  exec(spec: ProcessSpec, options?: RequestOptions): Promise<ExecResult>;
  /**
   * Starts a long-lived process and returns it; `Process.id` is what `streamOutput`,
   * `getProcess` and `killProcess` take, and `listProcesses` finds it again. Replay-safe
   * like `exec`: the command starts once however often the request is retried.
   */
  startProcess(spec: ProcessSpec, options?: RequestOptions): Promise<Process>;
  getProcess(id: string, options?: RequestOptions): Promise<Process>;
  listProcesses(options?: RequestOptions): Promise<Process[]>;
  killProcess(id: string, options?: RequestOptions): Promise<void>;
  /**
   * Yields output chunks as the process emits them. With `follow`, the stream stays open
   * until the `exit` chunk. A transport failure mid-stream re-checks the sandbox's state
   * and, if it is still running, resumes once from the last delivered offsets.
   */
  streamOutput(
    id: string,
    options?: StreamOutputOptions,
  ): AsyncGenerator<OutputChunk, void, undefined>;

  exposePort(port: number, options?: RequestOptions): Promise<PortExposure>;
  listPorts(options?: RequestOptions): Promise<PortExposure[]>;
  unexposePort(port: number, options?: RequestOptions): Promise<void>;

  readFile(path: string, options?: RequestOptions): Promise<FileContent>;
  readFileStream(path: string, options?: StreamRequestOptions): Promise<FileStream>;
  /** A `ReadableStream` body is consumed by the first attempt, so it is never replayed. */
  writeFile(path: string, body: WriteFileBody, options?: WriteFileOptions): Promise<FileInfo>;
}
