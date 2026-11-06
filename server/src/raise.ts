import { db, j, nowIso, audit } from "./db.js";
import { appBaseUrl } from "./auth/session.js";
import type { Principal } from "./auth/context.js";
import { adoConfigured } from "./ado/client.js";
import { adoSource, claimWorkItems, type SourceItem } from "./ado/sync.js";
import { readWorkItem } from "./ado/write.js";
import { raiseWorkItem, findRaised, raisedStates, checkCreateAccess, type RaiseRequest, type RaisedWorkItem } from "./ado/raise.js";
import { writebackSettings, WRITEBACK_TIMING } from "./writeback.js";
import { addEvent } from "./boards/declare.js";
import { boardById, memberRole } from "./boards/workflow.js";
import { reviewRow, userName } from "./reviews.js";

/**
 * A condition of an approval, raised as a work item in Azure DevOps by a person's click.
 *
 * A board approves with conditions; each is work somebody has to do. Where the delivery team plans its work in Azure
 * DevOps, the condition is otherwise retyped there by hand, or forgotten. Raising it makes one work item under the
 * planned change the review covers, linked back to the review. From that moment the work is the team's: archigov
 * never changes the work item again, and reads its state back as evidence.
 *
 * Each fact keeps its home. Whether the condition is MET stays a board's judgment, recorded here by the chair:
 * a closed work item says the team considers the work done, and prompts that judgment; it does not make it. And the
 * work item's state, assignee and text are the team's, shown here and never edited.
 *
 * Nothing is raised on its own. It is a person's click, on one condition, only while an administrator has the
 * capability on (Settings · Sources · Write Back · Conditions as Work Items).
 *
 * One condition, one work item. Three things hold that: only one request for a condition runs at a time (`raising`);
 * the request is on record before anything is sent (`pending_json`), so one that got no answer is looked for, by the
 * hyperlink only that work item carries, before another is made; and a request nobody asks after again is settled
 * by the read-back (`refreshRaised`), found or let go.
 */
const WORK_DONE = ["Closed", "Resolved", "Done"]; // the team says the work is finished, whatever the process calls it
const OPEN_CONDITION = ["open", "overdue"];
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const day = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "");
const refuse = (status: number, message: string, more: Record<string, unknown> = {}) => Object.assign(new Error(message), { status, ...more });
const firstLine = (e: any) => String(e?.message || e).split("\n")[0].slice(0, 300);

const rowOf = (conditionId: string) => db.prepare("SELECT * FROM condition_work_items WHERE condition_id=?").get(conditionId) as any | undefined;
const byExternal = (externalId: string) => db.prepare("SELECT * FROM condition_work_items WHERE external_id=?").get(externalId) as any | undefined;
const conditionOf = (id: string) => db.prepare("SELECT * FROM conditions WHERE id=?").get(id) as any | undefined;
const conditionTag = () => `${writebackSettings().tag_prefix}condition`;
const markerOf = (base: string, reviewId: string, conditionId: string) => `${base}/reviews/${reviewId}?condition=${conditionId}`;
/** A request on record: when it went (or was about to), what it asked for, and the tag it carries (the prefix may change afterwards). */
interface Kept { at: string; type: string; title: string; tag?: string }

/** What the API says of a raised condition: the work item it became and what the source last said of it. */
export function raisedView(row: any) {
  if (!row) return null;
  return {
    external_id: row.external_id ?? null, type: row.type ?? null, title: row.title ?? null, url: row.url ?? null,
    state: row.state ?? null, closed: !!row.state && WORK_DONE.includes(row.state), closed_at: row.closed_at ?? null, gone: !!row.gone,
    parent_work_item_id: row.parent_work_item_id, raised_by: row.raised_by, raised_by_name: userName(row.raised_by), raised_at: row.raised_at, seen_at: row.seen_at ?? null,
    // asked for, and Azure DevOps has not said whether it was made: asking again looks for it first
    unconfirmed: !row.external_id && !!row.pending_json, error: row.error ?? null,
  };
}
export const raisedOf = (conditionId: string) => raisedView(rowOf(conditionId));

