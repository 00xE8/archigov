import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { db, j, DATA_DIR, nowIso, getSetting, canonical, verifyAuditChain } from "./db.js";
import { listElements, resourcesOf, verificationCoverage } from "./model.js";
import { evidenceFor } from "./evidence.js";
import { std, dec, fnd, DECISIONS_FOR_APP } from "./http.js";

/**
 * The evidence pack: what the derived model, the imported compliance evidence, the decision log and the review
 * workflow contained at generation time, each item with its verification state. Three properties make it
 * handable to an auditor months later:
 *   hash       SHA-256 over the canonical JSON of the content — identifies this exact pack
 *   signature  Ed25519 over the canonical JSON of everything but the signature fields, with a key generated once
 *              per instance under DATA_DIR/keys (the public key travels inside the pack)
 *   chain_head the hash of the latest audit row when the pack was generated — ties the pack to a point in the
 *              tamper-evident audit chain, which /evidence-pack/verify re-walks
 * Nothing in it asserts compliance; see `disclaimer`.
 */
const KEY_FILE = path.join(DATA_DIR, "keys", "evidence-signing.key");
const PUB_FILE = path.join(DATA_DIR, "keys", "evidence-signing.pub");
const PACKS_DIR = path.join(DATA_DIR, "evidence-packs");

let keys: { priv: KeyObject; pubPem: string } | null = null;
/** Create the instance signing key pair on first use (0600 private, 0644 public); idempotent. */
export function ensureSigningKeys(): { pubPem: string; created: boolean } {
  let created = false;
  if (!fs.existsSync(KEY_FILE) || !fs.existsSync(PUB_FILE)) {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    fs.writeFileSync(KEY_FILE, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    fs.writeFileSync(PUB_FILE, publicKey.export({ type: "spki", format: "pem" }), { mode: 0o644 });
    keys = null; created = true;
  }
  return { pubPem: signingKeys().pubPem, created };
}
function signingKeys() {
  if (!keys) {
    if (!fs.existsSync(KEY_FILE)) ensureSigningKeys();
    keys = { priv: createPrivateKey(fs.readFileSync(KEY_FILE)), pubPem: fs.readFileSync(PUB_FILE, "utf8") };
  }
  return keys;
}

const SIGNATURE_FIELDS = ["signature", "public_key"];
const META_FIELDS = ["hash", "signed_at", "chain_head", "chain_rows", ...SIGNATURE_FIELDS];
const strip = (o: Record<string, any>, drop: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !drop.includes(k)));
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
// Hash and sign the pack as JSON represents it (no `undefined`, no Dates), so the bytes computed from the in-memory
// object at generation and from the persisted file at verification are identical. audit() does the same.
const asJson = (o: Record<string, any>): Record<string, any> => JSON.parse(JSON.stringify(o));
export const contentHash = (pack: Record<string, any>) => sha256(canonical(strip(asJson(pack), META_FIELDS)));
const signedBytes = (pack: Record<string, any>) => Buffer.from(canonical(strip(asJson(pack), SIGNATURE_FIELDS)));

const auditRowsFor = (ids: string[]) => {
  const out: any[] = [];
  for (let i = 0; i < ids.length; i += 500) { const chunk = ids.slice(i, i + 500); out.push(...db.prepare(`SELECT at, actor, role, action, entity, entity_id, hash FROM audit_log WHERE entity_id IN (${chunk.map(() => "?").join(",")})`).all(...chunk)); }
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
};
/** Board sessions: tenant-wide, or — per application — only those that declared one of its reviews. Minutes travel by hash (they are in the audit chain). */
const sessionsFor = (appId: string | null) => {
  const chairOf = db.prepare("SELECT user_id FROM board_members WHERE board_id=? AND board_role='chair' ORDER BY added_at LIMIT 1");
  return (db.prepare("SELECT s.*, b.code board_code FROM board_sessions s JOIN boards b ON b.id=s.board_id ORDER BY s.scheduled_at DESC").all() as any[]).map((s) => {
    const items = db.prepare("SELECT i.state, i.outcome, r.code, r.areas_json, r.application_id FROM session_items i JOIN reviews r ON r.id=i.review_id WHERE i.session_id=? ORDER BY i.position").all(s.id) as any[];
    if (appId && !items.some((i) => i.application_id === appId && i.state === "declared")) return null;
    return { id: s.id, code: s.code, board: s.board_code, title: s.title, scheduled_at: s.scheduled_at, status: s.status, chair: (chairOf.get(s.board_id) as any)?.user_id ?? null,
      attendance_count: (db.prepare("SELECT count(*) c FROM session_attendance WHERE session_id=? AND status='present'").get(s.id) as any).c,
      delegations: (db.prepare("SELECT count(*) c FROM session_delegations WHERE session_id=? AND revoked_at IS NULL").get(s.id) as any).c,
      items: items.map((i) => ({ code: i.code, outcome: i.outcome ?? null, state: i.state, areas: j(i.areas_json, []) || [] })), minutes_hash: s.minutes_hash ?? null, closed_at: s.closed_at ?? null };
  }).filter(Boolean) as any[];
};
const dependsOn = (decisionId: string) => (db.prepare("SELECT d.code FROM decision_links l JOIN decisions d ON d.id=l.to_id WHERE l.from_id=? AND l.kind='depends_on' ORDER BY d.code").all(decisionId) as any[]).map((d) => d.code);
const dependents = (decisionId: string) => (db.prepare("SELECT r.code, x.resolved_state FROM review_dependencies x JOIN reviews r ON r.id=x.review_id WHERE x.decision_id=? ORDER BY r.code").all(decisionId) as any[]).map((r) => ({ review: r.code, resolved_state: r.resolved_state ?? null }));

