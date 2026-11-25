import { HttpControlPlaneClient } from "./internal/control-plane.js";
import type {
  SandboxCreateOptions,
  SandboxListOptions,
  SandboxRecord,
  Snapshots,
} from "./resources.js";
import { Sandbox as SandboxHandle } from "./internal/sandbox.js";
import type { Sandbox, SandboxOptions } from "./sandbox.js";
import type { RequestOptions, StartProcessOptions } from "./types.js";

export interface BlacksmithOptions {
  /** Org API key. Default `process.env.BLACKSMITH_API_KEY`. Sent only to the Blacksmith API, never to a sandbox. */
  apiKey?: string;
  /** Blacksmith API origin. Default `https://api.blacksmith.sh`. */
  baseUrl?: string;
  /**
   * Sends every request, to the Blacksmith API and to sandboxes: for a proxy, tracing,
   * custom TLS or a test. Default: the runtime's fetch. `SandboxOptions.fetch` replaces
   * it for one sandbox's own requests.
   */
  fetch?: typeof globalThis.fetch;
}

function withoutProcessId(options: RequestOptions | undefined): RequestOptions | undefined {
  if (options === undefined) return options;
  const rest: StartProcessOptions = { ...options };
  delete rest.processId;
  return rest;
}

/** The handle honors `processId` for Blacksmith's own services; a customer's handle always generates the id. */
function generatedProcessIds(handle: SandboxHandle): Sandbox {
  const startProcess = handle.startProcess.bind(handle);
  const exec = handle.exec.bind(handle);
  handle.startProcess = (spec, options) => startProcess(spec, withoutProcessId(options));
  handle.exec = (spec, options) => exec(spec, withoutProcessId(options));
  return handle;
}

/**
 * The entry point to Blacksmith sandboxes: holds the API key and hands out `Sandbox` handles.
 * Reuse one instance: sandboxes reached through it share their short-lived agent tokens.
 *
 * ```ts
 * const bs = new Blacksmith();
 * const sandbox = await bs.sandboxes.create({ image: "ubuntu24", workload: "ci-repro" });
 * ```
 */
export class Blacksmith {
  readonly baseUrl: string;
  readonly sandboxes: {
    /** Creates a sandbox and resolves once its agent answers. */
    create(options: SandboxCreateOptions, sandboxOptions?: SandboxOptions): Promise<Sandbox>;
    /** A handle on an existing sandbox. */
    connect(id: string, sandboxOptions?: SandboxOptions): Promise<Sandbox>;
    get(id: string): Promise<SandboxRecord>;
    list(options?: SandboxListOptions): Promise<SandboxRecord[]>;
    delete(id: string): Promise<SandboxRecord>;
  };
  readonly snapshots: Snapshots;

  constructor(options: BlacksmithOptions = {}) {
    const apiKey = options.apiKey ?? process.env.BLACKSMITH_API_KEY;
    if (!apiKey) throw new TypeError("apiKey is required: pass it or set BLACKSMITH_API_KEY");
    const cp = new HttpControlPlaneClient({
      apiKey,
      baseUrl: options.baseUrl,
      fetch: options.fetch,
    });
    const withFetch = (sandboxOptions: SandboxOptions | undefined): SandboxOptions => ({
      ...sandboxOptions,
      fetch: sandboxOptions?.fetch ?? options.fetch,
    });
    this.baseUrl = cp.baseUrl;
    this.sandboxes = {
      create: async (createOptions, sandboxOptions) =>
        generatedProcessIds(
          await SandboxHandle.create(cp, createOptions, withFetch(sandboxOptions)),
        ),
      connect: async (id, sandboxOptions) =>
        generatedProcessIds(await SandboxHandle.connect(cp, id, withFetch(sandboxOptions))),
      get: (id) => cp.get(id),
      list: (listOptions) => cp.list(listOptions),
      delete: (id) => cp.delete(id),
    };
    this.snapshots = cp.images.snapshots;
  }
}
