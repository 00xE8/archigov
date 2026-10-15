// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The Archigov Authors
import type { PackStandard, StandardsPack } from "./types.js";

/** The five architecture-governance rules. Resource-configuration checks are deliberately absent: those are imported from Defender / Azure Policy as evidence. */
export const CORE_STANDARDS: PackStandard[] = [
  { code: "STD-001", title: "Production workloads run in UK regions", category: "Hosting", severity: "high", status: "adopt",
    statement: "All production resources are deployed to UK South or UK West. Global services are exempt.",
    rationale: "Patient data residency and the UK operational resilience expectations of our regulator.",
    control_refs: ["UK GDPR Art.44", "DSPT 2025 A1.a", "ISO 27001 A.5.23"],
    rule: { scope: "resource", match: { where: [{ path: "location", op: "neq", value: "global" }] }, assert: { path: "location", op: "in", value: ["uksouth", "ukwest"] } } },
  { code: "STD-005", title: "Every application has an accountable owner", category: "Governance", severity: "medium", status: "adopt",
    statement: "Every application is traceable to an owning team through an 'owner' tag on its resources.",
    rationale: "Findings, conditions and incidents need someone to route to.",
    control_refs: ["ISO 27001 A.5.9", "DORA Art.8(1)", "COBIT APO03"],
    rule: { scope: "application", assert: { op: "hasOwnerTag" } } },
  { code: "STD-006", title: "Data stores are an architecture decision", category: "Governance", severity: "high", status: "adopt",
    statement: "An application that holds data has an accepted ADR on its data store technology, and its deployed data stores match it.",
    rationale: "Data store choice drives cost, resilience and the clinical safety case; it must be deliberate and traceable.",
    control_refs: ["ISO 27001 A.8.27", "DORA Art.8(4)", "EU AI Act Annex IV §2(a)"],
    rule: { scope: "application", assert: { op: "hasDecision", topic: "data-store", type: "Microsoft.Sql" } } },
  { code: "STD-006b", title: "Deployed data stores match the accepted decision", category: "Governance", severity: "high", status: "adopt",
    statement: "Deployed database services for an application are within the set approved in its accepted data-store ADR.",
    rationale: "Continuous conformance between what the ARB approved and what runs.",
    control_refs: ["ISO 27001 A.8.27", "ISO 27001 A.8.32", "DORA RTS Art.17"],
    rule: { scope: "resource", match: { typeIn: ["Microsoft.Sql/servers", "Microsoft.DBforPostgreSQL/flexibleServers", "Microsoft.DocumentDB/databaseAccounts", "Microsoft.DBforMySQL/flexibleServers"] }, assert: { op: "decisionConstraint", topic: "data-store" } } },
  { code: "STD-010", title: ".NET Framework web apps are on hold", category: "Technology radar", severity: "low", status: "hold",
    statement: "No new App Service workloads on .NET Framework; existing ones have a migration decision.",
    rationale: "Linux containers on .NET 8 are the paved road.",
    control_refs: ["Internal technology radar"],
    rule: { scope: "resource", match: { type: "Microsoft.Web/sites" }, assert: { path: "props.siteConfig_netFrameworkVersion", op: "missing" } } },
];

export const ARCHIGOV_CORE: StandardsPack = { id: "archigov-core", name: "Archigov core architecture standards", version: "1.0.0", lifecycle_on_import: "adopted",
  description: "Five architecture-governance rules any estate can start with: UK hosting, accountable owners, data-store decisions and their conformance, and the technology radar. Resource-configuration checks are not here; they are imported from Defender for Cloud / Azure Policy as evidence. Imported as adopted so a first run is effective at once.",
  standards: CORE_STANDARDS };
