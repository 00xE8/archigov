import { db, audit } from "./db.js";
import { evaluateAll } from "./rules.js";
import { createArtefact } from "./artefacts.js";

/**
 * Standards packs: importable, versioned sets of architecture standards. A pack ships human statements,
 * control *references* and checkable rules — never the text of ISO or any other control body. The core pack is
 * what an empty instance needs before Conformance, pre-review and evidence packs mean anything; the demo seeds
 * the same definitions from here, so each standard has exactly one source of truth.
 */
export interface PackStandard {
  code: string; title: string; category: string; severity: string; status: string; statement: string; rationale: string; control_refs: string[]; rule: any | null;
  /** standard (default) | principle | pattern | policy */
  kind?: "standard" | "principle" | "pattern" | "policy";
  enforcement?: "mandatory" | "recommended"; context?: string; solution?: string; applicability?: string;
}
/** `lifecycle_on_import`: the core pack adopts immediately (a first run must be effective at once); every other pack lands as drafts for the governing board to review. */
export interface StandardsPack { id: string; name: string; description: string; version: string; standards: PackStandard[]; lifecycle_on_import?: "adopted" | "draft"; }

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

/** DORA-oriented architecture standards: the decisions, registers and resilience properties Articles 8, 9, 12 and 28 expect to be evidenced. */
export const DORA_STANDARDS: PackStandard[] = [
  { code: "STD-DORA-01", title: "Critical ICT services have an accepted hosting decision", category: "Governance", severity: "high", status: "adopt",
    statement: "Every application is covered by an accepted architecture decision on where and how it is hosted.",
    rationale: "The ICT risk management framework starts from a known, decided estate.",
    control_refs: ["DORA Art.8(1)", "DORA Art.8(2)", "DORA RTS on ICT risk management Art.3"],
    rule: { scope: "application", assert: { op: "hasDecision", topic: "hosting" } } },
  { code: "STD-DORA-02", title: "Critical data is backed up geo-redundantly", category: "Resilience", severity: "high", status: "adopt",
    statement: "Managed database services holding critical data use geo-redundant backup.",
    rationale: "Backup and restoration policies must survive the loss of a region.",
    control_refs: ["DORA Art.12(1)", "DORA Art.12(3)", "ISO 27001 A.8.13"],
    rule: { scope: "resource", match: { type: "Microsoft.DBforPostgreSQL/flexibleServers" }, assert: { path: "props.backup_geoRedundantBackup", op: "eq", value: "Enabled" } } },
  { code: "STD-DORA-03", title: "ICT third-party dependencies are registered", category: "Governance", severity: "medium", status: "adopt",
    statement: "Each application's ICT third-party service providers and the services they provide are recorded in the register of information and reviewed at least annually.",
    rationale: "The register of information is a DORA reporting obligation and the basis of concentration-risk analysis.",
    control_refs: ["DORA Art.28(3)", "DORA Art.28(9)", "ITS on the register of information (B_02.02, B_05.01)"], rule: null },
  { code: "STD-DORA-04", title: "Recovery objectives are decided per critical function", category: "Resilience", severity: "high", status: "adopt",
    statement: "Applications supporting critical or important functions have decided recovery time and recovery point objectives, and the design evidences how they are met.",
    rationale: "Response and recovery plans need objectives that were set deliberately, not inferred after an incident.",
    control_refs: ["DORA Art.11(2)", "DORA Art.11(6)", "DORA RTS on ICT risk management Art.26"], rule: null },
  { code: "STD-DORA-05", title: "Changes to critical ICT systems go through architecture review", category: "Governance", severity: "medium", status: "adopt",
    statement: "Material changes to applications supporting critical or important functions are reviewed by the Design Authority before release, and the approval records its conditions.",
    rationale: "ICT change management must be evidenced, including who approved what and on which conditions.",
    control_refs: ["DORA Art.9(4)(e)", "DORA RTS on ICT risk management Art.17"], rule: null },
  { code: "STD-DORA-06", title: "Legacy ICT systems are risk-assessed every year", category: "Governance", severity: "high", status: "adopt",
    statement: "Every application running a component past its vendor's standard support has a legacy ICT risk assessment that is less than a year old and covers each of those components.",
    rationale: "Legacy systems carry risk the rest of the estate does not; the assessment is yearly, and again when what is connected changes.",
    control_refs: ["DORA Art.8(7)"],
    rule: { scope: "application", assert: { op: "assessmentCurrent", kind: "legacy" } } },
  { code: "STD-DORA-07", title: "No ICT component runs past its end of life", category: "Resilience", severity: "high", status: "adopt",
    statement: "Operating systems, runtimes, database engines and Kubernetes versions are retired or upgraded before their vendor stops issuing security fixes; paid extended support counts until it ends.",
    rationale: "An unsupported component cannot be patched; the risk grows every month it stays.",
    control_refs: ["DORA Art.8(7)", "ISO 27001 A.8.8", "NIST SP 800-53 SA-22"],
    rule: { scope: "resource", assert: { op: "lifecycle", states: ["end_of_life"] } } },
  { code: "STD-DORA-08", title: "Critical reliance on a third party has an exit plan", category: "Resilience", severity: "high", status: "adopt",
    statement: "Every application supporting a critical or important function has, for each ICT provider it relies on, an exit plan less than a year old that states its substitutability and when it was last tested.",
    rationale: "Exit strategies must be documented, adequately tested and reviewed, so a provider's failure or a contract's end does not stop a critical function.",
    control_refs: ["DORA Art.28(8)", "ITS on the register of information (B_07.01)", "PRA SS2/21 ch.10"],
    rule: { scope: "application", assert: { op: "assessmentCurrent", kind: "exit_plan" } } },
];

