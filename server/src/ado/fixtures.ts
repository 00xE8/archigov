// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The archigov Authors
import { DEMO_WORK_ITEMS } from "../collectors/demo.js";

/**
 * Recorded-shape Azure DevOps responses for fixture mode. They carry the demo tenant's work item ids with ADO's
 * real field names, so a fixture backfill updates the demo backlog through the real mapping code: epic 1042's
 * description has changed since its design was approved, so exactly one material change surfaces.
 */
const ORG = "sehealth", PROJECT = "Clinical-Platform";
const CHANGED = new Date(Date.now() - 3600 * 1000).toISOString();
const url = (id: number | string) => `https://dev.azure.com/${ORG}/_apis/wit/workItems/${id}`;

/** What ADO returns for the backlog WIQL; and, for a query on a tag, the work items made here that carry it. */
function wiql(query: string) {
  const tag = /\[System\.Tags\]\s+CONTAINS\s+'((?:[^']|'')*)'/i.exec(query)?.[1]?.replace(/''/g, "'");
  if (tag) {
    if (fixtureState.unreachable) throw new Error("fetch failed");
    const has = (v: unknown) => String(v ?? "").split(";").map((t) => t.trim().toLowerCase()).includes(tag.toLowerCase());
    return { queryType: "flat", queryResultType: "workItem", asOf: CHANGED, columns: [], workItems: [...CREATED.values()].filter((i) => has(i.fields["System.Tags"]) && !fixtureState.gone.includes(String(i.id))).map((i) => ({ id: i.id, url: i.url })) };
  }
  return { queryType: "flat", queryResultType: "workItem", asOf: CHANGED, columns: [{ referenceName: "System.Id", name: "ID", url: `https://dev.azure.com/${ORG}/_apis/wit/fields/System.Id` }],
    workItems: DEMO_WORK_ITEMS.filter((w) => !/Removed/.test(query) || w.state !== "Removed").map((w) => ({ id: Number(w.external_id), url: url(w.external_id) })) };
}

const DESCRIPTION_OVERRIDES: Record<string, string> = {
  // 1042 was approved as "managed document service with retention and audit"; the team has since added an export requirement
  "1042": "<div>Move referral attachments from storage account to a managed document service with retention and audit. Must support 10-year retention, eDiscovery <b>and bulk export to the national record</b>.</div>",
};

/**
 * What has been written back onto the fixture items in this process: the project standing in for Azure DevOps has to
 * remember a tag, a link and a comment the way the real one does, so the write path runs end to end offline. A written
 * item's revision starts above the recorded hook sample's, since in the real service every change is a later revision.
 */
interface Written { rev: number; tags: string | null; relations: { rel: string; url: string; attributes?: Record<string, any> }[]; history: string[] }
const WRITTEN = new Map<string, Written>();
const FIRST_WRITTEN_REV = 20;
const baseRev = (externalId: string) => (externalId === "1042" ? 7 : 3);

export function fixtureWorkItem(externalId: string) {
  const w = DEMO_WORK_ITEMS.find((x) => x.external_id === externalId);
  if (!w) return null;
  const written = WRITTEN.get(externalId);
  return {
    id: Number(w.external_id), rev: written ? written.rev : baseRev(externalId),
    fields: {
      "System.Id": Number(w.external_id), "System.TeamProject": PROJECT, "System.Title": w.title, "System.WorkItemType": w.type, "System.State": w.state,
      "System.Tags": written?.tags ?? w.tags.join("; "), "System.Description": DESCRIPTION_OVERRIDES[w.external_id] ?? `<div>${w.description}</div>`,
      "System.ChangedDate": CHANGED, "System.CreatedDate": "2026-09-01T09:00:00Z", "System.AreaPath": `${PROJECT}\\${w.area}`, "System.IterationPath": `${PROJECT}\\Q4`,
      "Microsoft.VSTS.Common.Priority": 2, ...(w.app ? { "Custom.Application": w.app } : {}),
    },
    url: url(w.external_id),
  };
}

/**
 * Work items made in this process (a condition raised as a work item): the project standing in for Azure DevOps keeps
 * them the way the real one does, with their fields, their links and the web address a person opens.
 */
interface Created { id: number; rev: number; fields: Record<string, any>; relations: { rel: string; url: string; attributes?: Record<string, any> }[]; url: string; _links: { html: { href: string } } }
const CREATED = new Map<string, Created>();
let nextCreatedId = 9001;
/** The types this pretend project has (the Agile process, as the demo backlog uses Epics and Features). */
const TYPES = ["Epic", "Feature", "User Story", "Task", "Issue", "Bug"];

