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
import { isAllowedRedirectUri, RedirectPolicy, SIGN_IN_TTL } from "../src/oauth.js";
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
    PICNIC_USER_LIMIT_PER_MINUTE: "100000",
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

  it("knows a well-known app by its exact callback address, not by its host", async () => {
    const policy = new RedirectPolicy();
    for (const uri of [
      "https://claude.ai/api/mcp/auth_callback",
      "https://claude.com/api/mcp/auth_callback",
      "https://chatgpt.com/connector_platform_oauth_redirect",
      "https://chatgpt.com/connector/oauth/cb_1a2B3c",
      "https://vscode.dev/redirect",
      "https://insiders.vscode.dev/redirect",
    ]) {
      assert.equal(policy.trust(uri), "known", uri);
    }
    for (const uri of [
      "https://claude.ai/",
      "https://claude.ai/any/other/page",
      "https://claude.ai/api/mcp/auth_callback/",
      "https://claude.ai/api/mcp/auth_callback/more",
      "https://claude.ai/api/mcp/auth_callback?next=https://evil.example",
      "https://claude.ai:8443/api/mcp/auth_callback",
      "https://chatgpt.com/connector/oauth/",
      "https://chatgpt.com/connector/oauth/a/b",
      "https://chatgpt.com/connector/oauth/a%2Fb",
      "https://vscode.dev/redirect/other",
    ]) {
      assert.equal(policy.trust(uri), "unknown", uri);
    }

    // On the page: another address on a known host gets the warning, and not its self-chosen name.
    const other = "https://claude.ai/any/other/page";
    const { client } = await register({ client_name: "Picnic Security Team", redirect_uris: [other] });
    const html = await (await openSignIn(client.client_id, pkce().challenge, { redirect: other, lang: "en" })).text();
    assert.ok(!html.includes("Picnic Security Team"), "the self-chosen name is not shown");
    assert.match(html, /role="alert">This app is not on this server&#39;s list of known apps/);
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
    const strict = await startServer({
      UNKNOWN_APPS: "block",
      EXTRA_KNOWN_APPS: "app.example.org, myapp://, https://Exact.example.org/oauth/Callback, https://many.example.org/cb/*",
    });
    try {
      for (const uri of [evil, "https://claude.ai/any/other/page", "https://exact.example.org/oauth/callback", "https://exact.example.org/", "https://many.example.org/cb/a/b"]) {
        assert.equal((await register({ redirect_uris: [uri] }, strict.base)).res.status, 400, uri);
      }
      assert.equal((await openSignIn(earlier.client_id, pkce().challenge, { redirect: evil, at: strict.base })).status, 400);
      for (const uri of [
        REDIRECT,
        "http://127.0.0.1:33418/callback",
        "https://app.example.org/cb",
        "myapp://oauth/cb",
        "https://exact.example.org/oauth/Callback",
        "https://many.example.org/cb/one",
      ]) {
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
    for (const entry of ["http://x.example/cb", "https://x.example/cb?x=1", "https://x.example/*/cb", "https://x.example/cb*", "x.example/cb"]) {
      assert.throws(() => loadConfig({ ...secret, EXTRA_KNOWN_APPS: entry }), /EXTRA_KNOWN_APPS/, entry);
    }
    assert.throws(() => loadConfig({ ...secret, SIGN_IN_LIMIT_PER_MINUTE: "0" }), /SIGN_IN_LIMIT_PER_MINUTE/);
    assert.throws(() => loadConfig({ ...secret, PICNIC_LIMIT_PER_MINUTE: "0" }), /PICNIC_LIMIT_PER_MINUTE/);
    assert.throws(() => loadConfig({ ...secret, PICNIC_USER_LIMIT_PER_MINUTE: "0" }), /PICNIC_USER_LIMIT_PER_MINUTE/);
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

  it("refuses batches, which would count as one request while doing the work of many", async () => {
    const { access_token } = await connect("batch@example.com");
    const call = (id: number) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "add_to_cart", arguments: { items: [{ product_id: "s100" }] } } });
    const sentBefore = picnic.requests;
    for (const path of ["/picnic/mcp", "/mcp"]) {
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify([call(1), call(2)]),
      });
      assert.equal(res.status, 400, path);
      assert.equal(((await res.json()) as { error: { code: number } }).error.code, -32600, path);
    }
    assert.equal(picnic.requests, sentBefore, "nothing went to Picnic");
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

  it("gives one user a share of the server's requests, so the others keep theirs", async () => {
    const other = await startServer({ PICNIC_USER_LIMIT_PER_MINUTE: "3" });
    try {
      const greedy = await mcp((await connect("no2fa-greedy@example.com", other.base)).access_token, other.base);
      const modest = await mcp((await connect("no2fa-modest@example.com", other.base)).access_token, other.base);
      const sentBefore = picnic.requests;

      const added = JSON.parse(textOf(await greedy.callTool({ name: "add_to_cart", arguments: items("s100", "s200", "s100", "s200", "s100") })));
      assert.equal(added.cart.item_count, 3, "what was added within the share is reported");
      assert.deepEqual(added.failed.map((f: { product_id: string }) => f.product_id), ["s200", "s100"]);
      assert.match(added.failed[0].reason, /one user may per minute/);
      assert.match(added.failed[1].reason, /Not tried/);
      const again = await greedy.callTool({ name: "get_cart", arguments: {} });
      assert.equal(again.isError, true, "the user stays over their share for the rest of the minute");
      assert.equal(picnic.requests, sentBefore + 3, "nothing went to Picnic beyond the share");

      assert.equal(JSON.parse(textOf(await modest.callTool({ name: "get_cart", arguments: {} }))).item_count, 0, "another user is not held back");
      await greedy.close();
      await modest.close();
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
      const guard = new PicnicGuard({ limitPerMinute: 2, userLimitPerMinute: 100, pauseMs: 30_000, now: () => time });
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

  it("counts the requests of the real Picnic client per user", async () => {
    const realFetch = globalThis.fetch;
    let sent = 0;
    globalThis.fetch = (async () => {
      sent++;
      return Response.json({ items: [] });
    }) as unknown as typeof fetch;
    try {
      let time = 0;
      const picnicFor = createPicnicClient(new PicnicGuard({ limitPerMinute: 100, userLimitPerMinute: 2, pauseMs: 0, now: () => time }));
      const client = (authKey?: string) => picnicFor({ country: "NL", deviceId: "DEVICE", authKey });
      const held = (error: unknown) => error instanceof PicnicHeldError && error.reason === "user";

      await client("kim").cart.getCart();
      // A page is fetched another way than the cart, and every tool call makes a new client.
      await client("kim").catalog.getFavorites().catch((error: unknown) => assert.ok(!held(error)));
      await assert.rejects(client("kim").cart.getCart(), held);
      await assert.rejects(client("kim").catalog.getFavorites(), held);
      assert.equal(sent, 2, "nothing is sent beyond the share");

      await client("sam").cart.getCart();
      for (let i = 0; i < 3; i++) await client().cart.getCart();
      assert.equal(sent, 6, "another user and requests without a user, like a sign-in, are not held back");

      time = 60_000;
      await client("kim").cart.getCart();
      assert.equal(sent, 7);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
