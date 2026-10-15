import type { NormalisedResource } from "../model.js";
import { ARM, armFetch, armToken, respectQuota, fixturesEnabled, configuredSubscriptions } from "./client.js";
import { FIXTURES } from "./fixtures.js";

/**
 * Azure Resource Graph collector. Needs Reader on the subscriptions in scope.
 * REST: POST https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=2024-04-01
 *   https://learn.microsoft.com/rest/api/azureresourcegraph/resourcegraph/resources/resources?view=rest-azureresourcegraph-resourcegraph-2024-04-01
 *   (2022-10-01 has identical definitions.) body { subscriptions, query, options: { resultFormat: "objectArray" — always set
 *   explicitly, $top (1..1000), $skipToken } }; response { totalRecords, count, data[], $skipToken?, resultTruncated ("true"|"false", a string) }.
 *   $skipToken is absent when there is no further page (and never returned for queries using limit/take/sample), so paging
 *   stops on a missing token. `order by id asc` keeps pages stable.
 * Throttling: x-ms-user-quota-remaining / x-ms-user-quota-resets-after (hh:mm:ss) on every response; 429 with
 *   error.code "RateLimiting" on exhaustion; group subscriptions per call (≤ 300 recommended) and page with $skipToken.
 *   https://learn.microsoft.com/azure/governance/resource-graph/concepts/guidance-for-throttled-requests
 */
export const RG_API_VERSION = "2024-04-01";
export const RG_URL = `${ARM}/providers/Microsoft.ResourceGraph/resources?api-version=${RG_API_VERSION}`;
export const RG_PAGE_SIZE = 1000;
export const RG_SUBSCRIPTION_BATCH = 100;

export const RESOURCES_QUERY = `resources
| project id, name, type, location, resourceGroup, subscriptionId, tags, properties, kind, sku
| order by id asc`;

/**
 * Subscriptions are listed through Resource Graph too (resourcecontainers), not ARM's subscriptions API: it is
 * the same endpoint, token scope and Reader permission the collector already needs, so "Test connection"
 * proves exactly what a sync will use.
 */
export const SUBSCRIPTIONS_QUERY = `resourcecontainers
| where type == 'microsoft.resources/subscriptions'
| project subscriptionId, name
| order by name asc`;

/**
 * Which raw ARM properties are kept per resource type. Everything the rules consume is derived from these in
 * normaliseResource(): props.publicAccess, props.minTlsVersion, props.osSku, props.httpsOnly, props.location
 * (added by ingest), tags.owner.
 */
export const KEEP_PROPS: Record<string, string[]> = {
  "microsoft.storage/storageaccounts": ["allowBlobPublicAccess", "minimumTlsVersion", "supportsHttpsTrafficOnly", "publicNetworkAccess"],
  "microsoft.web/sites": ["httpsOnly", "publicNetworkAccess", "siteConfig.minTlsVersion", "siteConfig.linuxFxVersion", "siteConfig.netFrameworkVersion", "siteConfig.ftpsState"],
  "microsoft.sql/servers": ["minimalTlsVersion", "publicNetworkAccess", "version"],
  "microsoft.sql/servers/databases": ["zoneRedundant", "currentSku.name"],
  "microsoft.dbforpostgresql/flexibleservers": ["version", "highAvailability.mode", "backup.geoRedundantBackup", "network.publicNetworkAccess"],
  "microsoft.dbformysql/flexibleservers": ["version", "highAvailability.mode", "backup.geoRedundantBackup", "network.publicNetworkAccess"],
  "microsoft.documentdb/databaseaccounts": ["publicNetworkAccess", "minimalTlsVersion", "backupPolicy.type"],
  "microsoft.compute/virtualmachines": ["storageProfile.imageReference.sku", "storageProfile.imageReference.offer", "hardwareProfile.vmSize"],
  "microsoft.keyvault/vaults": ["enableSoftDelete", "enablePurgeProtection", "publicNetworkAccess"],
  "microsoft.network/publicipaddresses": ["ipAddress"],
  "microsoft.containerservice/managedclusters": ["kubernetesVersion", "apiServerAccessProfile.enablePrivateCluster"],
  "microsoft.cognitiveservices/accounts": ["publicNetworkAccess", "disableLocalAuth"],
  "microsoft.servicebus/namespaces": ["minimumTlsVersion", "publicNetworkAccess"],
};

