import { Hono } from "hono";
import { db, uid, nowIso, audit } from "../db.js";
import { listElements, getElement, resourcesOf, setVerification, rowToElement, hashOf } from "../model.js";
import { evidenceFor, evidenceFailCount } from "../evidence.js";
import { actorOf, fnd, dec, wi, ownerOf, DECISIONS_FOR_APP } from "../http.js";
import { applicationViews } from "../exporters/archimate.js";
import { userName } from "../reviews.js";

export const applications = new Hono();

applications.get("/applications", (c) => {
  const apps = listElements("application").map((a) => {
    const rs = resourcesOf(a.id);
    const open = (db.prepare("SELECT count(*) c FROM findings WHERE application_id=? AND status='open'").get(a.id) as any).c;
    const decisions = (db.prepare(`SELECT count(*) c FROM decisions WHERE ${DECISIONS_FOR_APP}`).get(`%${a.id}%`) as any).c;
    const owners = Array.from(new Set(rs.map(ownerOf).filter(Boolean)));
    return { ...a, resource_count: rs.length, open_findings: open, decision_count: decisions, owners, locations: Array.from(new Set(rs.map((r) => r.props.location).filter(Boolean))),
      evidence_fail_count: evidenceFailCount(a.id) };
  });
  return c.json(apps);
});

applications.get("/applications/:id", (c) => {
  const a = getElement(c.req.param("id"));
  if (!a) return c.json({ error: "not found" }, 404);
  const resources = resourcesOf(a.id).map((r) => ({ ...r,
    belongs: db.prepare("SELECT provenance_json, confidence, origin, verification, verified_by, verified_at FROM relations WHERE from_id=? AND to_id=? AND type='belongs_to' AND deleted_at IS NULL").get(r.id, a.id),
    evidence: evidenceFor(r.id).map((e) => ({ id: e.id, source: e.source, control: e.control, state: e.state, severity: e.severity, observed_at: e.observed_at, detail: e.detail })) }));
  const findings = db.prepare("SELECT f.*, s.code standard_code, s.title standard_title, s.kind artefact_kind, s.code artefact_code FROM findings f JOIN standards s ON s.id=f.standard_id WHERE f.application_id=? AND f.status<>'resolved' ORDER BY CASE f.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END").all(a.id).map(fnd);
  const decisions = db.prepare(`SELECT * FROM decisions WHERE ${DECISIONS_FOR_APP} ORDER BY code`).all(`%${a.id}%`).map(dec);
  const reviews = db.prepare("SELECT * FROM reviews WHERE application_id=? ORDER BY created_at DESC").all(a.id);
  const workItems = db.prepare("SELECT * FROM work_items WHERE application_id=? ORDER BY external_id").all(a.id).map(wi);
  const exceptions = db.prepare("SELECT e.*, s.code standard_code FROM exceptions e JOIN standards s ON s.id=e.standard_id WHERE e.application_id=?").all(a.id);
  const dependsOn = db.prepare(`SELECT DISTINCT t.* FROM relations rel JOIN elements f ON f.id=rel.from_id JOIN elements t ON t.id=rel.to_id
     JOIN relations b ON b.from_id=f.id AND b.type='belongs_to' AND b.to_id=? AND b.deleted_at IS NULL
     WHERE rel.type='depends_on' AND rel.deleted_at IS NULL`).all(a.id).map(rowToElement);
  return c.json({ ...a, resources, findings, decisions, reviews, workItems, exceptions, dependsOn });
});

/** Generated ArchiMate viewpoints for one application (the Design tab): deterministic, derived, never authored. */
applications.get("/applications/:id/views", (c) => {
  const a = getElement(c.req.param("id"));
  if (!a || a.type !== "application") return c.json({ error: "not found" }, 404);
  return c.json({ ...applicationViews(a), annotations: annotationsOf(a.id) });
});

/**
 * Design annotations: human notes pinned to a generated view or one element in it. The views stay derived and
 * read-only; the annotation is the commentary beside them — authored, audited, soft-deleted. Writing takes the
 * `comment` capability (authors and acting board seats; never the auditor or the platform admin), and only the
 * author edits or removes their own note.
 */
const annotationsOf = (appId: string) => (db.prepare("SELECT * FROM design_annotations WHERE application_id=? AND deleted_at IS NULL ORDER BY created_at, rowid").all(appId) as any[])
  .map((r) => ({ ...r, author_name: userName(r.author) }));

