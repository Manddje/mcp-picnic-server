import { createHash, randomBytes } from "node:crypto";
import type { Response } from "express";
import type { AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidGrantError, InvalidTokenError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Sealer } from "../crypto.js";
import { SIGN_IN_TTL } from "../oauth.js";
import { classifyAhError, type AhAuth, type AhTokens } from "./client.js";

export const AH_SCOPE = "ah";
const ACCESS_TTL = 24 * 60 * 60;
/** A token of this server stops working this long before the Albert Heijn token inside it does. */
const EXPIRY_MARGIN = 2 * 60;
/** With less than this left on the Albert Heijn token, renewing this server's tokens renews it too. */
const RENEW_BEFORE = 60 * 60;
/** A renewal asked for twice with the same refresh token gets the same answer for this long. */
const REPLAY_MS = 2 * 60 * 1000;
const CODE_TTL_MS = 2 * 60 * 1000;
const MAX_PENDING_CODES = 20_000;
const MAX_REMEMBERED = 100_000;

const CODE_PREFIX = "ahc_";
const ACCESS_PREFIX = "aha_";
const REFRESH_PREFIX = "ahr_";

/** What the server needs to act as an Albert Heijn user. It travels inside the user's encrypted tokens. */
export type AhSession = {
  /** Names this sign-in, across every renewal of its tokens. */
  id: string;
  accessToken: string;
  refreshToken: string;
  /** When Albert Heijn's access token expires, in seconds. */
  accessExpiresAt: number;
  /** False for a visitor who connected without an Albert Heijn account. */
  member: boolean;
};

export function newAhSession(tokens: AhTokens, member: boolean): AhSession {
  return { id: randomBytes(12).toString("base64url"), ...sessionTokens(tokens), member };
}

function sessionTokens(tokens: AhTokens): Pick<AhSession, "accessToken" | "refreshToken" | "accessExpiresAt"> {
  return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, accessExpiresAt: tokens.expiresAt };
}

/** An Albert Heijn session as sealed into an access or refresh token. `t` is when the user signed in, in seconds. */
type TokenRecord = { i: string; a: string; r: string; e: number; m: 0 | 1; c: string; t: number };

type Grant = { clientId: string; redirectUri: string; codeChallenge: string; session: AhSession; expiresAt: number };

const seconds = () => Math.floor(Date.now() / 1000);

/** Forgets entries whose time has passed, and the oldest ones when there are too many. */
function prune(map: Map<string, number>, now: number): void {
  for (const [key, until] of map) {
    if (until < now || map.size > MAX_REMEMBERED) map.delete(key);
  }
}

export function isAhCode(code: string): boolean {
  return code.startsWith(CODE_PREFIX);
}

export function isAhToken(token: string): boolean {
  return token.startsWith(ACCESS_PREFIX) || token.startsWith(REFRESH_PREFIX);
}

/**
 * The Albert Heijn half of the OAuth server. Like the Picnic half it keeps no database: a token of
 * this server is the sealed Albert Heijn session.
 *
 * Albert Heijn's tokens expire and its refresh token changes with every renewal, so a sealed token
 * goes out of date. The app's own refresh carries that: an access token of this server expires
 * just before the Albert Heijn token inside it, and renewing it renews the Albert Heijn tokens and
 * seals the new pair into the new tokens.
 */
export class AhOAuthProvider {
  private readonly codes = new Map<string, Grant>();
  /** Sign-ins that were ended here, until the moment they would have ended anyway. Lost on a restart. */
  private readonly ended = new Map<string, number>();
  /** Sign-ins whose Albert Heijn access token was refused before its time, with that token's expiry. */
  private readonly refused = new Map<string, number>();
  private readonly renewals = new Map<string, { tokens: Promise<OAuthTokens>; until: number }>();

  /** Shows the sign-in page; set by the login routes. */
  onAuthorize: (client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) => void = () => {
    throw new Error("Sign-in page is not configured");
  };

  constructor(
    private readonly sealer: Sealer,
    private readonly auth: AhAuth,
  ) {}

  /** Creates the one-time code the user's app exchanges for tokens. Codes live in memory for two minutes. */
  issueCode(grant: Omit<Grant, "expiresAt">): string {
    const now = Date.now();
    for (const [code, pending] of this.codes) {
      if (pending.expiresAt < now) this.codes.delete(code);
    }
    if (this.codes.size >= MAX_PENDING_CODES) throw new Error("Too many sign-ins in progress");
    const code = CODE_PREFIX + randomBytes(32).toString("base64url");
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

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, redirectUri?: string): Promise<OAuthTokens> {
    const grant = this.grantFor(client, code);
    this.codes.delete(code);
    if (redirectUri !== undefined && redirectUri !== grant.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }
    return this.issueTokens(client.client_id, grant.session, seconds());
  }

  /**
   * Renews the tokens. An app can ask twice with the same refresh token (two tabs, or a retry after
   * a lost answer), and Albert Heijn's refresh token works once: so requests for the same token
   * share one renewal, and its answer is repeated for two minutes.
   */
  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const record = this.open("ah-refresh", REFRESH_PREFIX, refreshToken);
    if (!record || record.c !== client.client_id || this.ended.has(record.i)) {
      throw new InvalidGrantError("Refresh token is invalid or expired");
    }
    const now = Date.now();
    for (const [key, renewal] of this.renewals) {
      if (renewal.until < now) this.renewals.delete(key);
    }
    const key = createHash("sha256").update(refreshToken).digest("base64url");
    const running = this.renewals.get(key);
    if (running) return running.tokens;

