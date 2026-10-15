import { createHash } from "node:crypto";
import { db, j, uid, nowIso, audit, canonical } from "../db.js";
import { nextCode } from "../http.js";
import { getUser } from "../auth/users.js";
import type { Principal } from "../auth/context.js";
import { reviewRow, targetOf, userName } from "../reviews.js";
import { approvalProgress, livePositions, liveDelegations, delegationsOf, presentUsers, boardById, sessionById, memberRole, canDecide, declareOutcomes, type SessionRow, type SessionItem, type Progress, type BoardRow } from "./workflow.js";
import { boardAreas, memberAreas, areaLabel } from "./areas.js";
import { declareOutcome, addEvent } from "./declare.js";

/**
 * Board sessions: a sitting of a board with a derived agenda (the reviews routed to it that are open, ready ones
 * first), attendance, one-hop delegations for the sitting, a consent agenda for items already satisfied when the
 * session opens, and derived minutes hashed into the audit chain when it closes. Nothing here is authored except
 * the secretary's notes; agenda and minutes are what the records say.
 */
export type ItemState = "awaiting_positions" | "open" | "blocked" | "ready" | "declared" | "deferred" | "withdrawn";
const err = (status: number, message: string) => Object.assign(new Error(message), { status });

export const sessionByIdOrCode = (idOrCode: string): SessionRow | null => sessionById(idOrCode) ?? ((db.prepare("SELECT * FROM board_sessions WHERE code=?").get(idOrCode.toUpperCase()) as SessionRow | undefined) ?? null);
export const sessionItems = (sessionId: string): SessionItem[] => db.prepare("SELECT * FROM session_items WHERE session_id=? ORDER BY position").all(sessionId) as SessionItem[];

/** Reviews a session of this board could list: open ones routed to it (circulation only when overdue, or on request) not already on another forthcoming session; ready first, then the most deferred, then oldest. */
export function eligibleReviews(boardId: string, excludeSessionId: string | null, includeCirculation = false): any[] {
  const rows = db.prepare(`SELECT * FROM reviews WHERE board_id=? AND (stage IN ('submitted','pre_review','in_review','changes_requested') OR (stage='approved_subject_to_circulation' AND (? OR (circulation_due IS NOT NULL AND circulation_due < ?))))
    AND id NOT IN (SELECT i.review_id FROM session_items i JOIN board_sessions s ON s.id=i.session_id WHERE s.status IN ('planned','open') AND s.id IS NOT ?) ORDER BY created_at`).all(boardId, includeCirculation ? 1 : 0, nowIso(), excludeSessionId) as any[];
  return rows.map((r) => ({ r, ready: approvalProgress(r).ready ? 0 : 1 }))
    .sort((a, b) => a.ready - b.ready || (b.r.deferred_count || 0) - (a.r.deferred_count || 0) || String(a.r.created_at).localeCompare(String(b.r.created_at)))
    .map((x) => x.r);
}

