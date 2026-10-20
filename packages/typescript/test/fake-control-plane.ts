import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface StoredSandbox {
  id: string;
  status: string;
  hostname: string;
  hostnames: string[];
  created_at: string;
  image: string;
  base_image: string;
  labels: string[];
  idle_delete_timeout_seconds?: number;
  idempotency_key?: string;
}

export interface StoredSnapshot {
  id: string;
  sandbox_id: string;
  status: string;
  region: string;
  arch: string;
  size_bytes: number | null;
  expires_at: string;
  last_error: string | null;
  created_at: string;
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: string;
  authorization: string | null;
  idempotencyKey: string | null;
  body: unknown;
}

/**
 * In-process stand-in for the provisional `/api/v1/sandboxes` control plane
 * (useblacksmith/web PRs #12589/#12591). State lives in `records` so tests can
 * flip a sandbox to `paused`/`failed` between calls. Every minted token is
 * `tok-<n>` and reported through `onMint` so a FakeAgent can accept it.
 */
export class FakeControlPlane {
  readonly apiKey = "org-api-key";
  readonly records = new Map<string, StoredSandbox>();
  readonly snapshots = new Map<string, StoredSnapshot>();
  readonly requests: RecordedRequest[] = [];
  readonly mintedTokens: string[] = [];
  onMint: (token: string) => void = () => undefined;
  domains = ["sandboxes.test", "sandboxes-legacy.test"];
  hostnameFor: (id: string) => string = (id) => `${id}.${this.domains[0]}`;
  tokenTtlMs = 3_600_000;
  /** `false` mimics a backend whose create response carries no `token`. */
  tokenOnCreate = true;

  private server: Server | undefined;
  private nextId = 1;

