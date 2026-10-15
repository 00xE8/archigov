import { createHash } from "node:crypto";
import { db, uid, nowIso, j, audit } from "./db.js";

/** A normalised cloud resource, independent of provider. */
export interface NormalisedResource {
  sourceRef: string;          // provider resource id
  name: string;
  type: string;               // provider type e.g. Microsoft.Web/sites
  location?: string;
  resourceGroup?: string;
  subscription?: string;
  tags: Record<string, string>;
  props: Record<string, unknown>; // selected properties relevant to standards
  dependsOn?: string[];       // sourceRefs this resource depends on
}

export const hashOf = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);

/** What a human verifies when they verify a standard: the statement, the rule and the control mapping. */
export const standardHash = (s: { title: string; category: string; statement: string; rationale?: string | null; status: string; severity: string; rule_json?: string | null; control_refs_json?: string }) =>
  hashOf({ title: s.title, category: s.category, statement: s.statement, rationale: s.rationale ?? null, status: s.status, severity: s.severity, rule: s.rule_json ?? null, control_refs: s.control_refs_json ?? "[]" });

/** What a human verifies when they verify a relation: the two ends, the kind and the evidence for it. */
export const relationHash = (r: { from_id: string; to_id: string; type: string; provenance_json?: string | null }) =>
  hashOf({ from: r.from_id, to: r.to_id, type: r.type, provenance: r.provenance_json ?? "{}" });

export interface Element {
  id: string; type: string; subtype: string | null; name: string;
  props: any; tags: Record<string, string>; source_id: string | null; source_ref: string | null;
  provenance: any; origin: string; confidence: number; verification: string;
  verified_by: string | null; verified_at: string | null; verified_hash: string | null; content_hash: string | null;
  created_at: string; updated_at: string;
}

export function rowToElement(r: any): Element {
  return { ...r, props: j(r.props_json, {}), tags: j(r.tags_json, {}), provenance: j(r.provenance_json, {}) };
}

export function listElements(type?: string): Element[] {
  const rows = type
    ? db.prepare("SELECT * FROM elements WHERE deleted_at IS NULL AND type = ? ORDER BY name").all(type)
    : db.prepare("SELECT * FROM elements WHERE deleted_at IS NULL ORDER BY type, name").all();
  return rows.map(rowToElement);
}

export function getElement(id: string): Element | null {
  const r = db.prepare("SELECT * FROM elements WHERE id = ?").get(id);
  return r ? rowToElement(r) : null;
}

export function applicationOf(elementId: string): Element | null {
  const r = db.prepare(`SELECT e.* FROM relations rel JOIN elements e ON e.id = rel.to_id
    WHERE rel.from_id = ? AND rel.type = 'belongs_to' AND rel.deleted_at IS NULL AND e.deleted_at IS NULL LIMIT 1`).get(elementId);
  return r ? rowToElement(r) : null;
}

export function resourcesOf(applicationId: string): Element[] {
  return db.prepare(`SELECT e.* FROM relations rel JOIN elements e ON e.id = rel.from_id
    WHERE rel.to_id = ? AND rel.type = 'belongs_to' AND rel.deleted_at IS NULL AND e.deleted_at IS NULL ORDER BY e.type, e.name`)
    .all(applicationId).map(rowToElement);
}

/** Resource groups that hold platform plumbing rather than an application. Only consulted when no app tag says otherwise. */
const SHARED_RG_TOKENS = new Set(["hub", "network", "networking", "connectivity", "shared", "platform", "management", "mgmt", "identity", "dns"]);
const ENV_TOKENS = new Set(["dev", "test", "uat", "prod", "prd", "stg", "staging"]);

/**
 * Decide which application (or shared service) a resource belongs to. Deterministic rules first; the result
 * carries provenance so a reviewer can see why. Returns null if nothing can be inferred.
 * Tags win over resource-group conventions; a resource group whose name says hub/network/shared/platform/…
 * becomes a shared service, not an application, so hub networks never show up as workloads.
 */
