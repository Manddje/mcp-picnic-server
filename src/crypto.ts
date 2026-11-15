import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

/**
 * Encrypts small JSON payloads into opaque, tamper-proof strings (AES-256-GCM).
 *
 * The server keeps no database: everything it needs to remember between requests (a registered
 * OAuth client, a sign-in in progress, an access token) is sealed into the string it hands out and
 * read back when the string returns. Each purpose has its own key, so a string sealed for one
 * purpose can't be used for another.
 */
export class Sealer {
  private readonly keys = new Map<string, Buffer>();

  constructor(private readonly secret: string) {}

  private key(purpose: string): Buffer {
    let key = this.keys.get(purpose);
    if (!key) {
      key = Buffer.from(hkdfSync("sha256", this.secret, "mop-picnic-server", purpose, 32));
      this.keys.set(purpose, key);
    }
    return key;
  }

  /** Seals a payload. With `ttlSeconds`, {@link open} rejects it after that time. */
  seal(purpose: string, payload: Record<string, unknown>, ttlSeconds?: number): string {
    const body = ttlSeconds ? { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds } : payload;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key(purpose), iv);
    cipher.setAAD(Buffer.from(purpose));
    const data = Buffer.concat([cipher.update(JSON.stringify(body), "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url");
  }

  /** Opens a sealed string. Returns null when it is malformed, forged, for another purpose or expired. */
  open<T extends Record<string, unknown>>(purpose: string, sealed: unknown): (T & { exp?: number }) | null {
    if (typeof sealed !== "string" || sealed.length < 40 || sealed.length > 16384) return null;
    try {
      const raw = Buffer.from(sealed, "base64url");
      const decipher = createDecipheriv("aes-256-gcm", this.key(purpose), raw.subarray(0, 12));
      decipher.setAAD(Buffer.from(purpose));
      decipher.setAuthTag(raw.subarray(12, 28));
      const json = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
      const payload = JSON.parse(json) as T & { exp?: number };
      if (typeof payload.exp === "number" && payload.exp < Date.now() / 1000) return null;
      return payload;
    } catch {
      return null;
    }
  }

  /** A keyed hash, used to derive a client secret from a client id. */
  mac(purpose: string, value: string): string {
    return createHmac("sha256", this.key(purpose)).update(value).digest("base64url");
  }
}
