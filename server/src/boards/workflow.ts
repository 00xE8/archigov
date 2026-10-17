import { db, j, uid, nowIso, audit } from "../db.js";
import { normaliseBoardRole, seatHas, capabilitiesFor, APPROVING_ROLES, DECIDING_ROLES, type BoardRole, type Capability } from "../auth/roles.js";
import type { Principal } from "../auth/context.js";
import { boardAreas, touchedAreas, areaLabel, memberAreas } from "./areas.js";
import { fastLaneOf, normaliseFastLane, type FastLane, type FastLanePolicy } from "./fastlane.js";
import { resourcesOf } from "../model.js";

/**
 * Boards, routing and the approval workflow.
 *
 * A review is routed to one board when it is created (board_routing). Every rule names a review type; the most specific
 * matching rule wins — an application condition (the applications listed, or every application whose resources carry
 * the rule's owner tag; all of the review's applications must be covered) outweighs an artefact kind, which outweighs a
 * category — and priority breaks ties, lowest first. The board coded DA is the fallback. The board's approval
 * policy for that review type is a list of steps: pre_review (automatic), approvals and decision (who may
 * declare the outcome: the chair). An approvals step runs in one of two modes:
 *   count  `min` distinct `yes` positions from seats holding one of the listed roles (chair or decision_maker; a
 *          reviewer seat is advisory and may only send the review back);
 *   areas  one `yes` (or resolved conditional) per area the review touches, from the decision maker who owns that
 *          area on the board — or their delegate for the session. The chair has no vote: the chair declares the
 *          outcome the positions allow, resolves conditionals and can always send an item back.
 * A review is "satisfied" when every approvals step is met by positions recorded after the latest (re)submission
 * and no `no` is live; only then may a decision-step seat declare it approved. Positions are never deleted: a
 * resubmission (or a referral to another board) supersedes them, so the audit trail keeps what was said about
 * the earlier version.
 *
 * A design policy may offer a fast lane (boards/fastlane.ts): a low-risk review that follows adopted patterns and
 * passes every deterministic check is satisfied without positions, so the chair may declare it at once; any `no` or
 * open conditional takes it out of the lane again.
 */
export const REVIEW_TYPES = ["design", "decision", "standard", "principle", "pattern", "policy", "exception"] as const;
export type ReviewType = (typeof REVIEW_TYPES)[number];
export const ARTEFACT_TYPES: ReviewType[] = ["standard", "principle", "pattern", "policy"];
export const isReviewType = (v: unknown): v is ReviewType => typeof v === "string" && (REVIEW_TYPES as readonly string[]).includes(v);
/** Stages in which a review is open for positions / a decision. */
export const OPEN_STAGES = ["submitted", "pre_review", "in_review"];
/** An approved outcome waiting on something before it takes effect (dependencies decided, circulation complete). */
export const PENDING_STAGES = ["approved_pending_dependencies", "approved_subject_to_circulation"];
/** Stages a review never leaves again (positions on it are frozen once its session has closed). */
export const FINAL_STAGES = ["approved", "approved_with_conditions", "rejected", "withdrawn", "approved_pending_dependencies"];
export const OUTCOMES = ["approved", "approved_with_conditions", "approved_subject_to_circulation", "changes_requested", "deferred", "referred", "rejected", "withdrawn"] as const;
export type Outcome = (typeof OUTCOMES)[number];
export const POSITIONS = ["yes", "no", "conditional", "not_my_area"] as const;
export type PositionValue = (typeof POSITIONS)[number];
export const RESOLUTIONS = ["accepted_condition", "addressed", "dependent_decision"] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

export type PolicyMode = "count" | "areas";
export interface PolicyStep { name: string; kind: "pre_review" | "approvals" | "decision"; mode?: PolicyMode; min?: number; roles?: BoardRole[] }
export interface Policy { steps: PolicyStep[]; fast_lane?: FastLanePolicy }
export const DEFAULT_POLICY: Policy = { steps: [
  { name: "Automatic pre-review", kind: "pre_review" },
  { name: "Board approval", kind: "approvals", mode: "count", min: 1, roles: ["decision_maker", "chair"] },
  { name: "Chair decision", kind: "decision", roles: ["chair"] },
] };

export interface BoardRow { id: string; code: string; name: string; purpose: string | null; created_at: string; areas_json?: string }
export const boardById = (id: string | null | undefined) => (id ? (db.prepare("SELECT * FROM boards WHERE id=?").get(id) as BoardRow | undefined) ?? null : null);
export const boardByCode = (code: string) => (db.prepare("SELECT * FROM boards WHERE code=?").get(code.toUpperCase()) as BoardRow | undefined) ?? null;
export const boardSummary = (b: BoardRow | null) => (b ? { id: b.id, code: b.code, name: b.name } : null);

