import type {
  Disk,
  DiskList,
  ExecResponse,
  FileInfo,
  Health,
  PortExposure,
  PortExposureList,
  Process,
  ProcessList,
} from "./generated/types.gen.js";
import { SandboxApiError, SandboxTransportError, isSandboxGone } from "./errors.js";
import { parseNdjson } from "./ndjson.js";
import { TokenSource, type TokenProvider } from "./token.js";
import {
  toDiskAttachRequest,
  toOutputChunk,
  toProcessSpec,
  type AttachDiskResult,
  type DiskAttachInput,
  type ExposePortResult,
  type FileContent,
  type FileMetadata,
  type FileStream,
  type OutputChunk,
  type OutputExitChunk,
  type ExecOptions,
  type ProcessSpecInput,
  type RequestOptions,
  type StartProcessResult,
  type StreamOutputOptions,
  type StreamRequestOptions,
  type WriteFileBody,
  type WriteFileOptions,
} from "./types.js";

export interface RetryOptions {
  /** Total attempts for idempotent requests that fail at the transport level. */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export interface SandboxClientOptions {
  /** Full agent base URL, e.g. `https://sbx-abc.sandboxes.example.com/v1`. */
  baseUrl?: string;
  /** Agent hostname; expands to `https://<hostname>/v1`. */
  hostname?: string;
  /** Fixed JWT. The client cannot recover from `token_expired` without a provider. */
  token?: string;
  /** Mints a fresh JWT; called at ~80% of the previous token's lifetime and after `token_expired`. */
  tokenProvider?: TokenProvider;
  fetch?: typeof globalThis.fetch;
  /**
   * Per-request timeout in ms; for streams it only covers time-to-headers and
   * for `exec` it is added on top of the process deadline. Default 30s.
   */
  timeoutMs?: number;
  retry?: RetryOptions;
}

type Method = "GET" | "POST" | "PUT" | "DELETE";

interface Operation {
  method: Method;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: string | Uint8Array | ReadableStream<Uint8Array>;
  contentType?: string;
  auth?: boolean;
  /** Safe to re-send after a transport failure. */
  idempotent: boolean;
  /**
   * Return the response as soon as headers arrive; the caller consumes the
   * body. The runtime's socket idle timeout is disabled (`timeout: false`, a
   * Bun extension Node ignores) so a quiet stream is only cut by `idleTimeoutMs`.
   */
  stream?: StreamRequestOptions;
  options?: RequestOptions;
}

const DEFAULT_TIMEOUT_MS = 30_000;
/** The agent's deployment default for an omitted `timeout_seconds` on `/exec`. */
const EXEC_DEFAULT_TIMEOUT_SECONDS = 300;
/** `ProcessSpec.timeout_seconds` maximum; `/exec` reads anything above it as `0`. */
const PROCESS_MAX_TIMEOUT_SECONDS = 31_622_400;
/** Bound on the `DELETE` that reclaims an exec process, independent of the call's deadline. */
const EXEC_CLEANUP_TIMEOUT_MS = 5_000;
/** The host may format and mount the disk before answering; the CLI allows the same. */
const ATTACH_DISK_TIMEOUT_MS = 180_000;
/** Detach unmounts in the guest first. */
const DETACH_DISK_TIMEOUT_MS = 60_000;
const DEFAULT_RETRY: Required<RetryOptions> = {
  maxAttempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 2_000,
};

export class SandboxClient {
  readonly baseUrl: string;
  private readonly tokens: TokenSource;
  private redialNext = false;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly retry: Required<RetryOptions>;

  constructor(options: SandboxClientOptions) {
    this.baseUrl = resolveBaseUrl(options);
    this.tokens = new TokenSource({ token: options.token, tokenProvider: options.tokenProvider });
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retry = {
      maxAttempts: options.retry?.maxAttempts ?? DEFAULT_RETRY.maxAttempts,
      baseDelayMs: options.retry?.baseDelayMs ?? DEFAULT_RETRY.baseDelayMs,
      maxDelayMs: options.retry?.maxDelayMs ?? DEFAULT_RETRY.maxDelayMs,
    };
  }

