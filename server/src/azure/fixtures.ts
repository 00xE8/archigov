/**
 * Recorded-shape Azure responses for fixture mode (ARCHIGOV_FIXTURES=1). They are shaped exactly like the REST
 * responses the collectors parse — ARM property names, paging tokens, nextLinks, the assessment catalogue — so the
 * real normalisation and mapping code runs offline. The estate is a small separate subscription (not the demo
 * tenant's ids): a fixture sync therefore adds its own resources and is idempotent on the second run, and the demo
 * estate is untouched. Evidence is split the way a real tenant produces it: Defender for Cloud assesses storage
 * public access, SQL public network access, App Service HTTPS/TLS, Cognitive Services public access and system
 * updates; minimum TLS on storage/SQL, Key Vault purge protection and Cognitive Services local auth come from Azure
 * Policy built-ins.
 */
export const FIXTURE_SUBSCRIPTION = "11111111-2222-3333-4444-fixture00001";
export const FIXTURE_SUBSCRIPTION_NAME = "Fixture subscription (recorded)";
const SUB = FIXTURE_SUBSCRIPTION;
const id = (rg: string, type: string, name: string) => `/subscriptions/${SUB}/resourceGroups/${rg}/providers/${type}/${name}`;

/** Rows as Resource Graph returns them for `resources | project id, name, type, location, resourceGroup, subscriptionId, tags, properties, kind, sku`. */
export const RG_ROWS: any[] = [
  { id: id("rg-claims-prod", "Microsoft.Storage/storageAccounts", "stclaimsdocs"), name: "stclaimsdocs", type: "microsoft.storage/storageaccounts", location: "uksouth", resourceGroup: "rg-claims-prod", subscriptionId: SUB,
    tags: { app: "claims", owner: "claims-team", env: "prod" }, kind: "StorageV2", sku: { name: "Standard_LRS", tier: "Standard" },
    properties: { allowBlobPublicAccess: true, minimumTlsVersion: "TLS1_0", supportsHttpsTrafficOnly: true, publicNetworkAccess: "Enabled", provisioningState: "Succeeded" } },
  { id: id("rg-claims-prod", "Microsoft.Web/sites", "app-claims-api"), name: "app-claims-api", type: "microsoft.web/sites", location: "uksouth", resourceGroup: "rg-claims-prod", subscriptionId: SUB,
    tags: { app: "claims", owner: "claims-team", env: "prod" }, kind: "app,linux", sku: null,
    properties: { httpsOnly: true, publicNetworkAccess: "Enabled", siteConfig: { minTlsVersion: "1.2", linuxFxVersion: "DOTNETCORE|8.0", ftpsState: "Disabled" }, state: "Running" } },
  { id: id("rg-claims-prod", "Microsoft.Sql/servers", "sql-claims"), name: "sql-claims", type: "microsoft.sql/servers", location: "uksouth", resourceGroup: "rg-claims-prod", subscriptionId: SUB,
    tags: { app: "claims", owner: "claims-team", env: "prod", dataClass: "customer" }, kind: "v12.0", sku: null,
    properties: { minimalTlsVersion: "1.2", publicNetworkAccess: "Enabled", version: "12.0", state: "Ready" } },
  { id: id("rg-claims-prod", "Microsoft.KeyVault/vaults", "kv-claims"), name: "kv-claims", type: "microsoft.keyvault/vaults", location: "uksouth", resourceGroup: "rg-claims-prod", subscriptionId: SUB,
    tags: { app: "claims", owner: "claims-team", env: "prod" }, kind: null, sku: null,
    properties: { enableSoftDelete: true, enablePurgeProtection: false, publicNetworkAccess: "Disabled", sku: { family: "A", name: "standard" } } },
  { id: id("rg-claims-prod", "Microsoft.ContainerService/managedClusters", "aks-claims"), name: "aks-claims", type: "microsoft.containerservice/managedclusters", location: "uksouth", resourceGroup: "rg-claims-prod", subscriptionId: SUB,
    tags: { app: "claims", owner: "claims-team", env: "prod" }, kind: null, sku: { name: "Base", tier: "Standard" },
    properties: { kubernetesVersion: "1.30.3", apiServerAccessProfile: { enablePrivateCluster: false }, provisioningState: "Succeeded" } },
  { id: id("rg-legacy-billing", "Microsoft.Compute/virtualMachines", "vm-billing-01"), name: "vm-billing-01", type: "microsoft.compute/virtualmachines", location: "westeurope", resourceGroup: "rg-legacy-billing", subscriptionId: SUB,
    tags: { owner: "finance-it", env: "prod" }, kind: null, sku: null,
    properties: { storageProfile: { imageReference: { publisher: "MicrosoftWindowsServer", offer: "WindowsServer", sku: "2012-R2-Datacenter" } }, hardwareProfile: { vmSize: "Standard_D2_v2" }, provisioningState: "Succeeded" } },
  { id: id("rg-legacy-billing", "Microsoft.CognitiveServices/accounts", "oai-billing-assist"), name: "oai-billing-assist", type: "microsoft.cognitiveservices/accounts", location: "uksouth", resourceGroup: "rg-legacy-billing", subscriptionId: SUB,
    tags: { owner: "finance-it", env: "prod", aiSystem: "true" }, kind: "OpenAI", sku: { name: "S0" },
    properties: { publicNetworkAccess: "Enabled", disableLocalAuth: false, provisioningState: "Succeeded" } },
  { id: id("rg-network-hub-fixture", "Microsoft.Network/virtualNetworks", "vnet-fixture-hub"), name: "vnet-fixture-hub", type: "microsoft.network/virtualnetworks", location: "uksouth", resourceGroup: "rg-network-hub-fixture", subscriptionId: SUB,
    tags: { owner: "platform", env: "prod" }, kind: "", sku: null, identity: null, properties: { addressSpace: { addressPrefixes: ["10.10.0.0/16"] }, provisioningState: "Succeeded" } },
];

