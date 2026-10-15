import { db, uid, nowIso, audit } from "../db.js";
import type { Principal } from "../auth/context.js";
import { OPEN_STAGES, memberRole, isDecider, openSessionOf, boardById, type ReviewLike, type Check } from "./workflow.js";
import { boardAreas } from "./areas.js";
import { addEvent } from "./declare.js";
import { getUser } from "../auth/users.js";
import { userName } from "../reviews.js";

/**
 * Assessments: due diligence a board seat requests on a review before it will decide — a DPIA, a security or
 * supplier assessment, a clinical-safety case, an AI impact assessment. The request names an assessor; only the
 * assessor records the result, as themselves (the same principle as positions: nobody records on another's
 * behalf). An open request blocks the approving outcomes (workflow.ts), until the result is recorded or the
 * review's chair waives it with a recorded reason. Results carry an external reference only — a pointer, never
 * the document — and are marked stale by a resubmission, never deleted.
 */
export const ASSESSMENT_TYPES = ["dpia", "security", "supplier", "clinical-safety", "ai-impact", "accessibility", "impact", "scope", "other"] as const;
export type AssessmentType = (typeof ASSESSMENT_TYPES)[number];
export const ASSESSMENT_RESULTS = ["satisfactory", "satisfactory_with_remarks", "unsatisfactory", "not_applicable"] as const;
export type AssessmentResult = (typeof ASSESSMENT_RESULTS)[number];

/**
 * One template per type: the headings a competent result answers, inserted as the summary's skeleton in the UI.
 * Prompts for human content only — references point at frameworks, no regulation text is reproduced.
 */
export const ASSESSMENT_TEMPLATES: Record<AssessmentType, string> = {
  dpia: "## Processing and purpose\n\n\n## Data categories and subjects\n\n\n## Lawful basis\n\n\n## Risks to individuals\n\n\n## Mitigations and residual risk\n\n\n## DPO consultation and outcome\n",
  security: "## Scope and assets\n\n\n## Threats considered\n\n\n## Controls in place and gaps\n\n\n## Residual risk and actions\n",
  supplier: "## Service and criticality\n\n\n## Due diligence performed\n\nFinancial standing, security posture, data locations.\n\n## Contractual controls\n\nExit, SLAs, audit rights, sub-processors.\n\n## Residual risk\n",
  "clinical-safety": "## Intended use and users\n\n\n## Hazards identified\n\nHazard log reference.\n\n## Mitigations\n\n\n## DCB0129/DCB0160 artefacts and clinical safety officer sign-off\n",
  "ai-impact": "## System purpose and the role of AI\n\n\n## Data and model provenance\n\n\n## Human oversight design\n\n\n## Risks and mitigations\n\nBias, robustness, transparency.\n\n## Monitoring plan\n",
  accessibility: "## Standard assessed against\n\ne.g. WCAG 2.2 AA.\n\n## Method\n\nAudit, tooling, assistive-technology testing.\n\n## Findings and severity\n\n\n## Remediation plan\n",
  impact: "## What changes\n\n\n## Who and what is affected\n\nServices, users, data, downstream systems.\n\n## Transition and rollback\n\n\n## Residual risk\n",
  scope: "## In scope\n\n\n## Out of scope\n\n\n## Assumptions\n\n\n## Dependencies and constraints\n",
  other: "## Purpose\n\n\n## Method\n\n\n## Findings\n\n\n## Conclusion\n",
};
/** Stages in which assessments are requested and recorded: open, or sent back (the board lines work up for the resubmission). */
const ACTIVE_STAGES = [...OPEN_STAGES, "changes_requested"];

