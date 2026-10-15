import { db, j, uid, nowIso, audit, getSetting, setSetting } from "./db.js";
import { listElements, resourcesOf, getElement, type Element } from "./model.js";
import { allClassifications, classificationOf, type Classification } from "./classification.js";
import { LEGACY_RESULTS, assessmentMonths } from "./lifecycle.js";

/**
 * Third parties: which ICT providers the estate relies on, how concentrated critical and important applications are
 * on any one of them (especially a designated critical third party), and whether each critical reliance has an exit
 * plan (DORA Art. 28(8), PRA SS2/21 ch. 10).
 *
 * Derived, never typed in: the cloud platform comes from the resource type's namespace (Microsoft.* → Microsoft,
 * AWS / Google / Oracle likewise for imported resources), and named suppliers from `supplier`/`vendor`/`provider`
 * tags on resources. The critical-third-party designations are reference data with their legal source, editable by
 * the platform admin because HM Treasury designates on a rolling basis. An exit plan is a register assessment
 * (kind exit_plan, subject = the provider) recorded by a named author: adequacy, the written plan, substitutability
 * in the DORA ITS vocabulary and when it was last tested; valid for a year.
 */
export interface CtpEntry { provider: string; entity: string }
export interface CtpList { regime: string; instrument: string; effective: string; entries: CtpEntry[] }
/** The UK designations in force when this release was cut — HM Treasury may add more; the platform admin keeps the list current. */
export const DEFAULT_CTP: CtpList = {
  regime: "UK critical third parties regime (FSMA 2000 Part 18, as amended by FSMA 2023)",
  instrument: "The Critical Third Parties (Designation) Regulations 2026 (SI 2026/777)",
  effective: "2026-07-13",
  entries: [
    { provider: "aws", entity: "Amazon Web Services EMEA SARL" },
    { provider: "google", entity: "Google Cloud EMEA Limited" },
    { provider: "microsoft", entity: "Microsoft Ireland Operations Limited" },
    { provider: "oracle", entity: "Oracle Corporation UK Limited" },
  ],
};
export const ctpList = (): CtpList => { const s = j(getSetting("suppliers.ctp"), null) as CtpList | null; return s?.entries ? s : DEFAULT_CTP; };

export const PLATFORMS: Record<string, string> = { microsoft: "Microsoft", aws: "Amazon Web Services", google: "Google Cloud", oracle: "Oracle" };
const PLATFORM_OF: [RegExp, string][] = [[/^microsoft\./i, "microsoft"], [/^(aws|amazon)[:.]/i, "aws"], [/^(google|gcp)[:.]/i, "google"], [/^(oracle|oci)[:.]/i, "oracle"]];
const NAMED_AS_PLATFORM: [RegExp, string][] = [[/^(microsoft|azure)\b/i, "microsoft"], [/^(aws|amazon web services)\b/i, "aws"], [/^(google|gcp)\b/i, "google"], [/^(oracle|oci)\b/i, "oracle"]];
const SUPPLIER_KEYS = new Set(["supplier", "vendor", "provider", "third-party", "thirdparty", "saas"]);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export interface Reliance { provider: string; name: string; kind: "platform" | "supplier"; method: string }
/** The providers one resource relies on: its platform, and any supplier its tags name. */
export function providersOf(r: Element): Reliance[] {
  const out: Reliance[] = [];
  const t = r.subtype || "";
  const p = PLATFORM_OF.find(([re]) => re.test(t))?.[1];
  if (p) out.push({ provider: p, name: PLATFORMS[p], kind: "platform", method: "resource type" });
  for (const [k, v] of Object.entries(r.tags || {})) {
    if (!SUPPLIER_KEYS.has(k.trim().toLowerCase().replace(/_/g, "-"))) continue;
    for (const name of String(v).split(/[;,|]/).map((x) => x.trim()).filter(Boolean)) {
      const known = NAMED_AS_PLATFORM.find(([re]) => re.test(name))?.[1];
      const id = known ?? `supplier:${slug(name)}`;
      if (!out.some((o) => o.provider === id)) out.push({ provider: id, name: known ? PLATFORMS[known] : name.slice(0, 80), kind: known ? "platform" : "supplier", method: `tag:${k}` });
    }
  }
  return out;
}

