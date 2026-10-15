import { db, j, uid, nowIso, audit, getSetting, setSetting } from "./db.js";
import { listElements, resourcesOf, getElement, type Element } from "./model.js";
import { BUNDLED_SNAPSHOT } from "./lifecycle/snapshot.js";

/**
 * The legacy register: which lifecycle-tracked components each resource runs (an OS image, a runtime stack, a
 * database engine, a Kubernetes version), where each stands against its vendor's support dates, and whether each
 * application with legacy components has had its yearly risk assessment (DORA Art. 8(7)).
 *
 * Deterministic end to end. Components are DERIVED from facts collection already holds (image sku/offer, App
 * Service linuxFxVersion / netFrameworkVersion, engine versions, kubernetesVersion) and resolved against a lifecycle
 * snapshot from endoflife.date (bundled, refreshable by the platform admin); a person corrects a resource's
 * components with a reason (origin human, never overwritten by collection). Nothing is guessed: a component whose
 * version is not in the snapshot, or a tracked resource that carries no version fact, is "unknown" and says so.
 *
 * States, worst last: supported → ending (end of support within the warning window) → extended (past standard
 * support, inside a paid extended-support window) → end_of_life. "Legacy" means extended or end of life.
 */
export const LIFECYCLE_STATES = ["supported", "ending", "extended", "end_of_life"] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number] | "unknown";
export const LEGACY_STATES: LifecycleState[] = ["extended", "end_of_life"];
const RANK: Record<LifecycleState, number> = { unknown: 0, supported: 1, ending: 2, extended: 3, end_of_life: 4 };
export const worse = (a: LifecycleState, b: LifecycleState) => (RANK[b] > RANK[a] ? b : a);

export interface Cycle { cycle: string; label?: string; release?: string; support?: string | boolean; eol?: string | boolean; extended?: string | boolean; lts?: boolean }
export interface Snapshot { source: string; licence: string; url: string; fetched_at: string; products: Record<string, { label: string; cycles: Cycle[] }> }
export const PRODUCTS = Object.keys((BUNDLED_SNAPSHOT as Snapshot).products);

let cached: Snapshot | null = null;
/** The lifecycle dates in force: the platform admin's refreshed snapshot, else the one bundled with the release. */
export function snapshot(): Snapshot {
  if (!cached) { const s = j(getSetting("lifecycle.snapshot"), null) as Snapshot | null; cached = s?.products ? s : (BUNDLED_SNAPSHOT as Snapshot); }
  return cached;
}
export const warnDays = () => Math.max(0, Number(getSetting("lifecycle.warn_days")) || 365);
export const assessmentMonths = () => Math.max(1, Number(getSetting("lifecycle.assessment_months")) || 12);

const day = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
/** Where one release cycle stands on `today` (YYYY-MM-DD). */
export function stateOfCycle(c: Cycle, today = nowIso().slice(0, 10), warn = warnDays()): LifecycleState {
  const eol = day(c.eol), ext = day(c.extended);
  if (c.eol === true || (eol && eol <= today)) return ext && ext > today ? "extended" : "end_of_life";
  if (eol && (Date.parse(eol) - Date.parse(today)) / 86_400_000 <= warn) return "ending";
  return "supported";
}

// ---------- matching ----------
export interface Component {
  product: string; product_label: string; cycle: string | null; label: string | null; state: LifecycleState;
  eol: string | null; extended: string | null; support: string | null; method: string; evidence: Record<string, unknown>; origin: "derived" | "human";
}
interface Match { product: string; key: string; method: string; evidence: Record<string, unknown>; note?: string }
const TRACKED = new Set(["microsoft.compute/virtualmachines", "microsoft.web/sites", "microsoft.dbforpostgresql/flexibleservers", "microsoft.dbformysql/flexibleservers", "microsoft.containerservice/managedclusters"]);
export const isTracked = (r: Element) => TRACKED.has((r.subtype || "").toLowerCase());

