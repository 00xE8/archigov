import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../db.js";

/**
 * Stateless sessions: a JSON payload signed with HMAC-SHA256 and carried in an httpOnly cookie. There is no
 * session table to replicate or clean up, which matters for a single-file-SQLite product, and nothing in the
 * cookie is secret — only unforgeable. The secret comes from SESSION_SECRET or a file generated once under
 * DATA_DIR/keys (mode 0600) so a self-hosted instance keeps sessions across restarts without configuration.
 */
export const SESSION_COOKIE = "archigov_session";
export const OIDC_COOKIE = "archigov_oidc";
export const SESSION_TTL_SECONDS = 12 * 3600;

let secret: Buffer | null = null;
export function sessionSecret(): Buffer {
  if (secret) return secret;
  if (process.env.SESSION_SECRET) { secret = Buffer.from(process.env.SESSION_SECRET, "utf8"); return secret; }
  const dir = path.join(DATA_DIR, "keys");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "session.secret");
  if (!fs.existsSync(file)) fs.writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600 });
  secret = Buffer.from(fs.readFileSync(file, "utf8").trim(), "hex");
  return secret;
}

const b64u = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const mac = (body: string) => createHmac("sha256", sessionSecret()).update(body).digest("base64url");

/** Sign a payload; `exp` (unix seconds) is enforced on verify when present. */
export function signToken(payload: Record<string, unknown>): string {
  const body = b64u(JSON.stringify(payload));
  return `${body}.${mac(body)}`;
}

/** Returns the payload when the signature is intact and it has not expired; null otherwise (never throws). */
export function verifyToken<T = any>(token: string | null | undefined): T | null {
  if (!token) return null;
  const i = token.lastIndexOf(".");
  if (i < 1) return null;
  const body = token.slice(0, i), given = Buffer.from(token.slice(i + 1)), expected = Buffer.from(mac(body));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof p.exp === "number" && p.exp < Date.now() / 1000) return null;
    return p as T;
  } catch { return null; }
}

export const appBaseUrl = () => (process.env.APP_BASE_URL || "").replace(/\/+$/, "");
export const secureCookies = () => appBaseUrl().startsWith("https://");

/** Cookie attributes shared by the session and the short-lived OIDC state cookie. */
export const cookieOptions = (maxAge: number) => ({ httpOnly: true, sameSite: "Lax" as const, path: "/", secure: secureCookies(), maxAge });