/** EU AI Act Annex IV: the technical-documentation evidence a high-risk AI system's architecture must be able to produce. Manual, except the decision check. */
export const AI_ACT_STANDARDS: PackStandard[] = [
  { code: "STD-AIA-01", title: "AI systems are an accepted architecture decision", category: "AI", severity: "high", status: "adopt",
    statement: "An application that runs an AI service has an accepted architecture decision on the AI system: its purpose, model provider, data flows and oversight design.",
    rationale: "Annex IV documentation starts from a described, decided system.",
    control_refs: ["EU AI Act Annex IV §1", "EU AI Act Art.11", "ISO 42001 A.6.1.2"],
    rule: { scope: "application", assert: { op: "hasDecision", topic: "ai-system", type: "Microsoft.CognitiveServices" } } },
  { code: "STD-AIA-02", title: "Design specifications and development process are documented", category: "AI", severity: "medium", status: "adopt",
    statement: "The design records the system architecture, the computational resources, the training/validation approach where applicable and the general logic of the system.",
    rationale: "Required technical documentation for high-risk AI systems.",
    control_refs: ["EU AI Act Annex IV §2(a)", "EU AI Act Annex IV §2(b)", "EU AI Act Annex IV §2(c)"], rule: null },
  { code: "STD-AIA-03", title: "Human oversight measures are designed in", category: "AI", severity: "high", status: "adopt",
    statement: "The design specifies the human oversight measures: who reviews outputs, how outputs can be overridden or stopped, and how operators are enabled to understand them.",
    rationale: "Oversight is a design property, not an operating instruction added later.",
    control_refs: ["EU AI Act Annex IV §2(e)", "EU AI Act Art.14", "ISO 42001 A.9.2"], rule: null },
  { code: "STD-AIA-04", title: "Logging supports post-market monitoring", category: "AI", severity: "medium", status: "adopt",
    statement: "The system logs the events needed to trace its operation (inputs, outputs, model version, reviewer) for the retention the risk assessment requires.",
    rationale: "Record-keeping and post-market monitoring obligations depend on logs designed up front.",
    control_refs: ["EU AI Act Annex IV §3", "EU AI Act Art.12", "EU AI Act Art.72"], rule: null },
  { code: "STD-AIA-05", title: "Risk management and lifecycle changes are evidenced", category: "AI", severity: "medium", status: "adopt",
    statement: "The risk management measures and every relevant change to the system through its lifecycle are recorded against the architecture decision.",
    rationale: "A high-risk AI system's documentation must stay current as it changes.",
    control_refs: ["EU AI Act Annex IV §4", "EU AI Act Annex IV §5", "EU AI Act Art.9"], rule: null },
];

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

