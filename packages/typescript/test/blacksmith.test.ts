import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Blacksmith } from "../src/index.js";
import type { SandboxOptions } from "../src/index.js";
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

const sandboxOptions = (): SandboxOptions => ({
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
});
