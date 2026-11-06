// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The archigov Authors
import { adoConfig, createWorkItem, getWorkItems, wiql, workItemsBatch, ADO_BATCH_MAX, type AdoWorkItemFull, type JsonPatchOp } from "./client.js";
import { readWorkItem, failure, noAnswer } from "./write.js";

/**
 * Making a work item under another in Azure DevOps: how, never what. The caller says what the item is (its type, its
 * title, its description, its tags) and which item it belongs under; this creates it as that item's child, in the
 * same area, with a hyperlink back that only it carries. That hyperlink is how it is found again: before anything is
 * created the parent's children are looked through for it, so asking twice makes one work item, and a request that
 * never got an answer can be settled later by looking.
 *
 * Once made, the work item is the delivery team's. Nothing here changes it again.
 */
export interface RaiseRequest {
  type: string; title: string;
  /** HTML */
  description: string;
  tags?: string[];
  /** the external id of the work item it goes under */
  parent: string;
  /** the address that identifies it (and leads a reader back): no other work item links there */
  marker: { url: string; comment?: string };
}
export interface RaisedWorkItem { id: number; rev: number; type: string | null; title: string | null; state: string | null; changed_at: string | null; url: string; created: boolean }
/** Where else to look for a work item made earlier, when it is no longer under its parent: among those carrying a tag, made since a day. */
export interface WiderSearch { tag: string; since: string }

const PARENT = "System.LinkTypes.Hierarchy-Reverse", CHILD = "System.LinkTypes.Hierarchy-Forward";
/**
 * What identifies a marker: its path and query, without the host. The same work item is still the same one after the
 * instance moved to another address, or when a trailing slash came and went.
 */
export const markerKey = (url: string) => { try { const u = new URL(url); return (u.pathname.replace(/\/+$/, "") + u.search).toLowerCase(); } catch { return String(url).toLowerCase(); } };
/** The page a person opens: the one the service names, else the address its pages have. */
const webUrl = (item: AdoWorkItemFull) => {
  const { org, project } = adoConfig();
  return item._links?.html?.href || `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_workitems/edit/${item.id}`;
};
const describe = (item: AdoWorkItemFull, created: boolean): RaisedWorkItem => ({
  id: item.id, rev: item.rev, type: item.fields?.["System.WorkItemType"] ?? null, title: item.fields?.["System.Title"] ?? null,
  state: item.fields?.["System.State"] ?? null, changed_at: item.fields?.["System.ChangedDate"] ?? null, url: webUrl(item), created,
});
const childIds = (parent: AdoWorkItemFull) => (parent.relations || []).filter((r) => r.rel === CHILD).map((r) => String(r.url).split("/").pop() || "").filter((x) => /^\d+$/.test(x));
const carries = (item: AdoWorkItemFull, key: string) => (item.relations || []).some((r) => r.rel === "Hyperlink" && markerKey(String(r.url)) === key);

/**
 * The work item already made for a marker, if there is one: among the parent's children first, and, when `wider` says
 * where, among the work items of the project carrying a tag and made since a day (the team may have moved it under
 * another parent since). Whatever carries the marker's hyperlink is it.
 */
export async function findRaised(parentExternalId: string, markerUrl: string, parent?: AdoWorkItemFull | null, wider?: WiderSearch): Promise<RaisedWorkItem | null> {
  const key = markerKey(markerUrl);
  try {
    const p = parent === null ? null : parent ?? (await readWorkItem(parentExternalId));
    const kids = p ? childIds(p) : [];
    const under = kids.length ? (await getWorkItems(kids)).find((i) => carries(i, key)) : undefined;
    if (under) return describe(under, false);
    if (!wider) return null;
    // From the day before the request: the service reads a date literal in its own time zone, and a day too early
    // only widens the search. Oldest first, since the one wanted was made at the start of that span.
    const t = Date.parse(wider.since), day = Number.isNaN(t) ? null : new Date(t - 24 * 3600 * 1000).toISOString().slice(0, 10);
    let found: Awaited<ReturnType<typeof wiql>>;
    try { found = await wiql(`SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.Tags] CONTAINS '${wider.tag.replace(/'/g, "''")}'${day ? ` AND [System.CreatedDate] >= '${day}'` : ""} ORDER BY [System.Id]`); }
    catch (e: any) { if (e?.status >= 400 && e.status < 500 && e.status !== 429) return null; throw e; } // the service would not run the query: the search under the parent stands, and nothing hangs on this one
    const ids = found.workItems.map((w) => w.id).filter((id) => !kids.includes(String(id))).slice(0, ADO_BATCH_MAX);
    const elsewhere = ids.length ? (await getWorkItems(ids)).find((i) => carries(i, key)) : undefined;
    return elsewhere ? describe(elsewhere, false) : null;
  } catch (e: any) { throw e?.sent ? e : failure(e, "nothing"); }
}

