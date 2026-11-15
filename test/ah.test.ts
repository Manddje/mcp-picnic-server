import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { extractCode } from "../src/ah/login.js";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { SIGN_IN_TTL } from "../src/oauth.js";
import { FakeAh } from "./fake-ah.js";
import { FakePicnic } from "./fake-picnic.js";

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

let server: Server;
let base: string;
let ah: FakeAh;
let picnic: FakePicnic;

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function startServer(env: Record<string, string>, fake: FakeAh, options: { signInAttemptLimit?: number } = {}) {
  const port = await freePort();
  const config = loadConfig({ PORT: String(port), SECRET_KEY: "t".repeat(48), TRUST_PROXY: "false", SIGN_IN_LIMIT_PER_MINUTE: "10000", ...env });
  const app = createApp({ config, picnic: picnic.factory, ahFetch: fake.fetch, signInAttemptLimit: 10_000, accountAttemptLimit: 10_000, log: () => {}, ...options });
  const listening = app.listen(port, "127.0.0.1");
  await new Promise((resolve) => listening.once("listening", resolve));
  return { server: listening, base: config.publicUrl.origin, close: () => new Promise((resolve) => listening.close(resolve)) };
}

before(async () => {
  picnic = new FakePicnic();
  ah = new FakeAh();
  ({ server, base } = await startServer({ AH_ENABLED: "true" }, ah));
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  // The server only ever made calls the stand-in knows, and none that would change an order.
  assert.deepEqual(ah.unexpected, []);
});

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

async function register(at = base) {
  const res = await fetch(`${at}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
  });
  return (await res.json()) as { client_id: string };
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/** Opens the sign-in page the way an app does: for a resource, for a scope, or for neither. */
async function openSignIn(clientId: string, challenge: string, how: { resource?: string; scope?: string } = { resource: `${base}/ah/mcp` }, at = base) {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st4te",
    ...how,
  });
  return fetch(`${at}/authorize?${query}`, { headers: { "Accept-Language": "nl-NL,nl;q=0.9" } });
}

/** Walks the Albert Heijn sign-in as a browser would and returns the authorization code. */
async function signIn(clientId: string, challenge: string, member: string | null): Promise<string> {
  const page = await (await openSignIn(clientId, challenge)).text();
  const fields: Record<string, string> = member === null ? { action: "guest" } : { action: "code", pasted: ah.loginExit(member) };
  const done = await fetch(`${base}/ah/login`, form({ tx: hidden(page, "tx"), lang: "nl", ...fields }));
  assert.equal(done.status, 303);
  const location = new URL(done.headers.get("location")!);
  assert.equal(location.origin + location.pathname, REDIRECT);
  assert.equal(location.searchParams.get("state"), "st4te");
  return location.searchParams.get("code")!;
}

type Tokens = { access_token: string; refresh_token: string; expires_in: number; scope?: string; error?: string };

async function token(fields: Record<string, string>) {
  const res = await fetch(`${base}/token`, form(fields));
  return { res, body: (await res.json()) as Tokens };
}

/** Connects as a member, or as a visitor without an account when `member` is null. */
async function connect(member: string | null = "kim") {
  const { client_id: clientId } = await register();
  const { verifier, challenge } = pkce();
  const code = await signIn(clientId, challenge, member);
  const { body } = await token({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: REDIRECT });
  assert.ok(body.access_token, "token endpoint returns an access token");
  return { clientId, ...body };
}

async function connectPicnic() {
  const { client_id: clientId } = await register();
  const { verifier, challenge } = pkce();
  const page = await (await openSignIn(clientId, challenge, {})).text();
  const done = await fetch(`${base}/login`, form({ tx: hidden(page, "tx"), lang: "nl", country: "NL", email: "no2fa@example.com", password: FakePicnic.PASSWORD }));
  const code = new URL(done.headers.get("location")!).searchParams.get("code")!;
  const { body } = await token({ grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: REDIRECT });
  return { clientId, ...body };
}

async function mcp(accessToken: string, path = "/ah/mcp"): Promise<Client> {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}${path}`), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }));
  return client;
}

