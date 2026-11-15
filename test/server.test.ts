import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { Sealer } from "../src/crypto.js";
import { LANGS, STRINGS } from "../src/i18n.js";
import { isAllowedRedirectUri, SIGN_IN_TTL } from "../src/oauth.js";
import { createPicnicClient, PicnicGuard, PicnicHeldError } from "../src/picnic.js";
import { FakePicnic } from "./fake-picnic.js";

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

let server: Server;
let base: string;
let picnic: FakePicnic;
let port: number;

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

before(async () => {
  port = await freePort();
  picnic = new FakePicnic();
  // This server serves most tests, so the limits that protect Picnic are out of their way.
  const config = loadConfig({
    PORT: String(port),
    SECRET_KEY: "t".repeat(48),
    TRUST_PROXY: "false",
    SIGN_IN_LIMIT_PER_MINUTE: "10000",
    PICNIC_LIMIT_PER_MINUTE: "100000",
    PICNIC_PAUSE_SECONDS: "0",
  });
  base = config.publicUrl.origin;
  server = createApp({ config, picnic: picnic.factory, signInAttemptLimit: 10_000, accountAttemptLimit: 10_000, log: () => {} }).listen(
    port,
    "127.0.0.1",
  );
  await new Promise((resolve) => server.once("listening", resolve));
});

after(() => new Promise((resolve) => server.close(resolve)));

/** Starts a second server with other settings, for the tests of limits and policies. */
async function startServer(env: Record<string, string>, options: { signInAttemptLimit?: number; accountAttemptLimit?: number } = {}) {
  const otherPort = await freePort();
  const config = loadConfig({ PORT: String(otherPort), SECRET_KEY: "t".repeat(48), TRUST_PROXY: "false", ...env });
  const other = createApp({ config, picnic: picnic.factory, log: () => {}, ...options }).listen(otherPort, "127.0.0.1");
  await new Promise((resolve) => other.once("listening", resolve));
  return { base: config.publicUrl.origin, close: () => new Promise((resolve) => other.close(resolve)) };
}

const form = (fields: Record<string, string>) => ({
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields),
  redirect: "manual" as const,
});

const hidden = (html: string, name: string) => {
  const value = new RegExp(`name="${name}" value="([^"]+)"`).exec(html)?.[1];
  assert.ok(value, `hidden field ${name} is on the page`);
  return value;
};

async function register(extra: Record<string, unknown> = {}, at = base) {
  const res = await fetch(`${at}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none", ...extra }),
  });
  return { res, client: (await res.json()) as { client_id: string; client_secret?: string; error?: string } };
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function openSignIn(clientId: string, challenge: string, { redirect = REDIRECT, at = base, lang = "nl-NL,nl;q=0.9" } = {}) {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirect,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st4te",
  });
  return fetch(`${at}/authorize?${query}`, { headers: { "Accept-Language": lang } });
}

/** Walks the whole sign-in as a browser would and returns the authorization code. */
async function signIn(clientId: string, challenge: string, email = "kim@example.com", at = base): Promise<string> {
  const page = await (await openSignIn(clientId, challenge, { at })).text();
  const login = await fetch(`${at}/login`, form({ tx: hidden(page, "tx"), lang: "nl", country: "NL", email, password: FakePicnic.PASSWORD }));
  let done = login;
  if (login.status === 200) {
    const verifyPage = await login.text();
    done = await fetch(`${at}/login/verify`, form({ pending: hidden(verifyPage, "pending"), lang: "nl", code: FakePicnic.SMS_CODE, action: "verify" }));
  }
  assert.equal(done.status, 303);
  const location = new URL(done.headers.get("location")!);
  assert.equal(location.origin + location.pathname, REDIRECT);
  assert.equal(location.searchParams.get("state"), "st4te");
  return location.searchParams.get("code")!;
}

async function token(fields: Record<string, string>, at = base) {
  const res = await fetch(`${at}/token`, form(fields));
  return { res, body: (await res.json()) as { access_token: string; refresh_token: string; expires_in: number; error?: string } };
}

async function connect(email?: string, at = base) {
  const { client } = await register({}, at);
  const { verifier, challenge } = pkce();
  const code = await signIn(client.client_id, challenge, email, at);
  const { body } = await token({ grant_type: "authorization_code", client_id: client.client_id, code, code_verifier: verifier, redirect_uri: REDIRECT }, at);
  assert.ok(body.access_token, "token endpoint returns an access token");
  return { clientId: client.client_id, ...body };
}

async function mcp(accessToken: string, at = base): Promise<Client> {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${at}/picnic/mcp`), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }),
  );
  return client;
}

const textOf = (result: unknown) => (result as { content: { text: string }[] }).content[0]!.text;