const PAGE_TOKEN = "eyJmaXh0dXJlIjoicGFnZS0yIn0=";

/** A Resource Graph POST → the page it would return. Two pages for the resources query, one for subscriptions. resultTruncated is a string, as documented. */
function resourceGraph(body: any) {
  const q = String(body?.query || "");
  if (/resourcecontainers/i.test(q)) {
    return { totalRecords: 1, count: 1, resultTruncated: "false", facets: [], data: [{ subscriptionId: SUB, name: FIXTURE_SUBSCRIPTION_NAME }] };
  }
  const second = body?.options?.$skipToken === PAGE_TOKEN;
  const data = second ? RG_ROWS.slice(5) : RG_ROWS.slice(0, 5);
  return { totalRecords: RG_ROWS.length, count: data.length, resultTruncated: "false", facets: [], data, ...(second ? {} : { $skipToken: PAGE_TOKEN }) };
}

const GHOST_STORAGE = id("rg-ghost", "Microsoft.Storage/storageAccounts", "stghost");
const GHOST_VAULT = id("rg-ghost", "Microsoft.KeyVault/vaults", "kv-ghost");
const OBSERVED = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
const POLICY_DEF = (guid: string) => `/providers/Microsoft.Authorization/policyDefinitions/${guid}`;

/**
 * Defender assessment keys. Only the system-updates key is confirmed on the current reference pages; the rest are
 * fixture keys — real tenants resolve keys through assessmentMetadata, which is exactly what the importer does.
 */
export const ASSESSMENT_KEYS = {
  storagePublic: "51fd8bb1-0db4-bbf1-7e2b-cfcba7eb66a6", sqlPublic: "1b4c1e6a-7f71-4d5a-a9c1-0d8f3b0e1c22", webHttps: "0c6d3bb3-1b1c-4f3d-9d0a-6b3f4e2a1c77",
  webTls: "2a54c352-7ca4-4bae-ad46-47ecd9595bd2", systemUpdates: "e1145ab1-eb4f-43d8-911b-36ddf771d13f", cognitivePublic: "13b10b36-aa99-4db6-b00c-dcf87c4761e6",
  sqlPrivateEndpoint: "7f3e2c4b-5a1d-4e8f-9b2c-1a2b3c4d5e6f", kubernetesApi: "e7a7b1bb-d1f4-4f9e-9a1e-9a1e9a1e9a1e",
};

