import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  HttpControlPlaneClient,
  Sandbox,
  SandboxApiError,
  SandboxNotRunningError,
  SandboxTransportError,
} from "../src/index.js";
import type { OutputChunk, SandboxOptions } from "../src/index.js";
import { FakeAgent } from "./fake-agent.js";
import { FakeControlPlane } from "./fake-control-plane.js";
import { requestUrl } from "./request-url.js";

let agent: FakeAgent;
let cp: FakeControlPlane;
let controlPlane: HttpControlPlaneClient;

beforeAll(async () => {
  agent = await new FakeAgent().start();
  cp = await new FakeControlPlane().start();
  cp.onMint = (token) => agent.validTokens.add(token);
  controlPlane = new HttpControlPlaneClient({ apiKey: cp.apiKey, baseUrl: cp.url });
});
afterAll(async () => {
  await agent.stop();
  await cp.stop();
});
beforeEach(() => {
  cp.records.clear();
  cp.requests.length = 0;
  cp.mintedTokens.length = 0;
  agent.requests.length = 0;
  agent.faults.length = 0;
  agent.expiredTokens.clear();
});

const options: SandboxOptions = {
  agentBaseUrl: () => agent.url,
  readyTimeoutMs: 5_000,
  client: { retry: { baseDelayMs: 1, maxDelayMs: 5 } },
};

const agentPaths = () => agent.requests.map((r) => r.path);
const cpCalls = () => cp.requests.map((r) => `${r.method} ${r.path}`);
const isExecStart = (r: { method: string; path: string }) =>
  r.method === "PUT" && r.path.startsWith("/v1/processes/exec-");