/** Validate a policy document; throws with a readable message. Old seat names ("member") are normalised, unknown ones dropped. */
export function normalisePolicy(input: any): Policy {
  const steps = Array.isArray(input?.steps) ? input.steps : null;
  if (!steps || !steps.length) throw new Error("policy needs a non-empty steps array");
  const out: PolicyStep[] = steps.map((s: any, i: number) => {
    if (!s || !["pre_review", "approvals", "decision"].includes(s.kind)) throw new Error(`step ${i + 1}: kind must be pre_review, approvals or decision`);
    const mode: PolicyMode | undefined = s.kind === "approvals" ? (s.mode === "areas" ? "areas" : "count") : undefined;
    let roles: BoardRole[] | undefined = Array.isArray(s.roles) ? [...new Set((s.roles as unknown[]).map(normaliseBoardRole).filter((r): r is BoardRole => !!r))] : undefined;
    // in areas mode the positions come from the decision makers owning the areas unless the policy says otherwise
    if (mode === "areas" && (!roles || !roles.length)) roles = ["decision_maker"];
    if (s.kind !== "pre_review" && (!roles || !roles.length)) throw new Error(`step ${i + 1}: ${s.kind} needs at least one board role`);
    if (s.kind === "approvals") { const bad = roles!.filter((r) => !APPROVING_ROLES.includes(r)); if (bad.length) throw new Error(`step ${i + 1}: the ${bad.join(", ")} seat does not approve; approvals come from ${APPROVING_ROLES.join(" or ")} (a reviewer is advisory)`); }
    if (s.kind === "decision") { const bad = roles!.filter((r) => !DECIDING_ROLES.includes(r)); if (bad.length) throw new Error(`step ${i + 1}: the ${bad.join(", ")} seat does not decide; only ${DECIDING_ROLES.join(" or ")}`); }
    const min = mode === "count" ? Math.max(1, Number(s.min) || 1) : undefined;
    return { name: String(s.name || s.kind).slice(0, 120), kind: s.kind, ...(mode ? { mode } : {}), ...(min !== undefined ? { min } : {}), ...(roles ? { roles } : {}) };
  });
  if (!out.some((s) => s.kind === "decision")) throw new Error("policy needs a decision step");
  const fast_lane = normaliseFastLane(input?.fast_lane);
  return { steps: out, ...(fast_lane ? { fast_lane } : {}) };
}
const parsePolicy = (json: string): Policy => { try { return normalisePolicy(j(json, null)); } catch { return DEFAULT_POLICY; } };

/** The routing decision for a would-be review. Most specific match first (type+kind+category > type+kind > type+category > type), then priority. */
/** The owner tags on an application's resources, lower-cased: what a routing rule's owner condition matches. */
export const applicationOwners = (applicationId: string): Set<string> =>
  new Set(resourcesOf(applicationId).map((r) => String(r.tags?.owner || r.tags?.Owner || "").trim().toLowerCase()).filter(Boolean));

/** The board a new review goes to. `applicationIds` are the applications the review is for: a design's or an
 *  exception's application, or every application a decision applies to (none for a catalogue review). */
export function routeBoard(type: ReviewType, kind?: string | null, category?: string | null, applicationIds: string[] = []): BoardRow | null {
  const rules = db.prepare("SELECT r.*, b.code board_code FROM board_routing r JOIN boards b ON b.id=r.board_id WHERE r.review_type=? ORDER BY r.priority").all(type) as any[];
  const k = (kind || "").toLowerCase(), cat = (category || "").toLowerCase();
  const apps = Array.from(new Set(applicationIds.filter(Boolean)));
  const owners = new Map<string, Set<string>>();
  const ownersOf = (id: string) => { if (!owners.has(id)) owners.set(id, applicationOwners(id)); return owners.get(id)!; };
  // null: the rule has no application condition; otherwise whether it covers every application of the review
  const covers = (r: any): boolean | null => {
    const ids: string[] = j(r.application_ids_json, []) || [], owner = String(r.owner || "").trim().toLowerCase();
    if (!ids.length && !owner) return null;
    return apps.length > 0 && apps.every((a) => ids.includes(a) || (!!owner && ownersOf(a).has(owner)));
  };
  const score = (r: any) => {
    const rk = (r.kind || "").toLowerCase(), rc = (r.category || "").toLowerCase();
    if ((rk && rk !== k) || (rc && rc !== cat)) return -1;
    const c = covers(r); if (c === false) return -1;
    return (c ? 4 : 0) + (rk ? 2 : 0) + (rc ? 1 : 0);
  };
  let best: any = null, bestScore = -1;
  for (const r of rules) { const s = score(r); if (s > bestScore) { best = r; bestScore = s; } }
  return best ? boardById(best.board_id) : boardByCode("DA");
}

export function policyFor(boardId: string | null | undefined, type: ReviewType): Policy {
  if (!boardId) return DEFAULT_POLICY;
  const row = db.prepare("SELECT policy_json FROM approval_policies WHERE board_id=? AND review_type=?").get(boardId, type) as any;
  return row ? parsePolicy(row.policy_json) : DEFAULT_POLICY;
}
export const policiesOf = (boardId: string) => Object.fromEntries((db.prepare("SELECT review_type, policy_json FROM approval_policies WHERE board_id=?").all(boardId) as any[]).map((r) => [r.review_type, parsePolicy(r.policy_json)]));

