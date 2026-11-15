import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { rateLimit, type RateLimitRequestHandler } from "express-rate-limit";
import type { Sealer } from "./crypto.js";
import { isLang, pickLang, STRINGS, type Lang } from "./i18n.js";
import type { PicnicOAuthProvider } from "./oauth.js";
import { describeRedirect, sendLoginPage, sendMessagePage, sendReturnPage, sendVerifyPage } from "./pages.js";
import { classifyPicnicError, isCountry, newDeviceId, type Country, type PicnicFactory, type PicnicSession } from "./picnic.js";

const TX_TTL = 30 * 60;
const PENDING_TTL = 10 * 60;

/** The authorization request, carried through the sign-in forms in a sealed hidden field. */
type Tx = { c: string; r: string; ch: string; s?: string };
/**
 * A sign-in waiting for its SMS code: the request plus Picnic's not yet verified key and the account
 * it is for (`a` for the limits, `e` to show the user; sign-ins from before the page showed it lack `e`).
 */
type Pending = Tx & { k: string; cc: string; d: string; a: string; e?: string };

/** A sign-in form that passed its checks and is about to go to Picnic; set on res.locals.attempt. */
type Attempt = {
  /** The account the attempt is for, as a keyed hash of the email address. */
  account: string;
  /** Shows the form again with a message. */
  retry: (status: number, message: string) => void;
};

const DEFAULT_COUNTRY: Record<Lang, Country> = { en: "NL", nl: "NL", de: "DE", fr: "FR" };

export type LoginDeps = {
  sealer: Sealer;
  provider: PicnicOAuthProvider;
  picnic: PicnicFactory;
  serviceName: string;
  /** Sign-in attempts allowed per IP address per 15 minutes. */
  attemptLimit: number;
  /** Sign-in attempts allowed per Picnic account per 15 minutes, from any IP address. */
  accountAttemptLimit: number;
  /** Sign-in attempts that reach Picnic per minute, for the whole server. */
  globalLimitPerMinute: number;
  log: (message: string) => void;
};