export interface Assessment {
  id: string; review_id: string | null; decision_id: string | null; type: string; title: string | null; area: string | null;
  requested_by: string; assigned_to: string; due_at: string | null;
  status: "requested" | "completed" | "waived"; result: AssessmentResult | null; result_md: string | null; reference: string | null;
  completed_by: string | null; completed_at: string | null; waived_by: string | null; waived_reason: string | null; waived_at: string | null;
  stale: boolean; provided: boolean; created_at: string; updated_at: string;
}
const map = (r: any): Assessment => ({ ...r, stale: !!r.stale, provided: !!r.provided });
export const assessmentsOf = (reviewId: string): Assessment[] => (db.prepare("SELECT * FROM review_assessments WHERE review_id=? ORDER BY created_at, rowid").all(reviewId) as any[]).map(map);
export const assessmentById = (id: string): Assessment | null => { const r = db.prepare("SELECT * FROM review_assessments WHERE id=?").get(id); return r ? map(r) : null; };
export const openAssessmentsOf = (reviewId: string): Assessment[] => assessmentsOf(reviewId).filter((a) => a.status === "requested");
/** The display name of an assessment: its title, or its type's label. */
export const assessmentLabel = (a: Pick<Assessment, "type" | "title">) => a.title || ({ dpia: "DPIA", "clinical-safety": "Clinical safety", "ai-impact": "AI impact" } as Record<string, string>)[a.type] || a.type.charAt(0).toUpperCase() + a.type.slice(1);
export const withAssessmentNames = (a: Assessment) => ({ ...a, requested_by_name: userName(a.requested_by), assigned_to_name: userName(a.assigned_to), completed_by_name: userName(a.completed_by), waived_by_name: userName(a.waived_by) });

/** May this principal request (or reassign) an assessment on this review: a chair, decision-maker or reviewer seat on its board, never the submitter. */
export function canRequestAssessment(p: Principal | null, review: ReviewLike): Check {
  if (!p) return { ok: false, reason: "sign in required" };
  if (!ACTIVE_STAGES.includes(review.stage)) return { ok: false, reason: `review is ${review.stage}` };
  if (review.submitted_by === p.id) return { ok: false, reason: "a submitter does not request assessments of their own review; the board asks, the submitter provides" };
  const role = memberRole(p, review.board_id);
  if (role && ["chair", "decision_maker", "reviewer"].includes(role)) return { ok: true, role };
  return { ok: false, reason: role ? `the ${role} seat does not request assessments; the chair, a decision maker or a reviewer of ${boardById(review.board_id)?.code ?? "the board"} does` : "not a member of the board this review is routed to", ...(role ? { role } : {}) };
}