/** Assemble the pack content for the tenant or one application. Returns null when the application does not exist. */
export function buildEvidencePack(appId: string | null): Record<string, any> | null {
  const apps = listElements("application").filter((a) => !appId || a.id === appId);
  if (appId && apps.length === 0) return null;
  const standards = db.prepare("SELECT * FROM standards ORDER BY code").all().map(std);
  const scopeIds: string[] = [];
  const pack: Record<string, any> = {
    generated_at: nowIso(), tenant: getSetting("tenant.name"), scope: appId ? "application" : "tenant",
    disclaimer: "Evidence, not assurance. This pack records what the derived model, the imported compliance evidence, the decision log and the review workflow contained at generation time, with each item's verification state. Compliance conclusions are for the accountable humans and auditors.",
    verification: verificationCoverage(appId || undefined),
    applications: apps.map((a) => {
      const resources = resourcesOf(a.id);
      const decisions = db.prepare(`SELECT * FROM decisions WHERE ${DECISIONS_FOR_APP} ORDER BY code`).all(`%${a.id}%`).map(dec);
      const reviews = db.prepare("SELECT * FROM reviews WHERE application_id=? ORDER BY code").all(a.id) as any[];
      const findings = db.prepare("SELECT f.*, s.code standard_code FROM findings f JOIN standards s ON s.id=f.standard_id WHERE f.application_id=? AND f.status<>'resolved'").all(a.id).map(fnd);
      const exceptions = db.prepare("SELECT e.*, s.code standard_code FROM exceptions e JOIN standards s ON s.id=e.standard_id WHERE e.application_id=?").all(a.id) as any[];
      const workItems = db.prepare("SELECT id FROM work_items WHERE application_id=?").all(a.id) as any[];
      const conditions = reviews.flatMap((r) => db.prepare("SELECT * FROM conditions WHERE review_id=?").all(r.id) as any[]);
      const events = reviews.flatMap((r) => db.prepare("SELECT id FROM review_events WHERE review_id=?").all(r.id) as any[]);
      scopeIds.push(a.id, ...resources.map((r) => r.id), ...decisions.map((d: any) => d.id), ...reviews.map((r) => r.id), ...conditions.map((x) => x.id), ...events.map((x) => x.id), ...findings.map((f: any) => f.id), ...exceptions.map((x) => x.id), ...workItems.map((x) => x.id));
      return {
        id: a.id, name: a.name, verification: a.verification, verified_by: a.verified_by, verified_at: a.verified_at, provenance: a.provenance,
        resources: resources.map((r) => ({ ref: r.source_ref, name: r.name, type: r.subtype, location: r.props.location, verification: r.verification, verified_by: r.verified_by, content_hash: r.content_hash,
          evidence: evidenceFor(r.id).map((e) => ({ source: e.source, control: e.control, state: e.state, severity: e.severity, observed_at: e.observed_at })) })),
        decisions: decisions.map((d: any) => ({ code: d.code, title: d.title, status: d.status, decided_at: d.decided_at, author: d.author, verification: d.verification, verified_by: d.verified_by, constraint: d.constraint, depends_on: dependsOn(d.id), dependents: dependents(d.id) })),
        reviews: reviews.map((r) => ({ code: r.code, title: r.title, risk_tier: r.risk_tier, stage: r.stage, decided_at: r.decided_at, areas: j(r.areas_json, []) || [], session: r.session_id ? ((db.prepare("SELECT code FROM board_sessions WHERE id=?").get(r.session_id) as any)?.code ?? null) : null,
          approvals: db.prepare("SELECT actor, kind, body_md, created_at, origin, verification FROM review_events WHERE review_id=? AND kind IN ('approve','reject','consent_declared','became_effective')").all(r.id),
          positions: db.prepare("SELECT area, position, user_id, on_behalf_of, text, at, resolution, resolution_text, resolved_by FROM review_positions WHERE review_id=? AND superseded=0 ORDER BY at").all(r.id),
          // the due diligence conducted for the submission: who asked, who recorded the result, and the result itself
          assessments: db.prepare("SELECT type, title, area, requested_by, assigned_to, due_at, status, result, result_md, reference, completed_by, completed_at, waived_by, waived_reason, stale FROM review_assessments WHERE review_id=? ORDER BY created_at").all(r.id),
          conditions: conditions.filter((x) => x.review_id === r.id).map((x) => ({ text: x.text, owner: x.owner, due_at: x.due_at, status: x.status, closed_at: x.closed_at, area: x.area ?? null })) })),
        findings: findings.map((f: any) => ({ standard: f.standard_code, severity: f.severity, status: f.status, message: f.message, evidence: f.evidence, first_seen: f.first_seen, last_seen: f.last_seen })),
        exceptions,
      };
    }),
    controls: standards.map((s: any) => ({ code: s.code, title: s.title, kind: s.kind || "standard", lifecycle: s.lifecycle || "adopted", version: s.version ?? 1, board_id: s.board_id ?? null, enforcement: s.enforcement ?? null,
      status: s.status, control_refs: s.control_refs, checkable: !!s.rule, imported_evidence: s.rule?.assert?.op === "evidence",
      verification: s.verification, verified_by: s.verified_by,
      open_findings: (db.prepare(`SELECT count(*) c FROM findings WHERE standard_id=? AND status='open'${appId ? " AND application_id=?" : ""}`).get(...(appId ? [s.id, appId] : [s.id])) as any).c })),
    sessions: [] as any[],
    audit_trail: [] as any[],
  };
  const sessions = sessionsFor(appId);
  pack.sessions = sessions.map(({ id, ...s }) => s);
  scopeIds.push(...sessions.map((s) => s.id));
  pack.audit_trail = appId ? auditRowsFor(Array.from(new Set(scopeIds))) : db.prepare("SELECT at, actor, role, action, entity, entity_id, hash FROM audit_log ORDER BY at DESC").all();
  return pack;
}

