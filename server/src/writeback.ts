import { db, j, nowIso, audit, getSetting, setSetting, onAudit } from "./db.js";
import { appBaseUrl } from "./auth/session.js";
import { adoConfigured } from "./ado/client.js";
import { adoSource } from "./ado/sync.js";
import { writeToWorkItem, readWorkItem, showsWrite, checkWriteAccess, type WorkItemWrite } from "./ado/write.js";
import type { AdoWorkItemFull } from "./ado/client.js";
import { CHANGE_SELECT, CHANGE_STAGES, STAGE_LABEL, changeStage, decisionStandings, requestOpen, setRequestsHeard, type ChangeStage } from "./stage.js";
import { rulesPreReview } from "./ai.js";
import { decisionPreReview } from "./reviews.js";

/**
 * Write-back: showing a planned change's place in the decision lifecycle on the work item at its source, so the
 * people who plan the work see what the boards said without leaving their tool. Optional, and off until a platform
 * admin turns it on, one capability at a time.
 *
 * Each fact keeps one home. archigov owns the decision, the review, its outcome and its conditions; Azure DevOps owns
 * the work (state, assignee, title, description), which is never touched. What crosses is a link to the records, one
 * tag naming the stage, and a dated comment when a board declares an outcome or the item changes after approval:
 * facts and where to read more, never the reasoning and never anything an AI wrote. Nothing in Azure DevOps is
 * blocked by any of it: the backlog stays a feed, never a gate.
 *
 * It works as a sweep, not as messages: what each item should show is worked out from the records, compared with what
 * was last written (work_item_writeback), and only the difference is sent. A failed write is tried again later, a
 * change made while the source was unreachable is not lost, and turning it on writes everything that is already true.
 */
export interface WritebackSettings { enabled: boolean; link: boolean; stage: boolean; comment: boolean; raise: boolean; request: boolean; tag_prefix: string; raise_type: string }
// `raise` creates work items and `request` listens for a tag the team types, so unlike the three that only show a
// stage they stay off until they are chosen
const DEFAULTS: WritebackSettings = { enabled: false, link: true, stage: true, comment: true, raise: false, request: false, tag_prefix: "arch:", raise_type: "Task" };
export const CAPABILITIES = [
  { id: "link", label: "Links", writes: "A hyperlink on the work item to the decision and to the review that cover it." },
  { id: "stage", label: "Lifecycle Stage", writes: "One tag naming where the change stands, replaced as it moves. It works in queries, board filters and card styles." },
  { id: "comment", label: "Outcome Comments", writes: "A comment when a board declares an outcome on the review, and when the item changes after approval. Followers of the item are notified by Azure DevOps." },
  { id: "raise", label: "Conditions as Work Items", writes: "Lets a person raise a condition of an approval as a work item under the change it belongs to, one click at a time. Nothing is created on its own, and from then on Azure DevOps owns the work." },
  { id: "request", label: "Review Requests", writes: "A team asks for a review by putting the request tag on a work item. The ask is listed for authors here, and when one of them opens a review the work item is told, with the counts of the automatic checks. Nothing is submitted on anyone's behalf." },
] as const;
/** The tag a delivery team puts on a work item to ask for a review: the prefix followed by `review`. It is theirs to put on and take off; archigov only reads it. */
export const requestTagOf = (prefix: string) => `${prefix}review`;
/** The work item type a condition is raised as: a type name of the project's process (Task, Issue, Product Backlog Item…). */
export const RAISE_TYPE = /^\p{L}[\p{L}\p{N} ._-]{0,48}$/u; // a process may name its types in any language
/** A prefix keeps archigov's tags apart from the team's own, and lets it take its own tags off again: it must end in a separator. */
export const TAG_PREFIX = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,18}[:/-]$/;
const OUTCOME_STAGES = ["approved", "approved_with_conditions", "changes_requested", "rejected"];
const tagOf = (prefix: string, stage: ChangeStage) => prefix + stage.replace(/_/g, "-");
const stageTags = (prefix: string) => CHANGE_STAGES.map((st) => tagOf(prefix, st.id));
/** Tests shorten this: how long an unanswered write is given to land before an unchanged revision is read as "it was not saved". */
export const WRITEBACK_TIMING = { settleAfterMs: 30_000 };

