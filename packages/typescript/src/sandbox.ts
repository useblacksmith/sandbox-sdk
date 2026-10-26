import {
  IdleTimeoutError,
  SandboxClient,
  newExecProcessId,
  type SandboxClientOptions,
} from "./client.js";
import type {
  MintedToken,
  SandboxControlPlane,
  SandboxCreateOptions,
  SandboxRecord,
} from "./control-plane.js";
import { SandboxApiError, SandboxError, SandboxTransportError, isSandboxGone } from "./errors.js";
import { sandboxTokens, type SandboxTokens, type SharedToken } from "./token-cache.js";
import type { Disk, ExecResponse, FileInfo, PortExposure, Process } from "./generated/types.gen.js";
import type { TokenProvider } from "./token.js";
import type {
  AttachDiskResult,
  DiskAttachInput,
  ExposePortResult,
  FileContent,
  FileStream,
  OutputChunk,
  ProcessSpecInput,
  ExecOptions,
  RequestOptions,
  StartProcessResult,
  StreamOutputOptions,
  StreamRequestOptions,
  WriteFileBody,
  WriteFileOptions,
} from "./types.js";

/** A failure that warrants asking the control plane what the sandbox is doing. */
type RecheckCause = SandboxTransportError | SandboxApiError;

/** The control plane reports the sandbox is not `running`, so the agent is unreachable by design. */
export class SandboxNotRunningError extends SandboxError {
  readonly id: string;
  readonly state: string;

  constructor(record: SandboxRecord, options?: ErrorOptions) {
    super(`sandbox ${record.id} is ${record.state}, not running`, options);
    this.id = record.id;
    this.state = record.state;
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
   * `running`: the call replays; `not_running`: the cycle ended in a terminal state;
   * `timeout`: it outlived `pauseResumeTimeoutMs`; `aborted`: the caller's signal fired;
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
   * `paused`, `resuming`, `starting`) waits for `running` and a healthy agent before failing
   * with `SandboxNotRunningError`. Default 30s, the cycle SLO: production pauses settle in
   * p99 14s and resumes report running in p99 6.4s (2026-10).
   */
  pauseResumeTimeoutMs?: number;
  /** Called once per wait with how it ended, so the caller can chart the cycle SLO. */
  onPauseResumeWait?: (wait: PauseResumeWait) => void;
  /** Maps the minted hostname to the agent base URL. Default `https://<hostname>/v1`. */
  agentBaseUrl?: (hostname: string) => string;
  client?: Omit<SandboxClientOptions, "baseUrl" | "hostname" | "token" | "tokenProvider">;
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

/**
 * One sandbox seen through both clients: lifecycle via `SandboxControlPlane`,
 * everything else via `SandboxClient`. Agent calls that fail at the transport
 * level re-check the control plane: a sandbox that is not `running` raises
 * `SandboxNotRunningError`; a running one gets the call retried once.
 */
export class Sandbox {
  readonly id: string;
  readonly client: SandboxClient;
  private readonly cp: SandboxControlPlane;
  private record: SandboxRecord;
  private readonly pauseResumeTimeoutMs: number;
  private readonly onPauseResumeWait: ((wait: PauseResumeWait) => void) | undefined;

  private constructor(
    cp: SandboxControlPlane,
    record: SandboxRecord,
    client: SandboxClient,
    options: SandboxOptions,
  ) {
    this.cp = cp;
    this.id = record.id;
    this.record = record;
    this.client = client;
    this.pauseResumeTimeoutMs = options.pauseResumeTimeoutMs ?? DEFAULT_PAUSE_RESUME_TIMEOUT_MS;
    this.onPauseResumeWait = options.onPauseResumeWait;
  }

  static async create(
    cp: SandboxControlPlane,
    createOptions: SandboxCreateOptions,
    options: SandboxOptions = {},
  ): Promise<Sandbox> {
    const record = await cp.create(createOptions);
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
      return await Sandbox.attach(cp, record, options);
    } catch (error) {
      // The caller never gets a handle, so a freshly allocated VM would leak. A keyed create
      // may have replayed a record another caller already holds, so leave it alone.
      if (createOptions.idempotencyKey === undefined) {
        await cp.delete(record.id).catch(() => undefined);
      }
      throw error;
    }
  }

  static async connect(
    cp: SandboxControlPlane,
    id: string,
    options: SandboxOptions = {},
  ): Promise<Sandbox> {
    return Sandbox.attach(cp, await cp.get(id), options);
  }