  health(options?: RequestOptions): Promise<Health> {
    return this.json<Health>({
      method: "GET",
      path: "/health",
      auth: false,
      idempotent: true,
      options,
    });
  }

  /**
   * Runs a command to completion and returns what `POST /exec` would. Built on
   * the process primitive so every leg survives a transport failure without
   * running the command twice: the process id is fixed for the call (a replayed
   * `PUT /processes/{id}` folds into the first start), output is read with
   * `follow` and resumed from the last offsets, and the process is deleted once
   * the call has its answer. When the caller fixed `options.processId` and the
   * call fails with a `SandboxTransportError`, the process is left in place, so
   * a replay under the same id finds it instead of starting the command again
   * (the agent reclaims it with the sandbox); such a replay reports
   * `duration_ms` from the agent's timestamps. A generated id is never
   * replayed, so that process is always deleted, even when the start's outcome
   * is unknown; only a start the agent rejected leaves nothing to delete. An
   * omitted `timeoutSeconds`
   * means 300s, as for `/exec`. Unless `options.timeoutMs` is
   * set, the whole call is bounded by `timeoutSeconds` plus the client's
   * `timeoutMs`; `timeoutSeconds: 0` leaves it unbounded. The deadline or the
   * caller's `signal` kills the process; that `DELETE` has its own short bound.
   */
  async exec(spec: ProcessSpecInput, options: ExecOptions = {}): Promise<ExecResponse> {
    const { processId, ...rest } = options;
    const id = processId ?? newExecProcessId();
    const timeoutSeconds = execTimeoutSeconds(spec.timeoutSeconds);
    const deadline = new RequestTimeout(
      rest.timeoutMs ?? execTimeoutMs(timeoutSeconds, this.timeoutMs),
      rest.signal,
    );
    const request: RequestOptions = { ...rest, signal: deadline.signal, timeoutMs: undefined };
    const called = Date.now();
    let cleanup = true;
    try {
      let start: StartProcessResult;
      try {
        start = await this.startProcess(id, { ...spec, timeoutSeconds }, request);
      } catch (error) {
        // Rejected outright (409: someone else's process), so nothing of ours is running.
        if (error instanceof SandboxApiError) cleanup = false;
        throw error;
      }
      const output = await this.collectOutput(id, request);
      if (output.exit.state === "lost") {
        throw new SandboxApiError(503, {
          code: "unavailable",
          message: "lost track of the process before it exited",
        });
      }
      return {
        exit_code: output.exit.exitCode,
        signal: output.exit.signal,
        stdout: new TextDecoder().decode(output.stdout),
        stderr: new TextDecoder().decode(output.stderr),
        truncated: output.truncated,
        timed_out: output.exit.timedOut,
        duration_ms: start.created
          ? Date.now() - called
          : attachedDurationMs(start.process, called),
      };
    } catch (error) {
      if (deadline.signal.aborted && !isAbort(error, rest.signal)) {
        throw new SandboxTransportError(
          "EXEC",
          this.url(`/processes/${id}`),
          1,
          deadline.signal.reason,
        );
      }
      // The process may still be running: the connection dropped, or the host that
      // answered no longer runs the sandbox at all. A replay under the same id
      // attaches to it instead of starting it again.
      if (
        (error instanceof SandboxTransportError || isSandboxGone(error)) &&
        processId !== undefined
      ) {
        cleanup = false;
      }
      throw error;
    } finally {
      deadline.clear();
      if (cleanup) await this.reclaimExecProcess(id);
    }
  }

  /** Best-effort `DELETE` with one bound across every retry, on its own signal. */
  private async reclaimExecProcess(id: string): Promise<void> {
    const bound = new RequestTimeout(EXEC_CLEANUP_TIMEOUT_MS, undefined);
    try {
      await this.killProcess(id, { signal: bound.signal, timeoutMs: EXEC_CLEANUP_TIMEOUT_MS });
    } catch {
      // the agent reclaims the process with the sandbox if this never lands
    } finally {
      bound.clear();
    }
  }

