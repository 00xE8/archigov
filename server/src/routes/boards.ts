import { Hono } from "hono";
import { z } from "zod";
import { db, j, uid, nowIso, audit } from "../db.js";
import { actorOf } from "../http.js";
import { BOARD_ROLES } from "../auth/roles.js";
import { currentPrincipal } from "../auth/context.js";
import { forbidden } from "../auth/middleware.js";
import { getUser, setMembership, setMemberAreas, removeMembership } from "../auth/users.js";
import { REVIEW_TYPES, isReviewType, boardById, policiesOf, policyFor, routeBoard, normalisePolicy, approvalProgress, memberRole, canDecide, OPEN_STAGES, type ReviewType } from "../boards/workflow.js";
import { declareOutcome } from "../boards/declare.js";
import { parseBoardAreas, normaliseAreasInput, boardAreas } from "../boards/areas.js";
import { sessionSummary } from "../boards/sessions.js";

/**
 * Boards: who sits on them in which seat (and, for decision makers, which areas of responsibility they own),
 * which reviews they receive (routing), how those are approved (policies) and which areas the board carries.
 * Platform admins create and configure boards (areas are configuration); a board's chair runs its members,
 * routing, policies and areas, its secretary the members and routing (not the policies). Sessions are the
 * board's own business (routes/sessions.ts): the platform admin only reads them.
 */
export const boards = new Hono();

type BoardArea = "members" | "routing" | "policies";
const manages = (boardId: string, area: BoardArea) => {
  const p = currentPrincipal(); if (!p) return false;
  if (p.is_platform_admin) return true;
  const role = memberRole(p, boardId);
  return role === "chair" || (role === "secretary" && area !== "policies");
};
const canOf = (boardId: string) => { const role = memberRole(currentPrincipal(), boardId); return { members: manages(boardId, "members"), routing: manages(boardId, "routing"), policies: manages(boardId, "policies"), areas: manages(boardId, "policies"), sessions: role === "chair" || role === "secretary" }; };
const isAdmin = () => !!currentPrincipal()?.is_platform_admin;
const load = (c: any) => boardById(c.req.param("id")) || (db.prepare("SELECT * FROM boards WHERE code=?").get(c.req.param("id").toUpperCase()) as any) || null;

const summary = (b: any) => ({
  id: b.id, code: b.code, name: b.name, purpose: b.purpose,
  members: (db.prepare("SELECT count(*) c FROM board_members WHERE board_id=?").get(b.id) as any).c,
  in_flight: (db.prepare("SELECT count(*) c FROM reviews WHERE board_id=? AND stage IN ('submitted','pre_review','in_review','changes_requested')").get(b.id) as any).c,
  areas: parseBoardAreas(b.areas_json),
  sessions_planned: (db.prepare("SELECT count(*) c FROM board_sessions WHERE board_id=? AND status IN ('planned','open')").get(b.id) as any).c,
  // the list page shows where each board stands: its next sitting and any area nobody owns
  next_session: ((s) => (s ? { id: s.id, code: s.code, status: s.status, scheduled_at: s.scheduled_at, items: sessionSummary(s).items } : null))(db.prepare("SELECT * FROM board_sessions WHERE board_id=? AND status IN ('planned','open') ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, scheduled_at LIMIT 1").get(b.id) as any),
  area_coverage: coverageOf(b),
  can_manage: manages(b.id, "members"),
  can: canOf(b.id),
});
const membersOf = (b: any) => {
  const ids = parseBoardAreas(b.areas_json).map((a) => a.id);
  return db.prepare("SELECT m.user_id, u.name, u.user_type, u.is_platform_admin, m.board_role, m.added_at, m.areas_json FROM board_members m LEFT JOIN users u ON u.id=m.user_id WHERE m.board_id=? ORDER BY CASE m.board_role WHEN 'chair' THEN 0 WHEN 'decision_maker' THEN 1 WHEN 'reviewer' THEN 2 WHEN 'secretary' THEN 3 ELSE 4 END, u.name").all(b.id)
    .map((m: any) => { const own: string[] = j(m.areas_json, []) || []; return { user_id: m.user_id, name: m.name || m.user_id, user_type: m.user_type ?? null, is_platform_admin: !!m.is_platform_admin, board_role: m.board_role === "member" ? "decision_maker" : m.board_role, added_at: m.added_at, areas: ids.filter((id) => own.includes(id)) }; });
};
/** Per area: the decision makers who own it (the UI warns when nobody does). */
const coverageOf = (b: any) => { const members = membersOf(b); return parseBoardAreas(b.areas_json).map((a) => ({ area: a.id, label: a.label, owners: members.filter((m) => m.board_role === "decision_maker" && m.areas.includes(a.id)).map((m) => m.user_id) })); };

