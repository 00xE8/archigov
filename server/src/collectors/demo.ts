import type { NormalisedResource } from "../model.js";

/**
 * A fictional mid-size healthcare provider's Azure estate: 9 applications, ~60 resources,
 * with deliberate standards violations and decision drift so the product has something to show.
 */
const SUB = "4c1f0f0a-2b1e-4d2f-9c3a-demo00000001";
const r = (
  rg: string, type: string, name: string, location: string, tags: Record<string, string>, props: Record<string, unknown> = {}, dependsOn: string[] = []
): NormalisedResource => ({
  sourceRef: `/subscriptions/${SUB}/resourcegroups/${rg}/providers/${type}/${name}`.toLowerCase(),
  name, type, location, resourceGroup: rg, subscription: SUB, tags, props, dependsOn,
});
const ref = (rg: string, type: string, name: string) => `/subscriptions/${SUB}/resourcegroups/${rg}/providers/${type}/${name}`.toLowerCase();

const uk = "uksouth";
const owner = (o: string, extra: Record<string, string> = {}) => ({ owner: o, env: "prod", ...extra });

export const DEMO_RESOURCES: NormalisedResource[] = [
  // --- PatientFlow (tagged, modern, mostly compliant; ADR says Postgres but a Cosmos account crept in) ---
  r("rg-patientflow-prod", "Microsoft.Web/sites", "app-patientflow-api", uk, { app: "patientflow", ...owner("clinical-systems", { criticality: "critical", ibs: "Admit and discharge patients" }) },
    { httpsOnly: true, minTlsVersion: "1.2", publicAccess: false, siteConfig_linuxFxVersion: "DOTNETCORE|8.0" },
    // VNet integration into the hub is a provider reference Resource Graph really returns (virtualNetworkSubnetId)
    [ref("rg-patientflow-prod", "Microsoft.DBforPostgreSQL/flexibleServers", "psql-patientflow"), ref("rg-patientflow-prod", "Microsoft.KeyVault/vaults", "kv-patientflow"), ref("rg-network-hub", "Microsoft.Network/virtualNetworks", "vnet-hub")]),
  r("rg-patientflow-prod", "Microsoft.Web/sites", "app-patientflow-web", uk, { app: "patientflow", ...owner("clinical-systems") },
    { httpsOnly: true, minTlsVersion: "1.2", publicAccess: true, siteConfig_linuxFxVersion: "NODE|20-lts" },
    [ref("rg-patientflow-prod", "Microsoft.Web/sites", "app-patientflow-api")]),
  r("rg-patientflow-prod", "Microsoft.DBforPostgreSQL/flexibleServers", "psql-patientflow", uk, { app: "patientflow", ...owner("clinical-systems", { dataClass: "patient" }) },
    { version: "16", highAvailability_mode: "ZoneRedundant", backup_geoRedundantBackup: "Enabled", publicAccess: false }),
  r("rg-patientflow-prod", "Microsoft.DocumentDB/databaseAccounts", "cosmos-patientflow-cache", uk, { app: "patientflow", ...owner("clinical-systems") },
    { publicAccess: false, minTlsVersion: "1.2", backupPolicy_type: "Continuous" }),
  r("rg-patientflow-prod", "Microsoft.KeyVault/vaults", "kv-patientflow", uk, { app: "patientflow", ...owner("clinical-systems") },
    { enableSoftDelete: true, enablePurgeProtection: true, publicAccess: false }),
  r("rg-patientflow-prod", "Microsoft.Storage/storageAccounts", "stpatientflowdocs", uk, { app: "patientflow", ...owner("clinical-systems", { dataClass: "patient" }) },
    { publicAccess: false, minTlsVersion: "1.2", supportsHttpsTrafficOnly: true }),
  r("rg-patientflow-prod", "Microsoft.ServiceBus/namespaces", "sb-patientflow", uk, { app: "patientflow", ...owner("clinical-systems") },
    { minTlsVersion: "1.2", publicAccess: false }),
  r("rg-patientflow-prod", "Microsoft.Insights/components", "appi-patientflow", uk, { app: "patientflow", ...owner("clinical-systems") }),

  // --- Referral API (tagged; public storage, TLS 1.0 on SQL) ---
  r("rg-referrals-prod", "Microsoft.Web/sites", "app-referrals-api", uk, { app: "referral-api", ...owner("integration", { criticality: "critical", ibs: "Receive and triage referrals" }) },
    { httpsOnly: true, minTlsVersion: "1.2", publicAccess: true, siteConfig_linuxFxVersion: "DOTNETCORE|6.0" },
    [ref("rg-referrals-prod", "Microsoft.Sql/servers", "sql-referrals"), ref("rg-network-hub", "Microsoft.Network/virtualNetworks", "vnet-hub")]),
  r("rg-referrals-prod", "Microsoft.Sql/servers", "sql-referrals", uk, { app: "referral-api", ...owner("integration", { dataClass: "patient" }) },
    { minTlsVersion: "1.0", publicAccess: true, version: "12.0" }),
  r("rg-referrals-prod", "Microsoft.Sql/servers/databases", "sql-referrals/referrals", uk, { app: "referral-api", ...owner("integration") },
    { zoneRedundant: false, currentSku_name: "S2" }),
  r("rg-referrals-prod", "Microsoft.Storage/storageAccounts", "streferralattach", uk, { app: "referral-api", ...owner("integration", { dataClass: "patient" }) },
    { publicAccess: true, minTlsVersion: "1.2", supportsHttpsTrafficOnly: true }),
  r("rg-referrals-prod", "Microsoft.ApiManagement/service", "apim-referrals", uk, { app: "referral-api", ...owner("integration") },
    { publicAccess: true }),

  // --- Finance ERP (resource-group convention, no app tag; in West Europe) ---
  r("rg-finance-erp-prod", "Microsoft.Compute/virtualMachines", "vm-erp-app-01", "westeurope", { owner: "finance-it", env: "prod", criticality: "important", "business-service": "Pay suppliers" },
    { osSku: "2016-Datacenter", hardwareProfile_vmSize: "Standard_D4s_v3" },
    [ref("rg-finance-erp-prod", "Microsoft.Compute/virtualMachines", "vm-erp-db-01")]),
  r("rg-finance-erp-prod", "Microsoft.Compute/virtualMachines", "vm-erp-db-01", "westeurope", { owner: "finance-it", env: "prod", dataClass: "financial" },
    { osSku: "2016-Datacenter", hardwareProfile_vmSize: "Standard_E8s_v3", software: "SQL Server 2016" }),
  r("rg-finance-erp-prod", "Microsoft.Storage/storageAccounts", "stfinanceerpbackup", "westeurope", { owner: "finance-it", env: "prod" },
    { publicAccess: false, minTlsVersion: "1.2", supportsHttpsTrafficOnly: true }),
  r("rg-finance-erp-prod", "Microsoft.Network/publicIPAddresses", "pip-erp-rdp", "westeurope", { owner: "finance-it", env: "prod" }, { ipAddress: "20.50.1.17" }),

  // --- Legacy Pharmacy (no owner tags, Windows 2012, no app tag) ---
  r("rg-pharmacy-legacy", "Microsoft.Compute/virtualMachines", "vm-pharm-01", uk, {},
    { osSku: "2012-R2-Datacenter", hardwareProfile_vmSize: "Standard_D2_v2" }),
  r("rg-pharmacy-legacy", "Microsoft.Compute/virtualMachines", "vm-pharm-02", uk, {},
    { osSku: "2012-R2-Datacenter", hardwareProfile_vmSize: "Standard_D2_v2" }),
  r("rg-pharmacy-legacy", "Microsoft.Storage/storageAccounts", "stpharmacyfiles", uk, {},
    { publicAccess: true, minTlsVersion: "1.0", supportsHttpsTrafficOnly: false }),
  r("rg-pharmacy-legacy", "Microsoft.Network/publicIPAddresses", "pip-pharm-01", uk, {}, { ipAddress: "20.50.2.9" }),

  // --- Data Platform (tagged; AKS public, OpenAI with local auth) ---
  r("rg-dataplatform-prod", "Microsoft.ContainerService/managedClusters", "aks-dataplatform", uk, { app: "data-platform", ...owner("data-engineering", { criticality: "important", "business-service": "Clinical reporting" }) },
    { kubernetesVersion: "1.29.4", apiServerAccessProfile_enablePrivateCluster: false },
    [ref("rg-network-hub", "Microsoft.Network/virtualNetworks", "vnet-hub")]),
  r("rg-dataplatform-prod", "Microsoft.Storage/storageAccounts", "stdatalakeprod", uk, { app: "data-platform", ...owner("data-engineering", { dataClass: "patient" }) },
    { publicAccess: false, minTlsVersion: "1.2", supportsHttpsTrafficOnly: true }),
  r("rg-dataplatform-prod", "Microsoft.Databricks/workspaces", "dbw-dataplatform", uk, { app: "data-platform", ...owner("data-engineering") }),
  r("rg-dataplatform-prod", "Microsoft.CognitiveServices/accounts", "oai-clinical-summaries", uk, { app: "data-platform", ...owner("data-engineering", { aiSystem: "true" }) },
    { kind: "OpenAI", publicAccess: true, disableLocalAuth: false }),
  r("rg-dataplatform-prod", "Microsoft.KeyVault/vaults", "kv-dataplatform", uk, { app: "data-platform", ...owner("data-engineering") },
    { enableSoftDelete: true, enablePurgeProtection: false, publicAccess: false }),
  r("rg-dataplatform-prod", "Microsoft.Synapse/workspaces", "syn-dataplatform", uk, { app: "data-platform", ...owner("data-engineering") }),

  // --- Intranet (tagged, fine) ---
  r("rg-intranet-prod", "Microsoft.Web/sites", "app-intranet", uk, { app: "intranet", ...owner("digital-workplace", { criticality: "standard" }) },
    { httpsOnly: true, minTlsVersion: "1.2", publicAccess: false, siteConfig_linuxFxVersion: "NODE|20-lts" }),
  r("rg-intranet-prod", "Microsoft.DBforPostgreSQL/flexibleServers", "psql-intranet", uk, { app: "intranet", ...owner("digital-workplace") },
    { version: "16", highAvailability_mode: "Disabled", backup_geoRedundantBackup: "Disabled", publicAccess: false }),
  r("rg-intranet-prod", "Microsoft.Storage/storageAccounts", "stintranetmedia", uk, { app: "intranet", ...owner("digital-workplace") },
    { publicAccess: false, minTlsVersion: "1.2", supportsHttpsTrafficOnly: true }),

  // --- Appointments (tagged; .NET Framework 4.8 on Windows app service, SQL TLS 1.1) ---
  r("rg-appointments-prod", "Microsoft.Web/sites", "app-appointments", uk, { app: "appointments", ...owner("clinical-systems", { criticality: "important", "business-service": "Book outpatient appointments" }) },
    { httpsOnly: false, minTlsVersion: "1.1", publicAccess: true, siteConfig_netFrameworkVersion: "v4.8" },
    // client secrets come from the identity platform's vault (Key Vault reference) — a cross-application dependency
    [ref("rg-appointments-prod", "Microsoft.Sql/servers", "sql-appointments"), ref("rg-identity-prod", "Microsoft.KeyVault/vaults", "kv-identity")]),
  r("rg-appointments-prod", "Microsoft.Sql/servers", "sql-appointments", uk, { app: "appointments", ...owner("clinical-systems", { dataClass: "patient" }) },
    { minTlsVersion: "1.1", publicAccess: false, version: "12.0" }),
  r("rg-appointments-prod", "Microsoft.Sql/servers/databases", "sql-appointments/appts", uk, { app: "appointments", ...owner("clinical-systems") },
    { zoneRedundant: true, currentSku_name: "GP_Gen5_2" }),
  r("rg-appointments-prod", "Microsoft.ServiceBus/namespaces", "sb-appointments", uk, { app: "appointments", ...owner("clinical-systems") },
    { minTlsVersion: "1.2", publicAccess: false }),

  // --- Identity platform (shared, compliant) ---
  r("rg-identity-prod", "Microsoft.KeyVault/vaults", "kv-identity", uk, { app: "identity-platform", ...owner("platform", { criticality: "critical", "essential-function": "Staff sign-in to clinical systems" }) },
    { enableSoftDelete: true, enablePurgeProtection: true, publicAccess: false }),
  r("rg-identity-prod", "Microsoft.Web/sites", "app-identity-broker", uk, { app: "identity-platform", ...owner("platform") },
    { httpsOnly: true, minTlsVersion: "1.2", publicAccess: true, siteConfig_linuxFxVersion: "DOTNETCORE|8.0" }),

  // --- Shared network (resource group only) ---
  r("rg-network-hub", "Microsoft.Network/virtualNetworks", "vnet-hub", uk, { owner: "platform", env: "prod" }),
  r("rg-network-hub", "Microsoft.Network/azureFirewalls", "afw-hub", uk, { owner: "platform", env: "prod" }),
  r("rg-network-hub", "Microsoft.Network/privateDnsZones", "privatelink.postgres.database.azure.com", "global", { owner: "platform", env: "prod" }),
];