let enabledNow: boolean | null = null; // read on every audit row, so kept in memory; saveWritebackSettings refreshes it
export function writebackSettings(): WritebackSettings {
  const s = j(getSetting("ado.writeback"), null) || {};
  const out = { enabled: !!s.enabled, link: s.link ?? DEFAULTS.link, stage: s.stage ?? DEFAULTS.stage, comment: s.comment ?? DEFAULTS.comment, raise: s.raise ?? DEFAULTS.raise, request: s.request ?? DEFAULTS.request,
    tag_prefix: typeof s.tag_prefix === "string" && TAG_PREFIX.test(s.tag_prefix) ? s.tag_prefix : DEFAULTS.tag_prefix,
    raise_type: typeof s.raise_type === "string" && RAISE_TYPE.test(s.raise_type) ? s.raise_type : DEFAULTS.raise_type };
  enabledNow = out.enabled;
  return out;
}
export function saveWritebackSettings(next: WritebackSettings) { setSetting("ado.writeback", JSON.stringify(next)); enabledNow = next.enabled; }
// asks for a review are heard while write-back is on with that capability; the stage (stage.ts) asks here
setRequestsHeard(() => { const s = writebackSettings(); return s.enabled && s.request; });

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const day = (iso: string | null | undefined) => new Date(iso || Date.now()).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/**
 * The work items write-back covers: those of the Azure DevOps source that are still there. One taken out of the
 * backlog (Removed) stays in scope for as long as it may carry a stage tag, so the tag comes off.
 */
function rowsInScope(): any[] {
  const src = adoSource(false);
  return src ? (db.prepare(`${CHANGE_SELECT} WHERE w.source_id=? AND (COALESCE(w.state,'') <> 'Removed' OR wb.tag IS NOT NULL OR wb.pending_json IS NOT NULL) ORDER BY w.external_id`).all(src.id) as any[]) : [];
}
const stored = (id: string) => db.prepare("SELECT * FROM work_item_writeback WHERE work_item_id=?").get(id) as any | undefined;
/** The review that covers an item: a withdrawn one covers nothing, so it is neither linked nor named. */
const coveringReview = (w: any) => (w.review_id && w.review_code && w.review_stage !== "withdrawn" ? w.review_id : null);

/**
 * What one item should show at its source under the current settings, from the records alone. `was` is what was last
 * written: with comments switched off (or the item gone) what was said stays as it was, so switching them on again
 * repeats nothing.
 */
export function shownFor(w: any, s: WritebackSettings, standing: ReturnType<typeof decisionStandings>, base = appBaseUrl(), was?: any) {
  const gone = w.state === "Removed";
  const stage = changeStage({ ...w, review_requested: requestOpen(w) }, standing(w.decision_id));
  const links: { url: string; comment: string }[] = [];
  if (s.link && base && !gone) {
    if (w.decision_id && w.decision_code) links.push({ url: `${base}/decisions/${w.decision_id}`, comment: `archigov decision ${w.decision_code}: ${w.decision_title}`.slice(0, 250) });
    if (coveringReview(w)) links.push({ url: `${base}/reviews/${w.review_id}`, comment: `archigov review ${w.review_code}: ${w.review_title}`.slice(0, 250) });
  }
  const speaks = s.comment && !gone;
  return {
    stage, tag: s.stage && stage ? tagOf(s.tag_prefix, stage) : null, links,
    // A dated fact is commented once, and each key names one occurrence of it: the outcome in effect on the review in
    // this round of it (a resubmission starts another, so a second "changes requested" is a new fact), and the change
    // since the text the approval was given on (acknowledging moves that baseline, so a later change is a new fact).
    // A key that differs from the one last written is said, even if the record never saw the one in between.
    outcome: !speaks ? (was?.outcome ?? null) : w.review_id && OUTCOME_STAGES.includes(w.review_stage) ? `${w.review_id}:${w.review_stage}:${w.review_resubmitted_at || ""}` : null,
    changed: !speaks ? (was?.changed_hash ?? null) : stage === "changed_after_approval" ? `since:${w.approved_hash || ""}` : null,
    // the answer to an ask for a review: said once per ask, when the review that answers it covers the item. It belongs
    // to the request capability, not to the outcome comments, and once said it stays said.
    answered: s.request && !gone && w.request_answered && coveringReview(w) ? `answered:${w.request_answered}` : (was?.answered ?? null),
  };
}