export function createSession(board: BoardRow, input: { scheduled_at: string; title?: string | null }, actor: string): SessionRow {
  const id = uid(), now = nowIso(), code = nextCode("board_sessions", "SES");
  db.prepare("INSERT INTO board_sessions(id,code,board_id,title,scheduled_at,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,'planned',?,?,?)").run(id, code, board.id, input.title || null, input.scheduled_at, actor, now, now);
  const items = eligibleReviews(board.id, id);
  const ins = db.prepare("INSERT INTO session_items(session_id,review_id,position) VALUES (?,?,?)");
  items.forEach((r, i) => ins.run(id, r.id, i + 1));
  audit(actor, "session:create", "sessions", id, { code, board: board.code, scheduled_at: input.scheduled_at, items: items.length });
  return sessionById(id)!;
}
/** Add newly eligible reviews at the end of the agenda. */
export function refreshAgenda(session: SessionRow, actor: string, includeCirculation = false): number {
  if (session.status === "closed") throw err(409, "the session is closed");
  const listed = new Set(sessionItems(session.id).map((i) => i.review_id));
  const next = (db.prepare("SELECT COALESCE(max(position),0) n FROM session_items WHERE session_id=?").get(session.id) as any).n as number;
  const added = eligibleReviews(session.board_id, session.id, includeCirculation).filter((r) => !listed.has(r.id));
  const ins = db.prepare("INSERT INTO session_items(session_id,review_id,position) VALUES (?,?,?)");
  added.forEach((r, i) => ins.run(session.id, r.id, next + i + 1));
  audit(actor, "session:agenda", "sessions", session.id, { refreshed: true, added: added.map((r) => r.code) });
  return added.length;
}
/** Reorder, and drop `listed` items left out; an item already called, declared or deferred stays. */
export function reorderAgenda(session: SessionRow, items: { review_id: string; position: number }[], actor: string) {
  if (session.status === "closed") throw err(409, "the session is closed");
  const current = sessionItems(session.id);
  const keep = new Map(items.map((i) => [i.review_id, i.position]));
  const removed: string[] = [];
  db.transaction(() => {
    for (const it of current) {
      if (keep.has(it.review_id)) continue;
      if (it.state !== "listed") throw err(409, `${reviewRow(it.review_id)?.code ?? it.review_id} is ${it.state} and cannot be removed from the agenda`);
      db.prepare("DELETE FROM session_items WHERE session_id=? AND review_id=?").run(session.id, it.review_id); removed.push(it.review_id);
    }
    const ordered = current.filter((it) => keep.has(it.review_id)).sort((a, b) => (keep.get(a.review_id)! - keep.get(b.review_id)!) || a.position - b.position);
    ordered.forEach((it, i) => db.prepare("UPDATE session_items SET position=? WHERE session_id=? AND review_id=?").run(i + 1, session.id, it.review_id));
  })();
  audit(actor, "session:agenda", "sessions", session.id, { reordered: items.length, removed: removed.length });
}

// ---------- attendance & delegations ----------
export function recordAttendance(session: SessionRow, userId: string, status: "present" | "apologies" | "absent", recordedBy: string, onBehalfOf: string | null = null) {
  if (session.status === "closed") throw err(409, "the session is closed");
  const role = (db.prepare("SELECT board_role FROM board_members WHERE board_id=? AND user_id=?").get(session.board_id, userId) as any)?.board_role ?? null;
  db.prepare(`INSERT INTO session_attendance(session_id,user_id,board_role,status,on_behalf_of,recorded_by,at) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(session_id,user_id) DO UPDATE SET status=excluded.status, board_role=excluded.board_role, on_behalf_of=COALESCE(excluded.on_behalf_of, session_attendance.on_behalf_of), recorded_by=excluded.recorded_by, at=excluded.at`)
    .run(session.id, userId, role, status, onBehalfOf, recordedBy, nowIso());
  audit(recordedBy, "session:attendance", "sessions", session.id, { user_id: userId, status, on_behalf_of: onBehalfOf, self: recordedBy === userId });
}
export interface DelegationInput { delegator: string; delegate: string; areas?: string[] | null; on_instruction?: boolean }
/**
 * One hop, for one session, recorded by the delegator or by the secretary on instruction. Never to an auditor, a
 * service account, the author of an agenda item, or someone already holding another seat's delegation here.
 */