/**
 * What Defender for Cloud / Azure Policy would report for this estate. Archigov imports these assessments as
 * evidence attached to each resource; the standards assert on the imported state and never re-test the
 * configuration themselves. `stpharmacyfiles` is deliberately unassessed (legacy subscription, Defender plan
 * off) so the "no evidence imported" path is visible in the demo.
 */
export interface DemoEvidence { resourceRef: string; source: "defender" | "azure_policy"; control: string; state: "pass" | "fail"; severity: string; observed_at: string; detail: Record<string, unknown>; }

const ASSESSMENTS = {
  storagePublic: { control: "storage-public-access", source: "defender" as const, assessment: "Storage account public access should be disallowed", severity: "high" },
  // Minimum TLS is an Azure Policy built-in for storage and SQL but a Defender assessment for App Service — mirror that split.
  tlsStorage: { control: "min-tls-1.2", source: "azure_policy" as const, assessment: "Storage accounts should have the specified minimum TLS version", severity: "medium" },
  tlsSql: { control: "min-tls-1.2", source: "azure_policy" as const, assessment: "Azure SQL Database should be running TLS version 1.2 or newer", severity: "medium" },
  tlsWeb: { control: "min-tls-1.2", source: "defender" as const, assessment: "App Service apps should use the latest TLS version", severity: "medium" },
  // OS retirement is deliberately NOT here: no Defender assessment or Azure Policy built-in exists for it, so STD-004 checks props.osSku on the model instead.
  dbPublic: { control: "db-public-network-access", source: "defender" as const, assessment: "Public network access should be disabled for PaaS databases", severity: "high" },
  kvPurge: { control: "kv-purge-protection", source: "azure_policy" as const, assessment: "Key vaults should have purge protection enabled", severity: "medium" },
  cogAuth: { control: "cognitive-local-auth", source: "azure_policy" as const, assessment: "Cognitive Services accounts should have local authentication methods disabled", severity: "high" },
  httpsOnly: { control: "web-https-only", source: "azure_policy" as const, assessment: "Web Application should only be accessible over HTTPS", severity: "medium" },
};
const EOL_SKUS = ["2012-R2-Datacenter", "2012-Datacenter", "2008-R2-SP1"];
const OBSERVED_AT = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
const UNASSESSED = new Set(["stpharmacyfiles"]);