describe("Sandbox.create / connect", () => {
  it("creates, uses the token from the create response, waits for health and runs commands", async () => {
    const sandbox = await Sandbox.create(controlPlane, { image: "ubuntu-24.04" }, options);

    expect(sandbox.state).toBe("running");
    expect(cpCalls()).toEqual(["POST /api/v1/sandboxes"]);
    expect(agentPaths()).toEqual(["/v1/health"]);

    const result = await sandbox.exec({ shell: "echo hello" });
    expect(result.stdout).toBe("hello\n");
    expect(agent.requests.at(-1)?.authorization).toBe("Bearer tok-1");
    expect(cpCalls()).toEqual(["POST /api/v1/sandboxes"]);
    expect(cp.mintedTokens).toEqual(["tok-1"]);
  });

  const retentionIgnoringControlPlane = () =>
    new HttpControlPlaneClient({
      apiKey: cp.apiKey,
      baseUrl: cp.url,
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        if (init?.method !== "POST" || !requestUrl(input).endsWith("/api/v1/sandboxes"))
          return response;
        const body = await response.json();
        delete body.idle_delete_timeout_seconds;
        const replayed = response.headers.get("Idempotent-Replayed");
        const headers = replayed === null ? undefined : { "Idempotent-Replayed": replayed };
        return Response.json(body, { status: response.status, headers });
      },
    });

  it("refuses an idle retention policy ignored by an older control plane and cleans up the allocation", async () => {
    await expect(
      Sandbox.create(
        retentionIgnoringControlPlane(),
        { image: "ubuntu-24.04", idleDeleteTimeoutSeconds: 604800 },
        options,
      ),
    ).rejects.toThrow("control plane did not accept idle deletion policy");
    const allocated = [...cp.records.values()][0];
    expect(allocated?.status).toBe("deleting");
    expect(agentPaths()).toEqual([]);
  });

  it("cleans up a fresh keyed allocation when idle retention is ignored", async () => {
    await expect(
      Sandbox.create(
        retentionIgnoringControlPlane(),
        { image: "ubuntu-24.04", idleDeleteTimeoutSeconds: 604800, idempotencyKey: "key-1" },
        options,
      ),
    ).rejects.toThrow("control plane did not accept idle deletion policy");
    expect([...cp.records.values()][0]?.status).toBe("deleting");
  });

  it("keeps a replayed keyed sandbox when idle retention is ignored", async () => {
    const existing = cp.seed("running");
    existing.idempotency_key = "key-1";
    await expect(
      Sandbox.create(
        retentionIgnoringControlPlane(),
        { image: "ubuntu-24.04", idleDeleteTimeoutSeconds: 604800, idempotencyKey: "key-1" },
        options,
      ),
    ).rejects.toThrow("control plane did not accept idle deletion policy");
    expect(cp.records.get(existing.id)?.status).toBe("running");
    expect(cpCalls().filter((c) => c.startsWith("DELETE"))).toEqual([]);
  });

  it("accepts an acknowledged idle retention policy and runs commands", async () => {
    const sandbox = await Sandbox.create(
      controlPlane,
      { image: "ubuntu-24.04", idleDeleteTimeoutSeconds: 604800 },
      options,
    );
    expect((await sandbox.exec({ shell: "echo hello" })).stdout).toBe("hello\n");
  });

  it("mints a token when the create response has none", async () => {
    cp.tokenOnCreate = false;
    try {
      const sandbox = await Sandbox.create(controlPlane, { image: "ubuntu-24.04" }, options);
      expect(cpCalls()).toEqual([
        "POST /api/v1/sandboxes",
        `POST /api/v1/sandboxes/${sandbox.id}/tokens`,
      ]);
      expect((await sandbox.exec({ shell: "echo hello" })).stdout).toBe("hello\n");
      expect(agent.requests.at(-1)?.authorization).toBe("Bearer tok-1");
      expect(cp.mintedTokens).toEqual(["tok-1"]);
    } finally {
      cp.tokenOnCreate = true;
    }
  });

  it("connects to an existing sandbox by id, minting a token", async () => {
    const record = cp.seed();
    const sandbox = await Sandbox.connect(controlPlane, record.id, options);
    expect(sandbox.id).toBe(record.id);
    expect(cpCalls()).toEqual([
      `GET /api/v1/sandboxes/${record.id}`,
      `POST /api/v1/sandboxes/${record.id}/tokens`,
    ]);
    expect((await sandbox.listProcesses()).length).toBe(0);
    expect(agent.requests.at(-1)?.authorization).toBe("Bearer tok-1");
  });

  it("keeps polling health through connection resets and 503 unavailable", async () => {
    const record = cp.seed("starting");
    agent.faults.push("reset", "reset", "reset", "unavailable");
    const sandbox = await Sandbox.connect(controlPlane, record.id, options);
    expect(sandbox.state).toBe("starting");
    expect(agentPaths().filter((p) => p === "/v1/health").length).toBe(5);
    expect(cpCalls().filter((c) => c === `GET /api/v1/sandboxes/${record.id}`).length).toBe(3);
  });

  it("gives up early when the control plane reports a terminal state", async () => {
    const record = cp.seed("starting");
    agent.faults.push(...Array<"reset">(6).fill("reset"));
    const flipAfterMint = new HttpControlPlaneClient({
      apiKey: cp.apiKey,
      baseUrl: cp.url,
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        if (requestUrl(input).endsWith("/tokens")) record.status = "failed";
        return response;
      },
    });
    const err = await Sandbox.connect(flipAfterMint, record.id, options).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxNotRunningError);
    expect(err).toMatchObject({ id: record.id, state: "failed" });
    expect((err as SandboxNotRunningError).cause).toBeInstanceOf(SandboxTransportError);
    expect(agentPaths()).toEqual(["/v1/health", "/v1/health", "/v1/health"]);
  });

  it("refuses to attach to a deleting sandbox without minting or polling health", async () => {
    const record = cp.seed("deleting");
    const err = await Sandbox.connect(controlPlane, record.id, options).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxNotRunningError);
    expect(err).toMatchObject({ id: record.id, state: "deleting" });
    expect(cpCalls()).toEqual([`GET /api/v1/sandboxes/${record.id}`]);
    expect(agentPaths()).toEqual([]);
  });

  it("deletes the sandbox when attaching after create fails", async () => {
    agent.faults.push(...Array<"reset">(30).fill("reset"));
    const err = await Sandbox.create(
      controlPlane,
      { image: "ubuntu-24.04" },
      { ...options, readyTimeoutMs: 300 },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxTransportError);
    const id = [...cp.records.keys()][0]!;
    expect(cp.records.get(id)?.status).toBe("deleting");
    expect(cpCalls().at(-1)).toBe(`DELETE /api/v1/sandboxes/${id}`);
  });

  it("keeps a keyed sandbox when attaching after create fails", async () => {
    const existing = cp.seed("running");
    existing.idempotency_key = "key-1";
    agent.faults.push(...Array<"reset">(30).fill("reset"));
    const err = await Sandbox.create(
      controlPlane,
      { image: "ubuntu-24.04", idempotencyKey: "key-1" },
      { ...options, readyTimeoutMs: 300 },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxTransportError);
    expect(cp.records.get(existing.id)?.status).toBe("running");
    expect(cpCalls().filter((c) => c.startsWith("DELETE"))).toEqual([]);
  });

  it("times out waiting for health", async () => {
    const record = cp.seed("starting");
    agent.faults.push(...Array<"reset">(30).fill("reset"));
    const err = await Sandbox.connect(controlPlane, record.id, {
      ...options,
      readyTimeoutMs: 300,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxTransportError);
    expect((err as Error).message).toContain("not reachable within 300ms");
  });

  it("connects to a pausing sandbox without waiting for the agent", async () => {
    const record = cp.seed("pausing");
    const sandbox = await Sandbox.connect(controlPlane, record.id, options);
    expect(sandbox.state).toBe("pausing");
    expect(agentPaths()).toEqual([]);
  });

  it("connects to a paused sandbox without waiting for the agent", async () => {
    const record = cp.seed("paused");
    const sandbox = await Sandbox.connect(controlPlane, record.id, options);
    expect(sandbox.state).toBe("paused");
    expect(agentPaths()).toEqual([]);

    expect((await sandbox.resume()).state).toBe("running");
    expect((await sandbox.exec({ shell: "echo back" })).stdout).toBe("back\n");
  });

  it("refuses to mint for a deleted sandbox", async () => {
    const record = cp.seed("deleted");
    const err = await Sandbox.connect(controlPlane, record.id, options).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxNotRunningError);
    expect(err).toMatchObject({ id: record.id, state: "deleted" });
    expect(cpCalls()).toEqual([`GET /api/v1/sandboxes/${record.id}`]);
  });
});