export const SUBSTITUTABILITY = ["not_substitutable", "highly_complex", "medium_complexity", "easily_substitutable"] as const;
export const EXIT_TEMPLATE = `## Reliance

What the application uses this provider for, and what stops working if the provider fails or the contract ends.

## Exit triggers

The events that would start the exit: insolvency, sustained outage, regulatory instruction, material contract change.

## Exit strategy

Where the service moves (another provider, another region, in-house) under a planned exit and under a stressed one.

## Data and portability

How data, configuration and keys are extracted and in what formats; what does not port.

## Timeline and resources

How long each exit takes, who leads it, and what it costs.

## Testing

When the plan was last tested, how, and what the test showed.
`;
/** An application needs an exit plan for a provider when it is classified critical or important, or supports a regulated service. */
export const needsExitPlan = (c: Classification | null | undefined) => !!c && (c.criticality === "critical" || c.criticality === "important" || c.regulated);

const planRow = (a: any) => a ? { ...a, components_json: undefined, details: j(a.details_json, {}), details_json: undefined } : null;
export const latestExitPlan = (appId: string, provider: string) => planRow(db.prepare("SELECT * FROM register_assessments WHERE application_id=? AND kind='exit_plan' AND subject=? ORDER BY assessed_at DESC, rowid DESC LIMIT 1").get(appId, provider));
export type ExitStatus = "not_needed" | "due" | "current";
export interface AppReliance { provider: string; name: string; kind: string; ctp: CtpEntry | null; resources: number; methods: string[]; exit: { status: ExitStatus; last: any | null } }

/** One application's providers and, where it needs them, the standing of each exit plan. */
export function reliancesOf(app: Element, cls?: Classification | null): AppReliance[] {
  const c = cls === undefined ? classificationOf(app.id) : cls;
  const ctp = ctpList();
  const by = new Map<string, AppReliance>();
  for (const r of resourcesOf(app.id)) for (const rel of providersOf(r)) {
    const cur = by.get(rel.provider) || { provider: rel.provider, name: rel.name, kind: rel.kind, ctp: ctp.entries.find((e) => e.provider === rel.provider) ?? null, resources: 0, methods: [], exit: { status: "not_needed" as ExitStatus, last: null } };
    cur.resources++; if (!cur.methods.includes(rel.method)) cur.methods.push(rel.method);
    by.set(rel.provider, cur);
  }
  const need = needsExitPlan(c);
  for (const rel of by.values()) {
    const last = latestExitPlan(app.id, rel.provider);
    rel.exit = { status: !need ? "not_needed" : last && last.valid_until > nowIso() ? "current" : "due", last };
  }
  return [...by.values()].sort((a, b) => b.resources - a.resources || a.name.localeCompare(b.name));
}

