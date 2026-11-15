import { AhClient, classifyAhError, type AhAuth, type AhFetch, type AhTokens } from "./client.js";

const TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 300;
/** A new visitor token is fetched this long before the old one expires, in seconds. */
const TOKEN_MARGIN = 10 * 60;

/**
 * What is the same for everyone, such as the weekly bonus, fetched once and kept for half an hour.
 * These calls go out with a visitor token of the server's own, never with a user's token, so
 * nothing that belongs to one user can end up in what another user is shown.
 */
export class AhPublic {
  private tokens: Promise<AhTokens> | null = null;
  private readonly cache = new Map<string, { value: Promise<unknown>; until: number }>();

  constructor(
    private readonly auth: AhAuth,
    private readonly fetchImpl: AhFetch,
  ) {}

  private async client(): Promise<AhClient> {
    const current = await this.tokens?.catch(() => null);
    if (!current || current.expiresAt - TOKEN_MARGIN < Date.now() / 1000) {
      this.tokens = this.auth.anonymous();
    }
    return new AhClient((await this.tokens!).accessToken, this.fetchImpl);
  }

  private async load<T>(run: (ah: AhClient) => Promise<T>): Promise<T> {
    try {
      return await run(await this.client());
    } catch (error) {
      if (classifyAhError(error).kind !== "session") throw error;
      // Albert Heijn sometimes drops a visitor token before its time: once more with a new one.
      this.tokens = null;
      return run(await this.client());
    }
  }

  /** The answer kept under `key`, or else what `run` fetches now. A failure isn't kept. */
  get<T>(key: string, run: (ah: AhClient) => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && hit.until > now) return hit.value as Promise<T>;
    for (const [k, entry] of this.cache) {
      if (entry.until <= now || this.cache.size >= MAX_ENTRIES) this.cache.delete(k);
    }
    const value = this.load(run);
    this.cache.set(key, { value, until: now + TTL_MS });
    value.catch(() => {
      if (this.cache.get(key)?.value === value) this.cache.delete(key);
    });
    return value;
  }
}
