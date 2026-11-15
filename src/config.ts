import { randomBytes } from "node:crypto";

export type Config = {
  /** The public base URL of this server, without a trailing slash, e.g. https://picnic.example.com */
  publicUrl: URL;
  port: number;
  host: string;
  /** Secret that all tokens are encrypted with. Changing it signs everyone out. */
  secretKey: string;
  /** Name shown on the landing and sign-in pages. */
  serviceName: string;
  /** Express "trust proxy" setting; 1 = one reverse proxy (Coolify/Traefik) in front. */
  trustProxy: number | boolean | string;
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

function parseTrustProxy(value: string | undefined): number | boolean | string {
  if (value === undefined || value === "") return 1;
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

  return {
    publicUrl,
    port,
    host: env.HOST ?? "0.0.0.0",
    secretKey,
    serviceName: env.SERVICE_NAME?.trim() || "Picnic MCP",
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    contact: env.CONTACT?.trim() || null,
    sourceUrl: env.SOURCE_URL?.trim() || null,
  };
}
