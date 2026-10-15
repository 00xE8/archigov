import { db, nowIso, j, audit } from "./db.js";
import { listElements, resourcesOf, hashOf, getElement, type Element } from "./model.js";

/**
 * Criticality classification: which applications support an important business service (PRA SS1/21, FCA SYSC
 * 15A), a critical or important function (DORA Art. 8) or an essential function (NCSC CAF A3), and how critical each
 * one is. Like application inference it is derived — from resource tags — with the method and the evidence kept,
 * so a person can confirm it (verification) or correct it (a human classification with a reason, which collection
 * never overwrites). Supporting a regulated service makes an application critical by definition.
 */
export const CRITICALITIES = ["critical", "important", "standard"] as const;
export type Criticality = (typeof CRITICALITIES)[number];
export const SERVICE_KINDS = ["ibs", "cif", "essential_function", "business_service"] as const;
export type ServiceKind = (typeof SERVICE_KINDS)[number];
/** The kinds a regulator names: an application supporting one is critical. */
export const REGULATED_KINDS: ServiceKind[] = ["ibs", "cif", "essential_function"];
export interface Service { name: string; kind: ServiceKind }

const RANK: Record<Criticality, number> = { critical: 3, important: 2, standard: 1 };
const CRIT_VALUES: Record<string, Criticality> = Object.fromEntries([
  ...["critical", "mission-critical", "tier0", "tier-0", "tier1", "tier-1", "t1", "1", "gold", "high"].map((v) => [v, "critical"]),
  ...["important", "business-important", "tier2", "tier-2", "t2", "2", "silver", "medium"].map((v) => [v, "important"]),
  ...["standard", "non-critical", "noncritical", "tier3", "tier-3", "t3", "3", "bronze", "low"].map((v) => [v, "standard"]),
]) as Record<string, Criticality>;
const CRIT_KEYS = new Set(["criticality", "business-criticality", "businesscriticality", "tier", "service-tier", "servicetier"]);
const SERVICE_KEYS: Record<string, ServiceKind> = {
  ibs: "ibs", "important-business-service": "ibs",
  cif: "cif", "critical-function": "cif", "dora-cif": "cif", "critical-or-important-function": "cif",
  "essential-function": "essential_function", "caf-essential-function": "essential_function",
  "business-service": "business_service", businessservice: "business_service",
};
const normKey = (k: string) => k.trim().toLowerCase().replace(/_/g, "-");
const serviceKey = (s: Service) => `${s.kind}|${s.name.trim().toLowerCase()}`;

export interface Derived { criticality: Criticality | null; services: Service[]; method: string | null; evidence: { resource: string; tag: string; value: string }[] }

