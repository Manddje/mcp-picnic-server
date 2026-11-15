import { randomBytes } from "node:crypto";
import PicnicClient from "picnic-api";

export type Country = "NL" | "DE" | "FR";
export const COUNTRIES: Country[] = ["NL", "DE", "FR"];

export function isCountry(value: unknown): value is Country {
  return typeof value === "string" && (COUNTRIES as string[]).includes(value);
}

/** What the server needs to act as a Picnic user. It travels inside the user's encrypted token. */
export type PicnicSession = {
  authKey: string;
  country: Country;
  /** The device id this user signed in with; every sign-in gets its own, like an app install. */
  deviceId: string;
};

export type PicnicFactory = (options: { country: Country; deviceId: string; authKey?: string }) => PicnicClient;

export const createPicnicClient: PicnicFactory = ({ country, deviceId, authKey }) =>
  new PicnicClient({ countryCode: country, deviceId, authKey });

export function newDeviceId(): string {
  return randomBytes(8).toString("hex").toUpperCase();
}

export type PicnicErrorKind = "credentials" | "code" | "session" | "throttled" | "not_found" | "other";

/** Sorts an error from picnic-api into the few cases the server treats differently. */
export function classifyPicnicError(error: unknown): { kind: PicnicErrorKind; status: number | null; code: string | null } {
  if (PicnicClient.isProductNotFoundError(error)) return { kind: "not_found", status: 404, code: null };
  if (!PicnicClient.isPicnicApiError(error)) return { kind: "other", status: null, code: null };
  const { status, code } = error;
  if (code === "AUTH_INVALID_CRED") return { kind: "credentials", status, code };
  if (code === "OTP_NOT_VALID") return { kind: "code", status, code };
  if (status === 401) return { kind: "session", status, code };
  // Picnic's edge answers a throttled client with a 403 HTML page (no code), or a 429.
  if (status === 429 || (status === 403 && !code)) return { kind: "throttled", status, code };
  if (status === 404) return { kind: "not_found", status, code };
  return { kind: "other", status, code };
}
