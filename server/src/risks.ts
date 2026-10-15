import { db, j, uid, nowIso, audit, getSetting } from "./db.js";
import { listElements } from "./model.js";
import { nextCode } from "./http.js";
import { userName } from "./reviews.js";
import { legacyRegister } from "./lifecycle.js";
import { thirdParties } from "./suppliers.js";

/**
 * The risk register and the architecture debt behind it.
 *
 * Risks are architecture risks with an owner, a severity and a review date, from three places:
 *   decision   risks a decision accepts (its Consequences made explicit). Their standing follows the decision:
 *              proposed while it is proposed, withdrawn if it is rejected, superseded or deprecated, and otherwise
 *              what the owner records (accepted → mitigated → closed);
 *   exception  every active exception is an accepted risk — read from the exceptions table, reviewed by its expiry;
 *   manual     an architecture risk an author logs on its own.
 * Closing needs a note. Only the owner or whoever logged a risk changes it; a model may suggest risks from a
 * decision's text, an author saves the ones that hold (origin ai_assisted), nothing is stored by the suggestion.
 *
 * Architecture debt is derived, never logged: findings open longer than the debt age (90 days by default), overdue
 * conditions, drift from accepted decisions, end-of-life components, expired exceptions whose finding is still
 * open, and legacy assessments and exit plans due — each a record anyone can open.
 */
export const RISK_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export const RISK_STATUSES = ["open", "accepted", "mitigated", "closed"] as const;
const err = (status: number, message: string) => Object.assign(new Error(message), { status });

const decisionStanding = (status: string | null | undefined) => (status === "proposed" ? "proposed" : status && ["rejected", "superseded", "deprecated"].includes(status) ? "withdrawn" : null);
function shape(r: any, decs: Map<string, any>, apps: Map<string, string>, now: string) {
  const d = r.decision_id ? decs.get(r.decision_id) : null;
  const status = decisionStanding(d?.status) ?? r.status;
  const ids: string[] = j(r.application_ids_json, []) || [];
  return { id: r.id, code: r.code, title: r.title, description: r.description, severity: r.severity, status, stored_status: r.status, owner: r.owner, owner_name: userName(r.owner),
    review_by: r.review_by, review_overdue: !!r.review_by && r.review_by < now && ["open", "accepted"].includes(status), source: r.source, origin: r.origin,
    decision: d ? { id: d.id, code: d.code, title: d.title, status: d.status } : null, applications: ids.map((id) => ({ id, name: apps.get(id) ?? id })),
    created_by: r.created_by, created_by_name: userName(r.created_by), created_at: r.created_at, closed_by: r.closed_by, closed_at: r.closed_at, closure_note: r.closure_note, editable: true };
}

/** Every risk: stored ones (decision and manual) and the accepted risks active exceptions stand for. */
export function riskRegister(opts: { application?: string | null; decision?: string | null } = {}) {
  const now = nowIso();
  const decs = new Map((db.prepare("SELECT id, code, title, status FROM decisions").all() as any[]).map((d) => [d.id, d]));
  const apps = new Map(listElements("application").map((a) => [a.id, a.name]));
  const stored = (db.prepare("SELECT * FROM risks ORDER BY code").all() as any[]).map((r) => shape(r, decs, apps, now));
  const exc = (db.prepare("SELECT e.*, s.code standard_code, s.title standard_title, s.severity FROM exceptions e JOIN standards s ON s.id=e.standard_id WHERE e.status='active' ORDER BY e.created_at").all() as any[])
    .map((e) => ({ id: `exception:${e.id}`, code: null, title: `Exception to ${e.standard_code} · ${e.standard_title}`, description: e.reason, severity: e.severity || "medium", status: "accepted", stored_status: "accepted",
      owner: e.approved_by ?? null, owner_name: userName(e.approved_by), review_by: e.expires_at ?? null, review_overdue: !!e.expires_at && e.expires_at < now, source: "exception", origin: "human", decision: null,
      applications: e.application_id ? [{ id: e.application_id, name: apps.get(e.application_id) ?? e.application_id }] : [], created_by: e.approved_by ?? null, created_by_name: userName(e.approved_by), created_at: e.created_at,
      closed_by: null, closed_at: null, closure_note: null, editable: false }));
  let all = [...stored, ...exc];
  if (opts.application) all = all.filter((r) => r.applications.some((a: any) => a.id === opts.application));
  if (opts.decision) all = all.filter((r) => r.decision?.id === opts.decision);
  const live = all.filter((r) => ["open", "accepted", "proposed"].includes(r.status));
  return { risks: all, counts: { open: all.filter((r) => r.status === "open").length, accepted: all.filter((r) => r.status === "accepted").length, proposed: all.filter((r) => r.status === "proposed").length,
    review_overdue: all.filter((r) => r.review_overdue).length, high_or_critical: live.filter((r) => r.severity === "high" || r.severity === "critical").length, from_exceptions: exc.length, total: all.length } };
}