export interface RequestAssessmentBody { type: string; title?: string | null; area?: string | null; assigned_to: string; due_at?: string | null }
const err = (status: number, message: string) => Object.assign(new Error(message), { status });
/** The assessor must be someone who can act: a known user who is not an auditor or a service account. */
function checkAssignee(userId: string) {
  const u = getUser(userId);
  if (!u) throw err(400, `assigned_to: no user "${userId}" (create them under Settings · Users & access first)`);
  if (u.user_type === "auditor" || u.user_type === "service") throw err(400, `assigned_to: ${u.name} is ${u.user_type === "auditor" ? "an auditor" : "a service account"} and changes nothing; assign an author or a seat holder`);
  return u;
}
/** Request an assessment (after canRequestAssessment said yes): row, timeline event, audit. */
export function requestAssessment(review: ReviewLike & { code?: string }, p: Principal, b: RequestAssessmentBody, actor: string): Assessment {
  if (!(ASSESSMENT_TYPES as readonly string[]).includes(b.type)) throw err(400, `type must be one of ${ASSESSMENT_TYPES.join(", ")}`);
  if (b.type === "other" && !b.title?.trim()) throw err(400, "a custom assessment needs a title");
  if (b.area) { const ids = boardAreas(review.board_id).map((a) => a.id); if (!ids.length) throw err(400, "this board has no areas of responsibility"); if (!ids.includes(b.area)) throw err(400, `not an area of this board: ${b.area} (areas: ${ids.join(", ")})`); }
  if (b.due_at && Number.isNaN(Date.parse(b.due_at))) throw err(400, "due_at must be an ISO date");
  const assignee = checkAssignee(b.assigned_to);
  const id = uid(), now = nowIso(), sid = openSessionOf(review.id)?.id ?? null;
  db.prepare(`INSERT INTO review_assessments(id,review_id,type,title,area,requested_by,assigned_to,due_at,status,stale,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,0,?,?)`)
    .run(id, review.id, b.type, b.title?.trim() || null, b.area || null, p.id, assignee.id, b.due_at || null, "requested", now, now);
  const a = assessmentById(id)!;
  addEvent(review.id, "assessment_requested", actor, null, { assessment_id: id, type: a.type, title: a.title, area: a.area, assigned_to: a.assigned_to, due_at: a.due_at, board_role: memberRole(p, review.board_id) }, sid);
  audit(actor, "assessment:request", "reviews", review.id, { assessment_id: id, type: a.type, title: a.title, area: a.area, assigned_to: a.assigned_to, due_at: a.due_at });
  return a;
}
/** Reassign an open assessment or move its due date (the same seats that request). */
export function reassignAssessment(a: Assessment, review: ReviewLike, b: { assigned_to?: string; due_at?: string | null }, actor: string): Assessment {
  if (a.status !== "requested") throw err(409, `this assessment is ${a.status}`);
  const assignee = b.assigned_to ? checkAssignee(b.assigned_to) : null;
  if (b.due_at && Number.isNaN(Date.parse(b.due_at))) throw err(400, "due_at must be an ISO date");
  db.prepare("UPDATE review_assessments SET assigned_to=COALESCE(?, assigned_to), due_at=CASE WHEN ? THEN ? ELSE due_at END, updated_at=? WHERE id=?")
    .run(assignee?.id ?? null, b.due_at !== undefined ? 1 : 0, b.due_at ?? null, nowIso(), a.id);
  audit(actor, "assessment:reassign", "reviews", review.id, { assessment_id: a.id, assigned_to: assignee?.id ?? a.assigned_to, due_at: b.due_at === undefined ? a.due_at : b.due_at });
  return assessmentById(a.id)!;
}
/** Record the result (the assignee only, as themselves): the row, its timeline event, audit. */
export function recordAssessmentResult(a: Assessment, review: ReviewLike, p: Principal, b: { result: string; result_md: string; reference?: string | null }, actor: string): Assessment {
  if (a.status !== "requested") throw err(409, `this assessment is ${a.status}`);
  if (p.id !== a.assigned_to) throw err(403, `only the assessor records the result (assigned to ${userName(a.assigned_to)}); ask a requester seat to reassign it`);
  if (!(ASSESSMENT_RESULTS as readonly string[]).includes(b.result)) throw err(400, `result must be one of ${ASSESSMENT_RESULTS.join(", ")}`);
  if ((b.result_md || "").trim().length < 10) throw err(400, "a result summary of at least 10 characters is required");
  const now = nowIso(), sid = openSessionOf(review.id)?.id ?? null;
  db.prepare("UPDATE review_assessments SET status='completed', result=?, result_md=?, reference=?, completed_by=?, completed_at=?, updated_at=? WHERE id=?")
    .run(b.result, b.result_md.trim(), b.reference?.trim() || null, p.id, now, now, a.id);
  addEvent(review.id, "assessment_completed", actor, b.result_md.trim(), { assessment_id: a.id, type: a.type, title: a.title, area: a.area, result: b.result, reference: b.reference?.trim() || null }, sid);
  audit(actor, "assessment:result", "reviews", review.id, { assessment_id: a.id, type: a.type, result: b.result, reference: b.reference?.trim() || undefined });
  return assessmentById(a.id)!;
}
/** The chair waives an open request with a recorded reason (after isDecider said yes) — the same shape as resolving a conditional. */
export function waiveAssessment(a: Assessment, review: ReviewLike, p: Principal, reason: string, actor: string): Assessment {
  if (a.status !== "requested") throw err(409, `this assessment is ${a.status}`);
  if ((reason || "").trim().length < 10) throw err(400, "a reason of at least 10 characters is required to waive an assessment");
  const now = nowIso(), sid = openSessionOf(review.id)?.id ?? null;
  db.prepare("UPDATE review_assessments SET status='waived', waived_by=?, waived_reason=?, waived_at=?, updated_at=? WHERE id=?").run(p.id, reason.trim(), now, now, a.id);
  addEvent(review.id, "assessment_waived", actor, reason.trim(), { assessment_id: a.id, type: a.type, title: a.title, area: a.area, assigned_to: a.assigned_to }, sid);
  audit(actor, "assessment:waive", "reviews", review.id, { assessment_id: a.id, type: a.type, assigned_to: a.assigned_to });
  return assessmentById(a.id)!;
}
/** A resubmission marks completed results stale (recorded against an earlier version); open requests stand. */
export const markAssessmentsStale = (reviewId: string) => db.prepare("UPDATE review_assessments SET stale=1, updated_at=? WHERE review_id=? AND status='completed' AND stale=0").run(nowIso(), reviewId).changes;