/** The components a resource's collected facts name — never a guess beyond what the fact says. */
export function matchComponents(r: Element): Match[] {
  const t = (r.subtype || "").toLowerCase(), p = r.props || {};
  const out: Match[] = [];
  if (t === "microsoft.compute/virtualmachines") {
    const sku = String(p.osSku ?? p.storageProfile_imageReference_sku ?? ""), offer = String(p.storageProfile_imageReference_offer ?? "");
    const ev = { ...(sku ? { sku } : {}), ...(offer ? { offer } : {}) };
    const sqlImage = offer.match(/sql(\d{4})(?:sp\d+)?-ws(\d{4})/i);
    if (sqlImage) { out.push({ product: "mssqlserver", key: sqlImage[1], method: "image offer", evidence: ev }); out.push({ product: "windows-server", key: sqlImage[2], method: "image offer", evidence: ev }); }
    const sw = String(p.software ?? "").match(/sql server (\d{4}(?: r2)?)/i);
    if (sw && !sqlImage) out.push({ product: "mssqlserver", key: sw[1], method: "software", evidence: { software: p.software } });
    const win = sku.match(/^(\d{4})(-r2)?[-_]/i);
    if (!sqlImage && (win || /windowsserver/i.test(offer))) { if (win) out.push({ product: "windows-server", key: `${win[1]}${win[2] ? "-r2" : ""}`, method: "image sku", evidence: ev }); }
    else if (/ubuntu/i.test(offer + sku)) { const m = `${offer} ${sku}`.match(/(\d{2})[._](\d{2})/); if (m) out.push({ product: "ubuntu", key: `${m[1]}.${m[2]}`, method: "image offer/sku", evidence: ev }); }
    else if (/rhel|redhat/i.test(offer)) { const m = sku.match(/^(\d+)/); if (m) out.push({ product: "rhel", key: m[1], method: "image sku", evidence: ev }); }
    else if (/debian/i.test(offer + sku)) { const m = `${offer} ${sku}`.match(/debian-?(\d+)/i) || sku.match(/^(\d+)/); if (m) out.push({ product: "debian", key: m[1], method: "image offer/sku", evidence: ev }); }
  } else if (t === "microsoft.web/sites") {
    const fx = String(p.siteConfig_linuxFxVersion ?? ""), [stack, ver = ""] = fx.split("|");
    const ev = { linuxFxVersion: fx }, S = (stack || "").toUpperCase(), major = ver.match(/^(\d+)/)?.[1];
    if ((S === "DOTNETCORE" || S === "DOTNET") && major) out.push({ product: "dotnet", key: Number(major) >= 5 ? major : ver.match(/^\d+\.\d+/)?.[0] || major, method: "runtime stack", evidence: ev });
    else if (S === "NODE" && major) out.push({ product: "nodejs", key: major, method: "runtime stack", evidence: ev });
    else if (S === "PYTHON" && ver) out.push({ product: "python", key: ver.match(/^\d+\.\d+/)?.[0] || ver, method: "runtime stack", evidence: ev });
    else if (S === "PHP" && ver) out.push({ product: "php", key: ver.match(/^\d+\.\d+/)?.[0] || ver, method: "runtime stack", evidence: ev });
    else if ((S === "JAVA" || S === "TOMCAT" || S === "JBOSSEAP") && major) out.push({ product: "microsoft-build-of-openjdk", key: (ver.match(/java(\d+)/i)?.[1]) || major, method: "runtime stack", evidence: ev });
    const nf = String(p.siteConfig_netFrameworkVersion ?? "").match(/^v(\d+)\.\d+$/i);
    if (!out.length && nf && Number(nf[1]) >= 5) out.push({ product: "dotnet", key: nf[1], method: "runtime (Windows)", evidence: { netFrameworkVersion: p.siteConfig_netFrameworkVersion } });
  } else if (t === "microsoft.dbforpostgresql/flexibleservers") {
    const v = String(p.version ?? "").match(/^(\d+(?:\.\d+)?)/)?.[1];
    if (v) out.push({ product: "postgresql", key: Number(v) >= 10 ? String(Math.floor(Number(v))) : v, method: "engine version", evidence: { version: p.version }, note: "community dates; Azure may offer extended support" });
  } else if (t === "microsoft.dbformysql/flexibleservers") {
    const v = String(p.version ?? "").match(/^(\d+\.\d+)/)?.[1];
    if (v) out.push({ product: "mysql", key: v, method: "engine version", evidence: { version: p.version } });
  } else if (t === "microsoft.containerservice/managedclusters") {
    const v = String(p.kubernetesVersion ?? "").match(/^(\d+\.\d+)/)?.[1];
    if (v) out.push({ product: "azure-kubernetes-service", key: v, method: "kubernetes version", evidence: { kubernetesVersion: p.kubernetesVersion } });
  }
  return out;
}