/** The planned changes from Azure DevOps that a review covers: where a condition of it can be raised. */
export function raiseParents(review: any): { id: string; external_id: string; type: string; title: string }[] {
  const src = adoSource(false);
  if (!src) return [];
  return db.prepare("SELECT id, external_id, type, title FROM work_items WHERE source_id=? AND COALESCE(state,'') <> 'Removed' AND (review_id=? OR id=?) ORDER BY external_id").all(src.id, review.id, review.work_item_id ?? "") as any[];
}

/** Whether raising is switched on and able to work on this instance, whatever the review: null when it is, else why not. */
function raiseOff(): string | null {
  const s = writebackSettings();
  if (!adoConfigured()) return "Azure DevOps is not connected.";
  if (!s.enabled || !s.raise) return "Raising conditions in Azure DevOps is off. A platform admin turns it on under Settings · Sources.";
  if (!appBaseUrl()) return "APP_BASE_URL is not set, so the work item could not link back to this review.";
  return null;
}
/** Whether a condition of this review can be raised at all, and if not, why: the reason the greyed-out action gives. */
export function raiseAvailability(review: any): { ok: true; type: string; parents: ReturnType<typeof raiseParents> } | { ok: false; reason: string } {
  const off = raiseOff();
  if (off) return { ok: false, reason: off };
  const parents = raiseParents(review);
  if (!parents.length) return { ok: false, reason: "This review covers no Azure DevOps work item to raise it under. Link the review to a planned change first." };
  return { ok: true, type: writebackSettings().raise_type, parents };
}

/**
 * Who raises a condition: the person it is owed by (its owner, when the condition names a user of this instance),
 * the person whose design it is (the submitter), and the people who run the board that set it (chair, secretary).
 * The right comes from that standing and from nothing else: not from a role, and not from the platform admin flag.
 * An auditor, a service account and an identity that is the platform admin and nothing else change nothing, whatever
 * they are named as.
 */
export function canRaiseCondition(p: Principal | null, review: any, cond: any): { ok: boolean; reason?: string } {
  if (!p) return { ok: false, reason: "sign in" };
  if (p.user_type === "auditor" || p.user_type === "service") return { ok: false, reason: "An auditor or a service account changes nothing." };
  // the platform admin flag alone runs the instance and changes nothing in governance, whatever a condition names it as
  if (p.is_platform_admin && !p.user_type && p.boards.length === 0) return { ok: false, reason: "A platform admin runs the instance and raises nothing." };
  const role = memberRole(p, review.board_id);
  if ((!!cond.owner && p.id === cond.owner) || p.id === review.submitted_by || role === "chair" || role === "secretary") return { ok: true };
  return { ok: false, reason: "The condition's owner, the review's submitter, or the chair or secretary of its board raises it." };
}

const defaultTitle = (cond: any, review: any) => `Condition of ${review.code}: ${String(cond.text).replace(/\s+/g, " ").trim()}`.slice(0, 255);
/** What the work item says: the condition in the board's words, where it comes from, and what closing it does and does not mean. */
function describe(cond: any, review: any, base: string): string {
  const board = boardById(review.board_id)?.name || "the board";
  return `<div>${esc(cond.text)}</div>`
    + `<div><br><b>archigov</b>: a condition of the approval of review ${esc(review.code)} (${esc(review.title)}) by ${esc(board)}${review.decided_at ? ` on ${day(review.decided_at)}` : ""}.`
    + `${cond.owner ? ` Owner: ${esc(userName(cond.owner))}.` : ""}${cond.due_at ? ` Due ${day(cond.due_at)}.` : ""} <a href="${esc(`${base}/reviews/${review.id}`)}">Open the review</a>.</div>`
    + `<div>Closing this work item tells the board the work is done. The board then confirms in archigov that the condition is met.</div>`;
}

