import { db, nowIso } from "../db.js";
import type { Principal } from "../auth/context.js";
import { OPEN_STAGES, approvalProgress, livePositions, canRecordPosition, canApprove, canResolve, isDecider, memberRole, boardById, boardSummary, listedSessionOf, type SessionRow } from "./workflow.js";
import { boardAreas, areaLabel } from "./areas.js";
import { reviewRow, userName } from "../reviews.js";
import { sessionItems } from "./sessions.js";

/**
 * The work queue of one principal: what the workflow is waiting on them for, derived from the same rules the
 * handlers enforce (canRecordPosition per area, isDecider, canResolve) so the queue never promises an action the
 * route would refuse. Someone with no governance identity — a platform admin without a seat or a system role, an
 * auditor, a service account — gets an empty queue: the platform admin runs the instance, not its boards.
 */
export const reviewRef = (r: any) => ({ id: r.id, code: r.code, title: r.title, type: r.type, stage: r.stage, board: boardSummary(boardById(r.board_id)), deferred_count: r.deferred_count || 0 });
export const sessionRef = (s: SessionRow | null) => (s ? { id: s.id, code: s.code, status: s.status, scheduled_at: s.scheduled_at } : null);
const IN_FLIGHT = ["submitted", "pre_review", "in_review", "changes_requested", "approved_pending_dependencies", "approved_subject_to_circulation"];
export const IN_FLIGHT_SQL = `(${IN_FLIGHT.map((s) => `'${s}'`).join(",")})`;

interface WorkLists { positions: any[]; declare: any[]; resolve: any[]; assessments: any[]; sessions: any[]; conditions: any[]; circulations: any[]; resubmit: any[]; changed: any[]; no_decision: any[] }
const empty = (): WorkLists => ({ positions: [], declare: [], resolve: [], assessments: [], sessions: [], conditions: [], circulations: [], resubmit: [], changed: [], no_decision: [] });
const countsOf = (l: WorkLists) => { const c: Record<string, number> = {}; let total = 0; for (const k of Object.keys(l) as (keyof WorkLists)[]) { c[k] = l[k].length; total += l[k].length; } return { total, ...c }; };
/** Holds a governance identity: a system role that acts (author) or at least one seat; never an auditor or a service account. */
export const governs = (p: Principal | null): p is Principal => !!p && p.user_type !== "auditor" && p.user_type !== "service" && (p.user_type === "author" || p.boards.length > 0);

