import { Hono } from "hono";
import { z } from "zod";
import { db, uid, nowIso, audit } from "../db.js";
import { listElements, setVerification } from "../model.js";
import { evaluateAll } from "../rules.js";
import { actorOf, dec, fnd, wi, nextCode } from "../http.js";
import { settleDependenciesOn } from "../boards/declare.js";
import { reviewInFlightFor } from "../boards/work.js";
import { reviewDecisionDraft } from "../ai.js";
import { assessmentsOfDecision, withAssessmentNames, requestDecisionAssessment, provideDecisionAssessment } from "../boards/assessments.js";
import { currentPrincipal } from "../auth/context.js";

export const decisions = new Hono();
/** How many links a decision carries each way: decisions it depends on, reviews that depend on it. */
const linkCounts = (id: string) => ({
  depends_on: (db.prepare("SELECT count(*) c FROM decision_links WHERE from_id=? AND kind='depends_on'").get(id) as any).c as number,
  blocks: (db.prepare("SELECT count(*) c FROM review_dependencies WHERE decision_id=?").get(id) as any).c as number,
});
/** What this decision depends on and what waits on it (decision_links + review_dependencies). */
const linksOf = (id: string) => ({
  depends_on: db.prepare("SELECT d.id, d.code, d.title, d.status, l.created_at FROM decision_links l JOIN decisions d ON d.id=l.to_id WHERE l.from_id=? AND l.kind='depends_on' ORDER BY l.created_at").all(id),
  dependents: (db.prepare("SELECT r.id review_id, r.code review_code, r.title review_title, r.stage, r.decision_id, x.resolved_state FROM review_dependencies x JOIN reviews r ON r.id=x.review_id WHERE x.decision_id=? ORDER BY x.created_at").all(id) as any[])
    .map((r) => ({ review: { id: r.review_id, code: r.review_code, title: r.review_title, stage: r.stage }, decision: r.decision_id ? db.prepare("SELECT id, code, title, status FROM decisions WHERE id=?").get(r.decision_id) ?? null : null, resolved_state: r.resolved_state ?? null })),
});