  private static async attach(
    cp: SandboxControlPlane,
    record: SandboxRecord,
    options: SandboxOptions,
  ): Promise<Sandbox> {
    // The control plane still mints tokens for a `deleting` record whose VM is already gone.
    if (isTerminal(record.state)) throw new SandboxNotRunningError(record);
    const tokens = sandboxTokens(cp);
    const attached = record.token
      ? tokens.remember(record.id, record.token)
      : await tokens.reuse(record.id);
    const toBaseUrl = options.agentBaseUrl ?? ((hostname: string) => `https://${hostname}/v1`);
    const client = new SandboxClient({
      ...options.client,
      baseUrl: toBaseUrl(attached.token.hostname),
      tokenProvider: sharedTokenProvider(tokens, record.id, attached),
    });
    const sandbox = new Sandbox(cp, record, client, options);
    // A pausing or paused VM is unreachable until `resume()`, so there is no agent to wait for.
    if (!isPaused(record.state)) {
      await sandbox.waitUntilReady(options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
    }
    return sandbox;
  }

  /** Last state seen from the control plane; `refresh()` updates it. */
  get state(): SandboxRecord["state"] {
    return this.record.state;
  }

  async refresh(): Promise<SandboxRecord> {
    this.record = await this.cp.get(this.id);
    return this.record;
  }

  async pause(): Promise<SandboxRecord> {
    this.record = await this.cp.pause(this.id);
    return this.record;
  }

  async resume(): Promise<SandboxRecord> {
    this.record = await this.cp.resume(this.id);
    return this.record;
  }

  async delete(): Promise<SandboxRecord> {
    this.record = await this.cp.delete(this.id);
    return this.record;
  }

  /**
   * Replay-safe: the process id is fixed before the first attempt and the client
   * leaves the process in place after a transport failure, so the replay finds
   * it and the command runs once. The call's own deadline is final.
   */
  exec(spec: ProcessSpecInput, options: ExecOptions = {}): Promise<ExecResponse> {
    const processId = options.processId ?? newExecProcessId();
    return this.withRecheck(() => this.client.exec(spec, { ...options, processId }), {
      replay: (error) => !(error instanceof SandboxTransportError) || error.method !== "EXEC",
      signal: options.signal,
    });
  }

  startProcess(
    id: string,
    spec: ProcessSpecInput,
    options?: RequestOptions,
  ): Promise<StartProcessResult> {
    return this.withRecheck(() => this.client.startProcess(id, spec, options), {
      signal: options?.signal,
    });
  }

  getProcess(id: string, options?: RequestOptions): Promise<Process> {
    return this.withRecheck(() => this.client.getProcess(id, options), { signal: options?.signal });
  }

  listProcesses(options?: RequestOptions): Promise<Process[]> {
    return this.withRecheck(() => this.client.listProcesses(options), { signal: options?.signal });
  }

  killProcess(id: string, options?: RequestOptions): Promise<void> {
    return this.withRecheck(() => this.client.killProcess(id, options), {
      signal: options?.signal,
    });
  }

  exposePort(port: number, options?: RequestOptions): Promise<ExposePortResult> {
    return this.withRecheck(() => this.client.exposePort(port, options), {
      signal: options?.signal,
    });
  }

  listPorts(options?: RequestOptions): Promise<PortExposure[]> {
    return this.withRecheck(() => this.client.listPorts(options), { signal: options?.signal });
  }

  unexposePort(port: number, options?: RequestOptions): Promise<void> {
    return this.withRecheck(() => this.client.unexposePort(port, options), {
      signal: options?.signal,
    });
  }

  /** See `SandboxClient.attachDisk`: the attachment does not survive `pause()`/`resume()`. */
  attachDisk(input: DiskAttachInput, options?: RequestOptions): Promise<AttachDiskResult> {
    return this.withRecheck(() => this.client.attachDisk(input, options), {
      replay: false,
      signal: options?.signal,
    });
  }

  listDisks(options?: RequestOptions): Promise<Disk[]> {
    return this.withRecheck(() => this.client.listDisks(options), { signal: options?.signal });
  }

  detachDisk(slot: number, options?: RequestOptions): Promise<Disk> {
    return this.withRecheck(() => this.client.detachDisk(slot, options), {
      replay: false,
      signal: options?.signal,
    });
  }

  /**
   * Like `SandboxClient.streamOutput`, but a transport failure mid-stream
   * re-checks the control plane and, if still running, resumes once from the
   * last delivered offsets.
   */
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
        for await (const chunk of this.client.streamOutput(id, {
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
        await this.recheck(error, options.signal);
      }
    }
  }

  readFile(path: string, options?: RequestOptions): Promise<FileContent> {
    return this.withRecheck(() => this.client.readFile(path, options), { signal: options?.signal });
  }

  readFileStream(path: string, options?: StreamRequestOptions): Promise<FileStream> {
    return this.withRecheck(() => this.client.readFileStream(path, options), {
      signal: options?.signal,
    });
  }

  /** A `ReadableStream` body is consumed by the first attempt, so it is never replayed. */
  writeFile(path: string, body: WriteFileBody, options?: WriteFileOptions): Promise<FileInfo> {
    return this.withRecheck(() => this.client.writeFile(path, body, options), {
      replay: !(body instanceof ReadableStream),
      signal: options?.signal,
    });
  }

  private async withRecheck<T>(
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
        await this.recheck(error, signal);
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
  private async recheck(cause: RecheckCause, signal?: AbortSignal): Promise<void> {
    if (signal) await this.readRecord(signal);
    else await this.refresh();
    if (isInPauseResumeCycle(this.record.state)) {
      return this.waitThroughPauseResume(cause, signal);
    }
    if (this.record.state !== "running") throw new SandboxNotRunningError(this.record, { cause });
    if (cause instanceof SandboxApiError) this.client.redial();
  }

  /**
   * Polls the record while a pause → resume cycle runs, then waits for the agent on the host
   * the resume landed on; the replay follows. A cycle that lands back in `pausing`/`paused`
   * before the agent answers is polled again. A final poll can start at the deadline and
   * use up to 250ms more; all reads and health checks share that cutoff. A terminal state,
   * the caller's `signal` or a failed poll ends it sooner. Every exit reports to `onPauseResumeWait`.
   */
  private async waitThroughPauseResume(cause: RecheckCause, signal?: AbortSignal): Promise<void> {
    const from = this.record.state;
    const started = Date.now();
    const deadline = started + this.pauseResumeTimeoutMs;
    const cutoff = deadline + READY_POLL_BASE_MS;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), Math.max(0, cutoff - Date.now()));
    const waitSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    const ended = (outcome: PauseResumeWait["outcome"]) =>
      this.onPauseResumeWait?.({
        id: this.id,
        from,
        state: this.record.state,
        outcome,
        waitedMs: Date.now() - started,
      });
    const fail = (outcome: PauseResumeWait["outcome"], error: unknown): never => {
      ended(outcome);
      throw error;
    };
    const timedOut = () =>
      new SandboxNotRunningError(this.record, {
        cause: new SandboxError(
          `sandbox ${this.id} (${this.record.state}) did not return to running within ${this.pauseResumeTimeoutMs}ms`,
          { cause },
        ),
      });
    const poll = async (): Promise<void> => {
      try {
        await this.readRecord(waitSignal);
      } catch (error) {
        if (signal?.aborted) return fail("aborted", signal.reason);
        if (timeout.signal.aborted) return fail("timeout", timedOut());
        return fail("failed", error);
      }
    };

    try {
      for (;;) {
        for (let attempt = 0; this.record.state !== "running"; attempt++) {
          if (signal?.aborted) return fail("aborted", signal.reason);
          if (isTerminal(this.record.state)) {
            return fail("not_running", new SandboxNotRunningError(this.record, { cause }));
          }
          if (!isInPauseResumeCycle(this.record.state)) {
            return fail("not_running", new SandboxNotRunningError(this.record, { cause }));
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
        this.client.redial();
        try {
          waitSignal.throwIfAborted();
          await this.raceAbort(
            this.waitUntilReady(cutoff - Date.now(), waitSignal, cutoff),
            waitSignal,
          );
          waitSignal.throwIfAborted();
          if (Date.now() >= cutoff) throw new SandboxError("pause-resume wait expired");
        } catch (error) {
          if (signal?.aborted) return fail("aborted", signal.reason);
          if (timeout.signal.aborted || Date.now() >= cutoff) {
            if (this.record.state !== "running") return fail("timeout", timedOut());
            const unreachable = new Error(
              `sandbox ${this.id} (${this.record.state}) not reachable within ${this.pauseResumeTimeoutMs}ms`,
              { cause: error },
            );
            return fail(
              "timeout",
              new SandboxTransportError("GET", `${this.client.baseUrl}/health`, 1, unreachable),
            );
          }
          // `running` with no healthy agent inside the budget is a transport failure, not a state one.
          return fail(error instanceof SandboxTransportError ? "timeout" : "not_running", error);
        }
        // `waitUntilReady` returns quietly for a record that was paused again mid-wait.
        if (this.record.state === "running") break;
      }
      ended("running");
    } finally {
      clearTimeout(timer);
    }
  }

  private async raceAbort<T>(read: Promise<T>, signal: AbortSignal): Promise<T> {
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

  private async readRecord(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const record = await this.raceAbort(this.cp.get(this.id), signal);
    signal.throwIfAborted();
    this.record = record;
  }

  private async waitUntilReady(
    timeoutMs: number,
    signal?: AbortSignal,
    cutoff = Date.now() + timeoutMs,
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      try {
        await this.client.health({
          timeoutMs: Math.min(10_000, Math.max(1, cutoff - Date.now())),
          signal,
        });
        signal?.throwIfAborted();
        return;
      } catch (error) {
        if (isAbort(error, signal)) throw error;
        if (!isNotReadyYet(error)) throw error;
        lastError = error;
        if (isSandboxGone(error)) this.client.redial();
      }
      if (signal) await this.readRecord(signal);
      else await this.refresh();
      if (isTerminal(this.record.state))
        throw new SandboxNotRunningError(this.record, { cause: lastError });
      // Paused mid-attach: like a record that was paused to begin with, there is no agent to wait for.
      if (isPaused(this.record.state)) return;
      const delay = Math.min(READY_POLL_MAX_MS, READY_POLL_BASE_MS * 2 ** attempt);
      if (Date.now() + delay > cutoff) {
        throw new SandboxTransportError(
          "GET",
          `${this.client.baseUrl}/health`,
          attempt + 1,
          new Error(
            `sandbox ${this.id} (${this.record.state}) not reachable within ${timeoutMs}ms`,
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