function inferApplication(r: NormalisedResource): { name: string; method: string; confidence: number; kind: "application" | "shared_service" } | null {
  const tagKeys = ["app", "application", "service", "workload", "system"];
  for (const k of tagKeys) {
    const v = Object.entries(r.tags).find(([tk]) => tk.toLowerCase() === k)?.[1];
    if (v && v.trim()) return { name: v.trim(), method: `tag:${k}`, confidence: 0.92, kind: "application" };
  }
  if (r.resourceGroup) {
    const rg = r.resourceGroup;
    const tokens = rg.toLowerCase().split(/[-_]+/).filter((t) => t && t !== "rg" && !ENV_TOKENS.has(t));
    if (tokens.some((t) => SHARED_RG_TOKENS.has(t))) return { name: tokens.join("-"), method: "resource-group-shared", confidence: 0.75, kind: "shared_service" };
    // rg-<app>-<env>-<region> or <app>-rg conventions
    const m = rg.match(/^rg-([a-z0-9]+(?:-[a-z0-9]+)*?)(?:-(dev|test|uat|prod|prd|stg|staging))?(?:-[a-z]+)?$/i);
    if (m) return { name: m[1], method: "resource-group-convention", confidence: 0.7, kind: "application" };
    return { name: rg.replace(/^rg[-_]/i, "").replace(/[-_]rg$/i, ""), method: "resource-group", confidence: 0.55, kind: "application" };
  }
  return null;
}

const ACRONYMS = new Set(["api", "erp", "crm", "hr", "ai", "epr", "sso", "dr", "etl", "bi"]);
const titleCase = (s: string) => s.replace(/[-_]+/g, " ").split(" ").map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))).join(" ");