/** A board's routing rules as the API shows them: the application condition names its applications. */
const routingOf = (boardId: string) => {
  const names = new Map((db.prepare("SELECT id, name FROM elements WHERE type='application' AND deleted_at IS NULL").all() as any[]).map((a) => [a.id, a.name]));
  return (db.prepare("SELECT id, review_type, kind, category, priority, application_ids_json, owner FROM board_routing WHERE board_id=? ORDER BY priority, review_type").all(boardId) as any[])
    .map(({ application_ids_json, ...r }) => { const ids: string[] = j(application_ids_json, []) || []; return { ...r, owner: r.owner || null, application_ids: ids, applications: ids.map((id) => ({ id, name: names.get(id) ?? null })) }; });
};
/** Review types a routing rule may scope to applications: the ones that are for an application. */
const APP_SCOPED_TYPES = ["design", "decision", "exception"];

boards.get("/boards", (c) => c.json((db.prepare("SELECT * FROM boards ORDER BY code").all() as any[]).map(summary)));
boards.get("/boards/route", (c) => {
  const type = c.req.query("type");
  if (!isReviewType(type)) return c.json({ error: `type must be one of ${REVIEW_TYPES.join(", ")}` }, 400);
  const apps = (c.req.queries("application") || []).flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean);
  const b = routeBoard(type, c.req.query("kind") || null, c.req.query("category") || null, apps);
  return c.json(b ? { ...summary(b), policy: policyFor(b.id, type) } : { error: "no board can receive this review (no routing rule and no board coded DA)" }, b ? 200 : 404);
});
boards.get("/boards/:id", (c) => {
  const b = load(c); if (!b) return c.json({ error: "not found" }, 404);
  const routing = routingOf(b.id);
  const inFlight = (db.prepare("SELECT * FROM reviews WHERE board_id=? AND stage IN ('submitted','pre_review','in_review','changes_requested') ORDER BY created_at DESC").all(b.id) as any[])
    .map((r) => ({ id: r.id, code: r.code, title: r.title, type: r.type, stage: r.stage, submitted_by: r.submitted_by, created_at: r.created_at, areas: j(r.areas_json, []) || [], deferred_count: r.deferred_count || 0, progress: approvalProgress(r) }));
  const sessions = (db.prepare("SELECT * FROM board_sessions WHERE board_id=? ORDER BY scheduled_at DESC LIMIT 5").all(b.id) as any[]).map(sessionSummary);
  return c.json({ ...summary(b), created_at: b.created_at, members: membersOf(b), routing, policies: policiesOf(b.id), reviews_in_flight: inFlight, sessions, area_coverage: coverageOf(b) });
});