/**
 * What the automatic checks say of a review, for the work item: counts, and the codes of the catalogue items they
 * cite. Only the deterministic checks are asked (the rules pre-review, always available), afresh, whatever pre-review
 * is stored on the review: nothing an AI wrote crosses, and no finding's words either. The detail is behind the link.
 */
function automaticChecks(w: any): string {
  try {
    if (w.review_type === "design") {
      // Only what is checked against the record: a catalogue item's rule on the application's estate, or an accepted
      // decision. What the template says is missing from the design text is left out: when the answer is given the
      // design may be no more than the work item's own words, and a count of its gaps would say nothing of the change.
      const cites = (f: { citations?: { kind: string; ref: string }[] }) => (f.citations || []).filter((c) => c.kind === "standard" || c.kind === "decision");
      const found = rulesPreReview(w.review_id).findings.filter((f) => cites(f).length);
      if (!found.length) return "The automatic checks against the catalogue and the accepted decisions found nothing to address.";
      const by = ["critical", "high", "medium", "low", "info"].map((sev) => [sev, found.filter((f) => f.severity === sev).length] as const).filter(([, n]) => n).map(([sev, n]) => `${n} ${sev}`);
      const codes = [...new Set(found.flatMap((f) => cites(f).map((c) => String(c.ref))))].slice(0, 6);
      return `The automatic checks against the catalogue and the accepted decisions found ${found.length} point${found.length === 1 ? "" : "s"} to address (${by.join(", ")}): ${esc(codes.join(", "))}.`;
    }
    if (w.review_type === "decision" && w.review_target_id) {
      const d = db.prepare("SELECT * FROM decisions WHERE id=?").get(w.review_target_id);
      if (!d) return "";
      const checks = decisionPreReview(d).checks as { state: string }[], n = (st: string) => checks.filter((k) => k.state === st).length;
      return `Automatic checks on the decision: ${n("pass")} passed${n("warn") ? `, ${n("warn")} to look at` : ""}${n("fail") ? `, ${n("fail")} failed` : ""}.`;
    }
  } catch { /* the checks could not be run: the fact that a review was opened is still said */ }
  return "";
}
/** The answer to an ask for a review: that it was opened, with which board, what the automatic checks counted, and where it is. */
function answerComment(w: any, base: string): string {
  const checks = automaticChecks(w);
  return `<div><b>archigov</b>: the review asked for on this item is open as ${esc(w.review_code)} and is with ${esc(w.review_board || "its board")}.${checks ? ` ${checks}` : ""}${base ? ` <a href="${esc(`${base}/reviews/${w.review_id}`)}">Open the review</a>.` : ""}</div>`;
}

/** The comment for a declared outcome: who, what, when, and where the record is. A fact, never a verdict on the design. */
function outcomeComment(w: any, base: string): string {
  // The day this outcome came about: for an approval or a rejection the declaration, or the later day a held approval
  // took effect; for changes requested the send-back itself (it sets no decided_at, and an earlier one may be standing).
  const at = w.review_stage === "changes_requested" ? w.review_sent_back_at || w.review_updated_at
    : [w.review_decided_at, w.review_effective_at].filter(Boolean).sort().pop() || w.review_updated_at;
  const board = esc(w.review_board || "the board"), code = esc(w.review_code), on = day(at);
  const n = Number(w.conditions || 0);
  const said = w.review_stage === "approved" ? `Review ${code} was approved by ${board} on ${on}.`
    : w.review_stage === "approved_with_conditions" ? `Review ${code} was approved with conditions by ${board} on ${on}${n ? `: ${n} condition${n === 1 ? "" : "s"} to meet` : ""}.`
    : w.review_stage === "rejected" ? `Review ${code} was rejected by ${board} on ${on}.`
    : `Changes were requested on review ${code} by ${board} on ${on}.`;
  return `<div><b>archigov</b>: ${said}${base ? ` <a href="${esc(`${base}/reviews/${w.review_id}`)}">Open the review</a> for the record and what happens next.` : ""}</div>`;
}
function changedComment(w: any, base: string): string {
  const review = coveringReview(w);
  const covered = review ? `review ${esc(w.review_code)}` : w.decision_code ? `decision ${esc(w.decision_code)}` : "its review";
  const link = !base ? "" : review ? ` <a href="${esc(`${base}/reviews/${review}`)}">Open the review</a>.` : w.decision_id ? ` <a href="${esc(`${base}/decisions/${w.decision_id}`)}">Open the decision</a>.` : "";
  return `<div><b>archigov</b>: the title or description of this item changed after ${covered} covered it. The change is flagged for the people who approved it; what was approved is the earlier text.${link}</div>`;
}

