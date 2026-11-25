/**
 * PROVISIONAL. The control-plane API (`/api/v1/sandboxes` on the Blacksmith
 * backend) is not signed off; this file is coded against its draft and is the
 * only part of the SDK expected to change when that API lands. Nothing here
 * talks to the agent.
 */
import * as z from "zod";
import { ControlPlaneError, SandboxError, SandboxTransportError } from "../errors.js";
import type {
  ImageSnapshotCreateOptions,
  ImageSnapshotListOptions,
  ImageSnapshotRecord,
  SandboxCreateOptions,
  SandboxFailure,
  SandboxListOptions,
  SandboxRecord,
  Snapshots,
} from "../resources.js";
import type { AgentToken } from "./token.js";

const SandboxFailureResponse = z
  .object({
    source: z.string(),
    code: z.string(),
    message: z.string(),
    attempts: z.number().int().nonnegative(),
    distinct_nodes: z.number().int().nonnegative(),
    occurred_at: z.string(),
  })
  .transform((failure) => ({
    source: failure.source,
    code: failure.code,
    message: failure.message,
    attempts: failure.attempts,
    distinctNodes: failure.distinct_nodes,
    occurredAt: failure.occurred_at,
  }));

const SandboxResponse = z.object({
  id: z.string(),
  status: z.string(),
  created_at: z.unknown().optional(),
  hostname: z.string().optional().catch(undefined),
  hostnames: z.array(z.string()).optional().catch(undefined),
  workload: z.string().optional().catch(undefined),
  tenant: z.string().optional().catch(undefined),
  image: z.string().optional().catch(undefined),
  base_image: z.string().optional().catch(undefined),
  last_error: z.string().optional().catch(undefined),
});

export interface CreatedSandboxRecord extends SandboxRecord {
  /** The first agent token, so no mint round-trip is needed. */
  token?: MintedToken;
  /** The Idempotency-Key matched an earlier create. */
  replayed?: boolean;
}

export interface MintedToken extends AgentToken {
  hostname: string;
}

export interface SandboxControlPlane {
  create(options: SandboxCreateOptions): Promise<CreatedSandboxRecord>;
  get(id: string): Promise<SandboxRecord>;
  list(options?: SandboxListOptions): Promise<SandboxRecord[]>;
  pause(id: string): Promise<SandboxRecord>;
  resume(id: string): Promise<SandboxRecord>;
  delete(id: string): Promise<SandboxRecord>;
  mintToken(id: string): Promise<MintedToken>;
  /** `/api/v1/images/…`: things a sandbox can boot from. */
  readonly images: { readonly snapshots: Snapshots };
}

const TerminalFailureDetails = z.object({
  sandbox_id: z.string(),
  last_error: z.string().nullable(),
});

export function terminalFailureRecord(error: unknown): SandboxRecord | undefined {
  if (
    !(error instanceof ControlPlaneError) ||
    error.status !== 409 ||
    error.code !== "invalid_state" ||
    error.sandboxStatus !== "failed"
  ) {
    return undefined;
  }
  const parsed = TerminalFailureDetails.safeParse(error.details);
  if (!parsed.success) return undefined;
  return {
    id: parsed.data.sandbox_id,
    state: "failed",
    createdAt: new Date(NaN),
    lastError:
      parsed.data.last_error === null ? error.message : parseSandboxFailure(parsed.data.last_error),
    raw: { id: parsed.data.sandbox_id, status: "failed", last_error: parsed.data.last_error },
  };
}

export interface HttpControlPlaneClientOptions {
  /** Org API key; sent only to the control plane, never to an agent. */
  apiKey: string;
  /** Backend origin. Default `https://api.blacksmith.sh`. */
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = "https://api.blacksmith.sh";
const DEFAULT_TIMEOUT_MS = 30_000;

export class HttpControlPlaneClient implements SandboxControlPlane {
  readonly baseUrl: string;
  readonly images: { readonly snapshots: Snapshots };
  private readonly apiKey: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(options: HttpControlPlaneClientOptions) {
    if (!options.apiKey) throw new TypeError("apiKey is required");
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.images = { snapshots: new HttpImageSnapshots((m, p, j) => this.request(m, p, j)) };
  }

  async create(options: SandboxCreateOptions): Promise<CreatedSandboxRecord> {
    const headers: Record<string, string> = {};
    if (options.idempotencyKey !== undefined) headers["Idempotency-Key"] = options.idempotencyKey;
    const { body, response } = await this.send(
      "POST",
      "/api/v1/sandboxes",
      toCreateBody(options),
      headers,
    );
    const record: CreatedSandboxRecord = toRecord(body);
    if (body.token !== undefined) record.token = toMintedToken(asObject(body.token));
    record.replayed = response.headers.get("Idempotent-Replayed") === "true";
    return record;
  }

  async get(id: string): Promise<SandboxRecord> {
    return toRecord(await this.request("GET", `/api/v1/sandboxes/${encodeURIComponent(id)}`));
  }