const post = (path: string, accessToken: string) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });

type Result = { content: { text: string }[]; isError?: boolean };
const textOf = (result: unknown) => (result as Result).content[0]!.text;
const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as Result;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const data = async (client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> => {
  const result = await call(client, name, args);
  assert.ok(!result.isError, `${name} succeeds: ${textOf(result)}`);
  return JSON.parse(textOf(result));
};

describe("settings", () => {
  it("leaves Albert Heijn off unless asked for", async () => {
    const other = await startServer({}, new FakeAh());
    try {
      for (const path of ["/ah/mcp", "/.well-known/oauth-protected-resource/ah/mcp"]) {
        assert.equal((await fetch(`${other.base}${path}`)).status, 404, path);
      }
      assert.equal((await fetch(`${other.base}/ah/login`, form({ action: "guest" }))).status, 404);
      const metadata = (await (await fetch(`${other.base}/.well-known/oauth-authorization-server`)).json()) as { scopes_supported: string[] };
      assert.deepEqual(metadata.scopes_supported, ["picnic"]);
      assert.ok(!(await (await fetch(`${other.base}/`)).text()).includes("/ah/mcp"));

      // An app that asks for Albert Heijn anyway gets the Picnic sign-in, as before.
      const { client_id: clientId } = await register(other.base);
      const page = await (await openSignIn(clientId, pkce().challenge, { resource: `${other.base}/ah/mcp`, scope: "ah" }, other.base)).text();
      assert.match(page, /name="password"/);
    } finally {
      await other.close();
    }
  });

  it("rejects a malformed setting", () => {
    assert.throws(() => loadConfig({ SECRET_KEY: "t".repeat(48), AH_ENABLED: "yes" }), /AH_ENABLED/);
    assert.equal(loadConfig({ SECRET_KEY: "t".repeat(48) }).ahEnabled, false);
  });
});

describe("discovery", () => {
  it("tells apps to sign in for Albert Heijn at the Albert Heijn address", async () => {
    const challenge = await fetch(`${base}/ah/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(challenge.status, 401);
    const header = challenge.headers.get("www-authenticate") ?? "";
    assert.ok(header.includes(`resource_metadata="${base}/.well-known/oauth-protected-resource/ah/mcp"`), header);
    assert.match(header, /scope="ah"/);

    const metadata = (await (await fetch(`${base}/.well-known/oauth-protected-resource/ah/mcp`)).json()) as { resource: string; scopes_supported: string[] };
    assert.equal(metadata.resource, `${base}/ah/mcp`);
    assert.deepEqual(metadata.scopes_supported, ["ah"]);
  });

  it("keeps describing the Picnic address as Picnic's", async () => {
    for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
      const metadata = (await (await fetch(`${base}${path}`)).json()) as { resource: string; scopes_supported: string[] };
      assert.equal(metadata.resource, `${base}/mcp`, path);
      assert.deepEqual(metadata.scopes_supported, ["picnic"], path);
    }
    const challenge = await fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.ok(challenge.headers.get("www-authenticate")?.includes(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`));
  });

  it("shows the second address on the landing page", async () => {
    const html = await (await fetch(`${base}/?lang=nl`)).text();
    assert.ok(html.includes(`${base}/ah/mcp`));
    assert.match(html, /Ook Albert Heijn/);
  });
});

