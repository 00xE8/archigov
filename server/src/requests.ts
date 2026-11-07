import { db, j, uid, nowIso, audit, onAudit } from "./db.js";
import type { Principal } from "./auth/context.js";
import { adoSource, feedAlso, readAgainWiql } from "./ado/sync.js";
import { writebackSettings, requestTagOf } from "./writeback.js";
import { DONE_STATES } from "./stage.js";

/**
 * A review asked for from the backlog. A delivery team puts the request tag (`arch:review`) on a work item; archigov
 * hears it, lists the ask for the people who submit reviews, and says on the work item when one of them has opened a
 * review, with the counts of the automatic checks.
 *
 * The tag makes a REQUEST, never a review. A review is submitted by a named person who stands behind it, as every
 * other review is: nothing here submits one on anyone's behalf, and a board is never put in front of a design nobody
 * proposed. The tag is the team's to put on and take off; archigov only reads it.
 *
 * An ask is open from the moment the tag is first seen until a review is opened for the item (answered) or the tag is
 * taken off again (withdrawn). Leaving the tag on after an answer is not a new ask; taking it off and putting it back
 * is. An ask can be made of a change a board has already spoken on (a second look): it is answered by the next review.
 * An ask made while a review of the change is under way is answered by that review at once. And an ask whose
 * answering review is then withdrawn stands again, for as long as the tag does: it was not met after all.
 *
 * It is a capability of write-back, off by default and switched on by a platform admin (Settings · Sources · Write
 * Back · Review Requests). Off, the tag is not looked for and an ask on record is not shown.
 */
const IN_FLIGHT = ["submitted", "pre_review", "in_review", "changes_requested", "approved_pending_dependencies", "approved_subject_to_circulation"];
/** Whether asks are being heard, and the tag that makes one. */
export function requestSettings() {
  const s = writebackSettings();
  return { on: s.enabled && s.request, tag: requestTagOf(s.tag_prefix) };
}
const hasTag = (tagsJson: unknown, tag: string) => ((j(tagsJson as string, []) || []) as unknown[]).some((t) => String(t).trim().toLowerCase() === tag.toLowerCase());

/**
 * Bring the record of asks in line with what the feed now shows: a tag newly seen is an ask, a tag gone withdraws an
 * ask still open, a review opened since answers one. Each change is audited on the work item, and the audit row is
 * what sends write-back on its way (the stage, and the answer). Cheap, and run wherever the feed may have moved.
 */
export function reconcileRequests(actor = "write-back") {
  const out = { seen: 0, answered: 0, withdrawn: 0 };
  const { on, tag } = requestSettings();
  const src = adoSource(false);
  if (!on || !src) return out;
  const now = nowIso();
  const items = db.prepare(`SELECT w.id, w.external_id, w.state, w.tags_json, w.review_id, r.stage review_stage, r.code review_code FROM work_items w LEFT JOIN reviews r ON r.id=w.review_id WHERE w.source_id=?`).all(src.id) as any[];
  const last = db.prepare("SELECT * FROM review_requests WHERE work_item_id=? ORDER BY requested_at DESC, rowid DESC LIMIT 1");
  for (const w of items) {
    const tagged = hasTag(w.tags_json, tag) && w.state !== "Removed";
    const row = last.get(w.id) as any | undefined;
    const open = row && !row.answered_at && !row.withdrawn_at;
    const live = w.review_id && w.review_stage !== "withdrawn" ? w.review_id : null;
    if (open) {
      // a review opened for the item since the ask answers it, whatever became of the tag
      if (live && live !== (row.review_id_at_request ?? null)) {
        db.prepare("UPDATE review_requests SET answered_review_id=?, answered_at=? WHERE id=?").run(live, now, row.id);
        audit(actor, "request:answered", "work_items", w.id, { external_id: w.external_id, review: w.review_code }); out.answered++;
      } else if (!tagged) {
        db.prepare("UPDATE review_requests SET withdrawn_at=?, tag_gone_at=? WHERE id=?").run(now, now, row.id);
        audit(actor, "request:withdrawn", "work_items", w.id, { external_id: w.external_id }); out.withdrawn++;
      }
      continue;
    }
    if (!tagged) { if (row && !row.tag_gone_at) db.prepare("UPDATE review_requests SET tag_gone_at=? WHERE id=?").run(now, row.id); continue; }
    // Tagged, and no ask open. It is a new ask only if the tag is new: never seen, seen gone since the last ask, or
    // still standing after the review that answered the last ask was withdrawn (that ask was not met after all).
    const answeredBy = row?.answered_review_id ? (db.prepare("SELECT code, stage FROM reviews WHERE id=?").get(row.answered_review_id) as any) : null;
    const undone = !!row?.answered_review_id && (!answeredBy || answeredBy.stage === "withdrawn");
    if (row && !row.tag_gone_at && !undone) continue;
    if (DONE_STATES.includes(w.state || "")) continue;
    if (live && IN_FLIGHT.includes(w.review_stage)) {
      // asked while a review of it is under way: that review is the answer, there and then, and no second look is owed later
      db.prepare("INSERT INTO review_requests(id, work_item_id, requested_at, review_id_at_request, answered_review_id, answered_at) VALUES (?,?,?,?,?,?)").run(uid(), w.id, now, null, live, now);
      audit(actor, "request:seen", "work_items", w.id, { external_id: w.external_id, tag, already_in_review: w.review_code }); out.seen++;
      audit(actor, "request:answered", "work_items", w.id, { external_id: w.external_id, review: w.review_code }); out.answered++;
      continue;
    }
    db.prepare("INSERT INTO review_requests(id, work_item_id, requested_at, review_id_at_request) VALUES (?,?,?,?)").run(uid(), w.id, now, live);
    audit(actor, "request:seen", "work_items", w.id, { external_id: w.external_id, tag, ...(live ? { again_after: w.review_code } : {}), ...(undone ? { reopened_after_withdrawn: answeredBy?.code ?? null } : {}) }); out.seen++;
  }
  return out;
}

