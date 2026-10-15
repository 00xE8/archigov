import { db, j, uid, nowIso, audit } from "./db.js";
import { getElement, listElements } from "./model.js";
import { runPreReview, stripTemplateHints } from "./ai.js";
import { dec, ev, nextCode } from "./http.js";
import { ARTEFACT_TYPES, type BoardRow, type ReviewType } from "./boards/workflow.js";
import { deriveAreas } from "./boards/areas.js";
import { preReviewArtefact, setArtefactLifecycle } from "./artefacts.js";

/**
 * What every review needs regardless of who creates it: the row, its target resolved for display, the automatic
 * pre-review that fits its type, and the areas it touches. Shared by the /reviews routes, the dependent-decision
 * flow (boards/declare.ts) and the session agenda (boards/sessions.ts).
 */
export const reviewRow = (id: string) => db.prepare("SELECT * FROM reviews WHERE id=?").get(id) as any;
export const userName = (id: string | null | undefined) => (id ? ((db.prepare("SELECT name FROM users WHERE id=?").get(id) as any)?.name ?? id) : null);

/** What the review is about, resolved for display and linking. */
export function targetOf(r: any) {
  const kind = r.target_kind, id = r.target_id;
  if (!kind || !id) return r.application_id ? { kind: "application", id: r.application_id, name: getElement(r.application_id)?.name ?? null } : null;
  if (kind === "application") return { kind, id, name: getElement(id)?.name ?? null };
  if (kind === "decision") { const d = db.prepare("SELECT code, title FROM decisions WHERE id=?").get(id) as any; return { kind, id, code: d?.code ?? null, name: d?.title ?? null }; }
  if (kind === "artefact") { const a = db.prepare("SELECT code, title, kind artefact_kind, lifecycle FROM standards WHERE id=?").get(id) as any; return { kind, id, code: a?.code ?? null, name: a?.title ?? null, artefact_kind: a?.artefact_kind ?? null, lifecycle: a?.lifecycle ?? null }; }
  if (kind === "finding") { const f = db.prepare("SELECT f.message, f.application_id, s.code standard_code FROM findings f JOIN standards s ON s.id=f.standard_id WHERE f.id=?").get(id) as any; return { kind, id, code: f?.standard_code ?? null, name: f?.message ?? null, application_id: f?.application_id ?? null }; }
  return { kind, id };
}

