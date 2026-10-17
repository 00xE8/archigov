import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { db, j, nowIso, getSetting } from "../db.js";
import { listElements, resourcesOf } from "../model.js";
import { evidenceFor } from "../evidence.js";
import { std, fnd } from "../http.js";
import { buildArchimate, archimateXml } from "../exporters/archimate.js";
import { allClassifications, REGULATED_KINDS } from "../classification.js";
import { reliancesOf } from "../suppliers.js";
// B_07.01 substitutability, in the ITS vocabulary, from the latest exit plan for that application and provider
const SUBST_CELL: Record<string, string> = { not_substitutable: "Not substitutable", highly_complex: "Highly complex substitutability", medium_complexity: "Medium complexity in terms of substitutability", easily_substitutable: "Easily substitutable" };

/**
 * Machine-readable exports for the people who have to take evidence away:
 *   GET /exports/oscal         OSCAL 1.1.2 assessment-results (NIST) — observations per rule evaluation and per
 *                              imported assessment, one finding per checkable standard (objective-id = STD code)
 *   GET /exports/dora-roi.csv  a clearly-labelled simplified DORA register of information derived from the model
 *   GET /runs/:id              one run with the findings it opened, resolved or reopened
 * None of them asserts compliance; the wording says what was observed and who stands behind it.
 */
export const exportsRoutes = new Hono();

const DISCLAIMER = "Evidence, not assurance. This document records what archigov's derived model, imported compliance evidence, decision log and review workflow contained at generation time, with each item's verification state. Compliance conclusions are for the accountable humans and auditors.";
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// ---------- OSCAL assessment-results ----------
// Model reference: https://pages.nist.gov/OSCAL-Reference/models/v1.1.2/assessment-results/json-reference/ ; schema
// oscal_assessment-results_schema.json at https://github.com/usnistgov/OSCAL/releases/tag/v1.1.2 (authoritative for
// required fields). Required: assessment-results{uuid, metadata{title,last-modified,version,oscal-version},
// import-ap{href}, results[]{uuid,title,description,start,reviewed-controls{control-selections[≥1]}}};
// observation{uuid,description,methods[≥1],collected}; finding{uuid,title,description,target{type: statement-id|
// objective-id, target-id (token), status{state: satisfied|not-satisfied}}}. UUIDs are v4; date-times carry a zone.
exportsRoutes.get("/exports/oscal", (c) => {
  const appId = c.req.query("application") || null;
  const apps = listElements("application").filter((a) => !appId || a.id === appId);
  if (appId && apps.length === 0) return c.json({ error: "not found" }, 404);
  const now = nowIso();
  const tenant = getSetting("tenant.name", "Local tenant");
  // every adopted artefact of any kind that has a rule is a reviewed control; drafts and retired ones are not
  const standards = db.prepare("SELECT * FROM standards WHERE lifecycle='adopted' ORDER BY code").all().map(std);
  const lastRun = db.prepare("SELECT started_at, finished_at FROM runs WHERE kind='evaluate' AND status='done' ORDER BY started_at DESC LIMIT 1").get() as any;

  const observations: any[] = [];
  const observationsByStandard = new Map<string, string[]>();
  const findings = (db.prepare("SELECT f.*, s.code standard_code, s.kind artefact_kind, e.name element_name FROM findings f JOIN standards s ON s.id=f.standard_id LEFT JOIN elements e ON e.id=f.element_id WHERE f.status<>'resolved' ORDER BY s.code").all() as any[])
    .map(fnd).filter((f: any) => !appId || f.application_id === appId);
  for (const f of findings) {
    const uuid = randomUUID();
    observations.push({
      uuid, title: `${f.standard_code}: ${f.element_name || "application"}`,
      description: `${f.message}${f.status === "excepted" ? " (an active exception applies)" : ""}`,
      methods: ["TEST"], types: ["finding"], collected: f.last_seen || now,
      props: [{ name: "severity", value: f.severity }, { name: "status", value: f.status }, { name: "standard", value: f.standard_code }, { name: "artefact-kind", value: f.artefact_kind || "standard" }],
      remarks: `Rule evaluation over the derived model. Evidence: ${JSON.stringify(f.evidence)}`,
    });
    observationsByStandard.set(f.standard_code, [...(observationsByStandard.get(f.standard_code) || []), uuid]);
  }
  for (const a of apps) for (const r of resourcesOf(a.id)) for (const e of evidenceFor(r.id)) {
    observations.push({
      uuid: randomUUID(), title: `${e.source} · ${e.control} · ${r.name}`,
      description: `${e.detail?.assessment || e.control}: ${e.state} (assessment imported from ${e.source})`,
      methods: ["TEST"], types: ["control-objective"], collected: e.observed_at || now,
      props: [{ name: "source", value: e.source }, { name: "control", value: e.control }, { name: "state", value: e.state }, { name: "resource", value: r.source_ref || r.name }, { name: "application", value: a.name }],
    });
  }
  const oscalFindings = standards.filter((s: any) => s.rule).map((s: any) => {
    const open = findings.filter((f: any) => f.standard_code === s.code && f.status === "open").length;
    const related = observationsByStandard.get(s.code) || [];
    return {
      uuid: randomUUID(), title: `${s.code} ${s.title}`,
      description: open
        ? `${open} open finding(s) against this standard at generation time. ${DISCLAIMER}`
        : `No open findings against this checkable standard at generation time. This records the evaluation's output and the evidence behind it, not a determination by the entity.`,
      target: { type: "objective-id", "target-id": s.code, title: s.title, status: { state: open ? "not-satisfied" : "satisfied", reason: open ? "fail" : "pass" },
        props: (s.control_refs || []).map((ref: string) => ({ name: "control-reference", value: ref })) },
      ...(related.length ? { "related-observations": related.map((u) => ({ "observation-uuid": u })) } : {}),
    };
  });
  const doc = {
    "assessment-results": {
      uuid: randomUUID(),
      metadata: { title: `archigov assessment results — ${tenant}${appId ? ` — ${apps[0].name}` : ""}`, "last-modified": now, version: "1", "oscal-version": "1.1.2", remarks: DISCLAIMER },
      "import-ap": { href: "urn:archigov:assessment-plan:continuous-conformance", remarks: "archigov's continuous conformance evaluation (rule evaluation over the derived model plus imported Defender for Cloud / Azure Policy assessments) stands in for a separately authored assessment plan." },
      results: [{
        uuid: randomUUID(), title: "Continuous conformance evaluation",
        description: `${DISCLAIMER} Scope: ${appId ? `application ${apps[0].name}` : "whole tenant"}. Observations are rule evaluations and imported assessments; findings are one per checkable standard, with objective-id = the standard's code.`,
        start: lastRun?.started_at || now, end: lastRun?.finished_at || now,
        // the controls this result reviewed: every checkable standard, by its code (an NCName token)
        "reviewed-controls": { description: "Checkable archigov standards evaluated by rule or by imported assessment.",
          "control-selections": [{ "include-controls": standards.filter((s: any) => s.rule).map((s: any) => ({ "control-id": s.code })) }] },
        observations, findings: oscalFindings,
      }],
    },
  };
  c.header("Content-Disposition", `attachment; filename="archigov-oscal-assessment-results${appId ? `-${slug(apps[0].name)}` : ""}.json"`);
  return c.json(doc);
});

