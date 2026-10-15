import { db, uid, nowIso, audit, getSetting } from "./db.js";
import { routeBoard, boardSummary, memberRole, type ReviewType } from "./boards/workflow.js";
import { userName } from "./reviews.js";
import type { Principal } from "./auth/context.js";

/**
 * Review dates and periodic sign-offs. Every adopted catalogue artefact and every accepted decision has a next review
 * date: its adoption (or decision) plus the cadence for its kind — 12 months for artefacts, 24 for decisions by
 * default — or, once signed off, the date that sign-off set. The chair of the board that owns it (the board its
 * review type routes to) signs it off: reaffirmed (still holds; the clock restarts for a full cadence) or revision
 * needed (with a note; it comes back in three months). Deterministic, no AI: a sign-off is a named person's statement.
 * Due soon = within 30 days; overdue = past the date. A chair's due and overdue sign-offs are in their work queue.
 */
export const SIGNOFF_OUTCOMES = ["reaffirmed", "revision_needed"] as const;
export type SubjectKind = "artefact" | "decision";
export type SignOffStatus = "current" | "due_soon" | "overdue";
const DUE_SOON_DAYS = 30, REVISION_MONTHS = 3;
export const cadenceMonths = (k: SubjectKind) => Math.max(1, Number(getSetting(k === "artefact" ? "review.artefact_months" : "review.decision_months")) || (k === "artefact" ? 12 : 24));
const addMonths = (iso: string, n: number) => { const d = new Date(iso); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString(); };
const err = (status: number, message: string) => Object.assign(new Error(message), { status });

interface Subject { kind: SubjectKind; id: string; code: string; title: string; type: string; since: string; board: any }
function subjects(): Subject[] {
  const arts = (db.prepare("SELECT id, code, title, kind, category, adopted_at, created_at FROM standards WHERE lifecycle='adopted' ORDER BY code").all() as any[])
    .map((a) => ({ kind: "artefact" as const, id: a.id, code: a.code, title: a.title, type: a.kind || "standard", since: a.adopted_at || a.created_at, board: routeBoard((a.kind || "standard") as ReviewType, a.kind || "standard", a.category) }));
  const decs = (db.prepare("SELECT id, code, title, topic, decided_at, created_at FROM decisions WHERE status='accepted' ORDER BY code").all() as any[])
    .map((d) => ({ kind: "decision" as const, id: d.id, code: d.code, title: d.title, type: "decision", since: d.decided_at || d.created_at, board: routeBoard("decision", null, d.topic) }));
  return [...arts, ...decs];
}
const lastOf = (kind: SubjectKind, id: string) => db.prepare("SELECT * FROM sign_offs WHERE subject_kind=? AND subject_id=? ORDER BY signed_at DESC, rowid DESC LIMIT 1").get(kind, id) as any;

export function standingOf(s: Subject, now = nowIso()) {
  const last = lastOf(s.kind, s.id);
  const due = last ? last.next_due : addMonths(s.since, cadenceMonths(s.kind));
  const days = (Date.parse(due) - Date.parse(now)) / 86_400_000;
  const status: SignOffStatus = days < 0 ? "overdue" : days <= DUE_SOON_DAYS ? "due_soon" : "current";
  return { due, status, revision_needed: last?.outcome === "revision_needed",
    last: last ? { outcome: last.outcome, note: last.note, signed_by: last.signed_by, signed_by_name: userName(last.signed_by), signed_at: last.signed_at } : null };
}

/** Every subject with its standing, its owning board and whether this principal may sign it off. */
export function signOffs(p: Principal | null, opts: { status?: string | null } = {}) {
  const now = nowIso();
  return subjects().map((s) => ({ subject: { kind: s.kind, id: s.id, code: s.code, title: s.title, type: s.type, since: s.since }, board: boardSummary(s.board), ...standingOf(s, now),
    can_sign: !!p && !!s.board && memberRole(p, s.board.id) === "chair" }))
    .filter((x) => !opts.status || x.status === opts.status || (opts.status === "revision_needed" && x.revision_needed))
    .sort((a, b) => a.due.localeCompare(b.due) || a.subject.code.localeCompare(b.subject.code));
}

/** Sign one subject off; only the chair of its owning board. Returns the new standing. */
export function signOff(p: Principal | null, b: { subject_kind: string; subject_id: string; outcome: string; note?: string | null }, actor: string) {
  if (b.subject_kind !== "artefact" && b.subject_kind !== "decision") throw err(400, "subject_kind must be artefact or decision");
  const s = subjects().find((x) => x.kind === b.subject_kind && x.id === b.subject_id);
  if (!s) throw err(404, b.subject_kind === "artefact" ? "no adopted artefact with that id" : "no accepted decision with that id");
  if (!(SIGNOFF_OUTCOMES as readonly string[]).includes(b.outcome)) throw err(400, `outcome must be one of ${SIGNOFF_OUTCOMES.join(", ")}`);
  if (!p || !s.board || memberRole(p, s.board.id) !== "chair") throw err(403, `only the chair of ${s.board?.code ?? "the owning board"} signs off ${s.code}`);
  const note = (b.note || "").trim();
  if (b.outcome === "revision_needed" && note.length < 10) throw err(400, "say what needs revising (at least 10 characters)");
  const now = nowIso(); const next = addMonths(now, b.outcome === "reaffirmed" ? cadenceMonths(s.kind) : REVISION_MONTHS);
  db.prepare("INSERT INTO sign_offs(id,subject_kind,subject_id,outcome,note,board_id,signed_by,signed_at,next_due) VALUES (?,?,?,?,?,?,?,?,?)").run(uid(), s.kind, s.id, b.outcome, note.slice(0, 2000) || null, s.board.id, actor, now, next);
  audit(actor, `signoff:${b.outcome}`, s.kind === "artefact" ? "standards" : "decisions", s.id, { code: s.code, board: s.board.code, next_due: next, note: note || undefined });
  return { subject: { kind: s.kind, id: s.id, code: s.code, title: s.title }, ...standingOf(s) };
}

/** The sign-offs due soon or overdue on the boards this principal chairs: their work queue. */
export const signOffsDueFor = (p: Principal) => signOffs(p).filter((x) => x.can_sign && x.status !== "current");
/** Coverage for the metrics: subjects whose next review date has not passed. */
export const signOffCoverage = () => { const all = signOffs(null); return { current: all.filter((x) => x.status !== "overdue").length, total: all.length, overdue: all.filter((x) => x.status === "overdue").length, due_soon: all.filter((x) => x.status === "due_soon").length }; };
