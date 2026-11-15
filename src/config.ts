import { randomBytes } from "node:crypto";
import { parseCallbackPattern } from "./oauth.js";

export type Config = {
  /** The public base URL of this server, without a trailing slash, e.g. https://picnic.example.com */
  publicUrl: URL;
  port: number;
  host: string;
  /** Secret that all tokens are encrypted with. Changing it signs everyone out. */
  secretKey: string;
  /** Name shown on the landing and sign-in pages. */
  serviceName: string;
  /**
   * Express "trust proxy" setting; 1 = one reverse proxy (Coolify/Traefik) in front. Off unless set
   * or running on Coolify: trusting X-Forwarded-For without a proxy lets anyone pick their own IP
   * address and so walk past the sign-in limits.
   */
  trustProxy: number | boolean | string;
  /** Extra known apps: callback addresses (https://example.com/oauth/callback), app schemes (myapp://) and whole host names (example.com). */
  extraKnownApps: string[];
  /** What to do with an app whose redirect URI is not a known one: warn on the sign-in page, or refuse it. */
  unknownApps: "warn" | "block";
  /** Sign-ins that reach Picnic per minute, for the whole server, so Picnic doesn't throttle its IP address. */
  signInLimitPerMinute: number;
  /** Requests of any kind that reach Picnic per minute, for the whole server. */
  picnicLimitPerMinute: number;
  /** Requests one signed-in user may send to Picnic per minute, out of the server's. */
  picnicUserLimitPerMinute: number;
  /** Seconds without any request to Picnic after it throttled one; 0 for no pause. */
  picnicPauseSeconds: number;
  /** Optional contact shown on the landing page (email address or URL). */
  contact: string | null;
  /** Optional link to the source code shown on the landing page. */
  sourceUrl: string | null;
};

function firstUrl(value: string | undefined): string | undefined {
  // Coolify sets COOLIFY_URL / COOLIFY_FQDN, possibly as a comma separated list.
  const first = value?.split(",")[0]?.trim();
  if (!first) return undefined;
  return /^https?:\/\//.test(first) ? first : `https://${first}`;
}

function parseTrustProxy(value: string | undefined, onCoolify: boolean): number | boolean | string {
  // Coolify always puts its Traefik proxy in front of the app.
  if (value === undefined || value === "") return onCoolify ? 1 : false;
  if (value === "true") return true;
  if (value === "false") return false;
  const n = Number(value);
  return Number.isInteger(n) ? n : value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 3000);
  const rawUrl = env.PUBLIC_URL?.trim() || firstUrl(env.COOLIFY_URL) || firstUrl(env.COOLIFY_FQDN) || `http://localhost:${port}`;

  let publicUrl: URL;
  try {
    publicUrl = new URL(rawUrl.replace(/\/+$/, ""));
  } catch {
    throw new Error(`PUBLIC_URL is not a valid URL: ${rawUrl}`);
  }
  const isLocal = publicUrl.hostname === "localhost" || publicUrl.hostname === "127.0.0.1";
  if (publicUrl.protocol !== "https:" && !isLocal) {
    throw new Error(`PUBLIC_URL must use https (got ${publicUrl.origin}). OAuth clients refuse plain http.`);
  }
  if (publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash) {
    throw new Error("PUBLIC_URL must be an origin without a path, e.g. https://picnic.example.com");
  }

  let secretKey = env.SECRET_KEY?.trim() ?? "";
  if (!secretKey) {
    if (env.NODE_ENV === "production") {
      throw new Error("SECRET_KEY is required. Generate one with: openssl rand -hex 32");
    }
    secretKey = randomBytes(32).toString("hex");
    console.warn("[config] SECRET_KEY is not set: using a random key. Everyone is signed out when the server restarts.");
  } else if (secretKey.length < 32) {
    throw new Error("SECRET_KEY must be at least 32 characters. Generate one with: openssl rand -hex 32");
  }

  const onCoolify = Boolean(env.COOLIFY_URL?.trim() || env.COOLIFY_FQDN?.trim());
  const trustProxy = parseTrustProxy(env.TRUST_PROXY?.trim(), onCoolify);
  if (trustProxy === false && !isLocal) {
    console.warn("[config] TRUST_PROXY is not set: client IP addresses are taken from the connection. Behind one reverse proxy, set TRUST_PROXY=1.");
  }

  const extraKnownApps = (env.EXTRA_KNOWN_APPS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    // A callback address keeps its case: paths are case sensitive.
    .map((entry) => (/^https?:\/\//i.test(entry) ? entry : entry.toLowerCase()));
  for (const entry of extraKnownApps) {
    if (!parseCallbackPattern(entry) && !/^[a-z0-9.-]+$/.test(entry) && !/^[a-z][a-z0-9+.-]*:\/\/$/.test(entry)) {
      throw new Error(
        `EXTRA_KNOWN_APPS: "${entry}" is not a callback address (https://example.com/oauth/callback, without a query), an app scheme (myapp://) or a host name (example.com)`,
      );
    }
  }

  const unknownApps = env.UNKNOWN_APPS?.trim() || "warn";
  if (unknownApps !== "warn" && unknownApps !== "block") {
    throw new Error(`UNKNOWN_APPS must be "warn" or "block" (got "${unknownApps}")`);
  }

  const wholeNumber = (name: string, fallback: number, min: number): number => {
    const value = Number(env[name]?.trim() || fallback);
    if (!Number.isInteger(value) || value < min) throw new Error(`${name} must be a whole number of at least ${min}`);
    return value;
  };
  const signInLimitPerMinute = wholeNumber("SIGN_IN_LIMIT_PER_MINUTE", 60, 1);
  const picnicLimitPerMinute = wholeNumber("PICNIC_LIMIT_PER_MINUTE", 300, 1);
  const picnicUserLimitPerMinute = wholeNumber("PICNIC_USER_LIMIT_PER_MINUTE", 120, 1);
  const picnicPauseSeconds = wholeNumber("PICNIC_PAUSE_SECONDS", 60, 0);

  return {
    publicUrl,
    port,
    host: env.HOST ?? "0.0.0.0",
    secretKey,
    serviceName: env.SERVICE_NAME?.trim() || "Picnic MCP",
    trustProxy,
    extraKnownApps,
    unknownApps,
    signInLimitPerMinute,
    picnicLimitPerMinute,
    picnicUserLimitPerMinute,
    picnicPauseSeconds,
    contact: env.CONTACT?.trim() || null,
    sourceUrl: env.SOURCE_URL?.trim() || null,
  };
}