/** A product's cycle for a key. SQL Server is named by year; its service packs are separate cycles, so the latest one is assumed (and said). */
function resolveCycle(product: string, key: string): { cycle: Cycle | null; note?: string } {
  const prod = snapshot().products[product];
  if (!prod) return { cycle: null };
  const exact = prod.cycles.find((c) => c.cycle.toLowerCase() === key.toLowerCase());
  if (exact) return { cycle: exact };
  if (product === "mssqlserver") {
    const year = key.toLowerCase();
    const cand = prod.cycles.filter((c) => (c.label || "").toLowerCase().startsWith(year) && !/azure connect/i.test(c.label || "") && (year.includes("r2") || !/\br2\b/i.test(c.label || "")));
    const best = cand.sort((a, b) => String(day(b.eol) ?? "").localeCompare(String(day(a.eol) ?? "")))[0];
    if (best) return { cycle: best, note: "latest service pack assumed" };
  }
  return { cycle: null };
}

/** A cycle's display label without the product name the source repeats ("Windows Server 2012 R2" → "2012 R2"). */
const cycleLabel = (productLabel: string, c: Cycle) => (c.label || c.cycle).replace(new RegExp(`^${productLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+`, "i"), "") || c.cycle;
const componentOf = (product: string, key: string | null, method: string, evidence: Record<string, unknown>, origin: "derived" | "human", today: string, warn: number, note?: string): Component => {
  const prod = snapshot().products[product];
  const r = key ? resolveCycle(product, key) : { cycle: null };
  const c = r.cycle;
  return { product, product_label: prod?.label || product, cycle: c?.cycle ?? key, label: c ? cycleLabel(prod?.label || product, c) : key, state: c ? stateOfCycle(c, today, warn) : "unknown",
    eol: c ? day(c.eol) ?? (c.eol === true ? "ended" : null) : null, extended: c ? day(c.extended) : null, support: c ? day(c.support) : null,
    method: [method, r.note || note].filter(Boolean).join("; "), evidence, origin };
};

export interface ResourceLifecycle { tracked: boolean; components: Component[]; state: LifecycleState; origin: "derived" | "human"; override: { reason: string; set_by: string; set_at: string } | null }
/** One resource's components and its worst state; a person's override replaces the derived components outright. */
export function lifecycleOf(r: Element, overrides?: Map<string, any>, today = nowIso().slice(0, 10), warn = warnDays()): ResourceLifecycle {
  const o = overrides ? overrides.get(r.id) : db.prepare("SELECT * FROM lifecycle_overrides WHERE resource_id=?").get(r.id);
  let components: Component[];
  if (o) components = (j(o.components_json, []) as { product: string; cycle: string }[]).map((x) => componentOf(x.product, x.cycle, "set by a person", { reason: o.reason }, "human", today, warn));
  else components = matchComponents(r).map((m) => componentOf(m.product, m.key, m.method, m.evidence, "derived", today, warn, m.note));
  const tracked = !!o || isTracked(r);
  const state = components.reduce<LifecycleState>((s, c) => worse(s, c.state), "unknown");
  return { tracked, components, state: tracked && !components.length && !o ? "unknown" : state, origin: o ? "human" : "derived", override: o ? { reason: o.reason, set_by: o.set_by, set_at: o.set_at } : null };
}
/** Every resource's lifecycle in one pass (one overrides read), for a run or the register. */
export function lifecycleIndex(resources: Element[]): Map<string, ResourceLifecycle> {
  const overrides = new Map((db.prepare("SELECT * FROM lifecycle_overrides").all() as any[]).map((o) => [o.resource_id, o]));
  const today = nowIso().slice(0, 10), warn = warnDays();
  return new Map(resources.map((r) => [r.id, lifecycleOf(r, overrides, today, warn)]));
}
/** What a rule sees as `lifecycle.*`: the worst component. */
export const lifecycleView = (l: ResourceLifecycle | undefined) => {
  const worst = l?.components.reduce<Component | null>((w, c) => (!w || RANK[c.state] > RANK[w.state] ? c : w), null) ?? null;
  return { state: l?.state ?? "unknown", product: worst?.product ?? null, cycle: worst?.cycle ?? null, eol: worst?.eol ?? null, tracked: !!l?.tracked };
};

