import { createHash, randomBytes } from "node:crypto";
import PicnicClient from "picnic-api";

export type Country = "NL" | "DE" | "FR";
export const COUNTRIES: Country[] = ["NL", "DE", "FR"];

export function isCountry(value: unknown): value is Country {
  return typeof value === "string" && (COUNTRIES as string[]).includes(value);
}

/** What the server needs to act as a Picnic user. It travels inside the user's encrypted token. */
export type PicnicSession = {
  authKey: string;
  country: Country;
  /** The device id this user signed in with; every sign-in gets its own, like an app install. */
  deviceId: string;
};

/** Creates the Picnic client for one user. */
export type PicnicFactory = (options: { country: Country; deviceId: string; authKey?: string }) => PicnicClient;

const MINUTE = 60 * 1000;

/** A user's Picnic key as a name to count that user under, without keeping the key itself. */
export function userOf(authKey: string): string {
  return createHash("sha256").update(authKey).digest("base64url");
}

/**
 * Why a request was not sent to Picnic: this server's own limit is used up ("limit"), this user's
 * share of it is ("user"), or Picnic is throttling ("pause").
 */
export class PicnicHeldError extends Error {
  constructor(
    readonly reason: "limit" | "user" | "pause",
    readonly retryAfterSeconds: number,
  ) {
    super(`Not sent to Picnic (${reason}); try again in ${retryAfterSeconds}s`);
    this.name = "PicnicHeldError";
  }
}

/**
 * Stands between the whole server and Picnic. Every user reaches Picnic from this server's IP
 * address, so once Picnic throttles that address everyone is locked out. The guard keeps the server
 * under a number of requests per minute, and stops all requests for a while as soon as Picnic
 * answers one with a throttling response, because requests sent while throttled prolong it.
 * One user gets no more than a share of those requests, so a single user can't use them all up.
 */
export class PicnicGuard {
  private windowStart = 0;
  private sent = 0;
  private readonly sentByUser = new Map<string, number>();
  private limitLogged = false;
  private pausedUntil = 0;

  constructor(
    private readonly options: {
      /** Requests that reach Picnic per minute, for the whole server. */
      limitPerMinute: number;
      /** Requests one signed-in user may send to Picnic per minute. */
      userLimitPerMinute: number;
      /** How long no request goes to Picnic after it throttled one; 0 for no pause. */
      pauseMs: number;
      log?: (message: string) => void;
      now?: () => number;
    },
  ) {}

  /**
   * Sends one request to Picnic, or throws a {@link PicnicHeldError} without sending it. `user` is
   * the signed-in user the request is for (see {@link userOf}); a sign-in has none yet.
   */
  async run<T>(send: () => Promise<T>, user?: string): Promise<T> {
    const { limitPerMinute, userLimitPerMinute, pauseMs, log, now = Date.now } = this.options;
    const time = now();
    if (time < this.pausedUntil) throw new PicnicHeldError("pause", Math.ceil((this.pausedUntil - time) / 1000));
    if (time - this.windowStart >= MINUTE) {
      this.windowStart = time;
      this.sent = 0;
      this.sentByUser.clear();
      this.limitLogged = false;
    }
    const sentByUser = user === undefined ? 0 : (this.sentByUser.get(user) ?? 0);
    if (sentByUser >= userLimitPerMinute) throw new PicnicHeldError("user", Math.ceil((this.windowStart + MINUTE - time) / 1000));
    if (this.sent >= limitPerMinute) {
      if (!this.limitLogged) log?.(`picnic request limit reached (${limitPerMinute} per minute): holding requests`);
      this.limitLogged = true;
      throw new PicnicHeldError("limit", Math.ceil((this.windowStart + MINUTE - time) / 1000));
    }
    this.sent++;
    if (user !== undefined) this.sentByUser.set(user, sentByUser + 1);
    try {
      return await send();
    } catch (error) {
      const { kind, status } = classifyPicnicError(error);
      if (kind === "throttled" && pauseMs > 0) {
        if (now() >= this.pausedUntil) log?.(`picnic is throttling (status ${status}): no requests for ${Math.round(pauseMs / 1000)}s`);
        this.pausedUntil = now() + pauseMs;
      }
      throw error;
    }
  }
}

type SendArgs = Parameters<PicnicClient["sendRequestWithHeaders"]>;

/** A Picnic client whose requests to Picnic's API all pass the guard. */
class GuardedPicnicClient extends PicnicClient {
  private readonly countedAs: string | undefined;

  constructor(
    options: ConstructorParameters<typeof PicnicClient>[0],
    private readonly guard: PicnicGuard,
  ) {
    super(options);
    this.countedAs = options?.authKey ? userOf(options.authKey) : undefined;
  }

  // Every request of the library goes through this method, including the several that one call can take.
  override sendRequestWithHeaders<TRequestData, TResponseData>(method: SendArgs[0], path: string, data?: TRequestData | null, options?: SendArgs[3]) {
    const send = () => super.sendRequestWithHeaders<TRequestData, TResponseData>(method, path, data, options);
    // Page scripts come from Picnic's CDN, which is another host with its own limits.
    const elsewhere = /^https?:\/\//.test(path) && new URL(path).origin !== new URL(this.url).origin;
    return elsewhere ? send() : this.guard.run(send, this.countedAs);
  }
}

/** The factory for real Picnic clients, all behind one guard. */
export const createPicnicClient =
  (guard: PicnicGuard): PicnicFactory =>
  ({ country, deviceId, authKey }) =>
    new GuardedPicnicClient({ countryCode: country, deviceId, authKey }, guard);

export function newDeviceId(): string {
  return randomBytes(8).toString("hex").toUpperCase();
}

/**
 * "throttled": Picnic refuses requests. "busy": this server has used up its own requests for this
 * minute. "over_share": this user has used up their share of them.
 */
export type PicnicErrorKind = "credentials" | "code" | "session" | "throttled" | "busy" | "over_share" | "not_found" | "other";

/** Sorts an error from picnic-api into the few cases the server treats differently. */
export function classifyPicnicError(error: unknown): { kind: PicnicErrorKind; status: number | null; code: string | null } {
  if (error instanceof PicnicHeldError) {
    const kind = ({ pause: "throttled", limit: "busy", user: "over_share" } as const)[error.reason];
    return { kind, status: null, code: null };
  }
  if (PicnicClient.isProductNotFoundError(error)) return { kind: "not_found", status: 404, code: null };
  if (!PicnicClient.isPicnicApiError(error)) return { kind: "other", status: null, code: null };
  const { status, code } = error;
  if (code === "AUTH_INVALID_CRED") return { kind: "credentials", status, code };
  if (code === "OTP_NOT_VALID") return { kind: "code", status, code };
  if (status === 401) return { kind: "session", status, code };
  // Picnic's edge answers a throttled client with a 403 HTML page (no code), or a 429.
  if (status === 429 || (status === 403 && !code)) return { kind: "throttled", status, code };
  if (status === 404) return { kind: "not_found", status, code };
  return { kind: "other", status, code };
}