export interface ReviewLike {
  id: string; type: string; stage: string; board_id: string | null; submitted_by: string | null; created_at: string; resubmitted_at?: string | null;
  areas_json?: string | null; application_id?: string | null; design_md?: string | null; target_kind?: string | null; target_id?: string | null; decision_id?: string | null; session_id?: string | null;
  risk_tier?: string | null; patterns_json?: string | null;
}
export interface Position {
  id: string; review_id: string; session_id: string | null; user_id: string; board_role: BoardRole; on_behalf_of: string | null; delegation_id: string | null;
  area: string | null; position: PositionValue; text: string | null; at: string; superseded: boolean;
  resolution: Resolution | null; resolution_text: string | null; resolved_by: string | null; resolved_at: string | null; resolution_ref: string | null;
}
const mapPosition = (p: any): Position => ({ ...p, board_role: normaliseBoardRole(p.board_role) ?? p.board_role, superseded: !!p.superseded });
export const positionsOf = (reviewId: string): Position[] => (db.prepare("SELECT * FROM review_positions WHERE review_id=? ORDER BY at, rowid").all(reviewId) as any[]).map(mapPosition);
export const positionById = (id: string): Position | null => { const r = db.prepare("SELECT * FROM review_positions WHERE id=?").get(id); return r ? mapPosition(r) : null; };
export const livePositions = (reviewId: string) => positionsOf(reviewId).filter((p) => !p.superseded);
/** The old approvals shape, for GET /reviews/:id.approvals: yes → approve, no → request_changes (other positions have no old equivalent). */
export interface Approval { id: string; review_id: string; user_id: string; board_role: BoardRole; decision: "approve" | "request_changes"; comment: string | null; at: string; superseded: boolean; area: string | null; on_behalf_of: string | null; position: PositionValue }
export const approvalsOf = (reviewId: string): Approval[] => positionsOf(reviewId).filter((p) => p.position === "yes" || p.position === "no")
  .map((p) => ({ id: p.id, review_id: p.review_id, user_id: p.user_id, board_role: p.board_role, decision: p.position === "yes" ? "approve" : "request_changes", comment: p.text, at: p.at, superseded: p.superseded, area: p.area, on_behalf_of: p.on_behalf_of, position: p.position }));

export function memberRole(p: Principal | null | undefined, boardId: string | null | undefined): BoardRole | null {
  if (!p || !boardId) return null;
  return p.boards.find((b) => b.id === boardId)?.role ?? null;
}
const roleOnBoard = (userId: string, boardId: string): BoardRole | null => normaliseBoardRole((db.prepare("SELECT board_role FROM board_members WHERE board_id=? AND user_id=?").get(boardId, userId) as any)?.board_role);

// ---------- sessions (the queries the workflow needs; the session lifecycle lives in boards/sessions.ts) ----------
export interface SessionRow { id: string; code: string; board_id: string; title: string | null; scheduled_at: string; status: "planned" | "open" | "closed"; created_by: string; opened_by: string | null; opened_at: string | null; closed_by: string | null; closed_at: string | null; notes_md: string | null; minutes_json: string | null; minutes_hash: string | null; created_at: string; updated_at: string }
export interface SessionItem { session_id: string; review_id: string; position: number; consent: number; state: "listed" | "called" | "declared" | "deferred" | "withdrawn"; acting_chair: string | null; called_at: string | null; outcome: string | null; declared_at: string | null; note: string | null }
export interface Delegation { id: string; session_id: string; delegator: string; delegate: string; areas: string[]; recorded_by: string; on_instruction: boolean; created_at: string; revoked_at: string | null; revoked_by: string | null }
export const sessionById = (id: string | null | undefined): SessionRow | null => (id ? ((db.prepare("SELECT * FROM board_sessions WHERE id=?").get(id) as SessionRow | undefined) ?? null) : null);
/** The open session this review sits on (any item state), if any. */
export const openSessionOf = (reviewId: string): SessionRow | null => (db.prepare("SELECT s.* FROM session_items i JOIN board_sessions s ON s.id=i.session_id WHERE i.review_id=? AND s.status='open' LIMIT 1").get(reviewId) as SessionRow | undefined) ?? null;
/** The planned or open session this review is listed on (open first). */
export const listedSessionOf = (reviewId: string): SessionRow | null => (db.prepare("SELECT s.* FROM session_items i JOIN board_sessions s ON s.id=i.session_id WHERE i.review_id=? AND s.status IN ('planned','open') ORDER BY CASE s.status WHEN 'open' THEN 0 ELSE 1 END, s.scheduled_at LIMIT 1").get(reviewId) as SessionRow | undefined) ?? null;
export const itemOf = (sessionId: string, reviewId: string): SessionItem | null => (db.prepare("SELECT * FROM session_items WHERE session_id=? AND review_id=?").get(sessionId, reviewId) as SessionItem | undefined) ?? null;
const mapDelegation = (d: any): Delegation => ({ ...d, areas: j(d.areas_json, []), on_instruction: !!d.on_instruction });
export const liveDelegations = (sessionId: string): Delegation[] => (db.prepare("SELECT * FROM session_delegations WHERE session_id=? AND revoked_at IS NULL ORDER BY created_at").all(sessionId) as any[]).map(mapDelegation);
export const delegationsOf = (sessionId: string): Delegation[] => (db.prepare("SELECT * FROM session_delegations WHERE session_id=? ORDER BY created_at").all(sessionId) as any[]).map(mapDelegation);
export const presentUsers = (sessionId: string): Set<string> => new Set((db.prepare("SELECT user_id FROM session_attendance WHERE session_id=? AND status='present'").all(sessionId) as any[]).map((r) => r.user_id));
/** The closed session that declared this review, when its outcome is final: positions on it are frozen. */
export function frozenBy(review: ReviewLike): SessionRow | null {
  if (!review.session_id || !FINAL_STAGES.includes(review.stage)) return null;
  const s = sessionById(review.session_id);
  return s && s.status === "closed" ? s : null;
}

