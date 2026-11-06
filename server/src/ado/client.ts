// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The archigov Authors
import { fixturesEnabled, sleep } from "../azure/client.js";
import { ADO_FIXTURES } from "./fixtures.js";

/**
 * Azure DevOps REST 7.1 client for the work-item feed, and for writing back onto a work item when an administrator
 * has turned that on (write.ts builds the document; the core decides what it says).
 *   WIQL:  POST https://dev.azure.com/{org}/{project}/_apis/wit/wiql?api-version=7.1   body { query } → { workItems: [{ id, url }] }
 *          https://learn.microsoft.com/rest/api/azure/devops/wit/wiql/query-by-wiql?view=azure-devops-rest-7.1
 *   Batch: POST https://dev.azure.com/{org}/_apis/wit/workitemsbatch?api-version=7.1   body { ids (≤200), fields } → { count, value: [{ id, rev, fields, url }] }
 *          https://learn.microsoft.com/rest/api/azure/devops/wit/work-items/get-work-items-batch?view=azure-devops-rest-7.1
 *   Get:   GET https://dev.azure.com/{org}/{project}/_apis/wit/workitems/{id}?$expand=relations&api-version=7.1 → { id, rev, fields, relations: [{ rel, url, attributes }] }
 *          https://learn.microsoft.com/rest/api/azure/devops/wit/work-items/get-work-item?view=azure-devops-rest-7.1
 *   Patch: PATCH https://dev.azure.com/{org}/{project}/_apis/wit/workitems/{id}?api-version=7.1   body a JSON Patch document, media type
 *          application/json-patch+json; validateOnly=true checks without saving, suppressNotifications=true tells no follower.
 *          Needs vso.work_write, where everything above needs vso.work.
 *          https://learn.microsoft.com/rest/api/azure/devops/wit/work-items/update?view=azure-devops-rest-7.1
 *   Create: POST https://dev.azure.com/{org}/{project}/_apis/wit/workitems/${type}?api-version=7.1   body a JSON Patch document of
 *          `add` operations (fields, relations); the same validateOnly / suppressNotifications; needs vso.work_write.
 *          https://learn.microsoft.com/rest/api/azure/devops/wit/work-items/create?view=azure-devops-rest-7.1
 *   List:  GET https://dev.azure.com/{org}/{project}/_apis/wit/workitems?ids=1,2&$expand=relations&errorPolicy=omit&api-version=7.1
 *          → { count, value: [...] }, at most 200 ids; with errorPolicy=omit an item that is gone is left out.
 *          https://learn.microsoft.com/rest/api/azure/devops/wit/work-items/list?view=azure-devops-rest-7.1
 * Auth: a PAT as HTTP basic (empty user, PAT as password), or a Microsoft Entra token for the Azure DevOps resource
 *   (scope https://app.vssps.visualstudio.com/.default — the resource id form 499b84ac-1321-427f-aa17-267ca6975798/.default
 *   is the same audience) via DefaultAzureCredential.
 *   https://learn.microsoft.com/azure/devops/integrate/get-started/authentication/service-principal-managed-identity
 */
export const ADO_API_VERSION = "7.1";
export const ADO_SCOPE = "https://app.vssps.visualstudio.com/.default";
export const ADO_BATCH_MAX = 200;
export const ADO_FIELDS = ["System.Id", "System.Title", "System.WorkItemType", "System.State", "System.Tags", "System.Description", "System.ChangedDate", "System.CreatedDate",
  "System.AreaPath", "System.IterationPath", "Microsoft.VSTS.Common.Priority"];
/** Default backlog scope: the items an architecture board cares about, not every task. */
export const DEFAULT_WIQL = "SELECT [System.Id] FROM WorkItems WHERE [System.WorkItemType] IN ('Epic','Feature') AND [System.State] <> 'Removed' AND [System.ChangedDate] >= @Today - 365 ORDER BY [System.ChangedDate] DESC";