  async startProcess(
    id: string,
    spec: ProcessSpecInput,
    options?: RequestOptions,
  ): Promise<StartProcessResult> {
    const { response, body } = await this.send({
      method: "PUT",
      path: `/processes/${encodeURIComponent(id)}`,
      body: JSON.stringify(toProcessSpec(spec)),
      contentType: "application/json",
      idempotent: true,
      options,
    });
    return { process: parseJson<Process>(body), created: response.status === 201 };
  }

  getProcess(id: string, options?: RequestOptions): Promise<Process> {
    return this.json<Process>({
      method: "GET",
      path: `/processes/${encodeURIComponent(id)}`,
      idempotent: true,
      options,
    });
  }

  async listProcesses(options?: RequestOptions): Promise<Process[]> {
    const list = await this.json<ProcessList>({
      method: "GET",
      path: "/processes",
      idempotent: true,
      options,
    });
    return list.processes;
  }

  /**
   * Kills the process if running and forgets it and its output. A replay
   * after a transport failure that finds the process gone counts as success.
   */
  async killProcess(id: string, options?: RequestOptions): Promise<void> {
    await this.send({
      method: "DELETE",
      path: `/processes/${encodeURIComponent(id)}`,
      idempotent: true,
      options,
    });
  }

  /** Follows a process to its `exit`, resuming by offset after a mid-stream transport failure. */
  private async collectOutput(
    id: string,
    request: RequestOptions,
  ): Promise<{
    stdout: Uint8Array;
    stderr: Uint8Array;
    truncated: boolean;
    exit: OutputExitChunk;
  }> {
    const parts = { stdout: [] as Uint8Array[], stderr: [] as Uint8Array[] };
    const from = { stdout: 0, stderr: 0 };
    let truncated = false;
    for (let attempt = 1; ; attempt++) {
      try {
        for await (const chunk of this.streamOutput(id, {
          ...request,
          follow: true,
          stdoutFrom: from.stdout,
          stderrFrom: from.stderr,
        })) {
          if (chunk.type === "exit") {
            return {
              stdout: concat(parts.stdout),
              stderr: concat(parts.stderr),
              truncated,
              exit: chunk,
            };
          }
          if (chunk.type === "gap") {
            truncated = true;
            from[chunk.stream] = chunk.to;
          } else {
            parts[chunk.type].push(chunk.data);
            from[chunk.type] = chunk.offset + chunk.data.byteLength;
          }
        }
        throw new SandboxTransportError(
          "GET",
          this.url(`/processes/${encodeURIComponent(id)}/output`),
          attempt,
          new Error("output stream ended before the exit event"),
        );
      } catch (error) {
        if (!(error instanceof SandboxTransportError) || attempt >= this.retry.maxAttempts) {
          throw error;
        }
        await sleep(backoffDelay(attempt, this.retry), request.signal);
      }
    }
  }

  /**
   * Yields output chunks as the agent emits them. With `follow`, the stream
   * stays open until the `exit` chunk. A transport failure mid-stream throws
   * `SandboxTransportError`; resume from the last seen offsets.
   */
  async *streamOutput(id: string, options: StreamOutputOptions = {}): AsyncGenerator<OutputChunk> {
    const { stream, stdoutFrom, stderrFrom, follow, idleTimeoutMs, ...request } = options;
    const { response, release, idle } = await this.send({
      method: "GET",
      path: `/processes/${encodeURIComponent(id)}/output`,
      query: { stream, stdout_from: stdoutFrom, stderr_from: stderrFrom, follow },
      idempotent: true,
      stream: { idleTimeoutMs },
      options: request,
    });
    try {
      if (!response.body) return;
      for await (const event of parseNdjson(watched(response.body, idle))) {
        yield toOutputChunk(event);
      }
    } catch (error) {
      if (isAbort(error, request.signal)) throw error;
      throw new SandboxTransportError("GET", response.url, 1, error);
    } finally {
      release();
    }
  }

