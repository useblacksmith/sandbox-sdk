import {
  IdleTimeoutError,
  SandboxClient,
  newExecProcessId,
  newProcessId,
  type RetryOptions,
} from "./client.js";
import { terminalFailureRecord } from "./control-plane.js";
import type { CreatedSandboxRecord, SandboxControlPlane } from "./control-plane.js";
import {
  ControlPlaneError,
  SandboxApiError,
  SandboxError,
  SandboxTransportError,
} from "../errors.js";
import type { SandboxCreateOptions, SandboxRecord } from "../resources.js";
import {
  SandboxNotRunningError,
  type PauseResumeWait,
  type Sandbox as PublicSandbox,
  type SandboxOptions,
} from "../sandbox.js";
import { isSandboxGone } from "./errors.js";
import { sandboxTokens, type SandboxTokens, type SharedToken } from "./token-cache.js";
import type {
  Disk,
  ExecResponse,
  FileInfo,
  Health,
  PortExposure,
  Process,
} from "../generated/types.gen.js";
import type { TokenProvider } from "./token.js";
import type {
  DiskAttachInput,
  FileContent,
  FileStream,
  OutputChunk,
  ProcessSpecInput,
  ExecOptions,
  RequestOptions,
  StartProcessOptions,
  StreamOutputOptions,
  StreamRequestOptions,
  WriteFileBody,
  WriteFileOptions,
} from "../types.js";

/** A failure that warrants asking the control plane what the sandbox is doing. */
type RecheckCause = SandboxTransportError | SandboxApiError;

export interface SandboxAttachOptions extends SandboxOptions {
  /** Maps the minted hostname to the agent base URL. Default `https://<hostname>/v1`. */
  agentBaseUrl?: (hostname: string) => string;
  /** Retry tuning for this sandbox's requests to the sandbox itself. */
  retry?: RetryOptions;
}

const DEFAULT_READY_TIMEOUT_MS = 120_000;
const DEFAULT_PAUSE_RESUME_TIMEOUT_MS = 30_000;
/**
 * How many times a call is replayed after a retired socket answered for a sandbox the
 * control plane says is running. Each such answer closes the connection that carried it,
 * so every replay retires one more pooled connection to the old host.
 */
const GONE_REPLAYS = 3;
const READY_POLL_BASE_MS = 250;
const READY_POLL_MAX_MS = 5_000;

/** The record a sandbox keeps: the token `create` returned lives only in the token cache. */
function withoutToken(created: CreatedSandboxRecord): SandboxRecord {
  const record: CreatedSandboxRecord = { ...created, raw: { ...created.raw } };
  delete record.token;
  delete record.replayed;
  delete record.raw.token;
  return record;
}

/**
 * One sandbox seen through both clients: lifecycle via `SandboxControlPlane`,
 * everything else via `SandboxClient`. Agent calls that fail at the transport
 * level re-check the control plane: a sandbox that is not `running` raises
 * `SandboxNotRunningError`; a running one gets the call retried once.
 */
export class Sandbox implements PublicSandbox {
  readonly id: string;
  readonly #client: SandboxClient;
  readonly #cp: SandboxControlPlane;
  #record: SandboxRecord;
  readonly #pauseResumeTimeoutMs: number;
  readonly #onPauseResumeWait: ((wait: PauseResumeWait) => void) | undefined;

  private constructor(
    cp: SandboxControlPlane,
    record: SandboxRecord,
    client: SandboxClient,
    options: SandboxOptions,
  ) {
    this.#cp = cp;
    this.id = record.id;
    this.#record = record;
    this.#client = client;
    this.#pauseResumeTimeoutMs = options.pauseResumeTimeoutMs ?? DEFAULT_PAUSE_RESUME_TIMEOUT_MS;
    this.#onPauseResumeWait = options.onPauseResumeWait;
  }

