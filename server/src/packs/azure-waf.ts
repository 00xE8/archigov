// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The archigov Authors
import type { PackStandard, StandardsPack } from "./types.js";

/**
 * Azure Well-Architected-aligned architecture standards. Resource-configuration checks assert on evidence imported
 * from Defender for Cloud / Azure Policy (the `evidence` op); architecture properties the collector derives
 * (redundancy, private control planes, tagging) are checked directly. References are WAF pillar checklist ids.
 */
export const AZURE_WAF_STANDARDS: PackStandard[] = [
  { code: "STD-WAF-01", title: "Internet-facing web apps enforce HTTPS", category: "Security", severity: "medium", status: "adopt",
    statement: "App Service sites are HTTPS-only. Evidence: the Azure Policy compliance state for the built-in HTTPS-only definition, imported per site.",
    rationale: "Transport security is table stakes for every public endpoint; the platform already evaluates it.",
    control_refs: ["Azure WAF SE:07", "Azure Policy: web-https-only", "ISO 27001 A.8.24"],
    rule: { scope: "resource", match: { type: "Microsoft.Web/sites" }, assert: { op: "evidence", source: "azure_policy", control: "web-https-only", state: "pass" } } },
  { code: "STD-WAF-02", title: "Data services reject TLS below 1.2", category: "Security", severity: "high", status: "adopt",
    statement: "Storage accounts and SQL servers require TLS 1.2 or later. Evidence: the Azure Policy compliance states for the built-in minimum-TLS definitions, imported per resource.",
    rationale: "Deprecated TLS fails Cyber Essentials and PCI DSS; Azure Policy evaluates it continuously.",
    control_refs: ["Azure WAF SE:07", "Azure Policy: min-tls-1.2", "Cyber Essentials: Secure configuration"],
    rule: { scope: "resource", match: { typeIn: ["Microsoft.Storage/storageAccounts", "Microsoft.Sql/servers"] }, assert: { op: "evidence", source: "azure_policy", control: "min-tls-1.2", state: "pass" } } },
  { code: "STD-WAF-03", title: "Managed databases are not publicly reachable", category: "Security", severity: "high", status: "adopt",
    statement: "PaaS databases disable public network access and are reached over private endpoints. Evidence: Defender for Cloud's public-network-access assessment, imported per database service.",
    rationale: "Network isolation of data stores is the single most effective control against data exposure.",
    control_refs: ["Azure WAF SE:06", "Defender: db-public-network-access", "NIST SP 800-53 SC-7"],
    rule: { scope: "resource", match: { typeIn: ["Microsoft.Sql/servers", "Microsoft.DBforPostgreSQL/flexibleServers", "Microsoft.DocumentDB/databaseAccounts", "Microsoft.DBforMySQL/flexibleServers"] }, assert: { op: "evidence", source: "defender", control: "db-public-network-access", state: "pass" } } },
  { code: "STD-WAF-04", title: "Key Vaults are protected against destructive deletion", category: "Resilience", severity: "medium", status: "adopt",
    statement: "Key Vaults enable purge protection. Evidence: the Azure Policy compliance state for the built-in purge-protection definition, imported per vault.",
    rationale: "A deleted key is an outage and possibly a data loss; purge protection makes deletion recoverable.",
    control_refs: ["Azure WAF RE:09", "Azure Policy: kv-purge-protection", "NIST SP 800-53 SC-12"],
    rule: { scope: "resource", match: { type: "Microsoft.KeyVault/vaults" }, assert: { op: "evidence", source: "azure_policy", control: "kv-purge-protection", state: "pass" } } },
  { code: "STD-WAF-05", title: "Virtual machines have their system updates installed", category: "Security", severity: "high", status: "adopt",
    statement: "Virtual machines carry no missing system updates. Evidence: Defender for Cloud's \"System updates should be installed on your machines\" assessment, imported per machine.",
    rationale: "Missing updates are the finding auditors raise first; Defender assesses every machine continuously.",
    control_refs: ["Azure WAF SE:08", "Defender: system-updates", "Cyber Essentials: Security update management"],
    rule: { scope: "resource", match: { type: "Microsoft.Compute/virtualMachines" }, assert: { op: "evidence", source: "defender", control: "system-updates", state: "pass" } } },
  { code: "STD-WAF-06", title: "Production PostgreSQL servers are zone redundant", category: "Resilience", severity: "high", status: "adopt",
    statement: "PostgreSQL flexible servers for production workloads run with zone-redundant high availability.",
    rationale: "A single-zone database is the usual single point of failure in an otherwise resilient design.",
    control_refs: ["Azure WAF RE:05", "DORA Art.12", "ISO 27001 A.8.14"],
    rule: { scope: "resource", match: { type: "Microsoft.DBforPostgreSQL/flexibleServers" }, assert: { path: "props.highAvailability_mode", op: "eq", value: "ZoneRedundant" } } },
  { code: "STD-WAF-07", title: "Kubernetes control planes are private", category: "Security", severity: "high", status: "adopt",
    statement: "AKS clusters expose the API server privately only.",
    rationale: "A public control plane is an internet-facing administrative surface.",
    control_refs: ["Azure WAF SE:06", "CIS Kubernetes Benchmark 5.4", "NIST SP 800-53 SC-7"],
    rule: { scope: "resource", match: { type: "Microsoft.ContainerService/managedClusters" }, assert: { path: "props.apiServerAccessProfile_enablePrivateCluster", op: "eq", value: true } } },
  { code: "STD-WAF-08", title: "Resources declare their environment", category: "Governance", severity: "low", status: "adopt",
    statement: "Every resource carries an `env` tag so production can be told from everything else in cost, policy and conformance views.",
    rationale: "Environment is the first filter in every operational and financial question.",
    control_refs: ["Azure WAF OE:04", "Azure WAF CO:03"],
    rule: { scope: "resource", assert: { path: "tags.env", op: "exists" } } },
];

export const AZURE_WAF_PACK: StandardsPack = { id: "azure-waf-architecture", name: "Azure Well-Architected architecture standards", version: "1.0.0", lifecycle_on_import: "draft",
  description: "Eight standards aligned to the Azure Well-Architected Framework checklists: transport security, data-store isolation, deletion protection, supported platforms, zone redundancy, private control planes and environment tagging. Platform checks assert on evidence imported from Defender for Cloud and Azure Policy.",
  standards: AZURE_WAF_STANDARDS };