applications.post("/applications/:id/annotations", async (c) => {
  const a = getElement(c.req.param("id"));
  if (!a || a.type !== "application") return c.json({ error: "not found" }, 404);
  const b = await c.req.json().catch(() => ({}));
  const text = String(b.text || "").trim();
  if (!text) return c.json({ error: "an annotation needs text" }, 400);
  if (text.length > 2000) return c.json({ error: "an annotation is a note, not a document: at most 2000 characters (link out for more)" }, 400);
  const m = applicationViews(a);
  const view = m.views.find((v: any) => v.id === b.view_id);
  if (!view) return c.json({ error: `view_id must be one of: ${m.views.map((v: any) => v.id).join(", ")}` }, 400);
  const elementId = b.element_id || null;
  if (elementId && !view.nodes.some((n: any) => n.elementId === elementId)) return c.json({ error: "element_id is not an element of this view" }, 400);
  const actor = actorOf(c), id = uid(), now = nowIso();
  db.prepare("INSERT INTO design_annotations(id,application_id,view_id,element_id,text,author,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, a.id, view.id, elementId, text, actor, now, now);
  audit(actor, "annotation:add", "applications", a.id, { annotation_id: id, view_id: view.id, element_id: elementId });
  return c.json(annotationsOf(a.id).find((x) => x.id === id));
});

applications.put("/annotations/:id", async (c) => {
  const r = db.prepare("SELECT * FROM design_annotations WHERE id=? AND deleted_at IS NULL").get(c.req.param("id")) as any;
  if (!r) return c.json({ error: "not found" }, 404);
  const actor = actorOf(c);
  if (actor !== r.author) return c.json({ error: `only the author edits their annotation (written by ${userName(r.author)})` }, 403);
  const b = await c.req.json().catch(() => ({}));
  const text = String(b.text || "").trim();
  if (!text || text.length > 2000) return c.json({ error: "an annotation needs text of at most 2000 characters" }, 400);
  db.prepare("UPDATE design_annotations SET text=?, updated_at=? WHERE id=?").run(text, nowIso(), r.id);
  audit(actor, "annotation:edit", "applications", r.application_id, { annotation_id: r.id });
  return c.json({ ok: true });
});

applications.delete("/annotations/:id", (c) => {
  const r = db.prepare("SELECT * FROM design_annotations WHERE id=? AND deleted_at IS NULL").get(c.req.param("id")) as any;
  if (!r) return c.json({ error: "not found" }, 404);
  const actor = actorOf(c);
  if (actor !== r.author) return c.json({ error: `only the author removes their annotation (written by ${userName(r.author)})` }, 403);
  db.prepare("UPDATE design_annotations SET deleted_at=? WHERE id=?").run(nowIso(), r.id);
  audit(actor, "annotation:delete", "applications", r.application_id, { annotation_id: r.id });
  return c.json({ ok: true });
});

/** Platform plumbing (hub networks, shared identity, DNS…) grouped by resource group: not applications, but still part of the model. */
applications.get("/shared-services", (c) => c.json(listElements("shared_service").map((s) => {
  const rs = resourcesOf(s.id);
  // applications whose resources depend on this shared service's resources (provider references)
  const usedBy = rs.length ? db.prepare(`SELECT DISTINCT app.id, app.name FROM relations dep
      JOIN relations b ON b.from_id=dep.from_id AND b.type='belongs_to' AND b.deleted_at IS NULL
      JOIN elements app ON app.id=b.to_id AND app.type='application' AND app.deleted_at IS NULL
      WHERE dep.type='depends_on' AND dep.deleted_at IS NULL AND dep.to_id IN (${rs.map(() => "?").join(",")}) ORDER BY app.name`).all(...rs.map((r) => r.id)) : [];
  return { id: s.id, name: s.name, origin: s.origin, verification: s.verification, verified_by: s.verified_by, verified_at: s.verified_at, provenance: s.provenance,
    resource_count: rs.length, locations: Array.from(new Set(rs.map((r) => r.props.location).filter(Boolean))), used_by: usedBy,
    resources: rs.map((r) => ({ id: r.id, name: r.name, type: r.subtype, location: r.props.location, verification: r.verification })) };
})));

applications.post("/elements/:id/verify", async (c) => { const body = await c.req.json().catch(() => ({})); setVerification("elements", c.req.param("id"), body.verified !== false, actorOf(c)); return c.json({ ok: true }); });

applications.post("/applications/:id/verify-all", (c) => {
  const actor = actorOf(c); const id = c.req.param("id"); const now = nowIso();
  db.prepare("UPDATE elements SET verification='verified', verified_by=?, verified_at=?, verified_hash=content_hash WHERE id=? OR id IN (SELECT from_id FROM relations WHERE to_id=? AND type='belongs_to' AND deleted_at IS NULL)").run(actor, now, id, id);
  db.prepare("UPDATE relations SET verification='verified', verified_by=?, verified_at=?, verified_hash=content_hash WHERE to_id=? AND type='belongs_to' AND deleted_at IS NULL").run(actor, now, id);
  audit(actor, "verify_all", "application", id);
  return c.json({ ok: true });
});

applications.post("/resources/:id/move", async (c) => {
  // human reassigns a resource to another application; becomes a human-origin relation that collectors will not overwrite
  const { applicationId } = await c.req.json(); const actor = actorOf(c); const now = nowIso(); const id = c.req.param("id");
  const provenance_json = JSON.stringify({ method: "human", by: actor });
  const content_hash = hashOf({ from: id, to: applicationId, type: "belongs_to", provenance: provenance_json });
  db.prepare("UPDATE relations SET deleted_at=? WHERE from_id=? AND type='belongs_to' AND deleted_at IS NULL").run(now, id);
  db.prepare(`INSERT INTO relations(id,from_id,to_id,type,provenance_json,confidence,origin,verification,verified_by,verified_at,content_hash,verified_hash,created_at) VALUES (?,?,?,'belongs_to',?,1,'human','verified',?,?,?,?,?)
    ON CONFLICT(from_id,to_id,type) DO UPDATE SET deleted_at=NULL, origin='human', verification='verified', verified_by=excluded.verified_by, verified_at=excluded.verified_at, provenance_json=excluded.provenance_json, content_hash=excluded.content_hash, verified_hash=excluded.verified_hash`)
    .run(uid(), id, applicationId, provenance_json, actor, now, content_hash, content_hash, now);
  audit(actor, "move_resource", "elements", id, { applicationId });
  return c.json({ ok: true });
});
