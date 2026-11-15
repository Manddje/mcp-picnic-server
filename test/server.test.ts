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
import { isAllowedRedirectUri, SIGN_IN_TTL } from "../src/oauth.js";
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
  const config = loadConfig({ PORT: String(port), SECRET_KEY: "t".repeat(48), TRUST_PROXY: "false", SIGN_IN_LIMIT_PER_MINUTE: "10000" });
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
async function signIn(clientId: string, challenge: string, email = "kim@example.com"): Promise<string> {
  const page = await (await openSignIn(clientId, challenge)).text();
  const login = await fetch(`${base}/login`, form({ tx: hidden(page, "tx"), lang: "nl", country: "NL", email, password: FakePicnic.PASSWORD }));
  let done = login;
  if (login.status === 200) {
    const verifyPage = await login.text();
    done = await fetch(`${base}/login/verify`, form({ pending: hidden(verifyPage, "pending"), lang: "nl", code: FakePicnic.SMS_CODE, action: "verify" }));
  }
  assert.equal(done.status, 303);
  const location = new URL(done.headers.get("location")!);
  assert.equal(location.origin + location.pathname, REDIRECT);
  assert.equal(location.searchParams.get("state"), "st4te");
  return location.searchParams.get("code")!;
}

async function token(fields: Record<string, string>) {
  const res = await fetch(`${base}/token`, form(fields));
  return { res, body: (await res.json()) as { access_token: string; refresh_token: string; expires_in: number; error?: string } };
}

async function connect(email?: string) {
  const { client } = await register();
  const { verifier, challenge } = pkce();
  const code = await signIn(client.client_id, challenge, email);
  const { body } = await token({ grant_type: "authorization_code", client_id: client.client_id, code, code_verifier: verifier, redirect_uri: REDIRECT });
  assert.ok(body.access_token, "token endpoint returns an access token");
  return { clientId: client.client_id, ...body };
}

async function mcp(accessToken: string): Promise<Client> {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }),
  );
  return client;
}

const textOf = (result: unknown) => (result as { content: { text: string }[] }).content[0]!.text;

describe("discovery", () => {
  it("tells clients where to sign in", async () => {
    const challenge = await fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(challenge.status, 401);
    const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge.headers.get("www-authenticate") ?? "")?.[1];
    assert.equal(metadataUrl, `${base}/.well-known/oauth-protected-resource/mcp`);

    const resource = (await (await fetch(metadataUrl)).json()) as { resource: string; authorization_servers: string[] };
    assert.equal(resource.resource, `${base}/mcp`);

    const as = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    assert.equal(as.registration_endpoint, `${base}/register`);
    assert.equal(as.authorization_endpoint, `${base}/authorize`);
    assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
  });

  it("serves the landing page in the visitor's language", async () => {
    const res = await fetch(`${base}/`, { headers: { "Accept-Language": "de" } });
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /<html lang="de">/);
    assert.ok(html.includes(`${base}/mcp`));
    assert.match(res.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
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
      fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" }, body: "{}" });
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

  it("only speaks POST", async () => {
    const { access_token } = await connect();
    const res = await fetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${access_token}`, Accept: "text/event-stream" } });
    assert.equal(res.status, 405);
  });
});