export function recordExitPlan(appId: string, b: { provider: string; result: string; summary_md: string; reference?: string | null; substitutability: string; tested_at?: string | null }, actor: string) {
  const err = (status: number, message: string) => Object.assign(new Error(message), { status });
  const app = getElement(appId);
  if (!app || app.type !== "application") throw err(404, "application not found");
  const rel = reliancesOf(app).find((x) => x.provider === b.provider);
  if (!rel) throw err(400, `${app.name} does not rely on "${b.provider}"`);
  if (!(LEGACY_RESULTS as readonly string[]).includes(b.result)) throw err(400, `result must be one of ${LEGACY_RESULTS.join(", ")}`);
  if (!(SUBSTITUTABILITY as readonly string[]).includes(b.substitutability)) throw err(400, `substitutability must be one of ${SUBSTITUTABILITY.join(", ")}`);
  if (!b.summary_md || b.summary_md.trim().length < 10) throw err(400, "the exit plan needs a summary of at least 10 characters");
  if (b.reference && !/^https?:\/\//i.test(b.reference.trim())) throw err(400, "reference must be a link (http or https) to where the plan lives");
  if (b.tested_at && (Number.isNaN(Date.parse(b.tested_at)) || b.tested_at.slice(0, 10) > nowIso().slice(0, 10))) throw err(400, "tested_at must be a date, not in the future");
  const now = new Date(); const until = new Date(now); until.setUTCMonth(until.getUTCMonth() + assessmentMonths());
  const details = { substitutability: b.substitutability, tested_at: b.tested_at ? b.tested_at.slice(0, 10) : null, provider_name: rel.name };
  db.prepare("INSERT INTO register_assessments(id,kind,application_id,subject,result,summary_md,reference,components_json,assessed_by,assessed_at,valid_until,origin,details_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(uid(), "exit_plan", app.id, rel.provider, b.result, b.summary_md.trim(), b.reference?.trim() || null, "[]", actor, now.toISOString(), until.toISOString(), "human", JSON.stringify(details));
  audit(actor, "exit_plan:record", "applications", app.id, { application: app.name, provider: rel.provider, result: b.result, substitutability: b.substitutability, tested_at: details.tested_at, valid_until: until.toISOString(), reference: b.reference?.trim() || null });
  return reliancesOf(app);
}

/** The third-party view: providers with the applications on each, concentration of critical reliance, and exit plans. */
export function thirdParties() {
  const cls = allClassifications();
  const ctp = ctpList();
  const apps = listElements("application");
  const providers = new Map<string, any>();
  const plans: any[] = [];
  let needing = 0;
  for (const app of apps) {
    const c = cls.get(app.id) ?? null;
    const rels = reliancesOf(app, c);
    if (needsExitPlan(c)) needing++;
    for (const r of rels) {
      const p = providers.get(r.provider) || { id: r.provider, name: r.name, kind: r.kind, ctp: r.ctp, applications: [] as any[], resources: 0, regions: new Set<string>(), critical: 0, regulated_services: new Set<string>() };
      p.resources += r.resources;
      p.applications.push({ id: app.id, name: app.name, criticality: c?.criticality ?? null, regulated: !!c?.regulated, resources: r.resources });
      if (needsExitPlan(c)) p.critical++;
      for (const s of c?.services || []) if (["ibs", "cif", "essential_function"].includes(s.kind)) p.regulated_services.add(s.name);
      for (const res of resourcesOf(app.id)) if (providersOf(res).some((x) => x.provider === r.provider) && res.props.location) p.regions.add(String(res.props.location));
      providers.set(r.provider, p);
      if (r.exit.status !== "not_needed") plans.push({ application: { id: app.id, name: app.name, criticality: c?.criticality ?? null, regulated: !!c?.regulated }, provider: { id: r.provider, name: r.name, ctp: !!r.ctp }, status: r.exit.status, last: r.exit.last });
    }
  }
  const list = [...providers.values()].map((p) => ({ ...p, regions: [...p.regions].sort(), regulated_services: [...p.regulated_services].sort(), share: needing ? p.critical / needing : 0 }))
    .sort((a, b) => b.critical - a.critical || b.resources - a.resources || a.name.localeCompare(b.name));
  // concentration worth naming: one provider carries half or more of the critical and important applications
  const concentration = list.filter((p) => needing > 0 && p.critical / needing >= 0.5).map((p) => ({ provider: p.id, name: p.name, ctp: p.ctp, critical: p.critical, of: needing, share: p.critical / needing }));
  plans.sort((a, b) => (a.status === "due" ? 0 : 1) - (b.status === "due" ? 0 : 1) || a.application.name.localeCompare(b.application.name));
  return { ctp, providers: list, concentration, exit_plans: plans, counts: { providers: list.length, ctp_relied_on: list.filter((p) => p.ctp).length, critical_applications: needing, critical_on_ctp: new Set(list.filter((p) => p.ctp).flatMap((p) => p.applications.filter((a: any) => needsExitPlan(cls.get(a.id))).map((a: any) => a.id))).size, exit_plans_due: plans.filter((x) => x.status === "due").length } };
}

/** Replace the designations list (platform admin): HM Treasury designates on a rolling basis. */
export function setCtpList(b: any, actor: string): CtpList {
  const err = (m: string) => Object.assign(new Error(m), { status: 400 });
  if (!b || typeof b.instrument !== "string" || !b.instrument.trim()) throw err("instrument (the designating instrument) is required");
  if (!Array.isArray(b.entries) || b.entries.some((e: any) => !e || typeof e.provider !== "string" || !e.provider.trim() || typeof e.entity !== "string" || !e.entity.trim())) throw err("entries must be a list of {provider, entity}");
  const next: CtpList = { regime: String(b.regime || DEFAULT_CTP.regime).slice(0, 200), instrument: b.instrument.trim().slice(0, 300), effective: String(b.effective || "").slice(0, 10), entries: b.entries.map((e: any) => ({ provider: e.provider.trim().toLowerCase(), entity: e.entity.trim().slice(0, 200) })) };
  setSetting("suppliers.ctp", JSON.stringify(next));
  audit(actor, "ctp:set", "settings", null, { instrument: next.instrument, effective: next.effective, entries: next.entries.map((e) => e.entity) });
  return next;
}
