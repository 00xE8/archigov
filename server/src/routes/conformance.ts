import { Hono } from "hono";
import { z } from "zod";
import { db, j, uid, nowIso, audit } from "../db.js";
import { listElements } from "../model.js";
import { evaluateAll } from "../rules.js";
import { actorOf, fnd, wi } from "../http.js";

export const conformance = new Hono();

conformance.get("/conformance", (c) => {
  const apps = new Map(listElements("application").map((a) => [a.id, a.name]));
  const findings = db.prepare("SELECT f.*, s.code standard_code, s.kind AS artefact_kind, s.code AS artefact_code, s.title standard_title, s.category, e.name element_name, e.subtype element_type, e.verification element_verification FROM findings f JOIN standards s ON s.id=f.standard_id LEFT JOIN elements e ON e.id=f.element_id WHERE f.status<>'resolved' ORDER BY CASE f.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, s.code").all().map(fnd).map((f: any) => ({ ...f, application_name: apps.get(f.application_id) || null }));
  const decisionDrift = findings.filter((f: any) => f.decision_id);
  const exceptions = db.prepare("SELECT e.*, s.code standard_code, s.title standard_title FROM exceptions e JOIN standards s ON s.id=e.standard_id ORDER BY e.expires_at").all().map((e: any) => ({ ...e, application_name: apps.get(e.application_id) || null }));
  const conditions = db.prepare("SELECT c.*, r.code review_code, r.title review_title FROM conditions c JOIN reviews r ON r.id=c.review_id WHERE c.status IN ('open','overdue') ORDER BY c.due_at").all();
  const runs = db.prepare("SELECT r.*, s.name source_name FROM runs r LEFT JOIN sources s ON s.id=r.source_id WHERE r.kind IN ('evaluate','sync') ORDER BY r.started_at DESC LIMIT 10").all()
    .map((r: any) => ({ id: r.id, kind: r.kind, source_id: r.source_id, source_name: r.source_name || null, started_at: r.started_at, finished_at: r.finished_at, status: r.status, error: r.error || null, stats: j(r.stats_json, {}) }));
  const materialChanges = db.prepare("SELECT w.*, r.code review_code FROM work_items w LEFT JOIN reviews r ON r.id=w.review_id WHERE w.material_change=1").all().map(wi);
  return c.json({ findings, decisionDrift, exceptions, conditions, runs, materialChanges });
});
conformance.post("/evaluate", (c) => c.json(evaluateAll(actorOf(c))));
conformance.post("/findings/:id/resolve", async (c) => {
  const id = c.req.param("id"); const b = await c.req.json().catch(() => ({})); const f = db.prepare("SELECT * FROM findings WHERE id=?").get(id) as any;
  if (!f) return c.json({ error: "not found" }, 404);
  const reason = typeof b.reason === "string" ? b.reason.trim() : "";
  if (!reason) return c.json({ error: "reason is required: say why this finding is closed" }, 400);
  const actor = actorOf(c);
  // a human closing a finding is material: it is what an auditor will ask about, so who and why stay on the finding
  // and in the audit log. The next evaluation reopens it if the condition is still there.
  db.prepare("UPDATE findings SET status='resolved', resolved_at=?, resolved_by=?, resolution=? WHERE id=?").run(nowIso(), actor, reason, id);
  audit(actor, "resolve", "findings", id, { standard_id: f.standard_id, element_id: f.element_id, application_id: f.application_id, message: f.message, reason });
  return c.json({ ok: true, finding: fnd(db.prepare("SELECT * FROM findings WHERE id=?").get(id)) });
});
conformance.post("/exceptions", async (c) => {
  const b = z.object({ standard_id: z.string(), application_id: z.string().nullable().optional(), element_id: z.string().nullable().optional(), reason: z.string(), expires_at: z.string().nullable().optional() }).parse(await c.req.json());
  const id = uid();
  db.prepare(`INSERT INTO exceptions(id,standard_id,application_id,element_id,reason,approved_by,expires_at,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)`).run(id, b.standard_id, b.application_id || null, b.element_id || null, b.reason, actorOf(c), b.expires_at || null, "active", nowIso());
  audit(actorOf(c), "create", "exceptions", id, b); evaluateAll(actorOf(c)); return c.json({ id });
});