/** The work item is known: on the record, on the audit chain and on the review's timeline. A planned change the feed made of it meanwhile is taken out again. */
function confirm(cond: any, review: any, made: RaisedWorkItem, under: string | null, actor: string, how: Record<string, unknown> = {}) {
  db.prepare("UPDATE condition_work_items SET external_id=?, type=?, title=?, url=?, state=?, rev=?, state_changed_at=?, closed_at=?, seen_at=?, gone=0, pending_json=NULL, error=NULL WHERE condition_id=?")
    .run(String(made.id), made.type, made.title, made.url, made.state, made.rev, made.changed_at, made.state && WORK_DONE.includes(made.state) ? made.changed_at || nowIso() : null, nowIso(), cond.id);
  const src = adoSource(false);
  if (src) db.prepare("UPDATE work_items SET state='Removed' WHERE source_id=? AND external_id=?").run(src.id, String(made.id));
  audit(actor, "writeback:raise", "conditions", cond.id, { review: review.code, external_id: String(made.id), type: made.type, under, found_existing: !made.created, ...how });
  addEvent(review.id, "condition_raised", actor, cond.text, { condition_id: cond.id, external_id: String(made.id), type: made.type, url: made.url, under }, null);
}

const raising = new Set<string>(); // conditions with a request in flight in this process

/**
 * Raise one condition. Answers what it became, or `unconfirmed` when Azure DevOps gave no answer: the request is kept,
 * and raising again looks for the work item before making another (not within the first half minute, when the first
 * may still be landing).
 */
export async function raiseCondition(cond: any, review: any, actor: string, opts: { work_item_id?: string | null; title?: string | null } = {}) {
  // everything up to the first await runs in one go, so of two clicks at the same moment the second stops here
  if (raising.has(cond.id)) throw refuse(409, "this condition is being raised right now: wait for that to finish", { waiting: true });
  raising.add(cond.id);
  try {
    const off = raiseOff();
    if (off) throw refuse(409, off);
    if (!OPEN_CONDITION.includes(cond.status)) throw refuse(409, `the condition is ${cond.status}: only an open condition is raised`);
    const s = writebackSettings(), base = appBaseUrl();
    let row = rowOf(cond.id);
    if (row?.external_id) throw refuse(409, `already raised as ${row.type || "work item"} ${row.external_id}`, { raised: raisedView(row) });
    const kept: Kept | null = j(row?.pending_json, null);
    // A request already on record is asked again as it was: the same work item under the same parent, even when that
    // parent has since left the backlog or the review. A new one goes under a planned change the review covers now.
    const parents = raiseParents(review);
    if (!row && !parents.length) throw refuse(409, "This review covers no Azure DevOps work item to raise it under. Link the review to a planned change first.");
    const parent = row ? (db.prepare("SELECT id, external_id, type, title FROM work_items WHERE id=?").get(row.parent_work_item_id) as any)
      : opts.work_item_id ? parents.find((p) => p.id === opts.work_item_id) : parents.length === 1 ? parents[0] : null;
    if (!parent) throw refuse(400, parents.length > 1 && !opts.work_item_id ? "this review covers several work items: say which one it goes under (work_item_id)" : "work_item_id is not a work item this review covers");
    const title = (kept?.title || String(opts.title || "").replace(/\s+/g, " ").trim() || defaultTitle(cond, review)).slice(0, 255);
    const type = kept?.type || s.raise_type, asked = kept?.at ?? nowIso(), tag = kept?.tag || conditionTag();
    // on record before anything is sent, with what is asked for: another request (in another process, or after a crash) finds it and looks first
    if (!row) { db.prepare("INSERT INTO condition_work_items(condition_id, parent_work_item_id, raised_by, raised_at, pending_json) VALUES (?,?,?,?,?)").run(cond.id, parent.id, actor, asked, JSON.stringify({ at: asked, type, title, tag } satisfies Kept)); row = rowOf(cond.id); }
    const req: RaiseRequest = { type, title, description: describe(cond, review, base), tags: [tag], parent: String(parent.external_id),
      marker: { url: markerOf(base, review.id, cond.id), comment: `archigov: condition of review ${review.code}` } };
    try {
      // an earlier request is looked for wherever it may have gone since (the team may have moved it under another parent)
      const made = await raiseWorkItem(req, { wider: kept ? { tag, since: kept.at } : undefined, sending: () => {
        // not found, so about to be created: unless the earlier request went only moments ago and may still be landing
        if (kept && Date.now() - Date.parse(kept.at) < WRITEBACK_TIMING.settleAfterMs) throw refuse(409, "Azure DevOps has not answered the first request yet: try again in a moment", { waiting: true });
        db.prepare("UPDATE condition_work_items SET pending_json=?, error=NULL WHERE condition_id=?").run(JSON.stringify({ at: nowIso(), type, title, tag } satisfies Kept), cond.id);
      } });
      confirm(cond, review, { ...made, type: made.type || type, title: made.title || title }, String(parent.external_id), actor);
      return { ok: true as const, raised: raisedOf(cond.id)! };
    } catch (e: any) {
      if (e?.waiting) throw e;
      const error = firstLine(e);
      if (e?.sent === "unanswered") {
        db.prepare("UPDATE condition_work_items SET error=? WHERE condition_id=?").run(error, cond.id);
        audit(actor, "writeback:raise_unanswered", "conditions", cond.id, { review: review.code, error });
        return { ok: false as const, unconfirmed: true as const, raised: raisedOf(cond.id)!, error };
      }
      // Nothing was made by this call. With no earlier request out there the claim is released; with one, it stays on
      // record unless Azure DevOps looked and refused (then it was not there to be found, and is not there now).
      if (!kept || e?.sent === "refused") db.prepare("DELETE FROM condition_work_items WHERE condition_id=? AND external_id IS NULL").run(cond.id);
      throw refuse(502, `Azure DevOps did not create the work item: ${error}`);
    }
  } finally { raising.delete(cond.id); }
}