// ---------- corrections ----------
const err = (status: number, message: string) => Object.assign(new Error(message), { status });
export function setResourceLifecycle(resourceId: string, b: { components: { product: string; cycle: string }[]; reason: string }, actor: string) {
  const r = getElement(resourceId);
  if (!r || r.type !== "resource") throw err(404, "resource not found");
  if (!b.reason || b.reason.trim().length < 10) throw err(400, "a reason of at least 10 characters is required");
  if (!Array.isArray(b.components) || b.components.length > 5) throw err(400, "components must be a list of at most five {product, cycle}");
  const snap = snapshot();
  const comps = b.components.map((c) => {
    const prod = snap.products[c.product];
    if (!prod) throw err(400, `unknown product "${c.product}" (known: ${Object.keys(snap.products).join(", ")})`);
    if (!resolveCycle(c.product, String(c.cycle)).cycle) throw err(400, `${prod.label} has no cycle "${c.cycle}" in the lifecycle data`);
    return { product: c.product, cycle: String(c.cycle) };
  });
  const before = lifecycleOf(r);
  db.prepare("INSERT INTO lifecycle_overrides(resource_id,components_json,reason,set_by,set_at) VALUES (?,?,?,?,?) ON CONFLICT(resource_id) DO UPDATE SET components_json=excluded.components_json, reason=excluded.reason, set_by=excluded.set_by, set_at=excluded.set_at")
    .run(r.id, JSON.stringify(comps), b.reason.trim(), actor, nowIso());
  audit(actor, "lifecycle:set", "elements", r.id, { resource: r.name, from: before.components.map((c) => `${c.product}:${c.cycle}`), to: comps.map((c) => `${c.product}:${c.cycle}`), reason: b.reason.trim() });
  return lifecycleOf(r);
}
export function resetResourceLifecycle(resourceId: string, actor: string) {
  const r = getElement(resourceId);
  if (!r || r.type !== "resource") throw err(404, "resource not found");
  if (!db.prepare("DELETE FROM lifecycle_overrides WHERE resource_id=?").run(r.id).changes) throw err(409, "nothing to reset: the components are already derived");
  audit(actor, "lifecycle:reset", "elements", r.id, { resource: r.name });
  return lifecycleOf(r);
}

// ---------- the yearly legacy assessment (DORA Art. 8(7)) ----------
export const LEGACY_RESULTS = ["satisfactory", "satisfactory_with_remarks", "unsatisfactory"] as const;
export const LEGACY_TEMPLATE = `## Legacy components in scope

Which components are past standard support, on which resources, and what they do for the application.

## Risks

What the legacy components expose: unpatched vulnerabilities, unsupported integrations, skills and vendor dependence.

## Compensating controls

Isolation, monitoring, extended-support agreements and anything else that reduces the risk until the components are retired.

## Plan

How and when each component is upgraded, replaced or retired, and who owns it.

## Conclusion

Whether the residual risk is acceptable until the next assessment, and why.
`;
export type LegacyStatus = "not_needed" | "due" | "stale" | "current";
const keyOf = (c: { product: string; cycle: string | null }) => `${c.product}:${c.cycle ?? "?"}`;
export interface LegacyApp { id: string; name: string; components: (Component & { resource_id: string; resource_name: string })[]; legacy: string[]; worst: LifecycleState; status: LegacyStatus; last: any | null; new_since_last: string[] }