export interface ProvideAssessmentBody { type: string; title?: string | null; area?: string | null; result: string; result_md: string; reference?: string | null }
/** May this principal provide an assessment on this review: its submitter, while it is still being decided. The board requests; the submitter provides. */
export function canProvideAssessment(p: Principal | null, review: ReviewLike): Check {
  if (!p) return { ok: false, reason: "sign in required" };
  if (!ACTIVE_STAGES.includes(review.stage)) return { ok: false, reason: `review is ${review.stage}` };
  if (review.submitted_by !== p.id) return { ok: false, reason: "only the review's submitter provides supporting assessments; a board seat requests one instead" };
  return { ok: true };
}
/**
 * The submitter attaches an assessment they already carried out — supporting information, recorded by its author.
 * It arrives completed (no open request), so it never blocks an outcome; the board reads it beside its own requests.
 */
export function provideAssessment(review: ReviewLike & { code?: string }, p: Principal, b: ProvideAssessmentBody, actor: string): Assessment {
  if (!(ASSESSMENT_TYPES as readonly string[]).includes(b.type)) throw err(400, `type must be one of ${ASSESSMENT_TYPES.join(", ")}`);
  if (b.type === "other" && !b.title?.trim()) throw err(400, "a custom assessment needs a title");
  if (b.area) { const ids = boardAreas(review.board_id).map((a) => a.id); if (!ids.includes(b.area)) throw err(400, `not an area of this board: ${b.area}`); }
  if (!(ASSESSMENT_RESULTS as readonly string[]).includes(b.result)) throw err(400, `result must be one of ${ASSESSMENT_RESULTS.join(", ")}`);
  if ((b.result_md || "").trim().length < 10) throw err(400, "a result summary of at least 10 characters is required");
  const id = uid(), now = nowIso(), sid = openSessionOf(review.id)?.id ?? null;
  db.prepare(`INSERT INTO review_assessments(id,review_id,type,title,area,requested_by,assigned_to,status,result,result_md,reference,completed_by,completed_at,provided,stale,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,0,?,?)`)
    .run(id, review.id, b.type, b.title?.trim() || null, b.area || null, p.id, p.id, "completed", b.result, b.result_md.trim(), b.reference?.trim() || null, p.id, now, now, now);
  const a = assessmentById(id)!;
  addEvent(review.id, "assessment_provided", actor, b.result_md.trim(), { assessment_id: id, type: a.type, title: a.title, area: a.area, result: a.result, reference: a.reference }, sid);
  audit(actor, "assessment:provide", "reviews", review.id, { assessment_id: id, type: a.type, title: a.title, result: a.result });
  return a;
}
/** The submitter keeps their provided assessment current while the review is active; an update re-affirms it (stale clears). */
export function updateProvidedAssessment(a: Assessment, review: ReviewLike, p: Principal, b: Partial<ProvideAssessmentBody>, actor: string): Assessment {
  if (!a.provided) throw err(409, "only a submitter-provided assessment is edited; a board-requested result stands as recorded");
  if (!ACTIVE_STAGES.includes(review.stage)) throw err(409, `review is ${review.stage}`);
  if (p.id !== a.completed_by) throw err(403, `only its author updates a provided assessment (provided by ${userName(a.completed_by)})`);
  const result = b.result !== undefined ? String(b.result) : a.result!;
  if (!(ASSESSMENT_RESULTS as readonly string[]).includes(result)) throw err(400, `result must be one of ${ASSESSMENT_RESULTS.join(", ")}`);
  const result_md = b.result_md !== undefined ? String(b.result_md).trim() : a.result_md!;
  if (result_md.length < 10) throw err(400, "a result summary of at least 10 characters is required");
  const reference = b.reference !== undefined ? String(b.reference || "").trim() || null : a.reference;
  const now = nowIso(), sid = openSessionOf(review.id)?.id ?? null;
  db.prepare("UPDATE review_assessments SET result=?, result_md=?, reference=?, stale=0, updated_at=? WHERE id=?").run(result, result_md, reference, now, a.id);
  addEvent(review.id, "assessment_updated", actor, result_md, { assessment_id: a.id, type: a.type, title: a.title, result }, sid);
  audit(actor, "assessment:update", "reviews", review.id, { assessment_id: a.id, type: a.type, result });
  return assessmentById(a.id)!;
}
/** May this principal waive assessments on this review: its chair (or acting chair), while it is still being decided. */
export function canWaiveAssessment(p: Principal | null, review: ReviewLike): Check {
  if (!p) return { ok: false, reason: "sign in required" };
  if (!ACTIVE_STAGES.includes(review.stage)) return { ok: false, reason: `review is ${review.stage}` };
  if (review.submitted_by === p.id) return { ok: false, reason: "a submitter cannot waive assessments on their own review" };
  return isDecider(p, review);
}