/** What the source now says of one raised work item, applied to its row: its state, and the moment it closed, reopened or was taken out. */
function apply(row: any, now: { rev: number; state?: string | null; title?: string | null; type?: string | null; changed_at?: string | null; deleted?: boolean }, actor: string) {
  if (now.deleted) return markGone(row, actor);
  if (row.rev != null && now.rev != null && now.rev < row.rev) return; // an older word than the one already on record
  const state = now.state ?? row.state, was = !!row.state && WORK_DONE.includes(row.state), is = !!state && WORK_DONE.includes(state);
  const changed = state !== row.state, back = !!row.gone;
  const at = now.changed_at || nowIso();
  // closed_at is the source's change date when the closure was first seen here: the day the team called it done, as near as the source says
  db.prepare("UPDATE condition_work_items SET state=?, rev=?, title=COALESCE(?, title), type=COALESCE(?, type), state_changed_at=CASE WHEN ? THEN ? ELSE state_changed_at END, closed_at=?, seen_at=?, gone=0 WHERE condition_id=?")
    .run(state, now.rev ?? row.rev, now.title ?? null, now.type ?? null, changed ? 1 : 0, at, is ? (was && row.closed_at ? row.closed_at : at) : null, nowIso(), row.condition_id);
  const cond = conditionOf(row.condition_id);
  if (!cond) return;
  const tell = (kind: string, action: string) => {
    addEvent(cond.review_id, kind, "azure-devops", cond.text, { condition_id: cond.id, external_id: row.external_id, state, url: row.url }, null, "derived");
    audit(actor, action, "conditions", cond.id, { external_id: row.external_id, state });
  };
  if (back) tell("condition_work_back", "writeback:raised_back");
  // closing is evidence the team considers the work done; the board still confirms the condition is met
  if (was !== is) tell(is ? "condition_work_closed" : "condition_work_reopened", is ? "writeback:raised_closed" : "writeback:raised_reopened");
  // taken out of the backlog without being done: the work was dropped, and the people the condition concerns should see that
  else if (changed && state === "Removed") tell("condition_work_removed", "writeback:raised_removed");
}
function markGone(row: any, actor: string) {
  if (row.gone) return;
  db.prepare("UPDATE condition_work_items SET gone=1, seen_at=? WHERE condition_id=?").run(nowIso(), row.condition_id);
  const cond = conditionOf(row.condition_id);
  if (!cond) return;
  addEvent(cond.review_id, "condition_work_gone", "azure-devops", cond.text, { condition_id: cond.id, external_id: row.external_id }, null, "derived");
  audit(actor, "writeback:raised_gone", "conditions", cond.id, { external_id: row.external_id });
}

