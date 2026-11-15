import { randomBytes } from "node:crypto";
import type { Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidClientMetadataError, InvalidGrantError, InvalidTokenError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Sealer } from "./crypto.js";
import { classifyPicnicError, isCountry, type PicnicFactory, type PicnicSession } from "./picnic.js";

export const SCOPE = "picnic";
const ACCESS_TTL = 24 * 60 * 60;
/**
 * How long one sign-in lasts. Refreshing doesn't extend it, so a refresh token that leaks stops
 * working by itself, and the user signs in again after this time.
 */
export const SIGN_IN_TTL = 90 * 24 * 60 * 60;
/** Refresh tokens from before sign-ins had an end lasted this long, counted from each refresh. */
const LEGACY_REFRESH_TTL = 365 * 24 * 60 * 60;
const CODE_TTL_MS = 2 * 60 * 1000;
const MAX_PENDING_CODES = 20_000;

const CLIENT_PREFIX = "pmc_";
const ACCESS_PREFIX = "pma_";
const REFRESH_PREFIX = "pmr_";

/** A registered client as sealed into its own client id. */
type ClientRecord = { r: string[]; n?: string; s: boolean };
/**
 * A Picnic session as sealed into an access or refresh token. `t` is when the user signed in, in
 * seconds; tokens from before sign-ins had an end don't have it.
 */
type TokenRecord = { k: string; cc: string; d: string; c: string; t?: number };

type Grant = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  session: PicnicSession;
  expiresAt: number;
};

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const FORBIDDEN_SCHEMES = new Set(["javascript:", "data:", "vbscript:", "file:", "blob:", "about:", "ftp:", "ws:", "wss:"]);

/** https anywhere, http on this computer only, or an app's own scheme (cursor://, vscode://). */
export function isAllowedRedirectUri(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.hash || url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return LOOPBACK.has(url.hostname);
  return !FORBIDDEN_SCHEMES.has(url.protocol);
}

/**
 * Where the well-known MCP apps send users back to after signing in: the exact address, not the
 * whole host. Any other page on such a host could pass the sign-in code on (an open redirect, a
 * page that leaks its address), and the code is all it takes to finish the sign-in elsewhere.
 * A `*` stands for one path segment.
 */
export const KNOWN_APP_CALLBACKS = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
  "https://chatgpt.com/connector_platform_oauth_redirect",
  "https://chatgpt.com/connector/oauth/*",
  "https://vscode.dev/redirect",
  "https://insiders.vscode.dev/redirect",
];
/** An app's own scheme always opens that app on the user's computer, whatever the path. */
export const KNOWN_APP_SCHEMES = ["cursor:", "vscode:", "vscode-insiders:"];

const ANY_SEGMENT = /^[A-Za-z0-9._~-]+$/;

/**
 * Reads a callback address as written in {@link KNOWN_APP_CALLBACKS} or EXTRA_KNOWN_APPS into the
 * form it is compared in. Null when it isn't an https address without a query or fragment.
 */
export function parseCallbackPattern(entry: string): string | null {
  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.search || url.hash || url.username || url.password) return null;
  const pattern = url.origin + url.pathname;
  // A `*` only as the whole last segment.
  const star = pattern.indexOf("*");
  return star === -1 || (star === pattern.length - 1 && pattern.endsWith("/*")) ? pattern : null;
}

function matchesCallback(pattern: string, address: string): boolean {
  if (!pattern.endsWith("/*")) return pattern === address;
  const prefix = pattern.slice(0, -1);
  return address.startsWith(prefix) && ANY_SEGMENT.test(address.slice(prefix.length));
}

/** known: a well-known app. local: an app on the user's own computer. unknown: anything else. */
export type RedirectTrust = "known" | "local" | "unknown";

/**
 * Which apps the sign-in page vouches for. Anyone can register a client with any name, so the page
 * only names an app whose redirect URI belongs to a known app or the user's own computer; for any
 * other app it warns the user instead, or (with `blockUnknown`) refuses the app altogether.
 */
export class RedirectPolicy {
  private readonly callbacks: string[];
  private readonly hosts = new Set<string>();
  private readonly schemes: Set<string>;