const assessmentRow = (a: any) => a ? { ...a, components: j(a.components_json, []), components_json: undefined } : null;
export const latestAssessment = (appId: string, kind = "legacy") => assessmentRow(db.prepare("SELECT * FROM register_assessments WHERE application_id=? AND kind=? ORDER BY assessed_at DESC, rowid DESC LIMIT 1").get(appId, kind));
export const assessmentsOfApp = (appId: string, kind = "legacy") => (db.prepare("SELECT * FROM register_assessments WHERE application_id=? AND kind=? ORDER BY assessed_at DESC, rowid DESC").all(appId, kind) as any[]).map(assessmentRow);

/** One application's legacy standing: its components, the legacy ones, and whether a current assessment covers them. */
export function legacyOf(app: Element, index?: Map<string, ResourceLifecycle>): LegacyApp {
  const rs = resourcesOf(app.id);
  const idx = index ?? lifecycleIndex(rs);
  const components = rs.flatMap((r) => (idx.get(r.id)?.components || []).map((c) => ({ ...c, resource_id: r.id, resource_name: r.name })));
  const legacy = [...new Set(components.filter((c) => LEGACY_STATES.includes(c.state)).map(keyOf))].sort();
  const worst = rs.reduce<LifecycleState>((s, r) => worse(s, idx.get(r.id)?.state ?? "unknown"), "unknown");
  const last = latestAssessment(app.id);
  const valid = !!last && last.valid_until > nowIso();
  const covered = new Set<string>((last?.components || []) as string[]);
  const new_since_last = legacy.filter((k) => !covered.has(k));
  // DORA Art. 8(7): yearly, and again when what is connected changes — a new legacy component makes the last one stale
  const status: LegacyStatus = !legacy.length ? "not_needed" : !valid ? "due" : new_since_last.length ? "stale" : "current";
  return { id: app.id, name: app.name, components, legacy, worst, status, last, new_since_last };
}