describe("token lifecycle through the control plane", () => {
  it("re-mints via cp.mintToken after token_expired", async () => {
    const sandbox = await Sandbox.create(controlPlane, { image: "ubuntu-24.04" }, options);
    agent.expiredTokens.add("tok-1");

    const result = await sandbox.exec({ shell: "echo again" });
    expect(result.stdout).toBe("again\n");
    const execAuth = agent.requests.filter(isExecStart).map((r) => r.authorization);
    expect(execAuth).toEqual(["Bearer tok-1", "Bearer tok-2"]);
    expect(cpCalls()).toEqual([
      "POST /api/v1/sandboxes",
      `POST /api/v1/sandboxes/${sandbox.id}/tokens`,
    ]);
    expect(cp.mintedTokens).toEqual(["tok-1", "tok-2"]);
  });
});

describe("tokens shared across handles", () => {
  const execAuth = () => agent.requests.filter(isExecStart).map((r) => r.authorization);

  it("reuses one token for every connect to a sandbox", async () => {
    const record = cp.seed();
    const handles = await Promise.all(
      Array.from({ length: 5 }, () => Sandbox.connect(controlPlane, record.id, options)),
    );
    const later = await Sandbox.connect(controlPlane, record.id, options);
    for (const sandbox of [...handles, later]) await sandbox.exec({ shell: "true" });

    expect(cp.mintedTokens).toEqual(["tok-1"]);
    expect(execAuth()).toEqual(Array<string>(6).fill("Bearer tok-1"));
  });

  it("reuses the token a create returned", async () => {
    const created = await Sandbox.create(controlPlane, { image: "ubuntu-24.04" }, options);
    const connected = await Sandbox.connect(controlPlane, created.id, options);
    await connected.exec({ shell: "true" });

    expect(cpCalls()).toEqual(["POST /api/v1/sandboxes", `GET /api/v1/sandboxes/${created.id}`]);
    expect(execAuth()).toEqual(["Bearer tok-1"]);
  });

  it("mints again once a token is past the point it would be refreshed", async () => {
    cp.tokenTtlMs = 0;
    try {
      const record = cp.seed();
      await Sandbox.connect(controlPlane, record.id, options);
      await Sandbox.connect(controlPlane, record.id, options);
      expect(cp.mintedTokens).toEqual(["tok-1", "tok-2"]);
    } finally {
      cp.tokenTtlMs = 3_600_000;
    }
  });

  it("hands later connects the token minted after the agent rejected the shared one", async () => {
    const record = cp.seed();
    const first = await Sandbox.connect(controlPlane, record.id, options);
    agent.expiredTokens.add("tok-1");
    await first.exec({ shell: "true" });
    const second = await Sandbox.connect(controlPlane, record.id, options);
    await second.exec({ shell: "true" });

    expect(cp.mintedTokens).toEqual(["tok-1", "tok-2"]);
    expect(execAuth()).toEqual(["Bearer tok-1", "Bearer tok-2", "Bearer tok-2"]);
  });

  it("refreshes a handle with the token another handle already re-minted", async () => {
    const record = cp.seed();
    const first = await Sandbox.connect(controlPlane, record.id, options);
    const second = await Sandbox.connect(controlPlane, record.id, options);
    await first.exec({ shell: "true" });
    await second.exec({ shell: "true" });
    agent.expiredTokens.add("tok-1");
    await first.exec({ shell: "true" });
    await second.exec({ shell: "true" });

    expect(cp.mintedTokens).toEqual(["tok-1", "tok-2"]);
    expect(execAuth()).toEqual([
      "Bearer tok-1",
      "Bearer tok-1",
      "Bearer tok-1",
      "Bearer tok-2",
      "Bearer tok-1",
      "Bearer tok-2",
    ]);
  });

  it("does not send the token seen at attach once it is past its refresh point", async () => {
    cp.tokenTtlMs = 0;
    try {
      const record = cp.seed();
      const sandbox = await Sandbox.connect(controlPlane, record.id, options);
      await sandbox.exec({ shell: "true" });
      expect(execAuth()).toEqual(["Bearer tok-2"]);
    } finally {
      cp.tokenTtlMs = 3_600_000;
    }
  });

  it("keeps a handle's fresh token after the shared cache evicts its sandbox", async () => {
    const record = cp.seed();
    const sandbox = await Sandbox.connect(controlPlane, record.id, options);
    const others = Array.from({ length: 1_000 }, () => cp.seed());
    for (let i = 0; i < others.length; i += 100) {
      await Promise.all(
        others.slice(i, i + 100).map((other) => Sandbox.connect(controlPlane, other.id, options)),
      );
    }
    await sandbox.exec({ shell: "true" });

    expect(cp.mintedTokens).toHaveLength(1_001);
    expect(execAuth()).toEqual(["Bearer tok-1"]);
  });

  it("stops minting for a rate-limited sandbox until Retry-After passes", async () => {
    const record = cp.seed();
    let mints = 0;
    const limited = new HttpControlPlaneClient({
      apiKey: cp.apiKey,
      baseUrl: cp.url,
      fetch: async (input, init) => {
        if (!requestUrl(input).endsWith("/tokens")) return fetch(input, init);
        mints++;
        return Response.json(
          { message: "Too Many Attempts." },
          { status: 429, headers: { "Retry-After": "30" } },
        );
      },
    });

    const errors = await Promise.all(
      Array.from({ length: 3 }, () =>
        Sandbox.connect(limited, record.id, options).catch((e: unknown) => e),
      ),
    );
    const again = await Sandbox.connect(limited, record.id, options).catch((e: unknown) => e);

    expect(mints).toBe(1);
    for (const error of [...errors, again]) {
      expect(error).toMatchObject({ status: 429, retryAfterMs: 30_000 });
    }
  });
});