  /**
   * `extra` adds known apps: callback addresses (https://example.com/oauth/callback), app schemes
   * (myapp://) and whole host names (example.com).
   */
  constructor(
    extra: readonly string[] = [],
    readonly blockUnknown = false,
  ) {
    this.callbacks = KNOWN_APP_CALLBACKS.map((entry) => parseCallbackPattern(entry)!);
    this.schemes = new Set(KNOWN_APP_SCHEMES);
    for (const entry of extra) {
      const callback = parseCallbackPattern(entry);
      if (callback) this.callbacks.push(callback);
      else if (entry.endsWith("://")) this.schemes.add(entry.slice(0, -2));
      else this.hosts.add(entry);
    }
  }

  trust(uri: string): RedirectTrust {
    let url: URL;
    try {
      url = new URL(uri);
    } catch {
      return "unknown";
    }
    if (url.protocol === "https:") {
      if (this.hosts.has(url.hostname)) return "known";
      // The app adds the code and state itself; a callback that already carries a query isn't the app's.
      const address = url.origin + url.pathname;
      return !url.search && this.callbacks.some((pattern) => matchesCallback(pattern, address)) ? "known" : "unknown";
    }
    if (url.protocol === "http:") return LOOPBACK.has(url.hostname) ? "local" : "unknown";
    return this.schemes.has(url.protocol) ? "known" : "unknown";
  }

  /** Whether a client may use this redirect URI at all. */
  allows(uri: string): boolean {
    return isAllowedRedirectUri(uri) && (!this.blockUnknown || this.trust(uri) !== "unknown");
  }
}

/**
 * Dynamic client registration without a database: the client id is the sealed registration.
 * Anyone may register (that's what lets a user paste the URL into any app), so a registration
 * proves nothing by itself; the sign-in page shows the user where they will be sent back to.
 */
class SealedClientsStore implements OAuthRegisteredClientsStore {
  constructor(
    private readonly sealer: Sealer,
    private readonly policy: RedirectPolicy,
  ) {}

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    if (!clientId.startsWith(CLIENT_PREFIX)) return undefined;
    const record = this.sealer.open<ClientRecord>("client", clientId.slice(CLIENT_PREFIX.length));
    // Also checked here, so registrations made before UNKNOWN_APPS=block stop working too.
    if (!record || !record.r.every((uri) => this.policy.allows(uri))) return undefined;
    return {
      client_id: clientId,
      client_name: record.n,
      redirect_uris: record.r,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: record.s ? "client_secret_post" : "none",
      ...(record.s ? { client_secret: this.sealer.mac("client-secret", clientId), client_secret_expires_at: 0 } : {}),
    };
  }

  registerClient(metadata: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">): OAuthClientInformationFull {
    const uris = metadata.redirect_uris ?? [];
    if (uris.length === 0 || uris.length > 10) {
      throw new InvalidClientMetadataError("Register between 1 and 10 redirect_uris");
    }
    for (const uri of uris) {
      if (uri.length > 400 || !this.policy.allows(uri)) {
        throw new InvalidClientMetadataError(`redirect_uri not allowed: ${uri.slice(0, 100)}`);
      }
    }
    const confidential = (metadata.token_endpoint_auth_method ?? "client_secret_post") !== "none";
    const name = metadata.client_name?.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80);
    const record: ClientRecord = { r: uris, s: confidential, ...(name ? { n: name } : {}) };
    const clientId = CLIENT_PREFIX + this.sealer.seal("client", record);
    return {
      ...this.getClient(clientId)!,
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
  }
}

