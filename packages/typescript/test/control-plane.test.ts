import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ControlPlaneError,
  HttpControlPlaneClient,
  SandboxTransportError,
  concurrencyLimit,
} from "../src/index.js";
import { FakeControlPlane } from "./fake-control-plane.js";

let cp: FakeControlPlane;

beforeAll(async () => {
  cp = await new FakeControlPlane().start();
});
afterAll(() => cp.stop());
beforeEach(() => {
  cp.records.clear();
  cp.snapshots.clear();
  cp.requests.length = 0;
  cp.mintedTokens.length = 0;
});

function client(apiKey = cp.apiKey) {
  return new HttpControlPlaneClient({ apiKey, baseUrl: cp.url });
}

describe("HttpControlPlaneClient", () => {
  it("requires an api key", () => {
    expect(() => new HttpControlPlaneClient({ apiKey: "" })).toThrow(TypeError);
  });

  it("creates with a snake_case body, bearer auth and Idempotency-Key", async () => {
    const record = await client().create({
      image: "ubuntu-24.04",
      vcpu: 4,
      labels: ["ci"],
      idleTimeoutSeconds: 600,
      idleDeleteTimeoutSeconds: 604800,
      idempotencyKey: "req-1",
    });

    expect(cp.requests[0]).toMatchObject({
      method: "POST",
      path: "/api/v1/sandboxes",
      authorization: `Bearer ${cp.apiKey}`,
      idempotencyKey: "req-1",
      body: {
        image: "ubuntu-24.04",
        vcpu: 4,
        labels: ["ci"],
        idle_timeout_seconds: 600,
        idle_delete_timeout_seconds: 604800,
      },
    });
    expect(record.id).toMatch(/^sbx-/);
    expect(record.state).toBe("running");
    expect(record.hostname).toBe(`${record.id}.sandboxes.test`);
    expect(record.hostnames).toEqual([
      `${record.id}.sandboxes.test`,
      `${record.id}.sandboxes-legacy.test`,
    ]);
    expect(record.createdAt.getTime()).toBeGreaterThan(0);
    expect(record.raw.status).toBe("running");
    expect(record.token).toMatchObject({ token: "tok-1", hostname: record.hostname });
    expect(record.token?.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(record.replayed).toBe(false);

    const replay = await client().create({ image: "ubuntu-24.04", idempotencyKey: "req-1" });
    expect(replay.id).toBe(record.id);
    expect(replay.token).toBeUndefined();
    expect(replay.replayed).toBe(true);
    expect(cp.records.size).toBe(1);
    expect((await client().get(record.id)).token).toBeUndefined();
  });

  it("rejects a create response whose token is malformed", async () => {
    const broken = new HttpControlPlaneClient({
      apiKey: cp.apiKey,
      baseUrl: cp.url,
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        const body = (await response.json()) as Record<string, unknown>;
        return Response.json({ ...body, token: { token: "tok-x" } }, { status: response.status });
      },
    });
    await expect(broken.create({ baseImage: "ubuntu-24.04" })).rejects.toThrow(
      "control plane token response is missing token, expires_at or hostname",
    );
  });

  it("gets, lists, pauses, resumes and deletes", async () => {
    const a = cp.seed();
    const b = cp.seed();
    const c = client();

    expect((await c.get(a.id)).state).toBe("running");
    expect((await c.list()).map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    expect((await c.pause(a.id)).state).toBe("paused");
    expect((await c.resume(a.id)).state).toBe("running");
    expect((await c.delete(b.id)).state).toBe("deleting");
  });

  it("maps structured last_error and preserves the original wire response", async () => {
    const failure = {
      source: "assigner",
      code: "node_boot_failed",
      message: "node could not boot VM",
      attempts: 2,
      distinct_nodes: 2,
      occurred_at: "2026-10-23T10:00:00Z",
    };
    const c = new HttpControlPlaneClient({
      apiKey: "k",
      fetch: async () =>
        Response.json({ id: "sbx-failed", status: "failed", last_error: JSON.stringify(failure) }),
    });
    const record = await c.get("sbx-failed");
    expect(record.lastError).toEqual({
      source: "assigner",
      code: "node_boot_failed",
      message: "node could not boot VM",
      attempts: 2,
      distinctNodes: 2,
      occurredAt: "2026-10-23T10:00:00Z",
    });
    expect(record.raw.last_error).toBe(JSON.stringify(failure));
  });

  it.each([null, undefined])("omits an absent last_error (%s)", async (last_error) => {
    const c = new HttpControlPlaneClient({
      apiKey: "k",
      fetch: async () => Response.json({ id: "sbx-ok", status: "running", last_error }),
    });
    expect((await c.get("sbx-ok")).lastError).toBeUndefined();
  });

  it.each([
    "agent boot failed",
    "{malformed JSON",
    JSON.stringify({ source: "assigner", code: "boot_failed", message: 123 }),
    JSON.stringify({ source: "assigner", code: "boot_failed", message: "missing metadata" }),
    "null",
  ])("retains an undecodable failure string: %s", async (last_error) => {
    const c = new HttpControlPlaneClient({
      apiKey: "k",
      fetch: async () =>
        Response.json({
          id: "sbx-failed",
          status: "failed",
          hostname: 123,
          hostnames: [123],
          last_error,
        }),
    });
    const record = await c.get("sbx-failed");
    expect(record.state).toBe("failed");
    expect(record.lastError).toBe(last_error);
    expect(record.hostname).toBeUndefined();
    expect(record.hostnames).toBeUndefined();
  });

  it("passes state, label and limit through as list query parameters", async () => {
    const running = cp.seed();
    running.labels = ["ci"];
    const paused = cp.seed("paused");
    paused.labels = ["ci"];
    cp.seed().labels = ["other"];
    const c = client();

    expect((await c.list({ state: "paused" })).map((r) => r.id)).toEqual([paused.id]);
    expect((await c.list({ label: "ci" })).map((r) => r.id).sort()).toEqual(
      [running.id, paused.id].sort(),
    );
    expect(await c.list({ limit: 1 })).toHaveLength(1);
    expect(cp.requests.at(-1)).toMatchObject({ method: "GET", path: "/api/v1/sandboxes" });
    expect(cp.requests.at(-1)!.query).toBe("?limit=1");

    const err = await c.list({ limit: 0 }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 400, code: "invalid_argument" });
  });

  it("mints a token with a Date expiry and the agent hostname", async () => {
    const record = cp.seed();
    const before = Date.now();
    const minted = await client().mintToken(record.id);
    expect(minted).toMatchObject({ token: "tok-1", hostname: record.hostname });
    expect(minted.expiresAt.getTime()).toBeGreaterThan(before + cp.tokenTtlMs - 5_000);
  });

  it("maps the error envelope to ControlPlaneError", async () => {
    const err = await client()
      .get("nope")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ControlPlaneError);
    expect(err).toMatchObject({ status: 404, code: "not_found" });

    const invalid = await client()
      .create({ image: "" })
      .catch((e: unknown) => e);
    expect(invalid).toMatchObject({
      status: 400,
      code: "invalid_argument",
      details: { image: expect.any(Array) },
    });

    const unauthorized = await client("wrong")
      .list()
      .catch((e: unknown) => e);
    expect(unauthorized).toMatchObject({ status: 401, code: "unauthorized" });

    const paused = cp.seed("paused");
    const state = await client()
      .pause(paused.id)
      .catch((e: unknown) => e);
    expect(state).toMatchObject({ status: 409, code: "invalid_state", sandboxStatus: "paused" });
  });

  it("preserves capacity failure details for callers", async () => {
    const c = new HttpControlPlaneClient({
      apiKey: "k",
      baseUrl: "https://control-plane.test",
      fetch: async () =>
        Response.json(
          {
            error: {
              code: "unavailable",
              message:
                "Failed to schedule sandbox: no eligible capacity. Please try again shortly.",
              details: { reason: "no_capacity", region: "us-west", arch: "amd64", vcpu: 4 },
            },
          },
          { status: 503 },
        ),
    });
    const err = await c.create({ baseImage: "ubuntu-24.04", vcpu: 4 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ControlPlaneError);
    expect(err).toMatchObject({
      status: 503,
      code: "unavailable",
      details: { reason: "no_capacity", region: "us-west", arch: "amd64", vcpu: 4 },
    });
  });

  it("surfaces a 429 concurrency_limit once, with its details and Retry-After", async () => {
    const fetch = vi.fn(async () =>
      Response.json(
        {
          error: {
            code: "concurrency_limit",
            message:
              "Concurrent sandbox vCPU limit reached in us-west: 4 in use, 2 requested, limit 4.",
            details: { limit: 4, in_use: 4, requested: 2, region: "us-west", scope: "sandbox" },
          },
        },
        { status: 429, headers: { "Retry-After": "15" } },
      ),
    );
    const c = new HttpControlPlaneClient({
      apiKey: "k",
      baseUrl: "https://control-plane.test",
      fetch,
    });
    const err = await c.create({ image: "ubuntu-24.04", vcpu: 2 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ControlPlaneError);
    expect(err).toMatchObject({ status: 429, code: "concurrency_limit", retryAfterMs: 15_000 });
    expect(concurrencyLimit(err)).toEqual({
      limit: 4,
      inUse: 4,
      requested: 2,
      region: "us-west",
      scope: "sandbox",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reads an assigner-scoped concurrency_limit without a visible tally", () => {
    const err = new ControlPlaneError(429, "concurrency_limit", "limit", {
      limit: null,
      in_use: null,
      requested: 2,
      region: "us-west",
      scope: "org",
    });
    expect(concurrencyLimit(err)).toEqual({
      limit: null,
      inUse: null,
      requested: 2,
      region: "us-west",
      scope: "org",
    });
    expect(concurrencyLimit(new ControlPlaneError(503, "unavailable", "x"))).toBeUndefined();
  });

  it("reads a live-count concurrency_limit (sandboxes + snapshots, every region)", () => {
    const err = new ControlPlaneError(429, "concurrency_limit", "limit", {
      limit: 512,
      in_use: 512,
      requested: 1,
      region: "us-west",
      scope: "live",
    });
    expect(concurrencyLimit(err)).toEqual({
      limit: 512,
      inUse: 512,
      requested: 1,
      region: "us-west",
      scope: "live",
    });
  });

  it("rejects concurrency_limit details that drifted from the contract", () => {
    const sandboxScoped = {
      limit: 4,
      in_use: 4,
      requested: 2,
      region: "us-west",
      scope: "sandbox",
    };
    const orgScoped = { limit: null, in_use: null, requested: 2, region: "us-west", scope: "org" };
    const drifted = [
      undefined,
      { ...sandboxScoped, in_use: undefined },
      { ...sandboxScoped, limit: null },
      { ...orgScoped, limit: 4 },
      { ...orgScoped, in_use: 4 },
      { ...sandboxScoped, scope: "installation" },
      { ...sandboxScoped, scope: "live", limit: null },
      { ...sandboxScoped, requested: "2" },
    ];
    for (const details of drifted) {
      expect(
        concurrencyLimit(new ControlPlaneError(429, "concurrency_limit", "limit", details)),
        JSON.stringify(details),
      ).toBeUndefined();
    }
  });

  it("wraps fetch failures in SandboxTransportError", async () => {
    const c = new HttpControlPlaneClient({
      apiKey: "k",
      baseUrl: "http://127.0.0.1:9",
      fetch: () => Promise.reject(new TypeError("fetch failed")),
    });
    const err = await c.list().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxTransportError);
    expect(err).toMatchObject({ method: "GET", attempts: 1 });
  });

  it("still sends the deprecated baseImage as base_image", async () => {
    const record = await client().create({ baseImage: "ubuntu-24.04" });
    expect(cp.requests[0]).toMatchObject({ body: { base_image: "ubuntu-24.04" } });
    expect(cp.requests[0]?.body).not.toHaveProperty("image");
    expect(record.image).toBe("ubuntu-24.04");
  });

  it("prefers image over baseImage and requires one of them", async () => {
    await client().create({ image: "ubuntu-24.04", baseImage: "ignored" });
    expect(cp.requests[0]).toMatchObject({ body: { image: "ubuntu-24.04" } });
    expect(cp.requests[0]?.body).not.toHaveProperty("base_image");
    // @ts-expect-error one of image/baseImage is required at the type level too
    await expect(client().create({ vcpu: 2 })).rejects.toThrow(TypeError);
    expect(cp.requests).toHaveLength(1);
  });
});

describe("HttpControlPlaneClient.images.snapshots", () => {
  it("creates a snapshot of a paused sandbox", async () => {
    const source = cp.seed("paused");
    const snapshot = await client().images.snapshots.create({
      sandbox: source.id,
      ttlSeconds: 3600,
    });

    expect(cp.requests[0]).toMatchObject({
      method: "POST",
      path: "/api/v1/images/snapshots",
      body: { sandbox: source.id, ttl_seconds: 3600 },
    });
    expect(snapshot.id).toMatch(/^snap-[a-z0-9]{12}$/);
    expect(snapshot.sandboxId).toBe(source.id);
    expect(snapshot.state).toBe("ready");
    expect(snapshot.region).toBe("us-east-1");
    expect(snapshot.arch).toBe("amd64");
    expect(snapshot.sizeBytes).toBe(10 * 1024 ** 3);
    expect(snapshot.expiresAt.getTime() - Date.now()).toBeGreaterThan(3500_000);
    expect(snapshot.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(3600_000);
    expect(snapshot.lastError).toBeUndefined();
    expect(snapshot.raw.status).toBe("ready");
  });

  it("rejects a snapshot response without a usable created_at", async () => {
    const snapshot = cp.seedSnapshot(cp.seed("paused"));
    snapshot.created_at = "not a date";
    await expect(client().images.snapshots.get(snapshot.id)).rejects.toThrow(
      "missing required fields",
    );
  });

  it("refuses a snapshot of a running sandbox with invalid_state", async () => {
    const source = cp.seed("running");
    const error = await client()
      .images.snapshots.create({ sandbox: source.id })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ControlPlaneError);
    expect(error).toMatchObject({ status: 409, code: "invalid_state", sandboxStatus: "running" });
  });

  it("creates a sandbox from a snapshot and refuses to snapshot that sandbox", async () => {
    const snapshot = cp.seedSnapshot(cp.seed("paused"));
    const child = await client().create({ image: snapshot.id, vcpu: 2 });
    expect(cp.requests[0]).toMatchObject({ body: { image: snapshot.id, vcpu: 2 } });
    expect(child.image).toBe(snapshot.id);

    cp.records.get(child.id)!.status = "paused";
    const error = await client()
      .images.snapshots.create({ sandbox: child.id })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 409, code: "invalid_state" });
  });

  it("surfaces unknown_image for a missing snapshot id", async () => {
    const error = await client()
      .create({ image: "snap-doesnotexist" })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 422, code: "unknown_image" });
  });

  it("lists with status and sandbox filters, gets and deletes", async () => {
    const a = cp.seed("paused");
    const b = cp.seed("paused");
    const ready = cp.seedSnapshot(a);
    const failed = cp.seedSnapshot(b, "failed");

    const all = await client().images.snapshots.list();
    expect(all.map((s) => s.id)).toEqual([ready.id, failed.id]);

    await client().images.snapshots.list({ state: "ready", sandbox: a.id, limit: 5 });
    expect(cp.requests[1]).toMatchObject({
      method: "GET",
      path: "/api/v1/images/snapshots",
      query: `?status=ready&sandbox=${a.id}&limit=5`,
    });

    const got = await client().images.snapshots.get(ready.id);
    expect(got.id).toBe(ready.id);
    expect(cp.requests[2]?.path).toBe(`/api/v1/images/snapshots/${ready.id}`);

    const deleted = await client().images.snapshots.delete(ready.id);
    expect(deleted.state).toBe("deleted");
    expect(cp.requests[3]).toMatchObject({
      method: "DELETE",
      path: `/api/v1/images/snapshots/${ready.id}`,
    });

    const missing = await client()
      .images.snapshots.get("snap-000000000000")
      .catch((e: unknown) => e);
    expect(missing).toMatchObject({ status: 404, code: "not_found" });
  });
});
