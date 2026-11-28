export type SandboxState =
  | "queued"
  | "starting"
  | "running"
  | "pausing"
  | "paused"
  | "resuming"
  | "deleting"
  | "deleted"
  | "failed";

export interface SandboxFailure {
  source: string;
  code: string;
  message: string;
  attempts: number;
  distinctNodes: number;
  occurredAt: string;
}

export interface SandboxRecord {
  id: string;
  /** Backend `status`; unknown values pass through untouched. */
  state: SandboxState | (string & {});
  /** Canonical hostname, the one `token.hostname` is minted for. */
  hostname?: string;
  /** Every hostname that reaches the sandbox, canonical first. */
  hostnames?: string[];
  createdAt: Date;
  lastError?: string | SandboxFailure;
  /** Absent on sandboxes created before the field existed. */
  workload?: string;
  tenant?: string;
  /** What the sandbox booted from: a catalog image reference, a `machine/<name>[:<version>]` or a `snap-…` id. */
  image?: string;
  /** The backend response as received. */
  raw: Record<string, unknown>;
}

export type SandboxCreateOptions = SandboxCreateSettings & {
  /**
   * A catalog image reference (`ubuntu24`, `ubuntu24:canary`), a Blacksmith
   * Machine's image (`machine/web-ci` for its latest ready version,
   * `machine/web-ci:3` for version 3, `machine/web-ci:stable` for the image
   * tagged `stable`) or a sandbox image snapshot id (`snap-…`).
   */
  image: string;
};

export interface SandboxCreateSettings {
  /**
   * The kind of work this sandbox does, such as `agent-session`, `test-runner` or `pr-review`.
   * Blacksmith reports usage per workload, so a clear, stable name lets you see what each kind
   * of work costs. Keep the set small and reuse values: a name used by one sandbox tells you
   * nothing.
   *
   * Lowercase letters, digits, `.`, `_` and `-`, starting with a letter or digit; at most 1024
   * characters. `create` throws a `TypeError` for anything else.
   *
   * Accepted: `test-runner`, `pr_review`, `e2e.v2`, `2fa-check`.
   * Rejected:
   *   - `Test-Runner`: uppercase
   *   - `test runner`: space, including a leading or trailing one
   *   - `test/runner`, `test:runner`, `tests@v2`: any other punctuation
   *   - `-test-runner`, `.hidden`, `_private`: starts with `-`, `.` or `_`
   *   - `e2e-tësts`: a letter outside a-z
   *   - an empty string
   */
  workload: string;
  /**
   * Whose work this is, when you run sandboxes on behalf of your own customers or teams, such
   * as `acme`. Use a stable id or name, and always send it in the same form. Leave it out when
   * every sandbox is your own.
   *
   * Letters, digits, `.`, `_` and `-`, starting with a letter or digit; at most 1024 characters.
   * Case matters: `Acme` and `acme` are two tenants. `create` throws a `TypeError` for anything
   * else.
   *
   * Accepted: `acme`, `Acme-Corp`, `acme.com`, `cus_Nf3x9`, `42`,
   * `550e8400-e29b-41d4-a716-446655440000`.
   * Rejected:
   *   - `Acme Corp`: space
   *   - `jane@acme.com`, `org:123`, `acme/eu`, `https://acme.com`: any other punctuation
   *   - `-acme`: starts with `-`, `.` or `_`
   *   - `Zoë`: a letter outside A-Z and a-z
   *   - an empty string; leave `tenant` out instead
   */
  tenant?: string;
  arch?: "amd64" | "arm64";
  vcpu?: number;
  env?: Record<string, string>;
  labels?: string[];
  /**
   * Pause the sandbox after this long with no request to it and no process output. `resume()`
   * brings it back. Default: it never pauses on its own.
   */
  idleTimeoutSeconds?: number;
  /**
   * Delete the sandbox this long after creation, whatever its state; activity and resume do
   * not extend it. Default: it is never deleted on its own.
   */
  ttlSeconds?: number;
  /**
   * Delete the sandbox once it is paused or failed and has been inactive for this long. Off by
   * default.
   */
  idleDeleteTimeoutSeconds?: number;
  /** Sent as `Idempotency-Key`; a replayed create returns the existing record. */
  idempotencyKey?: string;
}

export interface SandboxListOptions {
  state?: SandboxState | (string & {});
  label?: string;
  /** Newest first; the backend caps this. */
  limit?: number;
}

export type ImageSnapshotState = "creating" | "ready" | "deleting" | "deleted" | "failed";

/** A paused sandbox's boot disk, named so new sandboxes can be created from it. */
export interface ImageSnapshotRecord {
  /** `snap-…`; pass it as `image` to `create` a sandbox from it. */
  id: string;
  /** The sandbox whose boot disk this is. */
  sandboxId: string;
  /** Backend `status`; unknown values pass through untouched. */
  state: ImageSnapshotState | (string & {});
  /** New sandboxes must be created in this region and arch. */
  region: string;
  arch: string;
  sizeBytes?: number;
  /** After this the snapshot can no longer be used to create sandboxes. */
  expiresAt: Date;
  lastError?: string;
  createdAt: Date;
  /** The backend response as received. */
  raw: Record<string, unknown>;
}

export interface ImageSnapshotCreateOptions {
  /** The source sandbox; it must be `paused` and not itself created from a snapshot. */
  sandbox: string;
  /** How long the snapshot stays usable. The backend default and cap apply. */
  ttlSeconds?: number;
}

export interface ImageSnapshotListOptions {
  state?: ImageSnapshotState | (string & {});
  /** Only snapshots of this sandbox. */
  sandbox?: string;
  /** Newest first; the backend caps this. */
  limit?: number;
}

export interface Snapshots {
  create(options: ImageSnapshotCreateOptions): Promise<ImageSnapshotRecord>;
  get(id: string): Promise<ImageSnapshotRecord>;
  list(options?: ImageSnapshotListOptions): Promise<ImageSnapshotRecord[]>;
  delete(id: string): Promise<ImageSnapshotRecord>;
}
