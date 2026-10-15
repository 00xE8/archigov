import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./db.js";

/**
 * Secrets at rest. Values stored in the settings table (today: AI provider API keys) are encrypted with
 * AES-256-GCM under a master key that never enters the database — so DB backups (`db.backup`) and Litestream
 * replicas carry only ciphertext. The master key is, in order:
 *   1. ARCHIGOV_SECRET_KEY on the container (any string; hashed to 256 bits) — the production path, so the key
 *      lives in the operator's secret store (Docker/K8s secrets, Cloudflare secrets), not on disk; or
 *   2. DATA_DIR/keys/secret.key, generated on first use (0600, inside the 0700 keys dir beside the evidence
 *      signing key) — the zero-config path; backups and replicas never include the keys directory.
 * Rotating the master key invalidates stored ciphertexts: decryption then yields null, the provider shows as
 * having no key, and the admin re-enters it. Stored secrets are never logged, returned or exported either way.
 */
const KEY_FILE = path.join(DATA_DIR, "keys", "secret.key");
const PREFIX = "enc:v1:";
let cached: Buffer | null = null;

function masterKey(): Buffer {
  if (cached) return cached;
  const env = process.env.ARCHIGOV_SECRET_KEY;
  if (env && env.trim()) { cached = crypto.createHash("sha256").update(env.trim()).digest(); return cached; }
  if (!fs.existsSync(KEY_FILE)) fs.writeFileSync(KEY_FILE, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  cached = crypto.createHash("sha256").update(fs.readFileSync(KEY_FILE, "utf8").trim()).digest();
  return cached;
}

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", masterKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `${PREFIX}${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${ct.toString("base64")}`;
}

export const isEncrypted = (v: unknown): boolean => typeof v === "string" && v.startsWith(PREFIX);

/** Plaintext for a stored value: legacy plaintext passes through; undecryptable ciphertext (rotated master key) yields null. */
export function decryptSecret(stored: string): string | null {
  if (!isEncrypted(stored)) return stored;
  try {
    const [iv, tag, ct] = stored.slice(PREFIX.length).split(":");
    const decipher = crypto.createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
  } catch { return null; }
}