/** Decision makers who own an area on a board, plus — while the session is open — delegates holding it for one of them. */
export interface Owner { user_id: string; on_behalf_of: string | null; delegation_id: string | null }
export function ownersOf(boardId: string | null | undefined, area: string, session: SessionRow | null): Owner[] {
  if (!boardId) return [];
  const members = db.prepare("SELECT user_id, areas_json FROM board_members WHERE board_id=? AND board_role IN ('decision_maker','member')").all(boardId) as any[];
  const own: Owner[] = members.filter((m) => (j(m.areas_json, []) || []).includes(area)).map((m) => ({ user_id: m.user_id, on_behalf_of: null, delegation_id: null }));
  if (session?.status === "open") for (const d of liveDelegations(session.id)) if (d.areas.includes(area) && own.some((o) => o.user_id === d.delegator && !o.on_behalf_of)) own.push({ user_id: d.delegate, on_behalf_of: d.delegator, delegation_id: d.id });
  return own;
}

// ---------- progress ----------
export type AreaStateValue = "missing" | "yes" | "no" | "conditional" | "resolved" | "not_my_area";
export interface AreaState { area: string; label: string; state: AreaStateValue; by: string | null; on_behalf_of: string | null; text: string | null; position_id: string | null; resolution: Resolution | null; owners: string[] }
export interface ProgressStep { name: string; kind: PolicyStep["kind"]; mode?: PolicyMode; min?: number; roles?: BoardRole[]; received: number; satisfied: boolean; approvers: string[] }
export type Outstanding = { step: string; missing: number; roles: BoardRole[] } | { area: string; label: string; owners: string[] };
/** A reviewer's send-back in areas mode: a `no` held on no area — it blocks like any no, never counts as an approval. */
export interface AdvisoryObjection { by: string; board_role: BoardRole; text: string | null; at: string; position_id: string }
export interface Progress {
  mode: PolicyMode; required: number; received: number; satisfied: boolean; changes_requested: boolean; blocked: boolean; open_conditionals: number; open_assessments: number; ready: boolean;
  steps: ProgressStep[]; outstanding: Outstanding[]; areas: AreaState[]; advisory_objections: AdvisoryObjection[];
  /** the board's fast lane for this review (null when not offered); via_fast_lane: satisfied by the lane, not by positions */
  fast_lane: FastLane | null; via_fast_lane: boolean;
}
/** Requested assessments still open on a review: they block the approving outcomes until recorded or waived (boards/assessments.ts). */
const openAssessmentRows = (reviewId: string) => db.prepare("SELECT type, title FROM review_assessments WHERE review_id=? AND status='requested' ORDER BY created_at").all(reviewId) as { type: string; title: string | null }[];
/** Which mode this review runs in: the policy's approvals step says areas AND the board has areas AND the review touches some; otherwise count. */
export function modeOf(review: ReviewLike): { mode: PolicyMode; policy: Policy; step: PolicyStep | undefined; touched: string[] } {
  const policy = policyFor(review.board_id, review.type as ReviewType);
  const step = policy.steps.find((s) => s.kind === "approvals");
  const touched = step?.mode === "areas" && boardAreas(review.board_id).length ? touchedAreas(review) : [];
  return { mode: step?.mode === "areas" && touched.length ? "areas" : "count", policy, step, touched };
}
// resolved sits with yes in the spec's precedence; it is shown first because it carries the condition and how the chair resolved it
const STATE_RANK: Record<AreaStateValue, number> = { no: 6, conditional: 5, resolved: 4, yes: 3, not_my_area: 2, missing: 1 };
const stateOfPosition = (p: Position): AreaStateValue => p.position === "conditional" ? (p.resolution ? "resolved" : "conditional") : p.position;
/** The state of one touched area from its live positions: no > conditional > resolved/yes > not_my_area > missing; ties go to the latest position. */
export function areaStateOf(area: string, live: Position[], review: ReviewLike, session: SessionRow | null): AreaState {
  let best: Position | null = null;
  for (const p of live) {
    if (p.area !== area) continue;
    if (!best || STATE_RANK[stateOfPosition(p)] > STATE_RANK[stateOfPosition(best)] || (STATE_RANK[stateOfPosition(p)] === STATE_RANK[stateOfPosition(best)] && p.at >= best.at)) best = p;
  }
  return { area, label: areaLabel(area, boardAreas(review.board_id)), state: best ? stateOfPosition(best) : "missing", by: best?.user_id ?? null, on_behalf_of: best?.on_behalf_of ?? null, text: best?.text ?? null,
    position_id: best?.id ?? null, resolution: best?.resolution ?? null, owners: [...new Set(ownersOf(review.board_id, area, session).map((o) => o.user_id))] };
}
/** Where a review stands against its board's policy, counting only live positions (not superseded by a resubmission). */
export function approvalProgress(review: ReviewLike): Progress {
  const base = positionProgress(review);
  const fast_lane = OPEN_STAGES.includes(review.stage) || review.stage === "changes_requested" ? fastLaneOf(review, modeOf(review).policy) : null;
  if (!fast_lane?.eligible || base.satisfied) return { ...base, fast_lane, via_fast_lane: false };
  // eligibility already rules out a live no, an open conditional and an open assessment: the chair may declare now
  return { ...base, satisfied: true, ready: OPEN_STAGES.includes(review.stage), fast_lane, via_fast_lane: true };
}
function positionProgress(review: ReviewLike): Omit<Progress, "fast_lane" | "via_fast_lane"> {
  const { mode, policy, touched } = modeOf(review);
  const live = livePositions(review.id);
  const open_assessments = openAssessmentRows(review.id).length;
  if (mode === "count") {
    const changes = live.some((a) => a.position === "no");
    let required = 0, received = 0;
    const steps: ProgressStep[] = policy.steps.map((s) => {
      if (s.kind !== "approvals") return { name: s.name, kind: s.kind, roles: s.roles, received: 0, satisfied: true, approvers: [] as string[] };
      const approvers = [...new Set(live.filter((a) => a.position === "yes" && (s.roles || []).includes(a.board_role)).map((a) => a.user_id))];
      const min = s.min || 1; required += min; received += Math.min(min, approvers.length);
      return { name: s.name, kind: s.kind, mode: "count", min, roles: s.roles, received: approvers.length, satisfied: approvers.length >= min, approvers };
    });
    const outstanding: Outstanding[] = steps.filter((s) => s.kind === "approvals" && !s.satisfied).map((s) => ({ step: s.name, missing: (s.min || 1) - s.received, roles: s.roles || [] }));
    const satisfied = !changes && outstanding.length === 0;
    return { mode, required, received, satisfied, changes_requested: changes, blocked: changes, open_conditionals: 0, open_assessments, ready: satisfied && open_assessments === 0 && OPEN_STAGES.includes(review.stage), steps, outstanding, areas: [], advisory_objections: [] };
  }
  const session = openSessionOf(review.id);
  const areas = touched.map((a) => areaStateOf(a, live, review, session));
  const required = areas.filter((a) => a.state !== "not_my_area").length;
  const received = areas.filter((a) => a.state === "yes" || a.state === "resolved").length;
  const advisory_objections: AdvisoryObjection[] = live.filter((x) => x.area === null && x.position === "no").map((x) => ({ by: x.user_id, board_role: x.board_role, text: x.text, at: x.at, position_id: x.id }));
  const blocked = areas.some((a) => a.state === "no") || advisory_objections.length > 0;
  const open_conditionals = areas.filter((a) => a.state === "conditional").length;
  const satisfied = received === required && !blocked && open_conditionals === 0;
  const approvers = [...new Set(areas.filter((a) => a.state === "yes" || a.state === "resolved").map((a) => a.by!).filter(Boolean))];
  const steps: ProgressStep[] = policy.steps.map((s) => s.kind !== "approvals" ? { name: s.name, kind: s.kind, roles: s.roles, received: 0, satisfied: true, approvers: [] as string[] }
    : { name: s.name, kind: s.kind, mode: "areas", min: required, roles: s.roles, received, satisfied, approvers });
  const outstanding: Outstanding[] = areas.filter((a) => a.state === "missing").map((a) => ({ area: a.area, label: a.label, owners: a.owners }));
  // ready = the chair could declare it approved now: satisfied, no open assessment, and still open (a sent-back item keeps its positions until resubmission)
  return { mode, required, received, satisfied, changes_requested: blocked, blocked, open_conditionals, open_assessments, ready: satisfied && open_assessments === 0 && OPEN_STAGES.includes(review.stage), steps, outstanding, areas, advisory_objections };
}

