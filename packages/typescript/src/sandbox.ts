import { SandboxError } from "./errors.js";
import type {
  ExecResponse,
  FileInfo,
  Health,
  PortExposure,
  Process,
} from "./generated/types.gen.js";
import type { SandboxFailure, SandboxRecord } from "./resources.js";
import type {
  FileContent,
  FileStream,
  OutputChunk,
  ProcessSpecInput,
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

/** One wait inside an agent call for a pause → resume cycle the control plane reported. */
export interface PauseResumeWait {
  id: string;
  /** The state the recheck found: `pausing`, `paused`, `resuming` or `starting`. */
  from: string;
  /** The state the wait ended on. */
  state: string;
  /**
   * `running`: the call replays; `not_running`: the cycle settled in `paused` or a terminal
   * state; `timeout`: it outlived `pauseResumeTimeoutMs`; `aborted`: the caller's signal fired;
   * `failed`: a control-plane poll failed, so how the cycle went is unknown.
   */
  outcome: "running" | "not_running" | "timeout" | "aborted" | "failed";
  waitedMs: number;
}

export interface SandboxOptions {
  /** How long `create`/`connect` wait for `GET /health` to succeed. Default 120s. */
  readyTimeoutMs?: number;
  /**
   * How long an agent call that finds the sandbox mid pause → resume cycle (`pausing`,
   * `resuming`, `starting`) waits for `running` and a healthy agent before failing with
   * `SandboxNotRunningError`. A cycle that settles in `paused` fails at once: only `resume()`
   * brings it back. Default 30s, the cycle SLO: production pauses settle in p99 14s and
   * resumes report running in p99 6.4s (2026-10).
   */
  pauseResumeTimeoutMs?: number;
  /** Called once per wait with how it ended, so the caller can chart the cycle SLO. */
  onPauseResumeWait?: (wait: PauseResumeWait) => void;
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
  pause(): Promise<SandboxRecord>;
  resume(): Promise<SandboxRecord>;
  delete(): Promise<SandboxRecord>;
  /**
   * Asks the sandbox whether it is healthy, without re-checking its state: the caller
   * decides what a failure means. The request itself is retried like any other call to
   * the sandbox, so some failures (a dropped connection, a `sandbox_paused` answer from
   * an old host) are retried before they are thrown.
   */
  health(options?: RequestOptions): Promise<Health>;

  /**
   * Replay-safe: the process id is fixed before the first attempt and the process
   * stays in place after a transport failure, so the replay finds it and the
   * command runs once. The call's own deadline is final.
   */
  exec(spec: ProcessSpecInput, options?: RequestOptions): Promise<ExecResponse>;
  /**
   * Starts a long-lived process and returns it; `Process.id` is what `streamOutput`,
   * `getProcess` and `killProcess` take, and `listProcesses` finds it again. Replay-safe
   * like `exec`: the command starts once however often the request is retried.
   */
  startProcess(spec: ProcessSpecInput, options?: RequestOptions): Promise<Process>;
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