describe("discovery", () => {
  it("tells clients where to sign in", async () => {
    const challenge = await fetch(`${base}/picnic/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(challenge.status, 401);
    const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge.headers.get("www-authenticate") ?? "")?.[1];
    assert.equal(metadataUrl, `${base}/.well-known/oauth-protected-resource/picnic/mcp`);

    const resource = (await (await fetch(metadataUrl)).json()) as { resource: string; authorization_servers: string[] };
    assert.equal(resource.resource, `${base}/picnic/mcp`);

    const as = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    assert.equal(as.registration_endpoint, `${base}/register`);
    assert.equal(as.authorization_endpoint, `${base}/authorize`);
    assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
  });

  it("keeps the address from before the connectors had their own path working", async () => {
    const challenge = await fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(challenge.status, 401);
    const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge.headers.get("www-authenticate") ?? "")?.[1];
    assert.equal(metadataUrl, `${base}/.well-known/oauth-protected-resource/mcp`);
    // An app checks that the metadata is about the address it connects to.
    assert.equal(((await (await fetch(metadataUrl)).json()) as { resource: string }).resource, `${base}/mcp`);
    assert.equal(((await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json()) as { resource: string }).resource, `${base}/picnic/mcp`);

    // One sign-in works at both addresses.
    const { access_token } = await connect();
    for (const path of ["/mcp", "/picnic/mcp"]) {
      const client = new Client({ name: "test", version: "0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}${path}`), { requestInit: { headers: { Authorization: `Bearer ${access_token}` } } }));
      assert.equal((await client.listTools()).tools.length, 23, path);
      await client.close();
    }
    assert.equal((await fetch(`${base}/mcp`)).status, 405);
  });

  it("serves the landing page in the visitor's language", async () => {
    const res = await fetch(`${base}/`, { headers: { "Accept-Language": "de" } });
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /<html lang="de">/);
    assert.ok(html.includes(`${base}/picnic/mcp`));
    assert.match(res.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  });

  it("offers a button per app that can add the server from a link", async () => {
    const html = await (await fetch(`${base}/?lang=nl`)).text();
    const links = [...html.matchAll(/<a class="btn[^"]*" href="([^"]+)"/g)].map((m) => m[1]!.replaceAll("&amp;", "&"));

    // Claude: its own link for a connector by address, with the name and address filled in.
    const claude = new URL(links.find((l) => l.startsWith("https://claude.ai/"))!);
    assert.equal(claude.pathname, "/customize/connectors");
    assert.equal(claude.searchParams.get("modal"), "add-custom-connector");
    assert.equal(claude.searchParams.get("connectorName"), "Picnic");
    assert.equal(claude.searchParams.get("connectorUrl"), `${base}/picnic/mcp`);

    const cursor = new URL(links.find((l) => l.startsWith("cursor://"))!);
    assert.deepEqual(JSON.parse(Buffer.from(cursor.searchParams.get("config")!, "base64").toString()), { url: `${base}/picnic/mcp` });

    const vscode = links.find((l) => l.startsWith("vscode:mcp/install?"))!;
    assert.deepEqual(JSON.parse(decodeURIComponent(vscode.slice("vscode:mcp/install?".length))), { name: "picnic", type: "http", url: `${base}/picnic/mcp` });
    assert.match(html, /Toevoegen aan Claude/);
  });

  it("serves its own icon, so apps do not show the icon of the parent domain", async () => {
    const types = {
      "/favicon.ico": "image/x-icon",
      "/icon.svg": "image/svg+xml",
      "/icon-192.png": "image/png",
      "/icon-512.png": "image/png",
      "/apple-touch-icon.png": "image/png",
    };
    const robots = await (await fetch(`${base}/robots.txt`)).text();
    for (const [path, type] of Object.entries(types)) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 200, path);
      assert.equal(res.headers.get("content-type"), type, path);
      assert.match(res.headers.get("cache-control") ?? "", /public/, path);
      assert.ok((await res.arrayBuffer()).byteLength > 200, `${path} has content`);
      assert.ok(robots.includes(`Allow: ${path}$`), `${path} may be crawled`);
    }
    const png = new Uint8Array(await (await fetch(`${base}/icon-192.png`)).arrayBuffer());
    assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);

    const res = await fetch(`${base}/`);
    const html = await res.text();
    assert.ok(html.includes(`<link rel="icon" href="/favicon.ico"`));
    assert.ok(html.includes(`<link rel="apple-touch-icon" href="/apple-touch-icon.png">`));
    assert.match(res.headers.get("content-security-policy") ?? "", /img-src data: 'self'/, "the browser may load the icon");
  });

  it("gives each language of the landing page its own address for search engines", async () => {
    const res = await fetch(`${base}/?lang=nl`, { headers: { "Accept-Language": "de" } });
    const html = await res.text();
    assert.match(html, /<html lang="nl">/);
    assert.match(html, /<meta name="robots" content="index,follow">/);
    assert.ok(html.includes(`<meta name="description" content="${STRINGS.nl.metaDescription}">`));
    assert.ok(html.includes(`<link rel="canonical" href="${base}/?lang=nl">`));
    for (const lang of LANGS) {
      assert.ok(html.includes(`<link rel="alternate" hreflang="${lang}" href="${base}/?lang=${lang}">`), `points to the ${lang} page`);
    }
    assert.ok(html.includes(`<link rel="alternate" hreflang="x-default" href="${base}/">`));
    assert.ok(html.includes(`<meta property="og:url" content="${base}/?lang=nl">`));
    assert.ok(html.includes(`<meta property="og:locale" content="nl_NL">`));
    const data = JSON.parse(/<script type="application\/ld\+json">(.*?)<\/script>/.exec(html)?.[1] ?? "null") as Record<string, unknown>;
    assert.equal(data["@type"], "WebApplication");
    assert.equal(data.url, `${base}/?lang=nl`);
    assert.equal(data.inLanguage, "nl");
  });

  it("keeps the bare address as the one that follows the browser's language", async () => {
    const res = await fetch(`${base}/?lang=xx&ref=y`, { headers: { "Accept-Language": "fr" } });
    const html = await res.text();
    assert.match(html, /<html lang="fr">/);
    assert.ok(html.includes(`<link rel="canonical" href="${base}/">`));
    assert.match(res.headers.get("vary") ?? "", /accept-language/i);
  });

  it("lets search engines read the landing page in every language, and no other page", async () => {
    const robots = (await (await fetch(`${base}/robots.txt`)).text()).trim().split("\n");
    assert.equal(robots[0], "User-agent: *");
    assert.ok(robots.includes("Allow: /$"));
    assert.ok(robots.includes("Allow: /?lang="));
    assert.equal(robots.at(-1), "Disallow: /");
    const { client } = await register();
    const signInPage = await (await openSignIn(client.client_id, pkce().challenge)).text();
    assert.match(signInPage, /<meta name="robots" content="noindex">/);
    assert.doesNotMatch(signInPage, /rel="canonical"|hreflang="x-default"|application\/ld\+json/);
  });

  it("keeps the description for search results within the length they show", () => {
    for (const lang of LANGS) {
      const length = STRINGS[lang].metaDescription.length;
      assert.ok(length >= 120 && length <= 160, `${lang} is ${length} characters`);
    }
  });

  it("gives every snippet on the landing page its own copy button", async () => {
    const html = await (await fetch(`${base}/?lang=en`)).text();
    const targets = [...html.matchAll(/data-copy="([^"]+)"/g)].map((m) => m[1]!);
    assert.deepEqual(targets, ["mcp-url", "snip-claude-code", "snip-cursor", "snip-vscode", "snip-other"]);
    for (const id of targets) assert.ok(html.includes(`id="${id}"`), `${id} is on the page`);
    assert.match(html, /<pre id="snip-claude-code">claude mcp add --transport http picnic http:\/\/localhost:\d+\/picnic\/mcp<\/pre>/);
    assert.match(html, /role="status" id="copy-status"/, "copying is announced to screen readers");
  });

  it("answers a person's browser with a page, and an app with JSON", async () => {
    const browser = { headers: { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8", "Accept-Language": "nl" }, redirect: "manual" as const };

    // Someone pasted the server URL into the address bar.
    for (const path of ["/picnic/mcp", "/mcp"]) {
      const pasted = await fetch(base + path, browser);
      assert.equal(pasted.status, 302, path);
      assert.equal(pasted.headers.get("location"), "/");
    }

    const missing = await fetch(`${base}/nope`, browser);
    assert.equal(missing.status, 404);
    const page = await missing.text();
    assert.match(page, /Pagina niet gevonden/);
    assert.match(page, /<a href="\/">Naar de startpagina<\/a>/);

    const app = await fetch(`${base}/nope`);
    assert.equal(app.status, 404);
    assert.deepEqual(await app.json(), { error: "not_found" });
  });

  it("answers the health check", async () => {
    assert.equal((await fetch(`${base}/health`)).status, 200);
  });
});