export function workQueueFor(p: Principal | null) {
  const lists = empty();
  const user = p ? { id: p.id, name: p.name } : null;
  if (!governs(p)) return { user, counts: countsOf(lists), ...lists };
  const now = nowIso();
  // reviews still taking positions, a declaration or a resolution (a sent-back item waits on its author, not the board)
  const open = db.prepare("SELECT * FROM reviews WHERE stage IN ('submitted','pre_review','in_review','approved_subject_to_circulation') ORDER BY created_at").all() as any[];
  for (const r of open) {
    if (r.submitted_by === p.id) continue; // the author proposes; the author never acts on their own item
    const live = livePositions(r.id); const prog = approvalProgress(r); const session = listedSessionOf(r.id); const sref = sessionRef(session);
    const role = memberRole(p, r.board_id);
    if (prog.mode === "areas") {
      const areas = prog.areas.filter((a) => canRecordPosition(p, r, a.area).ok && !live.some((x) => x.area === a.area && x.user_id === p.id)).map((a) => a.area);
      if (areas.length) lists.positions.push({ review: reviewRef(r), areas, session: sref });
    } else if (canApprove(p, r).ok && !live.some((x) => x.user_id === p.id && x.position === "yes")) lists.positions.push({ review: reviewRef(r), areas: [], session: sref });
    if (r.stage === "approved_subject_to_circulation") {
      const missing = prog.areas.filter((a) => a.state === "missing");
      const mine = missing.some((a) => canRecordPosition(p, r, a.area).ok);
      if (mine || role === "chair") lists.circulations.push({ review: reviewRef(r), circulation_due: r.circulation_due ?? null, overdue: !!r.circulation_due && r.circulation_due < now, missing: missing.map((a) => a.label), mine });
    }
    if (OPEN_STAGES.includes(r.stage)) {
      const d = isDecider(p, r);
      // the chair (or acting chair) declares a ready item, and works through every item of an open sitting they chair
      if (d.ok && (prog.ready || (session?.status === "open" && (role === "chair" || d.acting)))) lists.declare.push({ review: reviewRef(r), ready: prog.ready, outstanding: prog.outstanding.map((o) => ("area" in o ? o.label : o.step)), session: sref });
    }
    if (canResolve(p, r).ok) {
      const bAreas = boardAreas(r.board_id);
      for (const x of live) if (x.position === "conditional" && !x.resolution) lists.resolve.push({ review: reviewRef(r), area: x.area, label: x.area ? areaLabel(x.area, bAreas) : null, by: x.user_id, by_name: userName(x.user_id), on_behalf_of: x.on_behalf_of, text: x.text, position_id: x.id, session: sref });
    }
  }
  // forthcoming sittings of the boards I sit on: the open one first, then the soonest
  for (const s of db.prepare("SELECT * FROM board_sessions WHERE status IN ('planned','open') ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, scheduled_at").all() as SessionRow[]) {
    const role = memberRole(p, s.board_id); if (!role) continue;
    const items = sessionItems(s.id);
    const att = db.prepare("SELECT status FROM session_attendance WHERE session_id=? AND user_id=?").get(s.id, p.id) as any;
    lists.sessions.push({ id: s.id, code: s.code, title: s.title, board: boardSummary(boardById(s.board_id)), scheduled_at: s.scheduled_at, status: s.status, my_role: role, my_attendance: att?.status ?? null, items: items.length, consent_count: items.filter((i) => i.consent && i.state === "listed").length });
  }
  // assessments assigned to me and still open, due-soonest first (the assignee may be the submitter: the board asks, the submitter provides)
  for (const a of db.prepare(`SELECT a.* FROM review_assessments a JOIN reviews r ON r.id=a.review_id WHERE a.assigned_to=? AND a.status='requested' AND r.stage IN ${IN_FLIGHT_SQL} ORDER BY COALESCE(a.due_at,'9999'), a.created_at`).all(p.id) as any[]) {
    const r = reviewRow(a.review_id); if (!r) continue;
    lists.assessments.push({ id: a.id, review: reviewRef(r), type: a.type, title: a.title ?? null, area: a.area ?? null, due_at: a.due_at ?? null, overdue: !!a.due_at && a.due_at < now, requested_by: a.requested_by, requested_by_name: userName(a.requested_by), session: sessionRef(listedSessionOf(r.id)) });
  }
  // conditions I own, the overdue ones first
  for (const c of db.prepare("SELECT id, review_id, text, due_at, status, area FROM conditions WHERE owner=? AND status IN ('open','overdue') ORDER BY CASE status WHEN 'overdue' THEN 0 ELSE 1 END, COALESCE(due_at, '9999'), created_at").all(p.id) as any[]) {
    const r = reviewRow(c.review_id); if (!r) continue;
    lists.conditions.push({ id: c.id, review: reviewRef(r), text: c.text, due_at: c.due_at ?? null, status: c.status, area: c.area ?? null });
  }
  // my items sent back: who sent them back and why (the latest send-back on the timeline)
  for (const r of db.prepare("SELECT * FROM reviews WHERE submitted_by=? AND stage='changes_requested' ORDER BY updated_at DESC").all(p.id) as any[]) {
    const ev = db.prepare("SELECT actor, created_at, body_md FROM review_events WHERE review_id=? AND (kind='request_changes' OR (kind='position' AND json_extract(data_json,'$.position')='no') OR (kind='circulation_objection')) ORDER BY created_at DESC LIMIT 1").get(r.id) as any;
    lists.resubmit.push({ review: reviewRef(r), requested_by: ev?.actor ?? null, requested_by_name: userName(ev?.actor ?? null), requested_at: ev?.created_at ?? null, text: ev?.body_md || null });
  }
  // backlog items that changed materially after a review I submitted was approved against them
  for (const w of db.prepare("SELECT w.id, w.external_id, w.type, w.title, w.review_id FROM work_items w JOIN reviews r ON r.id=w.review_id WHERE w.material_change=1 AND r.submitted_by=? ORDER BY w.changed_at DESC, w.external_id").all(p.id) as any[])
    lists.changed.push({ work_item: { id: w.id, external_id: w.external_id, type: w.type, title: w.title }, review: reviewRef(reviewRow(w.review_id)) });
  // epics nobody has decided on yet: an author's prompt to draft a decision or submit a design
  if (p.user_type === "author") for (const w of db.prepare("SELECT w.id, w.external_id, w.type, w.title, w.application_id, e.name application_name FROM work_items w LEFT JOIN elements e ON e.id=w.application_id WHERE w.type='Epic' AND w.state<>'Closed' AND w.decision_id IS NULL AND w.review_id IS NULL ORDER BY w.external_id").all() as any[])
    lists.no_decision.push({ work_item: { id: w.id, external_id: w.external_id, type: w.type, title: w.title, application_id: w.application_id ?? null, application_name: w.application_name ?? null } });
  return { user, counts: countsOf(lists), ...lists };
}

/** The most recent review still in flight that will decide this decision when declared (its own decision review, or a design that carries it). */
export function reviewInFlightFor(decisionId: string) {
  const r = db.prepare(`SELECT id, code, stage, board_id FROM reviews WHERE decision_id=? AND stage IN ${IN_FLIGHT_SQL} ORDER BY created_at DESC LIMIT 1`).get(decisionId) as any;
  if (!r) return null;
  const s = listedSessionOf(r.id);
  return { id: r.id as string, code: r.code as string, stage: r.stage as string, board: boardSummary(boardById(r.board_id)), session: s ? { id: s.id, code: s.code, status: s.status } : null };
}