export interface RiskInput { title: string; description?: string; severity: string; owner?: string | null; review_by?: string | null; decision_id?: string | null; application_ids?: string[]; origin?: "human" | "ai_assisted" }
export function logRisk(b: RiskInput, actor: string) {
  if (!b.title || b.title.trim().length < 5) throw err(400, "a risk needs a title of at least 5 characters");
  if (!(RISK_SEVERITIES as readonly string[]).includes(b.severity)) throw err(400, `severity must be one of ${RISK_SEVERITIES.join(", ")}`);
  if (b.review_by && Number.isNaN(Date.parse(b.review_by))) throw err(400, "review_by must be a date");
  let decision: any = null;
  if (b.decision_id) { decision = db.prepare("SELECT id, code, status, application_ids_json FROM decisions WHERE id=?").get(b.decision_id); if (!decision) throw err(404, "decision not found"); }
  if (b.owner && !db.prepare("SELECT 1 FROM users WHERE id=?").get(b.owner)) throw err(400, `unknown owner "${b.owner}"`);
  const appIds = [...new Set([...(b.application_ids || []), ...(decision ? j(decision.application_ids_json, []) || [] : [])])];
  for (const a of appIds) if (!db.prepare("SELECT 1 FROM elements WHERE id=? AND type='application'").get(a)) throw err(400, `unknown application "${a}"`);
  const id = uid(), code = nextCode("risks", "RSK"), now = nowIso();
  db.prepare("INSERT INTO risks(id,code,title,description,severity,status,owner,review_by,source,decision_id,application_ids_json,origin,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, code, b.title.trim().slice(0, 200), (b.description || "").trim().slice(0, 4000), b.severity, decision ? "accepted" : "open", b.owner || actor, b.review_by ? b.review_by.slice(0, 10) : null,
      decision ? "decision" : "manual", decision?.id ?? null, JSON.stringify(appIds), b.origin === "ai_assisted" ? "ai_assisted" : "human", actor, now, now);
  audit(actor, "risk:log", "risks", id, { code, severity: b.severity, decision: decision?.code ?? null, origin: b.origin === "ai_assisted" ? "ai_assisted" : "human" });
  return riskRegister().risks.find((r) => r.id === id);
}

export function updateRisk(id: string, b: { status?: string; severity?: string; owner?: string | null; review_by?: string | null; note?: string | null }, actor: string) {
  const r = db.prepare("SELECT * FROM risks WHERE id=?").get(id) as any;
  if (!r) throw err(404, "risk not found");
  if (actor !== r.owner && actor !== r.created_by) throw err(403, `only the owner (${r.owner}) or whoever logged ${r.code} changes it`);
  const status = b.status ?? r.status;
  if (!(RISK_STATUSES as readonly string[]).includes(status)) throw err(400, `status must be one of ${RISK_STATUSES.join(", ")}`);
  if (b.severity && !(RISK_SEVERITIES as readonly string[]).includes(b.severity)) throw err(400, `severity must be one of ${RISK_SEVERITIES.join(", ")}`);
  if (b.owner && !db.prepare("SELECT 1 FROM users WHERE id=?").get(b.owner)) throw err(400, `unknown owner "${b.owner}"`);
  const note = (b.note || "").trim();
  if ((status === "closed" || status === "mitigated") && status !== r.status && note.length < 10) throw err(400, `say how it was ${status} (at least 10 characters)`);
  const now = nowIso(), closing = status === "closed" && r.status !== "closed";
  db.prepare("UPDATE risks SET status=?, severity=?, owner=?, review_by=?, updated_at=?, closed_by=CASE WHEN ? THEN ? ELSE closed_by END, closed_at=CASE WHEN ? THEN ? ELSE closed_at END, closure_note=CASE WHEN ? THEN ? ELSE closure_note END WHERE id=?")
    .run(status, b.severity ?? r.severity, b.owner ?? r.owner, b.review_by === undefined ? r.review_by : b.review_by ? b.review_by.slice(0, 10) : null, now, closing ? 1 : 0, actor, closing ? 1 : 0, now, note ? 1 : 0, note || null, id);
  audit(actor, `risk:${status !== r.status ? status : "update"}`, "risks", id, { code: r.code, from: r.status, to: status, severity: b.severity ?? r.severity, owner: b.owner ?? r.owner, review_by: b.review_by ?? r.review_by, note: note || undefined });
  return riskRegister().risks.find((x) => x.id === id);
}