describe("client registration", () => {
  it("registers without storing anything, and reads the registration back from the client id", async () => {
    const { res, client } = await register();
    assert.equal(res.status, 201);
    assert.match(client.client_id, /^pmc_/);
    assert.equal(client.client_secret, undefined);
    assert.equal((await openSignIn(client.client_id, pkce().challenge)).status, 200);
  });

  it("gives confidential clients a secret that the token endpoint checks", async () => {
    const { client } = await register({ token_endpoint_auth_method: "client_secret_post" });
    assert.ok(client.client_secret);
    const { verifier, challenge } = pkce();
    const code = await signIn(client.client_id, challenge);
    const fields = { grant_type: "authorization_code", client_id: client.client_id, code, code_verifier: verifier };
    assert.equal((await token({ ...fields, client_secret: "wrong" })).res.status, 400);
    assert.equal((await token({ ...fields, client_secret: client.client_secret })).res.status, 200);
  });

  it("refuses dangerous redirect URIs", async () => {
    for (const uri of ["javascript:alert(1)", "http://evil.example/cb", "data:text/html,x", "https://ok.example/cb#frag"]) {
      assert.equal(isAllowedRedirectUri(uri), false, uri);
      assert.equal((await register({ redirect_uris: [uri] })).res.status, 400, uri);
    }
    for (const uri of ["https://claude.ai/cb", "http://localhost:6274/callback", "http://127.0.0.1/cb", "cursor://anysphere.cursor-mcp/oauth/callback"]) {
      assert.equal(isAllowedRedirectUri(uri), true, uri);
    }
  });

  it("rejects an unknown client and an unregistered redirect URI without redirecting", async () => {
    assert.equal((await openSignIn("pmc_forged", pkce().challenge)).status, 400);
    const { client } = await register();
    const query = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: "https://evil.example/cb", code_challenge: "x", code_challenge_method: "S256" });
    const res = await fetch(`${base}/authorize?${query}`, { redirect: "manual" });
    assert.equal(res.status, 400);
  });

  it("tells a person what to do when their app's registration no longer counts", async () => {
    const query = new URLSearchParams({ response_type: "code", client_id: "pmc_forged", redirect_uri: REDIRECT, code_challenge: "x", code_challenge_method: "S256" });
    const res = await fetch(`${base}/authorize?${query}`, { headers: { Accept: "text/html", "Accept-Language": "en" }, redirect: "manual" });
    assert.equal(res.status, 400);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await res.text(), /Remove the Picnic connector in your AI app, add it again/);
  });
});