describe("lifecycle", () => {
  it("pause, resume and delete update state", async () => {
    const sandbox = await Sandbox.create(controlPlane, { image: "ubuntu-24.04" }, options);
    expect((await sandbox.pause()).state).toBe("paused");
    expect(sandbox.state).toBe("paused");
    expect((await sandbox.resume()).state).toBe("running");
    expect((await sandbox.delete()).state).toBe("deleting");
    expect(sandbox.state).toBe("deleting");
  });
});

describe("ports", () => {
  it("exposes, lists and unexposes ports through the agent, re-checking and replaying once", async () => {
    const sandbox = await Sandbox.create(controlPlane, { image: "ubuntu-24.04" }, options);
    agent.requests.length = 0;
    cp.requests.length = 0;
    agent.faults.push("reset", "reset", "reset");

    const { created, exposure } = await sandbox.exposePort(8080);
    expect(created).toBe(true);
    expect(exposure.hostname).toBe(
      `port-8080-${exposure.rand}-${agent.sandboxId}.${agent.sandboxDomain}`,
    );
    expect(agentPaths().filter((p) => p === "/v1/ports/8080")).toHaveLength(4);
    expect(cpCalls()).toEqual([`GET /api/v1/sandboxes/${sandbox.id}`]);

    expect(await sandbox.listPorts()).toEqual([exposure]);
    await sandbox.unexposePort(8080);
    expect(await sandbox.listPorts()).toEqual([]);
  });
});

