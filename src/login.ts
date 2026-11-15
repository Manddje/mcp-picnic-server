import express, { type Request, type Response, type Router } from "express";
import { rateLimit } from "express-rate-limit";
import type { Sealer } from "./crypto.js";
import { pickLang, STRINGS, type Lang } from "./i18n.js";
import type { PicnicOAuthProvider } from "./oauth.js";
import { sendLoginPage, sendMessagePage, sendVerifyPage } from "./pages.js";
import { classifyPicnicError, isCountry, newDeviceId, type Country, type PicnicFactory, type PicnicSession } from "./picnic.js";

const TX_TTL = 30 * 60;
const PENDING_TTL = 10 * 60;

/** The authorization request, carried through the sign-in forms in a sealed hidden field. */
type Tx = { c: string; r: string; ch: string; s?: string };
/** A sign-in waiting for its SMS code: the request plus Picnic's not yet verified key. */
type Pending = Tx & { k: string; cc: string; d: string };

const DEFAULT_COUNTRY: Record<Lang, Country> = { en: "NL", nl: "NL", de: "DE", fr: "FR" };

export type LoginDeps = {
  sealer: Sealer;
  provider: PicnicOAuthProvider;
  picnic: PicnicFactory;
  serviceName: string;
  /** Sign-in attempts allowed per IP address per 15 minutes. */
  attemptLimit: number;
  log: (message: string) => void;
};

export function createLoginRouter({ sealer, provider, picnic, serviceName, attemptLimit, log }: LoginDeps): Router {
  const router = express.Router();

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

  // These requests come from the user's own browser, so a limit per IP address is a limit per user.
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: attemptLimit,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      const lang = pickLang(req);
      sendMessagePage(res, 429, lang, serviceName, STRINGS[lang].errTooMany, "");
    },
  });

  const form = express.urlencoded({ extended: false, limit: "32kb" });

  const finish = (res: Response, tx: Tx, session: PicnicSession) => {
    const code = provider.issueCode({ clientId: tx.c, redirectUri: tx.r, codeChallenge: tx.ch, session });
    const target = new URL(tx.r);
    target.searchParams.set("code", code);
    if (tx.s) target.searchParams.set("state", tx.s);
    res.setHeader("Cache-Control", "no-store");
    res.redirect(303, target.href);
  };

  const loginError = (error: unknown, t: (typeof STRINGS)[Lang]): { status: number; message: string } => {
    const { kind, status, code } = classifyPicnicError(error);
    if (kind === "credentials") return { status: 401, message: t.errCredentials };
    if (kind === "code") return { status: 401, message: t.errCode };
    log(`picnic sign-in failed: status=${status ?? "-"} code=${code ?? "-"}`);
    if (kind === "throttled") return { status: 429, message: t.errThrottled };
    return { status: 502, message: t.errGeneric };
  };

  router.post("/login", form, limiter, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const tx = sealer.open<Tx>("tx", body.tx);
    const client = tx && provider.clientsStore.getClient(tx.c);
    if (!tx || !client) return expired(req, res);

    const lang = pickLang(req);
    const t = STRINGS[lang];
    const country = isCountry(body.country) ? body.country : DEFAULT_COUNTRY[lang];
    const email = typeof body.email === "string" ? body.email.trim().slice(0, 254) : "";
    const password = typeof body.password === "string" ? body.password : "";
    const again = (status: number, error: string) =>
      sendLoginPage(res, status, {
        serviceName,
        lang,
        tx: body.tx as string,
        clientName: client.client_name,
        redirectUri: tx.r,
        country,
        email,
        error,
      });

    if (!email || !password || password.length > 512) return again(400, t.errMissing);

    const deviceId = newDeviceId();
    try {
      const api = picnic({ country, deviceId });
      const result = await api.auth.login(email, password);
      if (!result.secondFactorAuthenticationRequired) {
        return finish(res, tx, { authKey: result.authKey, country, deviceId });
      }
      await api.auth.generate2FACode("SMS");
      const pending: Pending = { ...tx, k: result.authKey, cc: country, d: deviceId };
      sendVerifyPage(res, 200, { serviceName, lang, pending: sealer.seal("pending", pending, PENDING_TTL) });
    } catch (error) {
      const { status, message } = loginError(error, t);
      again(status, message);
    }
  });

  router.post("/login/verify", form, limiter, async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const pending = sealer.open<Pending>("pending", body.pending);
    if (!pending || !isCountry(pending.cc)) return expired(req, res);

    const lang = pickLang(req);
    const t = STRINGS[lang];
    const again = (status: number, message: { error?: string; info?: string }) =>
      sendVerifyPage(res, status, { serviceName, lang, pending: body.pending as string, ...message });
    const api = picnic({ country: pending.cc, deviceId: pending.d, authKey: pending.k });

    try {
      if (body.action === "resend") {
        await api.auth.generate2FACode("SMS");
        return again(200, { info: t.resent });
      }
      const code = typeof body.code === "string" ? body.code.replace(/\D/g, "") : "";
      if (!code || code.length > 10) return again(400, { error: t.errCodeMissing });

      const result = await api.auth.verify2FACode(code);
      finish(res, pending, { authKey: result.authKey || pending.k, country: pending.cc, deviceId: pending.d });
    } catch (error) {
      const { status, message } = loginError(error, t);
      again(status, { error: message });
    }
  });

  return router;
}
