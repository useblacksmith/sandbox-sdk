import {
  HttpControlPlaneClient,
  type ImageSnapshotControlPlane,
  type SandboxCreateOptions,
  type SandboxListOptions,
  type SandboxRecord,
} from "./control-plane.js";
import { Sandbox, type SandboxOptions } from "./sandbox.js";

export interface BlacksmithOptions {
  /** Org API key. Default `process.env.BLACKSMITH_API_KEY`. Sent only to the Blacksmith API, never to a sandbox. */
  apiKey?: string;
  /** Blacksmith API origin. Default `https://api.blacksmith.sh`. */
  baseUrl?: string;
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
  readonly snapshots: ImageSnapshotControlPlane;

  constructor(options: BlacksmithOptions = {}) {
    const apiKey = options.apiKey ?? process.env.BLACKSMITH_API_KEY;
    if (!apiKey) throw new TypeError("apiKey is required: pass it or set BLACKSMITH_API_KEY");
    const cp = new HttpControlPlaneClient({ apiKey, baseUrl: options.baseUrl });
    this.baseUrl = cp.baseUrl;
    this.sandboxes = {
      create: (createOptions, sandboxOptions) => Sandbox.create(cp, createOptions, sandboxOptions),
      connect: (id, sandboxOptions) => Sandbox.connect(cp, id, sandboxOptions),
      get: (id) => cp.get(id),
      list: (listOptions) => cp.list(listOptions),
      delete: (id) => cp.delete(id),
    };
    this.snapshots = cp.images.snapshots;
  }
}
