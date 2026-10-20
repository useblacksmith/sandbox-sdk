import { ControlPlaneError, type MintedToken, type SandboxControlPlane } from "./control-plane.js";
import { DEFAULT_REFRESH_FRACTION } from "./token.js";

const MAX_SANDBOXES = 1_000;
/** For a 429 without `Retry-After`; the backend's token limits are per minute. */
const RATE_LIMIT_HOLD_MS = 60_000;

const caches = new WeakMap<SandboxControlPlane, SandboxTokens>();

/** The token cache every `Sandbox` attached through `cp` shares. */
export function sandboxTokens(cp: SandboxControlPlane): SandboxTokens {
  let tokens = caches.get(cp);
  if (!tokens) {
    tokens = new SandboxTokens(cp);
    caches.set(cp, tokens);
  }
  return tokens;
}

/** A token and when `TokenSource` would refresh it; it is not handed out after that. */
export interface SharedToken {
  token: MintedToken;
  reuseUntilMs: number;
}

/**
 * Agent tokens per sandbox, so a caller that attaches a new `Sandbox` for every
 * request mints once per token lifetime instead of once per request. Concurrent
 * mints for one sandbox share a request, and a 429 fails that sandbox's mints
 * without asking again until its `Retry-After` passes.
 */
export class SandboxTokens {
  private readonly cp: SandboxControlPlane;
  private readonly tokens = new Map<string, SharedToken>();
  private readonly minting = new Map<string, Promise<SharedToken>>();
  private readonly holds = new Map<string, { untilMs: number; error: ControlPlaneError }>();

  constructor(cp: SandboxControlPlane) {
    this.cp = cp;
  }

  /**
   * The cached token for `id` while fresh, else a new one. `attached` is the
   * token a handle already holds, still used if the cache evicted `id`.
   */
  reuse(id: string, attached?: SharedToken): Promise<SharedToken> {
    const cached = this.tokens.get(id) ?? attached;
    if (cached && Date.now() < cached.reuseUntilMs) return Promise.resolve(cached);
    return this.mint(id);
  }

  /**
   * For a handle replacing `held`: the cached token if another handle already
   * replaced `held` with it, else a new one. A still-fresh cached token equal to
   * `held` is one the agent rejected, so it is never handed back.
   */
  async refresh(id: string, held: string): Promise<MintedToken> {
    const cached = this.tokens.get(id);
    if (cached && cached.token.token !== held && Date.now() < cached.reuseUntilMs) {
      return cached.token;
    }
    return (await this.mint(id)).token;
  }

  private mint(id: string): Promise<SharedToken> {
    const hold = this.holds.get(id);
    if (hold && Date.now() < hold.untilMs) return Promise.reject(hold.error);
    const inflight = this.minting.get(id);
    if (inflight) return inflight;

    const minting = this.cp
      .mintToken(id)
      .then(
        (token) => this.remember(id, token),
        (error: unknown) => {
          if (error instanceof ControlPlaneError && error.status === 429) {
            const untilMs = Date.now() + (error.retryAfterMs ?? RATE_LIMIT_HOLD_MS);
            bounded(this.holds, id, { untilMs, error });
          }
          throw error;
        },
      )
      .finally(() => this.minting.delete(id));
    this.minting.set(id, minting);
    return minting;
  }

  remember(id: string, token: MintedToken): SharedToken {
    const nowMs = Date.now();
    const lifetimeMs = Math.max(0, token.expiresAt.getTime() - nowMs);
    const shared = { token, reuseUntilMs: nowMs + lifetimeMs * DEFAULT_REFRESH_FRACTION };
    bounded(this.tokens, id, shared);
    this.holds.delete(id);
    return shared;
  }
}

function bounded<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_SANDBOXES) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}