/** What would be sent for one item now: the difference between what it should show and what was last written. */
function pending(w: any, s: WritebackSettings, standing: ReturnType<typeof decisionStandings>, base: string) {
  const was = stored(w.id), want = shownFor(w, s, standing, base, was);
  const had: string[] = j(was?.links_json, []) || [];
  const write: WorkItemWrite = {};
  const retags = (was?.tag ?? null) !== want.tag;
  // Only a tag archigov knows it wrote is ever taken off: the one on record. A tag a person typed stays, even one
  // spelled like a stage tag (the Settings page says when the prefix is already in use).
  if (retags) { if (was?.tag) write.removeTags = [was.tag]; if (want.tag) write.addTags = [want.tag]; }
  const newLinks = want.links.filter((l) => !had.includes(l.url));
  if (newLinks.length) write.addLinks = newLinks;
  const notes: string[] = [], said: string[] = [];
  if (want.answered && want.answered !== (was?.answered ?? null)) { notes.push(answerComment(w, base)); said.push("review_opened"); }
  if (want.outcome && want.outcome !== (was?.outcome ?? null)) { notes.push(outcomeComment(w, base)); said.push(`outcome:${w.review_stage}`); }
  if (want.changed && want.changed !== (was?.changed_hash ?? null)) { notes.push(changedComment(w, base)); said.push("changed_after_approval"); }
  if (notes.length) write.comment = notes.join("");
  const sends = retags || !!write.addLinks || !!write.comment;
  // what was said stays said until the fact itself is gone (a resubmission, an acknowledged change): then it is forgotten
  const settles = !sends && ((was?.outcome ?? null) !== want.outcome || (was?.changed_hash ?? null) !== want.changed || (was?.answered ?? null) !== want.answered || (was?.stage ?? null) !== want.stage);
  return { want, was, write, said, sends, settles, retags, links: [...had, ...newLinks.map((l) => l.url)] };
}
const remember = (id: string, p: ReturnType<typeof pending>, rev: number | null, wrote: boolean) =>
  db.prepare(`INSERT INTO work_item_writeback(work_item_id, stage, tag, links_json, outcome, changed_hash, answered, rev, written_at, error, attempts, retry_after, pending_json) VALUES (?,?,?,?,?,?,?,?,?,NULL,0,NULL,NULL)
    ON CONFLICT(work_item_id) DO UPDATE SET stage=excluded.stage, tag=excluded.tag, links_json=excluded.links_json, outcome=excluded.outcome, changed_hash=excluded.changed_hash, answered=excluded.answered,
      rev=COALESCE(excluded.rev, rev), written_at=COALESCE(excluded.written_at, written_at), error=NULL, attempts=0, retry_after=NULL, pending_json=NULL`)
    .run(id, p.want.stage, p.want.tag, JSON.stringify(p.links), p.want.outcome, p.want.changed, p.want.answered, rev, wrote ? nowIso() : null);

/**
 * A document on its way: kept from just before it is sent until its answer comes. It holds the item's revision at that
 * moment, the tags and links the document carries, and what the record becomes if it is saved (the facts its comment
 * states among them). An answer clears it; no answer leaves it for `settle` to work out.
 */
interface Sent { rev: number; at: string; write: Pick<WorkItemWrite, "addTags" | "removeTags"> & { addLinks?: { url: string }[] }; stage: string | null; tag: string | null; links: string[]; outcome: string | null; changed: string | null; answered?: string | null; said: string[] }
const keep = (id: string, rev: number, p: ReturnType<typeof pending>) => {
  const sent: Sent = { rev, at: nowIso(), write: { addTags: p.write.addTags, removeTags: p.write.removeTags, addLinks: (p.write.addLinks || []).map((l) => ({ url: l.url })) },
    stage: p.want.stage, tag: p.want.tag, links: p.links, outcome: p.want.outcome, changed: p.want.changed, answered: p.want.answered, said: p.said };
  db.prepare("INSERT INTO work_item_writeback(work_item_id, pending_json) VALUES (?,?) ON CONFLICT(work_item_id) DO UPDATE SET pending_json=excluded.pending_json").run(id, JSON.stringify(sent));
};
const drop = (id: string) => db.prepare("UPDATE work_item_writeback SET pending_json=NULL WHERE work_item_id=?").run(id);