  static async create(
    cp: SandboxControlPlane,
    createOptions: SandboxCreateOptions,
    options: SandboxAttachOptions = {},
  ): Promise<Sandbox> {
    let record: CreatedSandboxRecord;
    try {
      record = await cp.create(createOptions);
    } catch (error) {
      const failed = terminalFailureRecord(error);
      if (failed) throw new SandboxNotRunningError(failed, { cause: error });
      throw error;
    }
    if (
      createOptions.idleDeleteTimeoutSeconds !== undefined &&
      record.raw.idle_delete_timeout_seconds !== createOptions.idleDeleteTimeoutSeconds
    ) {
      // A fresh allocation without the policy would never be deleted. A keyed create may return
      // a sandbox another caller already holds, so delete it only when the record is known new.
      const fresh = createOptions.idempotencyKey === undefined || record.replayed === false;
      if (fresh) await cp.delete(record.id).catch(() => undefined);
      throw new SandboxError("control plane did not accept idle deletion policy");
    }
    try {
      return await Sandbox.#attach(cp, record, options);
    } catch (error) {
      // The caller never gets a handle, so a freshly allocated VM would leak. A keyed create
      // may have replayed a record another caller already holds, so leave it alone.
      if (
        createOptions.idempotencyKey === undefined &&
        !(error instanceof SandboxNotRunningError && error.state === "failed")
      ) {
        await cp.delete(record.id).catch(() => undefined);
      }
      throw error;
    }
  }

  static async connect(
    cp: SandboxControlPlane,
    id: string,
    options: SandboxAttachOptions = {},
  ): Promise<Sandbox> {
    return Sandbox.#attach(cp, await cp.get(id), options);
  }