export function delegate(session: SessionRow, input: DelegationInput, p: Principal, actor: string) {
  if (session.status === "closed") throw err(409, "the session is closed");
  const role = memberRole(p, session.board_id);
  const self = input.delegator === p.id;
  if (!self && !(role === "secretary" || role === "chair")) throw err(403, "a decision maker delegates their own seat; the secretary records a delegation on instruction");
  if (!self && !input.on_instruction) throw err(400, "recording another member's delegation needs on_instruction: true");
  const delegatorRole = (db.prepare("SELECT board_role FROM board_members WHERE board_id=? AND user_id=?").get(session.board_id, input.delegator) as any)?.board_role;
  if (delegatorRole !== "decision_maker" && delegatorRole !== "member") throw err(400, `${input.delegator} holds no decision-maker seat on this board`);
  if (input.delegate === input.delegator) throw err(400, "a seat cannot be delegated to its own holder");
  const d = getUser(input.delegate); if (!d) throw err(404, `unknown user ${input.delegate}`);
  if (d.user_type === "auditor" || d.user_type === "service") throw err(400, `${d.user_type === "auditor" ? "an auditor" : "a service account"} cannot hold a delegation`);
  const authored = (db.prepare("SELECT r.code FROM session_items i JOIN reviews r ON r.id=i.review_id WHERE i.session_id=? AND r.submitted_by=?").all(session.id, input.delegate) as any[]).map((r) => r.code);
  if (authored.length) throw err(400, `${input.delegate} is the author of an agenda item (${authored.join(", ")}) and cannot hold a delegation in this session`);
  if (liveDelegations(session.id).some((x) => x.delegate === input.delegate && x.delegator !== input.delegator)) throw err(400, `${input.delegate} already holds a delegation for another seat in this session (one hop, one seat)`);
  const own = memberAreas(session.board_id, input.delegator);
  const areas = input.areas && input.areas.length ? input.areas : own;
  const bad = areas.filter((a) => !own.includes(a));
  if (bad.length) throw err(400, `${input.delegator} does not own ${bad.join(", ")}`);
  const id = uid(), now = nowIso();
  db.transaction(() => {
    // a fresh delegation by the same seat replaces the earlier one for this session
    db.prepare("UPDATE session_delegations SET revoked_at=?, revoked_by=? WHERE session_id=? AND delegator=? AND revoked_at IS NULL").run(now, actor, session.id, input.delegator);
    db.prepare("INSERT INTO session_delegations(id,session_id,delegator,delegate,areas_json,recorded_by,on_instruction,created_at) VALUES (?,?,?,?,?,?,?,?)").run(id, session.id, input.delegator, input.delegate, JSON.stringify(areas), actor, self ? 0 : 1, now);
    db.prepare(`INSERT INTO session_attendance(session_id,user_id,board_role,status,on_behalf_of,recorded_by,at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(session_id,user_id) DO UPDATE SET status='present', on_behalf_of=excluded.on_behalf_of, recorded_by=excluded.recorded_by, at=excluded.at`)
      .run(session.id, input.delegate, (db.prepare("SELECT board_role FROM board_members WHERE board_id=? AND user_id=?").get(session.board_id, input.delegate) as any)?.board_role ?? null, "present", input.delegator, actor, now);
  })();
  audit(actor, "session:delegate", "sessions", session.id, { delegation_id: id, delegator: input.delegator, delegate: input.delegate, areas, on_instruction: !self });
  return delegationsOf(session.id).find((x) => x.id === id)!;
}
export function revokeDelegation(session: SessionRow, delegationId: string, p: Principal, actor: string) {
  const d = delegationsOf(session.id).find((x) => x.id === delegationId); if (!d) throw err(404, "delegation not found");
  if (d.revoked_at) throw err(409, "already revoked");
  const role = memberRole(p, session.board_id);
  if (d.delegator !== p.id && role !== "secretary" && role !== "chair") throw err(403, "only the delegator or the secretary revokes a delegation");
  const now = nowIso();
  db.prepare("UPDATE session_delegations SET revoked_at=?, revoked_by=? WHERE id=?").run(now, actor, d.id);
  db.prepare("UPDATE session_attendance SET on_behalf_of=NULL WHERE session_id=? AND user_id=? AND on_behalf_of=?").run(session.id, d.delegate, d.delegator);
  audit(actor, "session:revoke_delegation", "sessions", session.id, { delegation_id: d.id, delegator: d.delegator, delegate: d.delegate });
}