    const tokens = this.renew(record);
    this.renewals.set(key, { tokens, until: now + REPLAY_MS });
    // A failed renewal isn't repeated: the next request tries again.
    tokens.catch(() => this.renewals.delete(key));
    return tokens;
  }

  private async renew(record: TokenRecord): Promise<OAuthTokens> {
    const session = sessionOf(record);
    const stillGood = record.e - seconds() > RENEW_BEFORE && this.refused.get(record.i) !== record.e;
    if (stillGood) return this.issueTokens(record.c, session, record.t);

    let fresh: AhTokens;
    try {
      fresh = await this.auth.refresh(record.r);
    } catch (error) {
      const visitor = !session.member && classifyAhError(error).kind === "session";
      // A visitor has nothing to lose: new visitor tokens are as good as the old ones.
      const again = visitor ? await this.auth.anonymous().catch(() => null) : null;
      if (!again) throw renewalError(error);
      fresh = again;
    }
    this.refused.delete(record.i);
    return this.issueTokens(record.c, { ...session, ...sessionTokens(fresh) }, record.t);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = this.open("ah-access", ACCESS_PREFIX, token);
    if (!record || this.ended.has(record.i)) throw new InvalidTokenError("Access token is invalid or expired");
    // Sends the app to its refresh token, which gets new Albert Heijn tokens.
    if (this.refused.get(record.i) === record.e) throw new InvalidTokenError("Access token needs to be renewed");
    return {
      token,
      clientId: record.c,
      scopes: [AH_SCOPE],
      expiresAt: record.exp,
      extra: { ahSession: sessionOf(record) },
    };
  }

  /** Notes that Albert Heijn refused a session's access token, so the app's next request makes it renew its tokens. */
  markRefused(session: AhSession): void {
    const now = seconds();
    prune(this.refused, now);
    if (session.accessExpiresAt > now) this.refused.set(session.id, session.accessExpiresAt);
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const record = this.open("ah-access", ACCESS_PREFIX, request.token) ?? this.open("ah-refresh", REFRESH_PREFIX, request.token);
    if (!record || record.c !== client.client_id) return;
    await this.signOut(sessionOf(record), record.t);
  }

  /**
   * Ends a sign-in. Albert Heijn's app API has no working sign-out, so the sign-in is ended here:
   * this server refuses its tokens from now on. That list is kept in memory, so after a restart a
   * token that leaked would work again until it expires. As far as Albert Heijn lets it, the
   * refresh token is used up too, so nothing can be renewed with it.
   */
  async signOut(session: AhSession, signedInAt = seconds()): Promise<void> {
    const now = seconds();
    prune(this.ended, now);
    this.ended.set(session.id, signedInAt + SIGN_IN_TTL);
    if (!(await this.auth.logout(session.refreshToken))) {
      await this.auth.refresh(session.refreshToken).catch(() => undefined);
    }
  }

  /** Tokens for a sign-in that started at `signedInAt` (in seconds); none of them outlive the sign-in. */
  private issueTokens(clientId: string, session: AhSession, signedInAt: number): OAuthTokens {
    const now = seconds();
    const left = signedInAt + SIGN_IN_TTL - now;
    if (left <= 0) throw new InvalidGrantError("This sign-in has ended. Sign in again.");
    const accessTtl = Math.min(ACCESS_TTL, left, session.accessExpiresAt - EXPIRY_MARGIN - now);
    if (accessTtl <= 0) throw new ServerError("Albert Heijn gave a sign-in that has already expired. Try again.");
    const record: TokenRecord = {
      i: session.id,
      a: session.accessToken,
      r: session.refreshToken,
      e: session.accessExpiresAt,
      m: session.member ? 1 : 0,
      c: clientId,
      t: signedInAt,
    };
    return {
      access_token: ACCESS_PREFIX + this.sealer.seal("ah-access", record, accessTtl),
      token_type: "bearer",
      expires_in: accessTtl,
      refresh_token: REFRESH_PREFIX + this.sealer.seal("ah-refresh", record, left),
      scope: AH_SCOPE,
    };
  }

  private open(purpose: "ah-access" | "ah-refresh", prefix: string, token: string): (TokenRecord & { exp: number }) | null {
    if (typeof token !== "string" || !token.startsWith(prefix)) return null;
    const record = this.sealer.open<TokenRecord>(purpose, token.slice(prefix.length));
    if (!record || typeof record.exp !== "number" || typeof record.i !== "string" || typeof record.e !== "number") return null;
    return record as TokenRecord & { exp: number };
  }
}

function sessionOf(record: TokenRecord): AhSession {
  return { id: record.i, accessToken: record.a, refreshToken: record.r, accessExpiresAt: record.e, member: record.m === 1 };
}

/** What the app is told when Albert Heijn's tokens can't be renewed: sign in again, or try again. */
function renewalError(error: unknown): Error {
  return classifyAhError(error).kind === "session"
    ? new InvalidGrantError("The Albert Heijn sign-in has ended. Sign in again.")
    : new ServerError("Albert Heijn could not be reached to renew the sign-in. Try again.");
}

/** The Albert Heijn session of an authenticated MCP request. */
export function ahSessionOf(auth: AuthInfo | undefined): AhSession {
  const session = auth?.extra?.ahSession as AhSession | undefined;
  if (!session) throw new InvalidTokenError("Missing session");
  return session;
}
