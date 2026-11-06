import { db } from "./db.js";
import { wi, NEEDS_DECISION_TYPES } from "./http.js";
import { listElements } from "./model.js";
import { realisationOf } from "./roadmap.js";

/**
 * Where a planned change stands in the decision lifecycle, as one word used identically wherever the change is shown:
 * on Planned Changes here and, when write-back is on, as a tag on the work item at its source. It is derived on every
 * read from the records (the review and the decision that cover the item, the conditions still open, a change after
 * approval, what conformance says about the decision) and never stored, so no two places can disagree about it.
 */
export const CHANGE_STAGES = [
  { id: "needs_decision", label: "Needs decision", explain: "An open change of a kind that warrants an architecture decision, with no decision and no review covering it yet." },
  { id: "decision_proposed", label: "Decision proposed", explain: "A decision covering this change has been proposed and has not been decided." },
  { id: "in_review", label: "In review", explain: "The review covering this change is with its board; no outcome is in effect yet." },
  { id: "changes_requested", label: "Changes requested", explain: "The board sent the review covering this change back to its submitter." },
  { id: "approved_with_conditions", label: "Approved with conditions", explain: "The review covering this change was approved, and conditions of that approval are still open." },
  { id: "approved", label: "Approved", explain: "The review or the decision covering this change was approved, with no condition left open." },
  { id: "rejected", label: "Rejected", explain: "The review or the decision covering this change was rejected." },
  { id: "changed_after_approval", label: "Changed after approval", explain: "The item's title or description changed after its design was approved; a person has yet to acknowledge the change." },
  { id: "drift", label: "Drift", explain: "The decision covering this change is accepted, and something deployed does not follow it: conformance holds open findings against it." },
  { id: "built_as_approved", label: "Built as approved", explain: "The decision covering this change is accepted, resources of the kind it allows are deployed, and nothing drifts from it." },
] as const;
export type ChangeStage = (typeof CHANGE_STAGES)[number]["id"];
export const STAGE_LABEL = Object.fromEntries(CHANGE_STAGES.map((s) => [s.id, s.label])) as Record<ChangeStage, string>;

/** What a stage needs to know about the decision behind a change: how conformance stands on it. */
export interface DecisionStanding { drift: number; realised: boolean }

/** The columns `changeStage` reads: a work item joined with the review and the decision that cover it (CHANGE_SELECT). */
export interface ChangeRow {
  type: string; state: string | null; material_change: number | boolean | null; decision_id: string | null; review_id: string | null;
  review_stage?: string | null; decision_status?: string | null; open_conditions?: number | null;
}

/** States in which the work is over, whatever the process template calls it: nothing is asked of such an item any more. */
export const DONE_STATES = ["Closed", "Resolved", "Done", "Removed"];

/**
 * The stage of one change: what the board said, then the bare decision, then the absence of either. On an approval,
 * what happened afterwards comes first: the item changed (what was approved is not what is now asked for), or
 * conformance speaks about the accepted decision.
 *
 * `material_change` alone is not "changed after approval": its baseline is taken when the review is submitted, so it
 * is also set while the review is still open, or after it was rejected. Only an approval makes it this stage.
 */
export function changeStage(w: ChangeRow, standing?: DecisionStanding | null): ChangeStage | null {
  if (w.state === "Removed") return null;
  const rs = w.review_id && w.review_stage && w.review_stage !== "withdrawn" ? w.review_stage : null; // a withdrawn review covers nothing
  let stage: ChangeStage | null = null;
  if (rs) {
    stage = rs === "changes_requested" ? "changes_requested" : rs === "rejected" ? "rejected" : rs === "approved" ? "approved"
      : rs === "approved_with_conditions" ? ((w.open_conditions ?? 0) > 0 ? "approved_with_conditions" : "approved")
      : "in_review"; // submitted, pre-review, in review, and an approval held on a dependency or on circulation
  }
  if (w.decision_id) {
    if (!stage) stage = w.decision_status === "proposed" ? "decision_proposed" : w.decision_status === "accepted" ? "approved" : w.decision_status === "rejected" ? "rejected" : null;
    // a rejected decision is not outweighed by an approval given to a review beside it; a review still open is the live word
    else if (w.decision_status === "rejected" && stage !== "in_review" && stage !== "changes_requested") stage = "rejected";
  }
  if (stage === "approved" || stage === "approved_with_conditions") {
    if (w.material_change) return "changed_after_approval";
    if (w.decision_status === "accepted" && standing) {
      if (standing.drift > 0) return "drift";
      if (stage === "approved" && standing.realised) return "built_as_approved";
    }
  }
  if (!stage && NEEDS_DECISION_TYPES.includes(w.type) && !DONE_STATES.includes(w.state || "") && !w.decision_id && !rs) stage = "needs_decision";
  return stage;
}

