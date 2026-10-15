/**
 * Shared Azure Resource Manager plumbing for the collectors and evidence importers: credential, token,
 * a fetch with bounded retry that honours ARM throttling headers, nextLink paging, and the fixture switch.
 *
 * Fixture mode (ARCHIGOV_FIXTURES=1) replaces every outbound call with recorded-shape responses from
 * ./fixtures.ts, so the real parsing and normalisation code runs offline (tests, demo, smoke).
 */
export const ARM = "https://management.azure.com";
export const ARM_SCOPE = "https://management.azure.com/.default";

export const fixturesEnabled = () => process.env.ARCHIGOV_FIXTURES === "1";
export const azureEnvConfigured = () => !!(process.env.AZURE_TENANT_ID || process.env.AZURE_CLIENT_ID || process.env.AZURE_SUBSCRIPTIONS);
/** Azure is usable when credentials are configured by environment, or when fixtures stand in for it. */
export const azureConfigured = () => fixturesEnabled() || azureEnvConfigured();
export const configuredSubscriptions = (): string[] => (process.env.AZURE_SUBSCRIPTIONS || "").split(",").map((s) => s.trim()).filter(Boolean);

let credential: any;
/** DefaultAzureCredential: env vars (AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET), managed identity, or `az login`. */
export async function armToken(scope = ARM_SCOPE): Promise<string> {
  const { DefaultAzureCredential } = await import("@azure/identity");
  credential ??= new DefaultAzureCredential();
  const t = await credential.getToken(scope);
  if (!t) throw new Error("Could not acquire an Azure token (check AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET or the managed identity)");
  return t.token;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Resource Graph reports the quota window as hh:mm:ss in x-ms-user-quota-resets-after. */
export function parseResetsAfter(v: string | null): number {
  if (!v) return 0;
  const m = v.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
  if (!m) return Number(v) || 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/**
 * fetch with a bounded retry for 429 and 5xx. Waits for Retry-After, else Resource Graph's quota reset header,
 * else an exponential backoff. Throws with the ARM error body when it gives up.
 * https://learn.microsoft.com/azure/governance/resource-graph/concepts/guidance-for-throttled-requests
 */
export async function armFetch(url: string, init: RequestInit & { token: string }, maxAttempts = 5): Promise<Response> {
  const { token, ...rest } = init;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(rest.headers as Record<string, string> || {}) };
  let last: Response | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url, { ...rest, headers });
    if (res.status !== 429 && res.status < 500) return res;
    last = res;
    if (attempt === maxAttempts) break;
    const retryAfter = Number(res.headers.get("Retry-After") || 0);
    const resets = parseResetsAfter(res.headers.get("x-ms-user-quota-resets-after"));
    await sleep(((retryAfter || resets || Math.min(2 ** attempt, 20)) * 1000) + Math.floor(Math.random() * 250));
  }
  throw new Error(`Azure ${last!.status}: ${(await last!.text()).slice(0, 500)}`);
}

/** Resource Graph quota: when the window is exhausted, wait for it to reset before the next page. */
export async function respectQuota(res: Response) {
  const remaining = res.headers.get("x-ms-user-quota-remaining");
  if (remaining !== null && Number(remaining) <= 0) await sleep(parseResetsAfter(res.headers.get("x-ms-user-quota-resets-after")) * 1000);
}

/** GET a list resource and follow `nextLink` / `@odata.nextLink` until exhausted. */
export async function armGetAll<T = any>(url: string, token: string, maxPages = 200): Promise<T[]> {
  const out: T[] = [];
  let next: string | undefined = url;
  for (let i = 0; next && i < maxPages; i++) {
    const res = await armFetch(next, { method: "GET", token });
    if (!res.ok) throw new Error(`Azure ${res.status}: ${(await res.text()).slice(0, 500)}`);
    const body: any = await res.json();
    out.push(...(body.value || []));
    next = body.nextLink || body["@odata.nextLink"];
  }
  return out;
}

export const slug = (s: string) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
