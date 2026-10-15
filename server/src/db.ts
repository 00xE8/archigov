import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { loadMigrations } from "./migrations/index.js";
import { currentRole } from "./auth/context.js";

export const DATA_DIR = process.env.DATA_DIR || path.resolve(process.cwd(), "../data");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, "blobs"), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, "backups"), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, "evidence-packs"), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, "keys"), { recursive: true, mode: 0o700 });

const DB_PATH = path.join(DATA_DIR, "app.db");

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("foreign_keys = ON");

export const nowIso = () => new Date().toISOString();
export const uid = () => randomUUID();

/** Apply every migration file under ./migrations (see migrations/index.ts) that is not yet recorded. */
export async function migrate() {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const applied = new Set(db.prepare("SELECT version FROM schema_migrations").all().map((r: any) => r.version));
  for (const m of await loadMigrations()) {
    if (applied.has(m.version)) continue;
    if (applied.size > 0) backupBeforeMigration(m.version);
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(m.version, nowIso());
    })();
  }
}

function backupBeforeMigration(version: number) {
  const dest = path.join(DATA_DIR, "backups", `pre-migration-v${version}-${Date.now()}.db`);
  db.backup(dest).catch(() => {});
}

export function backupNow(): string {
  const dest = path.join(DATA_DIR, "backups", `backup-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
  db.backup(dest);
  return dest;
}

/**
 * Canonical JSON: keys sorted at every level, so the same content always hashes the same. Follows JSON's own
 * semantics for `undefined` (dropped from objects, null in arrays) so that a value and its JSON round-trip
 * canonicalise identically — hashes are computed in memory but verified from stored JSON.
 */
export const canonical = (v: any): string => Array.isArray(v) ? `[${v.map((x) => canonical(x === undefined ? null : x)).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`
  : JSON.stringify(v === undefined ? null : v);

/** The fields of an audit row that are chained; `details` is the parsed JSON so insert and verify see the same value. */
const chainBody = (r: { at: string; actor: string; role: string | null; action: string; entity: string; entity_id: string | null; details: unknown }) =>
  ({ at: r.at, actor: r.actor, role: r.role ?? null, action: r.action, entity: r.entity, entity_id: r.entity_id ?? null, details: r.details ?? {} });
export const chainHash = (prev: string, row: Parameters<typeof chainBody>[0]) => createHash("sha256").update(prev + canonical(chainBody(row))).digest("hex");

/**
 * Append-only, tamper-evident: every row carries the hash of the previous row and of itself, in insertion
 * (rowid) order. The role comes from the request's principal (auth/context) so callers keep passing just the
 * actor. SQLite has one writer, and the read-then-insert runs in a transaction, so the chain cannot fork.
 */
export function audit(actor: string, action: string, entity: string, entityId: string | null, data: unknown = {}) {
  const details = JSON.parse(JSON.stringify(data ?? {}));
  const row = { at: nowIso(), actor, role: currentRole(), action, entity, entity_id: entityId, details };
  db.transaction(() => {
    const prev = ((db.prepare("SELECT hash FROM audit_log ORDER BY rowid DESC LIMIT 1").get() as any)?.hash as string | null) || "";
    db.prepare("INSERT INTO audit_log(id, at, actor, role, action, entity, entity_id, data_json, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(uid(), row.at, actor, row.role, action, entity, entityId, JSON.stringify(details), prev, chainHash(prev, row));
  })();
}

const chainRows = (where = "") => db.prepare(`SELECT rowid, id, at, actor, role, action, entity, entity_id, data_json, prev_hash, hash FROM audit_log ${where} ORDER BY rowid`).all() as any[];
const rowBody = (r: any) => ({ at: r.at, actor: r.actor, role: r.role ?? null, action: r.action, entity: r.entity, entity_id: r.entity_id, details: j(r.data_json, {}) });

/** Rows written before v5 have no hash: chain them once, in order. Idempotent — a complete chain is left alone. */
export function backfillAuditChain(): number {
  const missing = (db.prepare("SELECT count(*) c FROM audit_log WHERE hash IS NULL").get() as any).c as number;
  if (!missing) return 0;
  const upd = db.prepare("UPDATE audit_log SET prev_hash=?, hash=? WHERE rowid=?");
  db.transaction(() => {
    let prev = "";
    for (const r of chainRows()) { const h = chainHash(prev, rowBody(r)); upd.run(prev, h, r.rowid); prev = h; }
  })();
  return missing;
}

/** Recompute the whole chain. `broken_at` is the id of the first row whose stored hash or link does not match. */
export function verifyAuditChain(upTo?: string | null): { ok: boolean; rows: number; broken_at: string | null; head: string | null; reached: boolean } {
  let prev = "", head: string | null = null, rows = 0, reached = !upTo;
  for (const r of chainRows()) {
    rows++;
    if ((r.prev_hash || "") !== prev || r.hash !== chainHash(prev, rowBody(r))) return { ok: false, rows, broken_at: r.id, head, reached };
    prev = head = r.hash;
    if (upTo && r.hash === upTo) { reached = true; break; }
  }
  return { ok: reached, rows, broken_at: null, head, reached };
}

export function getSetting(key: string, fallback: string | null = null): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as any;
  return row ? row.value : fallback;
}
export function setSetting(key: string, value: string) {
  db.prepare("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export const j = (s: string | null | undefined, fallback: any = null) => {
  if (s == null) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
};