// ---------- architecture debt (derived) ----------
export const debtDays = () => Math.max(1, Number(getSetting("debt.finding_days")) || 90);
export function architectureDebt() {
  const now = nowIso(), days = debtDays(), cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const apps = new Map(listElements("application").map((a) => [a.id, a.name]));
  const items: any[] = [];
  const push = (kind: string, application_id: string | null, title: string, detail: string, since: string | null, link: { kind: string; id: string | null }) =>
    items.push({ kind, application: application_id ? { id: application_id, name: apps.get(application_id) ?? application_id } : null, title, detail, since, link });
  for (const f of db.prepare("SELECT f.*, s.code FROM findings f JOIN standards s ON s.id=f.standard_id WHERE f.status='open' AND f.decision_id IS NULL AND f.first_seen < ? ORDER BY f.first_seen").all(cutoff) as any[])
    push("aged_finding", f.application_id, `${f.code}: ${f.message}`, `Open since ${String(f.first_seen).slice(0, 10)} (${f.severity}).`, f.first_seen, { kind: "application", id: f.application_id });
  for (const f of db.prepare("SELECT f.*, d.code dcode, d.title dtitle FROM findings f JOIN decisions d ON d.id=f.decision_id WHERE f.status='open' AND d.status='accepted' ORDER BY f.first_seen").all() as any[])
    push("drift", f.application_id, `Drift from ${f.dcode}: ${f.message}`, `${f.dtitle}.`, f.first_seen, { kind: "decision", id: f.decision_id });
  for (const c of db.prepare("SELECT c.*, r.code, r.application_id FROM conditions c JOIN reviews r ON r.id=c.review_id WHERE c.status='overdue' OR (c.status='open' AND c.due_at IS NOT NULL AND c.due_at < ?) ORDER BY c.due_at").all(now) as any[])
    push("condition_overdue", c.application_id, c.text, `A condition of ${c.code}, due ${String(c.due_at).slice(0, 10)}.`, c.due_at, { kind: "review", id: c.review_id });
  for (const e of db.prepare("SELECT e.*, s.code FROM exceptions e JOIN standards s ON s.id=e.standard_id WHERE e.status='expired'").all() as any[]) {
    const still = db.prepare("SELECT 1 FROM findings WHERE standard_id=? AND application_id IS ? AND status='open'").get(e.standard_id, e.application_id);
    if (still) push("exception_expired", e.application_id, `${e.code}: the exception expired and the finding is still open`, `Expired ${String(e.expires_at).slice(0, 10)}.`, e.expires_at, { kind: "application", id: e.application_id });
  }
  const legacy = legacyRegister();
  for (const g of legacy.components.filter((c: any) => c.state === "end_of_life")) for (const a of g.applications)
    push("end_of_life", a.id, `${g.product_label} ${g.label} is past end of life`, `Support ended ${g.eol}; ${g.resources.filter((r: any) => r.application_id === a.id).length} resource(s).`, g.eol, { kind: "legacy", id: null });
  for (const a of legacy.applications.filter((x: any) => x.status === "due" || x.status === "stale")) push("legacy_assessment_due", a.id, "Legacy assessment due", a.status === "stale" ? "The last assessment does not cover every legacy component." : "No legacy assessment in date.", a.last?.valid_until ?? null, { kind: "legacy", id: null });
  for (const e of thirdParties().exit_plans.filter((x: any) => x.status === "due")) push("exit_plan_due", e.application.id, `Exit plan due for ${e.provider.name}`, e.provider.ctp ? "A designated critical third party." : "", e.last?.valid_until ?? null, { kind: "third-parties", id: null });
  const KINDS = ["aged_finding", "drift", "condition_overdue", "exception_expired", "end_of_life", "legacy_assessment_due", "exit_plan_due"];
  const by = new Map<string, any>();
  for (const i of items) { const k = i.application?.id ?? "_tenant"; const g = by.get(k) || { application: i.application, items: [] as any[] }; g.items.push(i); by.set(k, g); }
  const by_application = [...by.values()].map((g) => ({ ...g, counts: Object.fromEntries(KINDS.map((k) => [k, g.items.filter((i: any) => i.kind === k).length])), total: g.items.length })).sort((a, b) => b.total - a.total);
  return { finding_days: days, items, by_application, counts: Object.fromEntries(KINDS.map((k) => [k, items.filter((i) => i.kind === k).length])), total: items.length };
}
