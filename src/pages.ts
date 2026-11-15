import { randomBytes } from "node:crypto";
import type { Response } from "express";
import { LANG_NAMES, LANGS, STRINGS, type Lang, type Strings } from "./i18n.js";
import { ICON_LINKS, ICON_SVG } from "./icons.js";
import { COUNTRIES, type Country } from "./picnic.js";

export function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const ICON_URI = `data:image/svg+xml,${encodeURIComponent(ICON_SVG)}`;

const CSS = `
:root{--bg:#f6f5f1;--card:#fff;--ink:#1c1b18;--muted:#66655f;--line:#e2e0d8;--accent:#1f7a4d;--accent-ink:#fff;--soft:#eef5f0;--err:#b3261e;--err-bg:#fdeceb;--code:#f1efe9}
@media (prefers-color-scheme:dark){:root{--bg:#141512;--card:#1e1f1b;--ink:#f1f0ea;--muted:#a5a49c;--line:#34352f;--accent:#58c48d;--accent-ink:#0d1f15;--soft:#1d2a22;--err:#ffb4ab;--err-bg:#3a1512;--code:#272823}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent)}
h1,h2{line-height:1.2;margin:0;text-wrap:balance}
.wrap{max-width:720px;margin:0 auto;padding:32px 16px 56px}
.narrow{max-width:440px}
.brand{display:flex;align-items:center;gap:10px;font-weight:650;letter-spacing:-.01em}
.brand img{width:32px;height:32px;display:block}
.top{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:40px}
.langs{display:flex;gap:4px;font-size:14px}
.langs a{padding:4px 8px;border-radius:6px;text-decoration:none;color:var(--muted)}
.langs a[aria-current]{background:var(--soft);color:var(--ink);font-weight:600}
.hero h1{font-size:clamp(30px,6vw,42px);letter-spacing:-.025em}
.hero p{font-size:18px;color:var(--muted);margin:14px 0 0;max-width:58ch}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px}
.url{margin-top:28px}
.label{font-size:13px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px}
.copyrow{display:flex;gap:8px;align-items:stretch}
.copyrow code{flex:1;min-width:0;overflow-x:auto;white-space:nowrap;background:var(--code);border-radius:9px;padding:11px 13px;font:15px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
button,.btn{font:inherit;font-weight:600;border:0;border-radius:9px;padding:11px 16px;background:var(--accent);color:var(--accent-ink);cursor:pointer;text-decoration:none;display:inline-block;text-align:center}
button.ghost{background:transparent;color:var(--accent);border:1px solid var(--line)}
button.link{background:none;color:var(--accent);padding:0;font-weight:500;text-decoration:underline}
button:focus-visible,.btn:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:3px solid color-mix(in srgb,var(--accent) 45%,transparent);outline-offset:2px}
section{margin-top:44px}
section>h2{font-size:22px;letter-spacing:-.015em;margin-bottom:14px}
.note{color:var(--muted);margin:0 0 16px}
details{background:var(--card);border:1px solid var(--line);border-radius:12px;margin-top:8px}
summary{cursor:pointer;padding:14px 16px;font-weight:600;list-style-position:inside;border-radius:12px}
details>div{padding:0 16px 16px}
details ol{margin:0;padding-left:22px}
details li{margin:6px 0}
details p{margin:10px 0}
pre{margin:8px 0 0;background:var(--code);border-radius:9px;padding:12px 13px;overflow-x:auto;font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
ul.plain{list-style:none;margin:0;padding:0;display:grid;gap:10px}
ul.plain li{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:13px 16px}
ul.checks li{padding-left:44px;position:relative}
ul.checks li::before{content:"✓";position:absolute;left:16px;top:12px;color:var(--accent);font-weight:700}
footer{margin-top:48px;padding-top:20px;border-top:1px solid var(--line);color:var(--muted);font-size:14px}
footer p{margin:4px 0}
.login h1{font-size:26px;letter-spacing:-.02em;margin-top:6px}
.login .lead{margin:10px 0 0}
.login .sub{margin:4px 0 0;color:var(--muted);font-size:15px}
form{margin-top:22px;display:grid;gap:14px}
label{display:grid;gap:6px;font-size:14px;font-weight:600}
input,select{font:inherit;font-size:16px;font-weight:400;color:var(--ink);background:var(--card);border:1px solid var(--line);border-radius:9px;padding:11px 12px;width:100%}
input.otp{font:600 22px/1.2 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:.3em;text-align:center}
.alert{margin-top:18px;padding:11px 13px;border-radius:9px;background:var(--err-bg);color:var(--err);font-size:15px}
.info{margin-top:18px;padding:11px 13px;border-radius:9px;background:var(--soft);font-size:15px}
.scope{margin:22px 0 0;padding:13px 15px;border-radius:10px;background:var(--soft);font-size:14px}
.scope p{margin:0}
.scope p+p{margin-top:6px;font-weight:600}
.fine{color:var(--muted);font-size:13px;margin:14px 0 0}
.center{text-align:center}
`;