  static async #attach(
    cp: SandboxControlPlane,
    record: CreatedSandboxRecord,
    options: SandboxAttachOptions,
  ): Promise<Sandbox> {
    // The control plane still mints tokens for a `deleting` record whose VM is already gone.
    if (isTerminal(record.state)) throw new SandboxNotRunningError(record);
    const tokens = sandboxTokens(cp);
    let attached: SharedToken;
    try {
      attached = record.token
        ? tokens.remember(record.id, record.token)
        : await tokens.reuse(record.id);
    } catch (error) {
      const failed = terminalFailureRecord(error);
      if (failed) {
        if (failed.id !== record.id) throw error;
        throw new SandboxNotRunningError(failed, { cause: error });
      }
      if (
        error instanceof ControlPlaneError &&
        error.status === 409 &&
        error.code === "invalid_state" &&
        error.sandboxStatus === "failed"
      ) {
        const refreshed = await cp.get(record.id).catch(() => undefined);
        if (refreshed && isTerminal(refreshed.state)) {
          throw new SandboxNotRunningError(refreshed, { cause: error });
        }
      }
      throw error;
    }
    const toBaseUrl = options.agentBaseUrl ?? ((hostname: string) => `https://${hostname}/v1`);
    const client = new SandboxClient({
      fetch: options.fetch,
      retry: options.retry,
      baseUrl: toBaseUrl(attached.token.hostname),
      tokenProvider: sharedTokenProvider(tokens, record.id, attached),
    });
    const sandbox = new Sandbox(cp, withoutToken(record), client, options);
    // A pausing or paused VM is unreachable until `resume()`, so there is no agent to wait for.
    if (!isPaused(record.state)) {
      await sandbox.#waitUntilReady(options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
    }
    return sandbox;
  }

  get state(): SandboxRecord["state"] {
    return this.#record.state;
  }

  get lastError(): SandboxRecord["lastError"] {
    return this.#record.lastError;
  }

  async refresh(): Promise<SandboxRecord> {
    this.#record = await this.#cp.get(this.id);
    return this.#record;
  }

  async pause(): Promise<SandboxRecord> {
    this.#record = await this.#cp.pause(this.id);
    return this.#record;
  }

  async resume(): Promise<SandboxRecord> {
    try {
      this.#record = await this.#cp.resume(this.id);
      return this.#record;
    } catch (error) {
      const failed = terminalFailureRecord(error);
      if (failed && failed.id === this.id) {
        this.#record = { ...this.#record, state: failed.state, lastError: failed.lastError };
        throw new SandboxNotRunningError(this.#record, { cause: error });
      }
      throw error;
    }
  }

  async delete(): Promise<SandboxRecord> {
    this.#record = await this.#cp.delete(this.id);
    return this.#record;
  }

  async health(options?: RequestOptions): Promise<Health> {
    try {
      return await this.#client.health(options);
    } catch (error) {
      // The socket that answered belongs to a VM the host no longer runs; the next call dials afresh.
      if (isSandboxGone(error)) this.#client.redial();
      throw error;
    }
  }

  exec(spec: ProcessSpecInput, options: ExecOptions = {}): Promise<ExecResponse> {
    const processId = options.processId ?? newExecProcessId();
    return this.#withRecheck(() => this.#client.exec(spec, { ...options, processId }), {
      replay: (error) => !(error instanceof SandboxTransportError) || error.method !== "EXEC",
      signal: options.signal,
    });
  }

  async startProcess(spec: ProcessSpecInput, options: StartProcessOptions = {}): Promise<Process> {
    const { processId = newProcessId(), ...request } = options;
    const { process } = await this.#withRecheck(
      () => this.#client.startProcess(processId, spec, request),
      { signal: options.signal },
    );
    return process;
  }

  getProcess(id: string, options?: RequestOptions): Promise<Process> {
    return this.#withRecheck(() => this.#client.getProcess(id, options), {
      signal: options?.signal,
    });
  }

  listProcesses(options?: RequestOptions): Promise<Process[]> {
    return this.#withRecheck(() => this.#client.listProcesses(options), {
      signal: options?.signal,
    });
  }

  killProcess(id: string, options?: RequestOptions): Promise<void> {
    return this.#withRecheck(() => this.#client.killProcess(id, options), {
      signal: options?.signal,
    });
  }

  async exposePort(port: number, options?: RequestOptions): Promise<PortExposure> {
    const { exposure } = await this.#withRecheck(() => this.#client.exposePort(port, options), {
      signal: options?.signal,
    });
    return exposure;
  }

  listPorts(options?: RequestOptions): Promise<PortExposure[]> {
    return this.#withRecheck(() => this.#client.listPorts(options), { signal: options?.signal });
  }

  unexposePort(port: number, options?: RequestOptions): Promise<void> {
    return this.#withRecheck(() => this.#client.unexposePort(port, options), {
      signal: options?.signal,
    });
  }

  /**
   * Serves a sticky disk entity on a free drive slot of the running VM. Writes to it are
   * discarded: nothing is ever committed. Idempotent per entity. Never replayed. The
   * attachment does not survive `pause()`/`resume()` or a crash, so re-attach after any
   * resume.
   */
  async attachDisk(input: DiskAttachInput, options?: RequestOptions): Promise<Disk> {
    const { disk } = await this.#withRecheck(() => this.#client.attachDisk(input, options), {
      replay: false,
      signal: options?.signal,
    });
    return disk;
  }

  listDisks(options?: RequestOptions): Promise<Disk[]> {
    return this.#withRecheck(() => this.#client.listDisks(options), { signal: options?.signal });
  }

  async *streamOutput(
    id: string,
    options: StreamOutputOptions = {},
  ): AsyncGenerator<OutputChunk, void, undefined> {
    let stdoutFrom = options.stdoutFrom;
    let stderrFrom = options.stderrFrom;
    let resumed = false;
    let goneReplays = 0;
    for (;;) {
      try {
        for await (const chunk of this.#client.streamOutput(id, {
          ...options,
          stdoutFrom,
          stderrFrom,
        })) {
          if (chunk.type === "stdout") stdoutFrom = chunk.offset + chunk.data.byteLength;
          if (chunk.type === "stderr") stderrFrom = chunk.offset + chunk.data.byteLength;
          yield chunk;
        }
        return;
      } catch (error) {
        if (!isRecheckCause(error)) throw error;
        if (error instanceof SandboxTransportError) {
          if (resumed || error.cause instanceof IdleTimeoutError) throw error;
          resumed = true;
        } else if (++goneReplays > GONE_REPLAYS) {
          throw error;
        }
        await this.#recheck(error, options.signal);
      }
    }
  }

  readFile(path: string, options?: RequestOptions): Promise<FileContent> {
    return this.#withRecheck(() => this.#client.readFile(path, options), {
      signal: options?.signal,
    });
  }

  readFileStream(path: string, options?: StreamRequestOptions): Promise<FileStream> {
    return this.#withRecheck(() => this.#client.readFileStream(path, options), {
      signal: options?.signal,
    });
  }

  writeFile(path: string, body: WriteFileBody, options?: WriteFileOptions): Promise<FileInfo> {
    return this.#withRecheck(() => this.#client.writeFile(path, body, options), {
      replay: !(body instanceof ReadableStream),
      signal: options?.signal,
    });
  }

  async #withRecheck<T>(
    call: () => Promise<T>,
    {
      replay = true,
      signal,
    }: { replay?: boolean | ((error: RecheckCause) => boolean); signal?: AbortSignal } = {},
  ): Promise<T> {
    let transportReplayed = false;
    for (let goneReplays = 0; ;) {
      try {
        return await call();
      } catch (error) {
        if (!isRecheckCause(error)) throw error;
        if (error instanceof SandboxTransportError && transportReplayed) throw error;
        await this.#recheck(error, signal);
        if (!(typeof replay === "function" ? replay(error) : replay)) throw error;
        if (error instanceof SandboxTransportError) {
          transportReplayed = true;
        } else if (++goneReplays > GONE_REPLAYS) {
          throw error;
        }
      }
    }
  }

  /**
   * Resolves when the control plane still says `running`; throws `SandboxNotRunningError`
   * otherwise. A host that answered for a sandbox it no longer runs speaks for the VM it
   * last had, so when the control plane says `running` the replay dials afresh and
   * re-resolves the hostname instead of reusing a connection to that host. A transport
   * failure is replayed once; a retired socket's answer up to `GONE_REPLAYS` times.
   */
  async #recheck(cause: RecheckCause, signal?: AbortSignal): Promise<void> {
    if (signal) await this.#readRecord(signal);
    else await this.refresh();
    if (isInPauseResumeCycle(this.#record.state)) {
      return this.#waitThroughPauseResume(cause, signal);
    }
    if (this.#record.state !== "running") throw new SandboxNotRunningError(this.#record, { cause });
    if (cause instanceof SandboxApiError) this.#client.redial();
  }

  /**
   * Polls the record while a pause → resume cycle runs, then waits for the agent on the host
   * the resume landed on; the replay follows. A cycle that lands back in `pausing` before the
   * agent answers is polled again. A final poll can start at the deadline and use up to 250ms
   * more; all reads and health checks share that cutoff. A record in `paused` or a terminal
   * state, the caller's `signal` or a failed poll ends it sooner. Every exit reports to
   * `onPauseResumeWait`.
   */
  async #waitThroughPauseResume(cause: RecheckCause, signal?: AbortSignal): Promise<void> {
    const from = this.#record.state;
    const started = Date.now();
    const deadline = started + this.#pauseResumeTimeoutMs;
    const cutoff = deadline + READY_POLL_BASE_MS;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), Math.max(0, cutoff - Date.now()));
    const waitSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    const ended = (outcome: PauseResumeWait["outcome"]) =>
      this.#onPauseResumeWait?.({
        id: this.id,
        from,
        state: this.#record.state,
        outcome,
        waitedMs: Date.now() - started,
      });
    const fail = (outcome: PauseResumeWait["outcome"], error: unknown): never => {
      ended(outcome);
      throw error;
    };
    const timedOut = () =>
      new SandboxNotRunningError(this.#record, {
        cause: new SandboxError(
          `sandbox ${this.id} (${this.#record.state}) did not return to running within ${this.#pauseResumeTimeoutMs}ms`,
          { cause },
        ),
      });
    const poll = async (): Promise<void> => {
      try {
        await this.#readRecord(waitSignal);
      } catch (error) {
        if (signal?.aborted) return fail("aborted", signal.reason);
        if (timeout.signal.aborted) return fail("timeout", timedOut());
        return fail("failed", error);
      }
    };

    try {
      for (;;) {
        for (let attempt = 0; this.#record.state !== "running"; attempt++) {
          if (signal?.aborted) return fail("aborted", signal.reason);
          if (isTerminal(this.#record.state)) {
            return fail("not_running", new SandboxNotRunningError(this.#record, { cause }));
          }
          // A settled pause has no resume in flight (a resume moves the record to `resuming`),
          // so waiting would only run out the clock.
          if (!isInPauseResumeCycle(this.#record.state) || this.#record.state === "paused") {
            return fail("not_running", new SandboxNotRunningError(this.#record, { cause }));
          }
          const left = deadline - Date.now();
          if (left <= 0 || timeout.signal.aborted) return fail("timeout", timedOut());
          // The last poll lands on the deadline itself, so a record that turns `running` late
          // inside the budget is still seen.
          const delay = Math.min(left, READY_POLL_MAX_MS, READY_POLL_BASE_MS * 2 ** attempt);
          try {
            await sleep(delay, waitSignal);
          } catch (error) {
            if (signal?.aborted) return fail("aborted", signal.reason);
            return fail("timeout", timedOut());
          }
          await poll();
        }
        // The resume lands on another host as often as not; pooled connections point at the old one.
        this.#client.redial();
        try {
          waitSignal.throwIfAborted();
          await this.#raceAbort(
            this.#waitUntilReady(cutoff - Date.now(), waitSignal, cutoff),
            waitSignal,
          );
          waitSignal.throwIfAborted();
          if (Date.now() >= cutoff) throw new SandboxError("pause-resume wait expired");
        } catch (error) {
          if (signal?.aborted) return fail("aborted", signal.reason);
          if (timeout.signal.aborted || Date.now() >= cutoff) {
            if (this.#record.state !== "running") return fail("timeout", timedOut());
            const unreachable = new Error(
              `sandbox ${this.id} (${this.#record.state}) not reachable within ${this.#pauseResumeTimeoutMs}ms`,
              { cause: error },
            );
            return fail(
              "timeout",
              new SandboxTransportError("GET", `${this.#client.baseUrl}/health`, 1, unreachable),
            );
          }
          // `running` with no healthy agent inside the budget is a transport failure, not a state one.
          return fail(error instanceof SandboxTransportError ? "timeout" : "not_running", error);
        }
        // `waitUntilReady` returns quietly for a record that was paused again mid-wait.
        if (this.#record.state === "running") break;
      }
      ended("running");
    } finally {
      clearTimeout(timer);
    }
  }

  async #raceAbort<T>(read: Promise<T>, signal: AbortSignal): Promise<T> {
    let rejectAbort: ((reason: unknown) => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () => rejectAbort?.(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    try {
      return await Promise.race([read, aborted]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  async #readRecord(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const record = await this.#raceAbort(this.#cp.get(this.id), signal);
    signal.throwIfAborted();
    this.#record = record;
  }

  async #waitUntilReady(
    timeoutMs: number,
    signal?: AbortSignal,
    cutoff = Date.now() + timeoutMs,
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      try {
        await this.#client.health({
          timeoutMs: Math.min(10_000, Math.max(1, cutoff - Date.now())),
          signal,
        });
        signal?.throwIfAborted();
        return;
      } catch (error) {
        if (isAbort(error, signal)) throw error;
        if (!isNotReadyYet(error)) throw error;
        lastError = error;
        if (isSandboxGone(error)) this.#client.redial();
      }
      if (signal) await this.#readRecord(signal);
      else await this.refresh();
      if (isTerminal(this.#record.state))
        throw new SandboxNotRunningError(this.#record, { cause: lastError });
      // Paused mid-attach: like a record that was paused to begin with, there is no agent to wait for.
      if (isPaused(this.#record.state)) return;
      const delay = Math.min(READY_POLL_MAX_MS, READY_POLL_BASE_MS * 2 ** attempt);
      if (Date.now() + delay > cutoff) {
        throw new SandboxTransportError(
          "GET",
          `${this.#client.baseUrl}/health`,
          attempt + 1,
          new Error(
            `sandbox ${this.id} (${this.#record.state}) not reachable within ${timeoutMs}ms`,
            {
              cause: lastError,
            },
          ),
        );
      }
      await sleep(delay, signal);
    }
  }
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
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

function isPaused(state: string): boolean {
  return state === "paused" || state === "pausing";
}

/** A state the control plane passes through between `running` and `running` again. */
function isInPauseResumeCycle(state: string): boolean {
  return isPaused(state) || state === "resuming" || state === "starting";
}

function isTerminal(state: string): boolean {
  return state === "deleting" || state === "deleted" || state === "failed";
}

function isRecheckCause(error: unknown): error is RecheckCause {
  return error instanceof SandboxTransportError || isSandboxGone(error);
}

/**
 * DNS/TLS/connection failures while the VM boots, the agent's own 503 `unavailable`, or
 * the previous VM's retired socket still answering on the host a resume is leaving.
 */
function isNotReadyYet(error: unknown): boolean {
  return (
    error instanceof SandboxTransportError ||
    (error instanceof SandboxApiError && error.code === "unavailable") ||
    isSandboxGone(error)
  );
}

/**
 * `TokenSource` asks on first use, at its refresh point and after
 * `token_expired`. First use reads the shared token as it stands then, not the
 * one attach saw, unless the cache evicted it; later asks take a newer shared
 * token if another handle already replaced the one this handle holds, and mint
 * otherwise.
 */
function sharedTokenProvider(
  tokens: SandboxTokens,
  id: string,
  attached: SharedToken,
): TokenProvider {
  let held: string | undefined;
  return async () => {
    const next =
      held === undefined
        ? (await tokens.reuse(id, attached)).token
        : await tokens.refresh(id, held);
    held = next.token;
    return next;
  };
}