const approvalRoles = (policy: Policy) => [...new Set(policy.steps.filter((s) => s.kind === "approvals").flatMap((s) => s.roles || []))];
const decisionRoles = (policy: Policy) => [...new Set(policy.steps.filter((s) => s.kind === "decision").flatMap((s) => s.roles || []))];

export interface Check { ok: boolean; reason?: string; role?: BoardRole; mode?: PolicyMode; on_behalf_of?: string | null; delegation_id?: string | null; acting?: boolean; area?: string | null }
const NOT_MEMBER = "not a member of the board this review is routed to";

/**
 * May this principal record a position on this review — for `area` in areas mode, with `area` null in count mode —
 * and if not, why. Owners are decision makers holding the area (or, in count mode, any seat the step lists) and,
 * while the review sits on an open session, the delegates holding it for them. The chair has no vote in areas mode.
 */
export function canRecordPosition(p: Principal | null, review: ReviewLike, area: string | null): Check {
  if (!p) return { ok: false, reason: "sign in required" };
  const { mode, policy, touched } = modeOf(review);
  const bAreas = boardAreas(review.board_id);
  const label = (a: string) => areaLabel(a, bAreas);
  if (!OPEN_STAGES.includes(review.stage)) {
    if (review.stage === "approved_subject_to_circulation" && mode === "areas" && area) {
      const st = areaStateOf(area, livePositions(review.id), review, openSessionOf(review.id)).state;
      if (st !== "missing") return { ok: false, reason: `${label(area)} already has a position (${st}); circulation only fills the areas that were absent` };
    } else if (review.stage === "changes_requested") return { ok: false, reason: "changes were requested; the submitter must resubmit before new positions are recorded" };
    else return { ok: false, reason: `review is ${review.stage}` };
  }
  if (review.submitted_by === p.id) return { ok: false, reason: "a submitter cannot record a position on their own review" };
  const role = memberRole(p, review.board_id);
  const session = openSessionOf(review.id);
  const mine = session ? liveDelegations(session.id).filter((d) => d.delegate === p.id) : [];
  if (mode === "count") {
    const roles = approvalRoles(policy);
    if (role && seatHas(role, "approve_review") && roles.includes(role)) return { ok: true, role, mode };
    for (const d of mine) { const dr = roleOnBoard(d.delegator, review.board_id!); if (dr && roles.includes(dr)) return { ok: true, role: dr, mode, on_behalf_of: d.delegator, delegation_id: d.id }; }
    if (!role) return { ok: false, reason: NOT_MEMBER };
    if (!seatHas(role, "approve_review")) return { ok: false, reason: role === "reviewer" ? "the reviewer seat is advisory: it may request changes, but its approval does not count" : `the ${role} seat does not approve reviews`, role };
    return { ok: false, reason: `the ${role} seat does not approve ${review.type} reviews on this board (needs ${roles.join(" or ")})`, role };
  }
  if (!area) return { ok: false, reason: `an area is required: positions on this review are recorded per area (${touched.map(label).join(", ")})`, role: role ?? undefined };
  if (!touched.includes(area)) return { ok: false, reason: `this review does not touch ${label(area)} (it touches ${touched.map(label).join(", ")})`, role: role ?? undefined };
  if (role === "decision_maker" && memberAreas(review.board_id!, p.id).includes(area)) return { ok: true, role, mode };
  for (const d of mine) if (d.areas.includes(area) && memberAreas(review.board_id!, d.delegator).includes(area)) return { ok: true, role: "decision_maker", mode, on_behalf_of: d.delegator, delegation_id: d.id };
  const who = touched.map((a) => `${label(a)}: ${[...new Set(ownersOf(review.board_id, a, session).map((o) => o.user_id))].join(", ") || "nobody"}`).join("; ");
  if (role === "chair") return { ok: false, reason: `the chair has no vote in areas mode: positions come from the decision makers owning the touched areas (${who}); the chair declares the outcome they allow`, role };
  if (role === "reviewer") return { ok: false, reason: `the reviewer seat is advisory: it comments and pre-reviews, but positions come from the decision makers owning the touched areas (${who})`, role };
  if (role === "decision_maker") { const own = memberAreas(review.board_id!, p.id).filter((a) => touched.includes(a)); return { ok: false, reason: own.length ? `you do not own ${label(area)} on this board (you own ${own.map(label).join(", ")}; ${who})` : `you own none of the areas this review touches (${who})`, role }; }
  if (role) return { ok: false, reason: `the ${role} seat does not record positions; they come from the decision makers owning the touched areas (${who})`, role };
  return { ok: false, reason: `${NOT_MEMBER} (${who})` };
}
/** The touched areas this principal may record on right now (count mode: a single null entry when they may approve). */
export function recordableAreas(p: Principal | null, review: ReviewLike): { area: string | null; chk: Check }[] {
  const { mode, touched } = modeOf(review);
  if (mode === "count") { const chk = canRecordPosition(p, review, null); return chk.ok ? [{ area: null, chk }] : []; }
  return touched.map((area) => ({ area, chk: canRecordPosition(p, review, area) })).filter((x) => x.chk.ok);
}
/** May this principal approve (record a `yes`) somewhere on this review; the reason is the first area's refusal. */
export function canApprove(p: Principal | null, review: ReviewLike): Check {
  const { mode, touched } = modeOf(review);
  if (mode === "count") return canRecordPosition(p, review, null);
  let first: Check | null = null;
  for (const area of touched) { const chk = canRecordPosition(p, review, area); if (chk.ok) return { ...chk, area }; first ??= chk; }
  return first ?? { ok: false, reason: "this review touches no area" };
}
/**
 * May this principal send this review back: in count mode any seat holding request_changes (chair, decision maker,
 * reviewer); in areas mode an owner of a touched area (a `no` on it — `area` names the first) or the advisory
 * reviewer seat, whose `no` is held on no area (`area: null`): it sends the item back but never counts anywhere.
 */
