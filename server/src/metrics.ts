import { db, j, nowIso } from "./db.js";
import { listElements, verificationCoverage } from "./model.js";
import { allClassifications } from "./classification.js";
import { legacyRegister } from "./lifecycle.js";
import { thirdParties } from "./suppliers.js";
import { roadmap } from "./roadmap.js";
import { signOffCoverage } from "./signoffs.js";
import { riskRegister, architectureDebt } from "./risks.js";

/**
 * Governance metrics, computed from the records on read — the numbers a head of architecture reports to a board:
 * how fast reviews and decisions are decided and how often they recycle, how long decision makers take to record a
 * position, how conditions and exceptions age, how conformance trends and how fast findings are fixed, and how much
 * of the model and the registers a named person stands behind. Deterministic: every figure is a count, a median or a
 * 90th percentile over rows anyone can inspect, with its period stated. Nothing here judges a figure good or bad.
 */
const DAY = 86_400_000;
const days = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / DAY;
const round1 = (n: number | null) => (n === null ? null : Math.round(n * 10) / 10);
export function quantile(xs: number[], q: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return round1(s[lo] + (s[hi] - s[lo]) * (pos - lo));
}
const stats = (xs: number[]) => ({ n: xs.length, median: quantile(xs, 0.5), p90: quantile(xs, 0.9) });
const monthOf = (iso: string) => iso.slice(0, 7);
const lastMonths = (n: number, now: Date) => Array.from({ length: n }, (_, i) => { const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (n - 1 - i), 1)); return d.toISOString().slice(0, 7); });

