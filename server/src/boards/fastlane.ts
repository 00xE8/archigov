import { db, j } from "../db.js";
import { getElement } from "../model.js";
import { classificationOf } from "../classification.js";
import { dryRunForApplication, activeException } from "../rules.js";
import type { Policy, ReviewLike } from "./workflow.js";

/**
 * The fast lane: a low-risk design review that follows adopted patterns can be declared approved by the chair
 * without collecting a position from every area owner — the standard-change idea, held to deterministic checks.
 *
 * Everything here is derived on read, nothing is stored but the submitter's pattern claim (reviews.patterns_json):
 *   risk tier   max(the submitter's declared tier, the application's criticality, open high findings) — the
 *               submitter can only raise it;
 *   eligible    every check passes: tier low; the claimed patterns adopted (at least one when the board requires
 *               it) and their rules passing for the application; the latest pre-review — rules or AI — run on this
 *               version with no finding of medium or above; no rule finding of medium or above on the application;
 *               no open assessment request; no objection or unresolved conditional; the review open.
 * AI can only make it harder: an AI pre-review finding of medium or above vetoes the lane, nothing an AI says grants
 * it. Any area owner pulls an item out by recording a `no` or a `conditional`.
 */
export interface FastLanePolicy { enabled: boolean; require_pattern: boolean }
export type RiskTier = "low" | "medium" | "high";
export interface FastLaneCheck { id: string; name: string; ok: boolean; detail: string }
export interface FastLane {
  eligible: boolean; require_pattern: boolean;
  risk: { tier: RiskTier; declared: string | null; reasons: string[] };
  patterns: { id: string; code: string | null; title: string | null; adopted: boolean; has_rule: boolean; failing: number }[];
  checks: FastLaneCheck[];
}

const RANK: Record<RiskTier, number> = { low: 1, medium: 2, high: 3 };
const tierOf = (v: unknown): RiskTier | null => (v === "low" || v === "medium" || v === "high" ? v : null);
const AT_LEAST_MEDIUM = new Set(["medium", "high", "critical"]);
const OPEN = ["submitted", "pre_review", "in_review"];

export function normaliseFastLane(input: any): FastLanePolicy | undefined {
  if (input == null) return undefined;
  if (typeof input !== "object") throw new Error("fast_lane must be an object {enabled, require_pattern}");
  return { enabled: !!input.enabled, require_pattern: input.require_pattern !== false };
}

/** The tier a design review is held to: the highest of what the submitter declared, the application's criticality and its open serious findings. */
export function riskTierOf(review: ReviewLike & { risk_tier?: string | null }): FastLane["risk"] {
  const declared = tierOf(review.risk_tier);
  let tier: RiskTier = declared ?? "medium";
  const reasons: string[] = [declared ? `Declared ${declared} by the submitter.` : "No tier declared: medium assumed."];
  const raise = (t: RiskTier, why: string) => { reasons.push(why); if (RANK[t] > RANK[tier]) tier = t; };
  const app = review.application_id ? getElement(review.application_id) : null;
  if (!app) raise("medium", "No application: the tier cannot be derived.");
  else {
    const c = classificationOf(app.id);
    if (c?.criticality === "critical") raise("high", `${app.name} is classified critical${c.regulated ? " (a regulated service depends on it)" : ""}.`);
    else if (c?.criticality === "important") raise("medium", `${app.name} is classified important.`);
    else if (c?.criticality === "standard") reasons.push(`${app.name} is classified standard.`);
    else raise("medium", `${app.name} is unclassified: a fast lane needs a known criticality.`);
    const serious = (db.prepare("SELECT count(*) n FROM findings WHERE application_id=? AND status='open' AND severity IN ('high','critical')").get(app.id) as any).n;
    if (serious) raise("medium", `${serious} open high-severity finding${serious === 1 ? "" : "s"} on ${app.name}.`);
  }
  return { tier, declared, reasons };
}

/** The patterns a review claims to follow, resolved. */
export function claimedPatterns(review: { patterns_json?: string | null }, failing: Map<string, number> = new Map()): FastLane["patterns"] {
  const ids: string[] = j(review.patterns_json ?? "[]", []) || [];
  return ids.map((id) => {
    const a = db.prepare("SELECT id, code, title, kind, lifecycle, rule_json FROM standards WHERE id=?").get(id) as any;
    return { id, code: a?.code ?? null, title: a?.title ?? null, adopted: !!a && a.kind === "pattern" && a.lifecycle === "adopted", has_rule: !!a?.rule_json, failing: failing.get(id) || 0 };
  });
}

