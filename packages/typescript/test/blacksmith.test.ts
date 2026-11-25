import { inspect } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Blacksmith } from "../src/index.js";
import type { SandboxAttachOptions } from "../src/internal/index.js";
import { FakeAgent } from "./fake-agent.js";
import { FakeControlPlane } from "./fake-control-plane.js";

let agent: FakeAgent;
let cp: FakeControlPlane;

beforeAll(async () => {
  agent = await new FakeAgent().start();
  cp = await new FakeControlPlane().start();
  cp.onMint = (token) => agent.validTokens.add(token);
});
afterAll(async () => {
  await agent.stop();
  await cp.stop();
});
afterEach(() => {
  vi.unstubAllEnvs();
  cp.records.clear();
  cp.requests.length = 0;
});

const sandboxOptions = (): SandboxAttachOptions => ({
  agentBaseUrl: () => agent.url,
  readyTimeoutMs: 5_000,
});

describe("Blacksmith", () => {
  it("reads the API key from BLACKSMITH_API_KEY", async () => {
    vi.stubEnv("BLACKSMITH_API_KEY", cp.apiKey);
    const bs = new Blacksmith({ baseUrl: cp.url });

    const sandbox = await bs.sandboxes.create(
      { image: "ubuntu24", workload: "test" },
      sandboxOptions(),
    );

    expect(await bs.sandboxes.get(sandbox.id)).toMatchObject({ id: sandbox.id, state: "running" });
  });

  it("generates the process id even when the options carry a processId", async () => {
    const bs = new Blacksmith({ apiKey: cp.apiKey, baseUrl: cp.url });
    const sandbox = await bs.sandboxes.create(
      { image: "ubuntu24", workload: "test" },
      sandboxOptions(),
    );
    const options = { timeoutMs: 5_000, processId: "chosen" };

    const process = await sandbox.startProcess({ shell: "sleep 30" }, options);
    await sandbox.exec({ cmd: ["true"] }, options);

    expect(process.id).toMatch(/^proc-[0-9a-f-]{36}$/);
    expect(agent.requests.map((r) => r.path)).not.toContain("/v1/processes/chosen");
    await sandbox.killProcess(process.id);
  });

  it("throws without an API key", () => {
    vi.stubEnv("BLACKSMITH_API_KEY", "");

    expect(() => new Blacksmith()).toThrow("apiKey is required");
  });

  it("connects without minting a second token for a sandbox it created", async () => {
    const bs = new Blacksmith({ apiKey: cp.apiKey, baseUrl: cp.url });
    const created = await bs.sandboxes.create(
      { image: "ubuntu24", workload: "test" },
      sandboxOptions(),
    );

    const connected = await bs.sandboxes.connect(created.id, sandboxOptions());

    expect((await connected.exec({ cmd: ["true"] })).exit_code).toBe(0);
    expect(cp.requests.filter((r) => r.path.endsWith("/tokens"))).toHaveLength(0);
  });

  it("shows no agent token when a created sandbox is printed or serialized", async () => {
    const bs = new Blacksmith({ apiKey: cp.apiKey, baseUrl: cp.url });
    const before = new Set(agent.validTokens);

    const sandbox = await bs.sandboxes.create(
      { image: "ubuntu24", workload: "test" },
      sandboxOptions(),
    );

    const minted = [...agent.validTokens].filter((token) => !before.has(token));
    expect(minted).toHaveLength(1);
    const printed = inspect(sandbox, { depth: null, showHidden: true }) + JSON.stringify(sandbox);
    expect(printed).not.toContain(minted[0]);
    expect((await sandbox.exec({ cmd: ["true"] })).exit_code).toBe(0);
  });

  it("lists and deletes sandboxes, and snapshots a paused one", async () => {
    const bs = new Blacksmith({ apiKey: cp.apiKey, baseUrl: cp.url });
    const running = cp.seed("running");
    const paused = cp.seed("paused");

    expect((await bs.sandboxes.list()).map((s) => s.id).sort()).toEqual(
      [running.id, paused.id].sort(),
    );
    const snapshot = await bs.snapshots.create({ sandbox: paused.id });
    expect(snapshot.sandboxId).toBe(paused.id);
    expect((await bs.sandboxes.delete(running.id)).id).toBe(running.id);
  });

  it("sends API and sandbox requests through the fetch given to Blacksmith", async () => {
    const urls: string[] = [];
    const recording: typeof fetch = (input, init) => {
      urls.push(String(input));
      return fetch(input, init);
    };
    const bs = new Blacksmith({ apiKey: cp.apiKey, baseUrl: cp.url, fetch: recording });

    const sandbox = await bs.sandboxes.create(
      { image: "ubuntu24", workload: "test" },
      sandboxOptions(),
    );
    await sandbox.exec({ cmd: ["true"] });

    expect(urls.some((url) => url.startsWith(cp.url))).toBe(true);
    expect(urls.some((url) => url.startsWith(agent.url))).toBe(true);
  });

  it("sends one sandbox's own requests through the fetch in its options", async () => {
    const apiUrls: string[] = [];
    const sandboxUrls: string[] = [];
    const record =
      (urls: string[]): typeof fetch =>
      (input, init) => {
        urls.push(String(input));
        return fetch(input, init);
      };
    const bs = new Blacksmith({ apiKey: cp.apiKey, baseUrl: cp.url, fetch: record(apiUrls) });

    const sandbox = await bs.sandboxes.create(
      { image: "ubuntu24", workload: "test" },
      { ...sandboxOptions(), fetch: record(sandboxUrls) },
    );
    await sandbox.exec({ cmd: ["true"] });

    expect(apiUrls.every((url) => url.startsWith(cp.url))).toBe(true);
    expect(sandboxUrls.length).toBeGreaterThan(0);
    expect(sandboxUrls.every((url) => url.startsWith(agent.url))).toBe(true);
  });
});