describe("sign-in", () => {
  it("shows who is asking and where the user returns to", async () => {
    const { client } = await register();
    const html = await (await openSignIn(client.client_id, pkce().challenge)).text();
    assert.match(html, /<html lang="nl">/);
    assert.match(html, /<strong>Claude<\/strong> wil verbinden/);
    assert.match(html, /<strong>claude\.ai<\/strong>/);
  });

  it("does not name an unknown app, and warns about where the user is sent", async () => {
    const evil = "https://claude.ai.attacker.example/api/mcp/auth_callback";
    const { client } = await register({ redirect_uris: [evil] });
    const html = await (await openSignIn(client.client_id, pkce().challenge, { redirect: evil, lang: "en" })).text();
    assert.ok(!html.includes("<strong>Claude</strong>"), "the self-chosen name is not shown");
    assert.match(html, /<strong>claude\.ai\.attacker\.example<\/strong> wants to connect/);
    assert.match(html, /role="alert">This app is not on this server&#39;s list of known apps/);
  });

  it("names apps on the user's own computer and known app schemes", async () => {
    for (const redirect of ["http://localhost:6274/callback", "cursor://anysphere.cursor-mcp/oauth/callback"]) {
      const { client } = await register({ client_name: "Some App", redirect_uris: [redirect] });
      const html = await (await openSignIn(client.client_id, pkce().challenge, { redirect, lang: "en" })).text();
      assert.match(html, /<strong>Some App<\/strong> wants to connect/, redirect);
      assert.ok(!html.includes("known apps"), redirect);
    }
  });

  it("says on the sign-in page itself that the service is not Picnic's", async () => {
    const { client } = await register();
    const page = await (await openSignIn(client.client_id, pkce().challenge, { lang: "en" })).text();
    const notice = page.indexOf('<p class="unofficial">Unofficial service.');
    assert.ok(notice > 0 && notice < page.indexOf("<form"), "above the form, not under the card");
  });

  it("lets the user cancel, which tells the app so", async () => {
    const { client } = await register();
    const page = await (await openSignIn(client.client_id, pkce().challenge)).text();
    assert.match(page, /<button type="submit" name="action" value="cancel" class="ghost" formnovalidate>Annuleren<\/button>/);
    const res = await fetch(`${base}/login`, form({ tx: hidden(page, "tx"), lang: "nl", action: "cancel" }));
    assert.equal(res.status, 303);
    const location = new URL(res.headers.get("location")!);
    assert.equal(location.origin + location.pathname, REDIRECT);
    assert.equal(location.searchParams.get("error"), "access_denied");
    assert.equal(location.searchParams.get("state"), "st4te");
    assert.equal(location.searchParams.get("code"), null);
  });

  it("does not offer Cancel for an unknown app, and does not send the user there", async () => {
    const redirect = "https://assistant.example/callback";
    const { client } = await register({ redirect_uris: [redirect] });
    const page = await (await openSignIn(client.client_id, pkce().challenge, { redirect })).text();
    assert.ok(!page.includes('value="cancel"'));
    const res = await fetch(`${base}/login`, form({ tx: hidden(page, "tx"), lang: "en", action: "cancel" }));
    assert.equal(res.status, 400);
    assert.equal(res.headers.get("location"), null);
  });

  it("switches language on every step without losing the sign-in or asking Picnic again", async () => {
    const { client } = await register();
    const { verifier, challenge } = pkce();
    const first = await (await openSignIn(client.client_id, challenge)).text();
    assert.match(first, /<nav class="langs" aria-label="Taal"><a href="\/authorize\?[^"]*lang=en"/, "the first page has an address, so links");

    // After a wrong password the page is the answer to a form: the language buttons post its state back.
    const wrong = await (await fetch(`${base}/login`, form({ tx: hidden(first, "tx"), lang: "nl", country: "DE", email: "kim@example.com", password: "nope" }))).text();
    assert.match(wrong, /<nav class="langs" aria-label="Taal"><form method="post" action="\/login">/);
    assert.match(wrong, /<button type="submit" name="setlang" value="de" lang="de" title="Deutsch">DE<\/button>/);
    const german = await fetch(`${base}/login`, form({ tx: hidden(wrong, "tx"), country: "DE", email: "kim@example.com", setlang: "de" }));
    assert.equal(german.status, 200);
    const germanPage = await german.text();
    assert.match(germanPage, /<html lang="de">/);
    assert.match(germanPage, /Mit Picnic anmelden/);
    assert.match(germanPage, /value="kim@example.com"/, "keeps the email address");
    assert.match(germanPage, /<option value="DE" selected>/, "keeps the country");
    assert.ok(!germanPage.includes('class="alert"'), "the old message was in the other language");

    const sentBefore = picnic.smsSent;
    const login = await fetch(`${base}/login`, form({ tx: hidden(germanPage, "tx"), lang: "de", country: "DE", email: "kim@example.com", password: FakePicnic.PASSWORD }));
    const codePage = await login.text();
    assert.match(codePage, /Schau auf dein Handy/);
    const french = await fetch(`${base}/login/verify`, form({ pending: hidden(codePage, "pending"), setlang: "fr" }));
    const frenchPage = await french.text();
    assert.equal(french.status, 200);
    assert.match(frenchPage, /Regardez votre téléphone/);
    assert.equal(picnic.smsSent, sentBefore + 1, "no new code is sent for a change of language");

    const done = await fetch(`${base}/login/verify`, form({ pending: hidden(frenchPage, "pending"), lang: "fr", code: FakePicnic.SMS_CODE, action: "verify" }));
    assert.equal(done.status, 303);
    const code = new URL(done.headers.get("location")!).searchParams.get("code")!;
    const { res } = await token({ grant_type: "authorization_code", client_id: client.client_id, code, code_verifier: verifier, redirect_uri: REDIRECT });
    assert.equal(res.status, 200);
  });

  it("does not count language changes and cancelling as sign-in attempts", async () => {
    const limited = await startServer({}, { signInAttemptLimit: 2 });
    try {
      const { client } = await register({}, limited.base);
      const page = await (await openSignIn(client.client_id, pkce().challenge, { at: limited.base })).text();
      for (let i = 0; i < 5; i++) {
        const res = await fetch(`${limited.base}/login`, form({ tx: hidden(page, "tx"), setlang: "en" }));
        assert.equal(res.status, 200);
      }
      assert.equal((await fetch(`${limited.base}/login`, form({ tx: hidden(page, "tx"), action: "cancel" }))).status, 303);
      // A forged form with those buttons is counted like any other.
      const statuses: number[] = [];
      for (let i = 0; i < 3; i++) statuses.push((await fetch(`${limited.base}/login`, form({ tx: "A".repeat(80), setlang: "en" }))).status);
      assert.deepEqual(statuses, [400, 400, 429]);
    } finally {
      await limited.close();
    }
  });

  it("shows which account the code is for, and lets the user go back to use another", async () => {
    const { client } = await register();
    const { verifier, challenge } = pkce();
    const page = await (await openSignIn(client.client_id, challenge)).text();
    const login = await fetch(`${base}/login`, form({ tx: hidden(page, "tx"), lang: "en", country: "NL", email: "typo@example.com", password: FakePicnic.PASSWORD }));
    const codePage = await login.text();
    assert.match(codePage, /to the phone of <strong>typo@example.com<\/strong>/);

    const sentBefore = picnic.smsSent;
    const back = await fetch(`${base}/login/verify`, form({ pending: hidden(codePage, "pending"), lang: "en", action: "back" }));
    assert.equal(back.status, 200);
    const again = await back.text();
    assert.match(again, /Sign in with Picnic/);
    assert.match(again, /name="email" value=""/, "an empty form, for the other account");
    assert.equal(picnic.smsSent, sentBefore);

    // The form that comes back is a working one.
    const login2 = await fetch(`${base}/login`, form({ tx: hidden(again, "tx"), lang: "en", country: "NL", email: "no2fa@example.com", password: FakePicnic.PASSWORD }));
    assert.equal(login2.status, 303);
    const code = new URL(login2.headers.get("location")!).searchParams.get("code")!;
    const { res } = await token({ grant_type: "authorization_code", client_id: client.client_id, code, code_verifier: verifier, redirect_uri: REDIRECT });
    assert.equal(res.status, 200);
  });

  it("ends on a page of its own for an app with its own scheme, which a redirect would leave on the form", async () => {
    const redirect = "cursor://anysphere.cursor-mcp/oauth/callback";
    const { client } = await register({ client_name: "Cursor", redirect_uris: [redirect] });
    const { verifier, challenge } = pkce();
    const page = await (await openSignIn(client.client_id, challenge, { redirect, lang: "en" })).text();
    const done = await fetch(`${base}/login`, form({ tx: hidden(page, "tx"), lang: "en", country: "NL", email: "no2fa@example.com", password: FakePicnic.PASSWORD }));
    assert.equal(done.status, 200);
    assert.equal(done.headers.get("location"), null);
    assert.equal(done.headers.get("cache-control"), "no-store");
    const html = await done.text();
    assert.match(html, /<h1>You&#39;re signed in<\/h1>/);
    assert.match(html, /Go back to <strong>Cursor<\/strong>\. You can close this tab\./);
    const href = /<a class="btn" id="go" href="([^"]+)">Open Cursor<\/a>/.exec(html)?.[1]?.replace(/&amp;/g, "&");
    assert.ok(href, "a button for when the app does not open by itself");
    const target = new URL(href);
    assert.equal(target.protocol + "//" + target.host + target.pathname, redirect);
    assert.equal(target.searchParams.get("state"), "st4te");
    const { res } = await token({ grant_type: "authorization_code", client_id: client.client_id, code: target.searchParams.get("code")!, code_verifier: verifier, redirect_uri: redirect });
    assert.equal(res.status, 200, "the code on the page is the real one");

    const cancelled = await (await fetch(`${base}/login`, form({ tx: hidden(page, "tx"), lang: "en", action: "cancel" }))).text();
    assert.match(cancelled, /<h1>Sign-in cancelled<\/h1>/);
    assert.match(cancelled, /href="cursor:\/\/anysphere\.cursor-mcp\/oauth\/callback\?error=access_denied/);
  });

  it("has a button to show the password, which only appears where it works", async () => {
    const { client } = await register();
    const page = await (await openSignIn(client.client_id, pkce().challenge, { lang: "en" })).text();
    assert.match(page, /<label for="password">Password<\/label>/);
    assert.match(page, /<input type="password" id="password" name="password"/);
    assert.match(page, /<button type="button" class="reveal" hidden aria-label="Show password"/, "hidden until the script shows it");
  });

  it("ignores a second click on the sign-in and code forms", async () => {
    const { client } = await register();
    const page = await (await openSignIn(client.client_id, pkce().challenge)).text();
    assert.match(page, /addEventListener\("submit"/);
    const login = await fetch(`${base}/login`, form({ tx: hidden(page, "tx"), lang: "en", country: "NL", email: "kim@example.com", password: FakePicnic.PASSWORD }));
    assert.match(await login.text(), /addEventListener\("submit"/);
  });

  it("escapes a hostile client name", async () => {
    const { client } = await register({ client_name: `<script>alert(1)</script>` });
    const html = await (await openSignIn(client.client_id, pkce().challenge)).text();
    assert.ok(!html.includes("<script>alert(1)"));
    assert.ok(html.includes("&lt;script&gt;alert(1)"));
  });

  it("reports a wrong password and keeps the email address, not the password", async () => {
    const { client } = await register();
    const page = await (await openSignIn(client.client_id, pkce().challenge)).text();
    const res = await fetch(`${base}/login`, form({ tx: hidden(page, "tx"), lang: "en", country: "NL", email: "kim@example.com", password: "wrong-password" }));
    const html = await res.text();
    assert.equal(res.status, 401);
    assert.match(html, /don&#39;t match/);
    assert.match(html, /Check the country too/, "a Picnic account only exists in its own country");
    assert.match(html, /<input type="password"[^>]* aria-describedby="form-error"/);
    assert.match(html, /value="kim@example.com"/);
    assert.ok(!html.includes("wrong-password"));
  });

  it("asks for the SMS code, reports a wrong one and can send a new one", async () => {
    const { client } = await register();
    const page = await (await openSignIn(client.client_id, pkce().challenge)).text();
    const sentBefore = picnic.smsSent;
    const login = await fetch(`${base}/login`, form({ tx: hidden(page, "tx"), lang: "en", country: "DE", email: "kim@example.com", password: FakePicnic.PASSWORD }));
    const pending = hidden(await login.text(), "pending");
    assert.equal(picnic.smsSent, sentBefore + 1);

    const wrong = await fetch(`${base}/login/verify`, form({ pending, lang: "en", code: "000000", action: "verify" }));
    assert.equal(wrong.status, 401);
    assert.match(await wrong.text(), /code isn&#39;t right/);

    const resend = await fetch(`${base}/login/verify`, form({ pending, lang: "en", action: "resend" }));
    assert.equal(resend.status, 200);
    assert.equal(picnic.smsSent, sentBefore + 2);

    const ok = await fetch(`${base}/login/verify`, form({ pending, lang: "en", code: "123 456", action: "verify" }));
    assert.equal(ok.status, 303);
  });

  it("signs in directly when Picnic asks for no second factor", async () => {
    const tokens = await connect("no2fa@example.com");
    assert.ok(tokens.access_token);
  });

  it("explains when Picnic refuses sign-ins", async () => {
    const { client } = await register();
    const page = await (await openSignIn(client.client_id, pkce().challenge)).text();
    picnic.throttle = true;
    const res = await fetch(`${base}/login`, form({ tx: hidden(page, "tx"), lang: "en", country: "NL", email: "a@b.nl", password: FakePicnic.PASSWORD }));
    picnic.throttle = false;
    assert.equal(res.status, 429);
    assert.match(await res.text(), /refusing sign-ins/);
  });

  it("rejects a forged or missing form token", async () => {
    const res = await fetch(`${base}/login`, form({ tx: "A".repeat(80), email: "a@b.nl", password: "x" }));
    assert.equal(res.status, 400);
    assert.match(await res.text(), /expired/);
  });

  it("limits sign-in attempts per visitor", async () => {
    const limitedPort = await freePort();
    const config = loadConfig({ PORT: String(limitedPort), SECRET_KEY: "t".repeat(48), TRUST_PROXY: "false" });
    const limited = createApp({ config, picnic: picnic.factory, signInAttemptLimit: 3, log: () => {} }).listen(limitedPort, "127.0.0.1");
    await new Promise((resolve) => limited.once("listening", resolve));
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        const res = await fetch(`${config.publicUrl.origin}/login`, form({ tx: "A".repeat(80), email: "a@b.nl", password: "x" }));
        statuses.push(res.status);
      }
      assert.deepEqual(statuses, [400, 400, 400, 429, 429]);
      const page = await (await fetch(`${config.publicUrl.origin}/login`, form({ tx: "A".repeat(80), lang: "en", email: "a@b.nl", password: "x" }))).text();
      assert.match(page, /<h1>Too many attempts<\/h1><p class="lead">Wait a few minutes, then go back to your AI app/);
    } finally {
      await new Promise((resolve) => limited.close(resolve));
    }
  });

  it("limits sign-in attempts per account, from any IP address", async () => {
    const other = await startServer({}, { signInAttemptLimit: 10_000, accountAttemptLimit: 2 });
    try {
      const { client } = await register({}, other.base);
      const page = await (await openSignIn(client.client_id, pkce().challenge, { at: other.base })).text();
      const attempt = (email: string) =>
        fetch(`${other.base}/login`, form({ tx: hidden(page, "tx"), lang: "en", country: "NL", email, password: "wrong" }));

      const statuses: number[] = [];
      for (const email of ["kim@example.com", "KIM@example.com", "kim@example.com"]) statuses.push((await attempt(email)).status);
      assert.deepEqual(statuses, [401, 401, 429], "the same account, whatever the case of the address");
      const blocked = await (await attempt("kim@example.com")).text();
      assert.match(blocked, /Too many attempts/);
      assert.ok(hidden(blocked, "tx"), "the form stays usable");
      assert.equal((await attempt("sam@example.com")).status, 401, "other accounts are not affected");

      // Forms that never reach Picnic don't count.
      const missing = await fetch(`${other.base}/login`, form({ tx: hidden(page, "tx"), lang: "en", email: "sam@example.com", password: "" }));
      assert.equal(missing.status, 400);
      assert.equal((await attempt("sam@example.com")).status, 401);
      assert.equal((await attempt("sam@example.com")).status, 429);
    } finally {
      await other.close();
    }
  });

  it("caps sign-ins for the whole server so Picnic doesn't throttle it", async () => {
    const other = await startServer({ SIGN_IN_LIMIT_PER_MINUTE: "2" }, { signInAttemptLimit: 10_000, accountAttemptLimit: 10_000 });
    try {
      const { client } = await register({}, other.base);
      const page = await (await openSignIn(client.client_id, pkce().challenge, { at: other.base })).text();
      for (let i = 0; i < 3; i++) {
        assert.equal((await fetch(`${other.base}/login`, form({ tx: "A".repeat(80), email: "a@b.nl", password: "x" }))).status, 400);
      }
      const statuses: number[] = [];
      for (const email of ["a@example.com", "b@example.com", "c@example.com"]) {
        const res = await fetch(`${other.base}/login`, form({ tx: hidden(page, "tx"), lang: "en", country: "NL", email, password: "wrong" }));
        statuses.push(res.status);
        if (res.status === 429) assert.match(await res.text(), /Too many people are signing in/);
      }
      assert.deepEqual(statuses, [401, 401, 429], "forged forms did not use up the budget");
    } finally {
      await other.close();
    }
  });

  it("gives every sign-in its own device id", async () => {
    const before = picnic.deviceIds.size;
    await connect();
    await connect();
    assert.equal(picnic.deviceIds.size, before + 2);
  });
});

describe("settings", () => {
  it("refuses unknown apps with UNKNOWN_APPS=block, including ones registered earlier", async () => {
    const evil = "https://evil.example/cb";
    const { client: earlier } = await register({ redirect_uris: [evil] });
    const strict = await startServer({ UNKNOWN_APPS: "block", EXTRA_KNOWN_APPS: "app.example.org, myapp://" });
    try {
      assert.equal((await register({ redirect_uris: [evil] }, strict.base)).res.status, 400);
      assert.equal((await openSignIn(earlier.client_id, pkce().challenge, { redirect: evil, at: strict.base })).status, 400);
      for (const uri of [REDIRECT, "http://127.0.0.1:33418/callback", "https://app.example.org/cb", "myapp://oauth/cb"]) {
        assert.equal((await register({ redirect_uris: [uri] }, strict.base)).res.status, 201, uri);
      }
    } finally {
      await strict.close();
    }
  });

  it("only trusts X-Forwarded-For when told to, or on Coolify", () => {
    const secret = { SECRET_KEY: "t".repeat(48) };
    assert.equal(loadConfig({ ...secret }).trustProxy, false);
    assert.equal(loadConfig({ ...secret, COOLIFY_FQDN: "picnic.example.com" }).trustProxy, 1);
    assert.equal(loadConfig({ ...secret, COOLIFY_FQDN: "picnic.example.com", TRUST_PROXY: "2" }).trustProxy, 2);
    assert.equal(loadConfig({ ...secret, TRUST_PROXY: "1" }).trustProxy, 1);
  });

  it("rejects malformed settings", () => {
    const secret = { SECRET_KEY: "t".repeat(48) };
    assert.throws(() => loadConfig({ ...secret, UNKNOWN_APPS: "allow" }), /UNKNOWN_APPS/);
    assert.throws(() => loadConfig({ ...secret, EXTRA_KNOWN_APPS: "https://x.example/cb" }), /EXTRA_KNOWN_APPS/);
    assert.throws(() => loadConfig({ ...secret, SIGN_IN_LIMIT_PER_MINUTE: "0" }), /SIGN_IN_LIMIT_PER_MINUTE/);
    assert.throws(() => loadConfig({ ...secret, PICNIC_LIMIT_PER_MINUTE: "0" }), /PICNIC_LIMIT_PER_MINUTE/);
    assert.throws(() => loadConfig({ ...secret, PICNIC_PAUSE_SECONDS: "-1" }), /PICNIC_PAUSE_SECONDS/);
    assert.equal(loadConfig({ ...secret, PICNIC_PAUSE_SECONDS: "0" }).picnicPauseSeconds, 0);
  });
});

describe("tokens", () => {
  it("accepts a code once, and only with the right verifier", async () => {
    const { client } = await register();
    const { verifier, challenge } = pkce();
    const code = await signIn(client.client_id, challenge);
    const fields = { grant_type: "authorization_code", client_id: client.client_id, code, redirect_uri: REDIRECT };

    assert.equal((await token({ ...fields, code_verifier: pkce().verifier })).res.status, 400);
    assert.equal((await token({ ...fields, code_verifier: verifier, redirect_uri: "https://claude.ai/other" })).res.status, 400);
    assert.equal((await token({ ...fields, code_verifier: verifier })).res.status, 400, "the code was used up by the redirect_uri mismatch");

    const second = await signIn(client.client_id, challenge);
    assert.equal((await token({ ...fields, code: second, code_verifier: verifier })).res.status, 200);
    assert.equal((await token({ ...fields, code: second, code_verifier: verifier })).res.status, 400);
  });

  it("does not let another client use a code or a refresh token", async () => {
    const mine = await connect();
    const { client: other } = await register();
    const stolen = await token({ grant_type: "refresh_token", client_id: other.client_id, refresh_token: mine.refresh_token });
    assert.equal(stolen.res.status, 400);
  });

  it("refreshes, and rejects tampered or mixed-up tokens", async () => {
    const tokens = await connect();
    const refreshed = await token({ grant_type: "refresh_token", client_id: tokens.clientId, refresh_token: tokens.refresh_token });
    assert.equal(refreshed.res.status, 200);
    await (await mcp(refreshed.body.access_token)).close();

    const call = (bearer: string) =>
      fetch(`${base}/picnic/mcp`, { method: "POST", headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" }, body: "{}" });
    const tampered = tokens.access_token.slice(0, -4) + (tokens.access_token.endsWith("AAAA") ? "BBBB" : "AAAA");
    assert.equal((await call(tampered)).status, 401);
    assert.equal((await call(tokens.refresh_token)).status, 401, "a refresh token is not an access token");
    assert.equal((await call("pma_" + tokens.refresh_token.slice(4))).status, 401);
  });

  it("ends a sign-in after a fixed time, however often the tokens are refreshed", async () => {
    const sealer = new Sealer("t".repeat(48));
    const now = Math.floor(Date.now() / 1000);
    const day = 24 * 60 * 60;
    const expiryOf = (refreshToken: string) => sealer.open("refresh", refreshToken.slice(4))!.exp!;
    const refresh = (clientId: string, refreshToken: string) => token({ grant_type: "refresh_token", client_id: clientId, refresh_token: refreshToken });

    const tokens = await connect();
    const ends = expiryOf(tokens.refresh_token);
    assert.ok(Math.abs(ends - (now + SIGN_IN_TTL)) < 60, "a sign-in lasts SIGN_IN_TTL");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const refreshed = await refresh(tokens.clientId, tokens.refresh_token);
    assert.equal(refreshed.res.status, 200);
    assert.equal(expiryOf(refreshed.body.refresh_token), ends, "refreshing does not move the end of the sign-in");

    // Tokens as this server would have issued them at other moments.
    const record = { k: "key-1", cc: "NL", d: "DEVICE", c: tokens.clientId };
    const issued = (fields: Record<string, unknown>, ttl: number) => "pmr_" + sealer.seal("refresh", { ...record, ...fields }, ttl);

    const nearEnd = await refresh(tokens.clientId, issued({ t: now - SIGN_IN_TTL + 600 }, 600));
    assert.equal(nearEnd.res.status, 200);
    assert.ok(nearEnd.body.expires_in <= 600, "an access token does not outlive the sign-in");

    assert.equal((await refresh(tokens.clientId, issued({ t: now - SIGN_IN_TTL - 60 }, 3600))).res.status, 400, "the sign-in has ended");

    // Refresh tokens from before sign-ins had an end: valid for a year, without a sign-in time.
    const old = await refresh(tokens.clientId, issued({}, 365 * day));
    assert.equal(old.res.status, 200);
    assert.ok(expiryOf(old.body.refresh_token) <= now + SIGN_IN_TTL + 60, "an old token moves onto the fixed end");
    assert.equal((await refresh(tokens.clientId, issued({}, 365 * day - SIGN_IN_TTL - 60))).res.status, 400, "an old token issued too long ago");
  });

  it("is useless with another server's secret", () => {
    const sealed = new Sealer("a".repeat(48)).seal("access", { k: "key" }, 60);
    assert.equal(new Sealer("b".repeat(48)).open("access", sealed), null);
    assert.equal(new Sealer("a".repeat(48)).open("refresh", sealed), null);
    assert.deepEqual(new Sealer("a".repeat(48)).open("access", sealed)?.k, "key");
  });

  it("expires", async () => {
    const sealer = new Sealer("a".repeat(48));
    const sealed = sealer.seal("access", { k: "key" }, 1);
    assert.ok(sealer.open("access", sealed));
    await new Promise((resolve) => setTimeout(resolve, 2100));
    assert.equal(sealer.open("access", sealed), null);
  });
});

describe("mcp", () => {
  it("lists the tools with titles and safety hints", async () => {
    const client = await mcp((await connect()).access_token);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const name of ["search_products", "add_to_cart", "get_cart", "get_delivery_slots", "select_delivery_slot", "disconnect_account"]) {
      assert.ok(names.includes(name), name);
    }
    assert.ok(!names.some((n) => /checkout|pay|order_now/.test(n)), "no tool can place an order");
    for (const tool of tools) {
      assert.ok(tool.title && tool.description, `${tool.name} has a title and description`);
      assert.equal(typeof tool.annotations?.readOnlyHint, "boolean", `${tool.name} says whether it changes anything`);
    }
    assert.equal(tools.find((t) => t.name === "get_cart")?.annotations?.readOnlyHint, true);
    assert.equal(tools.find((t) => t.name === "clear_cart")?.annotations?.destructiveHint, true);
    assert.match(client.getInstructions() ?? "", /cannot place or pay/);
    const info = client.getServerVersion();
    assert.equal(info?.websiteUrl, `${base}/`);
    assert.deepEqual(info?.icons?.[0], { src: `${base}/icon-192.png`, mimeType: "image/png", sizes: ["192x192"] });
    await client.close();
  });

  it("searches, fills the cart and keeps users apart", async () => {
    const kim = await mcp((await connect()).access_token);
    const sam = await mcp((await connect()).access_token);

    const search = JSON.parse(textOf(await kim.callTool({ name: "search_products", arguments: { query: "melk" } })));
    assert.deepEqual(search.products, [{ product_id: "s100", name: "Halfvolle melk", brand: "Picnic", size: "1 liter", price: "€1.29", bought_before: true }]);

    const added = JSON.parse(
      textOf(
        await kim.callTool({
          name: "add_to_cart",
          arguments: { items: [{ product_id: "s100", quantity: 2 }, { product_id: "s200" }, { product_id: "s999" }] },
        }),
      ),
    );
    assert.equal(added.cart.item_count, 3);
    assert.equal(added.cart.total, "€3.57");
    assert.equal(added.cart.below_minimum_order_value, true);
    assert.equal(added.failed.length, 1);
    assert.equal(added.failed[0].product_id, "s999");

    const removed = JSON.parse(textOf(await kim.callTool({ name: "remove_from_cart", arguments: { items: [{ product_id: "s100", quantity: 2 }] } })));
    assert.deepEqual(removed.cart.items.map((i: { product_id: string }) => i.product_id), ["s200"]);

    const samCart = JSON.parse(textOf(await sam.callTool({ name: "get_cart", arguments: {} })));
    assert.equal(samCart.item_count, 0);

    await kim.close();
    await sam.close();
  });

  it("lists delivery slots per day, a few days at a time, in local time", async () => {
    const client = await mcp((await connect()).access_token);
    const call = async (args: Record<string, unknown>) => JSON.parse(textOf(await client.callTool({ name: "get_delivery_slots", arguments: args })));

    const first = await call({});
    assert.deepEqual(first.selected_slot, { slot_id: "slot-20-1", window: "Friday 2026-11-20 18:15–19:15", chosen_by_user: false });
    assert.equal(first.minimum_order_value, "€40.00", "said once, not on every slot");
    assert.deepEqual(first.days.map((d: { date: string }) => d.date), ["2026-11-16", "2026-11-17", "2026-11-18"]);
    assert.deepEqual(first.later_dates, ["2026-11-19", "2026-11-20"]);
    assert.deepEqual(first.days[0], {
      date: "2026-11-16",
      weekday: "Monday",
      slots: [
        { slot_id: "slot-16-1", window: "18:15–19:15", order_before: "Sunday 2026-11-15 23:00" },
        { slot_id: "slot-16-2", window: "18:15–20:15", order_before: "Sunday 2026-11-15 23:00", green_choice: true },
      ],
    });
    assert.equal(first.days[1].slots.length, 1, "a full slot is left out");

    const oneDay = await call({ date: "2026-11-17", include_unavailable: true });
    assert.deepEqual(oneDay.days.map((d: { date: string }) => d.date), ["2026-11-17"]);
    assert.equal(oneDay.days[0].slots[1].unavailable, true);
    assert.equal(oneDay.other_dates.length, 4);

    assert.equal((await call({ days: 14 })).days.length, 5);
    assert.match((await call({ date: "2027-01-01" })).hint, /No slots on that day/);
    assert.equal((await client.callTool({ name: "get_delivery_slots", arguments: { date: "tomorrow" } })).isError, true);
    await client.close();
  });

  it("gives the arrival time of a delivery on the user's clock, not in UTC", async () => {
    const client = await mcp((await connect()).access_token);
    const out = JSON.parse(textOf(await client.callTool({ name: "track_delivery", arguments: { delivery_id: "d1" } })));
    assert.deepEqual(out, { delivery_id: "d1", driver_on_the_way: true, expected_arrival: "Monday 2026-11-16 17:42" });
    await client.close();
  });

  it("rejects invalid arguments", async () => {
    const client = await mcp((await connect()).access_token);
    const result = await client.callTool({ name: "add_to_cart", arguments: { items: [{ product_id: "s100", quantity: 0 }] } });
    assert.equal(result.isError, true);
    await client.close();
  });

  it("disconnects: the tool and token revocation both sign out at Picnic", async () => {
    const first = await connect();
    const client = await mcp(first.access_token);
    const out = JSON.parse(textOf(await client.callTool({ name: "disconnect_account", arguments: {} })));
    assert.equal(out.disconnected, true);
    const after = await client.callTool({ name: "get_cart", arguments: {} });
    assert.equal(after.isError, true);
    assert.match(textOf(after), /connect it again/);
    await client.close();

    const second = await connect();
    const signedOutBefore = picnic.signedOut.size;
    const revoke = await fetch(`${base}/revoke`, form({ client_id: second.clientId, token: second.refresh_token }));
    assert.equal(revoke.status, 200);
    assert.equal(picnic.signedOut.size, signedOutBefore + 1);
  });

  it("reports a revocation that failed, and accepts one for a session that is already signed out", async () => {
    const tokens = await connect();
    const revoke = () => fetch(`${base}/revoke`, form({ client_id: tokens.clientId, token: tokens.refresh_token }));
    const refresh = () => token({ grant_type: "refresh_token", client_id: tokens.clientId, refresh_token: tokens.refresh_token });

    picnic.down = true;
    const failed = await revoke();
    picnic.down = false;
    assert.equal(failed.status, 500, "the app must not be told the token is gone");
    assert.equal(((await failed.json()) as { error: string }).error, "server_error");
    const client = await mcp((await refresh()).body.access_token);
    assert.equal((await client.callTool({ name: "get_cart", arguments: {} })).isError, undefined, "the session still works");
    await client.close();

    assert.equal((await revoke()).status, 200);
    assert.equal((await revoke()).status, 200, "Picnic refuses the key, which is what revoking is for");
  });

  it("only speaks POST", async () => {
    const { access_token } = await connect();
    const res = await fetch(`${base}/picnic/mcp`, { headers: { Authorization: `Bearer ${access_token}`, Accept: "text/event-stream" } });
    assert.equal(res.status, 405);
  });
});

describe("protecting the server's IP address at Picnic", () => {
  const items = (...ids: string[]) => ({ items: ids.map((product_id) => ({ product_id })) });

  it("caps the requests to Picnic for the whole server, and stops a cart change at the cap", async () => {
    const other = await startServer({ PICNIC_LIMIT_PER_MINUTE: "4" });
    try {
      const sentBefore = picnic.requests;
      const client = await mcp((await connect("no2fa@example.com", other.base)).access_token, other.base);
      assert.equal(picnic.requests, sentBefore + 1, "signing in counts too");

      const added = JSON.parse(textOf(await client.callTool({ name: "add_to_cart", arguments: items("s100", "s200", "s100", "s200", "s100") })));
      assert.equal(added.cart.item_count, 3, "what was added before the cap is reported");
      assert.deepEqual(added.failed.map((f: { product_id: string }) => f.product_id), ["s200", "s100"]);
      assert.match(added.failed[0].reason, /allows itself per minute/);
      assert.match(added.failed[1].reason, /Not tried/);

      const cart = await client.callTool({ name: "get_cart", arguments: {} });
      assert.equal(cart.isError, true);
      assert.match(textOf(cart), /allows itself per minute/);

      const { client: app } = await register({}, other.base);
      const page = await (await openSignIn(app.client_id, pkce().challenge, { at: other.base })).text();
      const login = await fetch(`${other.base}/login`, form({ tx: hidden(page, "tx"), lang: "en", country: "NL", email: "a@b.nl", password: "x" }));
      assert.equal(login.status, 429);
      assert.match(await login.text(), /Wait a minute and try again/);

      assert.equal(picnic.requests, sentBefore + 4, "nothing went to Picnic beyond the cap");
      await client.close();
    } finally {
      await other.close();
    }
  });

  it("stops every user's requests for a while once Picnic throttles one", async () => {
    const other = await startServer({ PICNIC_PAUSE_SECONDS: "1" });
    try {
      const kim = await mcp((await connect("no2fa@example.com", other.base)).access_token, other.base);
      const sam = await mcp((await connect("no2fa-sam@example.com", other.base)).access_token, other.base);
      const sentBefore = picnic.requests;

      picnic.throttle = true;
      const refused = await kim.callTool({ name: "add_to_cart", arguments: items("s100", "s200", "s100") });
      picnic.throttle = false;
      assert.equal(refused.isError, true);
      assert.match(textOf(refused), /temporarily refusing requests/);
      assert.equal(picnic.requests, sentBefore + 1, "the other products were not tried");

      const paused = await sam.callTool({ name: "get_cart", arguments: {} });
      assert.equal(paused.isError, true, "the pause is for the whole server");
      assert.equal(picnic.requests, sentBefore + 1);

      await new Promise((resolve) => setTimeout(resolve, 1100));
      assert.equal(JSON.parse(textOf(await sam.callTool({ name: "get_cart", arguments: {} }))).item_count, 0);
      await kim.close();
      await sam.close();
    } finally {
      picnic.throttle = false;
      await other.close();
    }
  });

  it("guards the requests of the real Picnic client, except files from Picnic's CDN", async () => {
    const realFetch = globalThis.fetch;
    const sent: string[] = [];
    let status = 403;
    globalThis.fetch = (async (url: string) => {
      sent.push(url);
      return status === 200 ? Response.json({ items: [] }) : new Response("<html>blocked</html>", { status });
    }) as typeof fetch;
    try {
      let time = 0;
      const guard = new PicnicGuard({ limitPerMinute: 2, pauseMs: 30_000, now: () => time });
      const client = createPicnicClient(guard)({ country: "NL", deviceId: "DEVICE", authKey: "key" });
      const held = (reason: string) => (error: unknown) => error instanceof PicnicHeldError && error.reason === reason;

      await assert.rejects(client.cart.getCart(), (error: unknown) => (error as { status?: number }).status === 403);
      await assert.rejects(client.cart.getCart(), held("pause"));
      assert.equal(sent.length, 1, "nothing is sent during the pause");

      status = 200;
      await client.sendRequest("GET", "https://cdn.example.com/chunk.js", null, { binary: true });
      assert.equal(sent.length, 2, "the CDN is another host");

      time = 30_000;
      await client.cart.getCart();
      await assert.rejects(client.cart.getCart(), held("limit"));
      assert.equal(sent.length, 3, "two requests per minute, the refused one included");

      time = 60_000;
      await client.cart.getCart();
      assert.equal(sent.length, 4);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
