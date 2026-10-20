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
import { SandboxApiError, SandboxError, SandboxTransportError } from "./errors.js";
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

export interface SandboxOptions {
  /** How long `create`/`connect` wait for `GET /health` to succeed. Default 120s. */
  readyTimeoutMs?: number;
  /** Maps the minted hostname to the agent base URL. Default `https://<hostname>/v1`. */
  agentBaseUrl?: (hostname: string) => string;
  client?: Omit<SandboxClientOptions, "baseUrl" | "hostname" | "token" | "tokenProvider">;
}

const DEFAULT_READY_TIMEOUT_MS = 120_000;
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

  private constructor(cp: SandboxControlPlane, record: SandboxRecord, client: SandboxClient) {
    this.cp = cp;
    this.id = record.id;
    this.record = record;
    this.client = client;
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
    const sandbox = new Sandbox(cp, record, client);
    // A pausing or paused VM is unreachable until `resume()`, so there is no agent to wait for.
    if (record.state !== "paused" && record.state !== "pausing") {
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
      replay: (error) => error.method !== "EXEC",
    });
  }

  startProcess(
    id: string,
    spec: ProcessSpecInput,
    options?: RequestOptions,
  ): Promise<StartProcessResult> {
    return this.withRecheck(() => this.client.startProcess(id, spec, options));
  }

  getProcess(id: string, options?: RequestOptions): Promise<Process> {
    return this.withRecheck(() => this.client.getProcess(id, options));
  }

  listProcesses(options?: RequestOptions): Promise<Process[]> {
    return this.withRecheck(() => this.client.listProcesses(options));
  }

  killProcess(id: string, options?: RequestOptions): Promise<void> {
    return this.withRecheck(() => this.client.killProcess(id, options));
  }

  exposePort(port: number, options?: RequestOptions): Promise<ExposePortResult> {
    return this.withRecheck(() => this.client.exposePort(port, options));
  }

  listPorts(options?: RequestOptions): Promise<PortExposure[]> {
    return this.withRecheck(() => this.client.listPorts(options));
  }

  unexposePort(port: number, options?: RequestOptions): Promise<void> {
    return this.withRecheck(() => this.client.unexposePort(port, options));
  }

  /** See `SandboxClient.attachDisk`: the attachment does not survive `pause()`/`resume()`. */
  attachDisk(input: DiskAttachInput, options?: RequestOptions): Promise<AttachDiskResult> {
    return this.withRecheck(() => this.client.attachDisk(input, options), { replay: false });
  }

  listDisks(options?: RequestOptions): Promise<Disk[]> {
    return this.withRecheck(() => this.client.listDisks(options));
  }

  detachDisk(slot: number, options?: RequestOptions): Promise<Disk> {
    return this.withRecheck(() => this.client.detachDisk(slot, options), { replay: false });
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
        if (!(error instanceof SandboxTransportError) || resumed) throw error;
        if (error.cause instanceof IdleTimeoutError) throw error;
        await this.recheck(error);
        resumed = true;
      }
    }
  }

  readFile(path: string, options?: RequestOptions): Promise<FileContent> {
    return this.withRecheck(() => this.client.readFile(path, options));
  }

  readFileStream(path: string, options?: StreamRequestOptions): Promise<FileStream> {
    return this.withRecheck(() => this.client.readFileStream(path, options));
  }

  /** A `ReadableStream` body is consumed by the first attempt, so it is never replayed. */
  writeFile(path: string, body: WriteFileBody, options?: WriteFileOptions): Promise<FileInfo> {
    return this.withRecheck(() => this.client.writeFile(path, body, options), {
      replay: !(body instanceof ReadableStream),
    });
  }

  private async withRecheck<T>(
    call: () => Promise<T>,
    { replay = true }: { replay?: boolean | ((error: SandboxTransportError) => boolean) } = {},
  ): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (!(error instanceof SandboxTransportError)) throw error;
      await this.recheck(error);
      if (!(typeof replay === "function" ? replay(error) : replay)) throw error;
      return call();
    }
  }

  /** Resolves when the control plane still says `running`; throws `SandboxNotRunningError` otherwise. */
  private async recheck(cause: SandboxTransportError): Promise<void> {
    await this.refresh();
    if (this.record.state !== "running") throw new SandboxNotRunningError(this.record, { cause });
  }

  private async waitUntilReady(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    for (let attempt = 0; ; attempt++) {
      try {
        await this.client.health({ timeoutMs: Math.min(10_000, timeoutMs) });
        return;
      } catch (error) {
        if (!isNotReadyYet(error)) throw error;
        lastError = error;
      }
      await this.refresh();
      if (isTerminal(this.record.state))
        throw new SandboxNotRunningError(this.record, { cause: lastError });
      const delay = Math.min(READY_POLL_MAX_MS, READY_POLL_BASE_MS * 2 ** attempt);
      if (Date.now() + delay > deadline) {
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
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

function isTerminal(state: string): boolean {
  return state === "deleting" || state === "deleted" || state === "failed";
}

/** DNS/TLS/connection failures while the VM boots, or the agent's own 503 `unavailable`. */
function isNotReadyYet(error: unknown): boolean {
  return (
    error instanceof SandboxTransportError ||
    (error instanceof SandboxApiError && error.code === "unavailable")
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
