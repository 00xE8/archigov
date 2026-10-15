// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The Archigov Authors
import type { PackStandard, StandardsPack } from "./types.js";

/**
 * The governance starter pack: principles, patterns and policies (not standards) an architecture function can
 * adopt on day one. Everything here is the organisation's own statement; control references point at the
 * frameworks that ask for it and reproduce none of their text.
 */
export const GOVERNANCE_STARTER: PackStandard[] = [
  { code: "PRN-GOV-01", kind: "principle", title: "The architecture model is derived, not drawn", category: "Principle", severity: "low", status: "adopt",
    statement: "The as-is model comes from the estate and the backlog. People spend their effort on decisions, standards and reviews, not on keeping diagrams current.",
    rationale: "A hand-maintained repository is out of date the day it is published; a derived one is as current as the last collection.", control_refs: ["TOGAF 10 Architecture Governance", "ISO/IEC/IEEE 42010"], rule: null },
  { code: "PRN-GOV-02", kind: "principle", title: "Evidence, not assurance", category: "Principle", severity: "low", status: "adopt",
    statement: "The repository shows what was decided, by whom, on what evidence. Compliance conclusions belong to accountable people and auditors, never to the tool.",
    rationale: "Keeps accountability where regulators expect it and makes every claim traceable.", control_refs: ["ISO 27001 Clause 9.1", "DORA Art.6(5)"], rule: null },
  { code: "PRN-GOV-03", kind: "principle", title: "Decisions are first-class and reviewable", category: "Principle", severity: "low", status: "adopt",
    statement: "Every significant architecture choice is recorded as a decision with options, consequences and, where possible, a checkable constraint the estate is held to.",
    rationale: "Decisions that are not written down cannot be conformed to, revisited or audited.", control_refs: ["TOGAF 10 Architecture Compliance", "ISO 27001 A.5.8"], rule: null },
  { code: "PAT-GOV-01", kind: "pattern", title: "One Key Vault per application", category: "Security", severity: "medium", status: "adopt",
    statement: "Each application keeps its secrets in a single Key Vault it owns, with access granted by role to the application's identities only.",
    rationale: "Shared vaults blur ownership and blast radius; many vaults per application fragment access reviews.",
    context: "Applications need secrets, keys and certificates; teams create vaults ad hoc, sometimes sharing one across unrelated workloads and sometimes creating one per environment or component.",
    solution: "Provision exactly one Key Vault per application (environments as separate vaults only where isolation is mandated), enable purge protection and RBAC authorisation, and grant access to the application's managed identities rather than to people.",
    applicability: "All applications holding secrets; shared platform services (identity, hub networking) may hold a platform vault instead.",
    control_refs: ["ISO 27001 A.8.24", "NIST SP 800-53 SC-12", "Azure WAF Security: secrets management"],
    rule: { scope: "application", assert: { op: "maxResourcesOfType", type: "Microsoft.KeyVault/vaults", max: 1 } } },
  { code: "PAT-GOV-02", kind: "pattern", title: "Private connectivity for data stores", category: "Networking", severity: "high", status: "adopt",
    statement: "Managed data stores are reached over private endpoints from the application's network; public network access is disabled.",
    rationale: "Removes the public attack surface from the data tier and keeps data-plane traffic on the Microsoft backbone.",
    context: "PaaS data services are reachable from the internet by default; firewall allow-lists erode over time and leave the data plane exposed.",
    solution: "Create a private endpoint for each data store in the application's virtual network, disable public network access, and resolve the service through the private DNS zone.",
    applicability: "SQL, PostgreSQL, Cosmos DB and storage accounts in production; development estates may use service endpoints.",
    control_refs: ["ISO 27001 A.8.20", "NIST SP 800-53 SC-7", "Azure WAF Security: network isolation"], rule: null },
  { code: "POL-GOV-01", kind: "policy", enforcement: "mandatory", title: "Every application has an accepted hosting decision", category: "Governance", severity: "high", status: "adopt",
    statement: "No application runs in production without an accepted architecture decision on where it is hosted and why.",
    rationale: "Residency, resilience and cost all follow from the hosting decision; it must exist before anything else can be checked against it.",
    control_refs: ["ISO 27001 A.5.8", "DORA Art.8(1)", "UK GDPR Art.44"],
    rule: { scope: "application", assert: { op: "hasDecision", topic: "hosting" } } },
  { code: "POL-GOV-02", kind: "policy", enforcement: "mandatory", title: "Exceptions to mandatory policies carry an expiry", category: "Governance", severity: "medium", status: "adopt",
    statement: "An exception granted against a mandatory policy or standard names its owner and an expiry date, and is re-reviewed before that date.",
    rationale: "Open-ended exceptions become the de-facto standard.", control_refs: ["ISO 27001 A.5.1", "DORA Art.6(8)"], rule: null },
];

export const GOVERNANCE_STARTER_PACK: StandardsPack = { id: "archigov-governance-starter", name: "Archigov governance starter: principles, patterns and policies", version: "1.0.0", lifecycle_on_import: "draft",
  description: "Three principles, two patterns and two policies an architecture function can adopt on day one. Imported as drafts for the governing board to review; two of them are checkable.",
  standards: GOVERNANCE_STARTER };