function batch(ids: number[]) {
  // errorPolicy "omit": an item that is gone is simply not in the answer
  const value = ids.filter((i) => !fixtureState.gone.includes(String(i))).map((i) => CREATED.get(String(i)) ?? fixtureWorkItem(String(i))).filter(Boolean);
  return { count: value.length, value };
}

/** A workitem.updated service-hook payload (resourceVersion 1.0 shape, as documented) for epic 1042 at a later revision. */
export const HOOK_SAMPLE = {
  id: "a0a0a0a0-bbbb-cccc-dddd-e1e1e1e1e1e1", eventType: "workitem.updated", publisherId: "tfs", scope: "all",
  message: { text: "Epic #1042 (Replace referral attachments store with managed document service) updated by m.hughes." },
  resource: {
    id: 1042, rev: 8,
    fields: {
      "System.AreaPath": `${PROJECT}\\Integration`, "System.TeamProject": PROJECT, "System.IterationPath": `${PROJECT}\\Q4`, "System.WorkItemType": "Epic", "System.State": "Active",
      "System.ChangedDate": CHANGED, "System.ChangedBy": "m.hughes", "System.Title": "Replace referral attachments store with managed document service",
      "System.Description": "<div>Move referral attachments to a managed document service with retention, audit, eDiscovery, bulk export <b>and a 30-day legal hold</b>.</div>",
      "System.Tags": "architecture-needed; data",
    },
    url: url(1042),
  },
  resourceVersion: "1.0", resourceContainers: { collection: { id: "b1b1b1b1-cccc-dddd-eeee-f2f2f2f2f2f2" }, project: { id: "00aa00aa-bb11-cc22-dd33-44ee44ee44ee" } },
  createdDate: CHANGED,
};

/** GET one work item with its relations. */
function get(externalId: string) {
  if (fixtureState.unreachable) throw new Error("fetch failed"); // a network failure carries no HTTP status
  if (fixtureState.throttled) throw Object.assign(new Error("Azure DevOps 429: too many requests"), { status: 429 });
  if (fixtureState.gone.includes(externalId)) throw Object.assign(new Error(`Azure DevOps 404: TF401232: work item ${externalId} does not exist, or you do not have permissions to read it`), { status: 404 });
  const made = CREATED.get(externalId);
  if (made) return { ...made, fields: { ...made.fields }, relations: [...made.relations] };
  const item = fixtureWorkItem(externalId);
  if (!item) throw Object.assign(new Error(`Azure DevOps 404: work item ${externalId} does not exist`), { status: 404 });
  return { ...item, relations: [...(WRITTEN.get(externalId)?.relations || [])] };
}
/** GET several work items with their relations; one that is gone is left out (errorPolicy "omit"). */
function list(ids: string[]) {
  if (fixtureState.unreachable) throw new Error("fetch failed");
  if (fixtureState.throttled) throw Object.assign(new Error("Azure DevOps 429: too many requests"), { status: 429 });
  return ids.flatMap((id) => { try { return [get(id)]; } catch (e: any) { if (e?.status === 404) return []; throw e; } });
}

/**
 * POST a new work item of a type, from a JSON Patch document of `add` operations, as the service does: the type must
 * exist in the project, a title is required, `validateOnly` checks and makes nothing. A link to a parent
 * (System.LinkTypes.Hierarchy-Reverse) shows on the parent as the forward link and is a new revision of it too. The
 * test switches of `update` apply here as well.
 */