const BoardIn = z.object({ code: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_-]{1,15}$/), name: z.string().trim().min(1).max(200), purpose: z.string().max(2000).optional() });
boards.post("/boards", async (c) => {
  if (!isAdmin()) return forbidden(c, "manage_platform", currentPrincipal(), "only a platform admin creates boards");
  const b = BoardIn.parse(await c.req.json()); const code = b.code.toUpperCase();
  if (db.prepare("SELECT 1 FROM boards WHERE code=?").get(code)) return c.json({ error: `board ${code} already exists` }, 409);
  const id = uid();
  db.prepare("INSERT INTO boards(id,code,name,purpose,created_at) VALUES (?,?,?,?,?)").run(id, code, b.name, b.purpose || null, nowIso());
  audit(actorOf(c), "create", "boards", id, { code, name: b.name });
  return c.json(summary(boardById(id)));
});
/** Name and purpose are the platform admin's; the areas of responsibility are configuration the chair may also set. */
boards.put("/boards/:id", async (c) => {
  const b0 = boardById(c.req.param("id")); if (!b0) return c.json({ error: "not found" }, 404);
  const p = currentPrincipal(); const chair = memberRole(p, b0.id) === "chair";
  const b = BoardIn.omit({ code: true }).partial().extend({ areas: z.array(z.any()).optional() }).parse(await c.req.json());
  if ((b.name !== undefined || b.purpose !== undefined) && !isAdmin()) return forbidden(c, "manage_platform", p, "only a platform admin edits a board's name and purpose");
  if (b.areas !== undefined && !isAdmin() && !chair) return forbidden(c, "manage_board", p, `only a platform admin or the chair of ${b0.code} sets its areas of responsibility`);
  if (b.name !== undefined || b.purpose !== undefined) {
    db.prepare("UPDATE boards SET name=?, purpose=? WHERE id=?").run(b.name ?? b0.name, b.purpose === undefined ? b0.purpose : b.purpose, b0.id);
    audit(actorOf(c), "update", "boards", b0.id, { name: b.name, purpose: b.purpose });
  }
  if (b.areas !== undefined) {
    let areas; try { areas = normaliseAreasInput(b.areas); } catch (e: any) { return c.json({ error: e.message }, 400); }
    const before = boardAreas(b0.id).map((a) => a.id); const ids = areas.map((a) => a.id);
    db.transaction(() => {
      db.prepare("UPDATE boards SET areas_json=? WHERE id=?").run(JSON.stringify(areas), b0.id);
      // an area the board no longer has is no longer anyone's
      for (const m of db.prepare("SELECT user_id, areas_json FROM board_members WHERE board_id=?").all(b0.id) as any[]) {
        const own: string[] = j(m.areas_json, []) || []; const kept = own.filter((a) => ids.includes(a));
        if (kept.length !== own.length) db.prepare("UPDATE board_members SET areas_json=? WHERE board_id=? AND user_id=?").run(JSON.stringify(kept), b0.id, m.user_id);
      }
    })();
    audit(actorOf(c), "board:areas", "boards", b0.id, { from: before, to: ids, removed: before.filter((a) => !ids.includes(a)) });
  }
  return c.json({ ...summary(boardById(b0.id)), area_coverage: coverageOf(boardById(b0.id)) });
});
const areasOnBoard = (boardId: string, areas: unknown) => {
  if (areas === undefined || areas === null) return undefined;
  if (!Array.isArray(areas) || !areas.every((a) => typeof a === "string")) throw Object.assign(new Error("areas must be a list of area ids"), { status: 400 });
  const ids = boardAreas(boardId).map((a) => a.id); const bad = (areas as string[]).filter((a) => !ids.includes(a));
  if (bad.length) throw Object.assign(new Error(`not areas of this board: ${bad.join(", ")} (areas: ${ids.join(", ") || "none"})`), { status: 400 });
  return ids.filter((id) => (areas as string[]).includes(id));
};
boards.post("/boards/:id/members", async (c) => {
  const b = boardById(c.req.param("id")); if (!b) return c.json({ error: "not found" }, 404);
  if (!manages(b.id, "members")) return forbidden(c, "manage_board", currentPrincipal(), `only a platform admin, the chair or the secretary of ${b.code} manages its members`);
  const m = z.object({ user_id: z.string().trim().min(1), board_role: z.enum(BOARD_ROLES), areas: z.array(z.string()).optional() }).parse(await c.req.json());
  if (!getUser(m.user_id)) return c.json({ error: `unknown user ${m.user_id}; create them first (POST /users)` }, 404);
  let areas; try { areas = areasOnBoard(b.id, m.areas); } catch (e: any) { return c.json({ error: e.message }, 400); }
  setMembership(b.id, m.user_id, m.board_role, areas);
  audit(actorOf(c), "board_member:set", "boards", b.id, { user_id: m.user_id, board_role: m.board_role, ...(areas ? { areas } : {}) });
  return c.json({ ok: true, board: b.code, user_id: m.user_id, board_role: m.board_role, areas: areas ?? (membersOf(b).find((x) => x.user_id === m.user_id)?.areas ?? []) });
});
/** The areas a member owns (meaningful for decision makers; stored for any seat). */
boards.put("/boards/:id/members/:userId", async (c) => {
  const b = boardById(c.req.param("id")); if (!b) return c.json({ error: "not found" }, 404);
  if (!manages(b.id, "members")) return forbidden(c, "manage_board", currentPrincipal(), `only a platform admin, the chair or the secretary of ${b.code} manages its members`);
  const userId = c.req.param("userId");
  if (!db.prepare("SELECT 1 FROM board_members WHERE board_id=? AND user_id=?").get(b.id, userId)) return c.json({ error: `${userId} is not a member of ${b.code}` }, 404);
  const m = z.object({ areas: z.array(z.string()) }).parse(await c.req.json());
  let areas; try { areas = areasOnBoard(b.id, m.areas)!; } catch (e: any) { return c.json({ error: e.message }, 400); }
  setMemberAreas(b.id, userId, areas);
  audit(actorOf(c), "board_member:areas", "boards", b.id, { user_id: userId, areas });
  return c.json({ ok: true, board: b.code, user_id: userId, areas, area_coverage: coverageOf(boardById(b.id)) });
});
boards.delete("/boards/:id/members/:userId", (c) => {
  const b = boardById(c.req.param("id")); if (!b) return c.json({ error: "not found" }, 404);
  if (!manages(b.id, "members")) return forbidden(c, "manage_board", currentPrincipal(), `only a platform admin, the chair or the secretary of ${b.code} manages its members`);
  const removed = removeMembership(b.id, c.req.param("userId"));
  if (removed) audit(actorOf(c), "board_member:remove", "boards", b.id, { user_id: c.req.param("userId") });
  return c.json({ ok: removed });
});
boards.put("/boards/:id/policies/:reviewType", async (c) => {
  const b = boardById(c.req.param("id")); if (!b) return c.json({ error: "not found" }, 404);
  if (!manages(b.id, "policies")) return forbidden(c, "manage_board", currentPrincipal(), `only a platform admin or the chair of ${b.code} changes its approval policies`);
  const type = c.req.param("reviewType"); if (!isReviewType(type)) return c.json({ error: `review type must be one of ${REVIEW_TYPES.join(", ")}` }, 400);
  let policy; try { policy = normalisePolicy((await c.req.json()).policy); } catch (e: any) { return c.json({ error: e.message }, 400); }
  if (policy.fast_lane?.enabled && type !== "design") return c.json({ error: "the fast lane applies to design reviews only" }, 400);
  db.prepare("INSERT INTO approval_policies(board_id,review_type,policy_json) VALUES (?,?,?) ON CONFLICT(board_id,review_type) DO UPDATE SET policy_json=excluded.policy_json").run(b.id, type, JSON.stringify(policy));
  audit(actorOf(c), "policy:set", "boards", b.id, { review_type: type, steps: policy.steps.map((s) => s.kind), mode: policy.steps.find((s) => s.kind === "approvals")?.mode ?? null, fast_lane: policy.fast_lane ?? null });
  return c.json({ ok: true, board: b.code, review_type: type, policy });
});
/**
 * The fast lane, board-wide: every open review the lane currently satisfies, and the chair declaring them approved
 * together (each one re-checked; an item that left the lane, or that this caller may not decide, is skipped with why).
 */
