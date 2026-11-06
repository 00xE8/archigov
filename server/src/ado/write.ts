// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The archigov Authors
import { adoConfig, getWorkItem, patchWorkItem, type AdoWorkItemFull, type JsonPatchOp } from "./client.js";

/**
 * Writing back onto an Azure DevOps work item: how, never what. The caller says which tags to put on and take off,
 * which hyperlinks to add and which comment to leave; this turns that into one JSON Patch document against the item as
 * it stands now, so a write is one revision and one notification at most. It never touches the state, the assignee,
 * the title or the description of an item: those are the delivery team's. It writes only inside the configured project.
 */
export interface WorkItemWrite {
  addTags?: string[]; removeTags?: string[];
  /** hyperlinks to add unless a link to the same address is already there */
  addLinks?: { url: string; comment?: string }[];
  /** one discussion comment (HTML), or none */
  comment?: string | null;
}
export interface WriteResult { rev: number; changed: boolean; tags: string[]; added_tags: string[]; removed_tags: string[]; added_links: string[]; commented: boolean }
export interface WriteOptions {
  /** The item, when the caller has just read it (readWorkItem): it is not read a second time. */
  item?: AdoWorkItemFull;
  /** Told the item's revision just before each document is sent, so the caller can keep what it is sending in case no answer comes. */
  sending?: (rev: number) => void;
}
/**
 * What a failed write leaves behind, on the error it throws: `sent` is "nothing" (the item could not even be read),
 * "refused" (a document was sent and turned down whole: nothing was saved) or "unanswered" (a document was sent and
 * may have been saved); `unreachable` says the service did not answer or is throttling, as against refusing this item.
 */
export type WriteFailure = Error & { sent: "nothing" | "refused" | "unanswered"; unreachable: boolean; status?: number; elsewhere?: boolean };

export const splitTags = (v: unknown) => String(v ?? "").split(";").map((t) => t.trim()).filter(Boolean);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase(); // tags and addresses compare without case, as the service does for tags

/** The document for one write against the item as it stands. `ops` is empty when the item already shows everything asked. */
export function buildPatch(item: Pick<AdoWorkItemFull, "rev" | "fields" | "relations">, w: WorkItemWrite) {
  const before = splitTags(item.fields?.["System.Tags"]);
  const removed = before.filter((t) => (w.removeTags || []).some((r) => same(r, t)) && !(w.addTags || []).some((a) => same(a, t)));
  let tags = before.filter((t) => !removed.includes(t));
  const added = (w.addTags || []).filter((t) => !tags.some((x) => same(x, t)));
  tags = [...tags, ...added];
  const have = (item.relations || []).filter((r) => r.rel === "Hyperlink").map((r) => r.url);
  const links = (w.addLinks || []).filter((l, i, all) => !have.some((u) => same(u, l.url)) && all.findIndex((x) => same(x.url, l.url)) === i);
  const ops: JsonPatchOp[] = [];
  // On System.Tags the service MERGES on `add` (the reference's "Add a tag": Tag0 + "Tag1; Tag2" → "Tag0; Tag1; Tag2")
  // and sets the whole list on `replace` ("Update a tag"). Taking a tag off is therefore always a `replace` with the
  // complete list that should remain; an empty string empties the field, as the reference empties a field elsewhere.
  if (added.length || removed.length) ops.push({ op: before.length ? "replace" : "add", path: "/fields/System.Tags", value: tags.join("; ") });
  for (const l of links) ops.push({ op: "add", path: "/relations/-", value: { rel: "Hyperlink", url: l.url, attributes: l.comment ? { comment: l.comment } : {} } });
  if (w.comment) ops.push({ op: "add", path: "/fields/System.History", value: w.comment });
  // the revision is tested first: a document built against a stale item is refused whole, never half applied
  return { ops: ops.length ? [{ op: "test", path: "/rev", value: item.rev } as JsonPatchOp, ...ops] : [], tags, added_tags: added, removed_tags: removed, added_links: links.map((l) => l.url), commented: !!w.comment };
}