  get url(): string {
    if (!this.server) throw new Error("not started");
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    return this;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  seed(status = "running"): StoredSandbox {
    const id = `sbx-${this.nextId++}`;
    const record: StoredSandbox = {
      id,
      status,
      hostname: this.hostnameFor(id),
      hostnames: this.domains.map((domain) => `${id}.${domain}`),
      created_at: new Date().toISOString(),
      image: "ubuntu-24.04",
      base_image: "ubuntu-24.04",
      labels: [],
    };
    this.records.set(id, record);
    return record;
  }

  seedSnapshot(sandbox: StoredSandbox, status = "ready"): StoredSnapshot {
    const id = `snap-${String(this.nextId++).padStart(12, "0")}`;
    const snapshot: StoredSnapshot = {
      id,
      sandbox_id: sandbox.id,
      status,
      region: "us-east-1",
      arch: "amd64",
      size_bytes: 10 * 1024 ** 3,
      expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      last_error: null,
      created_at: new Date().toISOString(),
    };
    this.snapshots.set(id, snapshot);
    return snapshot;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://fake");
    const method = req.method ?? "GET";
    const body = await readBody(req);
    this.requests.push({
      method,
      path: url.pathname,
      query: url.search,
      authorization: req.headers.authorization ?? null,
      idempotencyKey: header(req, "idempotency-key"),
      body,
    });

    if (req.headers.authorization !== `Bearer ${this.apiKey}`) {
      return sendError(res, 401, "unauthorized", "Unauthenticated.");
    }
    if (url.pathname.startsWith("/api/v1/images/snapshots")) {
      return this.handleSnapshots(url, method, body, res);
    }
    if (!url.pathname.startsWith("/api/v1/sandboxes")) {
      return sendError(res, 404, "not_found", "no such route");
    }
    const rest = url.pathname.slice("/api/v1/sandboxes".length);

    if (rest === "" || rest === "/") {
      if (method === "POST") return this.create(req, body, res);
      if (method === "GET") {
        const status = url.searchParams.get("status");
        const label = url.searchParams.get("label");
        const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 50;
        if (!Number.isInteger(limit) || limit < 1) {
          return sendError(res, 400, "invalid_argument", "The limit field must be at least 1.");
        }
        const items = [...this.records.values()]
          .filter((r) => status === null || r.status === status)
          .filter((r) => label === null || r.labels.includes(label))
          .slice(0, limit);
        return sendJson(res, 200, { sandboxes: items.map(present) });
      }
    }

    const match = /^\/([^/]+)(?:\/(pause|resume|tokens))?$/.exec(rest);
    if (!match) return sendError(res, 404, "not_found", "no such route");
    const record = this.records.get(decodeURIComponent(match[1]!));
    if (!record) return sendError(res, 404, "not_found", "Sandbox not found");
    const action = match[2];

    if (!action && method === "GET") return sendJson(res, 200, present(record));
    if (!action && method === "DELETE") {
      record.status = "deleting";
      return sendJson(res, 202, present(record));
    }
    if (action === "pause" && method === "POST") {
      if (record.status !== "running") {
        return sendInvalidState(res, `Cannot pause a ${record.status} sandbox`, record.status);
      }
      record.status = "paused";
      return sendJson(res, 202, present(record));
    }
    if (action === "resume" && method === "POST") {
      if (record.status !== "paused") {
        return sendInvalidState(res, `Cannot resume a ${record.status} sandbox`, record.status);
      }
      record.status = "running";
      return sendJson(res, 202, present(record));
    }
    if (action === "tokens" && method === "POST") {
      if (record.status === "deleted" || record.status === "failed") {
        return sendInvalidState(
          res,
          `Cannot mint a token for a ${record.status} sandbox`,
          record.status,
        );
      }
      return sendJson(res, 201, this.mint(record));
    }
    return sendError(res, 404, "not_found", "no such route");
  }

  private handleSnapshots(url: URL, method: string, body: unknown, res: ServerResponse): void {
    const rest = url.pathname.slice("/api/v1/images/snapshots".length);
    if (rest === "" || rest === "/") {
      if (method === "POST") {
        const input = (body ?? {}) as Record<string, unknown>;
        const sandbox =
          typeof input.sandbox === "string" ? this.records.get(input.sandbox) : undefined;
        if (!sandbox) return sendError(res, 404, "not_found", "Sandbox not found");
        if (sandbox.status !== "paused") {
          return sendInvalidState(
            res,
            `Sandbox ${sandbox.id} is ${sandbox.status}; pause it before taking an image snapshot`,
            sandbox.status,
          );
        }
        if (sandbox.image.startsWith("snap-")) {
          return sendInvalidState(
            res,
            `Sandbox ${sandbox.id} was created from ${sandbox.image}; snapshots of snapshots are not allowed`,
            sandbox.status,
          );
        }
        const snapshot = this.seedSnapshot(sandbox);
        if (typeof input.ttl_seconds === "number") {
          snapshot.expires_at = new Date(Date.now() + input.ttl_seconds * 1000).toISOString();
        }
        return sendJson(res, 201, snapshot);
      }
      if (method === "GET") {
        const status = url.searchParams.get("status");
        const sandbox = url.searchParams.get("sandbox");
        const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 50;
        const items = [...this.snapshots.values()]
          .filter((s) => status === null || s.status === status)
          .filter((s) => sandbox === null || s.sandbox_id === sandbox)
          .slice(0, limit);
        return sendJson(res, 200, { snapshots: items });
      }
    }
    const match = /^\/([^/]+)$/.exec(rest);
    const snapshot = match ? this.snapshots.get(decodeURIComponent(match[1]!)) : undefined;
    if (!snapshot) return sendError(res, 404, "not_found", "Sandbox image snapshot not found");
    if (method === "GET") return sendJson(res, 200, snapshot);
    if (method === "DELETE") {
      snapshot.status = "deleted";
      return sendJson(res, 200, snapshot);
    }
    return sendError(res, 404, "not_found", "no such route");
  }

  private create(req: IncomingMessage, body: unknown, res: ServerResponse): void {
    const input = (body ?? {}) as Record<string, unknown>;
    const image = typeof input.image === "string" ? input.image : input.base_image;
    if (typeof image !== "string" || image === "") {
      return sendError(res, 400, "invalid_argument", "The image field is required.", {
        image: ["The image field is required."],
      });
    }
    if (image.startsWith("snap-")) {
      const snapshot = this.snapshots.get(image);
      if (!snapshot) {
        return sendError(res, 422, "unknown_image", `Unknown image ${image}: no such snapshot`);
      }
      if (snapshot.status !== "ready") {
        return sendInvalidState(
          res,
          `Snapshot ${image} is ${snapshot.status} and cannot be used to create a sandbox`,
          snapshot.status,
        );
      }
    }
    const key = header(req, "idempotency-key");
    if (key) {
      const existing = [...this.records.values()].find((r) => r.idempotency_key === key);
      if (existing) {
        res.setHeader("Idempotent-Replayed", "true");
        return sendJson(res, 200, present(existing));
      }
    }
    const record = this.seed("running");
    record.image = image;
    record.base_image = image;
    record.labels = Array.isArray(input.labels) ? (input.labels as string[]) : [];
    if (typeof input.idle_delete_timeout_seconds === "number")
      record.idle_delete_timeout_seconds = input.idle_delete_timeout_seconds;
    if (key) record.idempotency_key = key;
    const token = this.tokenOnCreate ? { token: this.mint(record) } : {};
    sendJson(res, 201, { ...present(record), ...token });
  }

  private mint(record: StoredSandbox): { token: string; expires_at: string; hostname: string } {
    const token = `tok-${this.mintedTokens.length + 1}`;
    this.mintedTokens.push(token);
    this.onMint(token);
    return {
      token,
      expires_at: new Date(Date.now() + this.tokenTtlMs).toISOString(),
      hostname: record.hostname,
    };
  }
}

function present(record: StoredSandbox): Record<string, unknown> {
  const { idempotency_key: _omit, ...rest } = record;
  return { ...rest, region: "us-east-1", arch: "amd64", vcpu: 2 };
}

function header(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  return typeof value === "string" ? value : null;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? undefined : (JSON.parse(text) as unknown);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Like the backend, `invalid_state` carries the sandbox's current status. */
function sendInvalidState(res: ServerResponse, message: string, status: string): void {
  sendJson(res, 409, { error: { code: "invalid_state", message, status }, status });
}

function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): void {
  sendJson(res, status, { error: { code, message, ...(details ? { details } : {}) } });
}