// ---------- derived views ----------
/** Per board area: is an owner (or a delegate for one) present. */
export function quorumOf(session: SessionRow) {
  const present = presentUsers(session.id), dels = liveDelegations(session.id);
  const members = db.prepare("SELECT user_id, areas_json FROM board_members WHERE board_id=? AND board_role IN ('decision_maker','member')").all(session.board_id) as any[];
  return boardAreas(session.board_id).map((a) => {
    const owners = members.filter((m) => (j(m.areas_json, []) || []).includes(a.id)).map((m) => m.user_id as string);
    const by = new Set<string>(owners.filter((o) => present.has(o)));
    for (const d of dels) if (d.areas.includes(a.id) && owners.includes(d.delegator) && present.has(d.delegate)) by.add(d.delegate);
    return { area: a.id, label: a.label, covered: by.size > 0, by: [...by] };
  });
}
/** Every member of the board (absent unless recorded), then anyone else with a record (a delegate from outside). */
export function attendanceOf(session: SessionRow) {
  const rows = new Map((db.prepare("SELECT * FROM session_attendance WHERE session_id=?").all(session.id) as any[]).map((r) => [r.user_id, r]));
  const members = db.prepare("SELECT m.user_id, u.name, m.board_role, m.areas_json FROM board_members m LEFT JOIN users u ON u.id=m.user_id WHERE m.board_id=? ORDER BY CASE m.board_role WHEN 'chair' THEN 0 WHEN 'decision_maker' THEN 1 WHEN 'reviewer' THEN 2 WHEN 'secretary' THEN 3 ELSE 4 END, u.name").all(session.board_id) as any[];
  const ids = boardAreas(session.board_id).map((a) => a.id);
  const out = members.map((m) => { const r = rows.get(m.user_id); rows.delete(m.user_id); const own: string[] = j(m.areas_json, []) || [];
    return { user_id: m.user_id, name: m.name || m.user_id, board_role: m.board_role === "member" ? "decision_maker" : m.board_role, areas: ids.filter((id) => own.includes(id)), status: r?.status ?? "absent", on_behalf_of: r?.on_behalf_of ?? null, recorded_by: r?.recorded_by ?? null, at: r?.at ?? null, member: true }; });
  for (const r of rows.values()) out.push({ user_id: r.user_id, name: userName(r.user_id) || r.user_id, board_role: r.board_role ?? null, areas: liveDelegations(session.id).filter((d) => d.delegate === r.user_id).flatMap((d) => d.areas), status: r.status, on_behalf_of: r.on_behalf_of ?? null, recorded_by: r.recorded_by, at: r.at, member: false });
  return out;
}
export const delegationsView = (session: SessionRow) => delegationsOf(session.id).map((d) => ({ ...d, delegator_name: userName(d.delegator), delegate_name: userName(d.delegate) }));
/** The derived state of an agenda item: what the item row says once acted on, else what the positions say. */
export function itemState(item: SessionItem, review: any, progress: Progress): ItemState {
  if (item.state === "declared") return "declared";
  if (item.state === "deferred") return "deferred";
  if (item.state === "withdrawn" || review.stage === "withdrawn") return "withdrawn";
  if (progress.blocked || review.stage === "changes_requested") return "blocked";
  if (progress.open_conditionals > 0) return "open";
  if (progress.ready) return "ready";
  return "awaiting_positions";
}
export function sessionRights(p: Principal | null, session: SessionRow) {
  const role = memberRole(p, session.board_id);
  const chair = role === "chair", secretary = role === "secretary", member = !!role;
  const acting = !!p && !!db.prepare("SELECT 1 FROM session_items WHERE session_id=? AND acting_chair=?").get(session.id, p.id);
  const open = session.status === "open", live = session.status !== "closed";
  return { role, chair, secretary, acting, member, can: {
    manage: (chair || secretary) && live, open: chair && session.status === "planned", close: chair && open, call: (chair || acting) && open, declare: (chair || acting) && open,
    consent: chair && open, attend_self: member && live, delegate_self: role === "decision_maker" && live, record_attendance: (chair || secretary) && live, nominate: chair && live } };
}
export function sessionView(session: SessionRow, p: Principal | null) {
  const board = boardById(session.board_id);
  const items = sessionItems(session.id).map((it) => {
    const r = reviewRow(it.review_id); const progress = approvalProgress(r);
    return { position: it.position, consent: !!it.consent, state: it.state, acting_chair: it.acting_chair, acting_chair_name: userName(it.acting_chair), called_at: it.called_at, outcome: it.outcome, declared_at: it.declared_at, note: it.note,
      review: { id: r.id, code: r.code, title: r.title, type: r.type, stage: r.stage, submitted_by: r.submitted_by, submitted_by_name: userName(r.submitted_by), created_at: r.created_at, deferred_count: r.deferred_count || 0, deferred_reason: r.deferred_reason ?? null, areas: j(r.areas_json, []) || [], progress, target: targetOf(r), item_state: itemState(it, r, progress),
        can: { declare_outcomes: declareOutcomes(p, r) } } };
  });
  const rights = sessionRights(p, session);
  return { id: session.id, code: session.code, title: session.title, board: board ? { id: board.id, code: board.code, name: board.name } : null, scheduled_at: session.scheduled_at, status: session.status,
    created_by: session.created_by, opened_by: session.opened_by, opened_at: session.opened_at, closed_by: session.closed_by, closed_at: session.closed_at, notes_md: session.notes_md,
    quorum: quorumOf(session), attendance: attendanceOf(session), delegations: delegationsView(session), items, consent_count: items.filter((i) => i.consent && i.state === "listed").length,
    minutes: session.minutes_json ? j(session.minutes_json, null) : null, minutes_hash: session.minutes_hash, can: rights.can };
}
export const sessionSummary = (s: SessionRow) => {
  const items = sessionItems(s.id);
  return { id: s.id, code: s.code, title: s.title, board_id: s.board_id, scheduled_at: s.scheduled_at, status: s.status, items: items.length, declared: items.filter((i) => i.state === "declared").length, deferred: items.filter((i) => i.state === "deferred").length, opened_at: s.opened_at, closed_at: s.closed_at };
};