export const adoConfig = () => ({
  org: process.env.ADO_ORG || (fixturesEnabled() ? "sehealth" : ""),
  project: process.env.ADO_PROJECT || (fixturesEnabled() ? "Clinical-Platform" : ""),
  wiql: process.env.ADO_WIQL || DEFAULT_WIQL,
  hookSecretConfigured: !!process.env.ADO_HOOK_SECRET,
});
export const adoEnvConfigured = () => !!(process.env.ADO_ORG && process.env.ADO_PROJECT && (process.env.ADO_PAT || process.env.AZURE_TENANT_ID || process.env.AZURE_CLIENT_ID));
export const adoConfigured = () => fixturesEnabled() || adoEnvConfigured();

async function authHeader(): Promise<string> {
  if (process.env.ADO_PAT) return `Basic ${Buffer.from(`:${process.env.ADO_PAT}`).toString("base64")}`;
  const { DefaultAzureCredential } = await import("@azure/identity");
  const t = await new DefaultAzureCredential().getToken(ADO_SCOPE);
  if (!t) throw new Error("Could not acquire an Azure DevOps token (set ADO_PAT, or AZURE_* for an Entra identity added to the organisation)");
  return `Bearer ${t.token}`;
}

/** `retryServerErrors: false` is for a write: a 5xx may have been answered after the change was saved, so sending it again is the caller's call (a 429 was refused before anything happened, and is always retried). */
async function adoFetch(url: string, init: RequestInit = {}, maxAttempts = 4, retryServerErrors = true): Promise<any> {
  const auth = await authHeader();
  let last: Response | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url, { ...init, headers: { Authorization: auth, "Content-Type": "application/json", Accept: "application/json", ...(init.headers as any || {}) } });
    if (res.status === 429 || res.status >= 500) { last = res; if (attempt < maxAttempts && (res.status === 429 || retryServerErrors)) { await sleep((Number(res.headers.get("Retry-After") || 2 ** attempt) * 1000)); continue; } break; }
    if (res.status === 203 || res.status === 401 || res.status === 403) throw Object.assign(new Error(`Azure DevOps ${res.status}: not authorised — check the PAT / Entra identity and its access level`), { status: res.status });
    if (!res.ok) throw Object.assign(new Error(`Azure DevOps ${res.status}: ${(await res.text()).slice(0, 500)}`), { status: res.status });
    return res.json();
  }
  throw Object.assign(new Error(`Azure DevOps ${last!.status}: ${(await last!.text()).slice(0, 300)}`), { status: last!.status });
}

export async function wiql(query: string): Promise<{ workItems: { id: number; url: string }[]; asOf?: string; queryType?: string }> {
  const { org, project } = adoConfig();
  if (fixturesEnabled()) return ADO_FIXTURES.wiql(query);
  return adoFetch(`https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/wit/wiql?api-version=${ADO_API_VERSION}`, { method: "POST", body: JSON.stringify({ query }) });
}

export async function workItemsBatch(ids: number[], fields = ADO_FIELDS): Promise<{ id: number; rev: number; fields: Record<string, any>; url?: string }[]> {
  const { org } = adoConfig();
  const out: any[] = [];
  for (let i = 0; i < ids.length; i += ADO_BATCH_MAX) {
    const chunk = ids.slice(i, i + ADO_BATCH_MAX);
    const body = fixturesEnabled() ? ADO_FIXTURES.batch(chunk) : await adoFetch(`https://dev.azure.com/${encodeURIComponent(org)}/_apis/wit/workitemsbatch?api-version=${ADO_API_VERSION}`, { method: "POST", body: JSON.stringify({ ids: chunk, fields, errorPolicy: "omit" }) });
    out.push(...(body.value || []));
  }
  return out;
}