/** Upsert a batch of resources from one source. Preserves human verification unless content changed. */
export function ingestResources(sourceId: string, resources: NormalisedResource[], actor = "system") {
  const now = nowIso();
  const stats = { created: 0, updated: 0, unchanged: 0, removed: 0, reverified_needed: 0, applications: 0, shared_services: 0, kept_verified_links: 0 };
  const seen = new Set<string>();
  const groupIds = new Map<string, string>();

  const findBySourceRef = db.prepare("SELECT * FROM elements WHERE source_ref = ? AND deleted_at IS NULL");
  const insert = db.prepare(`INSERT INTO elements(id,type,subtype,name,props_json,tags_json,source_id,source_ref,provenance_json,origin,confidence,verification,content_hash,created_at,updated_at)
    VALUES (@id,@type,@subtype,@name,@props_json,@tags_json,@source_id,@source_ref,@provenance_json,@origin,@confidence,'unverified',@content_hash,@created_at,@updated_at)`);
  // content changed: when a verified element's content no longer matches what was verified, it drops to unverified
  // and the stale verifier is cleared, so nobody is shown as standing behind something they never saw.
  const update = db.prepare(`UPDATE elements SET name=@name, subtype=@subtype, props_json=@props_json, tags_json=@tags_json, provenance_json=@provenance_json,
    content_hash=@content_hash, updated_at=@updated_at,
    verification = CASE WHEN @drop = 1 THEN 'unverified' ELSE verification END,
    verified_by  = CASE WHEN @drop = 1 THEN NULL ELSE verified_by END,
    verified_at  = CASE WHEN @drop = 1 THEN NULL ELSE verified_at END
    WHERE id=@id`);

  /** Find or create the application / shared service a resource is grouped under. */
  const ensureGroup = (kind: "application" | "shared_service", name: string, method: string, confidence: number, evidenceRef: string): string => {
    const key = name.toLowerCase().replace(/\s+/g, "-");
    const refKey = `${kind === "application" ? "app" : "shared"}:${key}`;
    if (groupIds.has(refKey)) return groupIds.get(refKey)!;
    // match on the stable source key first (humans may rename the application), then on a normalised name
    const existing = (db.prepare("SELECT * FROM elements WHERE type=? AND source_ref=? AND deleted_at IS NULL").get(kind, refKey)
      || db.prepare("SELECT * FROM elements WHERE type=? AND replace(lower(name),' ','-')=? AND deleted_at IS NULL").get(kind, key)) as any;
    if (existing) {
      const prov = j(existing.provenance_json, {});
      prov.methods = Array.from(new Set([...(prov.methods || []), method]));
      prov.members = (prov.members || 0);
      db.prepare("UPDATE elements SET provenance_json=? WHERE id=?").run(JSON.stringify(prov), existing.id);
      groupIds.set(refKey, existing.id);
      return existing.id;
    }
    const id = uid();
    insert.run({
      id, type: kind, subtype: null, name: titleCase(name), props_json: "{}", tags_json: "{}",
      source_id: sourceId, source_ref: refKey,
      provenance_json: JSON.stringify({ inferred: true, methods: [method], firstEvidence: evidenceRef }),
      origin: "inferred", confidence, content_hash: null, created_at: now, updated_at: now,
    });
    if (kind === "application") stats.applications++; else stats.shared_services++;
    groupIds.set(refKey, id);
    return id;
  };

  // Relations carry a content hash too: if the evidence for an inferred link changes after a human verified it,
  // the verification drops exactly like it does for elements.
  const linkBelongsTo = db.prepare(`INSERT INTO relations(id,from_id,to_id,type,provenance_json,confidence,origin,content_hash,created_at)
    VALUES (@id,@from_id,@to_id,'belongs_to',@provenance_json,@confidence,'inferred',@content_hash,@created_at)
    ON CONFLICT(from_id,to_id,type) DO UPDATE SET deleted_at=NULL, provenance_json=excluded.provenance_json, content_hash=excluded.content_hash,
      verification = CASE WHEN relations.verification='verified' AND relations.verified_hash IS NOT excluded.content_hash THEN 'unverified' ELSE relations.verification END,
      verified_by  = CASE WHEN relations.verification='verified' AND relations.verified_hash IS NOT excluded.content_hash THEN NULL ELSE relations.verified_by END,
      verified_at  = CASE WHEN relations.verification='verified' AND relations.verified_hash IS NOT excluded.content_hash THEN NULL ELSE relations.verified_at END`);
  const linkDepends = db.prepare(`INSERT INTO relations(id,from_id,to_id,type,provenance_json,confidence,origin,content_hash,created_at)
    VALUES (@id,@from_id,@to_id,'depends_on',@provenance_json,@confidence,'derived',@content_hash,@created_at) ON CONFLICT(from_id,to_id,type) DO UPDATE SET deleted_at=NULL`);
  // a link a human created, or a human verified, is theirs: the collector never re-points it
  const protectedLink = db.prepare("SELECT id, to_id FROM relations WHERE from_id=? AND type='belongs_to' AND (origin='human' OR verification='verified') AND deleted_at IS NULL");

  const refToId = new Map<string, string>();

  db.transaction(() => {
    for (const r of resources) {
      seen.add(r.sourceRef);
      const content = { name: r.name, type: r.type, location: r.location, rg: r.resourceGroup, tags: r.tags, props: r.props };
      const hash = hashOf(content);
      const props = { ...r.props, location: r.location, resourceGroup: r.resourceGroup, subscription: r.subscription };
      const provenance = { source: sourceId, collectedAt: now, method: "collector", sourceRef: r.sourceRef };
      const existing = findBySourceRef.get(r.sourceRef) as any;
      let id: string;
      if (existing) {
        id = existing.id;
        if (existing.content_hash === hash) {
          stats.unchanged++;
        } else {
          const drop = existing.verification === "verified" && existing.verified_hash !== hash ? 1 : 0;
          if (drop) stats.reverified_needed++;
          update.run({ id, name: r.name, subtype: r.type, props_json: JSON.stringify(props), tags_json: JSON.stringify(r.tags),
            provenance_json: JSON.stringify({ ...j(existing.provenance_json, {}), ...provenance }), content_hash: hash, updated_at: now, drop });
          stats.updated++;
        }
      } else {
        id = uid();
        insert.run({ id, type: "resource", subtype: r.type, name: r.name, props_json: JSON.stringify(props), tags_json: JSON.stringify(r.tags),
          source_id: sourceId, source_ref: r.sourceRef, provenance_json: JSON.stringify(provenance), origin: "derived", confidence: 1,
          content_hash: hash, created_at: now, updated_at: now });
        stats.created++;
      }
      refToId.set(r.sourceRef, id);

      const inf = inferApplication(r);
      if (inf) {
        const groupId = ensureGroup(inf.kind, inf.name, inf.method, inf.confidence, r.sourceRef);
        const kept = protectedLink.get(id) as any;
        if (kept) {
          if (kept.to_id !== groupId) stats.kept_verified_links++;
        } else {
          db.prepare("UPDATE relations SET deleted_at=? WHERE from_id=? AND type='belongs_to' AND to_id<>? AND deleted_at IS NULL").run(now, id, groupId);
          const provenance_json = JSON.stringify({ method: inf.method, evidence: inf.method.startsWith("tag") ? r.tags : r.resourceGroup });
          linkBelongsTo.run({ id: uid(), from_id: id, to_id: groupId, provenance_json, confidence: inf.confidence,
            content_hash: relationHash({ from_id: id, to_id: groupId, type: "belongs_to", provenance_json }), created_at: now });
        }
      }
    }
    for (const r of resources) {
      for (const dep of r.dependsOn || []) {
        const a = refToId.get(r.sourceRef), b = refToId.get(dep);
        if (!a || !b) continue;
        const provenance_json = JSON.stringify({ method: "provider-reference" });
        linkDepends.run({ id: uid(), from_id: a, to_id: b, provenance_json, confidence: 1, content_hash: relationHash({ from_id: a, to_id: b, type: "depends_on", provenance_json }), created_at: now });
      }
    }
    // soft-delete resources no longer present in this source
    const stale = db.prepare("SELECT id, source_ref FROM elements WHERE source_id=? AND type='resource' AND deleted_at IS NULL").all(sourceId) as any[];
    for (const s of stale) if (!seen.has(s.source_ref)) { db.prepare("UPDATE elements SET deleted_at=? WHERE id=?").run(now, s.id); stats.removed++; }
    // refresh member counts on applications and shared services
    for (const group of [...listElements("application"), ...listElements("shared_service")]) {
      const n = (db.prepare("SELECT count(*) c FROM relations WHERE to_id=? AND type='belongs_to' AND deleted_at IS NULL").get(group.id) as any).c;
      const prov = { ...group.provenance, members: n };
      db.prepare("UPDATE elements SET provenance_json=? WHERE id=?").run(JSON.stringify(prov), group.id);
    }
  })();
  audit(actor, "ingest", "source", sourceId, stats);
  return stats;
}

