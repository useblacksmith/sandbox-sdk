export interface AgentToken {
  token: string;
  expiresAt: Date;
}

export type TokenProvider = () => Promise<AgentToken>;

/** Fraction of a token's lifetime after which the next request refreshes it. */
export const DEFAULT_REFRESH_FRACTION = 0.8;

interface CachedToken extends AgentToken {
  refreshAtMs: number;
}

/**
 * Caches the current agent token, refreshing it proactively at
 * `refreshFraction` of its lifetime and on demand after a `token_expired`.
 * Concurrent callers share one in-flight refresh.
 */
export class TokenSource {
  private readonly provider: TokenProvider | undefined;
  private readonly refreshFraction: number;
  private readonly now: () => number;
  private cached: CachedToken | undefined;
  private inflight: Promise<string> | undefined;

  constructor(options: {
    token?: string;
    tokenProvider?: TokenProvider;
    refreshFraction?: number;
    now?: () => number;
  }) {
    if (options.token !== undefined && options.tokenProvider !== undefined) {
      throw new TypeError("pass either token or tokenProvider, not both");
    }
    if (options.token === undefined && options.tokenProvider === undefined) {
      throw new TypeError("one of token or tokenProvider is required");
    }
    this.provider = options.tokenProvider;
    this.refreshFraction = options.refreshFraction ?? DEFAULT_REFRESH_FRACTION;
    this.now = options.now ?? Date.now;
    if (options.token !== undefined) {
      this.cached = {
        token: options.token,
        expiresAt: new Date(Number.POSITIVE_INFINITY),
        refreshAtMs: Number.POSITIVE_INFINITY,
      };
    }
  }

  get refreshable(): boolean {
    return this.provider !== undefined;
  }

  async get(): Promise<string> {
    if (this.cached && this.now() < this.cached.refreshAtMs) return this.cached.token;
    return this.refresh();
  }

  /** Drops the cached token so the next `get()` mints a fresh one. */
  invalidate(token?: string): void {
    if (token !== undefined && this.cached?.token !== token) return;
    if (this.provider) this.cached = undefined;
  }

  private refresh(): Promise<string> {
    if (this.inflight) return this.inflight;
    const provider = this.provider;
    if (!provider) {
      const fixed = this.cached;
      if (!fixed) throw new TypeError("token source has no token");
      return Promise.resolve(fixed.token);
    }
    this.inflight = provider()
      .then((fresh) => {
        const issuedMs = this.now();
        const lifetimeMs = Math.max(0, fresh.expiresAt.getTime() - issuedMs);
        this.cached = {
          ...fresh,
          refreshAtMs: issuedMs + lifetimeMs * this.refreshFraction,
        };
        return fresh.token;
      })
      .finally(() => {
        this.inflight = undefined;
      });
    return this.inflight;
  }
}