/*
 * Decision-attached assessments: the AUTHOR of a proposed decision gathers the evidence its argument needs before
 * submitting it for review — trigger an assessment (requested, completed by its assessor) or provide one already
 * done. They anchor to decision_id, never block anything (blocking stays with board-requested review assessments),
 * and surface on the decision's review as "on the decision" so the association is tracked end to end.
 */
export interface DecisionLike { id: string; code?: string; status: string; author: string }
export const assessmentsOfDecision = (decisionId: string): Assessment[] => (db.prepare("SELECT * FROM review_assessments WHERE decision_id=? ORDER BY created_at, rowid").all(decisionId) as any[]).map(map);
const checkDecisionAuthor = (p: Principal, d: DecisionLike, verb: string) => {
  if (d.status !== "proposed") throw err(409, `the decision is ${d.status}; evidence is gathered while it is proposed`);
  if (p.id !== d.author) throw err(403, `only the decision's author ${verb} its assessments (authored by ${userName(d.author)})`);
};
/** Trigger an assessment on a proposed decision: requested, assigned (to the author by default), completed by its assessor. */
export function requestDecisionAssessment(decision: DecisionLike, p: Principal, b: { type: string; title?: string | null; assigned_to?: string | null; due_at?: string | null }, actor: string): Assessment {
  checkDecisionAuthor(p, decision, "triggers");
  if (!(ASSESSMENT_TYPES as readonly string[]).includes(b.type)) throw err(400, `type must be one of ${ASSESSMENT_TYPES.join(", ")}`);
  if (b.type === "other" && !b.title?.trim()) throw err(400, "a custom assessment needs a title");
  const assignee = checkAssignee(b.assigned_to?.trim() || p.id);
  const id = uid(), now = nowIso();
  db.prepare(`INSERT INTO review_assessments(id,decision_id,type,title,requested_by,assigned_to,due_at,status,provided,stale,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'requested',0,0,?,?)`)
    .run(id, decision.id, b.type, b.title?.trim() || null, p.id, assignee.id, b.due_at || null, now, now);
  audit(actor, "assessment:request", "decisions", decision.id, { assessment_id: id, type: b.type, assigned_to: assignee.id });
  return assessmentById(id)!;
}
/** The assessor records the result of a decision-attached assessment; same discipline as on a review, audited on the decision. */
export function recordDecisionAssessmentResult(a: Assessment, decision: DecisionLike, p: Principal, b: { result: string; result_md: string; reference?: string | null }, actor: string): Assessment {
  if (a.status !== "requested") throw err(409, `this assessment is ${a.status}`);
  if (p.id !== a.assigned_to) throw err(403, `only the assessor records the result (assigned to ${userName(a.assigned_to)})`);
  if (!(ASSESSMENT_RESULTS as readonly string[]).includes(b.result)) throw err(400, `result must be one of ${ASSESSMENT_RESULTS.join(", ")}`);
  if ((b.result_md || "").trim().length < 10) throw err(400, "a result summary of at least 10 characters is required");
  const now = nowIso();
  db.prepare("UPDATE review_assessments SET status='completed', result=?, result_md=?, reference=?, completed_by=?, completed_at=?, updated_at=? WHERE id=?")
    .run(b.result, b.result_md.trim(), b.reference?.trim() || null, p.id, now, now, a.id);
  audit(actor, "assessment:result", "decisions", decision.id, { assessment_id: a.id, type: a.type, result: b.result, reference: b.reference?.trim() || undefined });
  return assessmentById(a.id)!;
}
/** The author attaches evidence already gathered: arrives completed under their name, never blocks. */
export function provideDecisionAssessment(decision: DecisionLike, p: Principal, b: ProvideAssessmentBody, actor: string): Assessment {
  checkDecisionAuthor(p, decision, "provides");
  if (!(ASSESSMENT_TYPES as readonly string[]).includes(b.type)) throw err(400, `type must be one of ${ASSESSMENT_TYPES.join(", ")}`);
  if (b.type === "other" && !b.title?.trim()) throw err(400, "a custom assessment needs a title");
  if (!(ASSESSMENT_RESULTS as readonly string[]).includes(b.result)) throw err(400, `result must be one of ${ASSESSMENT_RESULTS.join(", ")}`);
  if ((b.result_md || "").trim().length < 10) throw err(400, "a result summary of at least 10 characters is required");
  const id = uid(), now = nowIso();
  db.prepare(`INSERT INTO review_assessments(id,decision_id,type,title,requested_by,assigned_to,status,result,result_md,reference,completed_by,completed_at,provided,stale,created_at,updated_at)
    VALUES (?,?,?,?,?,?,'completed',?,?,?,?,?,1,0,?,?)`)
    .run(id, decision.id, b.type, b.title?.trim() || null, p.id, p.id, b.result, b.result_md.trim(), b.reference?.trim() || null, p.id, now, now, now);
  audit(actor, "assessment:provide", "decisions", decision.id, { assessment_id: id, type: b.type, result: b.result });
  return assessmentById(id)!;
}

