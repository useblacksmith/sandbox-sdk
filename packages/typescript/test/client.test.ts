import { getEventListeners } from "node:events";
import { mkdir, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxApiError, SandboxClient, SandboxTransportError } from "../src/index.js";
import type { OutputChunk } from "../src/index.js";
import { FakeAgent } from "./fake-agent.js";
import { FakeRouter } from "./fake-router.js";
import { requestUrl } from "./request-url.js";

const TOKEN = "valid-token";
let agent: FakeAgent;

beforeAll(async () => {
  agent = await new FakeAgent().start();
  agent.validTokens.add(TOKEN);
});
afterAll(() => agent.stop());
beforeEach(() => {
  agent.requests.length = 0;
  agent.faults.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

function client(overrides: Partial<ConstructorParameters<typeof SandboxClient>[0]> = {}) {
  return new SandboxClient({
    baseUrl: agent.url,
    token: TOKEN,
    retry: { baseDelayMs: 1, maxDelayMs: 5 },
    ...overrides,
  });
}

function decode(chunks: OutputChunk[], type: "stdout" | "stderr"): string {
  const parts = chunks.flatMap((c) => (c.type === type ? [c.data] : []));
  return Buffer.concat(parts).toString("utf8");
}

/** Never answers; rejects with the abort reason when the request's signal fires. */
const stalledFetch: typeof fetch = (_input, init) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
  });

describe("construction", () => {
  it("expands hostname to https://<hostname>/v1", () => {
    const c = new SandboxClient({ hostname: "sbx-1.sandboxes.example.com", token: TOKEN });
    expect(c.baseUrl).toBe("https://sbx-1.sandboxes.example.com/v1");
  });

  it("normalises a trailing slash on baseUrl", () => {
    const c = new SandboxClient({ baseUrl: "http://127.0.0.1:9/v1/", token: TOKEN });
    expect(c.baseUrl).toBe("http://127.0.0.1:9/v1");
  });

  it("defaults a bare origin to /v1", () => {
    const c = new SandboxClient({ baseUrl: "https://sbx-1.example.com", token: TOKEN });
    expect(c.baseUrl).toBe("https://sbx-1.example.com/v1");
  });

  it("rejects ambiguous options", () => {
    expect(
      () => new SandboxClient({ baseUrl: "http://x/v1", hostname: "x", token: TOKEN }),
    ).toThrow(TypeError);
    expect(() => new SandboxClient({ baseUrl: "http://x/v1" })).toThrow(TypeError);
    expect(
      () =>
        new SandboxClient({
          baseUrl: "http://x/v1",
          token: TOKEN,
          tokenProvider: async () => ({ token: "", expiresAt: new Date() }),
        }),
    ).toThrow(TypeError);
  });
});

describe("activity", () => {
  it("marks opted-in process observations and keeps ordinary reads passive", async () => {
    const requests: Array<{ path: string; activity: string | null }> = [];
    const c = client({
      fetch: async (input, init) => {
        const path = new URL(requestUrl(input)).pathname;
        requests.push({ path, activity: new Headers(init?.headers).get("X-Sandbox-Activity") });
        return path.endsWith("/output")
          ? new Response('{"type":"stdout","offset":0,"data":"cmVhZHkK"}\n')
          : Response.json({ id: "process-1", state: "running" });
      },
    });
    expect(await c.getProcess("process-1", { activity: "active" })).toMatchObject({
      id: "process-1",
      state: "running",
    });
    const chunks: OutputChunk[] = [];
    for await (const chunk of c.streamOutput("process-1", { activity: "active" }))
      chunks.push(chunk);
    expect(decode(chunks, "stdout")).toBe("ready\n");
    await c.getProcess("process-1");
    const passiveChunks: OutputChunk[] = [];
    for await (const chunk of c.streamOutput("process-1")) passiveChunks.push(chunk);
    expect(decode(passiveChunks, "stdout")).toBe("ready\n");
    expect(requests).toEqual([
      { path: "/v1/processes/process-1", activity: "active" },
      { path: "/v1/processes/process-1/output", activity: "active" },
      { path: "/v1/processes/process-1", activity: null },
      { path: "/v1/processes/process-1/output", activity: null },
    ]);
  });
});