  async readFile(path: string, options?: RequestOptions): Promise<FileContent> {
    const { response, body } = await this.send({
      method: "GET",
      path: "/fs/file",
      query: { path },
      idempotent: true,
      options,
    });
    return { ...fileMetadata(path, response), data: body };
  }

  /**
   * Like `readFile` but hands back the body stream; `timeoutMs` covers headers
   * only and `idleTimeoutMs` the gaps between body chunks. A transport failure
   * mid-body surfaces as `SandboxTransportError`.
   */
  async readFileStream(path: string, options: StreamRequestOptions = {}): Promise<FileStream> {
    const { idleTimeoutMs, ...request } = options;
    const { response, release, idle } = await this.send({
      method: "GET",
      path: "/fs/file",
      query: { path },
      idempotent: true,
      stream: { idleTimeoutMs },
      options: request,
    });
    if (!response.body) {
      release();
      return {
        ...fileMetadata(path, response),
        stream: new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      };
    }
    return {
      ...fileMetadata(path, response),
      stream: transportBody(watched(response.body, idle), release, {
        url: response.url,
        signal: request.signal,
      }),
    };
  }

  /**
   * Creates or atomically replaces a file. Retried on transport failure only
   * when the whole body is in memory; a `ReadableStream` body is sent once.
   */
  writeFile(path: string, body: WriteFileBody, options: WriteFileOptions = {}): Promise<FileInfo> {
    const { mode, mkdirParents, ...request } = options;
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
    return this.json<FileInfo>({
      method: "PUT",
      path: "/fs/file",
      query: { path, mode: formatMode(mode), mkdir_parents: mkdirParents },
      body: bytes,
      contentType: "application/octet-stream",
      idempotent: !(bytes instanceof ReadableStream),
      options: request,
    });
  }

  /**
   * Gives a guest TCP port a public `https://port-<port>-<rand>-<sandbox_id>.<domain>`
   * hostname that proxies to it. Idempotent: the first call returns 201, later
   * calls 200 with the same `hostname`, so it is safe to replay. Nothing checks
   * that the port is listening; the hostname answers 502 until it does. Traffic
   * on the hostname is unauthenticated: `rand` is the only secret.
   */
  async exposePort(port: number, options?: RequestOptions): Promise<ExposePortResult> {
    const { response, body } = await this.send({
      method: "PUT",
      path: `/ports/${portSegment(port)}`,
      idempotent: true,
      options,
    });
    return { exposure: parseJson<PortExposure>(body), created: response.status === 201 };
  }

  /** Exposed ports, ordered by port. */
  async listPorts(options?: RequestOptions): Promise<PortExposure[]> {
    const list = await this.json<PortExposureList>({
      method: "GET",
      path: "/ports",
      idempotent: true,
      options,
    });
    return list.ports;
  }

  /**
   * Unbinds the port's hostname; connections already proxied finish. A replay
   * after a transport failure that finds the port gone counts as success.
   */
  async unexposePort(port: number, options?: RequestOptions): Promise<void> {
    await this.send({
      method: "DELETE",
      path: `/ports/${portSegment(port)}`,
      idempotent: true,
      options,
    });
  }

  /**
   * Serves a sticky disk entity on a free drive slot of the running VM. Writes to
   * it are discarded: nothing is ever committed. Idempotent per entity: the
   * first call returns 201, later calls 200 with the same attachment. Not
   * retried: while the first attempt still runs, a replay gets 409. The
   * attachment lasts for the current VM only; a pause, resume or crash drops it,
   * so callers re-attach after any resume. Defaults to a 180s timeout.
   */
  async attachDisk(input: DiskAttachInput, options?: RequestOptions): Promise<AttachDiskResult> {
    const { response, body } = await this.send({
      method: "POST",
      path: "/disks",
      body: JSON.stringify(toDiskAttachRequest(input)),
      contentType: "application/json",
      idempotent: false,
      options: { ...options, timeoutMs: options?.timeoutMs ?? ATTACH_DISK_TIMEOUT_MS },
    });
    return { disk: parseJson<Disk>(body), created: response.status === 201 };
  }

