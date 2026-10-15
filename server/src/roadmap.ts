import { db, j, nowIso } from "./db.js";
import { listElements, resourcesOf } from "./model.js";
import { legacyRegister } from "./lifecycle.js";

/**
 * The architecture roadmap, built from records — never drawn. Every item is something the records already hold:
 *   decision   an accepted (or proposed) decision and how far the estate has realised it: for a decision with a
 *              checkable constraint, the resources of an allowed type against the open drift findings it raised
 *              (realised · in progress · not started); a decision without one is "not checkable" and says so
 *   change     a planned change (backlog work item) — under its decision when linked, on its own otherwise
 *   condition  an open condition of an approval, by its due date
 *   lifecycle  a component past or near its vendor's end of support, by that date
 *   exception  an active exception, by the date it expires (the remediation is due by then)
 * Lanes are deterministic: Done (realised, met, closed recently), Now (in progress, active, overdue or due within
 * 90 days), Next (not started, proposed, new, due within 180 days), Later (due beyond that).
 */
export type Lane = "now" | "next" | "later" | "done";
export type Kind = "decision" | "change" | "condition" | "lifecycle" | "exception";
export interface RoadmapItem {
  id: string; kind: Kind; lane: Lane; title: string; code: string | null; status: string; due: string | null;
  progress: { done: number; total: number } | null; applications: { id: string; name: string }[];
  link: { kind: "decision" | "review" | "backlog" | "legacy" | "application"; id: string | null }; detail: string;
  changes?: { id: string; title: string; external_id: string; state: string | null }[];
}
const DAY = 86_400_000;
const daysTo = (d: string | null, now: number) => (d ? (Date.parse(d) - now) / DAY : null);
const laneByDate = (due: string | null, now: number): Lane => { const n = daysTo(due, now); return n === null ? "next" : n <= 90 ? "now" : n <= 180 ? "next" : "later"; };
const RECENT_DAYS = 90;