/** What the tags on an application's resources say: the highest criticality any of them carries, and every named service. */
export function deriveClassification(resources: Element[]): Derived {
  let criticality: Criticality | null = null, method: string | null = null;
  const services = new Map<string, Service>();
  const evidence: Derived["evidence"] = [];
  for (const r of resources) {
    for (const [rawKey, rawValue] of Object.entries(r.tags || {})) {
      const key = normKey(rawKey), value = String(rawValue ?? "").trim();
      if (!value) continue;
      if (CRIT_KEYS.has(key)) {
        const c = CRIT_VALUES[value.toLowerCase()];
        if (!c) continue;
        evidence.push({ resource: r.name, tag: rawKey, value });
        if (!criticality || RANK[c] > RANK[criticality]) { criticality = c; method = `tag:${key}`; }
      } else if (SERVICE_KEYS[key]) {
        const kind = SERVICE_KEYS[key];
        for (const name of value.split(/[;,|]/).map((s) => s.trim()).filter((s) => s && !/^(true|yes|1)$/i.test(s))) {
          const s = { name: name.slice(0, 120), kind };
          if (!services.has(serviceKey(s))) { services.set(serviceKey(s), s); evidence.push({ resource: r.name, tag: rawKey, value: name }); }
        }
      }
    }
  }
  const list = [...services.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  // supporting a regulated service is what makes an application critical, whatever its tier tag says
  if (list.some((s) => REGULATED_KINDS.includes(s.kind)) && criticality !== "critical") { criticality = "critical"; method = "regulated-service"; }
  return { criticality, services: list, method, evidence };
}

const contentHash = (criticality: string | null, services: Service[]) => hashOf({ criticality, services: [...services].sort((a, b) => serviceKey(a).localeCompare(serviceKey(b))) });

export interface Classification {
  application_id: string; criticality: Criticality | null; services: Service[]; regulated: boolean;
  origin: "derived" | "human"; method: string | null; evidence: Derived["evidence"]; derived: Derived | null;
  reason: string | null; set_by: string | null; set_at: string | null;
  verification: string; verified_by: string | null; verified_at: string | null; updated_at: string;
}
const shape = (r: any): Classification => {
  const services: Service[] = j(r.services_json, []) || [];
  return { application_id: r.application_id, criticality: r.criticality ?? null, services, regulated: services.some((s) => REGULATED_KINDS.includes(s.kind)),
    origin: r.origin, method: r.method ?? null, evidence: j(r.evidence_json, []) || [], derived: j(r.derived_json, null),
    reason: r.reason ?? null, set_by: r.set_by ?? null, set_at: r.set_at ?? null,
    verification: r.verification, verified_by: r.verified_by ?? null, verified_at: r.verified_at ?? null, updated_at: r.updated_at };
};

/**
 * Bring every application's derived classification up to date with its resources' tags. A human classification is
 * kept as set (only the derived view beside it is refreshed); a derived one follows the tags, and if a person had
 * verified it, verification drops the moment the derived content changes.
 */
export function refreshClassifications(appIds?: string[]) {
  const apps = appIds ? appIds.map((id) => getElement(id)).filter((a): a is Element => !!a && a.type === "application") : listElements("application");
  const now = nowIso();
  const get = db.prepare("SELECT * FROM app_classifications WHERE application_id=?");
  db.transaction(() => {
    for (const app of apps) {
      const d = deriveClassification(resourcesOf(app.id));
      const hash = contentHash(d.criticality, d.services);
      const row = get.get(app.id) as any;
      if (!row) {
        db.prepare(`INSERT INTO app_classifications(application_id,criticality,services_json,origin,method,evidence_json,derived_json,content_hash,updated_at) VALUES (?,?,?,'derived',?,?,?,?,?)`)
          .run(app.id, d.criticality, JSON.stringify(d.services), d.method, JSON.stringify(d.evidence), JSON.stringify(d), hash, now);
      } else if (row.origin === "human") {
        db.prepare("UPDATE app_classifications SET derived_json=? WHERE application_id=?").run(JSON.stringify(d), app.id);
      } else if (row.content_hash !== hash || row.method !== d.method || row.evidence_json !== JSON.stringify(d.evidence)) {
        const drop = row.verification === "verified" && row.verified_hash !== hash;
        db.prepare(`UPDATE app_classifications SET criticality=?, services_json=?, method=?, evidence_json=?, derived_json=?, content_hash=?, updated_at=?,
            verification=CASE WHEN ? THEN 'unverified' ELSE verification END, verified_by=CASE WHEN ? THEN NULL ELSE verified_by END, verified_at=CASE WHEN ? THEN NULL ELSE verified_at END
          WHERE application_id=?`).run(d.criticality, JSON.stringify(d.services), d.method, JSON.stringify(d.evidence), JSON.stringify(d), hash, now, drop ? 1 : 0, drop ? 1 : 0, drop ? 1 : 0, app.id);
      }
    }
  })();
}

export function classificationOf(appId: string): Classification | null {
  let row = db.prepare("SELECT * FROM app_classifications WHERE application_id=?").get(appId) as any;
  if (!row) { refreshClassifications([appId]); row = db.prepare("SELECT * FROM app_classifications WHERE application_id=?").get(appId); }
  return row ? shape(row) : null;
}
/** Every application's classification, keyed by application id (derived on the fly for any not yet stored). */
export function allClassifications(): Map<string, Classification> {
  const rows = db.prepare("SELECT * FROM app_classifications").all() as any[];
  const missing = listElements("application").filter((a) => !rows.some((r) => r.application_id === a.id)).map((a) => a.id);
  if (missing.length) { refreshClassifications(missing); return allClassifications(); }
  return new Map(rows.map((r) => [r.application_id, shape(r)]));
}
/** The slice a rule sees as `app.*`: criticality, whether a regulated service depends on it, and the service names. */
export const classificationView = (c: Classification | null | undefined) => ({
  criticality: c?.criticality ?? null, regulated: !!c?.regulated, services: (c?.services || []).map((s) => s.name).join(", "),
  service_kinds: [...new Set((c?.services || []).map((s) => s.kind))].join(", "),
});

const err = (status: number, message: string) => Object.assign(new Error(message), { status });
export interface SetClassificationBody { criticality: string | null; services?: { name: string; kind: string }[]; reason: string }
/** A person classifies an application by hand: it becomes theirs (origin human, verified by them) and collection never overwrites it. */
export function setClassification(appId: string, b: SetClassificationBody, actor: string): Classification {
  const app = getElement(appId);
  if (!app || app.type !== "application") throw err(404, "not found");
  if (b.criticality !== null && !(CRITICALITIES as readonly string[]).includes(b.criticality)) throw err(400, `criticality must be one of ${CRITICALITIES.join(", ")}, or null for unclassified`);
  const reason = String(b.reason || "").trim();
  if (reason.length < 10) throw err(400, "a reason of at least 10 characters is required: say why this classification is right");
  const seen = new Set<string>();
  const services: Service[] = [];
  for (const s of b.services || []) {
    const name = String(s?.name || "").trim();
    if (!name) continue;
    if (name.length > 120) throw err(400, "a service name is at most 120 characters");
    if (!(SERVICE_KINDS as readonly string[]).includes(s.kind)) throw err(400, `service kind must be one of ${SERVICE_KINDS.join(", ")}`);
    const svc = { name, kind: s.kind as ServiceKind };
    if (!seen.has(serviceKey(svc))) { seen.add(serviceKey(svc)); services.push(svc); }
  }
  if (services.some((s) => REGULATED_KINDS.includes(s.kind)) && b.criticality !== "critical") throw err(400, "an application that supports an important business service, a critical or important function or an essential function is critical");
  const before = classificationOf(appId);
  const now = nowIso(), hash = contentHash(b.criticality, services);
  const derived = deriveClassification(resourcesOf(appId));
  db.prepare(`INSERT INTO app_classifications(application_id,criticality,services_json,origin,method,evidence_json,derived_json,reason,set_by,set_at,verification,verified_by,verified_at,content_hash,verified_hash,updated_at)
      VALUES (?,?,?,'human','human','[]',?,?,?,?,'verified',?,?,?,?,?)
    ON CONFLICT(application_id) DO UPDATE SET criticality=excluded.criticality, services_json=excluded.services_json, origin='human', method='human', evidence_json='[]', derived_json=excluded.derived_json,
      reason=excluded.reason, set_by=excluded.set_by, set_at=excluded.set_at, verification='verified', verified_by=excluded.verified_by, verified_at=excluded.verified_at,
      content_hash=excluded.content_hash, verified_hash=excluded.verified_hash, updated_at=excluded.updated_at`)
    .run(appId, b.criticality, JSON.stringify(services), JSON.stringify(derived), reason, actor, now, actor, now, hash, hash, now);
  audit(actor, "classification:set", "applications", appId, { from: { criticality: before?.criticality ?? null, services: before?.services ?? [], origin: before?.origin ?? null }, to: { criticality: b.criticality, services }, reason });
  return classificationOf(appId)!;
}
/** Hand the classification back to derivation (the tags decide again; nobody stands behind it until someone verifies). */
export function resetClassification(appId: string, actor: string): Classification {
  const before = classificationOf(appId);
  if (!before) throw err(404, "not found");
  if (before.origin !== "human") throw err(409, "the classification is already derived from tags");
  db.prepare("UPDATE app_classifications SET origin='derived', reason=NULL, set_by=NULL, set_at=NULL, verification='unverified', verified_by=NULL, verified_at=NULL, verified_hash=NULL, content_hash=NULL WHERE application_id=?").run(appId);
  refreshClassifications([appId]);
  const after = classificationOf(appId)!;
  audit(actor, "classification:reset", "applications", appId, { from: { criticality: before.criticality, services: before.services }, to: { criticality: after.criticality, services: after.services } });
  return after;
}
/** A person stands behind (or withdraws from) the classification as it is now; the hash makes a later change drop it. */
export function verifyClassification(appId: string, verified: boolean, actor: string): Classification {
  const c = classificationOf(appId);
  if (!c) throw err(404, "not found");
  if (verified) db.prepare("UPDATE app_classifications SET verification='verified', verified_by=?, verified_at=?, verified_hash=content_hash WHERE application_id=?").run(actor, nowIso(), appId);
  else db.prepare("UPDATE app_classifications SET verification='unverified', verified_by=NULL, verified_at=NULL, verified_hash=NULL WHERE application_id=?").run(appId);
  audit(actor, verified ? "classification:verify" : "classification:unverify", "applications", appId, { criticality: c.criticality, services: c.services });
  return classificationOf(appId)!;
}

/**
 * The business services the estate supports, each mapped to the applications behind it and — through them — to the
 * resources, regions and shared services it depends on: the dependency mapping operational-resilience rules ask for
 * (SS1/21 ch. 5, SYSC 15A.4), derived from the model rather than drawn.
 */
export function businessServices() {
  const cls = allClassifications();
  const apps = new Map(listElements("application").map((a) => [a.id, a]));
  const services = new Map<string, { name: string; kind: ServiceKind; apps: string[] }>();
  for (const c of cls.values()) for (const s of c.services) {
    const k = serviceKey(s);
    const e = services.get(k) || { name: s.name, kind: s.kind, apps: [] };
    if (apps.has(c.application_id) && !e.apps.includes(c.application_id)) e.apps.push(c.application_id);
    services.set(k, e);
  }
  const sharedOf = db.prepare(`SELECT DISTINCT sh.id, sh.name FROM relations dep
      JOIN relations b ON b.from_id=dep.from_id AND b.type='belongs_to' AND b.deleted_at IS NULL AND b.to_id=?
      JOIN relations sb ON sb.from_id=dep.to_id AND sb.type='belongs_to' AND sb.deleted_at IS NULL
      JOIN elements sh ON sh.id=sb.to_id AND sh.type='shared_service' AND sh.deleted_at IS NULL
      WHERE dep.type='depends_on' AND dep.deleted_at IS NULL`);
  const openFindings = db.prepare("SELECT count(*) c FROM findings WHERE application_id=? AND status='open'");
  const list = [...services.values()].map((s) => {
    const appRows = s.apps.map((id) => {
      const a = apps.get(id)!; const rs = resourcesOf(id); const c = cls.get(id)!;
      return { id, name: a.name, criticality: c.criticality, verification: c.verification, origin: c.origin,
        resources: rs.length, regions: [...new Set(rs.map((r) => r.props.location).filter(Boolean))],
        resource_types: Object.entries(rs.reduce((m: Record<string, number>, r) => ((m[r.subtype || "unknown"] = (m[r.subtype || "unknown"] || 0) + 1), m), {})).map(([type, n]) => ({ type, n })),
        shared_services: sharedOf.all(id) as { id: string; name: string }[], open_findings: (openFindings.get(id) as any).c as number };
    }).sort((a, b) => a.name.localeCompare(b.name));
    return { name: s.name, kind: s.kind, regulated: REGULATED_KINDS.includes(s.kind), applications: appRows,
      resources: appRows.reduce((n, a) => n + a.resources, 0), regions: [...new Set(appRows.flatMap((a) => a.regions))].sort(),
      shared_services: [...new Map(appRows.flatMap((a) => a.shared_services).map((x) => [x.id, x])).values()],
      open_findings: appRows.reduce((n, a) => n + a.open_findings, 0),
      verified: appRows.every((a) => a.verification === "verified") };
  }).sort((a, b) => Number(b.regulated) - Number(a.regulated) || a.name.localeCompare(b.name));
  const all = [...cls.values()].filter((c) => apps.has(c.application_id));
  const name = (id: string) => apps.get(id)?.name ?? id;
  return { services: list,
    unclassified: all.filter((c) => !c.criticality).map((c) => ({ id: c.application_id, name: name(c.application_id) })).sort((a, b) => a.name.localeCompare(b.name)),
    critical_without_service: all.filter((c) => c.criticality === "critical" && c.services.length === 0).map((c) => ({ id: c.application_id, name: name(c.application_id) })),
    counts: { applications: all.length, critical: all.filter((c) => c.criticality === "critical").length, important: all.filter((c) => c.criticality === "important").length,
      standard: all.filter((c) => c.criticality === "standard").length, unclassified: all.filter((c) => !c.criticality).length, verified: all.filter((c) => c.verification === "verified").length } };
}