export function canRequestChanges(p: Principal | null, review: ReviewLike): Check {
  if (!p) return { ok: false, reason: "sign in required" };
  if (modeOf(review).mode === "areas") {
    if (!OPEN_STAGES.includes(review.stage)) return { ok: false, reason: `review is ${review.stage}` };
    if (review.submitted_by === p.id) return { ok: false, reason: "a submitter cannot request changes on their own review; resubmit it instead" };
    if (memberRole(p, review.board_id) === "reviewer") return { ok: true, role: "reviewer", mode: "areas", area: null };
    return canApprove(p, review);
  }
  if (!OPEN_STAGES.includes(review.stage)) return { ok: false, reason: `review is ${review.stage}` };
  if (review.submitted_by === p.id) return { ok: false, reason: "a submitter cannot request changes on their own review; resubmit it instead" };
  const role = memberRole(p, review.board_id);
  if (!role) return { ok: false, reason: NOT_MEMBER };
  if (!seatHas(role, "request_changes")) return { ok: false, reason: `the ${role} seat does not request changes`, role };
  return { ok: true, role, mode: "count" };
}
/** A capability held everywhere through the system role or the flag, or on this review's board through a seat (comment, pre_review). */
export function canActOn(p: Principal | null, review: ReviewLike, cap: Capability): Check {
  if (!p) return { ok: false, reason: "sign in required" };
  if (capabilitiesFor({ user_type: p.user_type, is_platform_admin: p.is_platform_admin, boards: [] }).has(cap)) return { ok: true };
  const role = memberRole(p, review.board_id);
  if (role && seatHas(role, cap)) return { ok: true, role };
  return { ok: false, reason: role ? `the ${role} seat does not ${cap.replace(/_/g, " ")} on this board` : NOT_MEMBER, ...(role ? { role } : {}) };
}
/** Holds a decision-step seat on the review's board, or is the item's acting chair in an open session. */
export function isDecider(p: Principal | null, review: ReviewLike): Check {
  if (!p) return { ok: false, reason: "sign in required" };
  const role = memberRole(p, review.board_id);
  const roles = decisionRoles(policyFor(review.board_id, review.type as ReviewType));
  if (role && roles.includes(role) && seatHas(role, "decide_review")) return { ok: true, role };
  const s = openSessionOf(review.id);
  if (s && itemOf(s.id, review.id)?.acting_chair === p.id) return { ok: true, role: "chair", acting: true };
  return { ok: false, reason: role ? `the ${role} seat does not decide ${review.type} reviews on this board (needs ${roles.join(" or ")})` : NOT_MEMBER, ...(role ? { role } : {}) };
}
/** May this principal resolve a conditional on this review: the chair (or acting chair) while the review is open. */
export function canResolve(p: Principal | null, review: ReviewLike): Check {
  if (!p) return { ok: false, reason: "sign in required" };
  if (!OPEN_STAGES.includes(review.stage) && review.stage !== "approved_subject_to_circulation") return { ok: false, reason: `review is ${review.stage}` };
  if (review.submitted_by === p.id) return { ok: false, reason: "a submitter cannot resolve positions on their own review" };
  return isDecider(p, review);
}
/**
 * May this principal declare `outcome` on this review now. Sending back, deferring, referring and rejecting need
 * only the seat; approving needs the policy satisfied; approval subject to circulation needs an open session in
 * which every absent area's owner is away. Without an outcome the check is the plain approval one.
 */
