import { Hono } from "hono";
import { z } from "zod";
import { db, j, uid, nowIso, audit } from "../db.js";
import { listElements, getElement, setVerification } from "../model.js";
import { stripTemplateHints, draftAssessmentSummary } from "../ai.js";
import { actorOf, dec, wi, ev } from "../http.js";
import { currentPrincipal, type Principal } from "../auth/context.js";
import { capabilitiesFor, type Capability } from "../auth/roles.js";
import { forbidden } from "../auth/middleware.js";
import { REVIEW_TYPES, ARTEFACT_TYPES, OPEN_STAGES, FINAL_STAGES, POSITIONS, RESOLUTIONS, routeBoard, boardById, boardSummary, policyFor, approvalProgress, approvalsOf, positionsOf, livePositions, canApprove, canRequestChanges, canActOn, canDecide, canResolve, canRecordPosition, recordableAreas, declareOutcomes, supersedePositions, awaitingMe, memberRole, modeOf, frozenBy, positionById, listedSessionOf, sessionById, type ReviewType } from "../boards/workflow.js";
import { boardAreas, areaOfCategory } from "../boards/areas.js";
import { reviewRow, targetOf, userName, preReviewByType, createReview } from "../reviews.js";
import { declareOutcome, validateDeclare, DeclareIn, takePosition, resolvePosition, createDependency, dependenciesOf, dependentsOf } from "../boards/declare.js";
import { ASSESSMENT_TYPES, ASSESSMENT_RESULTS, ASSESSMENT_TEMPLATES, assessmentsOf, assessmentsOfDecision, assessmentById, assessmentLabel, withAssessmentNames, canRequestAssessment, canWaiveAssessment, canProvideAssessment, requestAssessment, reassignAssessment, recordAssessmentResult, recordDecisionAssessmentResult, waiveAssessment, markAssessmentsStale, provideAssessment, updateProvidedAssessment, updateProvidedDecisionAssessment } from "../boards/assessments.js";
import { artefactById } from "../artefacts.js";

/**
 * Reviews are typed: a design (an application), a decision (an ADR), a governance artefact (standard, principle,
 * pattern, policy — approving the review is what adopts it) or an exception. On creation a review is routed to a
 * board, pre-reviewed automatically according to its type, its touched areas derived, and then it waits for the
 * board's approval policy: positions per area from the decision makers who own them (areas mode) or a count of
 * approvals (count mode). The chair (or whoever the policy's decision step names) declares the outcome those
 * positions allow — and can always send an item back, defer, refer or reject it.
 */
export const reviews = new Hono();

const row = reviewRow;
const profile = (p: Principal) => ({ user_type: p.user_type, is_platform_admin: p.is_platform_admin, boards: p.boards });
const has = (p: Principal | null, cap: Capability) => !!p && capabilitiesFor(profile(p)).has(cap);
const fail = (c: any, e: any) => { const status = typeof e?.status === "number" ? e.status : 500; if (status >= 500) throw e; return c.json({ error: e.message }, status); };

/** The session a review belongs to for display: the forthcoming one it is listed on, else the one that declared it. */
const sessionRef = (r: any) => { const s = listedSessionOf(r.id) ?? sessionById(r.session_id); return s ? { id: s.id, code: s.code, status: s.status } : null; };
const enrich = (r: any, p: Principal | null, apps?: Map<string, string>) => ({
  ...r, application_name: r.application_id ? (apps ? apps.get(r.application_id) : getElement(r.application_id)?.name) ?? null : null,
  target: targetOf(r), board: boardSummary(boardById(r.board_id)), progress: approvalProgress(r), awaiting_me: awaitingMe(p, r),
  areas: j(r.areas_json, []) || [], deferred_count: r.deferred_count || 0, session: sessionRef(r),
});
const withNames = (x: any) => ({ ...x, name: userName(x.user_id), on_behalf_of_name: userName(x.on_behalf_of), resolved_by_name: userName(x.resolved_by) });