function pick(obj: any, paths: string[]) {
  const out: Record<string, unknown> = {};
  for (const p of paths) {
    const v = p.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
    if (v !== undefined) out[p.replace(/\./g, "_")] = v;
  }
  return out;
}

/** One Resource Graph row → the provider-independent shape the model ingests. The only place ARM property names are known. */
export function normaliseResource(row: any): NormalisedResource {
  const type = String(row.type || "").toLowerCase();
  const props: Record<string, any> = { ...pick(row.properties || {}, KEEP_PROPS[type] || []) };
  if (row.kind !== undefined && row.kind !== null && row.kind !== "") props.kind = row.kind;
  if (row.sku?.name) props.sku = row.sku.name;
  // common normalisations so one rule works across resource types
  const tls = props.minimumTlsVersion ?? props.minimalTlsVersion ?? props.siteConfig_minTlsVersion;
  if (tls !== undefined) props.minTlsVersion = String(tls).replace(/^TLS/i, "").replace("_", ".");
  if (props.allowBlobPublicAccess !== undefined) props.publicAccess = props.allowBlobPublicAccess === true;
  else if (props.network_publicNetworkAccess !== undefined) props.publicAccess = String(props.network_publicNetworkAccess).toLowerCase() === "enabled";
  else if (props.publicNetworkAccess !== undefined) props.publicAccess = String(props.publicNetworkAccess).toLowerCase() === "enabled";
  if (props.storageProfile_imageReference_sku) props.osSku = props.storageProfile_imageReference_sku;
  const tags: Record<string, string> = {};
  for (const [k, v] of Object.entries(row.tags || {})) if (v !== null && v !== undefined) tags[k] = String(v);
  return {
    sourceRef: String(row.id).toLowerCase(), name: String(row.name), type: String(row.type), location: row.location,
    resourceGroup: row.resourceGroup, subscription: row.subscriptionId, tags, props,
  };
}

async function postPage(body: any, token: string): Promise<any> {
  if (fixturesEnabled()) return FIXTURES.resourceGraph(body);
  const res = await armFetch(RG_URL, { method: "POST", token, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Resource Graph ${res.status}: ${(await res.text()).slice(0, 500)}`);
  await respectQuota(res);
  return res.json();
}

/** Run one query over the given subscriptions, following $skipToken until the result set is exhausted. */
export async function queryResourceGraph(query: string, subscriptions: string[] | undefined, token: string): Promise<any[]> {
  const rows: any[] = [];
  let skipToken: string | undefined;
  let pages = 0;
  do {
    const body: any = { query, options: { resultFormat: "objectArray", $top: RG_PAGE_SIZE, ...(skipToken ? { $skipToken: skipToken } : {}) } };
    if (subscriptions?.length) body.subscriptions = subscriptions;
    const data = await postPage(body, token);
    rows.push(...(data.data || []));
    skipToken = data.$skipToken;
    if (++pages > 10000) throw new Error("Resource Graph paging did not terminate");
  } while (skipToken);
  return rows;
}

const batches = <T>(xs: T[], n: number) => { const out: T[][] = []; for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n)); return out; };

/** Collect every resource in scope, normalised. Subscriptions default to AZURE_SUBSCRIPTIONS; none = the whole tenant the identity can see. */
export async function collectResourceGraph(opts: { subscriptions?: string[] } = {}): Promise<NormalisedResource[]> {
  const token = fixturesEnabled() ? "fixture" : await armToken();
  const subs = opts.subscriptions?.length ? opts.subscriptions : configuredSubscriptions();
  const groups = subs.length ? batches(subs, RG_SUBSCRIPTION_BATCH) : [undefined];
  const out: NormalisedResource[] = [];
  const seen = new Set<string>();
  for (const g of groups) {
    for (const row of await queryResourceGraph(RESOURCES_QUERY, g, token)) {
      const r = normaliseResource(row);
      if (seen.has(r.sourceRef)) continue; // the same id can appear twice across overlapping scopes
      seen.add(r.sourceRef); out.push(r);
    }
  }
  return out;
}

/** The subscriptions the identity can read — what "Test connection" shows and what a sync will cover. */
export async function listSubscriptions(): Promise<{ id: string; name: string }[]> {
  const token = fixturesEnabled() ? "fixture" : await armToken();
  const rows = await queryResourceGraph(SUBSCRIPTIONS_QUERY, undefined, token);
  const scoped = configuredSubscriptions();
  return rows.map((r) => ({ id: String(r.subscriptionId), name: String(r.name) })).filter((s) => !scoped.length || scoped.includes(s.id));
}