/** Where a design review stands against its board's fast lane, or null when the policy does not offer one. */
export function fastLaneOf(review: ReviewLike & { risk_tier?: string | null; patterns_json?: string | null }, policy: Policy): FastLane | null {
  const fl = policy.fast_lane;
  if (review.type !== "design" || !fl?.enabled) return null;
  const checks: FastLaneCheck[] = [];
  const add = (id: string, name: string, ok: boolean, detail: string) => checks.push({ id, name, ok, detail });
  const risk = riskTierOf(review);
  add("risk", "Risk Tier Is Low", risk.tier === "low", risk.tier === "low" ? "Low: declared low, on a standard application with no open high-severity findings." : `${risk.tier[0].toUpperCase()}${risk.tier.slice(1)}: ${risk.reasons.filter((r) => !/^Declared low/.test(r)).join(" ")}`);

  // the live rules against the application, with app-wide exceptions honoured: what a run would open now
  const live = review.application_id ? dryRunForApplication(review.application_id).filter((f) => !activeException(f.standard.id, review.application_id!, null)) : [];
  const failing = new Map<string, number>();
  for (const f of live) failing.set(f.standard.id, (failing.get(f.standard.id) || 0) + 1);
  const patterns = claimedPatterns(review, failing);
  const notAdopted = patterns.filter((x) => !x.adopted);
  if (notAdopted.length) add("patterns", "Follows Adopted Patterns", false, `Not an adopted pattern: ${notAdopted.map((x) => x.code || x.id).join(", ")}.`);
  else if (!patterns.length) add("patterns", "Follows Adopted Patterns", !fl.require_pattern, fl.require_pattern ? "No pattern claimed; this board's fast lane needs the design to follow at least one adopted pattern." : "No pattern claimed; this board does not require one.");
  else add("patterns", "Follows Adopted Patterns", true, `Claims ${patterns.map((x) => x.code).join(", ")}.`);
  const broken = patterns.filter((x) => x.failing > 0);
  const checkable = patterns.filter((x) => x.has_rule);
  add("pattern_rules", "Pattern Rules Pass", broken.length === 0, broken.length ? `Failing for this application: ${broken.map((x) => `${x.code} (${x.failing})`).join(", ")}.` : checkable.length ? `${checkable.map((x) => x.code).join(", ")} pass for this application.` : "No claimed pattern carries a rule; reviewers judge the claim.");

  const serious = live.filter((f) => !f.error && AT_LEAST_MEDIUM.has(String(f.standard.severity)));
  add("findings", "No Medium or Higher Findings", serious.length === 0, serious.length ? `${serious.length} rule finding${serious.length === 1 ? "" : "s"} of medium or above: ${[...new Set(serious.map((f) => f.standard.code))].join(", ")}.` : "No rule finding of medium or above on the application.");

  // the latest pre-review must have run on this version; whatever produced it, one medium finding is a veto
  const pre = db.prepare("SELECT data_json, origin, created_at FROM review_events WHERE review_id=? AND kind='pre_review' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(review.id) as any;
  const since = review.resubmitted_at || review.created_at;
  if (!pre) add("pre_review", "Pre-review Clean", false, "No pre-review yet.");
  else if (pre.created_at < since) add("pre_review", "Pre-review Clean", false, "The pre-review predates the resubmitted version; run it again.");
  else {
    const data = j(pre.data_json, {}) || {};
    const bad = (data.findings || []).filter((f: any) => AT_LEAST_MEDIUM.has(String(f?.severity)));
    const by = pre.origin === "ai" ? "The AI pre-review" : "The pre-review";
    add("pre_review", "Pre-review Clean", bad.length === 0, bad.length ? `${by} raised ${bad.length} finding${bad.length === 1 ? "" : "s"} of medium or above: ${bad.slice(0, 3).map((f: any) => f.title).join("; ")}.` : `${by} raised nothing of medium or above.`);
  }

  const openAssess = (db.prepare("SELECT count(*) n FROM review_assessments WHERE review_id=? AND status='requested'").get(review.id) as any).n;
  add("assessments", "No Open Assessment", openAssess === 0, openAssess ? `${openAssess} requested assessment${openAssess === 1 ? "" : "s"} still open.` : "No requested assessment is open.");
  const objections = db.prepare("SELECT position, area, user_id FROM review_positions WHERE review_id=? AND superseded=0 AND (position='no' OR (position='conditional' AND resolution IS NULL))").all(review.id) as any[];
  add("objections", "No Objection", objections.length === 0, objections.length ? `${objections.map((o) => `${o.user_id} said ${o.position === "no" ? "no" : "conditional"}${o.area ? ` on ${o.area}` : ""}`).join("; ")} — the item goes through the full policy.` : "Nobody has objected or set a condition.");
  add("open", "Review Is Open", OPEN.includes(review.stage), OPEN.includes(review.stage) ? "Open for a decision." : `The review is ${review.stage.replace(/_/g, " ")}.`);
  return { eligible: checks.every((c) => c.ok), require_pattern: fl.require_pattern, risk, patterns, checks };
}