// ---------- DORA register of information (simplified) ----------
// The ESAs' ITS (Commission Implementing Regulation (EU) 2024/2956, EUR-Lex CELEX:32024R2956; EBA final report JC
// 2023/85) defines the register as linked templates B_01.01 … B_07.01 with a data point model. Column headers below
// carry the template.column codes they approximate: B_06.01 functions (0010 identifier, 0030 name, 0050 criticality),
// B_05.01 provider (0010 code, 0020 code type, 0050 legal name, 0080 HQ country), B_02.02 contractual arrangements
// (0010 reference, 0060 type of ICT services — Annex III closed list, left blank rather than invented, 0130 country of
// provision, 0140 storage of data, 0150 data at rest, 0160 data processing, 0170 sensitiveness, 0180 reliance) and
// B_07.01 substitutability. What the model derives on its own is the function/provider/service/location view;
// identifiers, contract references, LEIs, sensitiveness, reliance and substitutability are the entity's to fill.
// Countries are ISO 3166-1 alpha-2 as the ITS requires; Azure regions map to the country hosting them.
const COUNTRY: Record<string, string> = {
  uksouth: "GB", ukwest: "GB", westeurope: "NL", northeurope: "IE", francecentral: "FR", francesouth: "FR", germanywestcentral: "DE", germanynorth: "DE",
  swedencentral: "SE", switzerlandnorth: "CH", switzerlandwest: "CH", norwayeast: "NO", norwaywest: "NO", polandcentral: "PL", italynorth: "IT", spaincentral: "ES",
  belgiumcentral: "BE", austriaeast: "AT", eastus: "US", eastus2: "US", westus: "US", westus2: "US", westus3: "US", centralus: "US", northcentralus: "US", southcentralus: "US",
  canadacentral: "CA", canadaeast: "CA", australiaeast: "AU", australiasoutheast: "AU", japaneast: "JP", japanwest: "JP", southeastasia: "SG", eastasia: "HK", uaenorth: "AE", southafricanorth: "ZA", brazilsouth: "BR", global: "",
};
// resource families that hold customer data at rest (B_02.02.0140 "storage of data"); others are left blank, not "No"
const STORES_DATA = /^microsoft\.(storage|sql|dbfor|documentdb|cache|keyvault|compute\/disks|datalake|cosmos)/i;
const SERVICE_FAMILY: [RegExp, string][] = [
  [/^microsoft\.compute/i, "Cloud computing resources (IaaS)"], [/^microsoft\.web/i, "Application hosting (PaaS)"],
  [/^microsoft\.(sql|dbfor|documentdb|cache)/i, "Database and data storage services (PaaS)"], [/^microsoft\.storage/i, "Data storage"],
  [/^microsoft\.keyvault/i, "Security services (key and secret management)"], [/^microsoft\.network/i, "Network infrastructure"],
  [/^microsoft\.(cognitiveservices|machinelearning)/i, "Artificial intelligence services"], [/^microsoft\.apimanagement/i, "API management"],
  [/^microsoft\.(containerservice|app)/i, "Container platform (PaaS)"], [/^microsoft\.(insights|operationalinsights)/i, "Monitoring and logging"],
];
const serviceFamily = (subtype: string | null) => { const t = subtype || ""; for (const [re, name] of SERVICE_FAMILY) if (re.test(t)) return name; return t.split("/")[0].replace(/^Microsoft\./, "") || "Unclassified"; };
const csvCell = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

