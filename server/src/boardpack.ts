import { db, j, uid, nowIso, audit, getSetting } from "./db.js";
import { governanceMetrics } from "./metrics.js";
import { roadmap } from "./roadmap.js";
import { legacyRegister } from "./lifecycle.js";
import { thirdParties } from "./suppliers.js";
import { signAndPersist } from "./evidence-pack.js";
import { userName } from "./reviews.js";
import { riskRegister } from "./risks.js";

/**
 * The board pack: what a chair or secretary takes to a board — the governance metrics for a period, the decisions
 * accepted and the reviews declared in it, the roadmap's Now lane, the register gaps and concentration — built
 * deterministically from the records and signed and chained like the evidence pack, so a third party can check it
 * is what the instance held. An optional narrative is the only authored part: written by the person who creates the
 * pack (perhaps from an AI draft, which the pack then says), never by a model on its own.
 */
export const BOARD_PACK_DISCLAIMER = "This board pack summarises records held in archigov for the period stated. It shows evidence and who stands behind it; it does not assert compliance with any regulation or standard.";

export interface BoardPackInput { days?: number; title?: string; board_id?: string | null; narrative_md?: string | null; narrative_origin?: "human" | "ai_assisted" }
export function buildBoardPack(b: BoardPackInput, actor: string) {
  const metrics = governanceMetrics({ days: b.days });
  const from = metrics.from, to = metrics.generated_at;
  const board = b.board_id ? (db.prepare("SELECT id, code, name FROM boards WHERE id=?").get(b.board_id) as any) : null;
  const decisions = (db.prepare("SELECT code, title, status, topic, decided_at FROM decisions WHERE decided_at >= ? ORDER BY decided_at").all(from) as any[]);
  const reviews = (db.prepare("SELECT r.id, r.code, r.title, r.type, r.stage, r.decided_at, b.code board FROM reviews r LEFT JOIN boards b ON b.id=r.board_id WHERE r.decided_at >= ? ORDER BY r.decided_at").all(from) as any[])
    .filter((r) => !board || r.board === board.code)
    .map((r) => ({ code: r.code, title: r.title, type: r.type, outcome: r.stage, board: r.board, decided_at: r.decided_at,
      via_fast_lane: (db.prepare("SELECT data_json FROM review_events WHERE review_id=? AND kind IN ('approve','consent_declared')").all(r.id) as any[]).some((e) => j(e.data_json, {})?.fast_lane) }));
  const rm = roadmap();
  const legacy = legacyRegister(); const tp = thirdParties();
  const narrative = b.narrative_md && b.narrative_md.trim() ? { md: b.narrative_md.trim().slice(0, 20000), origin: b.narrative_origin === "ai_assisted" ? "ai_assisted" : "human", author: actor, author_name: userName(actor) } : null;
  const pack: Record<string, any> = {
    kind: "board_pack", scope: board ? `board pack · ${board.code}` : "board pack",
    title: (b.title || "").trim() || `Board pack — ${new Date(to).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" })}`,
    tenant: getSetting("tenant.name", "Local tenant"), board: board ? { code: board.code, name: board.name } : null,
    generated_at: to, generated_by: actor, generated_by_name: userName(actor), period: { days: metrics.period_days, from, to },
    narrative, metrics, decisions_in_period: decisions, reviews_declared_in_period: reviews,
    roadmap: { counts: rm.counts, now: rm.lanes.now.map((i) => ({ kind: i.kind, title: i.title, code: i.code, status: i.status, due: i.due, applications: i.applications.map((a) => a.name) })) },
    registers: {
      legacy_due: legacy.applications.filter((a: any) => a.status === "due" || a.status === "stale").map((a: any) => ({ application: a.name, status: a.status,
        components: a.legacy.map((k: string) => { const g = legacy.components.find((c: any) => c.key === k); return g ? `${g.product_label} ${g.label}` : k; }) })),
      exit_plans_due: tp.exit_plans.filter((e: any) => e.status === "due").map((e: any) => ({ application: e.application.name, provider: e.provider.name })),
      concentration: tp.concentration.map((c: any) => ({ provider: c.name, designated_entity: c.ctp?.entity ?? null, critical: c.critical, of: c.of })),
      // live high and critical risks, and every risk whose review date has passed
      risks: (() => { const r = riskRegister(); return { counts: r.counts, attention: r.risks.filter((x: any) => (["open", "accepted"].includes(x.status) && (x.severity === "high" || x.severity === "critical")) || x.review_overdue)
        .map((x: any) => ({ code: x.code, title: x.title, severity: x.severity, status: x.status, source: x.source, owner: x.owner_name || x.owner, review_by: x.review_by, review_overdue: x.review_overdue, decision: x.decision?.code ?? null })) }; })(),
    },
    disclaimer: BOARD_PACK_DISCLAIMER,
  };
  signAndPersist(pack);
  const id = uid();
  db.prepare("INSERT INTO board_packs(id,hash,title,period_days,from_at,to_at,board_id,narrative_origin,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(id, pack.hash, pack.title, metrics.period_days, from, to, board?.id ?? null, narrative?.origin ?? null, actor, nowIso());
  audit(actor, "board_pack:create", "board_packs", id, { hash: pack.hash, title: pack.title, period_days: metrics.period_days, board: board?.code ?? null, narrative: narrative?.origin ?? null });
  return { id, hash: pack.hash, title: pack.title, signed_at: pack.signed_at };
}

export const boardPacks = () => (db.prepare("SELECT p.*, b.code board_code FROM board_packs p LEFT JOIN boards b ON b.id=p.board_id ORDER BY p.created_at DESC").all() as any[])
  .map((p) => ({ ...p, created_by_name: userName(p.created_by) }));
