import { randomBytes } from "node:crypto";
import type { Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidClientMetadataError, InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Sealer } from "./crypto.js";
import { isCountry, type PicnicFactory, type PicnicSession } from "./picnic.js";

export const SCOPE = "picnic";
const ACCESS_TTL = 24 * 60 * 60;
const REFRESH_TTL = 365 * 24 * 60 * 60;
const CODE_TTL_MS = 2 * 60 * 1000;
const MAX_PENDING_CODES = 20_000;

const CLIENT_PREFIX = "pmc_";
const ACCESS_PREFIX = "pma_";
const REFRESH_PREFIX = "pmr_";

/** A registered client as sealed into its own client id. */
type ClientRecord = { r: string[]; n?: string; s: boolean };
/** A Picnic session as sealed into an access or refresh token. */
type TokenRecord = { k: string; cc: string; d: string; c: string };

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
 * Dynamic client registration without a database: the client id is the sealed registration.
 * Anyone may register (that's what lets a user paste the URL into any app), so a registration
 * proves nothing by itself; the sign-in page shows the user where they will be sent back to.
 */
class SealedClientsStore implements OAuthRegisteredClientsStore {
  constructor(private readonly sealer: Sealer) {}

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    if (!clientId.startsWith(CLIENT_PREFIX)) return undefined;
    const record = this.sealer.open<ClientRecord>("client", clientId.slice(CLIENT_PREFIX.length));
    if (!record) return undefined;
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
      if (uri.length > 400 || !isAllowedRedirectUri(uri)) {
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
  ) {
    this.clientsStore = new SealedClientsStore(sealer);
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
    return this.issueTokens(client.client_id, grant.session);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const record = this.openToken("refresh", REFRESH_PREFIX, refreshToken);
    if (!record || record.c !== client.client_id) {
      throw new InvalidGrantError("Refresh token is invalid or expired");
    }
    return this.issueTokens(client.client_id, record.session);
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
    await this.signOut(record.session);
  }

  /** Signs a session out at Picnic. Never throws: a key that is already invalid is signed out too. */
  async signOut(session: PicnicSession): Promise<boolean> {
    try {
      await this.picnic(session).auth.logout();
      return true;
    } catch {
      return false;
    }
  }

  private issueTokens(clientId: string, session: PicnicSession): OAuthTokens {
    const record: TokenRecord = { k: session.authKey, cc: session.country, d: session.deviceId, c: clientId };
    return {
      access_token: ACCESS_PREFIX + this.sealer.seal("access", record, ACCESS_TTL),
      token_type: "bearer",
      expires_in: ACCESS_TTL,
      refresh_token: REFRESH_PREFIX + this.sealer.seal("refresh", record, REFRESH_TTL),
      scope: SCOPE,
    };
  }

  private openToken(purpose: "access" | "refresh", prefix: string, token: string): { c: string; exp: number; session: PicnicSession } | null {
    if (typeof token !== "string" || !token.startsWith(prefix)) return null;
    const record = this.sealer.open<TokenRecord>(purpose, token.slice(prefix.length));
    if (!record || typeof record.exp !== "number" || !isCountry(record.cc)) return null;
    return { c: record.c, exp: record.exp, session: { authKey: record.k, country: record.cc, deviceId: record.d } };
  }
}

/** The Picnic session of an authenticated MCP request. */
export function sessionOf(auth: AuthInfo | undefined): PicnicSession {
  const session = auth?.extra?.session as PicnicSession | undefined;
  if (!session) throw new InvalidTokenError("Missing session");
  return session;
}