/**
 * What became of a document that never got an answer, told from the item as it stands now and from what that
 * document carried (never from what is wanted today, which may have moved on since):
 *  - the item is at the revision it was sent at: it was not saved. Unless it was sent only moments ago, when the save
 *    may still be landing behind an error already returned: then "wait", and the next sweep looks again;
 *  - the item moved on and shows the document's tags and links: it was saved, comment and all. The record takes it;
 *  - the item moved on and does not show them: somebody else's revision. It was not saved;
 *  - the document was nothing but a comment and the item moved on: there is nothing to tell by. It is taken as saved,
 *    because a fact missing from the discussion is put right by the tag and the link, and one said twice is not.
 * Whatever is sent next is then worked out afresh from the record, so a later fact is still said in its own right.
 */
function settle(id: string, sent: Sent, item: AdoWorkItemFull, actor: string): "saved" | "not_saved" | "wait" {
  if (item.rev <= sent.rev) {
    if (Date.now() - Date.parse(sent.at) < WRITEBACK_TIMING.settleAfterMs) return "wait";
    drop(id); return "not_saved";
  }
  if (showsWrite(item, sent.write) === false) { drop(id); return "not_saved"; }
  db.prepare("UPDATE work_item_writeback SET stage=?, tag=?, links_json=?, outcome=?, changed_hash=?, answered=COALESCE(?, answered), rev=?, written_at=?, pending_json=NULL, error=NULL, attempts=0, retry_after=NULL WHERE work_item_id=?")
    .run(sent.stage, sent.tag, JSON.stringify(sent.links || []), sent.outcome, sent.changed, sent.answered ?? null, item.rev, sent.at, id);
  audit(actor, "writeback:write", "work_items", id, { stage: sent.stage, tag: sent.tag, comments: sent.said || [], rev: item.rev, confirmed_later: true });
  return "saved";
}
/** An item that is gone from the source (deleted, and Removed here) carries nothing any more: its record is closed. */
const forget = (id: string) => db.prepare("UPDATE work_item_writeback SET tag=NULL, stage=NULL, pending_json=NULL, error=NULL, attempts=0, retry_after=NULL WHERE work_item_id=?").run(id);
const isGone = (e: any, w: any) => e?.status === 404 && w.state === "Removed";

export interface SweepResult { enabled: boolean; in_scope: number; written: number; unchanged: number; failed: number; waiting: number; prefix_in_use?: number; items: { external_id: string; title: string; stage: string | null; tag: { from: string | null; to: string | null } | null; links: string[]; comments: string[]; error?: string }[] }

/** One thing at a time touches the source: a sweep, or the clean-up when write-back is turned off. */
let chain: Promise<unknown> = Promise.resolve();
const exclusive = <T>(fn: () => Promise<T>): Promise<T> => { const p = chain.then(fn); chain = p.catch(() => null); return p; };
/** After this many calls in a row that the source did not answer (or throttled), the rest waits rather than each timing out in turn. */
const UNANSWERED_LIMIT = 3;

/**
 * Bring every item in scope to what it should show. `dry` reports what would be sent and sends nothing (the preview).
 * One sweep runs at a time; a call made meanwhile runs after it. `force` tries again now what an earlier failure put
 * off: a person asked (Save, Try Again Now), and has probably just fixed what was wrong.
 */