describe("sign-in", () => {
  it("shows the Albert Heijn page for the Albert Heijn address or scope, and Picnic's otherwise", async () => {
    const { client_id: clientId } = await register();
    const { challenge } = pkce();
    for (const how of [{ resource: `${base}/ah/mcp` }, { scope: "ah" }, { resource: `${base}/ah/mcp`, scope: "picnic" }]) {
      const page = await (await openSignIn(clientId, challenge, how)).text();
      assert.match(page, /Albert Heijn koppelen/, JSON.stringify(how));
      assert.ok(page.includes("https://login.ah.nl/login?client_id=appie-ios"), "links to Albert Heijn's own sign-in page");
      assert.ok(!page.includes('name="password"'), "asks for no password");
      assert.match(page, /<strong>Claude<\/strong>/);
    }
    for (const how of [{}, { scope: "picnic" }, { resource: `${base}/mcp` }, { resource: `${base}/mcp`, scope: "ah" }, { scope: "picnic ah" }]) {
      const page = await (await openSignIn(clientId, challenge, how)).text();
      assert.match(page, /name="password"/, JSON.stringify(how));
    }
  });

  it("reads the code from whatever is pasted, and only the code", () => {
    assert.equal(extractCode("appie://login-exit?code=abc12345-6789"), "abc12345-6789");
    assert.equal(extractCode("  appie%3A%2F%2Flogin-exit%3Fcode%3Dabc12345-6789%26x%3D1 "), "abc12345-6789");
    assert.equal(extractCode("https://evil.example/?next=1&code=abc12345-6789#frag"), "abc12345-6789");
    assert.equal(extractCode("abc12345-6789"), "abc12345-6789");
    assert.equal(extractCode("appie://login-exit?error=access_denied"), null);
    assert.equal(extractCode("<script>alert(1)</script>"), null);
    assert.equal(extractCode(""), null);
  });

  it("asks again for a missing or refused code, without repeating what was pasted", async () => {
    const { client_id: clientId } = await register();
    const page = await (await openSignIn(clientId, pkce().challenge)).text();
    const tx = hidden(page, "tx");

    const missing = await fetch(`${base}/ah/login`, form({ tx, lang: "nl", action: "code", pasted: "geen idee" }));
    assert.equal(missing.status, 400);
    assert.match(await missing.text(), /Plak het adres/);

    const refused = await fetch(`${base}/ah/login`, form({ tx, lang: "nl", action: "code", pasted: "appie://login-exit?code=not-a-real-code-1" }));
    assert.equal(refused.status, 401);
    const html = await refused.text();
    assert.match(html, /accepteert die code niet/);
    assert.ok(!html.includes("not-a-real-code-1"));

    // A code works once at Albert Heijn.
    const address = ah.loginExit("kim");
    assert.equal((await fetch(`${base}/ah/login`, form({ tx, lang: "nl", action: "code", pasted: address }))).status, 303);
    assert.equal((await fetch(`${base}/ah/login`, form({ tx, lang: "nl", action: "code", pasted: address }))).status, 401);
  });

  it("rejects a forged form token, also one from the Picnic sign-in", async () => {
    const { client_id: clientId } = await register();
    const picnicPage = await (await openSignIn(clientId, pkce().challenge, {})).text();
    for (const tx of ["x".repeat(80), hidden(picnicPage, "tx")]) {
      const res = await fetch(`${base}/ah/login`, form({ tx, lang: "nl", action: "guest" }));
      assert.equal(res.status, 400);
      assert.match(await res.text(), /verlopen/);
    }
  });

  it("explains when Albert Heijn can't be reached or blocks the server", async () => {
    const { client_id: clientId } = await register();
    const tx = hidden(await (await openSignIn(clientId, pkce().challenge)).text(), "tx");
    ah.down = true;
    try {
      const res = await fetch(`${base}/ah/login`, form({ tx, lang: "nl", action: "guest" }));
      assert.equal(res.status, 502);
      assert.match(await res.text(), /niet gelukt/);
    } finally {
      ah.down = false;
    }
    ah.blocked = true;
    try {
      const res = await fetch(`${base}/ah/login`, form({ tx, lang: "nl", action: "guest" }));
      assert.equal(res.status, 502);
      assert.match(await res.text(), /weigert op dit moment verzoeken van deze server/);
    } finally {
      ah.blocked = false;
    }
  });

  it("limits sign-in attempts per visitor", async () => {
    const other = await startServer({ AH_ENABLED: "true" }, ah, { signInAttemptLimit: 2 });
    try {
      const { client_id: clientId } = await register(other.base);
      const tx = hidden(await (await openSignIn(clientId, pkce().challenge, { scope: "ah" }, other.base)).text(), "tx");
      const attempt = () => fetch(`${other.base}/ah/login`, form({ tx, lang: "nl", action: "code", pasted: "appie://login-exit?code=wrong-code-1234" }));
      assert.equal((await attempt()).status, 401);
      assert.equal((await attempt()).status, 401);
      assert.equal((await attempt()).status, 429);
    } finally {
      await other.close();
    }
  });
});