describe("disks", () => {
  it("attaches, lists and detaches sticky disks, re-checking but not replaying an attach", async () => {
    const sandbox = await Sandbox.create(controlPlane, { image: "ubuntu-24.04" }, options);
    agent.restartVm();
    agent.entityJwts.set(9, "entity-jwt-9");
    agent.requests.length = 0;
    cp.requests.length = 0;
    const input = {
      entityId: 9,
      entityJwt: "entity-jwt-9",
      mountPath: "/home/blacksmith/.gradle",
    };

    agent.faults.push("reset");
    await expect(sandbox.attachDisk(input)).rejects.toBeInstanceOf(SandboxTransportError);
    expect(agentPaths().filter((p) => p === "/v1/disks")).toHaveLength(1);
    expect(cpCalls()).toEqual([`GET /api/v1/sandboxes/${sandbox.id}`]);

    const { created, disk } = await sandbox.attachDisk(input);
    expect(created).toBe(true);
    expect(disk).toMatchObject({ entity_id: 9, mount_path: "/home/blacksmith/.gradle" });

    expect(await sandbox.listDisks()).toEqual([disk]);
    const detached = await sandbox.detachDisk(disk.slot);
    expect(await sandbox.listDisks()).toEqual([detached]);
  });
});

describe("transport-error re-check", () => {
  it("retries once when the control plane still says running", async () => {
    const sandbox = await Sandbox.create(controlPlane, { image: "ubuntu-24.04" }, options);
    cp.requests.length = 0;
    agent.faults.push("reset", "reset", "reset");

    expect(await sandbox.listProcesses()).toEqual([]);
    expect(agentPaths().filter((p) => p === "/v1/processes").length).toBe(4);
    expect(cpCalls()).toEqual([`GET /api/v1/sandboxes/${sandbox.id}`]);
  });

  it("replays exec under the same process id once the control plane says running", async () => {
    const sandbox = await Sandbox.create(controlPlane, { image: "ubuntu-24.04" }, options);
    cp.requests.length = 0;
    agent.faults.push("reset", "reset", "reset");

    const result = await sandbox.exec({ shell: "echo once" });
    expect(result.stdout).toBe("once\n");
    const starts = agent.requests.filter(isExecStart).map((r) => r.path);
    expect(starts).toHaveLength(4);
    expect(new Set(starts).size).toBe(1);
    expect(cpCalls()).toEqual([`GET /api/v1/sandboxes/${sandbox.id}`]);
  });

  it("replays exec after the output stream kept dropping without running the command twice", async () => {
    const sandbox = await Sandbox.create(controlPlane, { baseImage: "ubuntu-24.04" }, options);
    cp.requests.length = 0;
    const marker = join(agent.fsRoot, "sandbox-ran-once");
    agent.faults.push("pass", "cut-stream", "cut-stream", "cut-stream");

    const result = await sandbox.exec({
      shell: `echo run >> ${marker}; for i in $(seq 10); do echo tick; sleep 0.1; done; cat ${marker}`,
    });
    expect(result.stdout).toBe(`${"tick\n".repeat(10)}run\n`);
    expect(await readFile(marker, "utf8")).toBe("run\n");
    expect(agent.requests.filter(isExecStart)).toHaveLength(2);
    expect(cpCalls()).toEqual([`GET /api/v1/sandboxes/${sandbox.id}`]);
  });

  it("does not replay an exec that ran out of its own deadline", async () => {
    const sandbox = await Sandbox.create(controlPlane, { baseImage: "ubuntu-24.04" }, options);
    cp.requests.length = 0;

    const err = await sandbox
      .exec({ shell: "sleep 5" }, { timeoutMs: 100 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxTransportError);
    expect(err).toMatchObject({ method: "EXEC" });
    expect(agent.requests.filter(isExecStart)).toHaveLength(1);
    expect(await sandbox.client.listProcesses()).toEqual([]);
  });

  it("surfaces SandboxNotRunningError when the sandbox is paused", async () => {
    const sandbox = await Sandbox.create(controlPlane, { image: "ubuntu-24.04" }, options);
    cp.records.get(sandbox.id)!.status = "paused";
    agent.faults.push("reset", "reset", "reset");

    const err = await sandbox.exec({ shell: "echo nope" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxNotRunningError);
    expect(err).toMatchObject({ id: sandbox.id, state: "paused" });
    expect((err as SandboxNotRunningError).cause).toBeInstanceOf(SandboxTransportError);
    expect(sandbox.state).toBe("paused");
    expect(agent.requests.filter(isExecStart)).toHaveLength(3);
  });

  it("rechecks but never replays a streaming upload", async () => {
    const sandbox = await Sandbox.create(controlPlane, { image: "ubuntu-24.04" }, options);
    cp.requests.length = 0;
    agent.faults.push("reset");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("once"));
        controller.close();
      },
    });

    const err = await sandbox.writeFile("/once.txt", body).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxTransportError);
    expect(agentPaths().filter((p) => p.startsWith("/v1/fs/file")).length).toBe(1);
    expect(cpCalls()).toEqual([`GET /api/v1/sandboxes/${sandbox.id}`]);
  });

  it("does not retry more than once", async () => {
    const sandbox = await Sandbox.create(controlPlane, { image: "ubuntu-24.04" }, options);
    agent.faults.push(...Array<"reset">(6).fill("reset"));

    const err = await sandbox.listProcesses().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxTransportError);
    expect(agentPaths().filter((p) => p === "/v1/processes").length).toBe(6);
  });

  it("passes agent errors through untouched", async () => {
    const sandbox = await Sandbox.create(controlPlane, { image: "ubuntu-24.04" }, options);
    cp.requests.length = 0;
    const err = await sandbox.getProcess("missing").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxApiError);
    expect(err).toMatchObject({ code: "not_found" });
    expect(cpCalls()).toEqual([]);
  });

  it("resumes streamOutput from the last delivered offsets", async () => {
    const sandbox = await Sandbox.create(controlPlane, { image: "ubuntu-24.04" }, options);
    await sandbox.startProcess("p", { shell: "printf abc; sleep 0.3; printf def" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    agent.faults.push("cut-stream");

    const chunks: OutputChunk[] = [];
    for await (const chunk of sandbox.streamOutput("p", { follow: true })) {
      chunks.push(chunk);
    }

    expect(chunks.at(-1)).toMatchObject({ type: "exit", state: "exited", exitCode: 0 });
    const stdout = Buffer.concat(
      chunks.flatMap((c) => (c.type === "stdout" ? [c.data] : [])),
    ).toString();
    expect(stdout).toBe("abcdef");
    const outputRequests = agentPaths().filter((p) => p.startsWith("/v1/processes/p/output"));
    expect(outputRequests).toHaveLength(2);
    expect(outputRequests[1]).toContain("stdout_from=3");
  });

  it("does not resume a stream that hit the caller's idleTimeoutMs", async () => {
    const sandbox = await Sandbox.create(controlPlane, { baseImage: "ubuntu-24.04" }, options);
    await sandbox.startProcess("quiet", { shell: "echo hi; sleep 30" });
    agent.faults.push("stall");

    const error = await (async () => {
      for await (const _ of sandbox.streamOutput("quiet", { follow: true, idleTimeoutMs: 100 }));
    })().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(SandboxTransportError);
    expect(agentPaths().filter((p) => p.startsWith("/v1/processes/quiet/output"))).toHaveLength(1);
  });
});