export function sweep(opts: { dry?: boolean; actor?: string; as?: Partial<WritebackSettings>; force?: boolean } = {}): Promise<SweepResult> {
  if (opts.dry) return run(true, opts.actor, opts.as);
  return exclusive(() => run(false, opts.actor, {}, !!opts.force));
}
/** `as` previews switches that are not saved yet (dry runs only). */
async function run(dry: boolean, actor = "write-back", as: Partial<WritebackSettings> = {}, force = false): Promise<SweepResult> {
  const s = { ...writebackSettings(), ...(dry ? as : {}) }, base = appBaseUrl(), standing = decisionStandings();
  const out: SweepResult = { enabled: s.enabled, in_scope: 0, written: 0, unchanged: 0, failed: 0, waiting: 0, items: [] };
  if (dry) out.prefix_in_use = prefixInUse(s.tag_prefix);
  if (!s.enabled && !dry) return out;
  const on = dry ? { ...s, enabled: true } : s;
  const describe = (w: any, p: ReturnType<typeof pending>) => ({ external_id: String(w.external_id), title: String(w.title), stage: p.want.stage, tag: p.retags ? { from: p.was?.tag ?? null, to: p.want.tag } : null, links: (p.write.addLinks || []).map((l) => l.url), comments: p.said });
  let silent = 0; // calls in a row that the source did not answer
  for (const w of rowsInScope()) {
    if (w.state !== "Removed") out.in_scope++;
    let p = pending(w, on, standing, base);
    const unsettled: Sent | null = dry ? null : j(p.was?.pending_json, null);
    if (!p.sends && !unsettled) { if (!dry && (p.settles || p.was?.error)) remember(w.id, p, null, false); out.unchanged++; continue; } // nothing left to send: an old failure is over too
    if (dry) { out.items.push(describe(w, p)); out.written++; continue; }
    if (!enabledNow) break; // turned off while this sweep ran: nothing more is written
    if (silent >= UNANSWERED_LIMIT) { out.waiting++; continue; }
    if (!force && p.was?.retry_after && p.was.retry_after > nowIso()) { out.waiting++; continue; } // a write that keeps failing is tried less and less often
    try {
      let read: AdoWorkItemFull | undefined;
      if (unsettled) {
        // an earlier document got no answer: find out what became of it before working out what to send now
        read = await readWorkItem(String(w.external_id));
        if (settle(w.id, unsettled, read, actor) === "wait") { out.waiting++; continue; }
        p = pending(w, on, standing, base);
        if (!p.sends) { remember(w.id, p, null, false); out.unchanged++; continue; }
      }
      const r = await writeToWorkItem(String(w.external_id), p.write, { item: read, sending: (rev) => keep(w.id, rev, p) });
      remember(w.id, p, r.rev, true);
      const item = describe(w, p);
      audit(actor, "writeback:write", "work_items", w.id, { external_id: w.external_id, stage: p.want.stage, tag: item.tag, links: item.links.length, comments: p.said, rev: r.rev });
      out.written++; out.items.push(item); silent = 0;
    } catch (e: any) {
      if (isGone(e, w)) { forget(w.id); out.unchanged++; continue; }
      const error = String(e?.message || e).split("\n")[0].slice(0, 300), attempts = Number(p.was?.attempts || 0) + 1;
      const retry = new Date(Date.now() + Math.min(60, 2 ** attempts) * 60_000).toISOString();
      // a document refused whole saved nothing, so it is not kept; one left unanswered stays kept, for `settle` to work out
      db.prepare(`INSERT INTO work_item_writeback(work_item_id, error, attempts, retry_after) VALUES (?,?,?,?)
        ON CONFLICT(work_item_id) DO UPDATE SET error=excluded.error, attempts=excluded.attempts, retry_after=excluded.retry_after, pending_json=CASE WHEN ? THEN NULL ELSE pending_json END`).run(w.id, error, attempts, retry, e?.sent === "refused" ? 1 : 0);
      if (error !== p.was?.error) audit(actor, "writeback:error", "work_items", w.id, { external_id: w.external_id, error }); // the same failure is audited once, not at every sweep
      out.failed++; out.items.push({ ...describe(w, p), error }); silent = e?.unreachable ? silent + 1 : 0;
    }
  }
  return out;
}

/**
 * Take archigov's stage tags off every item that carries one: stage tags say what is true now, so they do not outlive
 * the feature. Links and comments stay, as history. It waits for a sweep in flight (which stops at its next item once
 * write-back is off), so nothing it removes is put back. An item with a document still unanswered is settled first,
 * so a tag written unseen is found and taken off too; one sent only moments ago is left on record rather than judged
 * early (its save may still be landing), and asking again settles it. A tag that could not be removed stays on
 * record, and asking again tries it again.
 *
 * Two kinds of item are let go instead, since nothing can be done about them from here and they would otherwise keep
 * the clean-up unfinished for ever: one that is no longer in the configured project (nothing is written outside it),
 * and one the source no longer has (404) while it answers for others. When it answers for none, a 404 more likely
 * means the identity can no longer read the backlog, and the records are kept.
 */