export function setVerification(table: "elements" | "relations" | "decisions" | "review_events" | "standards", id: string, verified: boolean, actor: string) {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id) as any;
  if (!row) throw new Error("not found");
  const now = nowIso();
  const hashed = table === "elements" || table === "relations" || table === "standards";
  if (verified) {
    db.prepare(`UPDATE ${table} SET verification='verified', verified_by=?, verified_at=?${hashed ? ", verified_hash=content_hash" : ""} WHERE id=?`).run(actor, now, id);
  } else {
    db.prepare(`UPDATE ${table} SET verification='unverified', verified_by=NULL, verified_at=NULL WHERE id=?`).run(id);
  }
  audit(actor, verified ? "verify" : "unverify", table, id);
}

/**
 * One-off after the v2 migration: give pre-existing relations and standards a content hash. A row that was
 * verified before hashes existed is treated as verified against its current content; a standard marked
 * verified with nobody behind it was already reset by the migration.
 */
export function backfillHashes() {
  db.transaction(() => {
    for (const r of db.prepare("SELECT * FROM relations WHERE content_hash IS NULL").all() as any[]) {
      const h = relationHash(r);
      db.prepare("UPDATE relations SET content_hash=?, verified_hash=CASE WHEN verification='verified' THEN ? ELSE verified_hash END WHERE id=?").run(h, h, r.id);
    }
    for (const s of db.prepare("SELECT * FROM standards WHERE content_hash IS NULL").all() as any[]) {
      const h = standardHash(s);
      db.prepare("UPDATE standards SET content_hash=?, verified_hash=CASE WHEN verification='verified' THEN ? ELSE verified_hash END WHERE id=?").run(h, h, s.id);
    }
  })();
}

/** How much of the model a human stands behind — for the whole tenant, or scoped to one application's elements. */
export function verificationCoverage(appId?: string) {
  const q = (sql: string, ...params: any[]) => db.prepare(sql).get(...params) as any;
  // `v` names the verification column when the FROM clause joins two tables that both carry one
  const cov = (from: string, where: string, v: string, ...params: any[]) =>
    q(`SELECT coalesce(sum(case when ${v}='verified' then 1 else 0 end), 0) verified, count(*) total FROM ${from} WHERE ${where}`, ...params);
  if (!appId) return {
    applications: cov("elements", "type='application' AND deleted_at IS NULL", "verification"),
    resources: cov("elements", "type='resource' AND deleted_at IS NULL", "verification"),
    relations: cov("relations", "deleted_at IS NULL", "verification"),
    decisions: cov("decisions", "1=1", "verification"),
    ai_outputs: cov("review_events", "origin='ai'", "verification"),
  };
  return {
    applications: cov("elements", "id=? AND deleted_at IS NULL", "verification", appId),
    resources: cov("elements e JOIN relations rel ON rel.from_id=e.id AND rel.type='belongs_to' AND rel.deleted_at IS NULL", "rel.to_id=? AND e.deleted_at IS NULL", "e.verification", appId),
    relations: cov("relations", "to_id=? AND type='belongs_to' AND deleted_at IS NULL", "verification", appId),
    decisions: cov("decisions", "(application_ids_json LIKE ? OR application_ids_json='[]')", "verification", `%${appId}%`),
    ai_outputs: cov("review_events ev JOIN reviews r ON r.id=ev.review_id", "r.application_id=? AND ev.origin='ai'", "ev.verification", appId),
  };
}