/** Hash, anchor to the audit chain, sign, persist under DATA_DIR/evidence-packs/<hash>.json. Mutates and returns the pack. */
export function signAndPersist(pack: Record<string, any>): Record<string, any> {
  const { priv, pubPem } = signingKeys();
  pack.hash = contentHash(pack);
  const head = db.prepare("SELECT hash FROM audit_log ORDER BY rowid DESC LIMIT 1").get() as any;
  pack.chain_head = head?.hash || null;
  pack.chain_rows = (db.prepare("SELECT count(*) c FROM audit_log").get() as any).c;
  pack.signed_at = nowIso();
  pack.public_key = pubPem;
  pack.signature = edSign(null, signedBytes(pack), priv).toString("base64");
  fs.writeFileSync(path.join(PACKS_DIR, `${pack.hash}.json`), JSON.stringify(pack, null, 2));
  return pack;
}

export interface PackVerification { found: boolean; hash_ok: boolean; signature_ok: boolean; key_is_current: boolean; chain_ok: boolean; chain_head: string | null; generated_at: string | null; scope?: string }
/** Re-open a persisted pack and check it the way an auditor would: content hash, signature with the embedded key, and the audit chain up to its anchor. */
export function verifyPack(hash: string): PackVerification {
  const none: PackVerification = { found: false, hash_ok: false, signature_ok: false, key_is_current: false, chain_ok: false, chain_head: null, generated_at: null };
  if (!/^[0-9a-f]{64}$/.test(hash)) return none;
  const file = path.join(PACKS_DIR, `${hash}.json`);
  if (!fs.existsSync(file)) return none;
  let blob: Record<string, any>;
  try { blob = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return none; }
  const hash_ok = blob.hash === hash && contentHash(blob) === hash;
  let signature_ok = false, key_is_current = false;
  if (typeof blob.signature === "string" && typeof blob.public_key === "string") {
    try { signature_ok = edVerify(null, signedBytes(blob), createPublicKey(blob.public_key), Buffer.from(blob.signature, "base64")); } catch { signature_ok = false; }
    key_is_current = blob.public_key === signingKeys().pubPem;
  }
  const chain_ok = typeof blob.chain_head === "string" ? verifyAuditChain(blob.chain_head).ok : false;
  return { found: true, hash_ok, signature_ok, key_is_current, chain_ok, chain_head: blob.chain_head ?? null, generated_at: blob.generated_at ?? null, scope: blob.scope };
}