/** Decision standings, worked out once each for as long as the returned function is kept (one request, one sweep). */
export function decisionStandings(): (decisionId: string | null | undefined) => DecisionStanding | null {
  const seen = new Map<string, DecisionStanding | null>();
  let apps: { id: string }[] | null = null;
  return (id) => {
    if (!id) return null;
    if (seen.has(id)) return seen.get(id)!;
    const d = db.prepare("SELECT id, status, constraint_json, application_ids_json FROM decisions WHERE id=?").get(id) as any;
    let out: DecisionStanding | null = null;
    if (d && d.status === "accepted") {
      const real = realisationOf(d, (apps ??= listElements("application")));
      const drift = real ? real.drift : ((db.prepare("SELECT count(*) n FROM findings WHERE decision_id=? AND status='open'").get(id) as any).n as number);
      out = { drift, realised: !!real && real.conforming > 0 && real.drift === 0 };
    }
    seen.set(id, out);
    return out;
  };
}

/** A work item with everything its stage is read from, and what write-back last showed at its source. */
export const CHANGE_SELECT = `SELECT w.*, s.kind source_kind, d.code decision_code, d.title decision_title, d.status decision_status,
    r.code review_code, r.title review_title, r.stage review_stage, r.decided_at review_decided_at, r.updated_at review_updated_at, r.resubmitted_at review_resubmitted_at, b.name review_board,
    (SELECT max(e.created_at) FROM review_events e WHERE e.review_id=r.id AND e.kind='became_effective') review_effective_at,
    (SELECT max(e.created_at) FROM review_events e WHERE e.review_id=r.id AND (e.kind='request_changes' OR (e.kind='position' AND e.data_json LIKE '%"position":"no"%'))) review_sent_back_at,
    (SELECT count(*) FROM conditions c WHERE c.review_id=r.id AND c.status IN ('open','overdue')) open_conditions,
    (SELECT count(*) FROM conditions c WHERE c.review_id=r.id) conditions,
    wb.tag wb_tag, wb.links_json wb_links, wb.written_at wb_written_at, wb.error wb_error
  FROM work_items w LEFT JOIN sources s ON s.id=w.source_id LEFT JOIN decisions d ON d.id=w.decision_id LEFT JOIN reviews r ON r.id=w.review_id
    LEFT JOIN boards b ON b.id=r.board_id LEFT JOIN work_item_writeback wb ON wb.work_item_id=w.id`;

/** Planned changes in the shape the API returns: the row, its stage, and what its source was last shown. */
export function plannedChanges(where = "ORDER BY w.external_id", ...params: unknown[]) {
  const standing = decisionStandings();
  return (db.prepare(`${CHANGE_SELECT} ${where}`).all(...params) as any[]).map((r) => {
    const { wb_tag, wb_links, wb_written_at, wb_error, ...row } = r;
    const stage = changeStage(r, standing(r.decision_id));
    let links = 0; try { links = (JSON.parse(wb_links || "[]") as unknown[]).length; } catch { links = 0; }
    // needs_decision follows the stage here, so the page's filter and actions agree with what the row says
    return { ...wi(row), needs_decision: stage === "needs_decision", lifecycle_stage: stage,
      writeback: wb_written_at || wb_error ? { tag: wb_tag ?? null, links, written_at: wb_written_at ?? null, error: wb_error ?? null } : null };
  });
}