export function recordLegacyAssessment(appId: string, b: { result: string; summary_md: string; reference?: string | null }, actor: string, origin: "human" = "human") {
  const app = getElement(appId);
  if (!app || app.type !== "application") throw err(404, "application not found");
  if (!(LEGACY_RESULTS as readonly string[]).includes(b.result)) throw err(400, `result must be one of ${LEGACY_RESULTS.join(", ")}`);
  if (!b.summary_md || b.summary_md.trim().length < 10) throw err(400, "the assessment needs a summary of at least 10 characters");
  if (b.reference && !/^https?:\/\//i.test(b.reference.trim())) throw err(400, "reference must be a link (http or https) to where the assessment document lives");
  const now = new Date(); const until = new Date(now); until.setUTCMonth(until.getUTCMonth() + assessmentMonths());
  const l = legacyOf(app);
  const id = uid();
  db.prepare("INSERT INTO register_assessments(id,kind,application_id,subject,result,summary_md,reference,components_json,assessed_by,assessed_at,valid_until,origin) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, "legacy", app.id, null, b.result, b.summary_md.trim(), b.reference?.trim() || null, JSON.stringify(l.legacy), actor, now.toISOString(), until.toISOString(), origin);
  audit(actor, "legacy:assess", "applications", app.id, { application: app.name, result: b.result, components: l.legacy, valid_until: until.toISOString(), reference: b.reference?.trim() || null });
  return legacyOf(app);
}

// ---------- the register ----------
export function legacyRegister() {
  const resources = listElements("resource");
  const idx = lifecycleIndex(resources);
  const apps = listElements("application");
  const appOfResource = new Map<string, Element>();
  for (const a of apps) for (const r of resourcesOf(a.id)) appOfResource.set(r.id, a);
  const groups = new Map<string, any>();
  const unmatched: any[] = [];
  const counts: Record<LifecycleState, number> = { supported: 0, ending: 0, extended: 0, end_of_life: 0, unknown: 0 };
  for (const r of resources) {
    const l = idx.get(r.id)!;
    if (!l.tracked) continue;
    const app = appOfResource.get(r.id) || null;
    const ref = { id: r.id, name: r.name, type: r.subtype, application_id: app?.id ?? null, application_name: app?.name ?? null, origin: l.origin };
    if (!l.components.length) { unmatched.push({ ...ref, reason: l.override ? "set by a person: no tracked component" : "no version fact collected" }); if (!l.override) counts.unknown++; continue; }
    for (const c of l.components) {
      counts[c.state]++;
      const k = keyOf(c);
      const g = groups.get(k) || { key: k, product: c.product, product_label: c.product_label, cycle: c.cycle, label: c.label, state: c.state, eol: c.eol, extended: c.extended, support: c.support, resources: [], applications: [] as any[] };
      g.resources.push({ ...ref, method: c.method, evidence: c.evidence });
      if (app && !g.applications.some((a: any) => a.id === app.id)) g.applications.push({ id: app.id, name: app.name });
      groups.set(k, g);
    }
  }
  const components = [...groups.values()].sort((a, b) => RANK[b.state as LifecycleState] - RANK[a.state as LifecycleState] || String(a.eol ?? "9999").localeCompare(String(b.eol ?? "9999")) || a.key.localeCompare(b.key));
  const applications = apps.map((a) => legacyOf(a, idx)).filter((a) => a.components.length || a.last).map((a) => ({ ...a, components: undefined, component_count: a.components.length }))
    .sort((a, b) => ["due", "stale", "current", "not_needed"].indexOf(a.status) - ["due", "stale", "current", "not_needed"].indexOf(b.status) || RANK[b.worst] - RANK[a.worst] || a.name.localeCompare(b.name));
  const snap = snapshot();
  return { snapshot: { source: snap.source, licence: snap.licence, url: snap.url, fetched_at: snap.fetched_at, products: Object.entries(snap.products).map(([id, p]) => ({ id, label: p.label, cycles: p.cycles.length })), refreshed: !!j(getSetting("lifecycle.snapshot"), null) },
    warn_days: warnDays(), assessment_months: assessmentMonths(), counts, components, unmatched, applications,
    due: applications.filter((a) => a.status === "due" || a.status === "stale").length };
}

/** The products and their cycles, for the correction form. */
export const productCatalogue = () => Object.entries(snapshot().products).map(([id, p]) => ({ id, label: p.label, cycles: p.cycles.map((c) => ({ cycle: c.cycle, label: cycleLabel(p.label, c), state: stateOfCycle(c), eol: day(c.eol) })) }));

// ---------- refresh ----------
/** Fetch every product's cycles from endoflife.date; a product that fails keeps its previous data. Platform admin only. */
export async function refreshSnapshot(actor: string) {
  const cur = snapshot();
  const products: Snapshot["products"] = { ...cur.products };
  const failed: string[] = [];
  for (const [id, p] of Object.entries(cur.products)) {
    try {
      const res = await fetch(`https://endoflife.date/api/${id}.json`, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = (await res.json()) as any[];
      if (!Array.isArray(raw) || !raw.length) throw new Error("empty");
      products[id] = { label: p.label, cycles: raw.map((x) => {
        const label = String(x.releaseLabel || "").replace(/\s*'__CODENAME__'/g, "").trim();
        const c: Cycle = { cycle: String(x.cycle) };
        if (label) c.label = label;
        if (x.releaseDate) c.release = x.releaseDate;
        if (x.support !== undefined && x.support !== false) c.support = x.support;
        if (x.eol !== undefined && x.eol !== false) c.eol = x.eol;
        if (x.extendedSupport !== undefined && x.extendedSupport !== false) c.extended = x.extendedSupport;
        if (x.lts) c.lts = true;
        return c;
      }) };
    } catch { failed.push(id); }
  }
  const next: Snapshot = { source: "endoflife.date", licence: "MIT", url: "https://endoflife.date", fetched_at: nowIso().slice(0, 10), products };
  if (failed.length < Object.keys(cur.products).length) { setSetting("lifecycle.snapshot", JSON.stringify(next)); cached = null; }
  audit(actor, "lifecycle:refresh", "settings", null, { products: Object.keys(products).length, failed });
  return { fetched_at: failed.length < Object.keys(cur.products).length ? next.fetched_at : cur.fetched_at, products: Object.keys(products).length, failed };
}
/** Tests and a restore drop the cache so the next read sees the stored setting. */
export const resetLifecycleCache = () => { cached = null; };