export function canDecide(p: Principal | null, review: ReviewLike, outcome?: string): Check {
  if (!p) return { ok: false, reason: "sign in required" };
  if (!OPEN_STAGES.includes(review.stage) && review.stage !== "changes_requested") return { ok: false, reason: `review is ${review.stage}` };
  // withdrawing is the submitter's own act
  if (outcome === "withdrawn") return review.submitted_by === p.id ? { ok: true } : { ok: false, reason: "only the submitter withdraws a review" };
  if (review.submitted_by === p.id) return { ok: false, reason: openSessionOf(review.id) ? "a submitter cannot decide their own review; nominate an acting chair" : "a submitter cannot decide their own review" };
  const d = isDecider(p, review);
  if (!d.ok) return d;
  if (outcome === "changes_requested" || outcome === "deferred" || outcome === "referred" || outcome === "rejected") return d;
  if (review.stage === "changes_requested") return { ...d, ok: false, reason: "changes were requested; the submitter must resubmit first" };
  const prog = approvalProgress(review);
  if (prog.changes_requested) return { ...d, ok: false, reason: "changes were requested; the submitter must resubmit first" };
  // an open assessment blocks every approving outcome: the result must be recorded, or the chair waives it with a reason
  const openAssess = openAssessmentRows(review.id);
  if (openAssess.length) return { ...d, ok: false, reason: `assessments outstanding: ${openAssess.map((a) => a.title || a.type).join(", ")} — record the result, or waive it with a reason` };
  const labels = (states: AreaStateValue[]) => prog.areas.filter((a) => states.includes(a.state)).map((a) => a.label).join(", ");
  if (outcome === "approved_subject_to_circulation") {
    if (prog.mode !== "areas") return { ...d, ok: false, reason: "approval subject to circulation applies to boards with areas of responsibility" };
    const s = openSessionOf(review.id);
    if (!s) return { ...d, ok: false, reason: "approval subject to circulation is declared in an open session" };
    if (prog.open_conditionals) return { ...d, ok: false, reason: `conditional unresolved: ${labels(["conditional"])}` };
    const present = presentUsers(s.id);
    let absent = 0;
    for (const a of prog.areas) {
      if (a.state !== "missing") continue;
      const here = a.owners.filter((o) => present.has(o));
      if (here.length) return { ...d, ok: false, reason: `${a.label}: an owner is present (${here.join(", ")}); a position is expected in the room` };
      absent++;
    }
    if (!absent) return { ...d, ok: false, reason: "every touched area has a position; declare it approved instead" };
    return d;
  }
  if (prog.mode === "areas") {
    if (prog.open_conditionals) return { ...d, ok: false, reason: `conditional unresolved: ${labels(["conditional"])}` };
    if (!prog.satisfied) return { ...d, ok: false, reason: `positions outstanding: ${prog.outstanding.map((o) => "area" in o ? `${o.label} (${o.owners.join("/") || "no owner"})` : o.step).join("; ")}` };
  } else if (!prog.satisfied) return { ...d, ok: false, reason: `approvals outstanding: ${prog.outstanding.map((o) => "step" in o ? `${o.step} needs ${o.missing} more (${o.roles.join("/")})` : o.label).join("; ")}` };
  return d;
}
/** The outcomes this principal may declare on this review right now. */
export const declareOutcomes = (p: Principal | null, review: ReviewLike): Outcome[] => OUTCOMES.filter((o) => canDecide(p, review, o).ok);

