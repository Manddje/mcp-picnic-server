import { createHash } from "node:crypto";
import cors from "cors";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Config } from "./config.js";
import { Sealer } from "./crypto.js";
import { pickLang } from "./i18n.js";
import { createLoginRouter } from "./login.js";
import { PicnicOAuthProvider, RedirectPolicy, SCOPE, sessionOf } from "./oauth.js";
import { sendLanding } from "./pages.js";
import { createPicnicClient, type PicnicFactory } from "./picnic.js";
import { buildMcpServer } from "./tools.js";

export const VERSION = "1.0.0";

export type AppOptions = {
  config: Config;
  /** Creates the Picnic client for a request; replaced by a fake in tests. */
  picnic?: PicnicFactory;
  /** Sign-in attempts allowed per IP address per 15 minutes. */
  signInAttemptLimit?: number;
  /** Sign-in attempts allowed per Picnic account per 15 minutes. */
  accountAttemptLimit?: number;
  log?: (message: string) => void;
};

function rpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

export function createApp({
  config,
  picnic = createPicnicClient,
  signInAttemptLimit = 15,
  accountAttemptLimit = 10,
  log = console.log,
}: AppOptions): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.trustProxy);

  const sealer = new Sealer(config.secretKey);
  const provider = new PicnicOAuthProvider(sealer, picnic, new RedirectPolicy(config.extraKnownApps, config.unknownApps === "block"));
  const mcpUrl = new URL("/mcp", config.publicUrl);
  const secure = config.publicUrl.protocol === "https:";

  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    if (secure) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    // One line per request, without query strings or bodies: those carry OAuth state and credentials.
    const started = Date.now();
    const path = req.path;
    res.on("finish", () => {
      if (path !== "/health") log(`${req.method} ${path} ${res.statusCode} ${Date.now() - started}ms`);
    });
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", version: VERSION });
  });

  app.get("/", (req, res) => {
    sendLanding(res, pickLang(req), {
      serviceName: config.serviceName,
      mcpUrl: mcpUrl.href,
      contact: config.contact,
      sourceUrl: config.sourceUrl,
    });
  });

  app.get("/robots.txt", (_req, res) => {
    res.type("text/plain").send("User-agent: *\nAllow: /$\nDisallow: /\n");
  });

  // Registration and token requests are made by the AI app's servers, so thousands of users can share
  // a handful of IP addresses there. A limit per IP address that suits one user would lock all of
  // them out; these only stop floods. Registering stores nothing, and a token request without a
  // valid code or refresh token costs a failed decryption.
  const serverToServer = { windowMs: 60 * 1000, limit: 1200 };

  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: config.publicUrl,
      resourceServerUrl: mcpUrl,
      resourceName: config.serviceName,
      scopesSupported: [SCOPE],
      serviceDocumentationUrl: config.publicUrl,
      // The sign-in page is opened in the user's own browser.
      authorizationOptions: { rateLimit: { windowMs: 15 * 60 * 1000, limit: 60 } },
      clientRegistrationOptions: { clientIdGeneration: false, clientSecretExpirySeconds: 0, rateLimit: serverToServer },
      tokenOptions: { rateLimit: serverToServer },
      revocationOptions: { rateLimit: serverToServer },
    }),
  );

  // Some clients look for the resource metadata at the root instead of under the /mcp path.
  app.get("/.well-known/oauth-protected-resource", cors(), (_req, res) => {
    res.json({
      resource: mcpUrl.href,
      authorization_servers: [config.publicUrl.href],
      scopes_supported: [SCOPE],
      resource_name: config.serviceName,
      bearer_methods_supported: ["header"],
    });
  });

  app.use(
    createLoginRouter({
      sealer,
      provider,
      picnic,
      serviceName: config.serviceName,
      attemptLimit: signInAttemptLimit,
      accountAttemptLimit,
      globalLimitPerMinute: config.signInLimitPerMinute,
      log,
    }),
  );

  /* ---------- MCP endpoint ---------- */

  const mcpCors = cors({
    origin: true,
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "Accept", "Mcp-Session-Id", "Mcp-Protocol-Version", "Last-Event-ID"],
    exposedHeaders: ["Mcp-Session-Id", "WWW-Authenticate"],
    maxAge: 86400,
  });
  const bearer = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
  });
  // Per signed-in user, not per IP address (see above). Runs after authentication.
  const perUser = rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => createHash("sha256").update(sessionOf(req.auth).authKey).digest("base64url"),
    handler: (_req, res) => rpcError(res, 429, -32000, "Too many requests. Wait a minute before trying again."),
  });

  app.options("/mcp", mcpCors);
  app.post("/mcp", mcpCors, bearer, perUser, express.json({ limit: "1mb" }), async (req: Request, res: Response) => {
    // No sessions: every request carries its token, so any request can be served on its own.
    const session = sessionOf(req.auth);
    const server = buildMcpServer(
      { picnic: picnic(session), country: session.country, signOut: () => provider.signOut(session) },
      VERSION,
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      log(`mcp request failed: ${error instanceof Error ? error.message : "unknown error"}`);
      if (!res.headersSent) rpcError(res, 500, -32603, "Internal server error");
    }
  });
  // The server never pushes messages on its own, so there is no stream to open and no session to end.
  app.all("/mcp", mcpCors, (_req, res) => {
    res.setHeader("Allow", "POST, OPTIONS");
    rpcError(res, 405, -32000, "Method not allowed. Send MCP requests with POST.");
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (error as { status?: number }).status;
    if (status && status >= 400 && status < 500) {
      res.status(status).json({ error: "bad_request" });
      return;
    }
    log(`request failed: ${error instanceof Error ? error.message : "unknown error"}`);
    if (!res.headersSent) res.status(500).json({ error: "server_error" });
  });

  return app;
}
