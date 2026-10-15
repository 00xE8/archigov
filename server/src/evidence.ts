import { db, uid, nowIso, j, audit } from "./db.js";
import { hashOf } from "./model.js";

/**
 * Imported compliance evidence. Resource-level checks (public access, TLS, OS support, purge protection…)
 * are produced by Defender for Cloud / Azure Policy; Archigov imports their state as evidence attached to the
 * resource and lets standards assert on it. It never re-implements the check.
 */
export type EvidenceSource = "defender" | "azure_policy" | "manual";
export type EvidenceState = "pass" | "fail" | "unknown";

export interface EvidenceItemIn {
  resourceId?: string;    // element id
  resourceRef?: string;   // provider resource id (element.source_ref)
  resourceName?: string;  // last resort: element name
  control: string;        // stable control key, e.g. "storage-public-access"
  state: EvidenceState;
  observed_at?: string;
  severity?: string | null;
  detail?: Record<string, unknown>;
}

export interface Evidence { id: string; resource_id: string; source: EvidenceSource; control: string; state: EvidenceState; severity: string | null; observed_at: string; detail: any; content_hash: string | null; created_at: string; updated_at: string; }

export const rowToEvidence = (r: any): Evidence => ({ ...r, detail: j(r.detail_json, {}) });

function resolveResource(item: EvidenceItemIn): string | null {
  if (item.resourceId) { const r = db.prepare("SELECT id FROM elements WHERE id=? AND type='resource' AND deleted_at IS NULL").get(item.resourceId) as any; if (r) return r.id; }
  if (item.resourceRef) { const r = db.prepare("SELECT id FROM elements WHERE source_ref=? AND type='resource' AND deleted_at IS NULL").get(item.resourceRef.toLowerCase()) as any; if (r) return r.id; }
  if (item.resourceName) { const r = db.prepare("SELECT id FROM elements WHERE lower(name)=? AND type='resource' AND deleted_at IS NULL").get(item.resourceName.toLowerCase()) as any; if (r) return r.id; }
  return null;
}

/** Upsert evidence by (resource, source, control). Unmatched resources are reported, not silently dropped. */
export function importEvidence(source: EvidenceSource, items: EvidenceItemIn[], actor = "system") {
  const now = nowIso();
  const stats = { source, received: items.length, created: 0, updated: 0, unchanged: 0, unmatched: [] as string[] };
  const upsert = db.prepare(`INSERT INTO evidence(id,resource_id,source,control,state,severity,observed_at,detail_json,content_hash,created_at,updated_at)
    VALUES (@id,@resource_id,@source,@control,@state,@severity,@observed_at,@detail_json,@content_hash,@now,@now)
    ON CONFLICT(resource_id,source,control) DO UPDATE SET state=excluded.state, severity=excluded.severity, observed_at=excluded.observed_at,
      detail_json=excluded.detail_json, content_hash=excluded.content_hash, updated_at=excluded.updated_at`);
  const current = db.prepare("SELECT content_hash FROM evidence WHERE resource_id=? AND source=? AND control=?");
  db.transaction(() => {
    for (const it of items) {
      const resourceId = resolveResource(it);
      if (!resourceId) { stats.unmatched.push(it.resourceRef || it.resourceName || it.resourceId || "?"); continue; }
      const observed_at = it.observed_at || now;
      const content_hash = hashOf({ state: it.state, severity: it.severity ?? null, detail: it.detail ?? {}, observed_at });
      const cur = current.get(resourceId, source, it.control) as any;
      if (cur && cur.content_hash === content_hash) { stats.unchanged++; continue; }
      upsert.run({ id: uid(), resource_id: resourceId, source, control: it.control, state: it.state, severity: it.severity ?? null, observed_at, detail_json: JSON.stringify(it.detail ?? {}), content_hash, now });
      if (cur) stats.updated++; else stats.created++;
    }
  })();
  // the audit row keeps the unmatched refs (capped) so the evidence view can show what the last import could not place
  audit(actor, "import_evidence", "evidence", null, { ...stats, unmatched: stats.unmatched.length, unmatched_refs: stats.unmatched.slice(0, 50) });
  return stats;
}

export function evidenceFor(resourceId: string): Evidence[] {
  return (db.prepare("SELECT * FROM evidence WHERE resource_id=? ORDER BY source, control").all(resourceId) as any[]).map(rowToEvidence);
}

export function evidenceFailCount(applicationId: string): number {
  return (db.prepare(`SELECT count(*) c FROM evidence ev JOIN relations rel ON rel.from_id=ev.resource_id
    WHERE rel.to_id=? AND rel.type='belongs_to' AND rel.deleted_at IS NULL AND ev.state='fail'`).get(applicationId) as any).c;
}