/** The assessmentMetadata catalogue (GET …/assessmentMetadata): one entry per key, naming the policy definition behind it. */
const META = (key: string, displayName: string, policyGuid: string | null, severity: "High" | "Medium" | "Low", categories: string[]) => ({
  id: `/providers/Microsoft.Security/assessmentMetadata/${key}`, name: key, type: "Microsoft.Security/assessmentMetadata",
  properties: { displayName, ...(policyGuid ? { policyDefinitionId: POLICY_DEF(policyGuid) } : {}), categories, severity, userImpact: "Low", implementationEffort: "Low", preview: false, assessmentType: "BuiltIn" },
});
const ASSESSMENT_METADATA: any[] = [
  META(ASSESSMENT_KEYS.storagePublic, "Storage account public access should be disallowed", "4fa4b6c0-31ca-4c0d-b10d-24b96f62a751", "Medium", ["Data"]),
  META(ASSESSMENT_KEYS.sqlPublic, "Public network access on Azure SQL Database should be disabled", "1b8ca024-1d5c-4dec-8995-b1a932b41780", "Medium", ["Data"]),
  META(ASSESSMENT_KEYS.webHttps, "Web Application should only be accessible over HTTPS", "a4af4a39-4135-47fb-b175-47fbdf85311d", "Medium", ["Compute"]),
  META(ASSESSMENT_KEYS.webTls, "TLS should be updated to the latest version for web apps", "f0e6e85b-9b9f-4a4b-b67b-f730d42f1b0b", "High", ["Compute"]),
  META(ASSESSMENT_KEYS.systemUpdates, "System updates should be installed on your machines (powered by Azure Update Manager)", "f85bf3e0-d513-442e-89c3-1784ad63382b", "High", ["Compute"]),
  META(ASSESSMENT_KEYS.cognitivePublic, "Public network access should be disabled for Cognitive Services accounts", "0725b4dd-7e76-479c-a735-68e7ee23d5ca", "Medium", ["Data"]),
  META(ASSESSMENT_KEYS.sqlPrivateEndpoint, "Private endpoint connections on Azure SQL Database should be enabled", "7698e800-9299-47a6-b3b6-5a0fee576eed", "Medium", ["Data"]),
  // no catalogue entry for kubernetesApi: exercises the display-name → fallback path
];

/** Assessments as the LIST returns them: no metadata, lower-case resourceDetails.id, status dates. */
const assessment = (resourceId: string, key: string, displayName: string, code: "Healthy" | "Unhealthy" | "NotApplicable") => ({
  id: `${resourceId}/providers/Microsoft.Security/assessments/${key}`, name: key, type: "Microsoft.Security/assessments",
  properties: { resourceDetails: { source: "Azure", id: resourceId }, displayName,
    status: { code, statusChangeDate: OBSERVED, firstEvaluationDate: OBSERVED, ...(code === "NotApplicable" ? { cause: "OffByPolicy", description: "The effective policy for the assessment was evaluated to off - use Microsoft.Authorization/policyAssignments to turn this assessment on" } : {}) } },
});
const DEFENDER_ITEMS: any[] = [
  assessment(RG_ROWS[0].id, ASSESSMENT_KEYS.storagePublic, "Storage account public access should be disallowed", "Unhealthy"),
  assessment(RG_ROWS[2].id, ASSESSMENT_KEYS.sqlPublic, "Public network access on Azure SQL Database should be disabled", "Unhealthy"),
  assessment(RG_ROWS[1].id, ASSESSMENT_KEYS.webHttps, "Web Application should only be accessible over HTTPS", "Healthy"),
  assessment(RG_ROWS[1].id, ASSESSMENT_KEYS.webTls, "TLS should be updated to the latest version for web apps", "Healthy"),
  assessment(RG_ROWS[5].id, ASSESSMENT_KEYS.systemUpdates, "System updates should be installed on your machines (powered by Azure Update Manager)", "Unhealthy"),
  assessment(RG_ROWS[6].id, ASSESSMENT_KEYS.cognitivePublic, "Public network access should be disabled for Cognitive Services accounts", "Unhealthy"),
  assessment(RG_ROWS[2].id, ASSESSMENT_KEYS.sqlPrivateEndpoint, "Private endpoint connections on Azure SQL Database should be enabled", "NotApplicable"),
  assessment(RG_ROWS[4].id, ASSESSMENT_KEYS.kubernetesApi, "Kubernetes API server should be configured with restricted access", "Unhealthy"),
  assessment(GHOST_STORAGE, ASSESSMENT_KEYS.storagePublic, "Storage account public access should be disallowed", "Unhealthy"),
];
function defenderAssessments() { return DEFENDER_ITEMS; }
function assessmentMetadata() { return ASSESSMENT_METADATA; }