export function createLoginRouter({
  sealer,
  provider,
  picnic,
  serviceName,
  attemptLimit,
  accountAttemptLimit,
  globalLimitPerMinute,
  log,
}: LoginDeps): Router {
  const router = express.Router();
  const verified = (redirectUri: string) => provider.redirectPolicy.trust(redirectUri) !== "unknown";

  // /authorize has validated the client and its redirect URI; show the sign-in form.
  provider.onAuthorize = (client, params, res) => {
    const req = res.req;
    const lang = pickLang(req);
    const tx: Tx = { c: client.client_id, r: params.redirectUri, ch: params.codeChallenge, ...(params.state ? { s: params.state } : {}) };
    sendLoginPage(res, 200, {
      serviceName,
      lang,
      tx: sealer.seal("tx", tx, TX_TTL),
      clientName: client.client_name,
      redirectUri: params.redirectUri,
      verified: verified(params.redirectUri),
      country: DEFAULT_COUNTRY[lang],
      langHref: (l) => {
        const url = new URL(req.originalUrl, "http://x");
        url.searchParams.set("lang", l);
        return url.pathname + url.search;
      },
    });
  };

  const expired = (req: Request, res: Response) => {
    const lang = pickLang(req);
    sendMessagePage(res, 400, lang, serviceName, STRINGS[lang].expiredTitle, STRINGS[lang].expiredText);
  };

  /* ---------- Limits ---------- */

  // These requests come from the user's own browser, so a limit per IP address is a limit per user.
  const perIp = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: attemptLimit,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      const lang = pickLang(req);
      sendMessagePage(res, 429, lang, serviceName, STRINGS[lang].tooManyTitle, STRINGS[lang].tooManyText);
    },
  });

  // The next two only count attempts that go to Picnic: forms that passed their checks.
  const attemptOf = (res: Response) => res.locals.attempt as Attempt;

  // Guessing one account's password from many IP addresses.
  const perAccount = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: accountAttemptLimit,
    standardHeaders: false,
    legacyHeaders: false,
    keyGenerator: (_req, res) => attemptOf(res).account,
    handler: (req, res) => attemptOf(res).retry(429, STRINGS[pickLang(req)].errTooMany),
  });

  // Every sign-in reaches Picnic from this server's IP address. Too many and Picnic throttles that
  // address, which locks every user out; this keeps the server under that point.
  const global = rateLimit({
    windowMs: 60 * 1000,
    limit: globalLimitPerMinute,
    standardHeaders: false,
    legacyHeaders: false,
    keyGenerator: () => "all",
    handler: (req, res) => attemptOf(res).retry(429, STRINGS[pickLang(req)].errBusy),
  });

  const limited: RateLimitRequestHandler[] = [perAccount, global];
  const form = express.urlencoded({ extended: false, limit: "32kb" });
  const accountOf = (email: string) => sealer.mac("account", email.toLowerCase());

  /* ---------- Sign-in ---------- */

  /**
   * Sends the user back to their app with the answer to its request. A web address or an app on
   * this computer shows a page of its own. An app with its own scheme (cursor://) doesn't: the
   * browser would stay on the form that was just sent, so it gets a page that opens the app and
   * says the tab is done with.
   */
  const leave = (req: Request, res: Response, tx: Tx, outcome: "done" | "cancelled", answer: Record<string, string>) => {
    const target = new URL(tx.r);
    for (const [name, value] of Object.entries(answer)) target.searchParams.set(name, value);
    if (tx.s) target.searchParams.set("state", tx.s);
    res.setHeader("Cache-Control", "no-store");
    if (target.protocol === "https:" || target.protocol === "http:") return res.redirect(303, target.href);
    const lang = pickLang(req);
    const name = verified(tx.r) ? provider.clientsStore.getClient(tx.c)?.client_name : undefined;
    sendReturnPage(res, { serviceName, lang, outcome, app: name || describeRedirect(tx.r, STRINGS[lang]), href: target.href });
  };

  const finish = (req: Request, res: Response, tx: Tx, session: PicnicSession) => {
    const code = provider.issueCode({ clientId: tx.c, redirectUri: tx.r, codeChallenge: tx.ch, session });
    leave(req, res, tx, "done", { code });
  };

  const loginError = (error: unknown, t: (typeof STRINGS)[Lang]): { status: number; message: string } => {
    const { kind, status, code } = classifyPicnicError(error);
    if (kind === "credentials") return { status: 401, message: t.errCredentials };
    if (kind === "code") return { status: 401, message: t.errCode };
    log(`picnic sign-in failed: status=${status ?? "-"} code=${code ?? "-"}`);
    if (kind === "throttled") return { status: 429, message: t.errThrottled };
    if (kind === "busy") return { status: 429, message: t.errBusy };
    if (kind === "over_share") return { status: 429, message: t.errTooMany };
    return { status: 502, message: t.errGeneric };
  };

  type LoginForm = { tx: Tx; country: Country; email: string; password: string };

  const emailOf = (body: Record<string, unknown>) => (typeof body.email === "string" ? body.email.trim().slice(0, 254) : "");

  /**
   * The buttons on the sign-in form that ask Picnic nothing: another language, and Cancel. They
   * don't count as sign-in attempts. Anything that isn't in order is left to the checks below.
   */
  const loginAside = (req: Request, res: Response, next: NextFunction) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const cancel = body.action === "cancel";
    if (!cancel && !isLang(body.setlang)) return next();
    const tx = sealer.open<Tx>("tx", body.tx);
    const client = tx && provider.clientsStore.getClient(tx.c);
    if (!tx || !client) return next();

    if (cancel) {
      // Only to an app the page vouched for; for any other app the page told the user to close it.
      if (!verified(tx.r)) return next();
      return leave(req, res, tx, "cancelled", { error: "access_denied", error_description: "The user cancelled the sign-in" });
    }
    const lang = body.setlang as Lang;
    sendLoginPage(res, 200, {
      serviceName,
      lang,
      tx: body.tx as string,
      clientName: client.client_name,
      redirectUri: tx.r,
      verified: verified(tx.r),
      country: isCountry(body.country) ? body.country : DEFAULT_COUNTRY[lang],
      email: emailOf(body),
    });
  };

  /** Checks the sign-in form before anything goes to Picnic. */
  const checkLogin = (req: Request, res: Response, next: NextFunction) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const tx = sealer.open<Tx>("tx", body.tx);
    const client = tx && provider.clientsStore.getClient(tx.c);
    if (!tx || !client) return expired(req, res);

    const lang = pickLang(req);
    const country = isCountry(body.country) ? body.country : DEFAULT_COUNTRY[lang];
    const email = emailOf(body);
    const password = typeof body.password === "string" ? body.password : "";
    const retry = (status: number, error: string) =>
      sendLoginPage(res, status, {
        serviceName,
        lang,
        tx: body.tx as string,
        clientName: client.client_name,
        redirectUri: tx.r,
        verified: verified(tx.r),
        country,
        email,
        error,
      });

    if (!email || !password || password.length > 512) return retry(400, STRINGS[lang].errMissing);
    res.locals.login = { tx, country, email, password } satisfies LoginForm;
    res.locals.attempt = { account: accountOf(email), retry } satisfies Attempt;
    next();
  };

  router.post("/login", form, loginAside, perIp, checkLogin, ...limited, async (req, res) => {
    const { tx, country, email, password } = res.locals.login as LoginForm;
    const { account, retry } = attemptOf(res);
    const t = STRINGS[pickLang(req)];

    const deviceId = newDeviceId();
    try {
      const api = picnic({ country, deviceId });
      const result = await api.auth.login(email, password);
      if (!result.secondFactorAuthenticationRequired) {
        return finish(req, res, tx, { authKey: result.authKey, country, deviceId });
      }
      await api.auth.generate2FACode("SMS");
      const pending: Pending = { ...tx, k: result.authKey, cc: country, d: deviceId, a: account, e: email };
      sendVerifyPage(res, 200, { serviceName, lang: pickLang(req), pending: sealer.seal("pending", pending, PENDING_TTL), email });
    } catch (error) {
      const { status, message } = loginError(error, t);
      retry(status, message);
    }
  });

  /* ---------- SMS code ---------- */

  type VerifyForm = { pending: Pending & { cc: Country }; action: "resend" | "verify"; code: string };

  /**
   * The buttons on the code form that ask Picnic nothing: another language, and going back to sign
   * in with a different account. They don't count as attempts.
   */
  const verifyAside = (req: Request, res: Response, next: NextFunction) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const back = body.action === "back";
    if (!back && !isLang(body.setlang)) return next();
    const pending = sealer.open<Pending>("pending", body.pending);
    const client = pending && provider.clientsStore.getClient(pending.c);
    if (!pending || !client || !isCountry(pending.cc)) return next();

    if (back) {
      const lang = pickLang(req);
      const tx: Tx = { c: pending.c, r: pending.r, ch: pending.ch, ...(pending.s ? { s: pending.s } : {}) };
      return sendLoginPage(res, 200, {
        serviceName,
        lang,
        tx: sealer.seal("tx", tx, TX_TTL),
        clientName: client.client_name,
        redirectUri: tx.r,
        verified: verified(tx.r),
        country: pending.cc,
      });
    }
    sendVerifyPage(res, 200, { serviceName, lang: body.setlang as Lang, pending: body.pending as string, email: pending.e });
  };

  /** Checks the code form before anything goes to Picnic. Resending a code counts as an attempt too. */
  const checkVerify = (req: Request, res: Response, next: NextFunction) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const pending = sealer.open<Pending>("pending", body.pending);
    if (!pending || !isCountry(pending.cc) || typeof pending.a !== "string") return expired(req, res);

    const lang = pickLang(req);
    const show = (status: number, message: { error?: string; info?: string }) =>
      sendVerifyPage(res, status, { serviceName, lang, pending: body.pending as string, email: pending.e, ...message });
    const action = body.action === "resend" ? "resend" : "verify";
    const code = typeof body.code === "string" ? body.code.replace(/\D/g, "") : "";
    if (action === "verify" && (!code || code.length > 10)) return show(400, { error: STRINGS[lang].errCodeMissing });

    res.locals.verify = { pending: pending as VerifyForm["pending"], action, code } satisfies VerifyForm;
    res.locals.show = show;
    res.locals.attempt = { account: pending.a, retry: (status, error) => show(status, { error }) } satisfies Attempt;
    next();
  };

  router.post("/login/verify", form, verifyAside, perIp, checkVerify, ...limited, async (req, res) => {
    const { pending, action, code } = res.locals.verify as VerifyForm;
    const show = res.locals.show as (status: number, message: { error?: string; info?: string }) => void;
    const t = STRINGS[pickLang(req)];
    const api = picnic({ country: pending.cc, deviceId: pending.d, authKey: pending.k });

    try {
      if (action === "resend") {
        await api.auth.generate2FACode("SMS");
        return show(200, { info: t.resent });
      }
      const result = await api.auth.verify2FACode(code);
      finish(req, res, pending, { authKey: result.authKey || pending.k, country: pending.cc, deviceId: pending.d });
    } catch (error) {
      const { status, message } = loginError(error, t);
      show(status, { error: message });
    }
  });

  return router;
}