/**
 * A request that got no answer and that nobody has asked after: found, or let go. It is looked for under its parent
 * and among the project's work items carrying the condition tag. Found, it is confirmed as raised. Not found once the
 * grace has passed, the claim is released and the condition can be raised afresh. While the source cannot be asked,
 * nothing is concluded.
 */
async function settleUnconfirmed(row: any, actor: string): Promise<"found" | "released" | "wait"> {
  const kept: Kept | null = j(row.pending_json, null);
  const cond = conditionOf(row.condition_id);
  if (!kept || !cond) return "wait";
  if (raising.has(cond.id) || Date.now() - Date.parse(kept.at) < WRITEBACK_TIMING.settleAfterMs) return "wait";
  const review = reviewRow(cond.review_id), base = appBaseUrl();
  const parent = db.prepare("SELECT external_id FROM work_items WHERE id=?").get(row.parent_work_item_id) as any;
  if (!review || !base || !parent) return "wait";
  const marker = markerOf(base, review.id, cond.id), wider = { tag: kept.tag || conditionTag(), since: kept.at };
  // held like a person's request: a click that arrives while this is looking waits, and never finds the claim gone under it
  raising.add(cond.id);
  try {
    let made: RaisedWorkItem | null;
    try { made = await findRaised(String(parent.external_id), marker, undefined, wider); }
    catch (e: any) {
      if (e?.status !== 404) return "wait"; // the source cannot be asked now
      try { made = await findRaised(String(parent.external_id), marker, null, wider); } catch { return "wait"; } // the parent itself is gone: look among the tagged ones only
    }
    if (made) { confirm(cond, review, { ...made, type: made.type || kept.type, title: made.title || kept.title }, String(parent.external_id), actor, { found_later: true }); return "found"; }
    db.prepare("DELETE FROM condition_work_items WHERE condition_id=? AND external_id IS NULL").run(cond.id);
    audit(actor, "writeback:raise_not_found", "conditions", cond.id, { review: review.code, asked_at: kept.at });
    return "released";
  } finally { raising.delete(cond.id); }
}

/**
 * Read back what the source says of the work items raised for conditions still open, and settle the requests that
 * never got an answer. Reading needs no switch: it is the feed's side, and a work item raised while the capability was
 * on goes on being evidence after it is turned off.
 *
 * A work item the source does not return is not thereby gone: an identity that lost its access gets the same answer.
 * It is called gone only when the planned change it was raised under can still be read, and it is asked after again
 * on every pass, so one that comes back is seen.
 */
export async function refreshRaised(actor = "write-back") {
  const out = { checked: 0, gone: 0, settled: 0 };
  if (!adoConfigured()) return out;
  const open = "c.status IN ('open','overdue')";
  for (const r of db.prepare(`SELECT cw.* FROM condition_work_items cw JOIN conditions c ON c.id=cw.condition_id WHERE cw.external_id IS NULL AND cw.pending_json IS NOT NULL AND ${open}`).all() as any[])
    if ((await settleUnconfirmed(r, actor)) !== "wait") out.settled++;
  const rows = db.prepare(`SELECT cw.*, w.external_id parent_external FROM condition_work_items cw JOIN conditions c ON c.id=cw.condition_id LEFT JOIN work_items w ON w.id=cw.parent_work_item_id WHERE cw.external_id IS NOT NULL AND ${open}`).all() as any[];
  if (!rows.length) return out;
  const states = await raisedStates(rows.map((r) => r.external_id));
  const readable = new Map<string, boolean>(); // whether a parent can still be read: the identity's access, checked once per parent
  for (const r of rows) {
    out.checked++;
    const now = states.get(String(r.external_id));
    if (now) { apply(r, now, actor); continue; }
    if (r.gone) continue;
    const parent = String(r.parent_external ?? "");
    if (!readable.has(parent)) readable.set(parent, parent ? await readWorkItem(parent).then(() => true, () => false) : false);
    if (readable.get(parent)) { markGone(r, actor); out.gone++; }
  }
  return out;
}