const fastLaneItems = (boardId: string) => (db.prepare("SELECT * FROM reviews WHERE board_id=? AND type='design' AND stage IN ('submitted','pre_review','in_review') ORDER BY created_at").all(boardId) as any[])
  .map((r) => ({ r, progress: approvalProgress(r) })).filter((x) => x.progress.via_fast_lane);
boards.get("/boards/:id/fast-lane", (c) => {
  const b = boardById(c.req.param("id")); if (!b) return c.json({ error: "not found" }, 404);
  const p = currentPrincipal();
  return c.json(fastLaneItems(b.id).map(({ r, progress }) => ({ id: r.id, code: r.code, title: r.title, application_id: r.application_id, submitted_by: r.submitted_by, created_at: r.created_at, fast_lane: progress.fast_lane, can_declare: canDecide(p, r, "approved").ok })));
});
boards.post("/boards/:id/fast-lane/declare", async (c) => {
  const b = boardById(c.req.param("id")); if (!b) return c.json({ error: "not found" }, 404);
  const body = z.object({ review_ids: z.array(z.string()).optional(), rationale: z.string().max(4000).optional() }).parse(await c.req.json().catch(() => ({})));
  const p = currentPrincipal(); const actor = actorOf(c);
  const items = fastLaneItems(b.id).filter((x) => !body.review_ids || body.review_ids.includes(x.r.id));
  const declared: { id: string; code: string; stage: string }[] = [], skipped: { id: string; code: string | null; reason: string }[] = [];
  for (const id of body.review_ids || []) if (!items.some((x) => x.r.id === id)) { const r = db.prepare("SELECT code, board_id, stage FROM reviews WHERE id=?").get(id) as any; skipped.push({ id, code: r?.code ?? null, reason: !r ? "not found" : r.board_id !== b.id ? `not on ${b.code}` : !OPEN_STAGES.includes(r.stage) ? `review is ${r.stage}` : "not in the fast lane" }); }
  for (const { r } of items) {
    const chk = canDecide(p, r, "approved");
    if (!chk.ok) { skipped.push({ id: r.id, code: r.code, reason: chk.reason || "may not decide" }); continue; }
    const out = declareOutcome(r, { outcome: "approved", rationale: body.rationale || "Approved in the fast lane: low risk, follows adopted patterns, every check passed." }, chk, actor);
    declared.push({ id: r.id, code: r.code, stage: out.stage });
  }
  if (!declared.length && skipped.length && skipped.every((s) => /seat|member|sign in/.test(s.reason))) return forbidden(c, "decide_review", p, skipped[0].reason);
  return c.json({ declared, skipped });
});
boards.put("/boards/:id/routing", async (c) => {
  const b = boardById(c.req.param("id")); if (!b) return c.json({ error: "not found" }, 404);
  if (!manages(b.id, "routing")) return forbidden(c, "manage_board", currentPrincipal(), `only a platform admin, the chair or the secretary of ${b.code} changes its routing`);
  const rules = z.array(z.object({ review_type: z.enum(REVIEW_TYPES), kind: z.string().trim().nullable().optional(), category: z.string().trim().nullable().optional(), priority: z.number().int().min(0).max(10000).default(100),
    application_ids: z.array(z.string().trim().min(1)).max(500).optional().nullable(), owner: z.string().trim().max(200).optional().nullable() })).parse(await c.req.json());
  const isApp = db.prepare("SELECT 1 FROM elements WHERE id=? AND type='application' AND deleted_at IS NULL");
  for (const r of rules) {
    const ids = Array.from(new Set(r.application_ids || []));
    if ((ids.length || r.owner) && !APP_SCOPED_TYPES.includes(r.review_type)) return c.json({ error: `a ${r.review_type} review is not for an application: only design, decision and exception rules may name applications or an owner` }, 400);
    const unknown = ids.filter((id) => !isApp.get(id));
    if (unknown.length) return c.json({ error: `not an application: ${unknown.join(", ")}` }, 400);
    r.application_ids = ids;
  }
  db.transaction(() => {
    db.prepare("DELETE FROM board_routing WHERE board_id=?").run(b.id);
    for (const r of rules) db.prepare("INSERT INTO board_routing(id,board_id,review_type,kind,category,priority,application_ids_json,owner) VALUES (?,?,?,?,?,?,?,?)")
      .run(uid(), b.id, r.review_type, r.kind || null, r.category || null, r.priority, r.application_ids?.length ? JSON.stringify(r.application_ids) : null, r.owner || null);
  })();
  audit(actorOf(c), "routing:set", "boards", b.id, { rules: rules.length, by_application: rules.filter((r) => r.application_ids?.length || r.owner).length });
  return c.json({ ok: true, board: b.code, routing: routingOf(b.id) });
});
export type { ReviewType };
