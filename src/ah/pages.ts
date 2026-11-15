import type { Response } from "express";
import { STRINGS, type Lang } from "../i18n.js";
import { brand, describeRedirect, esc, fill, langLinks, sendHtml } from "../pages.js";
import { AH_LOGIN_URL } from "./client.js";
import { AH_STRINGS } from "./i18n.js";

export type AhLoginPageOptions = {
  serviceName: string;
  lang: Lang;
  tx: string;
  clientName: string | undefined;
  redirectUri: string;
  /** Whether the redirect URI belongs to a known app or the user's own computer. Otherwise the page warns. */
  verified: boolean;
  error?: string;
  /** Present on the first render only, to switch language without losing the request. */
  langHref?: (lang: Lang) => string;
};

/**
 * The Albert Heijn sign-in page. Albert Heijn only signs people in on its own page, which ends at
 * an address for its app; the user copies that address and pastes it here. The password never
 * passes through this server.
 */
export function sendAhLoginPage(res: Response, status: number, o: AhLoginPageOptions): void {
  const t = AH_STRINGS[o.lang];
  const target = describeRedirect(o.redirectUri, STRINGS[o.lang]);
  // Anyone can register a client under any name, so only a verified app is called by its own name.
  const app = (o.verified && o.clientName) || target;

  const body = `<div class="wrap narrow login">
<header class="top">${brand(o.serviceName)}${o.langHref ? langLinks(o.lang, o.langHref) : ""}</header>
<main class="card">
<h1>${esc(t.loginTitle)}</h1>
<p class="lead">${fill(t.loginFor, "app", `<strong>${esc(app)}</strong>`)}</p>
${
    o.verified
      ? `<p class="sub">${fill(t.loginReturn, "target", `<strong>${esc(target)}</strong>`)}</p>`
      : `<div class="alert" role="alert">${fill(t.unknownApp, "target", `<strong>${esc(target)}</strong>`)}</div>`
  }
${o.error ? `<div class="alert" role="alert">${esc(o.error)}</div>` : ""}
<form method="post" action="/ah/login" autocomplete="off">
<input type="hidden" name="tx" value="${esc(o.tx)}">
<input type="hidden" name="lang" value="${o.lang}">
<div>
<label>${esc(t.step1Title)}</label>
<p class="sub">${esc(t.step1Text)}</p>
<p><a class="btn" href="${esc(AH_LOGIN_URL)}" target="_blank" rel="noopener noreferrer">${esc(t.step1Button)}</a></p>
</div>
<label>${esc(t.step2Title)}
<span class="sub">${esc(t.step2Text)}</span>
<input type="text" name="pasted" aria-label="${esc(t.pasteLabel)}" placeholder="appie://login-exit?code=…" autocapitalize="none" spellcheck="false" maxlength="2000">
</label>
<details><summary>${esc(t.howTitle)}</summary><div><ol>${t.howSteps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol></div></details>
<button type="submit" name="action" value="code">${esc(t.connect)}</button>
<div class="scope"><p>${esc(t.canDo)}</p><p>${esc(t.cannotDo)}</p></div>
<div>
<label>${esc(t.guestTitle)}</label>
<p class="sub">${esc(t.guestText)}</p>
<button type="submit" name="action" value="guest" class="ghost" formnovalidate>${esc(t.guestButton)}</button>
</div>
</form>
<p class="fine">${esc(t.loginNote)}</p>
</main>
<p class="fine center">${esc(t.disclaimer)}</p>
</div>`;
  sendHtml(res, status, o.lang, `${t.loginTitle} · ${o.serviceName}`, body);
}