export function removeStageTags(actor: string) {
  return exclusive(async () => {
    let removed = 0, failed = 0, silent = 0, answered = 0;
    const missing: string[] = [], away: string[] = [];
    const rows = db.prepare("SELECT wb.*, w.external_id, w.state FROM work_item_writeback wb JOIN work_items w ON w.id=wb.work_item_id WHERE wb.tag IS NOT NULL OR wb.pending_json IS NOT NULL ORDER BY w.external_id").all() as any[];
    for (const r of rows) {
      if (silent >= UNANSWERED_LIMIT) { failed++; continue; } // the source is not answering: the rest stays on record for the next try
      try {
        const item = await readWorkItem(String(r.external_id));
        answered++;
        const sent: Sent | null = j(r.pending_json, null);
        if (sent && settle(r.work_item_id, sent, item, actor) === "wait") { failed++; continue; }
        const tag = stored(r.work_item_id)?.tag as string | null;
        const w = tag ? await writeToWorkItem(String(r.external_id), { removeTags: [tag] }, { item }) : null;
        db.prepare("UPDATE work_item_writeback SET tag=NULL, stage=NULL WHERE work_item_id=?").run(r.work_item_id);
        if (tag || w?.changed) removed++;
        silent = 0;
      } catch (e: any) {
        if (e?.elsewhere) { away.push(r.work_item_id); continue; }
        if (e?.status === 404) { if (r.state === "Removed") forget(r.work_item_id); else missing.push(r.work_item_id); continue; }
        failed++; silent = e?.unreachable ? silent + 1 : 0;
      }
    }
    if (answered) for (const id of missing) forget(id); else failed += missing.length;
    for (const id of away) forget(id);
    const let_go = away.length + (answered ? missing.length : 0);
    audit(actor, "writeback:cleanup", "settings", null, { tags_removed: removed, failed, ...(let_go ? { let_go, moved_out_of_project: away.length } : {}) });
    return { removed, failed, let_go };
  });
}
/** Turned off, nothing is being tried again: failures of the time it was on are over. */
export const forgetFailures = () => { db.prepare("UPDATE work_item_writeback SET error=NULL, attempts=0, retry_after=NULL WHERE error IS NOT NULL OR attempts > 0").run(); };

/** Whether the configured identity may write to the backlog: asked of an item in scope, with nothing saved. One that is gone or in another project cannot say, so the next is asked. */
export async function testWriteAccess() {
  if (!adoConfigured()) return { ok: false as const, error: "Azure DevOps is not connected" };
  const rows = rowsInScope().filter((x) => x.state !== "Removed").slice(0, 5);
  if (!rows.length) return { ok: false as const, error: "No work item in scope to test against: sync the backlog first" };
  let last: { ok: false; checked: string; error: string } | null = null;
  for (const w of rows) {
    const r = await checkWriteAccess(String(w.external_id));
    if (r.ok) return { ok: true as const, checked: String(w.external_id) };
    last = { ok: false, checked: String(w.external_id), error: r.error };
    if (!r.elsewhere) break;
  }
  return last!;
}

/**
 * Work items that carry a tag under the prefix which archigov did not write, as the feed last saw them. They are left
 * alone; the count lets an administrator see, before turning it on or changing the prefix, that the team already uses
 * it and the two would be read together. (One of the stage tags on an item archigov has written to is its own, seen
 * again through the feed.)
 */
function prefixInUse(prefix: string): number {
  const src = adoSource(false);
  if (!src) return 0;
  const hears = writebackSettings().request; // only then is `<prefix>review` the request tag; otherwise it is a tag of the team's like any other
  const low = prefix.toLowerCase(), mine = new Set(stageTags(prefix).map((t) => t.toLowerCase()));
  let n = 0;
  for (const r of db.prepare("SELECT w.tags_json, wb.tag, wb.written_at FROM work_items w LEFT JOIN work_item_writeback wb ON wb.work_item_id=w.id WHERE w.source_id=? AND COALESCE(w.state,'') <> 'Removed'").all(src.id) as any[]) {
    const tags: string[] = j(r.tags_json, []) || [];
    // the request tag is the team's to type, under this prefix by design: it is not a clash
    if (tags.some((t) => { const x = String(t).toLowerCase(); return x.startsWith(low) && !(hears && x === requestTagOf(prefix).toLowerCase()) && x !== String(r.tag || "").toLowerCase() && !(r.written_at && mine.has(x)); })) n++;
  }
  return n;
}