/** Whether a work item of the configured type can be created, asked without creating one. An item that cannot say (gone, or another project's) is passed over for the next. */
export async function testRaiseAccess() {
  const s = writebackSettings();
  const src = adoSource(false);
  const items = src ? (db.prepare("SELECT external_id FROM work_items WHERE source_id=? AND COALESCE(state,'') <> 'Removed' ORDER BY external_id LIMIT 5").all(src.id) as any[]) : [];
  if (!items.length) return { type: s.raise_type, ok: false as const, error: "No work item in scope to test against: sync the backlog first" };
  let error = "";
  for (const w of items) {
    const r = await checkCreateAccess(s.raise_type, String(w.external_id));
    if (r.ok) return { type: s.raise_type, ok: true as const };
    error = r.error;
    if (!r.elsewhere) break;
  }
  return { type: s.raise_type, ok: false as const, error };
}

/** Conditions on boards a person chairs whose raised work item is closed: theirs to confirm as met, or not. */
export function conditionsToConfirm(p: Principal): any[] {
  const chaired = p.boards.filter((b) => b.role === "chair").map((b) => b.id);
  if (!chaired.length) return [];
  return (db.prepare(`SELECT c.id, c.review_id, c.text, c.due_at, c.status, c.area FROM conditions c JOIN condition_work_items cw ON cw.condition_id=c.id JOIN reviews r ON r.id=c.review_id
    WHERE c.status IN ('open','overdue') AND cw.gone=0 AND cw.state IN (${WORK_DONE.map(() => "?").join(",")}) AND r.board_id IN (${chaired.map(() => "?").join(",")}) ORDER BY cw.closed_at`).all(...WORK_DONE, ...chaired) as any[])
    .map((c) => ({ id: c.id, review_id: c.review_id as string, text: c.text, due_at: c.due_at ?? null, status: c.status, area: c.area ?? null, raised: raisedOf(c.id) }));
}

/**
 * The feed leaves the work items of conditions alone: they are not planned changes. What the service hook or the
 * backfill says of one that is on record is taken as news of its state. One that is not on record yet but carries the
 * condition tag, and is not already a planned change, is a request whose answer has not arrived (the hook can be
 * quicker than the answer, or the answer was lost): it is kept out of the planned changes all the same, and the
 * request it answers is confirmed when it is next looked for, by its hyperlink.
 */
export function startRaise() {
  claimWorkItems((w: SourceItem) => {
    const f = w.fields || {}, pick = (k: string) => { const v = f[k]; return v && typeof v === "object" && "newValue" in v ? v.newValue : v; }; // a hook's field diff is {oldValue, newValue}
    const row = byExternal(String(w.id));
    if (row) {
      try { apply(row, { rev: w.rev || row.rev, state: pick("System.State") ?? null, title: pick("System.Title") ?? null, type: pick("System.WorkItemType") ?? null, changed_at: pick("System.ChangedDate") ?? null, deleted: w.deleted }, "ado-hook"); }
      catch (e) { console.error("a raised work item's state could not be recorded", e); }
      return true; // it is one of these whatever became of recording it: never a planned change
    }
    const tags = String(pick("System.Tags") ?? "").split(";").map((t) => t.trim().toLowerCase());
    if (!tags.includes(conditionTag().toLowerCase())) return false;
    // the tag keeps a NEW work item out; one that already is a planned change stays one, whoever put the tag on it
    const src = adoSource(false);
    return !(src && db.prepare("SELECT 1 FROM work_items WHERE source_id=? AND external_id=?").get(src.id, String(w.id)));
  });
}