  async list(options: SandboxListOptions = {}): Promise<SandboxRecord[]> {
    const query = new URLSearchParams();
    if (options.state !== undefined) query.set("status", options.state);
    if (options.label !== undefined) query.set("label", options.label);
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    const search = query.size === 0 ? "" : `?${query}`;
    const body = await this.request("GET", `/api/v1/sandboxes${search}`);
    const items = body.sandboxes;
    if (!Array.isArray(items))
      throw new SandboxError("control plane list response has no sandboxes[]");
    return items.map((item) => toRecord(asObject(item)));
  }

  async pause(id: string): Promise<SandboxRecord> {
    return toRecord(
      await this.request("POST", `/api/v1/sandboxes/${encodeURIComponent(id)}/pause`),
    );
  }

  async resume(id: string): Promise<SandboxRecord> {
    return toRecord(
      await this.request("POST", `/api/v1/sandboxes/${encodeURIComponent(id)}/resume`),
    );
  }

  async delete(id: string): Promise<SandboxRecord> {
    return toRecord(await this.request("DELETE", `/api/v1/sandboxes/${encodeURIComponent(id)}`));
  }

  async mintToken(id: string): Promise<MintedToken> {
    return toMintedToken(
      await this.request("POST", `/api/v1/sandboxes/${encodeURIComponent(id)}/tokens`, {}),
    );
  }

  private async request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    json?: Record<string, unknown>,
    extraHeaders: Record<string, string> = {},
  ): Promise<Record<string, unknown>> {
    return (await this.send(method, path, json, extraHeaders)).body;
  }

  private async send(
    method: "GET" | "POST" | "DELETE",
    path: string,
    json?: Record<string, unknown>,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ body: Record<string, unknown>; response: Response }> {
    const url = this.baseUrl + path;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
      ...extraHeaders,
    };
    if (json !== undefined) headers["Content-Type"] = "application/json";

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: json === undefined ? undefined : JSON.stringify(json),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new SandboxTransportError(method, url, 1, error);
    }

    const text = await response.text();
    if (!response.ok) {
      const retryAfter = response.headers.get("Retry-After");
      const retryAfterMs =
        retryAfter !== null && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : undefined;
      throw errorFromResponse(response.status, text, retryAfterMs);
    }
    const body = text.trim() === "" ? {} : asObject(JSON.parse(text));
    return { body, response };
  }
}

type RequestFn = (
  method: "GET" | "POST" | "DELETE",
  path: string,
  json?: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

class HttpImageSnapshots implements Snapshots {
  constructor(private readonly request: RequestFn) {}

  async create(options: ImageSnapshotCreateOptions): Promise<ImageSnapshotRecord> {
    if (!options.sandbox) throw new TypeError("sandbox is required");
    const body: Record<string, unknown> = { sandbox: options.sandbox };
    if (options.ttlSeconds !== undefined) body.ttl_seconds = options.ttlSeconds;
    return toImageSnapshot(await this.request("POST", "/api/v1/images/snapshots", body));
  }

  async get(id: string): Promise<ImageSnapshotRecord> {
    return toImageSnapshot(
      await this.request("GET", `/api/v1/images/snapshots/${encodeURIComponent(id)}`),
    );
  }

  async list(options: ImageSnapshotListOptions = {}): Promise<ImageSnapshotRecord[]> {
    const query = new URLSearchParams();
    if (options.state !== undefined) query.set("status", options.state);
    if (options.sandbox !== undefined) query.set("sandbox", options.sandbox);
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    const search = query.size === 0 ? "" : `?${query}`;
    const body = await this.request("GET", `/api/v1/images/snapshots${search}`);
    const items = body.snapshots;
    if (!Array.isArray(items))
      throw new SandboxError("control plane list response has no snapshots[]");
    return items.map((item) => toImageSnapshot(asObject(item)));
  }

  async delete(id: string): Promise<ImageSnapshotRecord> {
    return toImageSnapshot(
      await this.request("DELETE", `/api/v1/images/snapshots/${encodeURIComponent(id)}`),
    );
  }
}

function toImageSnapshot(raw: Record<string, unknown>): ImageSnapshotRecord {
  const { id, sandbox_id: sandboxId, status: state, region, arch } = raw;
  const expiresAt = parseDate(raw.expires_at);
  const createdAt = parseDate(raw.created_at);
  if (
    typeof id !== "string" ||
    typeof sandboxId !== "string" ||
    typeof state !== "string" ||
    typeof region !== "string" ||
    typeof arch !== "string" ||
    !expiresAt ||
    !createdAt
  ) {
    throw new SandboxError("control plane image snapshot response is missing required fields");
  }
  const record: ImageSnapshotRecord = {
    id,
    sandboxId,
    state,
    region,
    arch,
    expiresAt,
    createdAt,
    raw,
  };
  if (typeof raw.size_bytes === "number") record.sizeBytes = raw.size_bytes;
  if (typeof raw.last_error === "string") record.lastError = raw.last_error;
  return record;
}

/** The backend's rules for `workload` and `tenant`, checked here so a bad value fails before the request. */
const MAX_ATTRIBUTE_LENGTH = 1024;
const WORKLOAD_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const TENANT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function checkAttribute(name: string, value: string, pattern: RegExp, letters: string): void {
  if (value.length > MAX_ATTRIBUTE_LENGTH) {
    throw new TypeError(`${name} is longer than ${MAX_ATTRIBUTE_LENGTH} characters`);
  }
  if (!pattern.test(value)) {
    throw new TypeError(
      `${name} must be ${letters}, digits, ".", "_" and "-", starting with a letter or digit`,
    );
  }
}

function toCreateBody(options: SandboxCreateOptions): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (options.image === undefined) throw new TypeError("image is required");
  body.image = options.image;
  if (!options.workload) throw new TypeError("workload is required");
  checkAttribute("workload", options.workload, WORKLOAD_PATTERN, "lowercase letters");
  body.workload = options.workload;
  if (options.tenant !== undefined) {
    checkAttribute("tenant", options.tenant, TENANT_PATTERN, "letters");
    body.tenant = options.tenant;
  }
  if (options.arch !== undefined) body.arch = options.arch;
  if (options.vcpu !== undefined) body.vcpu = options.vcpu;
  if (options.env !== undefined) body.env = options.env;
  if (options.labels !== undefined) body.labels = options.labels;
  if (options.idleTimeoutSeconds !== undefined)
    body.idle_timeout_seconds = options.idleTimeoutSeconds;
  if (options.idleDeleteTimeoutSeconds !== undefined)
    body.idle_delete_timeout_seconds = options.idleDeleteTimeoutSeconds;
  if (options.ttlSeconds !== undefined) body.ttl_seconds = options.ttlSeconds;
  if (options.metadata !== undefined) body.metadata = options.metadata;
  if (options.waitSeconds !== undefined) body.wait = options.waitSeconds;
  return body;
}