describe("tokens", () => {
  it("keeps the two connectors' tokens apart", async () => {
    const kim = await connect();
    const picnicUser = await connectPicnic();
    assert.equal(kim.scope, "ah");
    assert.equal((await post("/ah/mcp", kim.access_token)).status, 200);
    assert.equal((await post("/mcp", picnicUser.access_token)).status, 200);
    assert.equal((await post("/mcp", kim.access_token)).status, 401);
    assert.equal((await post("/ah/mcp", picnicUser.access_token)).status, 401);

    // Renewing a token while naming the other connector is refused.
    const wrong = await token({ grant_type: "refresh_token", client_id: kim.clientId, refresh_token: kim.refresh_token, resource: `${base}/mcp` });
    assert.equal(wrong.body.error, "invalid_target");
    const alsoWrong = await token({ grant_type: "refresh_token", client_id: picnicUser.clientId, refresh_token: picnicUser.refresh_token, resource: `${base}/ah/mcp` });
    assert.equal(alsoWrong.body.error, "invalid_target");
  });

  it("accepts a code once, for the app it was given to", async () => {
    const { client_id: clientId } = await register();
    const other = await register();
    const { verifier, challenge } = pkce();
    const code = await signIn(clientId, challenge, "kim");
    const fields = { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT };
    assert.equal((await token({ ...fields, client_id: other.client_id })).body.error, "invalid_grant");
    assert.equal((await token({ ...fields, client_id: clientId, code_verifier: "wrong".repeat(10) })).body.error, "invalid_grant");
    assert.ok((await token({ ...fields, client_id: clientId })).body.access_token);
    assert.equal((await token({ ...fields, client_id: clientId })).body.error, "invalid_grant");
  });

  it("expires just before Albert Heijn's own token does", async () => {
    ah.expiresIn = 1800;
    try {
      const kim = await connect();
      assert.ok(kim.expires_in > 1500 && kim.expires_in <= 1800 - 120, `expires in ${kim.expires_in}`);
    } finally {
      ah.expiresIn = 7200;
    }
    // And never later than a day, however long Albert Heijn's token lasts.
    ah.expiresIn = 7 * 24 * 3600;
    try {
      assert.equal((await connect()).expires_in, 24 * 3600);
    } finally {
      ah.expiresIn = 7200;
    }
  });

  it("renews Albert Heijn's tokens when they are about to expire, once per refresh token", async () => {
    ah.expiresIn = 1800;
    const kim = await connect();
    ah.expiresIn = 7200;
    const refreshes = ah.refreshes;
    const renew = () => token({ grant_type: "refresh_token", client_id: kim.clientId, refresh_token: kim.refresh_token });

    // Two tabs ask at the same moment, and one asks again after a lost answer.
    const [first, second] = await Promise.all([renew(), renew()]);
    const third = await renew();
    assert.equal(ah.refreshes, refreshes + 1);
    assert.ok(first.body.access_token);
    assert.deepEqual(second.body, first.body);
    assert.deepEqual(third.body, first.body);

    const client = await mcp(first.body.access_token);
    assert.equal((await data(client, "get_account")).name, "kim Jansen");
    await client.close();

    // The renewed tokens carry Albert Heijn's new refresh token.
    const next = await token({ grant_type: "refresh_token", client_id: kim.clientId, refresh_token: first.body.refresh_token });
    assert.ok(next.body.access_token);
  });

  it("leaves Albert Heijn's tokens alone while they are good for a long time yet", async () => {
    ah.expiresIn = 7 * 24 * 3600;
    const kim = await connect();
    ah.expiresIn = 7200;
    const refreshes = ah.refreshes;
    const renewed = await token({ grant_type: "refresh_token", client_id: kim.clientId, refresh_token: kim.refresh_token });
    assert.ok(renewed.body.access_token);
    assert.equal(ah.refreshes, refreshes);
    assert.equal((await post("/ah/mcp", renewed.body.access_token)).status, 200);
  });

  it("asks the user to sign in again when Albert Heijn ended the sign-in, and to try again when it is unreachable", async () => {
    ah.expiresIn = 1800;
    const kim = await connect();
    const sam = await connect("sam");
    ah.expiresIn = 7200;

    ah.down = true;
    try {
      const failed = await token({ grant_type: "refresh_token", client_id: kim.clientId, refresh_token: kim.refresh_token });
      assert.equal(failed.res.status, 500);
      assert.equal(failed.body.error, "server_error");
    } finally {
      ah.down = false;
    }
    // Nothing was lost: the same refresh token works when Albert Heijn is back.
    assert.ok((await token({ grant_type: "refresh_token", client_id: kim.clientId, refresh_token: kim.refresh_token })).body.access_token);

    // Albert Heijn ended sam's sign-in: its refresh token is no longer known there.
    ah.dropRefreshTokens("sam");
    const ended = await token({ grant_type: "refresh_token", client_id: sam.clientId, refresh_token: sam.refresh_token });
    assert.equal(ended.res.status, 400);
    assert.equal(ended.body.error, "invalid_grant");
  });

  it("gives a visitor new visitor tokens when Albert Heijn dropped the old ones", async () => {
    ah.expiresIn = 1800;
    const visitor = await connect(null);
    ah.expiresIn = 7200;
    ah.dropRefreshTokens(null);
    const renewed = await token({ grant_type: "refresh_token", client_id: visitor.clientId, refresh_token: visitor.refresh_token });
    assert.ok(renewed.body.access_token);
    const client = await mcp(renewed.body.access_token);
    assert.equal((await data(client, "get_account")).signed_in, false);
    assert.equal((await data(client, "search_products", { query: "melk" })).products.length, 1);
    await client.close();
  });

  it("ends a sign-in after a fixed time, however often the tokens are renewed", async (t) => {
    const kim = await connect();
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() + (SIGN_IN_TTL + 60) * 1000 });
    try {
      const late = await token({ grant_type: "refresh_token", client_id: kim.clientId, refresh_token: kim.refresh_token });
      assert.equal(late.body.error, "invalid_grant");
    } finally {
      t.mock.timers.reset();
    }
  });

  it("does not let another app use a refresh token, and rejects a tampered one", async () => {
    const kim = await connect();
    const other = await register();
    assert.equal((await token({ grant_type: "refresh_token", client_id: other.client_id, refresh_token: kim.refresh_token })).body.error, "invalid_grant");
    assert.equal((await token({ grant_type: "refresh_token", client_id: kim.clientId, refresh_token: `${kim.refresh_token}x` })).body.error, "invalid_grant");
    // An access token is not a refresh token.
    assert.equal((await token({ grant_type: "refresh_token", client_id: kim.clientId, refresh_token: kim.access_token })).body.error, "invalid_grant");
  });
});

