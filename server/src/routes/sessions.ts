import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db.js";
import { actorOf } from "../http.js";
import { currentPrincipal } from "../auth/context.js";
import { forbidden } from "../auth/middleware.js";
import { boardById, canDecide, memberRole, type SessionRow } from "../boards/workflow.js";
import { reviewRow } from "../reviews.js";
import { draftSessionNotes } from "../ai.js";
import { declareOutcome, validateDeclare, DeclareIn, type DeclareBody } from "../boards/declare.js";
import { sessionByIdOrCode, sessionItems, sessionView, sessionSummary, sessionRights, createSession, refreshAgenda, reorderAgenda, recordAttendance, delegate, revokeDelegation, openSession, callItem, nominateActingChair, pullItem, declareConsent, setNotes, closeSession, minutesMarkdown } from "../boards/sessions.js";

/**
 * Board sessions. Rights are the board's seats, never the platform-admin flag: the chair or secretary plans and
 * runs the agenda and records attendance; the chair (or an item's acting chair) opens, calls, declares, closes;
 * decision makers delegate their own seat and attend; any member records their own attendance. The route gate
 * (auth/roles.ts) lets seat holders through; each handler checks the seat on this session's board.
 */
export const sessions = new Hono();

const load = (c: any): SessionRow | null => sessionByIdOrCode(c.req.param("id"));
const notFound = (c: any) => c.json({ error: "not found" }, 404);
const fail = (c: any, e: any) => { const status = typeof e?.status === "number" ? e.status : 500; if (status >= 500) throw e; return c.json({ error: e.message }, status); };
/** A refusal in the vocabulary of the capability the action maps to. */
const refuse = (c: any, s: SessionRow, what: string, cap: "manage_board" | "decide_review" | "approve_review" | "comment" = "manage_board") => {
  const p = currentPrincipal(); const role = memberRole(p, s.board_id); const b = boardById(s.board_id);
  return forbidden(c, cap, p, `${what} ${b?.code ?? "this board"}${role ? ` (you hold the ${role} seat)` : p?.is_platform_admin ? " (the platform admin runs the instance, not its boards)" : " (not a member)"}`);
};

