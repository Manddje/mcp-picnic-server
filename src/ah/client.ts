/**
 * Talks to api.ah.nl the way the Albert Heijn app does. Albert Heijn has no public API: these are
 * the calls its own app makes, and they can change without notice. The calls follow the
 * documentation of https://github.com/danieltyukov/albertheijn-mcp (MIT).
 */

export const AH_API = "https://api.ah.nl";

/** Where a user signs in at Albert Heijn. It ends at an appie://login-exit?code=… address the user copies. */
export const AH_LOGIN_URL = "https://login.ah.nl/login?client_id=appie-ios&redirect_uri=appie%3A%2F%2Flogin-exit&response_type=code";

const CLIENT_ID = "appie-ios";
const APP_VERSION = "9.28";
/** The headers the app sends. REST calls fail without x-application. */
const APP_HEADERS: Record<string, string> = {
  "User-Agent": `Appie/${APP_VERSION} (iPhone17,3; iPhone; CPU OS 26_1 like Mac OS X)`,
  "x-client-name": CLIENT_ID,
  "x-client-version": APP_VERSION,
  "x-application": "AHWEBSHOP",
  Accept: "application/json",
};
const TIMEOUT_MS = 15_000;

export type AhFetch = typeof fetch;

/**
 * session: the token is no longer accepted. code: the sign-in code is wrong or used. refused: Albert
 * Heijn blocks the request. changed: the answer isn't what this server expects any more.
 */
export type AhErrorKind = "session" | "code" | "refused" | "throttled" | "not_found" | "unavailable" | "changed" | "other";

export class AhApiError extends Error {
  constructor(
    readonly kind: AhErrorKind,
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "AhApiError";
  }
}

/** Sorts any error into the few cases the server treats differently. */
export function classifyAhError(error: unknown): { kind: AhErrorKind; status: number | null } {
  return error instanceof AhApiError ? { kind: error.kind, status: error.status } : { kind: "other", status: null };
}

function kindOf(status: number): AhErrorKind {
  if (status === 401) return "session";
  if (status === 403) return "refused";
  if (status === 404) return "not_found";
  if (status === 429) return "throttled";
  return status >= 500 ? "unavailable" : "other";
}

async function send(fetchImpl: AhFetch, url: URL, init: RequestInit): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    // The cause can carry the request, and with it the token: it is not passed on.
    throw new AhApiError("unavailable", "Albert Heijn could not be reached");
  }
}

async function json<T>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    throw new AhApiError("changed", "Albert Heijn answered with something that is not JSON", response.status);
  }
}

/** Albert Heijn's own tokens for one sign-in. `expiresAt` is in seconds. */
export type AhTokens = { accessToken: string; refreshToken: string; expiresAt: number };

type TokenResponse = { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };

/** The token calls: signing in with a code, renewing, and visiting without an account. */
export class AhAuth {
  constructor(private readonly fetchImpl: AhFetch = fetch) {}