export class PicnicOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: SealedClientsStore;
  private readonly codes = new Map<string, Grant>();

  /** Shows the sign-in page; set by the login routes. */
  onAuthorize: (client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) => void = () => {
    throw new Error("Sign-in page is not configured");
  };

  constructor(
    private readonly sealer: Sealer,
    private readonly picnic: PicnicFactory,
    readonly redirectPolicy: RedirectPolicy = new RedirectPolicy(),
  ) {
    this.clientsStore = new SealedClientsStore(sealer, redirectPolicy);
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.onAuthorize(client, params, res);
  }

  /**
   * Creates the one-time code the user's app exchanges for tokens. Codes live in memory for two
   * minutes, so the Picnic key never appears in a URL.
   */
  issueCode(grant: Omit<Grant, "expiresAt">): string {
    const now = Date.now();
    for (const [code, pending] of this.codes) {
      if (pending.expiresAt < now) this.codes.delete(code);
    }
    if (this.codes.size >= MAX_PENDING_CODES) throw new Error("Too many sign-ins in progress");
    const code = randomBytes(32).toString("base64url");
    this.codes.set(code, { ...grant, expiresAt: now + CODE_TTL_MS });
    return code;
  }

  private grantFor(client: OAuthClientInformationFull, code: string): Grant {
    const grant = this.codes.get(code);
    if (!grant || grant.expiresAt < Date.now() || grant.clientId !== client.client_id) {
      throw new InvalidGrantError("Authorization code is invalid or expired");
    }
    return grant;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    return this.grantFor(client, code).codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const grant = this.grantFor(client, code);
    this.codes.delete(code);
    if (redirectUri !== undefined && redirectUri !== grant.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }
    return this.issueTokens(client.client_id, grant.session, Math.floor(Date.now() / 1000));
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const record = this.openToken("refresh", REFRESH_PREFIX, refreshToken);
    if (!record || record.c !== client.client_id) {
      throw new InvalidGrantError("Refresh token is invalid or expired");
    }
    // A token from before sign-ins had an end: count from when that token was issued.
    const signedInAt = record.signedInAt ?? record.exp - LEGACY_REFRESH_TTL;
    return this.issueTokens(client.client_id, record.session, signedInAt);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = this.openToken("access", ACCESS_PREFIX, token);
    if (!record) throw new InvalidTokenError("Access token is invalid or expired");
    return {
      token,
      clientId: record.c,
      scopes: [SCOPE],
      expiresAt: record.exp,
      extra: { session: record.session },
    };
  }

  /**
   * Revoking a token signs the session out at Picnic. That invalidates the Picnic key inside every
   * token of that sign-in, which is how a token is revoked without keeping a list of tokens.
   */
  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const record =
      this.openToken("access", ACCESS_PREFIX, request.token) ?? this.openToken("refresh", REFRESH_PREFIX, request.token);
    if (!record || record.c !== client.client_id) return;
    // Answering "revoked" while the Picnic key still works would leave the app sure of tokens that are still good.
    if (!(await this.signOut(record.session))) {
      throw new ServerError("Signing out at Picnic failed, so the token is still valid. Try again.");
    }
  }

  /**
   * Signs a session out at Picnic. True when its key no longer works: signed out now, or refused by
   * Picnic as already invalid. False when Picnic can't be reached or answers with another error.
   * Never throws.
   */
  async signOut(session: PicnicSession): Promise<boolean> {
    try {
      await this.picnic(session).auth.logout();
      return true;
    } catch (error) {
      return classifyPicnicError(error).kind === "session";
    }
  }

  /** Tokens for a sign-in that started at `signedInAt` (in seconds); none of them outlive the sign-in. */
  private issueTokens(clientId: string, session: PicnicSession, signedInAt: number): OAuthTokens {
    const left = signedInAt + SIGN_IN_TTL - Math.floor(Date.now() / 1000);
    if (left <= 0) throw new InvalidGrantError("This sign-in has ended. Sign in again.");
    const record: TokenRecord = { k: session.authKey, cc: session.country, d: session.deviceId, c: clientId, t: signedInAt };
    const accessTtl = Math.min(ACCESS_TTL, left);
    return {
      access_token: ACCESS_PREFIX + this.sealer.seal("access", record, accessTtl),
      token_type: "bearer",
      expires_in: accessTtl,
      refresh_token: REFRESH_PREFIX + this.sealer.seal("refresh", record, left),
      scope: SCOPE,
    };
  }

  private openToken(
    purpose: "access" | "refresh",
    prefix: string,
    token: string,
  ): { c: string; exp: number; signedInAt: number | undefined; session: PicnicSession } | null {
    if (typeof token !== "string" || !token.startsWith(prefix)) return null;
    const record = this.sealer.open<TokenRecord>(purpose, token.slice(prefix.length));
    if (!record || typeof record.exp !== "number" || !isCountry(record.cc)) return null;
    return {
      c: record.c,
      exp: record.exp,
      signedInAt: typeof record.t === "number" ? record.t : undefined,
      session: { authKey: record.k, country: record.cc, deviceId: record.d },
    };
  }
}

/** The Picnic session of an authenticated MCP request. */
export function sessionOf(auth: AuthInfo | undefined): PicnicSession {
  const session = auth?.extra?.session as PicnicSession | undefined;
  if (!session) throw new InvalidTokenError("Missing session");
  return session;
}