/** The document that makes it: its fields, its place under the parent, and the hyperlink back. */
export function buildRaise(req: RaiseRequest, parent: Pick<AdoWorkItemFull, "url" | "fields">): JsonPatchOp[] {
  const ops: JsonPatchOp[] = [
    { op: "add", path: "/fields/System.Title", value: req.title.slice(0, 255) },
    { op: "add", path: "/fields/System.Description", value: req.description },
  ];
  // the same area as the item it belongs under, so it lands on the backlog of the team that has that item
  if (parent.fields?.["System.AreaPath"]) ops.push({ op: "add", path: "/fields/System.AreaPath", value: parent.fields["System.AreaPath"] });
  if (req.tags?.length) ops.push({ op: "add", path: "/fields/System.Tags", value: req.tags.join("; ") });
  ops.push({ op: "add", path: "/relations/-", value: { rel: PARENT, url: parent.url, attributes: { comment: "Raised from archigov" } } });
  ops.push({ op: "add", path: "/relations/-", value: { rel: "Hyperlink", url: req.marker.url, attributes: req.marker.comment ? { comment: req.marker.comment } : {} } });
  return ops;
}

/**
 * Make the work item, once. If one carrying the marker is already there (under the parent, or where `wider` looks),
 * that one is returned and nothing is created. The create is sent once: with no answer it is not sent again here
 * (`sent: "unanswered"` on the error), because it may have been made; the caller, told just before it went
 * (`sending`), asks again later and this finds it.
 */
export async function raiseWorkItem(req: RaiseRequest, opts: { sending?: () => void; wider?: WiderSearch } = {}): Promise<RaisedWorkItem> {
  const parent = await readWorkItem(req.parent);
  if (!parent.url) throw failure(Object.assign(new Error(`work item ${req.parent} has no address to link a child to`), { refused: true }), "nothing");
  const there = await findRaised(req.parent, req.marker.url, parent, opts.wider);
  if (there) return there;
  opts.sending?.();
  try { return describe(await createWorkItem(req.type, buildRaise(req, parent)), true); }
  catch (e: any) { throw failure(e, noAnswer(e) ? "unanswered" : "refused"); }
}

/** Whether the configured identity may create a work item of this type under this parent, found out without creating one (validateOnly). */
export async function checkCreateAccess(type: string, parentExternalId: string): Promise<{ ok: true } | { ok: false; error: string; elsewhere: boolean }> {
  try {
    const parent = await readWorkItem(parentExternalId);
    await createWorkItem(type, buildRaise({ type, title: "archigov: checking that a work item can be created (nothing is saved)", description: "", parent: parentExternalId, marker: { url: "https://archigov.invalid/check" } }, parent), { validateOnly: true });
    return { ok: true };
  } catch (e: any) { return { ok: false, error: String(e?.message || e).split("\n")[0].slice(0, 300), elsewhere: !!e?.elsewhere || (e?.status === 404 && e?.sent === "nothing") }; }
}

/**
 * What the source says now of work items made earlier: their state and revision. One the source does not return is
 * not in the answer (whether it leaves it out or answers null in its place): that alone does not say it is gone, since
 * an identity that lost its access gets the same.
 */
export async function raisedStates(ids: (number | string)[]): Promise<Map<string, { rev: number; state: string | null; title: string | null; type: string | null; changed_at: string | null }>> {
  const out = new Map<string, { rev: number; state: string | null; title: string | null; type: string | null; changed_at: string | null }>();
  const items = await workItemsBatch(ids.map(Number), ["System.Id", "System.State", "System.Title", "System.WorkItemType", "System.ChangedDate"]);
  for (const i of items) if (i && i.id != null) out.set(String(i.id), { rev: i.rev, state: i.fields?.["System.State"] ?? null, title: i.fields?.["System.Title"] ?? null, type: i.fields?.["System.WorkItemType"] ?? null, changed_at: i.fields?.["System.ChangedDate"] ?? null });
  return out;
}