  /** Disks attached to the current VM, detached ones included, ordered by slot. */
  async listDisks(options?: RequestOptions): Promise<Disk[]> {
    const list = await this.json<DiskList>({
      method: "GET",
      path: "/disks",
      idempotent: true,
      options,
    });
    return list.disks;
  }

  /**
   * Unmounts the disk at `slot` and fails its drive. The slot stays taken until
   * the VM stops. Idempotent, but not retried: a replay during the unmount gets
   * 409, and one after a first attempt that never arrived gets 404 for an empty
   * slot instead of a disk. Defaults to a 60s timeout.
   */
  async detachDisk(slot: number, options?: RequestOptions): Promise<Disk> {
    return this.json<Disk>({
      method: "DELETE",
      path: `/disks/${slotSegment(slot)}`,
      idempotent: false,
      options: { ...options, timeoutMs: options?.timeoutMs ?? DETACH_DISK_TIMEOUT_MS },
    });
  }

  /**
   * Makes the next request dial a fresh connection instead of reusing a pooled
   * one. Call it when the control plane says the sandbox moved (a resume lands
   * on another host) so the request re-resolves the hostname.
   */
  redial(): void {
    this.redialNext = true;
  }

  private async json<T>(op: Operation): Promise<T> {
    const { body } = await this.send(op);
    return parseJson<T>(body);
  }

  /**
   * For `stream` operations the body is empty, `idle` runs the idle timer only
   * while a body read is outstanding, and `release` must be called once the
   * caller is done with `response.body`; otherwise both are no-ops.
   */
  private async send(
    op: Operation,
  ): Promise<{ response: Response; body: Uint8Array; release: () => void; idle: IdleWatch }> {
    const url = this.url(op.path, op.query);
    const signal = op.options?.signal;
    const timeoutMs = op.options?.timeoutMs ?? this.timeoutMs;
    const maxAttempts = op.idempotent ? this.retry.maxAttempts : 1;
    let refreshed = false;
    let replayed = false;
    let reconnected = this.redialNext;
    this.redialNext = false;

    for (let attempt = 1; ; attempt++) {
      signal?.throwIfAborted();
      const token = op.auth === false ? undefined : await this.tokens.get();
      const timeout = new RequestTimeout(timeoutMs, signal);
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: op.method,
          headers: buildHeaders(op, token),
          body: op.body,
          signal: timeout.signal,
          // Bun's fetch bypasses its shared socket pool for this reconnect.
          ...(reconnected ? { keepalive: false } : {}),
          ...(op.body instanceof ReadableStream ? { duplex: "half" } : {}),
          ...(op.stream ? { timeout: false } : {}),
        } as RequestInit);
      } catch (error) {
        timeout.clear();
        if (isAbort(error, signal)) throw error;
        if (attempt < maxAttempts) {
          await sleep(backoffDelay(attempt, this.retry), signal);
          replayed = true;
          continue;
        }
        throw new SandboxTransportError(op.method, url, attempt, error);
      }

      if (response.ok && op.stream) {
        timeout.watchIdle(op.stream.idleTimeoutMs ?? 0);
        return { response, body: new Uint8Array(), release: () => timeout.clear(), idle: timeout };
      }

      let body: Uint8Array;
      try {
        body = new Uint8Array(await response.arrayBuffer());
      } catch (error) {
        if (isAbort(error, signal)) throw error;
        if (attempt < maxAttempts) {
          await sleep(backoffDelay(attempt, this.retry), signal);
          replayed = true;
          continue;
        }
        throw new SandboxTransportError(op.method, url, attempt, error);
      } finally {
        timeout.clear();
      }
      if (response.ok) return { response, body, release: noop, idle: noIdleWatch };