export function roadmap(opts: { application?: string | null } = {}) {
  const now = Date.now(), nowStr = nowIso();
  const apps = listElements("application");
  const appName = new Map(apps.map((a) => [a.id, a.name]));
  const ref = (id: string) => ({ id, name: appName.get(id) ?? id });
  const items: RoadmapItem[] = [];
  const linkedChanges = new Set<string>();

  // ---- decisions: realisation from the constraint and the drift it raised ----
  const decisions = db.prepare("SELECT * FROM decisions WHERE status IN ('accepted','proposed') ORDER BY code").all() as any[];
  for (const d of decisions) {
    const scope: string[] = j(d.application_ids_json, []) || [];
    const inScope = scope.length ? scope.filter((id) => appName.has(id)) : apps.map((a) => a.id);
    const changes = (db.prepare("SELECT id, title, external_id, state FROM work_items WHERE decision_id=? AND COALESCE(state,'') <> 'Removed' ORDER BY external_id").all(d.id) as any[]);
    changes.forEach((c) => linkedChanges.add(c.id));
    const activeChange = changes.some((c) => c.state === "Active");
    const allowed: string[] = (j(d.constraint_json, null)?.allowedTypes || []).map((t: string) => t.toLowerCase());
    let status: string, lane: Lane, progress: RoadmapItem["progress"] = null, detail: string;
    if (d.status === "proposed") { status = "proposed"; lane = "next"; detail = "Proposed: realisation starts once it is accepted."; }
    else if (!allowed.length) { status = "not_checkable"; lane = activeChange ? "now" : "next"; detail = "No checkable constraint: realisation is evidenced through reviews, not measured."; }
    else {
      const conforming = inScope.flatMap((id) => resourcesOf(id)).filter((r) => allowed.includes((r.subtype || "").toLowerCase())).length;
      const drift = (db.prepare("SELECT count(*) n FROM findings WHERE decision_id=? AND status='open'").get(d.id) as any).n;
      progress = { done: conforming, total: conforming + drift };
      if (conforming > 0 && drift === 0) { status = "realised"; lane = "done"; detail = `${conforming} resource${conforming === 1 ? "" : "s"} of an allowed type; no drift.`; }
      else if (conforming > 0) { status = "in_progress"; lane = "now"; detail = `${drift} resource${drift === 1 ? " still drifts" : "s still drift"} from it.`; }
      else { status = "not_started"; lane = activeChange ? "now" : "next"; detail = drift ? `Nothing of an allowed type yet; ${drift} resource${drift === 1 ? "" : "s"} drift from it.` : "Nothing of an allowed type deployed yet."; }
    }
    items.push({ id: `decision:${d.id}`, kind: "decision", lane, title: d.title, code: d.code, status, due: null, progress, applications: (scope.length ? inScope : []).map(ref),
      link: { kind: "decision", id: d.id }, detail: scope.length ? detail : `${detail} Applies to every application.`, changes: changes.map((c) => ({ id: c.id, title: c.title, external_id: c.external_id, state: c.state })) });
  }

  // ---- planned changes not under a decision ----
  const changes = db.prepare("SELECT * FROM work_items WHERE COALESCE(state,'') <> 'Removed' ORDER BY external_id").all() as any[];
  for (const w of changes) {
    if (linkedChanges.has(w.id) || w.decision_id) continue;
    const closed = ["Closed", "Resolved", "Done"].includes(w.state || "");
    if (closed && !(w.changed_at && (now - Date.parse(w.changed_at)) / DAY <= RECENT_DAYS)) continue;
    const lane: Lane = closed ? "done" : w.state === "Active" ? "now" : "next";
    items.push({ id: `change:${w.id}`, kind: "change", lane, title: w.title, code: `${w.type} ${w.external_id}`, status: closed ? "closed" : (w.state || "new").toLowerCase(), due: null, progress: null,
      applications: w.application_id ? [ref(w.application_id)] : [], link: { kind: "backlog", id: w.id }, detail: ["Epic", "Project", "Initiative", "Change"].includes(w.type) && !w.review_id && !closed ? "No architecture decision yet." : w.iteration ? `Iteration ${w.iteration}.` : "" });
  }

  // ---- conditions of approvals ----
  const conds = db.prepare("SELECT c.*, r.code review_code, r.title review_title, r.application_id FROM conditions c JOIN reviews r ON r.id=c.review_id WHERE c.status IN ('open','overdue') OR (c.status='met' AND c.closed_at > ?)").all(new Date(now - RECENT_DAYS * DAY).toISOString()) as any[];
  for (const c of conds) {
    const met = c.status === "met";
    items.push({ id: `condition:${c.id}`, kind: "condition", lane: met ? "done" : laneByDate(c.due_at, now), title: c.text, code: c.review_code, status: met ? "met" : c.due_at && c.due_at < nowStr ? "overdue" : "open", due: c.due_at ?? null, progress: null,
      applications: c.application_id ? [ref(c.application_id)] : [], link: { kind: "review", id: c.review_id }, detail: `A condition of ${c.review_code} · ${c.review_title}${c.owner ? `; owner ${c.owner}` : ""}.` });
  }

  // ---- lifecycle deadlines: components past or near end of support ----
  for (const g of legacyRegister().components) {
    if (g.state === "supported") continue;
    const due = g.state === "extended" ? g.extended : g.eol;
    items.push({ id: `lifecycle:${g.key}`, kind: "lifecycle", lane: laneByDate(due, now), title: `Upgrade ${g.product_label} ${g.label}`, code: null, status: g.state, due, progress: null,
      applications: g.applications, link: { kind: "legacy", id: null }, detail: `${g.resources.length} resource${g.resources.length === 1 ? "" : "s"}${g.state === "extended" ? `; standard support ended ${g.eol}` : ""}.` });
  }

  // ---- exceptions: the remediation is due by the time they expire ----
  const exc = db.prepare("SELECT e.*, s.code standard_code, s.title standard_title FROM exceptions e JOIN standards s ON s.id=e.standard_id WHERE e.status='active' AND e.expires_at IS NOT NULL").all() as any[];
  for (const e of exc) items.push({ id: `exception:${e.id}`, kind: "exception", lane: laneByDate(e.expires_at, now), title: `Remediate ${e.standard_code} · ${e.standard_title}`, code: e.standard_code, status: "excepted", due: e.expires_at, progress: null,
    applications: e.application_id ? [ref(e.application_id)] : [], link: { kind: "application", id: e.application_id ?? null }, detail: e.reason });

  const scoped = opts.application ? items.filter((i) => i.applications.some((a) => a.id === opts.application) || (i.kind === "decision" && !i.applications.length)) : items;
  const order = (a: RoadmapItem, b: RoadmapItem) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title);
  const lanes = { now: [] as RoadmapItem[], next: [] as RoadmapItem[], later: [] as RoadmapItem[], done: [] as RoadmapItem[] };
  for (const i of scoped) lanes[i.lane].push(i);
  for (const k of Object.keys(lanes) as Lane[]) lanes[k].sort(order);
  const kinds = (["decision", "change", "condition", "lifecycle", "exception"] as Kind[]).map((k) => ({ kind: k, n: scoped.filter((i) => i.kind === k).length }));
  return { generated_at: nowStr, application: opts.application ? ref(opts.application) : null, lanes, counts: { now: lanes.now.length, next: lanes.next.length, later: lanes.later.length, done: lanes.done.length, total: scoped.length }, kinds };
}
