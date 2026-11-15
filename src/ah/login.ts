import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { rateLimit } from "express-rate-limit";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Sealer } from "../crypto.js";
import { pickLang, STRINGS } from "../i18n.js";
import type { RedirectPolicy } from "../oauth.js";
import { sendMessagePage } from "../pages.js";
import { classifyAhError, type AhAuth } from "./client.js";
import { AH_STRINGS, type AhStrings } from "./i18n.js";
import { newAhSession, type AhOAuthProvider, type AhSession } from "./oauth.js";
import { sendAhLoginPage } from "./pages.js";

const TX_TTL = 30 * 60;

/** The authorization request, carried through the sign-in form in a sealed hidden field. */
type Tx = { c: string; r: string; ch: string; s?: string };

/**
 * The sign-in code from whatever the user pasted: the whole appie://login-exit?code=… address, a
 * URL-encoded copy of it, or the code alone. Only the code is taken; the address is never opened.
 */
export function extractCode(pasted: string): string | null {
  let text = pasted.trim();
  if (!text) return null;
  try {
    text = decodeURIComponent(text);
  } catch {
    // Not URL-encoded; use it as it is.
  }
  const inAddress = /[?&]code=([A-Za-z0-9._~-]{8,200})(?=[&#\s"']|$)/.exec(text);
  if (inAddress) return inAddress[1]!;
  return /^[A-Za-z0-9._~-]{8,200}$/.test(text) ? text : null;
}

export type AhLoginDeps = {
  sealer: Sealer;
  provider: AhOAuthProvider;
  auth: AhAuth;
  /** The registered apps and which of them the page vouches for; shared with the Picnic sign-in. */
  clients: { getClient(clientId: string): OAuthClientInformationFull | undefined };
  redirectPolicy: RedirectPolicy;
  serviceName: string;
  /** Sign-in attempts allowed per IP address per 15 minutes. */
  attemptLimit: number;
  /** Sign-in attempts that reach Albert Heijn per minute, for the whole server. */
  globalLimitPerMinute: number;
  log: (message: string) => void;
};

export function createAhLoginRouter({ sealer, provider, auth, clients, redirectPolicy, serviceName, attemptLimit, globalLimitPerMinute, log }: AhLoginDeps): Router {
  const router = express.Router();
  const verified = (redirectUri: string) => redirectPolicy.trust(redirectUri) !== "unknown";

  // /authorize has validated the client and its redirect URI; show the sign-in page.
  provider.onAuthorize = (client, params, res) => {
    const req = res.req;
    const tx: Tx = { c: client.client_id, r: params.redirectUri, ch: params.codeChallenge, ...(params.state ? { s: params.state } : {}) };
    sendAhLoginPage(res, 200, {
      serviceName,
      lang: pickLang(req),
      tx: sealer.seal("ah-tx", tx, TX_TTL),
      clientName: client.client_name,
      redirectUri: params.redirectUri,
      verified: verified(params.redirectUri),
      langHref: (l) => {
        const url = new URL(req.originalUrl, "http://x");
        url.searchParams.set("lang", l);
        return url.pathname + url.search;
      },
    });
  };

  type Attempt = {
    tx: Tx;
    /** The code to sign in with, or null to continue without an account. */
    code: string | null;
    /** Shows the form again with a message. */
    retry: (status: number, message: string) => void;
  };
  const attemptOf = (res: Response) => res.locals.attempt as Attempt;

  // These requests come from the user's own browser, so a limit per IP address is a limit per user.
  const perIp = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: attemptLimit,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      const lang = pickLang(req);
      sendMessagePage(res, 429, lang, serviceName, STRINGS[lang].errTooMany, "");
    },
  });

  // Every sign-in reaches Albert Heijn from this server's IP address; too many and it blocks that
  // address for every user. Only forms that passed their checks count.
  const global = rateLimit({
    windowMs: 60 * 1000,
    limit: globalLimitPerMinute,
    standardHeaders: false,
    legacyHeaders: false,
    keyGenerator: () => "all",
    handler: (req, res) => attemptOf(res).retry(429, STRINGS[pickLang(req)].errBusy),
  });

  /** Checks the form before anything goes to Albert Heijn. */
  const check = (req: Request, res: Response, next: NextFunction) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const lang = pickLang(req);
    const tx = sealer.open<Tx>("ah-tx", body.tx);
    const client = tx && clients.getClient(tx.c);
    if (!tx || !client) return sendMessagePage(res, 400, lang, serviceName, STRINGS[lang].expiredTitle, STRINGS[lang].expiredText);

    const retry = (status: number, error: string) =>
      sendAhLoginPage(res, status, {
        serviceName,
        lang,
        tx: body.tx as string,
        clientName: client.client_name,
        redirectUri: tx.r,
        verified: verified(tx.r),
        error,
      });

    const guest = body.action === "guest";
    const code = guest ? null : extractCode(typeof body.pasted === "string" ? body.pasted.slice(0, 2000) : "");
    if (!guest && !code) return retry(400, AH_STRINGS[lang].errMissing);
    res.locals.attempt = { tx, code, retry } satisfies Attempt;
    next();
  };

  const finish = (res: Response, tx: Tx, session: AhSession) => {
    const code = provider.issueCode({ clientId: tx.c, redirectUri: tx.r, codeChallenge: tx.ch, session });
    const target = new URL(tx.r);
    target.searchParams.set("code", code);
    if (tx.s) target.searchParams.set("state", tx.s);
    res.setHeader("Cache-Control", "no-store");
    res.redirect(303, target.href);
  };

  const loginError = (error: unknown, t: AhStrings): { status: number; message: string } => {
    const { kind, status } = classifyAhError(error);
    if (kind === "code") return { status: 401, message: t.errCode };
    log(`albert heijn sign-in failed: kind=${kind} status=${status ?? "-"}`);
    if (kind === "throttled") return { status: 429, message: t.errThrottled };
    if (kind === "refused") return { status: 502, message: t.errRefused };
    return { status: 502, message: t.errGeneric };
  };

  router.post("/ah/login", express.urlencoded({ extended: false, limit: "32kb" }), perIp, check, global, async (req, res) => {
    const { tx, code, retry } = attemptOf(res);
    try {
      const tokens = code ? await auth.exchangeCode(code) : await auth.anonymous();
      finish(res, tx, newAhSession(tokens, code !== null));
    } catch (error) {
      const { status, message } = loginError(error, AH_STRINGS[pickLang(req)]);
      retry(status, message);
    }
  });

  return router;
}