      const apiError = SandboxApiError.fromResponse(
        response.status,
        new TextDecoder().decode(body),
        response.headers.get("x-request-id") ?? undefined,
      );
      const canReplay = !(op.body instanceof ReadableStream);
      // The old host rejects a relocated sandbox before dispatching the request:
      // 404 from a router with no socket for it, 409 `sandbox_paused` from the
      // socket the agent keeps serving after a pause, which a resume elsewhere
      // leaves behind. The redial re-resolves the hostname.
      if (isStaleHost(apiError)) {
        if (!reconnected && canReplay) {
          reconnected = true;
          continue;
        }
        throw apiError;
      }
      // The lost response to a DELETE was its success; the replay finds nothing left.
      if (op.method === "DELETE" && replayed && apiError.code === "not_found") {
        return { response, body, release: noop, idle: noIdleWatch };
      }
      if (
        apiError.code === "token_expired" &&
        token !== undefined &&
        !refreshed &&
        canReplay &&
        this.tokens.refreshable
      ) {
        this.tokens.invalidate(token);
        refreshed = true;
        continue;
      }
      throw apiError;
    }
  }

  private url(path: string, query?: Operation["query"]): string {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }
}

function isStaleHost(error: SandboxApiError): boolean {
  if (error.code === "sandbox_paused") return true;
  return (
    error.status === 404 &&
    error.code === "not_found" &&
    error.message === "sandbox not found on this host"
  );
}

function resolveBaseUrl(options: SandboxClientOptions): string {
  if (options.baseUrl !== undefined && options.hostname !== undefined) {
    throw new TypeError("pass either baseUrl or hostname, not both");
  }
  let url: URL;
  if (options.baseUrl !== undefined) {
    url = new URL(options.baseUrl);
  } else if (options.hostname !== undefined) {
    url = new URL(`https://${options.hostname}/v1`);
  } else {
    throw new TypeError("one of baseUrl or hostname is required");
  }
  const pathname = url.pathname.replace(/\/+$/, "");
  url.pathname = pathname === "" ? "/v1" : pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function buildHeaders(op: Operation, token: string | undefined): Headers {
  const headers = new Headers({ accept: "application/json" });
  if (token !== undefined) headers.set("authorization", `Bearer ${token}`);
  if (op.contentType !== undefined) headers.set("content-type", op.contentType);
  if (op.options?.activity === "active") headers.set("X-Sandbox-Activity", "active");
  headers.set("x-request-id", crypto.randomUUID());
  return headers;
}

function parseJson<T>(body: Uint8Array): T {
  return JSON.parse(new TextDecoder().decode(body)) as T;
}

function fileMetadata(path: string, response: Response): FileMetadata {
  const size = response.headers.get("x-file-size");
  const lastModified = response.headers.get("last-modified");
  const parsedDate = lastModified === null ? Number.NaN : Date.parse(lastModified);
  return {
    path,
    mode: response.headers.get("x-file-mode") ?? undefined,
    size: size === null ? undefined : Number(size),
    lastModified: Number.isNaN(parsedDate) ? undefined : new Date(parsedDate),
    requestId: response.headers.get("x-request-id") ?? undefined,
  };
}

function portSegment(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RangeError(`port must be an integer in 1..65535, got ${port}`);
  }
  return String(port);
}

function slotSegment(slot: number): string {
  if (!Number.isInteger(slot) || slot < 2 || slot > 11) {
    throw new RangeError(`slot must be an integer in 2..11, got ${slot}`);
  }
  return String(slot);
}

function formatMode(mode: string | number | undefined): string | undefined {
  if (mode === undefined) return undefined;
  return typeof mode === "number" ? `0${mode.toString(8).padStart(3, "0")}` : mode;
}

function execTimeoutMs(timeoutSeconds: number, graceMs: number): number {
  return timeoutSeconds === 0 ? 0 : timeoutSeconds * 1000 + graceMs;
}

/**
 * Duration of a process this call attached to rather than started: its own
 * start-to-finish when the agent already saw it exit, otherwise from its start
 * until now. Unparsable timestamps fall back to this call's own clock.
 */
