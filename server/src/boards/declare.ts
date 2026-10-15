import { z } from "zod";
import { db, j, uid, nowIso, audit } from "../db.js";
import { evaluateAll } from "../rules.js";
import { ev, nextCode } from "../http.js";
import { setArtefactLifecycle } from "../artefacts.js";
import type { Principal } from "../auth/context.js";
import { reviewRow, createReview, refreshAreas } from "../reviews.js";
import { ARTEFACT_TYPES, OPEN_STAGES, OUTCOMES, approvalProgress, openSessionOf, itemOf, boardById, boardSummary, routeBoard, supersedePositions, recordPosition, positionById, modeOf, sessionById,
  type Outcome, type Check, type Position, type PositionValue, type Resolution } from "./workflow.js";
import { presentIfUnrecorded } from "./sessions.js";

/**
 * Declaring an outcome, and what follows from it. The chair declares the outcome the positions allow; the
 * effects of an approval (ADR accepted, artefact adopted, exception created, conformance re-evaluated) are applied
 * only when the outcome is effective — at once, or later when the decisions it depends on are decided or an
 * absent area's position arrives through circulation. Everything here records the session the review sat on.
 */
const EVENT_KIND: Record<Outcome, string> = { approved: "approve", approved_with_conditions: "approve", approved_subject_to_circulation: "approve", changes_requested: "request_changes", deferred: "defer", referred: "refer", rejected: "reject", withdrawn: "withdraw" };
/** A review event. Human acts are verified by their actor; what the system derives (an outcome taking effect, an auto-deferral) is `derived`, never verified. */
export function addEvent(reviewId: string, kind: string, actor: string, body: string | null, data: Record<string, unknown>, sessionId: string | null, origin: "human" | "derived" = "human") {
  const id = uid(), now = nowIso();
  db.prepare(`INSERT INTO review_events(id,review_id,kind,actor,body_md,data_json,origin,verification,verified_by,verified_at,created_at,session_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, reviewId, kind, actor, body || "", JSON.stringify(data), origin, origin === "human" ? "verified" : "unverified", origin === "human" ? actor : null, origin === "human" ? now : null, now, sessionId);
  return id;
}

export interface Condition { text: string; owner?: string; due_at?: string; area?: string }
export interface DeclareBody { outcome: Outcome; rationale?: string; conditions?: Condition[]; circulation_due?: string; board_id?: string; reason?: string }
export interface DeclareOpts { eventKind?: string }
/** The body of POST /reviews/:id/decide and of a session item's declare. */
export const DeclareIn = z.object({ outcome: z.enum(OUTCOMES), rationale: z.string().max(4000).optional(), conditions: z.array(z.object({ text: z.string().min(1), owner: z.string().optional(), due_at: z.string().optional(), area: z.string().optional() })).optional(), circulation_due: z.string().optional(), board_id: z.string().optional(), reason: z.string().max(4000).optional() });
/** Body rules: a rationale for anything but an approval, an existing other board for a referral, a due date for circulation. Returns the problem or null. */
export function validateDeclare(b: DeclareBody, r: any): string | null {
  if (["changes_requested", "deferred", "referred", "rejected"].includes(b.outcome) && !(b.rationale || b.reason)?.trim()) return `a rationale is required to declare ${b.outcome.replace(/_/g, " ")}`;
  if (b.outcome === "referred") { const to = b.board_id ? boardById(b.board_id) : null; if (!to) return "referred needs board_id of an existing board"; if (to.id === r.board_id) return "the review is already on that board"; }
  if (b.outcome === "approved_subject_to_circulation" && (!b.circulation_due || Number.isNaN(Date.parse(b.circulation_due)))) return "approved_subject_to_circulation needs circulation_due (ISO date)";
  return null;
}
export const unresolvedDependencies = (reviewId: string) => db.prepare("SELECT * FROM review_dependencies WHERE review_id=? AND resolved_at IS NULL").all(reviewId) as any[];
const hasOpenConditions = (reviewId: string) => !!db.prepare("SELECT 1 FROM conditions WHERE review_id=? AND status IN ('open','overdue')").get(reviewId);

/** Store the declared outcome (after canDecide said yes) and apply its effects when it is effective. */
export function declareOutcome(review: any, b: DeclareBody, chk: Check, actor: string, opts: DeclareOpts = {}) {
  const id = review.id, now = nowIso();
  const session = openSessionOf(id); const item = session ? itemOf(session.id, id) : null; const sid = session?.id ?? null;
  const conds = b.conditions || [];
  const data: Record<string, unknown> = { outcome: b.outcome, conditions: conds.length, board_role: chk.role ?? null, acting_chair: !!chk.acting, board_id: review.board_id, session_id: sid };
  // an approval the positions alone did not allow rests on the fast lane: the checks that held are recorded with it
  if (b.outcome === "approved" || b.outcome === "approved_with_conditions") {
    const prog = approvalProgress(review);
    if (prog.via_fast_lane && prog.fast_lane) data.fast_lane = { risk_tier: prog.fast_lane.risk.tier, patterns: prog.fast_lane.patterns.map((x) => x.code), checks: prog.fast_lane.checks.map((x) => x.id) };
  }
  let stage = review.stage, pending: string | null = null, decided = false;
  switch (b.outcome) {
    case "withdrawn": stage = "withdrawn"; decided = true; break;
    case "rejected": stage = "rejected"; decided = true; break;
    case "changes_requested": stage = "changes_requested"; break;
    case "deferred": stage = OPEN_STAGES.includes(review.stage) ? "in_review" : review.stage; break;
    case "referred": stage = "in_review"; break;
    case "approved_subject_to_circulation": stage = "approved_subject_to_circulation"; pending = conds.length || hasOpenConditions(id) ? "approved_with_conditions" : "approved"; decided = true; break;
    default: // approved | approved_with_conditions: held while the decisions it depends on are undecided
      if (unresolvedDependencies(id).length) { stage = "approved_pending_dependencies"; pending = b.outcome; } else stage = b.outcome;
      decided = true;
  }
  for (const cond of conds) db.prepare(`INSERT INTO conditions(id,review_id,text,owner,due_at,status,created_at,area) VALUES (?,?,?,?,?,?,?,?)`).run(uid(), id, cond.text, cond.owner || null, cond.due_at || null, "open", now, cond.area || null);
  if (b.outcome === "referred") {
    const to = boardById(b.board_id)!; // validated by the route
    data.from_board = review.board_id; data.to_board = to.id; data.to_board_code = to.code;
    db.prepare("UPDATE reviews SET board_id=? WHERE id=?").run(to.id, id);
    data.positions_superseded = supersedePositions(id);
    refreshAreas(id, { reset: true });
    // it leaves the old board's forthcoming agendas; the open session it was referred from keeps the declared item
    db.prepare(`DELETE FROM session_items WHERE review_id=? AND state='listed' AND session_id IN (SELECT id FROM board_sessions WHERE status='planned')`).run(id);
  }
  if (b.outcome === "deferred") db.prepare("UPDATE reviews SET deferred_count=deferred_count+1, deferred_reason=?, last_deferred_at=? WHERE id=?").run(b.reason || b.rationale || null, now, id);
  db.prepare(`UPDATE reviews SET stage=?, pending_outcome=?, circulation_due=?, decided_at=CASE WHEN ? THEN ? ELSE decided_at END, session_id=COALESCE(?, session_id), updated_at=? WHERE id=?`)
    .run(stage, pending, b.outcome === "approved_subject_to_circulation" ? b.circulation_due || null : null, decided ? 1 : 0, now, sid, now, id);
  addEvent(id, opts.eventKind || EVENT_KIND[b.outcome], actor, b.rationale || b.reason || "", { ...data, pending_outcome: pending, circulation_due: b.circulation_due || null, reason: b.reason || null }, sid);
  if (session && item) {
    const state = b.outcome === "deferred" ? "deferred" : b.outcome === "withdrawn" ? "withdrawn" : "declared";
    db.prepare("UPDATE session_items SET state=?, outcome=?, declared_at=?, note=? WHERE session_id=? AND review_id=?").run(state, b.outcome, now, b.rationale || b.reason || null, session.id, id);
  }
  // a withdrawn review leaves every forthcoming agenda
  if (b.outcome === "withdrawn") db.prepare(`UPDATE session_items SET state='withdrawn', outcome='withdrawn', declared_at=? WHERE review_id=? AND state='listed' AND session_id IN (SELECT id FROM board_sessions WHERE status IN ('planned','open'))`).run(now, id);
  audit(actor, `decide:${b.outcome}`, "reviews", id, { conditions: conds.length, type: review.type, ...(data.fast_lane ? { basis: "fast_lane", fast_lane: data.fast_lane } : {}), board_id: b.outcome === "referred" ? data.to_board : review.board_id, board_role: chk.role ?? null, acting_chair: !!chk.acting, session_id: sid, pending_outcome: pending, ...(b.outcome === "referred" ? { from_board: review.board_id } : {}) });
  const effective = ["approved", "approved_with_conditions", "rejected", "withdrawn"].includes(b.outcome) && !pending;
  if (effective) applyOutcomeEffects(reviewRow(id), b.outcome, actor);
  return { ok: true as const, stage, pending_outcome: pending, session_id: sid, effective };
}

/** The consequences of an effective outcome: the linked ADR, the artefact's lifecycle, the exception, dependents waiting on this decision, conformance. */
export function applyOutcomeEffects(review: any, outcome: string, actor: string) {
  const now = nowIso(); const id = review.id;
  const approved = outcome.startsWith("approved");
  // a review outcome can decide the linked ADR; that is a decision-level event and is audited on the decision too
  if (review.decision_id && approved) {
    const n = db.prepare("UPDATE decisions SET status='accepted', decided_at=?, updated_at=? WHERE id=? AND status='proposed'").run(now, now, review.decision_id).changes;
    if (n) audit(actor, "status:accepted", "decisions", review.decision_id, { via_review: review.code, outcome });
  }
  if (review.decision_id && outcome === "rejected") {
    const n = db.prepare("UPDATE decisions SET status='rejected', decided_at=?, updated_at=? WHERE id=? AND status='proposed'").run(now, now, review.decision_id).changes;
    if (n) audit(actor, "status:rejected", "decisions", review.decision_id, { via_review: review.code, outcome });
  }
  // approving an artefact review is what adopts it; a rejection or withdrawal sends it back to draft
  if (ARTEFACT_TYPES.includes(review.type) && review.target_id) setArtefactLifecycle(review.target_id, approved ? "adopted" : "draft", actor, { reviewId: id });
  // an approved exception review creates the exception itself
  if (review.type === "exception" && approved) {
    const sub = ev(db.prepare("SELECT * FROM review_events WHERE review_id=? AND kind='submitted' ORDER BY created_at LIMIT 1").get(id)) as any; const d = sub?.data || {};
    const f = d.finding_id ? (db.prepare("SELECT * FROM findings WHERE id=?").get(d.finding_id) as any) : null;
    const standardId = f?.standard_id || d.artefact_id, exId = uid();
    if (standardId) {
      db.prepare(`INSERT INTO exceptions(id,standard_id,application_id,element_id,reason,approved_by,expires_at,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)`).run(exId, standardId, f?.application_id || d.application_id || review.application_id || null, f?.element_id || null, d.reason || review.summary || "", actor, d.proposed_expires_at || null, "active", now);
      audit(actor, "create", "exceptions", exId, { via_review: review.code, standard_id: standardId, expires_at: d.proposed_expires_at || null });
    }
  }
  if (review.decision_id && (approved || outcome === "rejected")) settleDependenciesOn(review.decision_id, approved ? "accepted" : "rejected", actor);
  evaluateAll(actor);
}

/** A held approval takes effect: stage ← pending_outcome, then the effects. Triggered by the last dependency decided or the last circulated position. */
export function makeEffective(review: any, actor = "system") {
  const outcome = review.pending_outcome || "approved";
  db.prepare("UPDATE reviews SET stage=?, pending_outcome=NULL, circulation_due=NULL, updated_at=? WHERE id=?").run(outcome, nowIso(), review.id);
  addEvent(review.id, "became_effective", actor, `Effective as ${outcome.replace(/_/g, " ")}.`, { outcome, from: review.stage }, review.session_id ?? null, "derived");
  audit(actor, "review:effective", "reviews", review.id, { outcome, from: review.stage });
  applyOutcomeEffects(reviewRow(review.id), outcome, actor);
}

/**
 * A decision was accepted or rejected (through its review, or directly by a chair): every review approved pending
 * on it is settled — effective once nothing else is outstanding, or back on the next agenda when it was rejected.
 */
export function settleDependenciesOn(decisionId: string, state: "accepted" | "rejected", actor: string) {
  const now = nowIso();
  for (const d of db.prepare("SELECT * FROM review_dependencies WHERE decision_id=? AND resolved_at IS NULL").all(decisionId) as any[]) {
    db.prepare("UPDATE review_dependencies SET resolved_at=?, resolved_state=? WHERE id=?").run(now, state, d.id);
    const dep = reviewRow(d.review_id); if (!dep) continue;
    const decision = db.prepare("SELECT code, title FROM decisions WHERE id=?").get(decisionId) as any;
    if (state === "accepted") {
      if (dep.stage === "approved_pending_dependencies" && unresolvedDependencies(dep.id).length === 0) makeEffective(dep, actor);
    } else {
      const back = dep.stage === "approved_pending_dependencies";
      if (back) db.prepare("UPDATE reviews SET stage='in_review', pending_outcome=NULL, updated_at=? WHERE id=?").run(now, dep.id);
      addEvent(dep.id, "dependency_rejected", actor, `${decision?.code ?? decisionId} was rejected${back ? "; the approval no longer stands and the item returns to the agenda" : ""}.`, { decision_id: decisionId, decision_code: decision?.code ?? null, returned_to: back ? "in_review" : dep.stage }, dep.session_id ?? null, "derived");
      audit(actor, "dependency:rejected", "reviews", dep.id, { decision_id: decisionId, decision_code: decision?.code ?? null, returned_to: back ? "in_review" : dep.stage });
    }
  }
}

// ---------- positions ----------
/** Record a position (after canRecordPosition said yes): the row, its timeline event, and what the stage does next. */
export function takePosition(review: any, p: Principal, chk: Check, area: string | null, position: PositionValue, text: string | null, actor: string): Position {
  const pos = recordPosition(review, p, chk, area, position, text, actor);
  const r = reviewRow(review.id); const now = nowIso();
  // a position taken in an open sitting puts its recorder in the room
  if (pos.session_id) { const s = sessionById(pos.session_id); if (s) presentIfUnrecorded(s, p.id); }
  const count = modeOf(r).mode === "count";
  // count mode keeps the old event names; in areas mode a position names its area, and a reviewer's area-less no is a plain send-back
  addEvent(r.id, count ? (position === "yes" ? "approval" : "request_changes") : area === null ? "request_changes" : "position", actor, text, { position, area, board_role: pos.board_role, board_id: r.board_id, on_behalf_of: pos.on_behalf_of, delegation_id: pos.delegation_id, session_id: pos.session_id }, pos.session_id);
  if (r.stage === "approved_subject_to_circulation") {
    if (position === "no") {
      // an objection in circulation: the approval no longer stands and the item goes on the next agenda
      db.prepare("UPDATE reviews SET stage='in_review', pending_outcome=NULL, circulation_due=NULL, updated_at=? WHERE id=?").run(now, r.id);
      addEvent(r.id, "circulation_objection", actor, text, { area, position, on_behalf_of: pos.on_behalf_of }, pos.session_id);
      audit(actor, "review:circulation_objection", "reviews", r.id, { area, on_behalf_of: pos.on_behalf_of });
    } else if (approvalProgress(reviewRow(r.id)).satisfied) makeEffective(reviewRow(r.id), actor);
    return pos;
  }
  db.prepare("UPDATE reviews SET stage=?, updated_at=? WHERE id=?").run(position === "no" ? "changes_requested" : (r.stage === "submitted" || r.stage === "pre_review" ? "in_review" : r.stage), now, r.id);
  return pos;
}

export interface ResolveBody { resolution: Resolution; text: string; condition?: { text?: string; owner?: string; due_at?: string }; decision_id?: string; create?: CreateDecision }
/** The chair resolves a conditional (after canResolve said yes): a tracked condition, an explanation, or a decision the item now depends on. */
export async function resolvePosition(review: any, pos: Position, b: ResolveBody, p: Principal, actor: string) {
  const now = nowIso(); const session = openSessionOf(review.id); const sid = session?.id ?? null;
  let ref: string | null = null, created: Awaited<ReturnType<typeof createDependency>> | null = null;
  if (b.resolution === "accepted_condition") {
    ref = uid();
    db.prepare(`INSERT INTO conditions(id,review_id,text,owner,due_at,status,created_at,area,position_id) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(ref, review.id, b.condition?.text || pos.text || b.text, b.condition?.owner || review.submitted_by || null, b.condition?.due_at || null, "open", now, pos.area, pos.id);
  } else if (b.resolution === "dependent_decision") {
    if (!b.create && !b.decision_id) throw Object.assign(new Error("a dependent_decision resolution needs decision_id or create"), { status: 400 });
    created = await createDependency(review, b.create ? { create: b.create, submit: true } : { decision_id: b.decision_id }, p, actor);
    ref = created.decision.id;
  }
  db.prepare("UPDATE review_positions SET resolution=?, resolution_text=?, resolved_by=?, resolved_at=?, resolution_ref=? WHERE id=?").run(b.resolution, b.text, p.id, now, ref, pos.id);
  addEvent(review.id, "position_resolved", actor, b.text, { position_id: pos.id, area: pos.area, position_by: pos.user_id, on_behalf_of: pos.on_behalf_of, resolution: b.resolution, resolution_ref: ref, session_id: sid }, sid);
  audit(actor, "position:resolve", "reviews", review.id, { position_id: pos.id, area: pos.area, resolution: b.resolution, resolution_ref: ref, session_id: sid });
  // the last open conditional of a circulated item resolves it
  const r = reviewRow(review.id);
  if (r.stage === "approved_subject_to_circulation" && approvalProgress(r).satisfied) makeEffective(r, actor);
  return { position: positionById(pos.id)!, dependency: created };
}