/** The author keeps a decision-attached provided assessment current while the decision is proposed. */
export function updateProvidedDecisionAssessment(a: Assessment, decision: DecisionLike, p: Principal, b: Partial<ProvideAssessmentBody>, actor: string): Assessment {
  if (!a.provided) throw err(409, "only a provided assessment is edited; a recorded result stands");
  if (decision.status !== "proposed") throw err(409, `the decision is ${decision.status}`);
  if (p.id !== a.completed_by) throw err(403, `only its author updates a provided assessment (provided by ${userName(a.completed_by)})`);
  const result = b.result !== undefined ? String(b.result) : a.result!;
  if (!(ASSESSMENT_RESULTS as readonly string[]).includes(result)) throw err(400, `result must be one of ${ASSESSMENT_RESULTS.join(", ")}`);
  const result_md = b.result_md !== undefined ? String(b.result_md).trim() : a.result_md!;
  if (result_md.length < 10) throw err(400, "a result summary of at least 10 characters is required");
  const reference = b.reference !== undefined ? String(b.reference || "").trim() || null : a.reference;
  db.prepare("UPDATE review_assessments SET result=?, result_md=?, reference=?, stale=0, updated_at=? WHERE id=?").run(result, result_md, reference, nowIso(), a.id);
  audit(actor, "assessment:update", "decisions", decision.id, { assessment_id: a.id, type: a.type, result });
  return assessmentById(a.id)!;
}