  private async post(path: string, body: Record<string, string>, refusedAs: AhErrorKind): Promise<Response> {
    const response = await send(this.fetchImpl, new URL(path, AH_API), {
      method: "POST",
      headers: { ...APP_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: CLIENT_ID, ...body }),
    });
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      throw new AhApiError(refusedAs, "Albert Heijn refused the sign-in", response.status);
    }
    if (!response.ok) throw new AhApiError(kindOf(response.status), "Albert Heijn's sign-in failed", response.status);
    return response;
  }

  private async tokens(path: string, body: Record<string, string>, refusedAs: AhErrorKind): Promise<AhTokens> {
    const raw = await json<TokenResponse>(await this.post(path, body, refusedAs));
    if (typeof raw.access_token !== "string" || typeof raw.refresh_token !== "string") {
      throw new AhApiError("changed", "Albert Heijn's sign-in answered without tokens");
    }
    const lifetime = typeof raw.expires_in === "number" && raw.expires_in > 0 ? raw.expires_in : 3600;
    return { accessToken: raw.access_token, refreshToken: raw.refresh_token, expiresAt: Math.floor(Date.now() / 1000) + lifetime };
  }

  /** Exchanges the code from the appie://login-exit address for tokens. A code works once. */
  exchangeCode(code: string): Promise<AhTokens> {
    return this.tokens("/mobile-auth/v1/auth/token", { code }, "code");
  }

  /** Renews the tokens. The refresh token passed in stops working. */
  refresh(refreshToken: string): Promise<AhTokens> {
    return this.tokens("/mobile-auth/v1/auth/token/refresh", { refreshToken }, "session");
  }

  /** Tokens for a visitor without an account: enough to search, not to shop. */
  anonymous(): Promise<AhTokens> {
    return this.tokens("/mobile-auth/v1/auth/token/anonymous", {}, "refused");
  }

  /** Asks Albert Heijn to end a sign-in. True when it said yes. */
  async logout(refreshToken: string): Promise<boolean> {
    try {
      await this.post("/mobile-auth/v1/auth/token/logout", { refreshToken }, "session");
      return true;
    } catch {
      return false;
    }
  }
}

type Query = Record<string, string | number | boolean | undefined | (string | number)[]>;

type GraphQLAnswer<T> = { data?: T | null; errors?: { message?: string; extensions?: { code?: string; classification?: string } }[] };

/** The data calls of one signed-in (or visiting) user. */
export class AhClient {
  constructor(
    private readonly accessToken: string,
    private readonly fetchImpl: AhFetch = fetch,
  ) {}

  private async call(method: string, path: string, query?: Query, body?: unknown): Promise<Response> {
    const url = new URL(path, AH_API);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined) continue;
      if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, String(item));
      else url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = { ...APP_HEADERS, Authorization: `Bearer ${this.accessToken}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return send(this.fetchImpl, url, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  }

  /** A REST call under /mobile-services. With `allow404`, a missing item is null instead of an error. */
  async rest<T>(path: string, options: { query?: Query; allow404?: boolean } = {}): Promise<T | null> {
    const response = await this.call("GET", path, options.query);
    if (response.status === 204 || (response.status === 404 && options.allow404)) return null;
    if (!response.ok) throw new AhApiError(kindOf(response.status), `Albert Heijn answered with status ${response.status}`, response.status);
    return json<T>(response);
  }

  /**
   * A GraphQL operation. Albert Heijn reports a failed operation in an answer with status 200, so
   * `errors` counts as a failure; with `partial`, data that came along with errors is still used.
   */
  async graphql<T>(query: string, variables: Record<string, unknown> = {}, options: { partial?: boolean } = {}): Promise<T> {
    const response = await this.call("POST", "/graphql", undefined, { query, variables });
    // A 400 here means the operation itself was rejected: Albert Heijn changed its schema.
    if (response.status === 400) throw new AhApiError("changed", "Albert Heijn no longer accepts this request", 400);
    if (!response.ok) throw new AhApiError(kindOf(response.status), `Albert Heijn answered with status ${response.status}`, response.status);
    const answer = await json<GraphQLAnswer<T>>(response);
    const first = answer.errors?.[0];
    if (first && !(options.partial && answer.data)) {
      const code = first.extensions?.code ?? first.extensions?.classification ?? "";
      if (/UNAUTH/i.test(code)) throw new AhApiError("session", "Albert Heijn no longer accepts this sign-in", 401);
      if (/FORBIDDEN/i.test(code)) throw new AhApiError("refused", "Albert Heijn refused this request", 403);
      if (/NOT_FOUND/i.test(code)) throw new AhApiError("not_found", "Not found at Albert Heijn", 404);
      throw new AhApiError("other", `Albert Heijn reported an error${code ? ` (${code.slice(0, 60)})` : ""}`);
    }
    if (!answer.data) throw new AhApiError("changed", "Albert Heijn answered without data");
    return answer.data;
  }
}
