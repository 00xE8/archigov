import { db, uid, nowIso, audit, setSetting } from "./db.js";
import { ingestResources, listElements, hashOf } from "./model.js";
import { DEMO_RESOURCES, DEMO_WORK_ITEMS } from "./collectors/demo.js";
import { evaluateAll } from "./rules.js";
import { loadDemoEvidence } from "./sync.js";
import { CORE_STANDARDS, type PackStandard } from "./packs.js";
import { createArtefact, type Lifecycle } from "./artefacts.js";

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString();
const daysAhead = (n: number) => new Date(Date.now() + n * 86400000).toISOString();

// Demo-only standards: the resource-configuration controls (consumed as imported evidence) and the principle.
// The five architecture rules (STD-001/005/006/006b/010) come from the core pack, so each has one definition.
type SeedArtefact = PackStandard & { lifecycle?: Lifecycle };
const DEMO_STANDARDS: SeedArtefact[] = [
  // Resource-configuration controls are *imported* from Defender for Cloud / Azure Policy as evidence; the standard
  // asserts on the imported state and never re-tests the configuration (see rule op "evidence").
  { code: "STD-002", title: "No anonymous public access to storage", category: "Security", severity: "critical", status: "adopt",
    statement: "Storage accounts never allow anonymous blob access. Evidence: the Defender for Cloud assessment \"Storage account public access should be disallowed\", imported per resource.",
    rationale: "Public blobs are the most common cause of healthcare data exposure. Defender already assesses this; we consume its result rather than rebuilding the check.",
    control_refs: ["ISO 27001 A.8.20", "NIST SP 800-53 AC-3", "DSPT 2025 B2.a", "Defender: storage-public-access"],
    rule: { scope: "resource", match: { type: "Microsoft.Storage/storageAccounts" }, assert: { op: "evidence", source: "defender", control: "storage-public-access", state: "pass" } } },
  { code: "STD-003", title: "TLS 1.2 or later everywhere", category: "Security", severity: "high", status: "adopt",
    statement: "Any service that terminates TLS enforces a minimum of TLS 1.2. Evidence: the Azure Policy compliance states \"Storage accounts should have the specified minimum TLS version\" and \"Azure SQL Database should be running TLS version 1.2 or newer\", and the Defender for Cloud assessment \"App Service apps should use the latest TLS version\", imported per resource.",
    rationale: "TLS 1.0 and 1.1 are deprecated and fail Cyber Essentials.",
    control_refs: ["ISO 27001 A.8.24", "Cyber Essentials: Secure configuration", "PCI DSS 4.0 4.2.1", "Azure Policy: min-tls-1.2", "Defender: min-tls-1.2"],
    // no `source`: whichever of Azure Policy (storage, SQL) or Defender (App Service) assesses the resource counts
    rule: { scope: "resource", match: { where: [{ path: "props.minTlsVersion", op: "exists" }] }, assert: { op: "evidence", control: "min-tls-1.2", state: "pass" } } },
  { code: "STD-004", title: "Windows Server 2012 and 2012 R2 are retired", category: "Technology radar", severity: "critical", status: "retire",
    statement: "No virtual machine runs an operating system past end of extended support. This is a technology-radar decision, checked directly on the derived model (the image SKU Resource Graph reports for each machine); neither Defender for Cloud nor Azure Policy assesses OS retirement, so there is nothing to import.",
    rationale: "Out-of-support OS has no security patches; it is a standing audit finding.",
    control_refs: ["ISO 27001 A.8.8", "Cyber Essentials: Security update management", "NIS2 Art.21(2)(e)", "Internal technology radar"],
    rule: { scope: "resource", match: { type: "Microsoft.Compute/virtualMachines" }, assert: { path: "props.osSku", op: "notIn", value: ["2012-R2-Datacenter", "2012-Datacenter", "2008-R2-SP1"] } } },
  { code: "STD-007", title: "Databases are not reachable from the internet", category: "Security", severity: "high", status: "adopt",
    statement: "Managed database services disable public network access and are reached over private endpoints. Evidence: the Defender for Cloud assessment \"Public network access should be disabled for PaaS databases\", imported per resource.",
    rationale: "Defence in depth for patient-identifiable data.",
    control_refs: ["ISO 27001 A.8.20", "NIST SP 800-53 SC-7", "DSPT 2025 B4.c", "Defender: db-public-network-access"],
    rule: { scope: "resource", match: { typeIn: ["Microsoft.Sql/servers", "Microsoft.DBforPostgreSQL/flexibleServers", "Microsoft.DocumentDB/databaseAccounts"] }, assert: { op: "evidence", source: "defender", control: "db-public-network-access", state: "pass" } } },
  { code: "STD-008", title: "Key Vaults have purge protection", category: "Resilience", severity: "medium", status: "adopt",
    statement: "All Key Vaults enable soft delete and purge protection. Evidence: the Azure Policy compliance state for \"Key vaults should have purge protection enabled\", imported per vault.",
    rationale: "Protects against destructive deletion of keys and secrets.",
    control_refs: ["ISO 27001 A.8.24", "NIST SP 800-53 SC-12", "Azure Policy: kv-purge-protection"],
    rule: { scope: "resource", match: { type: "Microsoft.KeyVault/vaults" }, assert: { op: "evidence", source: "azure_policy", control: "kv-purge-protection", state: "pass" } } },
  { code: "STD-009", title: "Azure OpenAI uses Entra ID only and no public access", category: "AI", severity: "high", status: "adopt",
    statement: "Azure OpenAI accounts disable local (key) authentication and public network access. Evidence: the Azure Policy compliance state for \"Cognitive Services accounts should have local authentication methods disabled\", imported per account.",
    rationale: "Prompt and completion traffic may carry patient data; access must be identity-bound and auditable.",
    control_refs: ["EU AI Act Art.12", "EU AI Act Art.15", "ISO 42001 A.6.2.6", "NIST AI RMF MAP 1.5", "Azure Policy: cognitive-local-auth"],
    rule: { scope: "resource", match: { type: "Microsoft.CognitiveServices/accounts", where: [{ path: "props.kind", op: "eq", value: "OpenAI" }] }, assert: { op: "evidence", source: "azure_policy", control: "cognitive-local-auth", state: "pass" } } },
  { code: "STD-011", title: "Web apps enforce HTTPS", category: "Security", severity: "medium", status: "adopt",
    statement: "App Service sites set HTTPS only. Evidence: the Azure Policy compliance state for \"Web Application should only be accessible over HTTPS\", imported per site.",
    rationale: "Baseline transport security.",
    control_refs: ["ISO 27001 A.8.24", "Cyber Essentials: Secure configuration", "Azure Policy: web-https-only"],
    rule: { scope: "resource", match: { type: "Microsoft.Web/sites" }, assert: { op: "evidence", source: "azure_policy", control: "web-https-only", state: "pass" } } },
  { code: "PRN-001", kind: "principle", title: "Principle: evidence, not assurance", category: "Principle", severity: "low", status: "adopt",
    statement: "The architecture repository records what was decided, by whom, on what evidence. It never asserts regulatory compliance; people do, on the evidence.",
    rationale: "Keeps accountability with the Design Authority and auditors.", control_refs: ["TOGAF Architecture Governance"], rule: null },
  // A pattern with a checkable constraint: every kind of artefact runs through the same engine.
  { code: "PAT-001", kind: "pattern", title: "Internet ingress only through a governed gateway", category: "Networking", severity: "high", status: "adopt",
    statement: "Workloads are reached from the internet only through a gateway the platform team governs (API Management, Application Gateway or Front Door); a public IP address exists only on such a gateway and is tagged purpose=gateway.",
    rationale: "A public IP on a virtual machine or database bypasses the WAF, the throttling policies and the ingress logging the gateways provide.",
    context: "Teams attach public IP addresses to virtual machines and services for convenience (RDP, quick tests, partner access), creating ingress paths nobody reviews.",
    solution: "Front every internet-facing workload with a governed gateway; delete direct public IPs or, where a gateway itself needs one, tag it purpose=gateway so the exception is explicit and visible.",
    applicability: "All production and staging virtual networks; hub-network gateways carry the tag by construction.",
    control_refs: ["ISO 27001 A.8.20", "NIST SP 800-53 SC-7", "Cyber Essentials: Firewalls", "Azure WAF Security: network isolation"],
    rule: { scope: "resource", match: { type: "Microsoft.Network/publicIPAddresses" }, assert: { path: "tags.purpose", op: "in", value: ["gateway", "ingress"] } } },
  // A mandatory policy with a checkable rule, and a draft policy that still has to go through its board.
  { code: "POL-001", kind: "policy", enforcement: "mandatory", title: "AI systems are decided before they process patient data", category: "AI", severity: "high", status: "adopt",
    statement: "An application that owns an Azure OpenAI or other Cognitive Services account has an accepted architecture decision on that AI system before it processes patient data.",
    rationale: "High-risk AI use needs a recorded decision with human oversight, logging and a hazard log before go-live.",
    control_refs: ["EU AI Act Art.9", "EU AI Act Art.14", "DCB0129", "ISO 42001 A.6.1.2"],
    rule: { scope: "application", assert: { op: "hasDecision", topic: "ai-system", type: "Microsoft.CognitiveServices" } } },
  { code: "POL-002", kind: "policy", enforcement: "mandatory", lifecycle: "draft", title: "Exceptions to mandatory policies expire within 180 days", category: "Governance", severity: "medium", status: "adopt",
    statement: "An exception granted against a mandatory policy or standard carries an owner and an expiry no more than 180 days out, and is re-reviewed before it lapses.",
    rationale: "Open-ended exceptions become the de-facto standard; a bounded one forces the conversation to happen again.",
    control_refs: ["ISO 27001 A.5.1", "DORA Art.6(8)"], rule: null },
];
const STANDARDS: SeedArtefact[] = [...CORE_STANDARDS, ...DEMO_STANDARDS];