describe("auth", () => {
  it("does not send a token to /health", async () => {
    await expect(client().health()).resolves.toEqual({ status: "ok" });
    expect(agent.requests[0]?.authorization).toBeNull();
  });

  it("sends Bearer <token> on authenticated calls", async () => {
    await client().listProcesses();
    expect(agent.requests[0]?.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("maps a bad token to SandboxApiError{unauthorized, 401}", async () => {
    const error = await client({ token: "nope" })
      .listProcesses()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SandboxApiError);
    expect(error).toMatchObject({ code: "unauthorized", status: 401 });
  });

  it("refreshes once via tokenProvider after 401 token_expired and replays the request", async () => {
    agent.validTokens.add("second");
    agent.expiredTokens.add("first");
    const minted: string[] = [];
    const c = client({
      token: undefined,
      tokenProvider: async () => {
        const token = minted.length === 0 ? "first" : "second";
        minted.push(token);
        return { token, expiresAt: new Date(Date.now() + 3_600_000) };
      },
    });
    await expect(c.listProcesses()).resolves.toEqual([]);
    expect(minted).toEqual(["first", "second"]);
    expect(agent.requests.map((r) => r.authorization)).toEqual(["Bearer first", "Bearer second"]);
  });

  it("gives up after one refresh when the new token is also expired", async () => {
    agent.expiredTokens.add("stale");
    let mints = 0;
    const c = client({
      token: undefined,
      tokenProvider: async () => {
        mints++;
        return { token: "stale", expiresAt: new Date(Date.now() + 3_600_000) };
      },
    });
    await expect(c.listProcesses()).rejects.toMatchObject({ code: "token_expired" });
    expect(mints).toBe(2);
  });

  it("surfaces token_expired directly for a fixed token", async () => {
    agent.expiredTokens.add("fixed-expired");
    await expect(client({ token: "fixed-expired" }).listProcesses()).rejects.toMatchObject({
      code: "token_expired",
    });
    expect(agent.requests).toHaveLength(1);
  });

  it("refreshes proactively at 80% of the token lifetime", async () => {
    agent.validTokens.add("t1").add("t2");
    vi.useFakeTimers({ toFake: ["Date"] });
    let mints = 0;
    const c = new SandboxClient({
      baseUrl: agent.url,
      tokenProvider: async () => {
        mints++;
        return { token: `t${mints}`, expiresAt: new Date(Date.now() + 10_000) };
      },
    });
    await c.listProcesses();
    vi.advanceTimersByTime(7_900);
    await c.listProcesses();
    expect(mints).toBe(1);
    vi.advanceTimersByTime(200);
    await c.listProcesses();
    expect(mints).toBe(2);
    expect(agent.requests.at(-1)?.authorization).toBe("Bearer t2");
  });
});

describe("exec", () => {
  it("runs a shell command and returns the wire response", async () => {
    const result = await client().exec({ shell: "echo out; echo err >&2; exit 3" });
    expect(result).toMatchObject({
      exit_code: 3,
      stdout: "out\n",
      stderr: "err\n",
      timed_out: false,
    });
  });

  it("passes cwd, env and argv", async () => {
    const result = await client().exec({
      cmd: ["sh", "-c", "pwd; echo $FOO"],
      cwd: "/",
      env: { FOO: "bar" },
    });
    expect(result.stdout).toBe("/\nbar\n");
  });

  it("reports timed_out when the command is cut off", async () => {
    const result = await client().exec({ shell: "echo partial; sleep 30", timeoutSeconds: 1 });
    expect(result.timed_out).toBe(true);
    expect(result.signal).toBe("SIGKILL");
    expect(result.stdout).toBe("partial\n");
  });

  it("maps invalid_argument when neither cmd nor shell is given", async () => {
    await expect(client().exec({})).rejects.toMatchObject({
      code: "invalid_argument",
      status: 400,
    });
  });

  const execPaths = () => agent.requests.map((r) => `${r.method} ${r.path}`);
  const putsFor = () => agent.requests.filter((r) => r.method === "PUT").map((r) => r.path);

  it("runs on the process primitive under one id and deletes the process afterwards", async () => {
    await client().exec({ shell: "true" });
    const [put, output, del] = execPaths();
    const id = put!.slice("PUT /v1/processes/".length);
    expect(id).toMatch(/^exec-[0-9a-f-]{36}$/);
    expect(output).toBe(`GET /v1/processes/${id}/output?stdout_from=0&stderr_from=0&follow=true`);
    expect(del).toBe(`DELETE /v1/processes/${id}`);
    await expect(client().getProcess(id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("retries a connection the agent closed before answering, under the same id", async () => {
    agent.faults.push("reset");
    const result = await client().exec({ shell: "echo once" });
    expect(result).toMatchObject({ exit_code: 0, stdout: "once\n" });
    const puts = putsFor();
    expect(puts).toHaveLength(2);
    expect(puts[0]).toBe(puts[1]);
  });

  it("runs the command once when the start was handled but its response lost", async () => {
    const marker = join(agent.fsRoot, "ran");
    agent.faults.push("lost-response");
    const result = await client().exec({ shell: `echo run >> ${marker}; cat ${marker}` });
    expect(result).toMatchObject({ exit_code: 0, stdout: "run\n" });
    expect(putsFor()).toHaveLength(2);
    expect(await fsReadFile(marker, "utf8")).toBe("run\n");
  });

  it("resumes the output stream by offset after a mid-stream cut", async () => {
    agent.faults.push("pass", "cut-stream");
    const result = await client().exec({ shell: "echo first; sleep 0.2; echo second" });
    expect(result).toMatchObject({ exit_code: 0, stdout: "first\nsecond\n", truncated: false });
    const outputs = agent.requests.filter((r) => r.path.includes("/output"));
    expect(outputs).toHaveLength(2);
    expect(outputs[1]!.path).toContain("stdout_from=6");
  });

  it("gives up with SandboxTransportError once the retry budget is spent", async () => {
    agent.faults.push("reset", "reset", "reset");
    const error = await client()
      .exec({ shell: "true" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SandboxTransportError);
    expect(error).toMatchObject({ method: "PUT", attempts: 3 });
  });

  it("leaves the process behind after a transport failure so a replay still runs it once", async () => {
    const marker = join(agent.fsRoot, "ran-once");
    const spec = {
      shell: `echo run >> ${marker}; for i in $(seq 10); do echo tick; sleep 0.1; done; cat ${marker}`,
    };
    agent.faults.push("pass", "cut-stream", "cut-stream", "cut-stream");
    const c = client();
    const first = await c.exec(spec, { processId: "replayed" }).catch((e: unknown) => e);
    expect(first).toBeInstanceOf(SandboxTransportError);
    expect(agent.requests.filter((r) => r.method === "DELETE")).toHaveLength(0);

    const result = await c.exec(spec, { processId: "replayed" });
    expect(result).toMatchObject({ exit_code: 0, stdout: `${"tick\n".repeat(10)}run\n` });
    expect(await fsReadFile(marker, "utf8")).toBe("run\n");
    expect(agent.requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
  });

  it("deletes a process under a generated id after a transport failure, since nobody can replay it", async () => {
    agent.faults.push("pass", "cut-stream", "cut-stream", "cut-stream");
    const error = await client()
      .exec({ shell: "for i in $(seq 10); do echo tick; sleep 0.1; done" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SandboxTransportError);
    expect(agent.requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
    expect(await client().listProcesses()).toEqual([]);
  });

  it("does not delete a process it failed to start under a taken id", async () => {
    const c = client();
    await c.startProcess("taken", { shell: "sleep 5" });
    await expect(c.exec({ shell: "true" }, { processId: "taken" })).rejects.toMatchObject({
      code: "conflict",
    });
    expect((await c.getProcess("taken")).state).toBe("running");
    await c.killProcess("taken");
  });

  it("kills the process when the caller aborts", async () => {
    const c = client();
    const abort = new AbortController();
    const pending = c.exec(
      { shell: "sleep 5", timeoutSeconds: 0 },
      {
        processId: "aborted",
        signal: abort.signal,
      },
    );
    await vi.waitFor(() => expect(execPaths().some((p) => p.includes("/output"))).toBe(true));
    abort.abort(new Error("caller gave up"));
    await expect(pending).rejects.toThrow("caller gave up");
    expect(execPaths().at(-1)).toBe("DELETE /v1/processes/aborted");
    await expect(c.getProcess("aborted")).rejects.toMatchObject({ code: "not_found" });
  });

  it("deletes the process when the deadline cuts the start short, since the agent may have run it", async () => {
    agent.faults.push("lost-response");
    const c = client({ retry: { baseDelayMs: 1_000, maxDelayMs: 1_000 } });
    const error = await c
      .exec({ shell: "sleep 5", timeoutSeconds: 0 }, { timeoutMs: 300 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SandboxTransportError);
    expect(error).toMatchObject({ method: "EXEC" });
    expect(execPaths().at(-1)).toMatch(/^DELETE \/v1\/processes\/exec-/);
    expect(await c.listProcesses()).toEqual([]);
  });

  it("gives the cleanup DELETE one time bound across all its retries", async () => {
    agent.faults.push("pass", "pass", "stall");
    const before = Date.now();
    await client().exec({ shell: "true" });
    expect(Date.now() - before).toBeLessThan(8_000);
    expect(agent.requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
  }, 15_000);

  it("reports the command's own duration when a replay attaches to a finished process", async () => {
    const c = client();
    await c.startProcess("finished", { shell: "true", timeoutSeconds: 300 });
    await vi.waitFor(async () => expect((await c.getProcess("finished")).state).toBe("exited"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const result = await c.exec({ shell: "true" }, { processId: "finished" });
    expect(result).toMatchObject({ exit_code: 0 });
    expect(result.duration_ms).toBeLessThan(300);
  });

  it("reads a timeoutSeconds above the agent's maximum as unlimited, like /exec", async () => {
    const bodies: string[] = [];
    const recording: typeof fetch = (input, init) => {
      if (init?.method === "PUT" && typeof init.body === "string") bodies.push(init.body);
      return fetch(input, init);
    };
    await client({ fetch: recording }).exec({ shell: "true", timeoutSeconds: 31_622_401 });
    expect(bodies.map((b) => JSON.parse(b) as unknown)).toEqual([
      { shell: "true", timeout_seconds: 0 },
    ]);
  });

  it("survives a stale-DNS router that holds the connection and then closes it", async () => {
    const router = await new FakeRouter(agent.url, 1).start();
    try {
      const result = await client({ baseUrl: router.url }).exec({ shell: "echo routed" });
      expect(result).toMatchObject({ exit_code: 0, stdout: "routed\n" });
      expect(putsFor()).toHaveLength(1);
    } finally {
      await router.stop();
    }
  });

  it("outlives the client's per-request timeout while the command runs", async () => {
    const result = await client({ timeoutMs: 50 }).exec({ shell: "sleep 0.3" });
    expect(result).toMatchObject({ exit_code: 0, timed_out: false });
  });

  it("bounds the whole call by timeoutSeconds (agent default 300s) plus timeoutMs", async () => {
    vi.useFakeTimers();
    // Starts and deletes answer at once; the output stream never ends on its own.
    const hangingOutput: typeof fetch = (input, init) => {
      const url = requestUrl(input);
      if (url.includes("/output")) {
        const signal = init?.signal;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            signal?.addEventListener("abort", () => controller.error(signal.reason));
          },
        });
        return Promise.resolve(
          new Response(body, {
            status: 200,
            headers: { "content-type": "application/x-ndjson" },
          }),
        );
      }
      if (init?.method === "DELETE") return Promise.resolve(new Response(null, { status: 204 }));
      const id = url.slice(url.lastIndexOf("/") + 1);
      const body = JSON.stringify({
        id,
        state: "running",
        spec: {},
        created_at: "2026-01-01T00:00:00Z",
        stdout: { total_bytes: 0, retained_from: 0, truncated: false },
        stderr: { total_bytes: 0, retained_from: 0, truncated: false },
      });
      return Promise.resolve(new Response(body, { status: 201 }));
    };
    const stalled = client({ timeoutMs: 1_000, retry: { maxAttempts: 1 }, fetch: hangingOutput });
    const settled = { explicit: false, defaulted: false, unlimited: false, overridden: false };
    const explicit = stalled.exec({ shell: "sleep 60", timeoutSeconds: 60 });
    const defaulted = stalled.exec({ shell: "sleep 600" });
    const unlimited = stalled.exec({ shell: "sleep 600", timeoutSeconds: 0 });
    const overridden = stalled.exec({ shell: "sleep 60", timeoutSeconds: 60 }, { timeoutMs: 10 });
    void explicit.catch(() => (settled.explicit = true));
    void defaulted.catch(() => (settled.defaulted = true));
    void unlimited.catch(() => (settled.unlimited = true));
    void overridden.catch(() => (settled.overridden = true));

    await vi.advanceTimersByTimeAsync(60_999);
    expect(settled).toEqual({
      explicit: false,
      defaulted: false,
      unlimited: false,
      overridden: true,
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(settled.explicit).toBe(true);
    await expect(explicit).rejects.toMatchObject({
      method: "EXEC",
      cause: { name: "TimeoutError" },
    });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(settled).toMatchObject({ defaulted: true, unlimited: false });
    await vi.advanceTimersByTimeAsync(24 * 3_600_000);
    expect(settled.unlimited).toBe(false);
    await expect(overridden).rejects.toBeInstanceOf(SandboxTransportError);
  });

  it("fails the start leg at the client's timeoutMs instead of waiting out the command", async () => {
    vi.useFakeTimers();
    const stalled = client({ timeoutMs: 1_000, retry: { maxAttempts: 1 }, fetch: stalledFetch });
    const pending = stalled.exec({ shell: "sleep 60", timeoutSeconds: 60 });
    let settled = false;
    void pending.catch(() => (settled = true));
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    // the start's outcome is unknown, so the cleanup DELETE runs (and times out) first
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).rejects.toMatchObject({ method: "PUT", attempts: 1 });
  });
});

describe("processes", () => {
  it("start is idempotent: 201 then 200 for the same spec, 409 for a different one", async () => {
    const c = client();
    const first = await c.startProcess("idem", { shell: "sleep 5" });
    expect(first.created).toBe(true);
    expect(first.process).toMatchObject({
      id: "idem",
      state: "running",
      spec: { shell: "sleep 5" },
    });

    const again = await c.startProcess("idem", { shell: "sleep 5", env: {} });
    expect(again.created).toBe(false);
    expect(again.process.id).toBe("idem");

    const conflict = await c.startProcess("idem", { shell: "sleep 6" }).catch((e: unknown) => e);
    expect(conflict).toBeInstanceOf(SandboxApiError);
    expect(conflict).toMatchObject({
      code: "conflict",
      status: 409,
      details: { existing_spec: { shell: "sleep 5" } },
    });

    expect((await c.listProcesses()).map((p) => p.id)).toContain("idem");
    await c.killProcess("idem");
    await expect(c.getProcess("idem")).rejects.toMatchObject({ code: "not_found", status: 404 });
  });

  it("sends timeoutSeconds as timeout_seconds and reports timed_out", async () => {
    const c = client();
    await c.startProcess("slow", { shell: "sleep 30", timeoutSeconds: 1 });
    const chunks: OutputChunk[] = [];
    for await (const chunk of c.streamOutput("slow", { follow: true })) chunks.push(chunk);
    expect(chunks.at(-1)).toMatchObject({ type: "exit", state: "killed", timedOut: true });
    await c.killProcess("slow");
  });

  it("kill succeeds when the 204 is lost and the replay finds the process gone", async () => {
    const c = client();
    await c.startProcess("lost", { shell: "sleep 30" });
    agent.requests.length = 0;
    agent.faults.push("lost-response");
    await c.killProcess("lost");
    expect(agent.requests.filter((r) => r.method === "DELETE")).toHaveLength(2);
    await expect(c.getProcess("lost")).rejects.toMatchObject({ code: "not_found" });
    await expect(c.killProcess("lost")).rejects.toMatchObject({ code: "not_found", status: 404 });
  });
});

describe("ports", () => {
  it("expose is idempotent: 201 then 200 with the same hostname; list and unexpose", async () => {
    const c = client();
    const first = await c.exposePort(8080);
    expect(first.created).toBe(true);
    expect(first.exposure).toMatchObject({
      port: 8080,
      rand: expect.stringMatching(/^[a-z]{8}$/) as string,
      hostname: `port-8080-${first.exposure.rand}-${agent.sandboxId}.${agent.sandboxDomain}`,
      url: `https://port-8080-${first.exposure.rand}-${agent.sandboxId}.${agent.sandboxDomain}`,
    });
    expect(Date.parse(first.exposure.created_at)).not.toBeNaN();

    const again = await c.exposePort(8080);
    expect(again.created).toBe(false);
    expect(again.exposure).toEqual(first.exposure);

    await c.exposePort(3000);
    expect((await c.listPorts()).map((p) => p.port)).toEqual([3000, 8080]);

    await c.unexposePort(8080);
    await c.unexposePort(3000);
    expect(await c.listPorts()).toEqual([]);
    await expect(c.unexposePort(8080)).rejects.toMatchObject({ code: "not_found", status: 404 });
  });

  it("surfaces the agent's invalid_argument and conflict errors", async () => {
    const c = client();
    await expect(c.exposePort(7777)).rejects.toMatchObject({
      code: "invalid_argument",
      status: 400,
    });
    for (let port = 10_000; port < 10_032; port++) await c.exposePort(port);
    await expect(c.exposePort(10_032)).rejects.toMatchObject({ code: "conflict", status: 409 });
    for (let port = 10_000; port < 10_032; port++) await c.unexposePort(port);
  });

  it("rejects a port outside 1..65535 before sending anything", async () => {
    const c = client();
    for (const port of [0, 65536, 1.5, Number.NaN]) {
      await expect(c.exposePort(port)).rejects.toBeInstanceOf(RangeError);
      await expect(c.unexposePort(port)).rejects.toBeInstanceOf(RangeError);
    }
    expect(agent.requests).toEqual([]);
  });

  it("expose replays after a lost response and still reports the exposure as created", async () => {
    const c = client();
    agent.faults.push("lost-response");
    const { created, exposure } = await c.exposePort(9090);
    expect(agent.requests.filter((r) => r.method === "PUT")).toHaveLength(2);
    // The first attempt was handled, so the replay sees an existing exposure.
    expect(created).toBe(false);
    expect(exposure.port).toBe(9090);
    await c.unexposePort(9090);
  });

  it("unexpose succeeds when the 204 is lost and the replay finds the port gone", async () => {
    const c = client();
    await c.exposePort(9091);
    agent.requests.length = 0;
    agent.faults.push("lost-response");
    await c.unexposePort(9091);
    expect(agent.requests.filter((r) => r.method === "DELETE")).toHaveLength(2);
    expect(await c.listPorts()).toEqual([]);
  });
});

describe("disks", () => {
  const ENTITY = 4242;
  const JWT = "entity-jwt-4242";

  beforeEach(() => {
    agent.restartVm();
    agent.entityJwts.clear();
    agent.entityJwts.set(ENTITY, JWT);
  });

  it("attach is idempotent per entity: 201 then 200 with the same disk; list and detach", async () => {
    const c = client();
    const first = await c.attachDisk({ entityId: ENTITY, entityJwt: JWT, mountPath: "/cache" });
    expect(first.created).toBe(true);
    expect(first.disk).toMatchObject({ slot: 2, entity_id: ENTITY, mount_path: "/cache" });
    expect(JSON.stringify(first.disk)).not.toContain(JWT);

    const again = await c.attachDisk({ entityId: ENTITY, entityJwt: JWT, mountPath: "/cache" });
    expect(again).toEqual({ disk: first.disk, created: false });
    expect(await c.listDisks()).toEqual([first.disk]);

    const detached = await c.detachDisk(2);
    expect(detached.detached_at).toBeDefined();
    expect(await c.detachDisk(2)).toEqual(detached);
    expect(await c.listDisks()).toEqual([detached]);
    await expect(c.detachDisk(3)).rejects.toMatchObject({ code: "not_found", status: 404 });
  });

  it("attaches a bare block device when no mount path is given", async () => {
    const { disk } = await client().attachDisk({ entityId: ENTITY, entityJwt: JWT });
    expect(disk.mount_path).toBeUndefined();
  });

  it("surfaces the host's forbidden, not_found and conflict errors", async () => {
    const c = client();
    await expect(c.attachDisk({ entityId: ENTITY, entityJwt: "other" })).rejects.toMatchObject({
      code: "forbidden",
      status: 403,
    });
    await expect(c.attachDisk({ entityId: 7, entityJwt: JWT })).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });
    await c.attachDisk({ entityId: ENTITY, entityJwt: JWT, mountPath: "/cache" });
    await expect(
      c.attachDisk({ entityId: ENTITY, entityJwt: JWT, mountPath: "/elsewhere" }),
    ).rejects.toMatchObject({ code: "conflict", status: 409 });
  });

  it("rejects a slot outside 2..11 before sending anything", async () => {
    const c = client();
    for (const slot of [1, 12, 2.5, Number.NaN]) {
      await expect(c.detachDisk(slot)).rejects.toBeInstanceOf(RangeError);
    }
    expect(agent.requests).toEqual([]);
  });

  it("attach and detach surface a lost response instead of replaying it", async () => {
    const c = client();
    agent.faults.push("lost-response");
    await expect(c.attachDisk({ entityId: ENTITY, entityJwt: JWT })).rejects.toBeInstanceOf(
      SandboxTransportError,
    );
    agent.faults.push("lost-response");
    await expect(c.detachDisk(3)).rejects.toBeInstanceOf(SandboxTransportError);
    expect(agent.requests.map((r) => r.method)).toEqual(["POST", "DELETE"]);
  });

  it("gives attach longer than the client's per-request timeout", async () => {
    const c = client({ timeoutMs: 20, retry: { maxAttempts: 1 } });
    agent.attachDelayMs = 200;
    try {
      const { created } = await c.attachDisk({ entityId: ENTITY, entityJwt: JWT });
      expect(created).toBe(true);
      const err = await c
        .attachDisk({ entityId: ENTITY, entityJwt: JWT }, { timeoutMs: 20 })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SandboxTransportError);
    } finally {
      agent.attachDelayMs = 0;
    }
  });
});

describe("streamOutput", () => {
  it("yields chunks incrementally with follow=true and ends with exit", async () => {
    const c = client();
    await c.startProcess("ticker", {
      shell: "echo one; sleep 0.3; echo two >&2; sleep 0.3; echo three; exit 7",
    });
    const seenAt: number[] = [];
    const chunks: OutputChunk[] = [];
    for await (const chunk of c.streamOutput("ticker", { follow: true })) {
      chunks.push(chunk);
      seenAt.push(Date.now());
    }
    expect(decode(chunks, "stdout")).toBe("one\nthree\n");
    expect(decode(chunks, "stderr")).toBe("two\n");
    expect(chunks.at(-1)).toEqual({
      type: "exit",
      state: "exited",
      exitCode: 7,
      signal: undefined,
      timedOut: false,
    });
    expect(seenAt.at(-1)! - seenAt[0]!).toBeGreaterThan(400);
    await c.killProcess("ticker");
  });

  it("resumes from byte offsets and honours stream=", async () => {
    const c = client();
    await c.startProcess("offsets", { shell: "printf abcdef; printf XY >&2" });
    const all: OutputChunk[] = [];
    for await (const chunk of c.streamOutput("offsets", { follow: true })) all.push(chunk);
    expect(decode(all, "stdout")).toBe("abcdef");

    const resumed: OutputChunk[] = [];
    for await (const chunk of c.streamOutput("offsets", { stdoutFrom: 4, stream: "stdout" }))
      resumed.push(chunk);
    expect(resumed[0]).toMatchObject({ type: "stdout", offset: 4 });
    expect(decode(resumed, "stdout")).toBe("ef");
    expect(decode(resumed, "stderr")).toBe("");
    expect(agent.requests.at(-1)?.path).toContain("stdout_from=4");
    await c.killProcess("offsets");
  });

  it("stops on AbortSignal without a transport error", async () => {
    const c = client();
    await c.startProcess("forever", { shell: "echo hi; sleep 30" });
    const controller = new AbortController();
    const iterator = c.streamOutput("forever", { follow: true, signal: controller.signal });
    const first = await iterator.next();
    expect(first.value).toMatchObject({ type: "stdout" });
    controller.abort();
    const error = await iterator.next().catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(SandboxTransportError);
    expect(error).toMatchObject({ name: "AbortError" });
    await c.killProcess("forever");
  });

  it("unhooks from the caller's AbortSignal once the stream ends", async () => {
    const c = client();
    const controller = new AbortController();
    await c.startProcess("brief", { shell: "echo hi" });
    for await (const _ of c.streamOutput("brief", { follow: true, signal: controller.signal }));
    await c.writeFile("/brief.txt", "hi");
    const { stream } = await c.readFileStream("/brief.txt", { signal: controller.signal });
    for await (const _ of stream);
    const cancelled = await c.readFileStream("/brief.txt", { signal: controller.signal });
    await cancelled.stream.cancel();
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    await c.killProcess("brief");
  });

  it("maps a missing process to not_found before yielding", async () => {
    const iterator = client().streamOutput("nope");
    await expect(iterator.next()).rejects.toMatchObject({ code: "not_found" });
  });

  it("disables the runtime idle timeout for streams only", async () => {
    const timeouts: Array<{ path: string; timeout: unknown }> = [];
    const c = client({
      fetch: (input, init) => {
        timeouts.push({
          path: new URL(requestUrl(input)).pathname,
          timeout: init && "timeout" in init ? init.timeout : undefined,
        });
        return fetch(input, init);
      },
    });
    await c.startProcess("quiet", { shell: "echo hi" });
    for await (const _ of c.streamOutput("quiet", { follow: true }));
    await c.writeFile("/quiet.txt", "hi");
    for await (const _ of (await c.readFileStream("/quiet.txt")).stream);
    await c.readFile("/quiet.txt");
    expect(timeouts).toEqual([
      { path: "/v1/processes/quiet", timeout: undefined },
      { path: "/v1/processes/quiet/output", timeout: false },
      { path: "/v1/fs/file", timeout: undefined },
      { path: "/v1/fs/file", timeout: false },
      { path: "/v1/fs/file", timeout: undefined },
    ]);
    await c.killProcess("quiet");
  });

  it("fails a quiet stream after idleTimeoutMs as SandboxTransportError", async () => {
    const c = client();
    await c.startProcess("stalled", { shell: "echo hi; sleep 30" });
    agent.faults.push("stall");
    const iterator = c.streamOutput("stalled", { follow: true, idleTimeoutMs: 100 });
    expect((await iterator.next()).value).toMatchObject({ type: "stdout" });
    const error = await iterator.next().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SandboxTransportError);
    expect((error as SandboxTransportError).cause).toMatchObject({ name: "TimeoutError" });
    await c.killProcess("stalled");
  });

  it("rejects an output event that does not match the agent spec", async () => {
    const c = client();
    await c.startProcess("garbage", { shell: "echo hi" });
    agent.faults.push("garbage-event");
    const error = await (async () => {
      for await (const _ of c.streamOutput("garbage"));
    })().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SandboxTransportError);
    expect((error as SandboxTransportError).cause).toMatchObject({
      name: "SandboxError",
      message: 'malformed output event: bad offset "zero"',
    });
    await c.killProcess("garbage");
  });

  it("does not run the idle timer while the consumer is busy", async () => {
    const c = client();
    await c.startProcess("busy", { shell: "echo hi; sleep 30" });
    agent.faults.push("stall");
    const iterator = c.streamOutput("busy", { follow: true, idleTimeoutMs: 100 });
    expect((await iterator.next()).value).toMatchObject({ type: "stdout" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const resumedAt = Date.now();
    const error = await iterator.next().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SandboxTransportError);
    expect(Date.now() - resumedAt).toBeGreaterThanOrEqual(90);
    await c.killProcess("busy");
  });

  it("keeps a slow but live stream open past idleTimeoutMs", async () => {
    const c = client();
    await c.startProcess("drip", { shell: "echo a; sleep 0.15; echo b; sleep 0.15; echo c" });
    const chunks: OutputChunk[] = [];
    for await (const chunk of c.streamOutput("drip", { follow: true, idleTimeoutMs: 1_000 }))
      chunks.push(chunk);
    expect(decode(chunks, "stdout")).toBe("a\nb\nc\n");
    await c.killProcess("drip");
  });
});

describe("files", () => {
  it("round-trips a string with mode and mkdirParents", async () => {
    const c = client();
    const info = await c.writeFile("/deep/nested/hello.txt", "héllo", {
      mode: 0o600,
      mkdirParents: true,
    });
    expect(info).toMatchObject({ path: "/deep/nested/hello.txt", size: 6, mode: "0600" });
    expect(agent.requests.at(-1)?.path).toContain("mode=0600");
    expect(agent.requests.at(-1)?.path).toContain("mkdir_parents=true");

    const read = await c.readFile("/deep/nested/hello.txt");
    expect(new TextDecoder().decode(read.data)).toBe("héllo");
    expect(read).toMatchObject({ path: "/deep/nested/hello.txt", mode: "0600", size: 6 });
    expect(read.lastModified).toBeInstanceOf(Date);
    expect(read.requestId).toBeTruthy();
  });

  it("encodes a numeric mode below 0o100 with three octal digits", async () => {
    const info = await client().writeFile("/locked.txt", "x", { mode: 0o040 });
    expect(info.mode).toBe("0040");
    expect(agent.requests.at(-1)?.path).toContain("mode=0040");
  });

  it("fails with not_found when the parent is missing and mkdirParents is off", async () => {
    await expect(client().writeFile("/missing/x", "1")).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(client().readFile("/missing/x")).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });
  });

  it("round-trips a multi-MB Uint8Array and streams it back", async () => {
    const c = client();
    const big = new Uint8Array(5 * 1024 * 1024);
    for (let i = 0; i < big.length; i += 4096) big[i] = i & 0xff;
    const info = await c.writeFile("/big.bin", big);
    expect(info.size).toBe(big.length);

    const read = await c.readFile("/big.bin");
    expect(read.data.byteLength).toBe(big.length);
    expect(Buffer.from(read.data).equals(Buffer.from(big))).toBe(true);

    const streamed = await c.readFileStream("/big.bin");
    expect(streamed.size).toBe(big.length);
    let total = 0;
    let reads = 0;
    for await (const chunk of streamed.stream) {
      total += chunk.byteLength;
      reads++;
    }
    expect(total).toBe(big.length);
    expect(reads).toBeGreaterThan(1);
  });

  it("surfaces a mid-body disconnect on readFileStream as SandboxTransportError", async () => {
    const c = client();
    await c.writeFile("/cut.bin", new Uint8Array(256 * 1024));
    agent.faults.push("cut-body");
    const { stream } = await c.readFileStream("/cut.bin");
    const error = await (async () => {
      for await (const _ of stream);
    })().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SandboxTransportError);
    expect(error).toMatchObject({ method: "GET", attempts: 1 });
    expect((error as SandboxTransportError).url).toContain("/fs/file");
  });

  it("fails a stalled readFileStream body after idleTimeoutMs", async () => {
    const c = client();
    await c.writeFile("/stall.bin", new Uint8Array(256 * 1024));
    agent.faults.push("stall");
    const { stream } = await c.readFileStream("/stall.bin", { idleTimeoutMs: 100 });
    let received = 0;
    const error = await (async () => {
      for await (const chunk of stream) received += chunk.byteLength;
    })().catch((e: unknown) => e);
    expect(received).toBeGreaterThan(0);
    expect(received).toBeLessThan(256 * 1024);
    expect(error).toBeInstanceOf(SandboxTransportError);
    expect((error as SandboxTransportError).cause).toMatchObject({ name: "TimeoutError" });
  });

  it("uploads a ReadableStream body without retrying it", async () => {
    const c = client();
    const pieces = ["abc", "def", "ghi"].map((s) => new TextEncoder().encode(s));
    const info = await c.writeFile(
      "/streamed.txt",
      Readable.toWeb(Readable.from(pieces)) as ReadableStream<Uint8Array>,
    );
    expect(info.size).toBe(9);
    expect(await fsReadFile(join(agent.fsRoot, "streamed.txt"), "utf8")).toBe("abcdefghi");

    agent.faults.push("reset");
    const error = await c
      .writeFile(
        "/streamed2.txt",
        Readable.toWeb(Readable.from(pieces)) as ReadableStream<Uint8Array>,
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SandboxTransportError);
    expect(error).toMatchObject({ attempts: 1 });
  });

  it("retries an in-memory upload after a transport failure", async () => {
    agent.faults.push("reset");
    const info = await client().writeFile("/retried.txt", "ok");
    expect(info.size).toBe(2);
    expect(agent.requests.filter((r) => r.method === "PUT")).toHaveLength(2);
  });

  it("reads files the agent already has", async () => {
    await mkdir(join(agent.fsRoot, "etc"), { recursive: true });
    await fsWriteFile(join(agent.fsRoot, "etc", "motd"), "welcome\n", { mode: 0o644 });
    const read = await client().readFile("/etc/motd");
    expect(new TextDecoder().decode(read.data)).toBe("welcome\n");
    expect(read.mode).toBe("0644");
  });
});

describe("errors and retries", () => {
  it("reconnects once for a stale host even with transport retries disabled", async () => {
    const requests: Array<{ url: string; keepalive: boolean | undefined }> = [];
    const c = client({
      retry: { maxAttempts: 1 },
      fetch: async (input, init) => {
        requests.push({ url: requestUrl(input), keepalive: init?.keepalive });
        if (requests.length === 1) {
          return Response.json(
            { error: { code: "not_found", message: "sandbox not found on this host" } },
            { status: 404 },
          );
        }
        return fetch(input, init);
      },
    });
    await expect(c.health()).resolves.toEqual({ status: "ok" });
    expect(requests).toEqual([
      { url: `${agent.url}/health`, keepalive: undefined },
      { url: `${agent.url}/health`, keepalive: false },
    ]);
  });

  it("preserves the process id and body when reconnecting a command start", async () => {
    const requests: Array<{ url: string; body: BodyInit | null | undefined }> = [];
    const c = client({
      fetch: async (input, init) => {
        requests.push({ url: requestUrl(input), body: init?.body });
        if (requests.length === 1) {
          return Response.json(
            { error: { code: "not_found", message: "sandbox not found on this host" } },
            { status: 404 },
          );
        }
        return fetch(input, init);
      },
    });
    try {
      await expect(c.startProcess("relocated", { shell: "true" })).resolves.toMatchObject({
        created: true,
        process: { id: "relocated" },
      });
      expect(requests).toHaveLength(2);
      expect(requests[1]).toEqual(requests[0]);
      expect(agent.requests.filter((r) => r.method === "PUT")).toHaveLength(1);
    } finally {
      await c.killProcess("relocated");
    }
  });

  it.each([
    { status: 404, code: "not_found", message: "no process missing" },
    { status: 503, code: "not_found", message: "sandbox not found on this host" },
    { status: 404, code: "unavailable", message: "sandbox not found on this host" },
  ])("does not reconnect for other API errors: $status $code $message", async (error) => {
    let calls = 0;
    const c = client({
      fetch: async () => {
        calls++;
        return Response.json(
          { error: { code: error.code, message: error.message } },
          { status: error.status },
        );
      },
    });
    await expect(c.getProcess("missing")).rejects.toMatchObject(error);
    expect(calls).toBe(1);
  });

  it.each([false, true])(
    "does not swallow a repeated stale-host error on DELETE (prior transport failure: %s)",
    async (transportFailure) => {
      let calls = 0;
      const c = client({
        fetch: async () => {
          if (++calls === 1 && transportFailure) throw new TypeError("connection reset");
          return Response.json(
            { error: { code: "not_found", message: "sandbox not found on this host" } },
            { status: 404 },
          );
        },
      });
      await expect(c.killProcess("missing")).rejects.toMatchObject({
        status: 404,
        code: "not_found",
        message: "sandbox not found on this host",
      });
      expect(calls).toBe(transportFailure ? 3 : 2);
    },
  );

  it("keeps lost-response DELETE recovery after reconnecting", async () => {
    let calls = 0;
    const c = client({
      fetch: async () => {
        calls++;
        if (calls === 1) throw new TypeError("connection reset");
        return Response.json(
          {
            error: {
              code: "not_found",
              message: calls === 2 ? "sandbox not found on this host" : "no process missing",
            },
          },
          { status: 404 },
        );
      },
    });
    await expect(c.killProcess("missing")).resolves.toBeUndefined();
    expect(calls).toBe(3);
  });

  it("does not replay a streaming upload after a stale-host error", async () => {
    let calls = 0;
    const c = client({
      fetch: async () => {
        calls++;
        return Response.json(
          { error: { code: "not_found", message: "sandbox not found on this host" } },
          { status: 404 },
        );
      },
    });
    const body = new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
    await expect(c.writeFile("/upload", body)).rejects.toMatchObject({
      code: "not_found",
      message: "sandbox not found on this host",
    });
    expect(calls).toBe(1);
  });

  it("honors cancellation before reconnecting", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    let calls = 0;
    const c = client({
      fetch: async () => {
        calls++;
        controller.abort(reason);
        return Response.json(
          { error: { code: "not_found", message: "sandbox not found on this host" } },
          { status: 404 },
        );
      },
    });
    await expect(c.health({ signal: controller.signal })).rejects.toBe(reason);
    expect(calls).toBe(1);
  });

  it("retries idempotent GETs with backoff and succeeds", async () => {
    agent.faults.push("reset", "reset");
    await expect(client().health()).resolves.toEqual({ status: "ok" });
    expect(agent.requests).toHaveLength(3);
  });

  it("gives up after maxAttempts with the cause attached", async () => {
    agent.faults.push("reset", "reset", "reset");
    const error = await client()
      .health()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SandboxTransportError);
    expect(error).toMatchObject({ method: "GET", attempts: 3 });
    expect((error as SandboxTransportError).cause).toBeInstanceOf(Error);
  });

  it("does not retry PUT /processes across a transport failure more than the budget", async () => {
    agent.faults.push("reset");
    const result = await client().startProcess("retried", { shell: "true" });
    expect(result.created).toBe(true);
    expect(agent.requests.filter((r) => r.method === "PUT")).toHaveLength(2);
    await client().killProcess("retried");
  });

  it("turns a non-envelope error body into an internal SandboxApiError", () => {
    const error = SandboxApiError.fromResponse(500, "<html>oops</html>", "rid");
    expect(error).toMatchObject({ code: "internal", status: 500, requestId: "rid" });
    expect(error.details).toEqual({ raw_body: "<html>oops</html>" });
  });

  it("classifies unenveloped 408/504, 502/503 and 507 by status", () => {
    expect(SandboxApiError.fromResponse(408, "").code).toBe("timeout");
    expect(SandboxApiError.fromResponse(504, "").code).toBe("timeout");
    expect(SandboxApiError.fromResponse(502, "<html>bad gateway</html>").code).toBe("unavailable");
    expect(SandboxApiError.fromResponse(503, "").code).toBe("unavailable");
    expect(SandboxApiError.fromResponse(507, "").code).toBe("insufficient_storage");
  });

  it("keeps retry defaults for fields passed as undefined", async () => {
    agent.faults.push("reset", "reset");
    const c = client({ retry: { maxAttempts: undefined, baseDelayMs: 1, maxDelayMs: undefined } });
    await expect(c.health()).resolves.toEqual({ status: "ok" });
    expect(agent.requests).toHaveLength(3);
  });

  it("wraps a failure while reading an error body as SandboxTransportError", async () => {
    const broken = client({
      retry: { maxAttempts: 1 },
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.error(new Error("body reset"));
            },
          }),
          { status: 500 },
        ),
    });
    const error = await broken.health().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SandboxTransportError);
    expect(String((error as Error).cause)).toContain("body reset");
  });

  it("maps a request timeout to SandboxTransportError", async () => {
    const stalled = client({
      timeoutMs: 20,
      retry: { maxAttempts: 1 },
      fetch: stalledFetch,
    });
    const error = await stalled.health().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SandboxTransportError);
    expect(String((error as Error).cause)).toContain("timed out");
  });
});