const policyState = (resourceId: string, definition: string, assignment: string, complianceState: "Compliant" | "NonCompliant" | "Exempt", resourceType: string) => ({
  "@odata.id": null, "@odata.context": `https://management.azure.com/subscriptions/${SUB}/providers/Microsoft.PolicyInsights/policyStates/$metadata#latest/$entity`,
  timestamp: OBSERVED, resourceId, policyAssignmentId: `/subscriptions/${SUB}/providers/Microsoft.Authorization/policyAssignments/${assignment}`,
  policyDefinitionId: POLICY_DEF(definition), effectiveParameters: null, isCompliant: complianceState === "Compliant",
  subscriptionId: SUB, resourceType: `/${resourceType}`, resourceLocation: "uksouth", resourceGroup: resourceId.split("/")[4], resourceTags: "tbd", policyAssignmentName: assignment,
  policyAssignmentOwner: "tbd", policyAssignmentParameters: "{}", policyAssignmentScope: `/subscriptions/${SUB}`, policyAssignmentVersion: "1.0.0", policyDefinitionName: definition,
  policyDefinitionAction: "audit", policyDefinitionCategory: "tbd", policyDefinitionVersion: "1.0.0", policyDefinitionGroupNames: [], policySetDefinitionId: "", policySetDefinitionName: "", policyDefinitionReferenceId: null, complianceState,
});

/** Azure Policy latest states: built-in GUIDs the mapping table knows, one unknown GUID (fallback key), one unmatched resource. */
const POLICY_ITEMS: any[] = [
  policyState(RG_ROWS[3].id, "0b60c0b2-2dc2-4e1c-b5c9-abbed971de53", "security-baseline", "NonCompliant", "Microsoft.KeyVault/vaults"),          // purge protection
  policyState(RG_ROWS[3].id, "1e66c121-a66a-4b1f-9b83-0fd99bf0fc2d", "security-baseline", "Compliant", "Microsoft.KeyVault/vaults"),             // soft delete
  policyState(RG_ROWS[0].id, "fe83a0eb-a853-422d-aac2-1bffd182c5d0", "security-baseline", "NonCompliant", "Microsoft.Storage/storageAccounts"), // storage min TLS
  policyState(RG_ROWS[0].id, "4fa4b6c0-31ca-4c0d-b10d-24b96f62a751", "security-baseline", "NonCompliant", "Microsoft.Storage/storageAccounts"), // storage public access
  policyState(RG_ROWS[2].id, "32e6bbec-16b6-44c2-be37-c5b672d103cf", "security-baseline", "Compliant", "Microsoft.Sql/servers"),                // SQL TLS 1.2
  policyState(RG_ROWS[1].id, "a4af4a39-4135-47fb-b175-47fbdf85311d", "security-baseline", "Compliant", "Microsoft.Web/sites"),                  // HTTPS only
  policyState(RG_ROWS[6].id, "71ef260a-8f18-47b7-abcb-62d0673d94dc", "security-baseline", "NonCompliant", "Microsoft.CognitiveServices/accounts"), // local auth
  policyState(RG_ROWS[4].id, "0e246bcf-5f6f-4f87-bc6f-775d4712c7ea", "security-baseline", "Compliant", "Microsoft.ContainerService/managedClusters"), // unknown → policy:<guid>
  policyState(GHOST_VAULT, "0b60c0b2-2dc2-4e1c-b5c9-abbed971de53", "security-baseline", "NonCompliant", "Microsoft.KeyVault/vaults"),
];
function policyStates() { return POLICY_ITEMS; }

export const FIXTURES = { resourceGraph, defenderAssessments, assessmentMetadata, policyStates, subscription: { id: SUB, name: FIXTURE_SUBSCRIPTION_NAME }, unmatched: { storage: GHOST_STORAGE, vault: GHOST_VAULT } };