export const DORA_COLUMNS = [
  "B_06.01.0010_function_identifier", "B_06.01.0030_function_name", "B_06.01.0050_criticality_or_importance",
  "B_05.01.0050_provider_legal_name", "B_05.01.0010_provider_identification_code", "B_05.01.0020_provider_code_type", "B_05.01.0080_provider_hq_country",
  "B_02.02.0010_contractual_arrangement_reference", "B_02.02.0060_type_of_ict_services", "B_02.02.0130_country_of_provision", "B_02.02.0140_storage_of_data",
  "B_02.02.0150_data_at_rest_country", "B_02.02.0160_data_processing_country", "B_02.02.0170_data_sensitiveness", "B_02.02.0180_reliance_level",
  "B_07.01_substitutability",
  "archigov_application_id", "archigov_service_family", "archigov_region", "archigov_resource_count", "archigov_origin", "archigov_verification",
];
// B_06.01.0050 from the classification: "Critical or important" when the application supports a regulated service or
// is classified critical, "Not critical or important" when it is classified standard. Our "important" tier (material
// disruption) may or may not be a DORA important function, so it stays blank with the unclassified: the entity decides.
const CRIT_CELL: Record<string, string> = { critical: "Critical or important", standard: "Not critical or important" };
exportsRoutes.get("/exports/dora-roi.csv", (c) => {
  const apps = listElements("application");
  const cls = allClassifications();
  const lines = [
    `# Simplified register of information derived from the archigov model on ${nowIso()} for tenant ${getSetting("tenant.name", "Local tenant")}. Columns approximate ESAs ITS templates B_06.01 (functions), B_05.01 (ICT third-party service providers), B_02.02 (contractual arrangements, specific) and B_07.01 (assessments); the template.column code is in each header. This is NOT the official ITS/DPM layout (Commission Implementing Regulation (EU) 2024/2956). Function names and B_06.01.0050 criticality come from each application's classification in archigov (blank where nobody has classified it, and for the important tier). B_07.01 substitutability comes from the latest exit plan recorded in archigov for that application and provider (blank where there is none); suppliers named on resource tags get rows of their own. Function identifiers are generated; provider identification codes, contract references, Annex III service-type codes, sensitiveness and reliance are left blank for the entity to complete, never inferred. Evidence, not assurance.`,
    DORA_COLUMNS.join(","),
  ];
  apps.forEach((a, i) => {
    const k = cls.get(a.id);
    // the function is what the application supports: its critical or important functions where named, else the application itself
    const functions = (k?.services || []).filter((s) => REGULATED_KINDS.includes(s.kind)).map((s) => s.name);
    const functionName = functions.length ? functions.join("; ") : a.name;
    const groups = new Map<string, { family: string; location: string; n: number; criticality: string; storesData: boolean }>();
    for (const r of resourcesOf(a.id)) {
      const family = serviceFamily(r.subtype), location = String(r.props.location || "").toLowerCase();
      const key = `${family}|${location}`;
      const g = groups.get(key) || { family, location, n: 0, criticality: "", storesData: false };
      g.n++;
      if (STORES_DATA.test(r.subtype || "")) g.storesData = true;
      g.criticality = (k?.criticality && CRIT_CELL[k.criticality]) || "";
      groups.set(key, g);
    }
    const rels = reliancesOf(a, k ?? null);
    const subst = (provider: string) => SUBST_CELL[rels.find((r) => r.provider === provider)?.exit.last?.details?.substitutability ?? ""] ?? "";
    for (const g of groups.values()) {
      const country = g.location in COUNTRY ? COUNTRY[g.location] : "";
      lines.push([
        `F${i + 1}`, functionName, g.criticality,
        "Microsoft", "", "", "",
        "", "", country, g.storesData ? "Yes" : "", g.storesData ? country : "", country, "", "",
        subst("microsoft"),
        a.id, g.family, g.location, g.n, a.origin, a.verification,
      ].map(csvCell).join(","));
    }
    // suppliers named on the resources' tags are ICT third-party providers of their own; where and how they serve is the entity's to fill
    for (const r of rels.filter((x) => x.kind === "supplier")) lines.push([
      `F${i + 1}`, functionName, (k?.criticality && CRIT_CELL[k.criticality]) || "",
      r.name, "", "", "",
      "", "", "", "", "", "", "", "",
      subst(r.provider),
      a.id, "Third-party ICT service (named on resource tags)", "", r.resources, "derived", "unverified",
    ].map(csvCell).join(","));
  });
  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="archigov-dora-register-of-information.csv"`);
  return c.body(lines.join("\n") + "\n");
});

// ---------- ArchiMate model with generated viewpoints ----------
// Open Group Model Exchange File Format 3.0 (opens in Archi and the commercial tools). Per application the exporter
// derives a Deployment view and an Application usage view deterministically from the model — see exporters/archimate.ts.
exportsRoutes.get("/exports/archimate", (c) => {
  const appId = c.req.query("application") || null;
  let m;
  try { m = buildArchimate(appId); } catch (e: any) { return c.json({ error: e.message }, e.status === 404 ? 404 : 500); }
  c.header("Content-Type", "application/xml; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="archigov-archimate-${slug(m.scopeName)}.xml"`);
  return c.body(archimateXml(m));
});