export function governanceMetrics(opts: { days?: number } = {}) {
  const period = Math.min(730, Math.max(7, Math.round(opts.days ?? 90)));
  const now = new Date(), nowS = nowIso(), from = new Date(now.getTime() - period * DAY).toISOString();
  const months = lastMonths(6, now);

  // ---- reviews: lead time, throughput, recycling, the fast lane, position latency ----
  const decided = db.prepare("SELECT id, type, created_at, decided_at, resubmitted_at, stage FROM reviews WHERE decided_at IS NOT NULL").all() as any[];
  const inPeriod = decided.filter((r) => r.decided_at >= from);
  const lead = inPeriod.map((r) => days(r.created_at, r.decided_at)).filter((x) => x >= 0);
  const byType = Object.fromEntries([...new Set(inPeriod.map((r) => r.type))].sort().map((t) => [t, stats(inPeriod.filter((r) => r.type === t).map((r) => days(r.created_at, r.decided_at)).filter((x) => x >= 0))]));
  const recycledIds = new Set((db.prepare("SELECT DISTINCT review_id FROM review_events WHERE kind IN ('request_changes','resubmitted')").all() as any[]).map((r) => r.review_id));
  const approvals = db.prepare("SELECT review_id, data_json FROM review_events WHERE kind IN ('approve','consent_declared') AND created_at >= ?").all(from) as any[];
  const fastLane = approvals.filter((a) => j(a.data_json, {})?.fast_lane).length;
  const positions = db.prepare("SELECT p.at, r.created_at, r.resubmitted_at FROM review_positions p JOIN reviews r ON r.id=p.review_id WHERE p.at >= ?").all(from) as any[];
  const latency = positions.map((p) => days(p.resubmitted_at && p.resubmitted_at <= p.at ? p.resubmitted_at : p.created_at, p.at)).filter((x) => x >= 0);
  const open = db.prepare("SELECT created_at FROM reviews WHERE stage IN ('submitted','pre_review','in_review','changes_requested')").all() as any[];
  const reviews = {
    decided: inPeriod.length, lead_time_days: { ...stats(lead), by_type: byType },
    recycle_rate: inPeriod.length ? round1((inPeriod.filter((r) => recycledIds.has(r.id)).length / inPeriod.length) * 100) : null,
    fast_lane: { approvals: approvals.length, via_fast_lane: fastLane },
    position_latency_days: stats(latency),
    open: open.length, oldest_open_days: open.length ? round1(Math.max(...open.map((r) => days(r.created_at, nowS)))) : null,
    monthly: months.map((m) => { const rs = decided.filter((r) => monthOf(r.decided_at) === m); return { month: m, decided: rs.length, median_lead_days: quantile(rs.map((r) => days(r.created_at, r.decided_at)).filter((x) => x >= 0), 0.5) }; }),
  };

  // ---- decisions: decided, how long it took, and how far the estate realised them ----
  const decs = db.prepare("SELECT status, created_at, decided_at FROM decisions").all() as any[];
  const accepted = decs.filter((d) => d.status === "accepted" && d.decided_at && d.decided_at >= from);
  const rm = roadmap();
  const realisation: Record<string, number> = { realised: 0, in_progress: 0, not_started: 0, not_checkable: 0 };
  for (const lane of Object.values(rm.lanes)) for (const i of lane) if (i.kind === "decision" && i.status in realisation) realisation[i.status]++;
  const decisions = { accepted: accepted.length, lead_time_days: stats(accepted.map((d) => days(d.created_at, d.decided_at)).filter((x) => x >= 0)), proposed: decs.filter((d) => d.status === "proposed").length, realisation };

  // ---- conditions ----
  const conds = db.prepare("SELECT status, created_at, due_at, closed_at FROM conditions").all() as any[];
  const met = conds.filter((c) => c.status === "met" && c.closed_at && c.closed_at >= from);
  const metDue = met.filter((c) => c.due_at);
  const conditions = { open: conds.filter((c) => c.status === "open").length, overdue: conds.filter((c) => c.status === "overdue" || (c.status === "open" && c.due_at && c.due_at < nowS)).length,
    met: met.length, met_on_time_rate: metDue.length ? round1((metDue.filter((c) => c.closed_at <= c.due_at).length / metDue.length) * 100) : null, days_to_meet: stats(met.map((c) => days(c.created_at, c.closed_at)).filter((x) => x >= 0)) };

  // ---- exceptions: how old the active ones are, and what is about to expire ----
  const exc = db.prepare("SELECT status, created_at, expires_at FROM exceptions").all() as any[];
  const active = exc.filter((e) => e.status === "active");
  const age = (e: any) => days(e.created_at, nowS);
  const exceptions = { active: active.length,
    ageing: [{ bucket: "0–30 days", n: active.filter((e) => age(e) <= 30).length }, { bucket: "31–90 days", n: active.filter((e) => age(e) > 30 && age(e) <= 90).length }, { bucket: "91–180 days", n: active.filter((e) => age(e) > 90 && age(e) <= 180).length }, { bucket: "Over 180 days", n: active.filter((e) => age(e) > 180).length }],
    expiring_30_days: active.filter((e) => e.expires_at && days(nowS, e.expires_at) <= 30).length, without_expiry: active.filter((e) => !e.expires_at).length, expired: exc.filter((e) => e.status === "expired").length };

  // ---- conformance: the trend from the evaluation runs, and how fast findings are fixed ----
  const runs = (db.prepare("SELECT started_at, stats_json FROM runs WHERE kind='evaluate' AND status='done' AND started_at >= ? ORDER BY started_at").all(from) as any[]);
  const lastPerDay = new Map<string, any>();
  for (const r of runs) lastPerDay.set(r.started_at.slice(0, 10), r);
  const trend = [...lastPerDay.values()].map((r) => { const s = j(r.stats_json, {}); const b = s.bySeverity || {}; return { at: r.started_at, findings_open: s.findings ?? 0, critical: b.critical || 0, high: b.high || 0, medium: b.medium || 0, low: b.low || 0 }; });
  const totals = runs.reduce((t, r) => { const s = j(r.stats_json, {}); t.opened += s.opened || 0; t.resolved += s.resolved || 0; return t; }, { opened: 0, resolved: 0 });
  const fixed = db.prepare("SELECT first_seen, resolved_at FROM findings WHERE status='resolved' AND resolved_at >= ?").all(from) as any[];
  const openF = db.prepare("SELECT severity, first_seen FROM findings WHERE status='open'").all() as any[];
  const conformance = { trend, opened: totals.opened, resolved: totals.resolved, time_to_fix_days: stats(fixed.map((f) => days(f.first_seen, f.resolved_at)).filter((x) => x >= 0)),
    open: openF.length, open_by_severity: openF.reduce((m: any, f) => ((m[f.severity] = (m[f.severity] || 0) + 1), m), {}), oldest_open_days: openF.length ? round1(Math.max(...openF.map((f) => days(f.first_seen, nowS)))) : null };

  // ---- coverage: what a named person stands behind ----
  const cls = [...allClassifications().values()];
  const legacy = legacyRegister(); const tp = thirdParties();
  const needLegacy = legacy.applications.filter((a: any) => a.status !== "not_needed");
  const coverage = { verification: verificationCoverage(),
    classification: { classified: cls.filter((c) => c.criticality).length, verified: cls.filter((c) => c.verification === "verified").length, total: listElements("application").length },
    legacy_assessments: { current: needLegacy.filter((a: any) => a.status === "current").length, needed: needLegacy.length },
    exit_plans: { current: tp.exit_plans.filter((e: any) => e.status === "current").length, needed: tp.exit_plans.length },
    sign_offs: signOffCoverage() };

  return { generated_at: nowS, period_days: period, from, reviews, decisions, conditions, exceptions, conformance, coverage,
    risks: riskRegister().counts, debt: architectureDebt().counts,
    registers: { legacy_counts: legacy.counts, concentration: tp.concentration.map((c: any) => ({ provider: c.name, designated: !!c.ctp, critical: c.critical, of: c.of })) },
    roadmap: rm.counts };
}