function assess(res: NormalisedResource, a: (typeof ASSESSMENTS)[keyof typeof ASSESSMENTS], pass: boolean, observed: Record<string, unknown>): DemoEvidence {
  return { resourceRef: res.sourceRef, source: a.source, control: a.control, state: pass ? "pass" : "fail", severity: a.severity, observed_at: OBSERVED_AT,
    detail: { assessment: a.assessment, source: a.source === "defender" ? "Microsoft Defender for Cloud" : "Azure Policy", observed } };
}

export const DEMO_EVIDENCE: DemoEvidence[] = DEMO_RESOURCES.flatMap((res) => {
  if (UNASSESSED.has(res.name)) return [];
  const t = res.type.toLowerCase(), p = res.props as Record<string, any>, out: DemoEvidence[] = [];
  if (t === "microsoft.storage/storageaccounts") out.push(assess(res, ASSESSMENTS.storagePublic, p.publicAccess !== true, { allowBlobPublicAccess: p.publicAccess === true }));
  if (p.minTlsVersion !== undefined) {
    const tls = t === "microsoft.storage/storageaccounts" ? ASSESSMENTS.tlsStorage : t === "microsoft.web/sites" ? ASSESSMENTS.tlsWeb : ASSESSMENTS.tlsSql;
    out.push(assess(res, tls, ["1.2", "1.3"].includes(String(p.minTlsVersion)), { minimumTlsVersion: p.minTlsVersion }));
  }
  if (["microsoft.sql/servers", "microsoft.dbforpostgresql/flexibleservers", "microsoft.documentdb/databaseaccounts"].includes(t)) out.push(assess(res, ASSESSMENTS.dbPublic, p.publicAccess !== true, { publicNetworkAccess: p.publicAccess ? "Enabled" : "Disabled" }));
  if (t === "microsoft.keyvault/vaults") out.push(assess(res, ASSESSMENTS.kvPurge, p.enablePurgeProtection === true, { enablePurgeProtection: p.enablePurgeProtection === true }));
  if (t === "microsoft.cognitiveservices/accounts" && p.kind === "OpenAI") out.push(assess(res, ASSESSMENTS.cogAuth, p.disableLocalAuth === true, { disableLocalAuth: p.disableLocalAuth === true }));
  if (t === "microsoft.web/sites") out.push(assess(res, ASSESSMENTS.httpsOnly, p.httpsOnly === true, { httpsOnly: p.httpsOnly === true }));
  return out;
});