function create(type: string, ops: { op: string; path: string; value?: any }[], opts: { validateOnly?: boolean } = {}) {
  if (fixtureState.unreachable) throw new Error("fetch failed");
  if (fixtureState.throttled) throw Object.assign(new Error("Azure DevOps 429: too many requests"), { status: 429 });
  if (fixtureState.denyWrites) throw Object.assign(new Error("Azure DevOps 403: not authorised — check the PAT / Entra identity and its access level"), { status: 403 });
  const known = TYPES.find((t) => t.toLowerCase() === type.toLowerCase());
  if (!known) throw Object.assign(new Error(`Azure DevOps 404: VS402323: Work item type ${type} does not exist in project ${PROJECT}, or you do not have permission to access it.`), { status: 404 });
  const id = opts.validateOnly ? 0 : nextCreatedId++, now = new Date().toISOString();
  const item: Created = { id, rev: 1, url: url(id), _links: { html: { href: `https://dev.azure.com/${ORG}/${encodeURIComponent(PROJECT)}/_workitems/edit/${id}` } }, relations: [],
    fields: { "System.Id": id, "System.TeamProject": PROJECT, "System.WorkItemType": known, "System.State": "New", "System.AreaPath": PROJECT, "System.IterationPath": PROJECT, "System.CreatedDate": now, "System.ChangedDate": now } };
  for (const o of ops) {
    if (o.op !== "add") throw Object.assign(new Error(`Azure DevOps 400: unsupported operation ${o.op} ${o.path}`), { status: 400 });
    if (o.path === "/relations/-") item.relations.push({ rel: o.value.rel, url: o.value.url, attributes: { ...(o.value.attributes || {}) } });
    else if (o.path.startsWith("/fields/")) item.fields[o.path.slice("/fields/".length)] = o.value;
    else throw Object.assign(new Error(`Azure DevOps 400: unsupported operation ${o.op} ${o.path}`), { status: 400 });
  }
  if (!String(item.fields["System.Title"] ?? "").trim()) throw Object.assign(new Error("Azure DevOps 400: TF401320: Rule Error for field Title. Error code: Required, InvalidEmpty."), { status: 400 });
  const parents = item.relations.filter((r) => r.rel === "System.LinkTypes.Hierarchy-Reverse").map((r) => r.url.split("/").pop() as string);
  for (const p of parents) get(p); // a parent that does not exist refuses the whole document
  if (opts.validateOnly) return item;
  if (fixtureState.failWrites > 0) { fixtureState.failWrites--; throw Object.assign(new Error("Azure DevOps 503: the service is temporarily unavailable"), { status: 503 }); }
  const save = () => {
    CREATED.set(String(id), item);
    for (const p of parents) { // the same link, seen from the parent: a new revision of it
      const parent = get(p), was = WRITTEN.get(p);
      WRITTEN.set(p, { rev: Math.max(parent.rev + 1, FIRST_WRITTEN_REV), tags: String(parent.fields["System.Tags"] ?? ""), relations: [...parent.relations, { rel: "System.LinkTypes.Hierarchy-Forward", url: url(id), attributes: {} }], history: [...(was?.history || [])] });
    }
  };
  if (fixtureState.loseAnswers > 0) {
    fixtureState.loseAnswers--;
    if (fixtureState.saveLateMs) setTimeout(save, fixtureState.saveLateMs); else save();
    if (fixtureState.thenUnreachable) fixtureState.unreachable = true;
    throw Object.assign(new Error("Azure DevOps 503: the service is temporarily unavailable"), { status: 503 });
  }
  save();
  return get(String(id));
}
/** For tests: the team moves a made work item on (a new revision in a new state). */
function setState(externalId: string, state: string) {
  const item = CREATED.get(externalId);
  if (!item) throw new Error(`fixture: work item ${externalId} was not made here`);
  item.rev += 1; item.fields["System.State"] = state; item.fields["System.ChangedDate"] = new Date().toISOString();
}
const created = () => [...CREATED.values()];
/** For tests: the team moves a made work item under another parent (its hyperlinks go with it). */
function reparent(externalId: string, toParent: string) {
  const item = CREATED.get(externalId);
  if (!item) throw new Error(`fixture: work item ${externalId} was not made here`);
  const drop = (p: string) => { const w = WRITTEN.get(p); if (w) w.relations = w.relations.filter((r) => !(r.rel === "System.LinkTypes.Hierarchy-Forward" && r.url.endsWith(`/${externalId}`))); };
  for (const r of item.relations.filter((x) => x.rel === "System.LinkTypes.Hierarchy-Reverse")) drop(r.url.split("/").pop() as string);
  const parent = get(toParent), was = WRITTEN.get(toParent);
  WRITTEN.set(toParent, { rev: Math.max(parent.rev + 1, FIRST_WRITTEN_REV), tags: String(parent.fields["System.Tags"] ?? ""), relations: [...parent.relations, { rel: "System.LinkTypes.Hierarchy-Forward", url: url(externalId), attributes: {} }], history: [...(was?.history || [])] });
  item.relations = [...item.relations.filter((x) => x.rel !== "System.LinkTypes.Hierarchy-Reverse"), { rel: "System.LinkTypes.Hierarchy-Reverse", url: url(toParent), attributes: {} }];
  item.rev += 1;
}