/** The asks still open, for the people who submit reviews: oldest first. */
export function openRequests(): { work_item: { id: string; external_id: string; type: string; title: string; application_id: string | null; application_name: string | null }; requested_at: string; again_after: string | null }[] {
  const { on } = requestSettings();
  const src = adoSource(false);
  if (!on || !src) return [];
  return (db.prepare(`SELECT w.id, w.external_id, w.type, w.title, w.state, w.application_id, e.name application_name, q.requested_at, r.code again_after
      FROM review_requests q JOIN work_items w ON w.id=q.work_item_id LEFT JOIN elements e ON e.id=w.application_id LEFT JOIN reviews r ON r.id=q.review_id_at_request
      WHERE w.source_id=? AND q.answered_at IS NULL AND q.withdrawn_at IS NULL ORDER BY q.requested_at`).all(src.id) as any[])
    .filter((w) => !DONE_STATES.includes(w.state || ""))
    .map((w) => ({ work_item: { id: w.id, external_id: w.external_id, type: w.type, title: w.title, application_id: w.application_id ?? null, application_name: w.application_name ?? null }, requested_at: w.requested_at, again_after: w.again_after ?? null }));
}
/** Asks are an author's to pick up: authors submit reviews. */
export const requestsFor = (p: Principal) => (p.user_type === "author" ? openRequests() : []);

let soon = false;
/** Reconcile at the end of the present turn: several changes in a row (a backfill's worth of audit rows) are one pass. */
function reconcileSoon() {
  if (soon) return;
  soon = true;
  setImmediate(() => { soon = false; try { reconcileRequests(); } catch (e) { console.error("reconciling review requests failed", e); } });
}

/**
 * "Any work item": the backlog query covers epics and features, and a team may tag a story. While asks are heard, the
 * feed also takes in the work items of the project that carry the request tag, whatever their type — and reads every
 * item with an open ask again, by id: such an item may be in the feed through its tag alone, and the tag coming off (the
 * withdrawal) is the one change that tag query can never show (seen live, 7 Nov 2026: the ask stayed open until a hook).
 *
 * And an ask is answered the moment a review is opened for its item, not at the next collection: whatever touches a
 * work item, or opens or closes a review, is followed by a reconciliation (its own rows and write-back's are not news).
 */
export function startRequests() {
  onAudit((row) => {
    if (row.action.startsWith("request:") || row.action.startsWith("writeback:")) return;
    if (row.entity === "work_items" || (row.entity === "reviews" && (row.action === "create" || row.action.startsWith("decide:")))) reconcileSoon();
  });
  feedAlso(() => {
    const { on, tag } = requestSettings();
    return on ? [`SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.Tags] CONTAINS '${tag.replace(/'/g, "''")}' AND [System.State] <> 'Removed' ORDER BY [System.ChangedDate] DESC`] : [];
  });
  feedAlso((seen) => { // after the tag query: an open ask whose tag is still on was just returned, and is not asked for again
    const { on } = requestSettings();
    const src = adoSource(false);
    if (!on || !src) return [];
    const open = db.prepare("SELECT w.external_id FROM review_requests q JOIN work_items w ON w.id=q.work_item_id WHERE w.source_id=? AND q.answered_at IS NULL AND q.withdrawn_at IS NULL").all(src.id) as { external_id: string }[];
    return readAgainWiql(open.map((r) => r.external_id), seen);
  });
}