// ---------- lifecycle ----------
export function openSession(session: SessionRow, actor: string) {
  if (session.status !== "planned") throw err(409, `the session is ${session.status}`);
  const now = nowIso();
  let consent = 0;
  for (const it of sessionItems(session.id)) if (it.state === "listed" && approvalProgress(reviewRow(it.review_id)).ready) { db.prepare("UPDATE session_items SET consent=1 WHERE session_id=? AND review_id=?").run(session.id, it.review_id); consent++; }
  db.prepare("UPDATE board_sessions SET status='open', opened_by=?, opened_at=?, updated_at=? WHERE id=?").run(actor, now, now, session.id);
  // whoever opens the sitting is in the room: recorded as present by themselves
  recordAttendance(session, actor, "present", actor);
  const quorum = quorumOf(session);
  audit(actor, "session:open", "sessions", session.id, { code: session.code, items: sessionItems(session.id).length, consent, quorum_uncovered: quorum.filter((q) => !q.covered).map((q) => q.area) });
  return sessionById(session.id)!;
}
/** A member acting in an open sitting without an attendance record is present (a delegate already has one from the delegation). */
export function presentIfUnrecorded(session: SessionRow, userId: string) {
  if (session.status !== "open" || db.prepare("SELECT 1 FROM session_attendance WHERE session_id=? AND user_id=?").get(session.id, userId)) return;
  recordAttendance(session, userId, "present", userId);
}
export function callItem(session: SessionRow, reviewId: string, actor: string) {
  if (session.status !== "open") throw err(409, `the session is ${session.status}`);
  const it = sessionItems(session.id).find((i) => i.review_id === reviewId); if (!it) throw err(404, "not on this agenda");
  if (it.state !== "listed" && it.state !== "called") throw err(409, `item is ${it.state}`);
  db.prepare("UPDATE session_items SET state='called', called_at=COALESCE(called_at, ?) WHERE session_id=? AND review_id=?").run(nowIso(), session.id, reviewId);
  audit(actor, "session:call", "sessions", session.id, { review_id: reviewId, code: reviewRow(reviewId)?.code });
}
export function nominateActingChair(session: SessionRow, reviewId: string, nominee: string, actor: string) {
  if (session.status === "closed") throw err(409, "the session is closed");
  const it = sessionItems(session.id).find((i) => i.review_id === reviewId); if (!it) throw err(404, "not on this agenda");
  const r = reviewRow(reviewId);
  const role = (db.prepare("SELECT board_role FROM board_members WHERE board_id=? AND user_id=?").get(session.board_id, nominee) as any)?.board_role;
  if (role !== "decision_maker" && role !== "member") throw err(400, `${nominee} holds no decision-maker seat on this board`);
  if (r.submitted_by === nominee) throw err(400, `${nominee} is the author of ${r.code} and cannot chair it`);
  db.prepare("UPDATE session_items SET acting_chair=? WHERE session_id=? AND review_id=?").run(nominee, session.id, reviewId);
  audit(actor, "session:nominate", "sessions", session.id, { review_id: reviewId, code: r.code, acting_chair: nominee });
}
export function pullItem(session: SessionRow, reviewId: string, actor: string) {
  if (session.status !== "open") throw err(409, `the session is ${session.status}`);
  const it = sessionItems(session.id).find((i) => i.review_id === reviewId); if (!it) throw err(404, "not on this agenda");
  db.prepare("UPDATE session_items SET consent=0 WHERE session_id=? AND review_id=?").run(session.id, reviewId);
  audit(actor, "session:pull", "sessions", session.id, { review_id: reviewId, code: reviewRow(reviewId)?.code });
}
/** Declare every consent item still listed: approved, or approved with conditions when it already carries some. */
export function declareConsent(session: SessionRow, p: Principal, rationale: string | undefined, actor: string) {
  if (session.status !== "open") throw err(409, `the session is ${session.status}`);
  let declared = 0; const skipped: { review_id: string; code: string; reason: string }[] = [];
  for (const it of sessionItems(session.id).filter((i) => i.consent && i.state === "listed")) {
    const r = reviewRow(it.review_id);
    const outcome = db.prepare("SELECT 1 FROM conditions WHERE review_id=? AND status IN ('open','overdue')").get(r.id) ? "approved_with_conditions" : "approved";
    const chk = canDecide(p, r, outcome);
    if (!chk.ok) { skipped.push({ review_id: r.id, code: r.code, reason: chk.reason || "cannot declare" }); continue; }
    declareOutcome(r, { outcome, rationale: rationale || "Approved on the consent agenda." }, chk, actor, { eventKind: "consent_declared" });
    declared++;
  }
  audit(actor, "session:consent_declare", "sessions", session.id, { declared, skipped: skipped.map((s) => s.code) });
  return { declared, skipped };
}
export function setNotes(session: SessionRow, notes: string, actor: string) {
  if (session.status === "closed") throw err(409, "the session is closed");
  db.prepare("UPDATE board_sessions SET notes_md=?, updated_at=? WHERE id=?").run(notes, nowIso(), session.id);
  audit(actor, "session:notes", "sessions", session.id, { length: notes.length });
}
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
/** Minutes are derived from the records, never authored (the notes are the secretary's), and hashed as stored JSON so the hash can be re-checked from the row. */
export function buildMinutes(session: SessionRow) {
  const board = boardById(session.board_id);
  const chair = db.prepare("SELECT m.user_id, u.name FROM board_members m LEFT JOIN users u ON u.id=m.user_id WHERE m.board_id=? AND m.board_role='chair' ORDER BY m.added_at LIMIT 1").get(session.board_id) as any;
  const bAreas = boardAreas(session.board_id);
  const items = sessionItems(session.id).map((it) => {
    const r = reviewRow(it.review_id);
    return { code: r.code, title: r.title, type: r.type, author: r.submitted_by, author_name: userName(r.submitted_by), areas: (j(r.areas_json, []) || []).map((a: string) => ({ id: a, label: areaLabel(a, bAreas) })), state: it.state, acting_chair: it.acting_chair,
      positions: livePositions(r.id).map((x) => ({ area: x.area, position: x.position, by: x.user_id, on_behalf_of: x.on_behalf_of, text: x.text, resolution: x.resolution, resolution_text: x.resolution_text, resolved_by: x.resolved_by })),
      outcome: it.outcome, rationale: it.note,
      conditions: (db.prepare("SELECT text, owner, due_at, area, status FROM conditions WHERE review_id=? ORDER BY created_at").all(r.id) as any[]),
      dependencies_created: (db.prepare("SELECT d.code FROM review_dependencies x JOIN decisions d ON d.id=x.decision_id WHERE x.review_id=? AND x.session_id=?").all(r.id, session.id) as any[]).map((d) => d.code),
      deferred_reason: it.state === "deferred" ? r.deferred_reason ?? null : null };
  });
  return { origin: "derived", code: session.code, title: session.title, board: board ? { id: board.id, code: board.code, name: board.name } : null, scheduled_at: session.scheduled_at, opened_at: session.opened_at, closed_at: session.closed_at,
    chair: chair ? { user_id: chair.user_id, name: chair.name || chair.user_id } : null,
    attendance: attendanceOf(session).map((a) => ({ user_id: a.user_id, name: a.name, board_role: a.board_role, status: a.status, on_behalf_of: a.on_behalf_of })),
    delegations: delegationsOf(session.id).map((d) => ({ delegator: d.delegator, delegate: d.delegate, areas: d.areas, on_instruction: d.on_instruction, revoked_at: d.revoked_at })),
    quorum: quorumOf(session), items, notes_md: session.notes_md ?? null };
}
export const minutesHash = (minutes: unknown) => sha256(canonical(JSON.parse(JSON.stringify(minutes))));
/** Close: called items must have been declared or deferred; listed ones are deferred as not reached; minutes derived and hashed. */
export function closeSession(session: SessionRow, input: { notes_md?: string }, actor: string) {
  if (session.status !== "open") throw err(409, `the session is ${session.status}`);
  const now = nowIso();
  const items = sessionItems(session.id);
  const called = items.filter((i) => i.state === "called");
  if (called.length) throw err(409, `called items must be declared or deferred before closing: ${called.map((i) => reviewRow(i.review_id)?.code).join(", ")}`);
  let auto = 0;
  db.transaction(() => {
    for (const it of items.filter((i) => i.state === "listed")) {
      const r = reviewRow(it.review_id);
      db.prepare("UPDATE reviews SET deferred_count=deferred_count+1, deferred_reason='not reached', last_deferred_at=?, session_id=?, updated_at=? WHERE id=?").run(now, session.id, now, r.id);
      db.prepare("UPDATE session_items SET state='deferred', outcome='deferred', declared_at=?, note='not reached' WHERE session_id=? AND review_id=?").run(now, session.id, r.id);
      addEvent(r.id, "defer", actor, `Not reached in ${session.code}; deferred to the next session.`, { outcome: "deferred", reason: "not reached", auto: true, session_id: session.id }, session.id, "derived");
      audit(actor, "session:defer", "sessions", session.id, { review_id: r.id, code: r.code, reason: "not reached", auto: true });
      auto++;
    }
    if (input.notes_md !== undefined) db.prepare("UPDATE board_sessions SET notes_md=? WHERE id=?").run(input.notes_md, session.id);
    db.prepare("UPDATE board_sessions SET status='closed', closed_by=?, closed_at=?, updated_at=? WHERE id=?").run(actor, now, now, session.id);
    const minutes = buildMinutes(sessionById(session.id)!);
    const hash = minutesHash(minutes);
    db.prepare("UPDATE board_sessions SET minutes_json=?, minutes_hash=? WHERE id=?").run(JSON.stringify(minutes), hash, session.id);
    const after = sessionItems(session.id);
    audit(actor, "session:close", "sessions", session.id, { code: session.code, minutes_hash: hash, items: after.length, declared: after.filter((i) => i.state === "declared").length, deferred: after.filter((i) => i.state === "deferred").length, auto_deferred: auto });
  })();
  return sessionById(session.id)!;
}
/** Minutes as markdown, for export or paste. */
export function minutesMarkdown(m: any): string {
  const L: string[] = [];
  L.push(`# ${m.code}${m.title ? ` — ${m.title}` : ""}`, "", `Board: ${m.board?.code ?? ""} ${m.board?.name ?? ""}`, `Scheduled: ${m.scheduled_at}`, `Opened: ${m.opened_at ?? "—"} · Closed: ${m.closed_at ?? "—"}`, `Chair: ${m.chair?.name ?? "—"}`, "", "Derived from the session records; the notes are the secretary's. Evidence, not assurance.", "");
  L.push("## Attendance", "");
  for (const a of m.attendance || []) L.push(`- ${a.name} (${a.board_role ?? "delegate"}): ${a.status}${a.on_behalf_of ? ` — on behalf of ${a.on_behalf_of}` : ""}`);
  if (m.delegations?.length) { L.push("", "## Delegations", ""); for (const d of m.delegations) L.push(`- ${d.delegator} → ${d.delegate} (${d.areas.join(", ") || "all"})${d.on_instruction ? " — recorded by the secretary on instruction" : ""}${d.revoked_at ? " — revoked" : ""}`); }
  L.push("", "## Quorum by area", "");
  for (const q of m.quorum || []) L.push(`- ${q.label}: ${q.covered ? `covered (${q.by.join(", ")})` : "not covered"}`);
  L.push("", "## Items", "");
  (m.items || []).forEach((it: any, i: number) => {
    L.push(`### ${i + 1}. ${it.code} — ${it.title}`, "", `Type: ${it.type} · Author: ${it.author_name ?? it.author} · Areas: ${(it.areas || []).map((a: any) => a.label).join(", ") || "—"}`, `Outcome: ${it.outcome ?? it.state}${it.rationale ? ` — ${it.rationale}` : ""}${it.deferred_reason ? ` (${it.deferred_reason})` : ""}`);
    if (it.positions?.length) { L.push("", "Positions:"); for (const p of it.positions) L.push(`- ${p.area ?? "board"}: ${p.position} by ${p.by}${p.on_behalf_of ? ` for ${p.on_behalf_of}` : ""}${p.text ? ` — ${p.text}` : ""}${p.resolution ? ` → ${p.resolution} by ${p.resolved_by}: ${p.resolution_text}` : ""}`); }
    if (it.conditions?.length) { L.push("", "Conditions:"); for (const c of it.conditions) L.push(`- ${c.text}${c.owner ? ` (owner ${c.owner}` + (c.due_at ? `, due ${c.due_at}` : "") + ")" : ""} — ${c.status}`); }
    if (it.dependencies_created?.length) L.push("", `Dependent decisions: ${it.dependencies_created.join(", ")}`);
    L.push("");
  });
  if (m.notes_md) L.push("## Secretary's notes", "", m.notes_md, "");
  return L.join("\n");
}