// ---------- pre-review by type ----------
function storePreReview(reviewId: string, actor: string, data: Record<string, any>, summary: string) {
  const eventId = uid(), now = nowIso();
  // machine output, whatever produced it: nobody has stood behind it yet, so it is never stored as verified
  db.prepare(`INSERT INTO review_events(id,review_id,kind,actor,body_md,data_json,origin,verification,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(eventId, reviewId, "pre_review", actor, summary, JSON.stringify({ engine: "rules", findings: [], suggested_conditions: [], ...data, summary }), "rules", "unverified", now);
  audit(actor, "pre_review", "review", reviewId, { engine: "rules", checks: (data.checks || []).length });
  return eventId;
}
const check = (name: string, state: "pass" | "warn" | "fail", detail: string) => ({ name, state, detail });
export function decisionPreReview(d: any) {
  const checks: any[] = [];
  const x = dec(d);
  checks.push(x.topic ? check("Topic", "pass", `Topic "${x.topic}".`) : check("Topic", "warn", "No topic: the decision cannot be matched against the model."));
  const cst = x.constraint;
  if (cst == null) checks.push(check("Checkable constraint", "warn", "No constraint: the decision is evidenced through reviews only."));
  else if (cst.allowedTypes && Array.isArray(cst.allowedTypes) && cst.allowedTypes.every((t: any) => typeof t === "string" && t.includes("/"))) checks.push(check("Checkable constraint", "pass", `allowedTypes: ${cst.allowedTypes.join(", ")}`));
  else checks.push(check("Checkable constraint", "fail", "constraint.allowedTypes must be a non-empty list of resource types like Microsoft.Sql/servers"));
  const apps = listElements("application");
  const affected = x.application_ids.length ? apps.filter((a) => x.application_ids.includes(a.id)) : apps;
  checks.push(check("Scope", "pass", x.application_ids.length ? `${affected.length} application(s): ${affected.map((a) => a.name).join(", ")}` : `tenant-wide: all ${apps.length} applications`));
  const clash = (db.prepare("SELECT code, title, application_ids_json FROM decisions WHERE status='accepted' AND topic=? AND id<>?").all(x.topic, x.id) as any[])
    .filter((o) => { const ids: string[] = j(o.application_ids_json, []); return !ids.length || !x.application_ids.length || ids.some((i) => x.application_ids.includes(i)); });
  if (clash.length) checks.push(check("Overlap", "warn", `Already accepted on "${x.topic}" for overlapping applications: ${clash.map((o) => o.code).join(", ")} — this decision should supersede or scope itself.`));
  else checks.push(check("Overlap", "pass", "No accepted decision on the same topic for these applications."));
  const ok = !checks.some((k) => k.state === "fail");
  return { ok, checks, impact: { applications: affected.length, application_names: affected.map((a) => a.name).slice(0, 10) }, recommendation: ok ? (checks.some((k) => k.state === "warn") ? "approve_with_conditions" : "approve") : "request_changes" };
}
export function exceptionPreReview(data: { finding_id?: string | null; artefact_id?: string | null; application_id?: string | null; proposed_expires_at?: string | null; reason?: string | null }) {
  const checks: any[] = [];
  let f: any = null;
  if (data.finding_id) { f = db.prepare("SELECT f.*, s.code standard_code FROM findings f JOIN standards s ON s.id=f.standard_id WHERE f.id=?").get(data.finding_id); checks.push(f ? check("Finding", f.status === "open" ? "pass" : "warn", f ? `${f.standard_code}: ${f.message} (${f.status})` : "") : check("Finding", "fail", "finding not found")); }
  else { const a = data.artefact_id ? (db.prepare("SELECT code, title FROM standards WHERE id=?").get(data.artefact_id) as any) : null; checks.push(a ? check("Artefact", "pass", `${a.code}: ${a.title}`) : check("Artefact", "fail", "artefact not found")); }
  checks.push(data.reason && data.reason.trim().length >= 10 ? check("Reason", "pass", "A reason is given.") : check("Reason", "fail", "A reason of at least 10 characters is required."));
  if (data.proposed_expires_at) {
    const days = (new Date(data.proposed_expires_at).getTime() - Date.now()) / 86_400_000;
    checks.push(Number.isNaN(days) ? check("Expiry", "fail", "proposed_expires_at is not a date") : days <= 180 ? check("Expiry", days > 0 ? "pass" : "fail", days > 0 ? `Expires in ${Math.round(days)} days.` : "Expiry is in the past.") : check("Expiry", "warn", `Expires in ${Math.round(days)} days; exceptions should not run longer than 180 days.`));
  } else checks.push(check("Expiry", "warn", "No expiry proposed: open-ended exceptions are flagged in evidence packs."));
  const ok = !checks.some((k) => k.state === "fail");
  return { ok, checks, impact: { findings: f ? 1 : 0 }, recommendation: ok ? (checks.some((k) => k.state === "warn") ? "approve_with_conditions" : "approve") : "request_changes" };
}
/** Run the pre-review that fits the review's type, store it as an event and move the review to in_review. */
export async function preReviewByType(r: any, actor: string) {
  if (r.type === "design") await runPreReview(r.id, actor);
  else if (ARTEFACT_TYPES.includes(r.type)) {
    const pre = preReviewArtefact(r.target_id);
    storePreReview(r.id, actor, { checks: pre.checks, impact: pre.impact, recommendation: pre.ok ? "approve" : "request_changes" }, `${(pre.checks || []).length} checks; ${pre.impact?.findings ?? 0} finding(s) would open on adoption.`);
  } else if (r.type === "decision") {
    const d = db.prepare("SELECT * FROM decisions WHERE id=?").get(r.target_id); if (!d) throw new Error("decision not found");
    const pre = decisionPreReview(d);
    storePreReview(r.id, actor, pre, `${pre.checks.length} checks on the decision; ${pre.impact.applications} application(s) affected.`);
  } else if (r.type === "exception") {
    const sub = ev(db.prepare("SELECT * FROM review_events WHERE review_id=? AND kind='submitted' ORDER BY created_at LIMIT 1").get(r.id)) as any;
    const pre = exceptionPreReview(sub?.data || {});
    storePreReview(r.id, actor, pre, `${pre.checks.length} checks on the exception request.`);
  }
  db.prepare("UPDATE reviews SET stage=CASE WHEN stage IN ('submitted','pre_review') THEN 'in_review' ELSE stage END, updated_at=? WHERE id=?").run(nowIso(), r.id);
  // the pre-review may cite new catalogue items: re-derive the touched areas unless an author pinned them
  refreshAreas(r.id);
}

// ---------- areas ----------
/**
 * Derive and store the areas a review touches. The derived set is always kept for display (areas_derived_json);
 * the touched set (areas_json) follows it while areas_origin is 'derived' — an author's edit sticks until `reset`
 * (a referral to another board).
 */
export function refreshAreas(reviewId: string, opts: { reset?: boolean } = {}): string[] {
  const r = reviewRow(reviewId); if (!r) return [];
  const derived = deriveAreas(r);
  const keep = !opts.reset && r.areas_origin === "human" && r.areas_json != null;
  db.prepare("UPDATE reviews SET areas_derived_json=?, areas_json=CASE WHEN ? THEN areas_json ELSE ? END, areas_origin=CASE WHEN ? THEN areas_origin ELSE 'derived' END WHERE id=?")
    .run(JSON.stringify(derived), keep ? 1 : 0, JSON.stringify(derived), keep ? 1 : 0, reviewId);
  return keep ? j(r.areas_json, []) : derived;
}

// ---------- creation ----------
export interface NewReview {
  type: ReviewType; title: string; target_kind: string; target_id: string; board: BoardRow; submitted_by: string;
  application_id?: string | null; decision_id?: string | null; work_item_id?: string | null; risk_tier?: string; impact?: string | null; summary?: string; design_md?: string;
  /** extra data stored on the `submitted` event (an exception's request) */
  submitted_data?: Record<string, unknown>;
}
/** Insert a review already validated and routed: row, `submitted` event, work-item link, artefact lifecycle, audit, pre-review, areas. Returns the row. */
export async function createReview(input: NewReview, actor: string) {
  const id = uid(); const now = nowIso(); const code = nextCode("reviews", "REV");
  db.prepare(`INSERT INTO reviews(id,code,title,application_id,decision_id,work_item_id,risk_tier,stage,summary,design_md,submitted_by,created_at,updated_at,type,target_kind,target_id,board_id,impact) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, code, input.title, input.application_id || null, input.decision_id || null, input.work_item_id || null, input.risk_tier || "medium", "submitted", input.summary || "", stripTemplateHints(input.design_md || ""), input.submitted_by, now, now, input.type, input.target_kind, input.target_id, input.board.id, input.impact || null);
  db.prepare(`INSERT INTO review_events(id,review_id,kind,actor,body_md,data_json,origin,verification,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(uid(), id, "submitted", input.submitted_by, "Submitted for review.", JSON.stringify({ ...(input.submitted_data || {}), ...(actor !== input.submitted_by ? { created_by: actor } : {}) }), "human", "verified", now);
  if (input.work_item_id) { const w = db.prepare("SELECT * FROM work_items WHERE id=?").get(input.work_item_id) as any; if (w) db.prepare("UPDATE work_items SET review_id=?, approved_hash=?, material_change=0 WHERE id=?").run(id, w.content_hash, w.id); }
  if (ARTEFACT_TYPES.includes(input.type)) setArtefactLifecycle(input.target_id, "in_review", actor, { reviewId: id });
  audit(actor, "create", "reviews", id, { code, type: input.type, target_kind: input.target_kind, target_id: input.target_id, board: input.board.code, ...(actor !== input.submitted_by ? { submitted_by: input.submitted_by } : {}) });
  await preReviewByType(reviewRow(id), "system");
  refreshAreas(id);
  return reviewRow(id);
}
