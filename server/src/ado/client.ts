import { fixturesEnabled, sleep } from "../azure/client.js";
import { ADO_FIXTURES } from "./fixtures.js";

/**
 * Azure DevOps REST 7.1 client for the work-item feed.
 *   WIQL:  POST https://dev.azure.com/{org}/{project}/_apis/wit/wiql?api-version=7.1   body { query } → { workItems: [{ id, url }] }
 *          https://learn.microsoft.com/rest/api/azure/devops/wit/wiql/query-by-wiql?view=azure-devops-rest-7.1
 *   Batch: POST https://dev.azure.com/{org}/_apis/wit/workitemsbatch?api-version=7.1   body { ids (≤200), fields } → { count, value: [{ id, rev, fields, url }] }
 *          https://learn.microsoft.com/rest/api/azure/devops/wit/work-items/get-work-items-batch?view=azure-devops-rest-7.1
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

async function adoFetch(url: string, init: RequestInit = {}, maxAttempts = 4): Promise<any> {
  const auth = await authHeader();
  let last: Response | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url, { ...init, headers: { Authorization: auth, "Content-Type": "application/json", Accept: "application/json", ...(init.headers as any || {}) } });
    if (res.status === 429 || res.status >= 500) { last = res; if (attempt < maxAttempts) { await sleep((Number(res.headers.get("Retry-After") || 2 ** attempt) * 1000)); continue; } break; }
    if (res.status === 203 || res.status === 401 || res.status === 403) throw new Error(`Azure DevOps ${res.status}: not authorised — check the PAT / Entra identity and its access level`);
    if (!res.ok) throw new Error(`Azure DevOps ${res.status}: ${(await res.text()).slice(0, 500)}`);
    return res.json();
  }
  throw new Error(`Azure DevOps ${last!.status}: ${(await last!.text()).slice(0, 300)}`);
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