/** A refusal that means "the item moved under you": nothing was saved, and it is worth one more try against the item as it now stands. */
const stale = (e: any) => [409, 412].includes(e?.status) || (e?.status === 400 && /TF26071|\/rev|test operation/i.test(String(e?.message)));
/** A failure that is no answer at all: the network, or a server error. After a write, it does not say whether the change was saved. */
export const noAnswer = (e: any) => !e?.refused && (e?.status === undefined || e.status >= 500);
export const failure = (e: any, sent: WriteFailure["sent"]): WriteFailure => Object.assign(e instanceof Error ? e : new Error(String(e)), { sent, unreachable: noAnswer(e) || e?.status === 429 });

/**
 * Only the configured project is written to, whatever the backlog query reaches. An item says which project it is in
 * by name, so the check holds when ADO_PROJECT is the project's name; given as an ID there is nothing to compare, and
 * where the identity may write is left to its permissions in Azure DevOps.
 */
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function inProject(item: AdoWorkItemFull): AdoWorkItemFull {
  const want = adoConfig().project, got = item.fields?.["System.TeamProject"];
  if (want && got && !GUID.test(want) && !same(String(got), want)) throw Object.assign(new Error(`work item ${item.id} belongs to the project ${got}: write-back writes only inside ${want}`), { refused: true, elsewhere: true });
  return item;
}

/** One work item as it stands, if it is one write-back may touch. */
export async function readWorkItem(externalId: string): Promise<AdoWorkItemFull> {
  try { return inProject(await getWorkItem(externalId)); } catch (e) { throw failure(e, "nothing"); }
}

/** Whether the item shows the tags and links a write asks for. Null when the write asks for neither: a comment leaves no trace to look for. */
export function showsWrite(item: Pick<AdoWorkItemFull, "rev" | "fields" | "relations">, w: WorkItemWrite): boolean | null {
  if (!(w.addTags?.length || w.removeTags?.length || w.addLinks?.length)) return null;
  return buildPatch(item, { ...w, comment: null }).ops.length === 0;
}

/**
 * Bring one work item to what is asked. Followers are told only when a comment is left: a tag or a link alone is
 * not news. Returns what actually changed, which may be nothing.
 *
 * A document is sent once. Refused because the item moved (a stale revision), it is rebuilt against the item as it
 * now stands and sent once more: nothing of the first was saved. Left without an answer, it is NOT sent again here:
 * it may have been saved, and a comment sent twice is two notifications. The error says so (`sent: "unanswered"`), and
 * the caller, who was told what was being sent, finds out later what became of it.
 */
export async function writeToWorkItem(externalId: string, w: WorkItemWrite, opts: WriteOptions = {}): Promise<WriteResult> {
  let item = opts.item ?? (await readWorkItem(externalId));
  for (let attempt = 1; ; attempt++) {
    const p = buildPatch(item, w);
    if (!p.ops.length) return { rev: item.rev, changed: false, tags: p.tags, added_tags: [], removed_tags: [], added_links: [], commented: false };
    opts.sending?.(item.rev);
    try {
      const after = await patchWorkItem(externalId, p.ops, { suppressNotifications: !p.commented });
      return { rev: after.rev, changed: true, tags: p.tags, added_tags: p.added_tags, removed_tags: p.removed_tags, added_links: p.added_links, commented: p.commented };
    } catch (e: any) {
      if (attempt < 2 && stale(e)) { try { item = inProject(await getWorkItem(externalId)); } catch { throw failure(e, "refused"); } continue; }
      throw failure(e, noAnswer(e) ? "unanswered" : "refused");
    }
  }
}

/** Whether the configured identity may change this work item, found out without changing it (validateOnly). `elsewhere`: this item cannot say (not there, or another project's); ask another. */
export async function checkWriteAccess(externalId: string): Promise<{ ok: true; rev: number } | { ok: false; error: string; elsewhere: boolean }> {
  try {
    const item = inProject(await getWorkItem(externalId));
    await patchWorkItem(externalId, [{ op: "test", path: "/rev", value: item.rev }, { op: "add", path: "/fields/System.History", value: "archigov: checking write access (nothing is saved)" }], { validateOnly: true });
    return { ok: true, rev: item.rev };
  } catch (e: any) { return { ok: false, error: String(e?.message || e).split("\n")[0].slice(0, 300), elsewhere: !!e?.elsewhere || e?.status === 404 }; }
}