function toRecord(raw: Record<string, unknown>): SandboxRecord {
  const parsed = SandboxResponse.safeParse(raw);
  if (!parsed.success) {
    throw new SandboxError("invalid control plane sandbox response", { cause: parsed.error });
  }
  const data = parsed.data;
  const record: SandboxRecord = {
    id: data.id,
    state: data.status,
    createdAt: parseDate(data.created_at) ?? new Date(NaN),
    raw,
  };
  if (data.hostname !== undefined) record.hostname = data.hostname;
  if (data.workload !== undefined) record.workload = data.workload;
  if (data.tenant !== undefined) record.tenant = data.tenant;
  if (data.image !== undefined) record.image = data.image;
  else if (data.base_image !== undefined) record.image = data.base_image;
  if (data.hostnames !== undefined) record.hostnames = data.hostnames;
  if (data.last_error !== undefined) record.lastError = parseSandboxFailure(data.last_error);
  return record;
}

function parseSandboxFailure(raw: string): string | SandboxFailure {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return raw;
  }
  const parsed = SandboxFailureResponse.safeParse(decoded);
  return parsed.success ? parsed.data : raw;
}

function toMintedToken(raw: Record<string, unknown>): MintedToken {
  const token = raw.token;
  const expiresAt = parseDate(raw.expires_at);
  const hostname = raw.hostname;
  if (typeof token !== "string" || !expiresAt || typeof hostname !== "string") {
    throw new SandboxError("control plane token response is missing token, expires_at or hostname");
  }
  return { token, expiresAt, hostname };
}

function errorFromResponse(
  status: number,
  text: string,
  retryAfterMs: number | undefined,
): ControlPlaneError {
  try {
    const parsed = z
      .object({
        error: z.object({
          code: z.string(),
          message: z.string(),
          details: z.record(z.string(), z.unknown()).optional().catch(undefined),
          status: z.string().optional().catch(undefined),
        }),
      })
      .safeParse(JSON.parse(text));
    if (parsed.success) {
      const { error } = parsed.data;
      return new ControlPlaneError(
        status,
        error.code,
        error.message,
        error.details,
        error.status,
        retryAfterMs,
      );
    }
  } catch {
    // not JSON or not the envelope
  }
  const message = text.trim() === "" ? `HTTP ${status}` : `HTTP ${status}: ${text.slice(0, 200)}`;
  return new ControlPlaneError(
    status,
    `http_${status}`,
    message,
    { raw_body: text },
    undefined,
    retryAfterMs,
  );
}

function asObject(value: unknown): Record<string, unknown> {
  const parsed = z.record(z.string(), z.unknown()).safeParse(value);
  if (!parsed.success) {
    throw new SandboxError("control plane response is not a JSON object", { cause: parsed.error });
  }
  return parsed.data;
}

function parseDate(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