reviews.get("/reviews", (c) => {
  const p = currentPrincipal();
  const apps = new Map(listElements("application").map((a) => [a.id, a.name]));
  const type = c.req.query("type"), board = c.req.query("board"), awaiting = c.req.query("awaiting"), stage = c.req.query("stage"), session = c.req.query("session");
  const onSession = session ? new Set((db.prepare("SELECT review_id FROM session_items WHERE session_id=?").all(session) as any[]).map((i) => i.review_id)) : null;
  const rows = (db.prepare("SELECT r.*, (SELECT count(*) FROM conditions c WHERE c.review_id=r.id AND c.status IN ('open','overdue')) open_conditions, (SELECT count(*) FROM conditions c WHERE c.review_id=r.id AND c.status='overdue') overdue_conditions FROM reviews r ORDER BY created_at DESC").all() as any[])
    .filter((r) => (!type || r.type === type) && (!stage || r.stage === stage) && (!board || r.board_id === board || boardById(r.board_id)?.code === board.toUpperCase()) && (!onSession || onSession.has(r.id) || r.session_id === session))
    .map((r) => enrich(r, p, apps))
    .filter((r) => awaiting !== "me" || r.awaiting_me);
  return c.json(rows);
});
reviews.get("/reviews/:id", (c) => {
  const r = row(c.req.param("id")); if (!r) return c.json({ error: "not found" }, 404);
  const p = currentPrincipal();
  const app = r.application_id ? getElement(r.application_id) : null;
  // a pre-review stores citations as codes/refs (what the engine saw); resolve them to ids here so the UI can link
  const stdByCode = new Map((db.prepare("SELECT id, code, title, category, kind FROM standards").all() as any[]).map((s) => [s.code, s]));
  const decByCode = new Map((db.prepare("SELECT id, code, title FROM decisions").all() as any[]).map((d) => [d.code, d]));
  const resByRef = db.prepare("SELECT e.id, e.name, rel.to_id application_id FROM elements e LEFT JOIN relations rel ON rel.from_id=e.id AND rel.type='belongs_to' AND rel.deleted_at IS NULL WHERE e.source_ref=? AND e.deleted_at IS NULL");
  const cite = (ct: any) => {
    if (ct.kind === "standard") { const s = stdByCode.get(ct.ref); return { ...ct, id: s?.id, label: s?.title ?? ct.ref }; }
    if (ct.kind === "decision") { const d = decByCode.get(ct.ref); return { ...ct, id: d?.id, label: d?.title ?? ct.ref }; }
    if (ct.kind === "resource") { const e = resByRef.get(String(ct.ref).toLowerCase()) as any; return { ...ct, id: e?.id, application_id: e?.application_id || null, label: e?.name ?? String(ct.ref).split("/").pop() }; }
    return { ...ct, label: ct.ref };
  };
  const sessionCodes = new Map((db.prepare("SELECT id, code FROM board_sessions").all() as any[]).map((s) => [s.id, s.code]));
  const events = db.prepare("SELECT * FROM review_events WHERE review_id=? ORDER BY created_at").all(r.id).map(ev).map((e: any) => ({ ...e, session_code: e.session_id ? sessionCodes.get(e.session_id) ?? null : null })).map((e: any) => e.kind !== "pre_review" ? e
    : { ...e, data: { ...e.data, suggested_conditions: Array.isArray(e.data?.suggested_conditions) ? e.data.suggested_conditions : [],
        findings: (e.data?.findings || []).map((f: any) => ({ ...f, citations: (f.citations || []).map(cite) })) } });
  const conditions = db.prepare("SELECT * FROM conditions WHERE review_id=? ORDER BY created_at").all(r.id);
  const decision = r.decision_id ? dec(db.prepare("SELECT * FROM decisions WHERE id=?").get(r.decision_id)) : null;
  const workItems = db.prepare("SELECT * FROM work_items WHERE review_id=?").all(r.id).map(wi);
  const approvals = approvalsOf(r.id).map((a) => ({ ...a, name: userName(a.user_id) }));
  const positions = positionsOf(r.id).map(withNames);
  const approve = canApprove(p, r), changes = canRequestChanges(p, r), decide = canDecide(p, r), resolve = canResolve(p, r);
  const open = OPEN_STAGES.includes(r.stage) || r.stage === "changes_requested";
  const recordable = recordableAreas(p, r); const frozen = frozenBy(r);
  const openConditional = livePositions(r.id).some((x) => x.position === "conditional" && !x.resolution);
  const isSubmitter = !!p && p.id === r.submitted_by; const role = memberRole(p, r.board_id);
  const bAreas = boardAreas(r.board_id);
  // the latest pre-review, summarised, and its findings joined to the areas they belong to: a finding counts for an
  // area when it cites a catalogue item whose category maps there (citations to decisions or resources place nothing)
  const pre = [...events].reverse().find((e: any) => e.kind === "pre_review") as any;
  const preFindings: any[] = pre?.data?.findings || [];
  const findingsOf = (area: string) => preFindings.flatMap((f: any) => { const s = (f.citations || []).map((ct: any) => (ct.kind === "standard" ? stdByCode.get(ct.ref) : null)).find((s: any) => s && areaOfCategory(s.category) === area);
    return s ? [{ severity: f.severity, title: f.title, code: s.code, label: s.title, kind: s.kind ?? "standard" }] : []; });
  const base = enrich(r, p);
  const progress = { ...base.progress, areas: base.progress.areas.map((a: any) => { const findings = findingsOf(a.area); return { ...a, mine: canRecordPosition(p, r, a.area).ok, findings, findings_count: findings.length }; }) };
  const pre_review = pre ? { recommendation: pre.data?.recommendation ?? null, findings: preFindings.length, checks_failed: (pre.data?.checks || []).filter((k: any) => k?.state === "fail").length, at: pre.created_at } : null;
  const reqAssess = canRequestAssessment(p, r), waiveAssess = canWaiveAssessment(p, r);
  // exact for this review: seat-held rights only count on the board the review is routed to
  return c.json({ ...base, progress, pre_review, application: app, events, conditions, decision, workItems, approvals, positions, policy: policyFor(r.board_id, r.type),
    areas: { touched: j(r.areas_json, []) || [], derived: j(r.areas_derived_json, []) || [], origin: r.areas_origin ?? null, board_areas: bAreas, mode: modeOf(r).mode },
    dependencies: dependenciesOf(r.id), dependents: r.type === "decision" ? dependentsOf(r.decision_id) : [],
    // the review's own assessments, plus the evidence gathered on the decision before it was submitted (tracked, never blocking)
    assessments: [...assessmentsOf(r.id).map(withAssessmentNames), ...(r.decision_id ? assessmentsOfDecision(r.decision_id).map((a) => ({ ...withAssessmentNames(a), on_decision: true })) : [])],
    submitted_by_name: userName(r.submitted_by),
    can: { approve: approve.ok && !frozen, request_changes: changes.ok && !frozen, decide: decide.ok, comment: open && canActOn(p, r, "comment").ok, resubmit: r.stage === "changes_requested" && isSubmitter && has(p, "resubmit"), pre_review: open && canActOn(p, r, "pre_review").ok,
      record_position: recordable.length > 0 && !frozen, resolve: resolve.ok && openConditional && !frozen,
      create_dependency: open && !!p && (isSubmitter || role === "chair" || role === "decision_maker" || role === "reviewer"),
      edit_areas: bAreas.length > 0 && !!p && !FINAL_STAGES.includes(r.stage) && ((isSubmitter && open) || role === "chair" || role === "secretary"),
      request_assessment: reqAssess.ok, waive_assessment: waiveAssess.ok,
      declare_outcomes: declareOutcomes(p, r) },
    why: { approve: approve.reason ?? null, request_changes: changes.reason ?? null, decide: decide.reason ?? null,
      record_position: frozen ? `positions are frozen: declared in ${frozen.code}, which is closed` : recordable.length ? null : approve.reason ?? null,
      request_assessment: reqAssess.reason ?? null,
      resolve: resolve.ok ? (openConditional ? null : "no open conditional") : resolve.reason ?? null } });
});