// ---------- one run, with what it changed ----------
exportsRoutes.get("/runs/:id", (c) => {
  const r = db.prepare("SELECT r.*, s.name source_name FROM runs r LEFT JOIN sources s ON s.id=r.source_id WHERE r.id=?").get(c.req.param("id")) as any;
  if (!r) return c.json({ error: "not found" }, 404);
  const ch = j(r.changes_json, {}) || {};
  const load = (ids: unknown) => {
    const list = Array.isArray(ids) ? (ids as string[]) : [];
    const out: any[] = [];
    for (let i = 0; i < list.length; i += 500) {
      const chunk = list.slice(i, i + 500);
      out.push(...db.prepare(`SELECT f.id, f.severity, f.status, f.message, f.application_id, s.code standard_code, e.name element_name, a.name application_name
        FROM findings f JOIN standards s ON s.id=f.standard_id LEFT JOIN elements e ON e.id=f.element_id LEFT JOIN elements a ON a.id=f.application_id
        WHERE f.id IN (${chunk.map(() => "?").join(",")}) ORDER BY CASE f.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, s.code`).all(...chunk));
    }
    return out;
  };
  return c.json({ id: r.id, kind: r.kind, source_id: r.source_id, source_name: r.source_name || null, started_at: r.started_at, finished_at: r.finished_at, status: r.status, error: r.error || null,
    stats: j(r.stats_json, {}), changes: { opened: load(ch.opened), resolved: load(ch.resolved), reopened: load(ch.reopened) } });
});