export interface DemoWorkItem { external_id: string; type: string; title: string; state: string; area: string; description: string; tags: string[]; app?: string; }
export const DEMO_WORK_ITEMS: DemoWorkItem[] = [
  { external_id: "1042", type: "Epic", title: "Replace referral attachments store with managed document service", state: "Active", area: "Integration",
    description: "Move referral attachments from storage account to a managed document service with retention and audit. Must support 10-year retention and eDiscovery.", tags: ["architecture-needed", "data"], app: "referral-api" },
  { external_id: "1051", type: "Epic", title: "Patient self check-in kiosks", state: "New", area: "Clinical systems",
    description: "Kiosks in outpatient reception that integrate with PatientFlow arrivals. Needs offline tolerance and NHS login.", tags: ["clinical-safety"], app: "patientflow" },
  { external_id: "1063", type: "Epic", title: "Clinical note summarisation with Azure OpenAI", state: "Active", area: "Data",
    description: "Generate draft discharge summaries from clinical notes. High-risk AI use: requires human oversight design, logging and DCB0129 hazard log.", tags: ["ai", "clinical-safety"], app: "data-platform" },
  { external_id: "1070", type: "Epic", title: "Decommission legacy pharmacy servers", state: "New", area: "Infrastructure",
    description: "Retire vm-pharm-01/02 after migrating dispensing records to the new pharmacy SaaS.", tags: ["decommission"] },
  { external_id: "1077", type: "Feature", title: "Appointments: add SMS reminders via third-party gateway", state: "Active", area: "Clinical systems",
    description: "Integrate with an SMS gateway. Patient phone numbers leave the tenant. Needs DPIA and supplier assessment.", tags: ["third-party", "data"], app: "appointments" },
  { external_id: "1081", type: "Epic", title: "Finance ERP move to UK South", state: "New", area: "Finance",
    description: "Relocate ERP VMs from West Europe to UK South to meet data residency standard.", tags: ["residency"], app: "finance-erp" },
  { external_id: "1088", type: "Feature", title: "Intranet search upgrade", state: "Closed", area: "Digital workplace", description: "Swap search provider.", tags: [], app: "intranet" },
];