decisions.get("/decisions", (c) => {
  const apps = new Map(listElements("application").map((a) => [a.id, a.name]));
  // `review` is the review in flight that will decide the decision when declared; `links` the dependency edges each way
  return c.json(db.prepare("SELECT * FROM decisions ORDER BY code DESC").all().map(dec).map((d: any) => ({ ...d, applications: d.application_ids.map((id: string) => ({ id, name: apps.get(id) })), review: reviewInFlightFor(d.id), links: linkCounts(d.id) })));
});
decisions.get("/decisions/:id", (c) => {
  const d = db.prepare("SELECT * FROM decisions WHERE id=?").get(c.req.param("id")); if (!d) return c.json({ error: "not found" }, 404);
  const x = dec(d);
  const apps = new Map(listElements("application").map((a) => [a.id, a.name]));
  const findings = db.prepare("SELECT f.*, s.code standard_code, e.name element_name FROM findings f JOIN standards s ON s.id=f.standard_id LEFT JOIN elements e ON e.id=f.element_id WHERE f.decision_id=? AND f.status<>'resolved'").all(x.id).map(fnd);
  const standards = db.prepare(`SELECT code,title,id FROM standards WHERE id IN (${x.standard_ids.map(() => "?").join(",") || "''"})`).all(...x.standard_ids);
  const reviews = db.prepare("SELECT code,title,stage,id FROM reviews WHERE decision_id=?").all(x.id);
  const workItems = db.prepare("SELECT * FROM work_items WHERE decision_id=?").all(x.id).map(wi);
  return c.json({ ...x, applications: x.application_ids.map((id: string) => ({ id, name: apps.get(id) })), findings, standards, reviews, workItems, assessments: assessmentsOfDecision(x.id).map(withAssessmentNames), ...linksOf(x.id), links: linkCounts(x.id), review_in_flight: reviewInFlightFor(x.id), audit: db.prepare("SELECT * FROM audit_log WHERE entity='decisions' AND entity_id=? ORDER BY at DESC").all(x.id) });
});
const DecisionIn = z.object({ title: z.string(), topic: z.string().default("general"), status: z.string().default("proposed"), context_md: z.string().optional(), options: z.array(z.any()).default([]), decision_md: z.string().optional(), justification_md: z.string().optional(), consequences_md: z.string().optional(), constraint: z.any().nullable().optional(), application_ids: z.array(z.string()).default([]), standard_ids: z.array(z.string()).default([]), work_item_id: z.string().optional(), origin: z.string().optional() });
// Evidence on a proposed decision: the author triggers an assessment (requested, completed by its assessor) or
// provides one already done, then submits the decision for review — the rows keep decision_id, so the association
// follows the decision onto its review. Nothing here ever blocks; blocking stays with board-requested assessments.
decisions.post("/decisions/:id/assessments", async (c) => {
  const d = db.prepare("SELECT id, code, status, author FROM decisions WHERE id=?").get(c.req.param("id")) as any; if (!d) return c.json({ error: "not found" }, 404);
  const b = z.object({ type: z.string(), title: z.string().max(200).optional().nullable(), assigned_to: z.string().optional().nullable(), due_at: z.string().optional().nullable() }).parse(await c.req.json());
  const p = currentPrincipal(); if (!p) return c.json({ error: "sign in required" }, 401);
  try { requestDecisionAssessment(d, p, b, actorOf(c)); return c.json({ ok: true, assessments: assessmentsOfDecision(d.id).map(withAssessmentNames) }); } catch (e: any) { return c.json({ error: String(e.message || e) }, e.status || 500); }
});
decisions.post("/decisions/:id/assessments/provide", async (c) => {
  const d = db.prepare("SELECT id, code, status, author FROM decisions WHERE id=?").get(c.req.param("id")) as any; if (!d) return c.json({ error: "not found" }, 404);
  const b = z.object({ type: z.string(), title: z.string().max(200).optional().nullable(), result: z.string(), result_md: z.string().min(1), reference: z.string().max(2000).optional().nullable() }).parse(await c.req.json());
  const p = currentPrincipal(); if (!p) return c.json({ error: "sign in required" }, 401);
  try { provideDecisionAssessment(d, p, b as any, actorOf(c)); return c.json({ ok: true, assessments: assessmentsOfDecision(d.id).map(withAssessmentNames) }); } catch (e: any) { return c.json({ error: String(e.message || e) }, e.status || 500); }
});
// AI critical review of a decision draft before submission — nothing stored; 409 when the feature is off.
decisions.post("/decisions/review-draft", async (c) => {
  const b = DecisionIn.partial().extend({ title: z.string().min(1) }).parse(await c.req.json());
  try { return c.json(await reviewDecisionDraft(b as any)); }
  catch (e: any) { return c.json({ error: String(e.message || e).slice(0, 300) }, /not enabled/i.test(String(e.message)) ? 409 : e.status || 502); }
});
decisions.post("/decisions", async (c) => {
  const b = DecisionIn.parse(await c.req.json()); const id = uid(); const now = nowIso(); const code = nextCode("decisions", "ADR");
  // whoever posts a decision is a human author; origin/verification are never taken from the client
  db.prepare(`INSERT INTO decisions(id,code,title,status,topic,context_md,options_json,decision_md,justification_md,consequences_md,constraint_json,application_ids_json,standard_ids_json,author,origin,verification,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'human','unverified',?,?)`)
    .run(id, code, b.title, b.status, b.topic, b.context_md || "", JSON.stringify(b.options), b.decision_md || "", b.justification_md || "", b.consequences_md || "", b.constraint ? JSON.stringify(b.constraint) : null, JSON.stringify(b.application_ids), JSON.stringify(b.standard_ids), actorOf(c), now, now);
  if (b.work_item_id) db.prepare("UPDATE work_items SET decision_id=? WHERE id=?").run(id, b.work_item_id);
  audit(actorOf(c), "create", "decisions", id, { code }); return c.json({ id, code });
});
decisions.put("/decisions/:id", async (c) => {
  const b = DecisionIn.partial().parse(await c.req.json()); const id = c.req.param("id"); const cur = db.prepare("SELECT * FROM decisions WHERE id=?").get(id) as any; if (!cur) return c.json({ error: "not found" }, 404);
  db.prepare(`UPDATE decisions SET title=?, topic=?, context_md=?, options_json=?, decision_md=?, justification_md=?, consequences_md=?, constraint_json=?, application_ids_json=?, standard_ids_json=?, updated_at=?, verification='unverified', verified_by=NULL, verified_at=NULL WHERE id=?`)
    .run(b.title ?? cur.title, b.topic ?? cur.topic, b.context_md ?? cur.context_md, b.options ? JSON.stringify(b.options) : cur.options_json, b.decision_md ?? cur.decision_md, b.justification_md ?? cur.justification_md, b.consequences_md ?? cur.consequences_md,
      b.constraint === undefined ? cur.constraint_json : b.constraint ? JSON.stringify(b.constraint) : null, b.application_ids ? JSON.stringify(b.application_ids) : cur.application_ids_json, b.standard_ids ? JSON.stringify(b.standard_ids) : cur.standard_ids_json, nowIso(), id);
  audit(actorOf(c), "update", "decisions", id, b); return c.json({ ok: true });
});
decisions.post("/decisions/:id/status", async (c) => {
  const { status } = await c.req.json(); const id = c.req.param("id"); const now = nowIso();
  if (!["proposed", "accepted", "rejected", "superseded", "deprecated"].includes(status)) return c.json({ error: "bad status" }, 400);
  if (!db.prepare("SELECT 1 FROM decisions WHERE id=?").get(id)) return c.json({ error: "not found" }, 404);
  // while a review that decides this decision is in flight, acceptance or rejection is the board's declaration, not a status edit
  if (status === "accepted" || status === "rejected") {
    const r = reviewInFlightFor(id);
    if (r) { audit(actorOf(c), "status:refused_under_review", "decisions", id, { status, review_id: r.id, review: r.code, stage: r.stage }); return c.json({ error: "under review", review: { id: r.id, code: r.code, stage: r.stage, board: r.board } }, 409); }
  }
  db.prepare("UPDATE decisions SET status=?, decided_at=CASE WHEN ? IN ('accepted','rejected') THEN ? ELSE decided_at END, updated_at=? WHERE id=?").run(status, status, now, now, id);
  audit(actorOf(c), `status:${status}`, "decisions", id);
  // reviews approved pending on this decision take effect (accepted) or return to the agenda (rejected)
  if (status === "accepted" || status === "rejected") settleDependenciesOn(id, status, actorOf(c));
  if (status === "accepted") evaluateAll(actorOf(c));
  return c.json({ ok: true });
});
decisions.post("/decisions/:id/verify", async (c) => { const body = await c.req.json().catch(() => ({})); setVerification("decisions", c.req.param("id"), body.verified !== false, actorOf(c)); return c.json({ ok: true }); });