// ---------- writing back onto a work item ----------
export const ADO_PATCH_TYPE = "application/json-patch+json";
export interface JsonPatchOp { op: "add" | "replace" | "remove" | "test"; path: string; value?: unknown }
export interface AdoRelation { rel: string; url: string; attributes?: Record<string, any> }
export interface AdoWorkItemFull { id: number; rev: number; fields: Record<string, any>; relations?: AdoRelation[]; url?: string; _links?: { html?: { href?: string } } }
const itemUrl = (id: number | string) => { const { org, project } = adoConfig(); return `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/wit/workitems/${encodeURIComponent(String(id))}`; };

/** One work item as it stands now, with its links. ($expand cannot be combined with a field list, so every field comes back.) */
export async function getWorkItem(id: number | string): Promise<AdoWorkItemFull> {
  if (fixturesEnabled()) return ADO_FIXTURES.get(String(id));
  return adoFetch(`${itemUrl(id)}?$expand=relations&api-version=${ADO_API_VERSION}`, {}, 2);
}

/**
 * Apply a JSON Patch document to a work item. `validateOnly` changes nothing; `suppressNotifications` tells no follower.
 * Sent once: a server error is not retried here, because the change may have been saved before the answer was lost
 * (write.ts looks at the item again before deciding).
 */
export async function patchWorkItem(id: number | string, ops: JsonPatchOp[], opts: { validateOnly?: boolean; suppressNotifications?: boolean } = {}): Promise<AdoWorkItemFull> {
  if (fixturesEnabled()) { if (ADO_FIXTURES.state.latencyMs) await sleep(ADO_FIXTURES.state.latencyMs); return ADO_FIXTURES.update(String(id), ops, opts); }
  const q = `${opts.validateOnly ? "validateOnly=true&" : ""}${opts.suppressNotifications ? "suppressNotifications=true&" : ""}api-version=${ADO_API_VERSION}`;
  return adoFetch(`${itemUrl(id)}?${q}`, { method: "PATCH", body: JSON.stringify(ops), headers: { "Content-Type": ADO_PATCH_TYPE } }, 3, false);
}

/**
 * Create a work item of a type from a JSON Patch document of `add` operations. Sent once, like patchWorkItem: a
 * server error may have been answered after the item was made, and making it again is the caller's call.
 */
export async function createWorkItem(type: string, ops: JsonPatchOp[], opts: { validateOnly?: boolean; suppressNotifications?: boolean } = {}): Promise<AdoWorkItemFull> {
  if (fixturesEnabled()) { if (ADO_FIXTURES.state.latencyMs) await sleep(ADO_FIXTURES.state.latencyMs); return ADO_FIXTURES.create(type, ops, opts); }
  const { org, project } = adoConfig();
  const q = `${opts.validateOnly ? "validateOnly=true&" : ""}${opts.suppressNotifications ? "suppressNotifications=true&" : ""}api-version=${ADO_API_VERSION}`;
  const base = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/wit/workitems`;
  return adoFetch(`${base}/$${encodeURIComponent(type)}?${q}`, { method: "POST", body: JSON.stringify(ops), headers: { "Content-Type": ADO_PATCH_TYPE } }, 3, false);
}

/** Several work items as they stand, with their links. One that is gone is left out. */
export async function getWorkItems(ids: (number | string)[]): Promise<AdoWorkItemFull[]> {
  if (!ids.length) return [];
  if (fixturesEnabled()) return ADO_FIXTURES.list(ids.map(String));
  const { org, project } = adoConfig();
  const base = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/wit/workitems`;
  const out: AdoWorkItemFull[] = [];
  for (let i = 0; i < ids.length; i += ADO_BATCH_MAX) {
    const chunk = ids.slice(i, i + ADO_BATCH_MAX).map((x) => encodeURIComponent(String(x))).join(",");
    const body = await adoFetch(`${base}?ids=${chunk}&$expand=relations&errorPolicy=omit&api-version=${ADO_API_VERSION}`, {}, 2);
    out.push(...((body.value || []) as (AdoWorkItemFull | null)[]).filter((x): x is AdoWorkItemFull => !!x));
  }
  return out;
}