export const PACKS: StandardsPack[] = [
  { id: "archigov-core", name: "Archigov core architecture standards", version: "1.0.0", lifecycle_on_import: "adopted",
    description: "Five architecture-governance rules any estate can start with: UK hosting, accountable owners, data-store decisions and their conformance, and the technology radar. Resource-configuration checks are not here; they are imported from Defender for Cloud / Azure Policy as evidence. Imported as adopted so a first run is effective at once.",
    standards: CORE_STANDARDS },
  { id: "archigov-governance-starter", name: "Archigov governance starter: principles, patterns and policies", version: "1.0.0", lifecycle_on_import: "draft",
    description: "Three principles, two patterns and two policies an architecture function can adopt on day one. Imported as drafts for the governing board to review; two of them are checkable.",
    standards: GOVERNANCE_STARTER },
  { id: "azure-waf-architecture", name: "Azure Well-Architected architecture standards", version: "1.0.0", lifecycle_on_import: "draft",
    description: "Eight standards aligned to the Azure Well-Architected Framework checklists: transport security, data-store isolation, deletion protection, supported platforms, zone redundancy, private control planes and environment tagging. Platform checks assert on evidence imported from Defender for Cloud and Azure Policy.",
    standards: AZURE_WAF_STANDARDS },
  { id: "dora-ict-architecture", name: "DORA ICT risk — architecture standards", version: "1.1.0", lifecycle_on_import: "draft",
    description: "Eight standards covering what DORA Articles 8, 9, 11, 12 and 28 expect the architecture to evidence: hosting decisions, geo-redundant backup, the third-party register, recovery objectives, reviewed change, the yearly legacy assessment, no component past end of life, and an exit plan for each critical reliance on a provider. Five are checkable; three are evidenced through reviews.",
    standards: DORA_STANDARDS },
  { id: "ai-act-annex-iv-design", name: "EU AI Act Annex IV — design evidence", version: "1.0.0", lifecycle_on_import: "draft",
    description: "Five standards for the technical documentation a high-risk AI system's architecture must be able to produce: a decided system, design specifications, human oversight, logging and lifecycle risk management. References point at Annex IV sections; no regulation text is reproduced.",
    standards: AI_ACT_STANDARDS },
];

export const listPacks = () => PACKS.map((p) => ({ id: p.id, name: p.name, description: p.description, version: p.version, lifecycle_on_import: p.lifecycle_on_import || "draft",
  kinds: p.standards.reduce((m: Record<string, number>, s) => ((m[s.kind || "standard"] = (m[s.kind || "standard"] || 0) + 1), m), {}),
  standards: p.standards.map((s) => ({ code: s.code, title: s.title, kind: s.kind || "standard" })) }));
export const getPack = (id: string) => PACKS.find((p) => p.id === id) || null;

/** Insert the pack's artefacts that do not exist yet (by code), as adopted or as drafts per the pack. An imported artefact is unverified until someone stands behind it. */
export function importPack(pack: StandardsPack, actor: string) {
  const out = { imported: 0, skipped: 0, codes: [] as string[], lifecycle: pack.lifecycle_on_import || "draft" as "adopted" | "draft" };
  const exists = db.prepare("SELECT 1 FROM standards WHERE code=?");
  db.transaction(() => {
    for (const s of pack.standards) {
      if (exists.get(s.code)) { out.skipped++; continue; }
      createArtefact({ kind: s.kind || "standard", code: s.code, title: s.title, category: s.category, statement: s.statement, rationale: s.rationale, status: s.status, severity: s.severity, rule: s.rule,
        control_refs: s.control_refs, enforcement: s.enforcement ?? null, context: s.context ?? null, solution: s.solution ?? null, applicability: s.applicability ?? null }, actor, { lifecycle: out.lifecycle });
      out.imported++; out.codes.push(s.code);
    }
  })();
  audit(actor, "import_pack", "standards", pack.id, { pack: pack.id, version: pack.version, ...out });
  if (out.imported && out.lifecycle === "adopted") evaluateAll(actor);
  return out;
}