export function seedDemo(actor = "seed") {
  const now = nowIso();
  const existing = db.prepare("SELECT count(*) c FROM elements").get() as any;
  if (existing.c > 0) return { skipped: true };

  // sources
  const demoSourceId = uid();
  db.prepare("INSERT INTO sources(id,kind,name,config_json,status,last_sync_at,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(demoSourceId, "demo-azure", "Demo Azure tenant (St Edmund's Health)", JSON.stringify({ subscriptions: ["4c1f0f0a-...-demo00000001"] }), "ok", now, now);
  const adoSourceId = uid();
  db.prepare("INSERT INTO sources(id,kind,name,config_json,status,last_sync_at,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(adoSourceId, "demo-ado", "Demo Azure DevOps (sehealth/Clinical-Platform)", JSON.stringify({ org: "sehealth", project: "Clinical-Platform" }), "ok", now, now);

  // governance artefacts — adopted by the Design Authority chair, so they carry a real verifier and the hash they verified;
  // a draft (POL-002) is the author's claim awaiting its board
  const stdId: Record<string, string> = {};
  for (const s of STANDARDS) {
    // already present (e.g. the core pack was imported before the demo estate was loaded): keep it, reference it
    const present = db.prepare("SELECT id FROM standards WHERE code=?").get(s.code) as any;
    if (present) { stdId[s.code] = present.id; continue; }
    const lifecycle: Lifecycle = s.lifecycle || "adopted";
    const r = createArtefact({ kind: s.kind || "standard", code: s.code, title: s.title, category: s.category, statement: s.statement, rationale: s.rationale, status: s.status, severity: s.severity, rule: s.rule,
      owner: "Design Authority", control_refs: s.control_refs, enforcement: s.enforcement ?? null, context: s.context ?? null, solution: s.solution ?? null, applicability: s.applicability ?? null }, "j.duduka",
      lifecycle === "adopted" ? { lifecycle, verification: "verified", verified_by: "j.duduka", verified_at: daysAgo(30), created_at: daysAgo(120) } : { lifecycle, created_at: daysAgo(3) });
    stdId[s.code] = r.id;
  }

  // derived model, then the Defender / Azure Policy assessments imported as evidence against it
  const stats = ingestResources(demoSourceId, DEMO_RESOURCES, actor);
  loadDemoEvidence(actor);
  const apps = listElements("application");
  const app = (name: string) => apps.find((a) => a.name.toLowerCase().replace(/\s+/g, "-") === name)?.id || apps.find((a) => a.name.toLowerCase().includes(name.split("-")[0]))?.id!;

  // verify a few things a human would have confirmed already
  for (const a of apps.filter((x) => ["Patientflow", "Intranet", "Identity Platform"].includes(x.name)))
    db.prepare("UPDATE elements SET verification='verified', verified_by=?, verified_at=?, verified_hash=content_hash WHERE id=?").run("j.duduka", daysAgo(10), a.id);
  db.prepare("UPDATE elements SET name='PatientFlow' WHERE name='Patientflow'").run();

  // decisions
  const insD = db.prepare(`INSERT INTO decisions(id,code,title,status,topic,context_md,options_json,decision_md,consequences_md,constraint_json,application_ids_json,standard_ids_json,author,origin,verification,verified_by,verified_at,created_at,updated_at,decided_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const dPF = uid(), dRef = uid(), dRegion = uk(), dAI = uid(), dAppt = uid();
  function uk() { return uid(); }
  insD.run(dRegion, "ADR-0001", "Production hosting is UK South with UK West for DR", "accepted", "hosting",
    "We hold patient-identifiable data and our regulator expects UK residency. Two UK regions exist.",
    JSON.stringify([{ name: "UK South + UK West", pros: "Residency, paired region", cons: "Smaller service catalogue" }, { name: "West Europe", pros: "Full catalogue", cons: "Fails residency expectation" }]),
    "All production workloads run in UK South; DR in UK West. Existing West Europe workloads migrate by Q2.",
    "Finance ERP must move (epic 1081). Some preview services unavailable.", null, JSON.stringify(apps.map((a) => a.id)), JSON.stringify([stdId["STD-001"]]),
    "j.duduka", "human", "verified", "j.duduka", daysAgo(90), daysAgo(95), daysAgo(90), daysAgo(90));
  insD.run(dPF, "ADR-0002", "PatientFlow uses PostgreSQL Flexible Server as its system of record", "accepted", "data-store",
    "PatientFlow needs relational integrity, zone redundancy and point-in-time restore. The team proposed Cosmos DB for scale.",
    JSON.stringify([{ name: "PostgreSQL Flexible Server", pros: "Relational, HA, team skills", cons: "Vertical scaling" }, { name: "Cosmos DB", pros: "Global scale", cons: "Cost, consistency model, no clinical-safety precedent" }, { name: "Azure SQL", pros: "Familiar", cons: "Licence cost" }]),
    "PostgreSQL Flexible Server (zone-redundant HA, geo-redundant backup). No other database services for this application without a superseding ADR.",
    "Any cache must be in-memory (Redis) and non-authoritative.", JSON.stringify({ allowedTypes: ["Microsoft.DBforPostgreSQL/flexibleServers"] }),
    JSON.stringify([app("patientflow")]), JSON.stringify([stdId["STD-006"], stdId["STD-006b"]]),
    "a.okafor", "human", "verified", "j.duduka", daysAgo(60), daysAgo(70), daysAgo(60), daysAgo(60));
  insD.run(dRef, "ADR-0003", "Referral API exposes FHIR R4 through API Management", "accepted", "integration",
    "External partners need a stable, authenticated referral interface.",
    JSON.stringify([{ name: "APIM + FHIR R4", pros: "Standard, policy enforcement", cons: "APIM cost" }, { name: "Direct app service", pros: "Simple", cons: "No throttling or auth policy" }]),
    "All external access via APIM with OAuth2 client credentials; FHIR R4 resources only.", "APIM becomes a critical dependency.", null,
    JSON.stringify([app("referral-api")]), JSON.stringify([]), "m.hughes", "human", "verified", "j.duduka", daysAgo(40), daysAgo(45), daysAgo(40), daysAgo(40));
  insD.run(dAI, "ADR-0004", "Clinical summarisation runs on Azure OpenAI with human sign-off", "proposed", "ai-system",
    "Epic 1063 introduces an AI system that drafts discharge summaries. It is high-risk under the EU AI Act framing we adopted and needs a DCB0129 hazard log.",
    JSON.stringify([{ name: "Azure OpenAI in-tenant, human-in-the-loop", pros: "Data stays in tenant, auditable", cons: "Cost" }, { name: "Third-party SaaS summariser", pros: "Faster", cons: "Data leaves tenant; supplier assurance" }]),
    "Proposed: Azure OpenAI with Entra-only auth, private endpoint, every output reviewed and signed by a clinician before it enters the record; prompts and outputs logged for 7 years.",
    "Needs STD-009 conformance (currently failing) and a hazard log before go-live.", JSON.stringify({ allowedTypes: ["Microsoft.CognitiveServices/accounts"] }),
    JSON.stringify([app("data-platform")]), JSON.stringify([stdId["STD-009"]]), "a.okafor", "human", "unverified", null, null, daysAgo(5), daysAgo(5), null);
  insD.run(dAppt, "ADR-0005", "Appointments keeps Azure SQL until re-platforming", "accepted", "data-store",
    "Appointments is a .NET Framework app on Azure SQL. Re-platforming is planned for next year.",
    JSON.stringify([{ name: "Keep Azure SQL", pros: "No migration risk now", cons: "Two database platforms" }, { name: "Move to PostgreSQL now", pros: "Consolidation", cons: "Risk during winter pressures" }]),
    "Keep Azure SQL; revisit at re-platforming. TLS must be raised to 1.2 (condition).", "Exception to the PostgreSQL preference until Q4.", JSON.stringify({ allowedTypes: ["Microsoft.Sql/servers"] }),
    JSON.stringify([app("appointments")]), JSON.stringify([stdId["STD-006"]]), "m.hughes", "human", "verified", "j.duduka", daysAgo(20), daysAgo(25), daysAgo(20), daysAgo(20));

  // reviews
  const insR = db.prepare(`INSERT INTO reviews(id,code,title,application_id,decision_id,work_item_id,risk_tier,stage,summary,design_md,submitted_by,created_at,updated_at,decided_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insE = db.prepare(`INSERT INTO review_events(id,review_id,kind,actor,body_md,data_json,origin,verification,verified_by,verified_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const insC = db.prepare(`INSERT INTO conditions(id,review_id,text,owner,due_at,status,created_at,closed_at) VALUES (?,?,?,?,?,?,?,?)`);

  const r1 = uid();
  insR.run(r1, "REV-0007", "Appointments: SMS reminders via third-party gateway", app("appointments"), null, null, "high", "in_review",
    "Send appointment reminders through an external SMS gateway. Patient mobile numbers and appointment times leave the tenant.",
    "## Design\n\nAppointments publishes a `ReminderDue` event to Service Bus. A new function app calls the gateway's REST API over TLS 1.2 with an API key held in Key Vault.\n\n## Data\n\nMobile number, first name, appointment date/time, clinic name. No clinical detail.\n\n## Supplier\n\nUK-based gateway, ISO 27001 certified, data processed in UK South.",
    "s.patel", daysAgo(6), daysAgo(1), null);
  insE.run(uid(), r1, "submitted", "s.patel", "Submitted for Design Authority review.", "{}", "human", "verified", null, null, daysAgo(6));
  insE.run(uid(), r1, "comment", "j.duduka", "DPIA reference needed before approval. Please confirm the gateway's sub-processors.", "{}", "human", "verified", null, null, daysAgo(2));

  const r2 = uid();
  insR.run(r2, "REV-0006", "Referral API: managed document service for attachments", app("referral-api"), null, null, "medium", "approved_with_conditions",
    "Replace the public storage account with a managed document service with retention and audit.",
    "## Design\n\nAttachments move to a managed document service with private endpoint, 10-year retention, legal hold and audit log export to the SIEM.",
    "m.hughes", daysAgo(20), daysAgo(12), daysAgo(12));
  insE.run(uid(), r2, "submitted", "m.hughes", null, "{}", "human", "verified", null, null, daysAgo(20));
  insE.run(uid(), r2, "approve", "j.duduka", "Approved with conditions. Public access on streferralattach must be removed before cut-over.", JSON.stringify({ conditions: 2 }), "human", "verified", null, null, daysAgo(12));
  insC.run(uid(), r2, "Disable anonymous blob access on streferralattach", "m.hughes", daysAgo(2), "overdue", daysAgo(12), null);
  insC.run(uid(), r2, "Raise sql-referrals minimum TLS to 1.2", "m.hughes", daysAhead(10), "open", daysAgo(12), null);

  const r3 = uid();
  insR.run(r3, "REV-0008", "Clinical note summarisation with Azure OpenAI", app("data-platform"), dAI, null, "high", "submitted",
    "AI-assisted discharge summary drafting. High-risk AI use.",
    "## Design\n\nClinicians trigger summarisation from the EPR. The function retrieves notes, calls Azure OpenAI (gpt-4o) in-tenant, and returns a draft to a review screen. Nothing is written to the record without clinician sign-off.\n\n## Oversight\n\nEvery output carries the model version, prompt hash and reviewer identity.\n\n## Logging\n\nPrompts and completions retained 7 years in the data lake.",
    "a.okafor", daysAgo(1), daysAgo(1), null);
  insE.run(uid(), r3, "submitted", "a.okafor", null, "{}", "human", "verified", null, null, daysAgo(1));

  const r4 = uid();
  insR.run(r4, "REV-0005", "PatientFlow: add Cosmos DB read cache", app("patientflow"), dPF, null, "medium", "rejected",
    "Add Cosmos DB as a read cache for the arrivals board.", "## Design\n\nCosmos DB account with change feed from PostgreSQL.", "t.nguyen", daysAgo(35), daysAgo(30), daysAgo(30));
  insE.run(uid(), r4, "submitted", "t.nguyen", null, "{}", "human", "verified", null, null, daysAgo(35));
  insE.run(uid(), r4, "reject", "j.duduka", "Rejected: contradicts ADR-0002 (cache must be in-memory and non-authoritative). Use Azure Cache for Redis.", "{}", "human", "verified", null, null, daysAgo(30));

  // exception: Finance ERP region, expired
  db.prepare(`INSERT INTO exceptions(id,standard_id,application_id,element_id,reason,approved_by,expires_at,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(uid(), stdId["STD-001"], app("finance-erp"), null, "ERP vendor only supported West Europe at the time; migration planned (epic 1081).", "j.duduka", daysAgo(15), "active", daysAgo(100));
  db.prepare(`INSERT INTO exceptions(id,standard_id,application_id,element_id,reason,approved_by,expires_at,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(uid(), stdId["STD-010"], app("appointments"), null, "Re-platforming scheduled; see ADR-0005.", "j.duduka", daysAhead(120), "active", daysAgo(20));

  // work items
  const insW = db.prepare(`INSERT INTO work_items(id,source_id,external_id,type,title,state,area,description,tags_json,application_id,decision_id,review_id,content_hash,approved_hash,material_change,changed_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const w of DEMO_WORK_ITEMS) {
    const h = hashOf([w.title, w.description]);
    let decision: string | null = null, review: string | null = null, approvedHash: string | null = null, material = 0;
    if (w.external_id === "1042") { review = r2; approvedHash = hashOf([w.title, "Move referral attachments to a managed document service with retention and audit."]); material = 1; }
    if (w.external_id === "1063") { decision = dAI; review = r3; }
    if (w.external_id === "1077") { review = r1; }
    if (w.external_id === "1081") { decision = dRegion; }
    insW.run(uid(), adoSourceId, w.external_id, w.type, w.title, w.state, w.area, w.description, JSON.stringify(w.tags), w.app ? app(w.app) : null, decision, review, h, approvedHash, material, daysAgo(Math.floor(Math.random() * 10) + 1), daysAgo(30));
  }

  setSetting("tenant.name", "St Edmund's Health (demo)");
  setSetting("demo.loaded", now);
  audit(actor, "seed", "tenant", null, stats);
  const ev = evaluateAll(actor);
  return { skipped: false, ingest: stats, evaluate: ev };
}