/** Every sitting across boards: `?board=<id|code>`, `?status=planned,open` (comma list); forthcoming ones soonest first (the open one leads), closed ones newest first. */
sessions.get("/sessions", (c) => {
  const p = currentPrincipal();
  const board = c.req.query("board"), statuses = (c.req.query("status") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const rank = (s: any) => (s.status === "open" ? 0 : s.status === "planned" ? 1 : 2);
  const rows = (db.prepare("SELECT s.*, b.code board_code, b.name board_name FROM board_sessions s JOIN boards b ON b.id=s.board_id").all() as any[])
    .filter((s) => (!board || s.board_id === board || s.board_code === board.toUpperCase()) && (!statuses.length || statuses.includes(s.status)))
    .sort((a, b) => rank(a) - rank(b) || (a.status === "closed" ? String(b.scheduled_at).localeCompare(String(a.scheduled_at)) : String(a.scheduled_at).localeCompare(String(b.scheduled_at))))
    .map((s) => ({ ...sessionSummary(s), board: { id: s.board_id, code: s.board_code, name: s.board_name }, consent_count: sessionItems(s.id).filter((i) => i.consent && i.state === "listed").length, my_role: memberRole(p, s.board_id) }));
  return c.json(rows);
});
sessions.get("/boards/:id/sessions", (c) => {
  const b = boardById(c.req.param("id")) || (db.prepare("SELECT * FROM boards WHERE code=?").get(c.req.param("id").toUpperCase()) as any);
  if (!b) return notFound(c);
  return c.json((db.prepare("SELECT * FROM board_sessions WHERE board_id=? ORDER BY scheduled_at DESC").all(b.id) as SessionRow[]).map(sessionSummary));
});
sessions.post("/boards/:id/sessions", async (c) => {
  const b = boardById(c.req.param("id")) || (db.prepare("SELECT * FROM boards WHERE code=?").get(c.req.param("id").toUpperCase()) as any);
  if (!b) return notFound(c);
  const p = currentPrincipal(); const role = memberRole(p, b.id);
  if (role !== "chair" && role !== "secretary") return forbidden(c, "manage_board", p, `only the chair or secretary of ${b.code} plans its sessions`);
  const body = z.object({ scheduled_at: z.string().min(4), title: z.string().max(200).optional().nullable() }).parse(await c.req.json());
  if (Number.isNaN(Date.parse(body.scheduled_at))) return c.json({ error: "scheduled_at must be an ISO date" }, 400);
  const s = createSession(b, body, actorOf(c));
  return c.json(sessionView(s, p));
});
sessions.get("/sessions/:id", (c) => { const s = load(c); return s ? c.json(sessionView(s, currentPrincipal())) : notFound(c); });
sessions.get("/sessions/:id/minutes", (c) => {
  const s = load(c); if (!s) return notFound(c);
  if (s.status !== "closed" || !s.minutes_json) return c.json({ error: "minutes are derived when the session closes" }, 404);
  const minutes = JSON.parse(s.minutes_json);
  return c.json({ minutes, minutes_hash: s.minutes_hash, markdown: minutesMarkdown(minutes) });
});
sessions.post("/sessions/:id/agenda/refresh", async (c) => {
  const s = load(c); if (!s) return notFound(c);
  if (!sessionRights(currentPrincipal(), s).can.manage) return refuse(c, s, "only the chair or secretary refreshes the agenda of");
  const body = z.object({ include_circulation: z.boolean().optional() }).parse(await c.req.json().catch(() => ({})));
  try { const added = refreshAgenda(s, actorOf(c), !!body.include_circulation); return c.json({ ok: true, added, ...sessionView(s, currentPrincipal()) }); } catch (e) { return fail(c, e); }
});
sessions.put("/sessions/:id/agenda", async (c) => {
  const s = load(c); if (!s) return notFound(c);
  if (!sessionRights(currentPrincipal(), s).can.manage) return refuse(c, s, "only the chair or secretary reorders the agenda of");
  const body = z.object({ items: z.array(z.object({ review_id: z.string(), position: z.number().int().min(0) })) }).parse(await c.req.json());
  try { reorderAgenda(s, body.items, actorOf(c)); return c.json(sessionView(s, currentPrincipal())); } catch (e) { return fail(c, e); }
});
sessions.post("/sessions/:id/attendance", async (c) => {
  const s = load(c); if (!s) return notFound(c);
  const p = currentPrincipal()!; const rights = sessionRights(p, s);
  const body = z.object({ user_id: z.string().optional(), status: z.enum(["present", "apologies", "absent"]) }).parse(await c.req.json());
  const target = body.user_id || p.id;
  if (target === p.id) { if (!rights.member) return refuse(c, s, "only a member records their own attendance at a session of", "comment"); }
  else if (!rights.can.record_attendance) return refuse(c, s, "only the chair or secretary records attendance for others at a session of");
  try { recordAttendance(s, target, body.status, actorOf(c)); return c.json({ ok: true, attendance: sessionView(s, p).attendance }); } catch (e) { return fail(c, e); }
});
sessions.post("/sessions/:id/delegations", async (c) => {
  const s = load(c); if (!s) return notFound(c);
  const p = currentPrincipal()!;
  const body = z.object({ delegate: z.string().min(1), areas: z.array(z.string()).optional().nullable(), delegator: z.string().optional(), on_instruction: z.boolean().optional() }).parse(await c.req.json());
  try { const d = delegate(s, { delegator: body.delegator || p.id, delegate: body.delegate, areas: body.areas, on_instruction: body.on_instruction }, p, actorOf(c)); return c.json({ ok: true, delegation: d, ...sessionView(s, p) }); }
  catch (e: any) { return e?.status === 403 ? forbidden(c, "approve_review", p, e.message) : fail(c, e); }
});
sessions.delete("/sessions/:id/delegations/:did", (c) => {
  const s = load(c); if (!s) return notFound(c);
  const p = currentPrincipal()!;
  try { revokeDelegation(s, c.req.param("did"), p, actorOf(c)); return c.json({ ok: true }); } catch (e: any) { return e?.status === 403 ? forbidden(c, "approve_review", p, e.message) : fail(c, e); }
});
sessions.post("/sessions/:id/open", (c) => {
  const s = load(c); if (!s) return notFound(c);
  if (!sessionRights(currentPrincipal(), s).chair) return refuse(c, s, "only the chair opens a session of", "decide_review");
  try { return c.json(sessionView(openSession(s, actorOf(c)), currentPrincipal())); } catch (e) { return fail(c, e); }
});
sessions.post("/sessions/:id/close", async (c) => {
  const s = load(c); if (!s) return notFound(c);
  if (!sessionRights(currentPrincipal(), s).chair) return refuse(c, s, "only the chair closes a session of", "decide_review");
  const body = z.object({ notes_md: z.string().max(20000).optional() }).parse(await c.req.json().catch(() => ({})));
  try { return c.json(sessionView(closeSession(s, body, actorOf(c)), currentPrincipal())); } catch (e) { return fail(c, e); }
});
sessions.put("/sessions/:id/notes", async (c) => {
  const s = load(c); if (!s) return notFound(c);
  if (!sessionRights(currentPrincipal(), s).can.manage) return refuse(c, s, "only the chair or secretary writes the notes of a session of");
  const body = z.object({ notes_md: z.string().max(20000) }).parse(await c.req.json());
  try { setNotes(s, body.notes_md, actorOf(c)); return c.json({ ok: true }); } catch (e) { return fail(c, e); }
});
// AI draft of the secretary's narrative from the session's own records — the same seats that write the notes; nothing is stored.
sessions.post("/sessions/:id/draft-notes", async (c) => {
  const s = load(c); if (!s) return notFound(c);
  if (!sessionRights(currentPrincipal(), s).can.manage) return refuse(c, s, "only the chair or secretary drafts the notes of a session of");
  try { return c.json(await draftSessionNotes(sessionView(s, currentPrincipal()))); }
  catch (e: any) { return c.json({ error: String(e.message || e).slice(0, 300) }, /not enabled/i.test(String(e.message)) ? 409 : e.status || 502); }
});
sessions.post("/sessions/:id/consent/declare", async (c) => {
  const s = load(c); if (!s) return notFound(c);
  const p = currentPrincipal()!;
  if (!sessionRights(p, s).chair) return refuse(c, s, "only the chair declares the consent agenda of", "decide_review");
  const body = z.object({ rationale: z.string().max(4000).optional() }).parse(await c.req.json().catch(() => ({})));
  try { return c.json(declareConsent(s, p, body.rationale, actorOf(c))); } catch (e) { return fail(c, e); }
});

// ---------- items ----------
const item = (c: any, s: SessionRow) => { const r = reviewRow(c.req.param("reviewId")); return r && sessionItems(s.id).some((i) => i.review_id === r.id) ? r : null; };
const actsAsChair = (p: any, s: SessionRow, reviewId: string) => sessionRights(p, s).chair || !!db.prepare("SELECT 1 FROM session_items WHERE session_id=? AND review_id=? AND acting_chair=?").get(s.id, reviewId, p?.id ?? "");
sessions.post("/sessions/:id/items/:reviewId/call", (c) => {
  const s = load(c); if (!s) return notFound(c); const r = item(c, s); if (!r) return notFound(c);
  if (!actsAsChair(currentPrincipal(), s, r.id)) return refuse(c, s, "only the chair (or the item's acting chair) calls an item at a session of", "decide_review");
  try { callItem(s, r.id, actorOf(c)); return c.json({ ok: true }); } catch (e) { return fail(c, e); }
});
sessions.post("/sessions/:id/items/:reviewId/nominate", async (c) => {
  const s = load(c); if (!s) return notFound(c); const r = item(c, s); if (!r) return notFound(c);
  if (!sessionRights(currentPrincipal(), s).chair) return refuse(c, s, "only the chair nominates an acting chair at a session of", "decide_review");
  const body = z.object({ acting_chair: z.string().min(1) }).parse(await c.req.json());
  try { nominateActingChair(s, r.id, body.acting_chair, actorOf(c)); return c.json({ ok: true, acting_chair: body.acting_chair }); } catch (e) { return fail(c, e); }
});
sessions.post("/sessions/:id/items/:reviewId/pull", (c) => {
  const s = load(c); if (!s) return notFound(c); const r = item(c, s); if (!r) return notFound(c);
  if (!sessionRights(currentPrincipal(), s).chair) return refuse(c, s, "only the chair pulls an item from the consent agenda of", "decide_review");
  try { pullItem(s, r.id, actorOf(c)); return c.json({ ok: true }); } catch (e) { return fail(c, e); }
});
/** Same code as POST /reviews/:id/decide: the item must be on this session's agenda, which is open. */
async function declareHere(c: any, s: SessionRow, body: DeclareBody) {
  const r = item(c, s); if (!r) return notFound(c);
  if (s.status !== "open") return c.json({ error: `the session is ${s.status}` }, 409);
  const p = currentPrincipal();
  const problem = validateDeclare(body, r);
  if (problem) return c.json({ error: problem }, 400);
  const chk = canDecide(p, r, body.outcome);
  if (!chk.ok) return forbidden(c, body.outcome === "withdrawn" ? "submit_review" : "decide_review", p, chk.reason);
  const out = declareOutcome(r, body, chk, actorOf(c));
  return c.json({ ...out, review: { id: r.id, code: r.code } });
}
sessions.post("/sessions/:id/items/:reviewId/declare", async (c) => { const s = load(c); if (!s) return notFound(c); return declareHere(c, s, DeclareIn.parse(await c.req.json())); });
sessions.post("/sessions/:id/items/:reviewId/defer", async (c) => {
  const s = load(c); if (!s) return notFound(c);
  const body = z.object({ reason: z.string().min(1).max(4000) }).parse(await c.req.json());
  return declareHere(c, s, { outcome: "deferred", reason: body.reason, rationale: body.reason });
});