type HtmlOptions = {
  script?: string;
  /** Extra tags for the head, already escaped. */
  head?: string;
  /** Whether search engines may list the page. Only the landing page asks for this. */
  indexable?: boolean;
};

function sendHtml(res: Response, status: number, lang: Lang, title: string, body: string, { script = "", head = "", indexable = false }: HtmlOptions = {}): void {
  const nonce = randomBytes(16).toString("base64");
  res.status(status);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src data: 'self'; base-uri 'none'; frame-ancestors 'none'`,
  );
  res.send(`<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="${indexable ? "index,follow" : "noindex"}">
<meta name="color-scheme" content="light dark">
<title>${esc(title)}</title>
${head}
${ICON_LINKS}
<style nonce="${nonce}">${CSS}</style>
</head>
<body>
${body}
${script ? `<script nonce="${nonce}">${script}</script>` : ""}
</body>
</html>`);
}

function brand(serviceName: string): string {
  return `<div class="brand"><img src="${ICON_URI}" alt="" width="32" height="32"><span>${esc(serviceName)}</span></div>`;
}

function langLinks(current: Lang, hrefFor: (lang: Lang) => string): string {
  return `<nav class="langs" aria-label="Language">${LANGS.map(
    (l) => `<a href="${esc(hrefFor(l))}" lang="${l}" hreflang="${l}" title="${LANG_NAMES[l]}"${l === current ? ' aria-current="true"' : ""}>${l.toUpperCase()}</a>`,
  ).join("")}</nav>`;
}

/* ---------- Landing page ---------- */

export type LandingOptions = {
  serviceName: string;
  /** The public address of this page, ending in a slash. */
  homeUrl: string;
  /** Whether the address names the language (`/?lang=nl`), rather than leaving it to the browser (`/`). */
  pinned: boolean;
  mcpUrl: string;
  contact: string | null;
  sourceUrl: string | null;
};

const OG_LOCALE: Record<Lang, string> = { en: "en_US", nl: "nl_NL", de: "de_DE", fr: "fr_FR" };

/** What search engines and link previews read: one address per language, and `/` for everyone else. */
function landingHead(lang: Lang, title: string, o: LandingOptions): string {
  const t = STRINGS[lang];
  const urlFor = (l: Lang) => `${o.homeUrl}?lang=${l}`;
  const canonical = o.pinned ? urlFor(lang) : o.homeUrl;
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: o.serviceName,
    description: t.metaDescription,
    url: canonical,
    inLanguage: lang,
    applicationCategory: "ShoppingApplication",
    operatingSystem: "Any",
    offers: { "@type": "Offer", price: "0", priceCurrency: "EUR" },
  }).replace(/</g, "\\u003c");

  return [
    `<meta name="description" content="${esc(t.metaDescription)}">`,
    `<link rel="canonical" href="${esc(canonical)}">`,
    ...LANGS.map((l) => `<link rel="alternate" hreflang="${l}" href="${esc(urlFor(l))}">`),
    `<link rel="alternate" hreflang="x-default" href="${esc(o.homeUrl)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="${esc(o.serviceName)}">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(t.metaDescription)}">`,
    `<meta property="og:url" content="${esc(canonical)}">`,
    `<meta property="og:image" content="${esc(o.homeUrl)}icon-512.png">`,
    `<meta property="og:locale" content="${OG_LOCALE[lang]}">`,
    ...LANGS.filter((l) => l !== lang).map((l) => `<meta property="og:locale:alternate" content="${OG_LOCALE[l]}">`),
    `<meta name="twitter:card" content="summary">`,
    // A data block, not a script that runs, so the content security policy leaves it alone.
    `<script type="application/ld+json">${jsonLd}</script>`,
  ].join("\n");
}

export function sendLanding(res: Response, lang: Lang, o: LandingOptions): void {
  const t = STRINGS[lang];
  const url = o.mcpUrl;
  const cursorConfig = Buffer.from(JSON.stringify({ url })).toString("base64");
  const cursorLink = `cursor://anysphere.cursor-deeplink/mcp/install?name=picnic&config=${encodeURIComponent(cursorConfig)}`;
  const vscodeConfig = JSON.stringify({ name: "picnic", type: "http", url });
  const vscodeLink = `vscode:mcp/install?${encodeURIComponent(vscodeConfig)}`;
  const cursorJson = JSON.stringify({ mcpServers: { picnic: { url } } }, null, 2);
  const remoteJson = JSON.stringify({ mcpServers: { picnic: { command: "npx", args: ["-y", "mcp-remote", url] } } }, null, 2);
  const steps = (items: string[]) => `<ol>${items.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>`;
  const contactHref = o.contact && (/^https?:\/\//.test(o.contact) ? o.contact : `mailto:${o.contact}`);

  const body = `<div class="wrap">
<header class="top">${brand(o.serviceName)}${langLinks(lang, (l) => `/?lang=${l}`)}</header>
<main>
<div class="hero">
<h1>${esc(t.tagline)}</h1>
<p>${esc(t.intro)}</p>
</div>

<div class="card url">
<div class="label">${esc(t.urlLabel)}</div>
<div class="copyrow"><code id="mcp-url">${esc(url)}</code><button type="button" data-copy="mcp-url" data-done="${esc(t.copied)}">${esc(t.copy)}</button></div>
</div>

<section>
<h2>${esc(t.howTitle)}</h2>
<p class="note">${esc(t.signinNote)}</p>
<details open><summary>${esc(t.claudeTitle)}</summary><div>${steps(t.claudeSteps)}</div></details>
<details><summary>${esc(t.claudeCodeTitle)}</summary><div><pre>claude mcp add --transport http picnic ${esc(url)}</pre><p>${esc(t.claudeCodeAfter)}</p></div></details>
<details><summary>${esc(t.chatgptTitle)}</summary><div>${steps(t.chatgptSteps)}</div></details>
<details><summary>${esc(t.cursorTitle)}</summary><div><p><a class="btn" href="${esc(cursorLink)}">${esc(t.cursorButton)}</a></p><p>${esc(t.cursorManual)}</p><pre>${esc(cursorJson)}</pre></div></details>
<details><summary>${esc(t.vscodeTitle)}</summary><div><p><a class="btn" href="${esc(vscodeLink)}">${esc(t.vscodeButton)}</a></p><p>${esc(t.vscodeManual)}</p><pre>code --add-mcp '${esc(vscodeConfig)}'</pre></div></details>
<details><summary>${esc(t.otherTitle)}</summary><div><p>${esc(t.otherText)}</p><pre>${esc(remoteJson)}</pre></div></details>
</section>

<section>
<h2>${esc(t.askTitle)}</h2>
<ul class="plain">${t.examples.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>
</section>

<section>
<h2>${esc(t.privacyTitle)}</h2>
<ul class="plain checks">${t.privacyItems.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>
</section>
</main>

<footer>
<p>${esc(t.disclaimer)}</p>
<p>${[
    contactHref ? `<a href="${esc(contactHref)}">${esc(t.contact)}</a>` : "",
    o.sourceUrl ? `<a href="${esc(o.sourceUrl)}" rel="noopener">${esc(t.source)}</a>` : "",
    `<a href="https://github.com/MRVDH/picnic-api" rel="noopener">picnic-api</a>`,
  ]
    .filter(Boolean)
    .join(" · ")}</p>
</footer>
</div>`;

  const script = `document.addEventListener("click",function(e){var b=e.target.closest("[data-copy]");if(!b)return;var s=document.getElementById(b.dataset.copy);navigator.clipboard.writeText(s.textContent).then(function(){var o=b.textContent;b.textContent=b.dataset.done;setTimeout(function(){b.textContent=o},1600)})});`;
  const title = `${o.serviceName} · ${t.tagline}`;
  if (!o.pinned) res.vary("Accept-Language");
  sendHtml(res, 200, lang, title, body, { script, head: landingHead(lang, title, o), indexable: true });
}

/* ---------- Sign-in pages ---------- */

/** Where the user goes after signing in, in words: a host name, an app scheme, or "an app on this computer". */
export function describeRedirect(redirectUri: string, t: Strings): string {
  try {
    const url = new URL(redirectUri);
    if (url.protocol === "https:") return url.host;
    if (url.protocol === "http:") return t.thisComputer;
    return `${url.protocol}//`;
  } catch {
    return redirectUri;
  }
}

function fill(template: string, key: string, html: string): string {
  const [before = "", after = ""] = template.split(`{${key}}`);
  return `${esc(before)}${html}${esc(after)}`;
}

export type LoginPageOptions = {
  serviceName: string;
  lang: Lang;
  tx: string;
  clientName: string | undefined;
  redirectUri: string;
  /** Whether the redirect URI belongs to a known app or the user's own computer. Otherwise the page warns. */
  verified: boolean;
  country: Country;
  email?: string;
  error?: string;
  /** Present on the first render only, to switch language without losing the request. */
  langHref?: (lang: Lang) => string;
};

export function sendLoginPage(res: Response, status: number, o: LoginPageOptions): void {
  const t = STRINGS[o.lang];
  const target = describeRedirect(o.redirectUri, t);
  // Anyone can register a client under any name, so only a verified app is called by its own name.
  const app = (o.verified && o.clientName) || target;
  const countryName: Record<Country, string> = { NL: t.countryNL, DE: t.countryDE, FR: t.countryFR };

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
<form method="post" action="/login" autocomplete="on">
<input type="hidden" name="tx" value="${esc(o.tx)}">
<input type="hidden" name="lang" value="${o.lang}">
<label>${esc(t.country)}
<select name="country">${COUNTRIES.map((c) => `<option value="${c}"${c === o.country ? " selected" : ""}>${esc(countryName[c])}</option>`).join("")}</select>
</label>
<label>${esc(t.email)}
<input type="email" name="email" value="${esc(o.email ?? "")}" autocomplete="username" inputmode="email" autocapitalize="none" spellcheck="false" required${o.email ? "" : " autofocus"}>
</label>
<label>${esc(t.password)}
<input type="password" name="password" autocomplete="current-password" required${o.email ? " autofocus" : ""}>
</label>
<button type="submit">${esc(t.signIn)}</button>
</form>
<div class="scope"><p>${esc(t.canDo)}</p><p>${esc(t.cannotDo)}</p></div>
<p class="fine">${esc(t.loginNote)}</p>
</main>
<p class="fine center">${esc(t.disclaimer)}</p>
</div>`;
  sendHtml(res, status, o.lang, `${t.loginTitle} · ${o.serviceName}`, body);
}

export type VerifyPageOptions = { serviceName: string; lang: Lang; pending: string; error?: string; info?: string };

export function sendVerifyPage(res: Response, status: number, o: VerifyPageOptions): void {
  const t = STRINGS[o.lang];
  const body = `<div class="wrap narrow login">
<header class="top">${brand(o.serviceName)}</header>
<main class="card">
<h1>${esc(t.verifyTitle)}</h1>
<p class="lead">${esc(t.verifyText)}</p>
${o.error ? `<div class="alert" role="alert">${esc(o.error)}</div>` : ""}
${o.info ? `<div class="info" role="status">${esc(o.info)}</div>` : ""}
<form method="post" action="/login/verify" autocomplete="off">
<input type="hidden" name="pending" value="${esc(o.pending)}">
<input type="hidden" name="lang" value="${o.lang}">
<label>${esc(t.code)}
<input class="otp" type="text" name="code" inputmode="numeric" pattern="[0-9 ]*" maxlength="12" autocomplete="one-time-code" autofocus>
</label>
<button type="submit" name="action" value="verify">${esc(t.verify)}</button>
<button type="submit" name="action" value="resend" class="link" formnovalidate>${esc(t.resend)}</button>
</form>
</main>
<p class="fine center">${esc(t.disclaimer)}</p>
</div>`;
  sendHtml(res, status, o.lang, `${t.verifyTitle} · ${o.serviceName}`, body);
}

export function sendMessagePage(res: Response, status: number, lang: Lang, serviceName: string, title: string, text: string): void {
  const body = `<div class="wrap narrow login">
<header class="top">${brand(serviceName)}</header>
<main class="card"><h1>${esc(title)}</h1><p class="lead">${esc(text)}</p></main>
</div>`;
  sendHtml(res, status, lang, `${title} · ${serviceName}`, body);
}