describe("mcp", () => {
  it("lists the tools with titles and safety hints, and none that orders", async () => {
    const client = await mcp((await connect()).access_token);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "add_to_cart",
      "clear_cart",
      "disconnect_account",
      "get_account",
      "get_cart",
      "get_delivery_slots",
      "get_product",
      "get_promotions",
      "get_recipe",
      "list_orders",
      "remove_from_cart",
      "search_products",
      "search_recipes",
    ]);
    assert.ok(!names.some((n) => /checkout|pay|order_now|book|reserve|slot_select|select_delivery/.test(n)), "no tool can place an order or book a delivery");
    for (const tool of tools) {
      assert.ok(tool.title, `${tool.name} has a title`);
      assert.ok(tool.description, `${tool.name} has a description`);
      assert.equal(typeof tool.annotations?.readOnlyHint, "boolean", `${tool.name} says whether it changes anything`);
    }
    assert.equal(tools.find((t) => t.name === "get_delivery_slots")?.annotations?.readOnlyHint, true);
    assert.match(client.getInstructions() ?? "", /cannot place or pay/);
    assert.equal(client.getServerVersion()?.name, "albert-heijn");
    await client.close();
  });

  it("searches products, leaves out sponsored ones and shows a product's label", async () => {
    const client = await mcp((await connect()).access_token);
    const found = await data(client, "search_products", { query: "melk" });
    assert.deepEqual(
      found.products.map((p: { product_id: number }) => p.product_id),
      [1001],
    );
    assert.equal(found.products[0].price, "€1.29");
    const penne = (await data(client, "search_products", { query: "penne" })).products[0];
    assert.equal(penne.deal, "2 voor 1.50");
    assert.equal(penne.deal_until, undefined);

    // Ids arrive as numbers or as text.
    const product = await data(client, "get_product", { product_id: "1001" });
    assert.equal(product.name, "AH Halfvolle melk");
    assert.equal(product.nutriscore, "B");
    assert.deepEqual(product.allergens.contains, ["Melk"]);
    assert.deepEqual(product.diet_labels, ["Vegetarisch"]);
    assert.match(textOf(await call(client, "get_product", { product_id: 4242 })), /Not found/);
    await client.close();
  });

  it("fills the basket and keeps users apart", async () => {
    const kim = await mcp((await connect("kim")).access_token);
    const sam = await mcp((await connect("sam")).access_token);

    const added = await data(kim, "add_to_cart", { items: [{ product_id: 1001, quantity: 2 }, { product_id: 1002 }, { product_id: 1001 }, { product_id: 4242 }] });
    assert.deepEqual(added.not_added, [4242]);
    assert.equal(added.cart.item_count, 4);
    assert.equal(added.cart.estimated_total, "€4.86");
    assert.equal(ah.quantity("kim", 1001), 3);
    assert.equal(ah.quantity("sam", 1001), 0);
    assert.deepEqual((await data(sam, "get_cart")).items, undefined);

    const removed = await data(kim, "remove_from_cart", { items: [{ product_id: 1001, quantity: 1 }, { product_id: 1002, quantity: 5 }, { product_id: 999 }] });
    assert.deepEqual(removed.not_in_cart, [999]);
    assert.equal(ah.quantity("kim", 1001), 2);
    assert.equal(ah.quantity("kim", 1002), 0);

    const cleared = await data(kim, "clear_cart");
    assert.equal(cleared.items, undefined);
    assert.deepEqual(cleared.notes, ["ballonnen"]);
    assert.equal(ah.quantity("kim", 1001), 0);
    await kim.close();
    await sam.close();
  });

  it("does not touch the basket once a delivery is booked", async () => {
    const client = await mcp((await connect("lee")).access_token);
    await data(client, "add_to_cart", { items: [{ product_id: 1001, quantity: 2 }] });
    ah.booked.add("lee");
    try {
      const cart = await data(client, "get_cart");
      assert.equal(cart.delivery_booked, true);
      assert.equal(cart.booked_order.items[0].quantity, 2);
      for (const [name, args] of [
        ["add_to_cart", { items: [{ product_id: 1002 }] }],
        ["remove_from_cart", { items: [{ product_id: 1001 }] }],
        ["clear_cart", {}],
      ] as const) {
        const result = await call(client, name, args);
        assert.equal(result.isError, true, name);
        assert.match(textOf(result), /Nothing was changed. A delivery or pick-up is booked/, name);
      }
      assert.equal(ah.quantity("lee", 1001), 2);
      assert.equal(ah.quantity("lee", 1002), 0);
    } finally {
      ah.booked.delete("lee");
    }
    await client.close();
  });

  it("changes nothing when it can't check for a booked delivery", async () => {
    const client = await mcp((await connect("max")).access_token);
    ah.orderCheckDown = true;
    try {
      const result = await call(client, "add_to_cart", { items: [{ product_id: 1001 }] });
      assert.equal(result.isError, true);
      assert.match(textOf(result), /Nothing was changed, because it could not be checked/);
      assert.equal(ah.quantity("max", 1001), 0);
    } finally {
      ah.orderCheckDown = false;
    }
    await client.close();
  });

  it("lets a visitor without an account search, and nothing that needs an account", async () => {
    const client = await mcp((await connect(null)).access_token);
    const account = await data(client, "get_account");
    assert.equal(account.signed_in, false);
    assert.equal((await data(client, "search_products", { query: "melk" })).products.length, 1);
    assert.equal((await data(client, "search_recipes", { query: "penne" })).recipes[0].recipe_id, 501);
    assert.ok((await data(client, "get_promotions")).deals.length > 0);
    assert.equal((await data(client, "get_delivery_slots", { street: "Dorpsstraat", house_number: 1, postal_code: "1234 AB", city: "Ons Dorp" })).days.length, 1);

    for (const [name, args] of [
      ["get_cart", {}],
      ["add_to_cart", { items: [{ product_id: 1001 }] }],
      ["remove_from_cart", { items: [{ product_id: 1001 }] }],
      ["clear_cart", {}],
      ["list_orders", {}],
      ["get_promotions", { personal: true }],
      ["get_delivery_slots", {}],
    ] as const) {
      const result = await call(client, name, args);
      assert.equal(result.isError, true, name);
      assert.match(textOf(result), /without (an Albert Heijn account|one)/, name);
    }
    await client.close();
  });

  it("shows the bonus deals, fetched once for everyone", async () => {
    const kim = await mcp((await connect("kim")).access_token);
    const sam = await mcp((await connect("sam")).access_token);

    const featured = await data(kim, "get_promotions");
    assert.deepEqual(featured.sections, ["Pasta, rijst", "Zuivel, eieren"]);
    assert.equal(featured.deals[0].group_id, "9001");
    assert.equal(featured.deals[0].deal, "2 VOOR 1.50");

    const dairy = await data(sam, "get_promotions", { section: "zuivel" });
    assert.equal(dairy.deals[0].product_id, 1001);
    assert.equal(dairy.deals[0].price, "€0.97");
    assert.equal(dairy.deals[0].was, "€1.29");
    assert.equal((await data(kim, "get_promotions", { search: "pasta" })).deals.length, 1);
    assert.equal((await data(kim, "get_promotions", { group_id: "9001" })).products[0].product_id, 1002);
    assert.match(textOf(await call(kim, "get_promotions", { section: "vuurwerk" })), /No bonus section matches/);
    assert.match(textOf(await call(kim, "get_promotions", { week: "next" })), /aren't published yet/);

    await data(sam, "get_promotions");
    await data(sam, "get_promotions", { search: "melk" });
    assert.equal(ah.calls.filter((c) => c === "GET bonuspage/v3/metadata").length, 1);
    assert.equal(ah.calls.filter((c) => c === "GET bonuspage/v2/section/spotlight").length, 1);
    assert.equal(ah.calls.filter((c) => c === "GET bonuspage/v2/section").length, 2);

    // Personal offers are the user's own and are never shared.
    assert.equal((await data(kim, "get_promotions", { personal: true })).deals[0].name, "Koffie voor kim");
    assert.equal((await data(sam, "get_promotions", { personal: true })).deals[0].name, "Koffie voor sam");
    await kim.close();
    await sam.close();
  });

  it("shows recipes with the products for them, scaled to the portions asked for", async () => {
    const client = await mcp((await connect()).access_token);
    const recipe = await data(client, "get_recipe", { recipe_id: 501, portions: 2 });
    assert.equal(recipe.name, "Penne met melksaus");
    assert.equal(recipe.ingredients[0].needed, "150 g penne");
    assert.equal(recipe.ingredients[0].product.product_id, 1002);
    assert.equal(recipe.product_quantities_are_for_portions, 4);
    assert.deepEqual(recipe.steps, ["Kook de penne."]);
    assert.match(textOf(await call(client, "get_recipe", { recipe_id: 7 })), /No Allerhande recipe/);
    await client.close();
  });

  it("shows delivery times for the account's address, orders and the account", async () => {
    const client = await mcp((await connect()).access_token);
    const slots = await data(client, "get_delivery_slots");
    assert.equal(slots.address, "Dorpsstraat 12A, 1234AB Ons Dorp");
    assert.deepEqual(slots.days[0].slots, [{ from: "16:00", until: "18:00", delivery_costs: "€5.95", regular_costs: "€7.95" }]);
    assert.equal((await data(client, "get_delivery_slots", { include_full: true })).days[0].slots.length, 2);

    assert.equal((await data(client, "list_orders")).orders[0].order_id, 77);
    assert.equal((await data(client, "list_orders", { status: "past" })).orders, undefined);

    const account = await data(client, "get_account");
    assert.equal(account.signed_in, true);
    assert.equal(account.email, "kim@example.com");
    assert.equal(account.bonus_card, "•••••••••2345");
    await client.close();
  });

  it("rejects invalid arguments", async () => {
    const client = await mcp((await connect()).access_token);
    for (const [name, args] of [
      ["add_to_cart", { items: [] }],
      ["add_to_cart", { items: [{ product_id: 1001, quantity: 0 }] }],
      ["search_products", { query: "" }],
      ["get_product", { product_id: "melk" }],
    ] as const) {
      assert.equal((await call(client, name, args)).isError, true, `${name} ${JSON.stringify(args)}`);
    }
    await client.close();
  });

  it("makes the app renew its tokens when Albert Heijn refuses one before its time", async () => {
    const pat = await connect("pat");
    const client = await mcp(pat.access_token);
    ah.dropAccessTokens("pat");

    const result = await call(client, "get_cart");
    assert.equal(result.isError, true);
    assert.match(textOf(result), /Try once more/);
    await client.close().catch(() => {});

    // The same token is now refused, which sends the app to its refresh token.
    assert.equal((await post("/ah/mcp", pat.access_token)).status, 401);
    const refreshes = ah.refreshes;
    const renewed = await token({ grant_type: "refresh_token", client_id: pat.clientId, refresh_token: pat.refresh_token });
    assert.equal(ah.refreshes, refreshes + 1);
    const again = await mcp(renewed.body.access_token);
    assert.equal((await data(again, "get_cart")).item_count, 0);
    await again.close();
  });

  it("disconnects: the tool and token revocation both end the sign-in here", async () => {
    const kim = await connect("kim");
    const client = await mcp(kim.access_token);
    assert.equal((await data(client, "disconnect_account")).disconnected, true);
    await client.close().catch(() => {});
    assert.equal((await post("/ah/mcp", kim.access_token)).status, 401);
    assert.equal((await token({ grant_type: "refresh_token", client_id: kim.clientId, refresh_token: kim.refresh_token })).body.error, "invalid_grant");

    const sam = await connect("sam");
    const revoked = await fetch(`${base}/revoke`, form({ client_id: sam.clientId, token: sam.refresh_token }));
    assert.equal(revoked.status, 200);
    assert.equal((await post("/ah/mcp", sam.access_token)).status, 401);

    // Another user's sign-in is untouched.
    const lee = await connect("lee");
    assert.equal((await post("/ah/mcp", lee.access_token)).status, 200);
  });

  it("only speaks POST", async () => {
    const res = await fetch(`${base}/ah/mcp`);
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "POST, OPTIONS");
  });
});
