import type { ErrorBody, ErrorCode } from "./generated/types.gen.js";

/** Base class for every error thrown by this SDK. */
export class SandboxError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * The agent answered with an error envelope. `code` is the only field to
 * branch on; `message` is human-readable and not stable.
 */
export class SandboxApiError extends SandboxError {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;
  readonly status: number;
  readonly requestId: string | undefined;

  constructor(status: number, body: ErrorBody, requestId?: string) {
    super(body.message);
    this.code = body.code;
    this.details = body.details;
    this.status = status;
    this.requestId = requestId;
  }

  static fromResponse(status: number, raw: string, requestId?: string): SandboxApiError {
    const envelope = parseEnvelope(raw);
    if (envelope) return new SandboxApiError(status, envelope, requestId);
    const message = raw.trim() === "" ? `HTTP ${status}` : `HTTP ${status}: ${raw.slice(0, 200)}`;
    return new SandboxApiError(
      status,
      { code: codeForStatus(status), message, details: { raw_body: raw } },
      requestId,
    );
  }
}

/**
 * The request never produced an HTTP response: DNS failure, TLS EOF while the
 * router has no socket for the sandbox yet, ECONNRESET, timeout. Callers
 * should re-check the sandbox state on the control plane before retrying.
 */
export class SandboxTransportError extends SandboxError {
  readonly method: string;
  readonly url: string;
  readonly attempts: number;

  constructor(method: string, url: string, attempts: number, cause: unknown) {
    super(`${method} ${url} failed after ${attempts} attempt(s): ${describeCause(cause)}`, {
      cause,
    });
    this.method = method;
    this.url = url;
    this.attempts = attempts;
  }
}

function parseEnvelope(raw: string): ErrorBody | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || !("error" in parsed)) return undefined;
  const inner: unknown = parsed.error;
  if (typeof inner !== "object" || inner === null) return undefined;
  if (!("code" in inner) || typeof inner.code !== "string") return undefined;
  const message = "message" in inner && typeof inner.message === "string" ? inner.message : "";
  const details =
    "details" in inner && typeof inner.details === "object" && inner.details !== null
      ? (inner.details as Record<string, unknown>)
      : undefined;
  return { code: inner.code as ErrorCode, message, details };
}

function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
      return "invalid_argument";
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 408:
      return "timeout";
    case 409:
      return "conflict";
    case 502:
      return "unavailable";
    case 503:
      return "unavailable";
    case 504:
      return "timeout";
    case 507:
      return "insufficient_storage";
    default:
      return "internal";
  }
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    const inner = cause.cause;
    if (inner instanceof Error && inner.message !== cause.message) {
      return `${cause.message} (${inner.message})`;
    }
    return cause.message;
  }
  return String(cause);
}

/** The control plane answered with `{"error": {"code", "message", "details", "status"}}`. */
export class ControlPlaneError extends SandboxError {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;
  /** The sandbox's current status, sent with `invalid_state`, e.g. `running` or `deleted`. */
  readonly sandboxStatus: string | undefined;
  /** From a 429's `Retry-After: <seconds>`. */
  readonly retryAfterMs: number | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
    sandboxStatus?: string,
    retryAfterMs?: number,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.sandboxStatus = sandboxStatus;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * `details` of a 429 `concurrency_limit`: one of the installation's sandbox caps is used up.
 * `scope: "sandbox"` is the control plane's concurrent-vCPU cap in `region` (paused sandboxes
 * do not count); `scope: "live"` is its cap on live sandboxes (paused included) plus snapshots
 * across all regions, so `requested` is 1 and `region` is where the refused object would have
 * lived; both carry `limit`/`inUse`. `scope: "org"` is the assigner's org budget (shared with
 * CI), which the control plane cannot count, so both are null. Pause or delete a sandbox,
 * delete a snapshot, or wait `retryAfterMs`; a retry loop will not help.
 */
export type ConcurrencyLimit =
  | {
      readonly scope: "sandbox" | "live";
      readonly limit: number;
      readonly inUse: number;
      readonly requested: number;
      readonly region: string;
    }
  | {
      readonly scope: "org";
      readonly limit: null;
      readonly inUse: null;
      readonly requested: number;
      readonly region: string;
    };

/** `undefined` for any other error, and for a `concurrency_limit` whose details drifted from the contract above. */
export function concurrencyLimit(error: unknown): ConcurrencyLimit | undefined {
  if (!(error instanceof ControlPlaneError) || error.code !== "concurrency_limit") {
    return undefined;
  }
  const d = error.details;
  if (d === undefined || typeof d.requested !== "number" || typeof d.region !== "string") {
    return undefined;
  }
  const { requested, region } = d;
  if (
    (d.scope === "sandbox" || d.scope === "live") &&
    typeof d.limit === "number" &&
    typeof d.in_use === "number"
  ) {
    return { scope: d.scope, limit: d.limit, inUse: d.in_use, requested, region };
  }
  if (d.scope === "org" && d.limit === null && d.in_use === null) {
    return { scope: "org", limit: null, inUse: null, requested, region };
  }
  return undefined;
}