function attachedDurationMs(process: Process, called: number): number {
  const started = Date.parse(process.started_at ?? process.created_at);
  if (Number.isNaN(started)) return Date.now() - called;
  const finished = process.finished_at === undefined ? Number.NaN : Date.parse(process.finished_at);
  return (Number.isNaN(finished) ? Date.now() : finished) - started;
}

function execTimeoutSeconds(requested: number | undefined): number {
  if (requested === undefined) return EXEC_DEFAULT_TIMEOUT_SECONDS;
  return requested > PROCESS_MAX_TIMEOUT_SECONDS ? 0 : requested;
}

export function newExecProcessId(): string {
  return `exec-${crypto.randomUUID()}`;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function noop(): void {}

/** Idle timer bracketed around each network read, so a slow consumer never counts as idle. */
interface IdleWatch {
  waiting(): void;
  received(): void;
}

const noIdleWatch: IdleWatch = { waiting: noop, received: noop };

/** Forwards `source`, running the idle timer only while a read from it is outstanding. */
function watched(source: ReadableStream<Uint8Array>, idle: IdleWatch): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        idle.waiting();
        try {
          const { value, done } = await reader.read();
          if (done) controller.close();
          else controller.enqueue(value);
        } finally {
          idle.received();
        }
      },
      cancel: (reason) => reader.cancel(reason),
    },
    // no prefetch: pull only runs while the consumer has a read pending
    { highWaterMark: 0 },
  );
}

/**
 * Forwards `source`, calls `release` once it ends, errors or is cancelled, and
 * wraps non-abort read failures in `SandboxTransportError`.
 */
function transportBody(
  source: ReadableStream<Uint8Array>,
  release: () => void,
  request: { url: string; signal: AbortSignal | undefined },
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch (error) {
        release();
        if (isAbort(error, request.signal)) throw error;
        throw new SandboxTransportError("GET", request.url, 1, error);
      }
      if (next.done) {
        release();
        controller.close();
      } else {
        controller.enqueue(next.value);
      }
    },
    async cancel(reason) {
      release();
      await reader.cancel(reason);
    },
  });
}

function backoffDelay(attempt: number, retry: Required<RetryOptions>): number {
  const exponential = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** (attempt - 1));
  return Math.round(exponential * (0.5 + Math.random() * 0.5));
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal?.reason);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true || (signal !== undefined && error === signal.reason);
}

/**
 * Aborts a fetch after `timeoutMs`, when the caller's signal fires, or once
 * `watchIdle` is on and a `waiting()` read stays unanswered for `idleMs`.
 */
class RequestTimeout implements IdleWatch {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private idleMs = 0;
  private readonly upstream: AbortSignal | undefined;

  constructor(timeoutMs: number, upstream: AbortSignal | undefined) {
    this.signal = this.controller.signal;
    this.upstream = upstream;
    upstream?.addEventListener("abort", this.onUpstreamAbort, { once: true });
    if (timeoutMs > 0) {
      this.timer = setTimeout(
        () => this.controller.abort(new TimeoutError(`request timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    }
  }

  clear(): void {
    this.clearTimer();
    this.upstream?.removeEventListener("abort", this.onUpstreamAbort);
  }

  /** Drops the deadline in favour of a per-read idle timer; `0` means none. */
  watchIdle(idleMs: number): void {
    this.clearTimer();
    this.idleMs = idleMs;
  }

  waiting(): void {
    if (this.idleMs <= 0) return;
    this.clearTimer();
    this.timer = setTimeout(
      () => this.controller.abort(new IdleTimeoutError(this.idleMs)),
      this.idleMs,
    );
  }

  received(): void {
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
  }

  private readonly onUpstreamAbort = (): void => {
    this.controller.abort(this.upstream?.reason);
  };
}

class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

/** The caller's `idleTimeoutMs` elapsed; a deliberate bound, not a flaky link. */
export class IdleTimeoutError extends TimeoutError {
  constructor(idleMs: number) {
    super(`stream idle for ${idleMs}ms`);
  }
}
