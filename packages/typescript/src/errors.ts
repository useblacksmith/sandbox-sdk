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

/**
 * The host's answer for a sandbox it no longer runs: `sandbox_failed`,
 * `sandbox_paused` or `sandbox_deleted` from the socket the agent keeps
 * serving for a few minutes after the VM went. `details.vm_id` names the VM
 * it speaks for, which is not necessarily the one the control plane routes
 * to now, so the control plane's record is the one to trust.
 */
export function isSandboxGone(error: unknown): error is SandboxApiError {
  return (
    error instanceof SandboxApiError &&
    (error.code === "sandbox_failed" ||
      error.code === "sandbox_paused" ||
      error.code === "sandbox_deleted")
  );
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