// ---------- create ----------
const ReviewIn = z.object({
  type: z.enum(REVIEW_TYPES).default("design"), title: z.string().min(1),
  application_id: z.string().nullable().optional(), decision_id: z.string().nullable().optional(), artefact_id: z.string().nullable().optional(), finding_id: z.string().nullable().optional(), work_item_id: z.string().nullable().optional(),
  risk_tier: z.string().default("medium"), impact: z.enum(["minor", "major"]).optional(), summary: z.string().optional(), design_md: z.string().optional(),
  reason: z.string().optional(), proposed_expires_at: z.string().nullable().optional(),
});
reviews.post("/reviews", async (c) => {
  const b = ReviewIn.parse(await c.req.json()); const p = currentPrincipal(); const actor = actorOf(c);
  const needs: Capability = ARTEFACT_TYPES.includes(b.type) ? "manage_artefacts" : b.type === "decision" ? "create_decision" : "submit_review";
  if (!has(p, needs)) return forbidden(c, needs, p, `${b.type} reviews need ${needs}`);
  let target_kind: string, target_id: string, kind: string | null = null, category: string | null = null, application_id = b.application_id || null, decision_id = b.decision_id || null;
  if (b.type === "design") { if (!application_id || !getElement(application_id)) return c.json({ error: "application_id is required for a design review" }, 400); target_kind = "application"; target_id = application_id; }
  else if (b.type === "decision") { if (!decision_id || !db.prepare("SELECT 1 FROM decisions WHERE id=?").get(decision_id)) return c.json({ error: "decision_id is required for a decision review" }, 400); target_kind = "decision"; target_id = decision_id; const d = db.prepare("SELECT topic FROM decisions WHERE id=?").get(decision_id) as any; category = d?.topic ?? null; }
  else if (ARTEFACT_TYPES.includes(b.type)) {
    if (!b.artefact_id) return c.json({ error: `artefact_id is required for a ${b.type} review` }, 400);
    const a: any = artefactById(b.artefact_id); if (!a) return c.json({ error: "artefact not found" }, 404);
    if (a.kind && a.kind !== b.type) return c.json({ error: `artefact ${a.code} is a ${a.kind}, not a ${b.type}` }, 400);
    if (a.lifecycle === "in_review" && db.prepare("SELECT 1 FROM reviews WHERE target_id=? AND stage IN ('submitted','pre_review','in_review','changes_requested')").get(a.id)) return c.json({ error: `${a.code} is already under review` }, 409);
    if (a.lifecycle === "retired") return c.json({ error: `${a.code} is retired` }, 409);
    target_kind = "artefact"; target_id = a.id; kind = a.kind || b.type; category = a.category ?? null;
  } else { // exception
    if (b.finding_id) { const f = db.prepare("SELECT * FROM findings WHERE id=?").get(b.finding_id) as any; if (!f) return c.json({ error: "finding not found" }, 404); target_kind = "finding"; target_id = f.id; application_id = f.application_id || application_id; }
    else if (b.artefact_id && application_id) { if (!db.prepare("SELECT 1 FROM standards WHERE id=?").get(b.artefact_id)) return c.json({ error: "artefact not found" }, 404); target_kind = "artefact"; target_id = b.artefact_id; }
    else return c.json({ error: "an exception review needs finding_id, or artefact_id with application_id" }, 400);
    if (!b.reason) return c.json({ error: "reason is required for an exception review" }, 400);
  }
  const board = routeBoard(b.type, kind, category);
  if (!board) return c.json({ error: "no board can receive this review (no routing rule and no board coded DA)" }, 500);
  const r = await createReview({ type: b.type, title: b.title, target_kind, target_id, board, submitted_by: actor, application_id, decision_id, work_item_id: b.work_item_id || null, risk_tier: b.risk_tier, impact: b.impact || null, summary: b.summary || b.reason || "", design_md: b.design_md || "",
    submitted_data: b.type === "exception" ? { reason: b.reason, proposed_expires_at: b.proposed_expires_at || null, finding_id: b.finding_id || null, artefact_id: b.artefact_id || null, application_id } : {} }, actor);
  return c.json({ id: r.id, code: r.code, type: r.type, stage: r.stage, board: boardSummary(board), areas: j(r.areas_json, []) || [] });
});
reviews.post("/reviews/:id/pre-review", async (c) => {
  const r = row(c.req.param("id")); if (!r) return c.json({ error: "not found" }, 404);
  const p = currentPrincipal(); const chk = canActOn(p, r, "pre_review");
  if (!chk.ok) return forbidden(c, "pre_review", p, chk.reason);
  await preReviewByType(r, actorOf(c)); const r2 = row(r.id); return c.json({ ok: true, stage: r2.stage, areas: j(r2.areas_json, []) || [] });
});
/** The touched areas: the submitter while the review is open, or the board's chair / secretary; always a non-empty subset of the board's areas. */
reviews.put("/reviews/:id/areas", async (c) => {
  const r = row(c.req.param("id")); if (!r) return c.json({ error: "not found" }, 404);
  const p = currentPrincipal(); const role = memberRole(p, r.board_id);
  const open = OPEN_STAGES.includes(r.stage) || r.stage === "changes_requested";
  const allowed = !!p && !FINAL_STAGES.includes(r.stage) && ((p.id === r.submitted_by && open) || role === "chair" || role === "secretary");
  if (!allowed) return forbidden(c, "submit_review", p, p?.id === r.submitted_by ? `the review is ${r.stage}` : `only the submitter (while the review is open) or the chair / secretary of ${boardById(r.board_id)?.code ?? "its board"} edits the areas`);
  const bAreas = boardAreas(r.board_id);
  if (!bAreas.length) return c.json({ error: "this board has no areas of responsibility" }, 400);
  const b = z.object({ areas: z.array(z.string()).min(1) }).parse(await c.req.json());
  const ids = bAreas.map((a) => a.id); const bad = b.areas.filter((a) => !ids.includes(a));
  if (bad.length) return c.json({ error: `not areas of this board: ${bad.join(", ")} (areas: ${ids.join(", ")})` }, 400);
  const areas = ids.filter((id) => b.areas.includes(id)); const from = j(r.areas_json, []) || [];
  const now = nowIso(), actor = actorOf(c);
  db.prepare("UPDATE reviews SET areas_json=?, areas_origin='human', updated_at=? WHERE id=?").run(JSON.stringify(areas), now, r.id);
  db.prepare(`INSERT INTO review_events(id,review_id,kind,actor,body_md,data_json,origin,verification,verified_by,verified_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(uid(), r.id, "areas_changed", actor, `Areas set to ${areas.join(", ")}.`, JSON.stringify({ from, to: areas, derived: j(r.areas_derived_json, []) || [] }), "human", "verified", actor, now, now);
  audit(actor, "review:areas", "reviews", r.id, { from, to: areas });
  const r2 = row(r.id);
  return c.json({ ok: true, areas: areas, origin: "human", progress: approvalProgress(r2) });
});

// ---------- discussion, positions, resubmission ----------
reviews.post("/reviews/:id/comment", async (c) => {
  const r = row(c.req.param("id")); if (!r) return c.json({ error: "not found" }, 404);
  const p = currentPrincipal(); const chk = canActOn(p, r, "comment");
  if (!chk.ok) return forbidden(c, "comment", p, chk.reason);
  const { body } = await c.req.json(); const id = r.id; const now = nowIso(); const actor = actorOf(c); const eventId = uid();
  db.prepare(`INSERT INTO review_events(id,review_id,kind,actor,body_md,data_json,origin,verification,created_at,session_id) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(eventId, id, "comment", actor, body, "{}", "human", "verified", now, listedSessionOf(id)?.status === "open" ? listedSessionOf(id)!.id : null);
  db.prepare("UPDATE reviews SET stage=CASE WHEN stage IN ('submitted','pre_review') THEN 'in_review' ELSE stage END, updated_at=? WHERE id=?").run(now, id);
  audit(actor, "comment", "reviews", id, { event_id: eventId });
  return c.json({ ok: true });
});
const frozenReply = (c: any, r: any) => { const f = frozenBy(r); return f ? c.json({ error: `positions on ${r.code} are frozen: it was declared in ${f.code}, which is closed` }, 409) : null; };
const positionsReply = (c: any, reviewId: string, positions: any[]) => { const r2 = row(reviewId); return c.json({ ok: true, positions: positions.map(withNames), stage: r2.stage, progress: approvalProgress(r2) }); };
/** A position per area (areas mode) or a plain yes/no (count mode); `text` says why for anything but a yes. */
reviews.post("/reviews/:id/positions", async (c) => {
  const r = row(c.req.param("id")); if (!r) return c.json({ error: "not found" }, 404);
  const b = z.object({ area: z.string().optional().nullable(), areas: z.array(z.string()).optional(), position: z.enum(POSITIONS), text: z.string().max(4000).optional().nullable() }).parse(await c.req.json());
  const p = currentPrincipal(); const actor = actorOf(c);
  const frozen = frozenReply(c, r); if (frozen) return frozen;
  if (b.position !== "yes" && !b.text?.trim()) return c.json({ error: `text is required for a ${b.position.replace(/_/g, " ")} position` }, 400);
  if (modeOf(r).mode === "count") {
    if (b.position !== "yes" && b.position !== "no") return c.json({ error: "this board's policy counts approvals: record yes or no" }, 400);
    const chk = b.position === "yes" ? canRecordPosition(p, r, null) : canRequestChanges(p, r);
    if (!chk.ok) return forbidden(c, b.position === "yes" ? "approve_review" : "request_changes", p, chk.reason);
    return positionsReply(c, r.id, [takePosition(r, p!, chk, null, b.position, b.text?.trim() || null, actor)]);
  }
  const list = [...new Set(b.areas?.length ? b.areas : b.area ? [b.area] : [])];
  if (!list.length) {
    // the advisory reviewer seat sends an item back without holding an area: a no on no area
    if (b.position === "no") { const chk = canRequestChanges(p, r); if (chk.ok && chk.area === null) return positionsReply(c, r.id, [takePosition(r, p!, chk, null, "no", b.text?.trim() || null, actor)]); if (!chk.ok) return forbidden(c, "request_changes", p, chk.reason); }
    return c.json({ error: "area (or areas) is required: positions on this review are recorded per area of responsibility" }, 400);
  }
  const checks = list.map((area) => ({ area, chk: canRecordPosition(p, r, area) }));
  const bad = checks.find((x) => !x.chk.ok);
  if (bad) return forbidden(c, "approve_review", p, bad.chk.reason);
  return positionsReply(c, r.id, checks.map((x) => takePosition(r, p!, x.chk, x.area, b.position, b.text?.trim() || null, actor)));
});
/** Compatibility alias: approve → yes on every touched area the caller owns (count mode: no area), request_changes → no likewise. */
reviews.post("/reviews/:id/approvals", async (c) => {
  const r = row(c.req.param("id")); if (!r) return c.json({ error: "not found" }, 404);
  const b = z.object({ decision: z.enum(["approve", "request_changes"]), comment: z.string().max(4000).optional() }).parse(await c.req.json());
  const p = currentPrincipal(); const actor = actorOf(c);
  const frozen = frozenReply(c, r); if (frozen) return frozen;
  const position = b.decision === "approve" ? "yes" : "no"; const cap: Capability = b.decision === "approve" ? "approve_review" : "request_changes";
  let positions: any[];
  if (modeOf(r).mode === "count") {
    // an approval needs a seat the policy counts; a request for changes is open to every seat that holds it (a reviewer is advisory)
    const chk = b.decision === "approve" ? canRecordPosition(p, r, null) : canRequestChanges(p, r);
    if (!chk.ok) return forbidden(c, cap, p, chk.reason);
    if (position === "no" && !b.comment?.trim()) return c.json({ error: "a comment is required to request changes" }, 400);
    positions = [takePosition(r, p!, chk, null, position, b.comment?.trim() || null, actor)];
  } else {
    const mine = recordableAreas(p, r);
    const advisory = position === "no" && !mine.length ? canRequestChanges(p, r) : null; // a reviewer's send-back holds no area
    if (!mine.length && !(advisory?.ok && advisory.area === null)) return forbidden(c, cap, p, (advisory ?? canApprove(p, r)).reason);
    if (position === "no" && !b.comment?.trim()) return c.json({ error: "a comment is required to request changes" }, 400);
    positions = mine.length ? mine.map((x) => takePosition(r, p!, x.chk, x.area, position, b.comment?.trim() || null, actor)) : [takePosition(r, p!, advisory!, null, "no", b.comment?.trim() || null, actor)];
  }
  const r2 = row(r.id);
  return c.json({ ok: true, approval: approvalsOf(r.id).find((a) => a.id === positions[0].id) ?? null, positions: positions.map(withNames), stage: r2.stage, progress: approvalProgress(r2) });
});
reviews.post("/positions/:id/resolve", async (c) => {
  const pos = positionById(c.req.param("id")); if (!pos) return c.json({ error: "not found" }, 404);
  const r = row(pos.review_id); if (!r) return c.json({ error: "not found" }, 404);
  const b = z.object({ resolution: z.enum(RESOLUTIONS), text: z.string().trim().min(10, "an explanation of at least 10 characters is required"),
    condition: z.object({ text: z.string().optional(), owner: z.string().optional(), due_at: z.string().optional() }).optional(), decision_id: z.string().optional(),
    create: z.object({ title: z.string().min(1), topic: z.string().optional(), context_md: z.string().optional(), decision_md: z.string().optional(), application_ids: z.array(z.string()).optional() }).optional() }).parse(await c.req.json());
  const p = currentPrincipal();
  const frozen = frozenReply(c, r); if (frozen) return frozen;
  if (pos.superseded) return c.json({ error: "this position was superseded" }, 409);
  if (pos.position !== "conditional") return c.json({ error: `only a conditional is resolved (this position is ${pos.position})` }, 400);
  if (pos.resolution) return c.json({ error: `already resolved (${pos.resolution})` }, 409);
  const chk = canResolve(p, r);
  if (!chk.ok) return forbidden(c, "decide_review", p, chk.reason);
  try {
    const out = await resolvePosition(r, pos, b, p!, actorOf(c)); const r2 = row(r.id);
    return c.json({ ok: true, position: withNames(out.position), dependency: out.dependency, stage: r2.stage, progress: approvalProgress(r2) });
  } catch (e) { return fail(c, e); }
});
/** A decision the review depends on: an existing one, or a new ADR (and, by default, its own decision review). */
reviews.post("/reviews/:id/dependencies", async (c) => {
  const r = row(c.req.param("id")); if (!r) return c.json({ error: "not found" }, 404);
  const b = z.object({ decision_id: z.string().optional(), submit: z.boolean().optional(),
    create: z.object({ title: z.string().min(1), topic: z.string().optional(), context_md: z.string().optional(), decision_md: z.string().optional(), application_ids: z.array(z.string()).optional() }).optional() }).parse(await c.req.json());
  const p = currentPrincipal(); const role = memberRole(p, r.board_id);
  const open = OPEN_STAGES.includes(r.stage) || r.stage === "changes_requested";
  if (!open) return c.json({ error: `review is ${r.stage}` }, 409);
  if (!p || !(p.id === r.submitted_by || role === "chair" || role === "decision_maker" || role === "reviewer")) return forbidden(c, "comment", p, `only the submitter or a chair / decision maker / reviewer of ${boardById(r.board_id)?.code ?? "the board"} links a dependency`);
  if (!b.create && !b.decision_id) return c.json({ error: "decision_id or create is required" }, 400);
  try { return c.json(await createDependency(r, b, p, actorOf(c))); } catch (e) { return fail(c, e); }
});
// ---------- assessments ----------
const assessmentsReply = (c: any, reviewId: string) => { const r2 = row(reviewId); return c.json({ ok: true, assessments: assessmentsOf(reviewId).map(withAssessmentNames), stage: r2.stage, progress: approvalProgress(r2) }); };
/** A board seat (chair, decision maker or reviewer) requests due diligence on the submission, naming the assessor. */
reviews.post("/reviews/:id/assessments", async (c) => {
  const r = row(c.req.param("id")); if (!r) return c.json({ error: "not found" }, 404);
  const b = z.object({ type: z.enum(ASSESSMENT_TYPES), title: z.string().max(200).optional().nullable(), area: z.string().optional().nullable(), assigned_to: z.string().min(1), due_at: z.string().optional().nullable() }).parse(await c.req.json());
  const p = currentPrincipal(); const chk = canRequestAssessment(p, r);
  if (!chk.ok) return forbidden(c, "approve_review", p, chk.reason);
  try { requestAssessment(r, p!, b, actorOf(c)); return assessmentsReply(c, r.id); } catch (e) { return fail(c, e); }
});
/** A decision-attached assessment (author-gathered evidence on a proposed decision) answered from the decisions table. */
const decisionOf = (a: { decision_id: string | null }) => (a.decision_id ? (db.prepare("SELECT id, code, status, author FROM decisions WHERE id=?").get(a.decision_id) as any) : null);
const decisionAssessmentsReply = (c: any, decisionId: string) => c.json({ ok: true, assessments: assessmentsOfDecision(decisionId).map(withAssessmentNames) });
/** Reassign an open assessment or move its due date (the same seats that request). */
reviews.put("/assessments/:id", async (c) => {
  const a = assessmentById(c.req.param("id")); if (!a) return c.json({ error: "not found" }, 404);
  if (!a.review_id) return c.json({ error: "a decision-attached assessment is the author's to manage; it has no board seats to reassign it" }, 409);
  const r = row(a.review_id); if (!r) return c.json({ error: "not found" }, 404);
  const b = z.object({ assigned_to: z.string().min(1).optional(), due_at: z.string().nullable().optional() }).parse(await c.req.json());
  const p = currentPrincipal(); const chk = canRequestAssessment(p, r);
  if (!chk.ok) return forbidden(c, "approve_review", p, chk.reason);
  try { reassignAssessment(a, r, b, actorOf(c)); return assessmentsReply(c, r.id); } catch (e) { return fail(c, e); }
});
/** The assessor records the result, as themselves; the summary travels with the submission and into the evidence pack. */
reviews.post("/assessments/:id/result", async (c) => {
  const a = assessmentById(c.req.param("id")); if (!a) return c.json({ error: "not found" }, 404);
  const b = z.object({ result: z.enum(ASSESSMENT_RESULTS), result_md: z.string().min(1), reference: z.string().max(2000).optional().nullable() }).parse(await c.req.json());
  const p = currentPrincipal(); if (!p) return forbidden(c, "comment", p, "sign in required");
  if (!a.review_id) {
    const d = decisionOf(a); if (!d) return c.json({ error: "not found" }, 404);
    try { recordDecisionAssessmentResult(a, d, p, b, actorOf(c)); return decisionAssessmentsReply(c, d.id); } catch (e) { return fail(c, e); }
  }
  const r = row(a.review_id); if (!r) return c.json({ error: "not found" }, 404);
  try { recordAssessmentResult(a, r, p, b, actorOf(c)); return assessmentsReply(c, r.id); } catch (e) { return fail(c, e); }
});
/** The assessment type catalogue, with the template a competent result follows (the UI inserts it as the summary's skeleton). */
reviews.get("/assessments/types", (c) => c.json(ASSESSMENT_TYPES.map((t) => ({ type: t, label: assessmentLabel({ type: t, title: null }), template: ASSESSMENT_TEMPLATES[t] }))));
/** The submitter attaches an assessment they already carried out: supporting information, recorded by its author, never blocking. */
// AI prefill of an assessment summary from the review content — a draft for whoever records the result; nothing is stored.
reviews.post("/reviews/:id/assessments/draft", async (c) => {
  const r = row(c.req.param("id")); if (!r) return c.json({ error: "not found" }, 404);
  const b = z.object({ type: z.enum(ASSESSMENT_TYPES) }).parse(await c.req.json());
  try { return c.json(await draftAssessmentSummary(r.id, b.type, ASSESSMENT_TEMPLATES[b.type])); }
  catch (e: any) { return c.json({ error: String(e.message || e).slice(0, 300) }, /not enabled/i.test(String(e.message)) ? 409 : e.status || 502); }
});
reviews.post("/reviews/:id/assessments/provide", async (c) => {
  const r = row(c.req.param("id")); if (!r) return c.json({ error: "not found" }, 404);
  const b = z.object({ type: z.enum(ASSESSMENT_TYPES), title: z.string().max(200).optional().nullable(), area: z.string().optional().nullable(), result: z.enum(ASSESSMENT_RESULTS), result_md: z.string().min(1), reference: z.string().max(2000).optional().nullable() }).parse(await c.req.json());
  const p = currentPrincipal(); const chk = canProvideAssessment(p, r);
  if (!chk.ok) return forbidden(c, "submit_review", p, chk.reason);
  try { provideAssessment(r, p!, b, actorOf(c)); return assessmentsReply(c, r.id); } catch (e) { return fail(c, e); }
});
/** The submitter keeps a provided assessment current (updates re-affirm it against the latest version). */
reviews.put("/assessments/:id/provided", async (c) => {
  const a = assessmentById(c.req.param("id")); if (!a) return c.json({ error: "not found" }, 404);
  const b = z.object({ result: z.enum(ASSESSMENT_RESULTS).optional(), result_md: z.string().optional(), reference: z.string().max(2000).optional().nullable() }).parse(await c.req.json());
  const p = currentPrincipal(); if (!p) return forbidden(c, "submit_review", p, "sign in required");
  if (!a.review_id) {
    const d = decisionOf(a); if (!d) return c.json({ error: "not found" }, 404);
    try { updateProvidedDecisionAssessment(a, d, p, b, actorOf(c)); return decisionAssessmentsReply(c, d.id); } catch (e) { return fail(c, e); }
  }
  const r = row(a.review_id); if (!r) return c.json({ error: "not found" }, 404);
  try { updateProvidedAssessment(a, r, p, b, actorOf(c)); return assessmentsReply(c, r.id); } catch (e) { return fail(c, e); }
});
/** The chair waives an open request with a recorded reason. */
reviews.post("/assessments/:id/waive", async (c) => {
  const a = assessmentById(c.req.param("id")); if (!a) return c.json({ error: "not found" }, 404);
  if (!a.review_id) return c.json({ error: "a decision-attached assessment never blocks anything, so there is nothing to waive" }, 409);
  const r = row(a.review_id); if (!r) return c.json({ error: "not found" }, 404);
  const b = z.object({ reason: z.string().min(1) }).parse(await c.req.json());
  const p = currentPrincipal(); const chk = canWaiveAssessment(p, r);
  if (!chk.ok) return forbidden(c, "decide_review", p, chk.reason);
  try { waiveAssessment(a, r, p!, b.reason, actorOf(c)); return assessmentsReply(c, r.id); } catch (e) { return fail(c, e); }
});

reviews.post("/reviews/:id/resubmit", async (c) => {
  const r = row(c.req.param("id")); if (!r) return c.json({ error: "not found" }, 404);
  const p = currentPrincipal();
  if (!p || p.id !== r.submitted_by) return forbidden(c, "resubmit", p, "only the submitter resubmits a review");
  if (r.stage !== "changes_requested") return c.json({ error: `review is ${r.stage}; only a review with changes requested is resubmitted` }, 409);
  const b = z.object({ summary: z.string().optional(), design_md: z.string().optional(), note: z.string().max(4000).optional() }).parse(await c.req.json().catch(() => ({})));
  const now = nowIso(), actor = actorOf(c);
  const superseded = supersedePositions(r.id);
  // completed assessment results assessed the earlier version: marked stale, never deleted; open requests stand
  const staleAssessments = markAssessmentsStale(r.id);
  db.prepare("UPDATE reviews SET stage='in_review', resubmitted_at=?, updated_at=?, summary=COALESCE(?, summary), design_md=COALESCE(?, design_md) WHERE id=?").run(now, now, b.summary ?? null, b.design_md === undefined ? null : stripTemplateHints(b.design_md), r.id);
  db.prepare(`INSERT INTO review_events(id,review_id,kind,actor,body_md,data_json,origin,verification,verified_by,verified_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(uid(), r.id, "resubmitted", actor, b.note || "Resubmitted after changes.", JSON.stringify({ approvals_superseded: superseded, positions_superseded: superseded, assessments_stale: staleAssessments }), "human", "verified", actor, now, now);
  audit(actor, "resubmit", "reviews", r.id, { approvals_superseded: superseded, positions_superseded: superseded, assessments_stale: staleAssessments });
  const r2 = row(r.id);
  return c.json({ ok: true, stage: r2.stage, progress: approvalProgress(r2) });
});

// ---------- decision ----------
reviews.post("/reviews/:id/decide", async (c) => {
  const r = row(c.req.param("id")); if (!r) return c.json({ error: "not found" }, 404);
  const b = DeclareIn.parse(await c.req.json());
  const problem = validateDeclare(b, r); if (problem) return c.json({ error: problem }, 400);
  const p = currentPrincipal(); const chk = canDecide(p, r, b.outcome);
  if (!chk.ok) return forbidden(c, b.outcome === "withdrawn" ? "submit_review" : "decide_review", p, chk.reason);
  const out = declareOutcome(r, b, chk, actorOf(c));
  return c.json(out);
});
reviews.post("/review-events/:id/verify", async (c) => { const body = await c.req.json().catch(() => ({})); setVerification("review_events", c.req.param("id"), body.verified !== false, actorOf(c)); return c.json({ ok: true }); });
reviews.post("/conditions/:id/close", async (c) => {
  const { status } = await c.req.json().catch(() => ({ status: "met" })); const id = c.req.param("id");
  db.prepare("UPDATE conditions SET status=?, closed_at=? WHERE id=?").run(status || "met", nowIso(), id);
  audit(actorOf(c), `condition:${status || "met"}`, "conditions", id); return c.json({ ok: true });
});
export type { ReviewType };