/** Everything the Settings page shows: the switches, whether they can work, and how the last sweeps went. */
export function writebackStatus() {
  const s = writebackSettings(), base = appBaseUrl(), src = adoSource(false);
  const n = (sql: string) => (src ? ((db.prepare(sql).get(src.id) as any).n as number) : 0);
  const last = src ? (db.prepare("SELECT max(wb.written_at) at FROM work_item_writeback wb JOIN work_items w ON w.id=wb.work_item_id WHERE w.source_id=?").get(src.id) as any) : null;
  const lastError = src ? (db.prepare("SELECT wb.error, w.external_id FROM work_item_writeback wb JOIN work_items w ON w.id=wb.work_item_id WHERE w.source_id=? AND wb.error IS NOT NULL ORDER BY wb.retry_after DESC LIMIT 1").get(src.id) as any) : null;
  return {
    ...s, available: adoConfigured(), source: src ? { id: src.id, name: src.name } : null,
    // links (and the link in a comment) need this instance's public address; a tag does not
    base_url: base || null,
    capabilities: CAPABILITIES.map((c) => { const needsAddress = c.id === "link" || c.id === "raise"; // both write a link back to this instance
      return { ...c, enabled: s[c.id], available: needsAddress ? !!base : true, ...(needsAddress && !base ? { unavailable_reason: "Set APP_BASE_URL to this instance's address, so links lead here." } : {}) }; }),
    raised: n("SELECT count(*) n FROM condition_work_items cw JOIN work_items w ON w.id=cw.parent_work_item_id WHERE w.source_id=? AND cw.external_id IS NOT NULL"),
    stages: CHANGE_STAGES.map((st) => ({ id: st.id, label: st.label, explain: st.explain, tag: tagOf(s.tag_prefix, st.id) })),
    in_scope: n("SELECT count(*) n FROM work_items WHERE source_id=? AND COALESCE(state,'') <> 'Removed'"),
    shown: n("SELECT count(*) n FROM work_item_writeback wb JOIN work_items w ON w.id=wb.work_item_id WHERE w.source_id=? AND wb.written_at IS NOT NULL"),
    // a document still unanswered may have left a tag: it counts until it is settled
    tagged: n("SELECT count(*) n FROM work_item_writeback wb JOIN work_items w ON w.id=wb.work_item_id WHERE w.source_id=? AND (wb.tag IS NOT NULL OR wb.pending_json IS NOT NULL)"),
    errors: n("SELECT count(*) n FROM work_item_writeback wb JOIN work_items w ON w.id=wb.work_item_id WHERE w.source_id=? AND wb.error IS NOT NULL"),
    prefix_in_use: prefixInUse(s.tag_prefix),
    // the tag a team puts on a work item to ask for a review, and how many such asks are open
    request_tag: requestTagOf(s.tag_prefix),
    requests_open: s.enabled && s.request ? n("SELECT count(*) n FROM review_requests q JOIN work_items w ON w.id=q.work_item_id WHERE w.source_id=? AND q.answered_at IS NULL AND q.withdrawn_at IS NULL AND COALESCE(w.state,'') NOT IN ('Closed','Resolved','Done','Removed')") : 0,
    last_written_at: last?.at ?? null, last_error: lastError ? { external_id: lastError.external_id, error: lastError.error } : null,
  };
}
export { STAGE_LABEL };

// ---------- when it runs ----------
let timer: ReturnType<typeof setTimeout> | null = null, queued = false;
/**
 * A sweep shortly after something changed: several changes in a row are one sweep, and while one is waiting its turn
 * no other is queued behind it (it reads the records when it starts, so it sees them all). A change that lands once
 * it has started asks for the next.
 */
export function scheduleSweep(delayMs = 1500) {
  if (timer || queued || !(enabledNow ?? writebackSettings().enabled)) return;
  timer = setTimeout(() => {
    timer = null; queued = true;
    exclusive(() => { queued = false; return run(false); }).catch((e) => { queued = false; console.error("write-back sweep failed", e); });
  }, delayMs);
  timer.unref?.();
}
/** Hear every audit row (db.onAudit): whatever changed a stage wrote one. Write-back's own rows are not news to it. */
export function startWriteback() {
  onAudit((row) => { if (!row.action.startsWith("writeback:")) scheduleSweep(); });
}