// ---------- dependencies ----------
export interface CreateDecision { title: string; topic?: string; context_md?: string; decision_md?: string; application_ids?: string[] }
export interface DependencyBody { decision_id?: string; create?: CreateDecision; submit?: boolean }
/**
 * Link a decision the review depends on — an existing proposed ADR, or a new one authored (origin human) in the
 * submitter's name and, by default, submitted for its own decision review routed like any other.
 */
export async function createDependency(review: any, b: DependencyBody, p: Principal, actor: string) {
  const now = nowIso(); const session = openSessionOf(review.id); const sid = session?.id ?? null;
  let decision: any, depReview: any = null;
  if (b.create) {
    const id = uid(), code = nextCode("decisions", "ADR"), topic = b.create.topic || "general";
    const appIds = b.create.application_ids ?? (review.application_id ? [review.application_id] : []);
    db.prepare(`INSERT INTO decisions(id,code,title,status,topic,context_md,options_json,decision_md,consequences_md,constraint_json,application_ids_json,standard_ids_json,author,origin,verification,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'human','unverified',?,?)`)
      .run(id, code, b.create.title, "proposed", topic, b.create.context_md || `Raised as a dependency of ${review.code} (${review.title}).`, "[]", b.create.decision_md || "", "", null, JSON.stringify(appIds), "[]", review.submitted_by || actor, now, now);
    audit(actor, "create", "decisions", id, { code, via_review: review.code, author: review.submitted_by || actor });
    decision = db.prepare("SELECT * FROM decisions WHERE id=?").get(id);
    if (b.submit !== false) {
      const board = routeBoard("decision", null, topic);
      if (!board) throw Object.assign(new Error("no board can receive a decision review (no routing rule and no board coded DA)"), { status: 500 });
      depReview = await createReview({ type: "decision", title: `Decide ${code}: ${b.create.title}`, target_kind: "decision", target_id: id, decision_id: id, application_id: appIds.length === 1 ? appIds[0] : null, board, submitted_by: review.submitted_by || actor, risk_tier: "medium", summary: `Dependent decision raised from ${review.code}.` }, actor);
    }
  } else {
    decision = b.decision_id ? db.prepare("SELECT * FROM decisions WHERE id=?").get(b.decision_id) : null;
    if (!decision) throw Object.assign(new Error("decision not found"), { status: 404 });
    depReview = db.prepare("SELECT * FROM reviews WHERE decision_id=? AND stage IN ('submitted','pre_review','in_review','changes_requested','approved_pending_dependencies','approved_subject_to_circulation') ORDER BY created_at DESC LIMIT 1").get(decision.id) ?? null;
  }
  if (decision.id === review.decision_id) throw Object.assign(new Error("a decision cannot depend on itself"), { status: 400 });
  if (db.prepare("SELECT 1 FROM review_dependencies WHERE review_id=? AND decision_id=?").get(review.id, decision.id)) throw Object.assign(new Error(`${review.code} already depends on ${decision.code}`), { status: 409 });
  const resolved = decision.status === "accepted" ? "accepted" : decision.status === "rejected" ? "rejected" : null;
  const depId = uid();
  db.prepare("INSERT INTO review_dependencies(id,review_id,decision_id,dependency_review_id,created_by,session_id,created_at,resolved_at,resolved_state) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(depId, review.id, decision.id, depReview?.id ?? null, actor, sid, now, resolved ? now : null, resolved);
  if (review.type === "decision" && review.decision_id) db.prepare("INSERT OR IGNORE INTO decision_links(from_id,to_id,kind,created_by,created_at) VALUES (?,?,'depends_on',?,?)").run(review.decision_id, decision.id, actor, now);
  addEvent(review.id, "dependency_created", actor, `Depends on ${decision.code}: ${decision.title}`, { decision_id: decision.id, decision_code: decision.code, dependency_review_id: depReview?.id ?? null, dependency_review_code: depReview?.code ?? null, created: !!b.create, resolved_state: resolved, session_id: sid }, sid);
  audit(actor, "dependency:create", "reviews", review.id, { decision_id: decision.id, decision_code: decision.code, dependency_review_id: depReview?.id ?? null, created: !!b.create, session_id: sid });
  return { dependency: db.prepare("SELECT * FROM review_dependencies WHERE id=?").get(depId) as any, decision: { id: decision.id as string, code: decision.code as string }, review: depReview ? { id: depReview.id as string, code: depReview.code as string, board: boardSummary(boardById(depReview.board_id)) } : null };
}
/** What a review depends on, resolved for display. */
export const dependenciesOf = (reviewId: string) => (db.prepare("SELECT * FROM review_dependencies WHERE review_id=? ORDER BY created_at").all(reviewId) as any[]).map((d) => {
  const dec = db.prepare("SELECT id, code, title, status FROM decisions WHERE id=?").get(d.decision_id) as any;
  const rv = d.dependency_review_id ? (db.prepare("SELECT id, code, stage FROM reviews WHERE id=?").get(d.dependency_review_id) as any) : null;
  return { id: d.id, decision: dec ?? { id: d.decision_id, code: null, title: null, status: null }, review: rv ?? null, resolved_state: d.resolved_state ?? null, created_by: d.created_by, created_at: d.created_at, session_id: d.session_id };
});
/** The reviews that depend on this decision (for a decision review, the items it blocks). */
export const dependentsOf = (decisionId: string | null | undefined) => decisionId ? (db.prepare("SELECT r.id, r.code, r.title, r.stage, d.resolved_state FROM review_dependencies d JOIN reviews r ON r.id=d.review_id WHERE d.decision_id=? ORDER BY d.created_at").all(decisionId) as any[])
  .map((r) => ({ review: { id: r.id, code: r.code, title: r.title, stage: r.stage }, resolved_state: r.resolved_state ?? null })) : [];