/**
 * PATCH one work item with a JSON Patch document, as the service does: a failed `test` of the revision refuses the
 * whole document, `validateOnly` checks it and saves nothing, anything saved is a new revision. Tags follow the
 * reference's own examples: `add` MERGES the given tags into those already there ("Add a tag": Tag0 + "Tag1; Tag2" →
 * "Tag0; Tag1; Tag2"), `replace` sets the whole list ("Update a tag"), and nothing documents `remove` on a field, so
 * it is refused here. For tests: `denyWrites` fails every write the way an identity without write access does,
 * `loseAnswers` saves the next n writes and then fails as a server error would (the answer never arrives; with
 * `thenUnreachable` the service is gone from that moment, with `saveLateMs` the save itself lands that much after
 * the error), `failWrites` fails the next n writes as a server error with nothing saved, `unreachable` fails every call as a network error, `throttled` as a 429, `gone` lists items that
 * were deleted (404), `latencyMs` makes a write take that long (client.ts waits).
 */
const fixtureState = { denyWrites: false, loseAnswers: 0, thenUnreachable: false, saveLateMs: 0, failWrites: 0, unreachable: false, throttled: false, gone: [] as string[], latencyMs: 0 };
const mergeTags = (have: string, add: string) => {
  const split = (v: string) => v.split(";").map((t) => t.trim()).filter(Boolean);
  const out = split(have);
  for (const t of split(add)) if (!out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  return out.join("; ");
};
function update(externalId: string, ops: { op: string; path: string; value?: any }[], opts: { validateOnly?: boolean } = {}) {
  const item = get(externalId);
  if (fixtureState.denyWrites) throw Object.assign(new Error("Azure DevOps 403: not authorised — check the PAT / Entra identity and its access level"), { status: 403 });
  const next: Written = { rev: item.rev, tags: String(item.fields["System.Tags"] ?? ""), relations: item.relations, history: [...(WRITTEN.get(externalId)?.history || [])] };
  for (const o of ops) {
    if (o.op === "test" && o.path === "/rev") { if (Number(o.value) !== item.rev) throw Object.assign(new Error(`Azure DevOps 412: TF26071: this work item has been changed by someone else since you opened it (rev ${item.rev}, expected ${o.value})`), { status: 412 }); }
    else if (o.op === "add" && o.path === "/fields/System.Tags") next.tags = mergeTags(next.tags ?? "", String(o.value ?? ""));
    else if (o.op === "replace" && o.path === "/fields/System.Tags") next.tags = String(o.value ?? "");
    else if (o.op === "add" && o.path === "/fields/System.History") next.history.push(String(o.value ?? ""));
    else if (o.op === "add" && o.path === "/relations/-") next.relations.push({ rel: o.value.rel, url: o.value.url, attributes: { ...(o.value.attributes || {}) } });
    else if (o.op === "remove" && /^\/relations\/\d+$/.test(o.path)) next.relations.splice(Number(o.path.split("/")[2]), 1);
    else throw Object.assign(new Error(`Azure DevOps 400: unsupported operation ${o.op} ${o.path}`), { status: 400 });
  }
  if (opts.validateOnly) return item;
  next.rev = Math.max(item.rev + 1, FIRST_WRITTEN_REV);
  if (fixtureState.failWrites > 0) { fixtureState.failWrites--; throw Object.assign(new Error("Azure DevOps 503: the service is temporarily unavailable"), { status: 503 }); }
  if (fixtureState.loseAnswers > 0) {
    fixtureState.loseAnswers--;
    if (fixtureState.saveLateMs) setTimeout(() => WRITTEN.set(externalId, next), fixtureState.saveLateMs); else WRITTEN.set(externalId, next);
    if (fixtureState.thenUnreachable) fixtureState.unreachable = true;
    throw Object.assign(new Error("Azure DevOps 503: the service is temporarily unavailable"), { status: 503 });
  }
  WRITTEN.set(externalId, next);
  return get(externalId);
}
/** For tests: somebody else edits the item at the source (a new revision, optionally with other tags). */
function touch(externalId: string, tags?: string) {
  const item = get(externalId), was = WRITTEN.get(externalId);
  WRITTEN.set(externalId, { rev: Math.max(item.rev + 1, FIRST_WRITTEN_REV), tags: tags ?? String(item.fields["System.Tags"] ?? ""), relations: item.relations, history: [...(was?.history || [])] });
}
/** For tests: what was written to an item, and a clean slate. */
const written = (externalId: string) => WRITTEN.get(externalId) ?? null;
const reset = () => { WRITTEN.clear(); CREATED.clear(); Object.assign(fixtureState, { denyWrites: false, loseAnswers: 0, thenUnreachable: false, saveLateMs: 0, failWrites: 0, unreachable: false, throttled: false, gone: [], latencyMs: 0 }); };

export const ADO_FIXTURES = { org: ORG, project: PROJECT, wiql, batch, get, list, update, create, touch, setState, reparent, written, created, reset, state: fixtureState, hookSample: HOOK_SAMPLE };