/** Record a position (after canRecordPosition said yes). Supersedes the same user's live position on that area; audits `position:<position>`. */
export function recordPosition(review: ReviewLike, p: Principal, chk: Check, area: string | null, position: PositionValue, text: string | null, actor: string): Position {
  const id = uid(), at = nowIso();
  const session = openSessionOf(review.id);
  db.prepare("UPDATE review_positions SET superseded=1 WHERE review_id=? AND user_id=? AND superseded=0 AND area IS ?").run(review.id, p.id, area);
  db.prepare("INSERT INTO review_positions(id,review_id,session_id,user_id,board_role,on_behalf_of,delegation_id,area,position,text,at,superseded) VALUES (?,?,?,?,?,?,?,?,?,?,?,0)")
    .run(id, review.id, session?.id ?? null, p.id, chk.role ?? "decision_maker", chk.on_behalf_of ?? null, chk.delegation_id ?? null, area, position, text, at);
  audit(actor, `position:${position}`, "reviews", review.id, { area, session_id: session?.id ?? null, on_behalf_of: chk.on_behalf_of ?? null, board_id: review.board_id, board_role: chk.role ?? "decision_maker", text: text || undefined });
  return positionById(id)!;
}
/** The old approvals API, for callers that still speak it (count mode): approve → yes, request_changes → no. */
export function recordApproval(review: ReviewLike, p: Principal, role: BoardRole, decision: "approve" | "request_changes", comment: string | null, actor: string): Approval {
  const pos = recordPosition(review, p, { ok: true, role }, null, decision === "approve" ? "yes" : "no", comment, actor);
  return approvalsOf(review.id).find((a) => a.id === pos.id)!;
}
/** A resubmission (or a referral) supersedes every live position so the policy restarts for the new version. */
export const supersedePositions = (reviewId: string) => db.prepare("UPDATE review_positions SET superseded=1 WHERE review_id=? AND superseded=0").run(reviewId).changes;
export const supersedeApprovals = supersedePositions;

/** Is there anything this principal is expected to do on this review right now (a position the policy counts, a conditional to resolve, or the decision). */
export function awaitingMe(p: Principal | null, review: ReviewLike): boolean {
  if (!p) return false;
  const prog = approvalProgress(review);
  const live = livePositions(review.id);
  if (prog.mode === "areas") {
    // a fast-lane item waits on the chair alone; owners may still object, but nobody is awaited for a position
    if (!prog.via_fast_lane) for (const a of prog.areas) if (canRecordPosition(p, review, a.area).ok && !live.some((x) => x.area === a.area && x.user_id === p.id)) return true;
    if (OPEN_STAGES.includes(review.stage) && review.submitted_by !== p.id && isDecider(p, review).ok && (prog.ready || prog.open_conditionals > 0)) return true;
    return false;
  }
  const a = canApprove(p, review);
  if (a.ok && !prog.via_fast_lane && !live.some((x) => x.user_id === p.id && x.position === "yes")) return true;
  return canDecide(p, review).ok;
}
