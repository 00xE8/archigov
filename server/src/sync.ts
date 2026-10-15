import { db, uid, nowIso, audit, getSetting, j } from "./db.js";
import { ingestResources, type NormalisedResource } from "./model.js";
import { evaluateAll } from "./rules.js";
import { importEvidence } from "./evidence.js";
import { collectResourceGraph, listSubscriptions } from "./azure/resourceGraph.js";
import { importDefender } from "./azure/defender.js";
import { importPolicy } from "./azure/policy.js";
import { azureConfigured, configuredSubscriptions, fixturesEnabled } from "./azure/client.js";
import { FIXTURES } from "./azure/fixtures.js";
import { adoConfigured, adoConfig } from "./ado/client.js";
import { syncAdo as adoBackfill } from "./ado/sync.js";
import { DEMO_RESOURCES, DEMO_EVIDENCE } from "./collectors/demo.js";

export { azureConfigured, fixturesEnabled, adoConfigured };

/** Source kinds that come from the environment (or fixtures) rather than from a file or the demo. */
export const SOURCE_NAMES: Record<string, string> = {
  azure: "Azure (Resource Graph)", defender: "Microsoft Defender for Cloud", azure_policy: "Azure Policy", ado: "Azure DevOps",
};

/** Find or create the single source row of a kind. */
export function ensureSource(kind: string, name = SOURCE_NAMES[kind] || kind, config: Record<string, unknown> = {}) {
  let src = db.prepare("SELECT * FROM sources WHERE kind=?").get(kind) as any;
  if (!src) { src = { id: uid(), kind, name }; db.prepare("INSERT INTO sources(id,kind,name,config_json,status,created_at) VALUES (?,?,?,?,?,?)").run(src.id, kind, name, JSON.stringify(config), "idle", nowIso()); }
  return src;
}

/**
 * Collect → ingest → evaluate for one source, recorded as a run. Shared by the API routes and the scheduler,
 * so "continuous" means the same code path whether a human clicked Sync or the timer fired.
 */
async function runSync(src: any, actor: string, collect: () => Promise<{ resources: NormalisedResource[]; evidence?: () => void }>) {
  const runId = uid();
  db.prepare("INSERT INTO runs(id,kind,source_id,started_at) VALUES (?,?,?,?)").run(runId, "sync", src.id, nowIso());
  try {
    const { resources, evidence } = await collect();
    const stats = ingestResources(src.id, resources, actor);
    evidence?.();
    db.prepare("UPDATE sources SET status='ok', last_sync_at=?, last_error=NULL WHERE id=?").run(nowIso(), src.id);
    db.prepare("UPDATE runs SET finished_at=?, status='done', stats_json=? WHERE id=?").run(nowIso(), JSON.stringify(stats), runId);
    const evaluate = evaluateAll(actor);
    return { ok: true as const, runId, run_id: runId, collected: resources.length, stats, evaluate };
  } catch (e: any) {
    db.prepare("UPDATE sources SET status='error', last_error=? WHERE id=?").run(String(e.message), src.id);
    db.prepare("UPDATE runs SET finished_at=?, status='error', error=? WHERE id=?").run(nowIso(), String(e.message), runId);
    return { ok: false as const, runId, run_id: runId, error: String(e.message) };
  }
}

/** Import-only sync (Defender, Azure Policy): evidence attaches to resources the model already knows; nothing is collected. */
async function runEvidenceSync(src: any, actor: string, importer: () => Promise<any>) {
  const runId = uid();
  db.prepare("INSERT INTO runs(id,kind,source_id,started_at) VALUES (?,?,?,?)").run(runId, "sync", src.id, nowIso());
  try {
    const r = await importer();
    const stats = { fetched: r.fetched, created: r.created, updated: r.updated, unchanged: r.unchanged, unmatched: r.unmatched.length };
    db.prepare("UPDATE sources SET status='ok', last_sync_at=?, last_error=NULL WHERE id=?").run(nowIso(), src.id);
    db.prepare("UPDATE runs SET finished_at=?, status='done', stats_json=? WHERE id=?").run(nowIso(), JSON.stringify(stats), runId);
    const evaluate = evaluateAll(actor);
    return { ok: true as const, run_id: runId, fetched: r.fetched, imported: { created: r.created, updated: r.updated, unchanged: r.unchanged }, unmatched: r.unmatched, evaluate };
  } catch (e: any) {
    db.prepare("UPDATE sources SET status='error', last_error=? WHERE id=?").run(String(e.message), src.id);
    db.prepare("UPDATE runs SET finished_at=?, status='error', error=? WHERE id=?").run(nowIso(), String(e.message), runId);
    return { ok: false as const, run_id: runId, error: String(e.message) };
  }
}

// ---------- Azure ----------
const azureSubs = () => (configuredSubscriptions().length ? configuredSubscriptions() : fixturesEnabled() ? [FIXTURES.subscription.id] : []);

export async function syncAzure(actor: string) {
  const src = ensureSource("azure", SOURCE_NAMES.azure, { subscriptions: azureSubs() });
  if (!azureConfigured()) {
    db.prepare("UPDATE sources SET status='error', last_error=? WHERE id=?").run("Azure is not configured (AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET / AZURE_SUBSCRIPTIONS)", src.id);
    return { ok: false as const, error: "Azure is not configured (set AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET and AZURE_SUBSCRIPTIONS, or a managed identity)" };
  }
  return runSync(src, actor, async () => ({ resources: await collectResourceGraph({ subscriptions: configuredSubscriptions() }) }));
}

/** "Test connection": the subscriptions the identity can read through Resource Graph — exactly what a sync will cover. */
export async function testAzure() {
  if (!azureConfigured()) return { ok: false, subscriptions: [], error: "Azure is not configured (set AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET and AZURE_SUBSCRIPTIONS, or a managed identity)" };
  try {
    const subscriptions = await listSubscriptions();
    return { ok: true, tenant: process.env.AZURE_TENANT_ID || (fixturesEnabled() ? "fixture" : undefined), subscriptions, fixtures: fixturesEnabled() };
  } catch (e: any) { return { ok: false, subscriptions: [], error: String(e.message) }; }
}

export const syncDefender = (actor: string) => runEvidenceSync(ensureSource("defender", SOURCE_NAMES.defender, { subscriptions: azureSubs() }), actor, () => importDefender(actor, azureSubs()));
export const syncPolicy = (actor: string) => runEvidenceSync(ensureSource("azure_policy", SOURCE_NAMES.azure_policy, { subscriptions: azureSubs() }), actor, () => importPolicy(actor, azureSubs()));

// ---------- Azure DevOps ----------
export const syncAdo = (actor: string) => adoBackfill(actor);

// ---------- Demo ----------
/** Demo-only: props overrides applied on top of the fixture so a perturbation survives the next resync until reset. */
const DEMO_OVERRIDES = new Map<string, Record<string, unknown>>();

export const demoResources = (): NormalisedResource[] =>
  DEMO_RESOURCES.map((r) => (DEMO_OVERRIDES.has(r.sourceRef) ? { ...r, props: { ...r.props, ...DEMO_OVERRIDES.get(r.sourceRef)! } } : r));

export const demoSource = () => db.prepare("SELECT * FROM sources WHERE kind='demo-azure'").get() as any;

export function loadDemoEvidence(actor: string) {
  const bySource = new Map<string, typeof DEMO_EVIDENCE>();
  for (const e of DEMO_EVIDENCE) bySource.set(e.source, [...(bySource.get(e.source) || []), e]);
  return Array.from(bySource.entries()).map(([source, items]) => importEvidence(source as any, items, actor));
}

export async function syncDemo(actor: string) {
  const src = demoSource();
  if (!src) return { ok: false as const, error: "no demo source" };
  return runSync(src, actor, async () => ({ resources: demoResources(), evidence: () => { loadDemoEvidence(actor); } }));
}

/** Demo-only: change a resource's properties and re-collect, so content hashes move and verification drops the way it would for real drift. */
export async function perturbDemo(actor: string, sel: { resourceName?: string; resourceId?: string }, props: Record<string, unknown>) {
  const src = demoSource();
  if (!src) throw Object.assign(new Error("no demo source"), { status: 400 });
  let ref: string | undefined;
  if (sel.resourceId) {
    const el = db.prepare("SELECT source_ref, source_id FROM elements WHERE id=? AND type='resource' AND deleted_at IS NULL").get(sel.resourceId) as any;
    if (!el) throw Object.assign(new Error("resource not found"), { status: 404 });
    if (el.source_id !== src.id) throw Object.assign(new Error("perturb is only available for demo-source resources"), { status: 400 });
    ref = el.source_ref;
  } else if (sel.resourceName) {
    ref = DEMO_RESOURCES.find((r) => r.name.toLowerCase() === sel.resourceName!.toLowerCase())?.sourceRef;
  }
  if (!ref) throw Object.assign(new Error("resource not found in the demo estate"), { status: 404 });
  DEMO_OVERRIDES.set(ref, { ...(DEMO_OVERRIDES.get(ref) || {}), ...props });
  audit(actor, "perturb", "source", src.id, { resource: ref, props });
  const result = await runSync(src, actor, async () => ({ resources: demoResources() }));
  const element = db.prepare("SELECT id, name, verification, verified_by, verified_at, content_hash, verified_hash FROM elements WHERE source_ref=? AND deleted_at IS NULL").get(ref);
  return { ...result, element };
}

export function resetDemoOverrides() { DEMO_OVERRIDES.clear(); }

// ---------- what the UI sees ----------
/**
 * Every source, in the shape the Settings page needs: rows that exist, plus the kinds that are configured by
 * environment (or stood in for by fixtures) but have never synced, so "Sync now" is offered before the first run.
 * Config is the non-secret summary only — never a key or a PAT.
 */
export function sourcesOverview() {
  const rows = db.prepare("SELECT * FROM sources ORDER BY created_at").all() as any[];
  const fx = fixturesEnabled();
  const describe = (kind: string, stored: any = {}) => {
    switch (kind) {
      case "azure": case "defender": case "azure_policy": return { configured: azureConfigured(), fixtures: fx, config: { subscriptions: azureSubs(), tenant: process.env.AZURE_TENANT_ID || (fx ? "fixture" : null) } };
      case "ado": { const { org, project, wiql, hookSecretConfigured } = adoConfig(); return { configured: adoConfigured(), fixtures: fx, config: { org, project, wiql, hook_url: "/api/hooks/ado", hook_secret_configured: hookSecretConfigured } }; }
      case "demo-ado": { const { hookSecretConfigured } = adoConfig(); return { configured: true, fixtures: fx, config: { ...stored, ...(fx ? { hook_url: "/api/hooks/ado", hook_secret_configured: hookSecretConfigured, fed_by: "ado fixtures" } : {}) } }; }
      default: return { configured: true, fixtures: false, config: stored };
    }
  };
  const out = rows.map((s) => {
    const d = describe(s.kind, j(s.config_json, {}));
    return { id: s.id, kind: s.kind, name: s.name, status: s.last_sync_at ? s.status : s.status === "error" ? "error" : "never", last_sync_at: s.last_sync_at, last_error: s.last_error, created_at: s.created_at, ...d };
  });
  for (const kind of ["azure", "defender", "azure_policy", "ado"]) {
    if (rows.some((r) => r.kind === kind)) continue;
    if (kind === "ado" && fx && rows.some((r) => r.kind === "demo-ado")) continue; // fixtures feed the demo backlog
    const d = describe(kind);
    if (!d.configured) continue;
    out.push({ id: `pending:${kind}`, kind, name: SOURCE_NAMES[kind], status: "never", last_sync_at: null, last_error: null, created_at: null, ...d });
  }
  return out;
}

// ---------- Scheduler ----------
export const collectIntervalMinutes = () => Math.max(1, Number(getSetting("collect_interval_minutes", "60")) || 60);

/** Every configured source, in turn. Used by the scheduler; never runs on boot. */
export async function syncAll(actor: string) {
  const out: any[] = [];
  const kinds = new Set<string>();
  for (const src of db.prepare("SELECT * FROM sources ORDER BY created_at").all() as any[]) {
    kinds.add(src.kind);
    if (src.kind === "demo-azure") out.push({ source: src.name, ...(await syncDemo(actor)) });
    else if (src.kind === "azure" && azureConfigured()) out.push({ source: src.name, ...(await syncAzure(actor)) });
    else if (src.kind === "defender" && azureConfigured()) out.push({ source: src.name, ...(await syncDefender(actor)) });
    else if (src.kind === "azure_policy" && azureConfigured()) out.push({ source: src.name, ...(await syncPolicy(actor)) });
    else if ((src.kind === "ado" || (src.kind === "demo-ado" && fixturesEnabled())) && adoConfigured()) out.push({ source: src.name, ...(await syncAdo(actor)) });
  }
  // configured by environment (or fixtures) but never synced yet: register by syncing once
  if (azureConfigured()) {
    if (!kinds.has("azure")) out.push({ source: SOURCE_NAMES.azure, ...(await syncAzure(actor)) });
    if (!kinds.has("defender")) out.push({ source: SOURCE_NAMES.defender, ...(await syncDefender(actor)) });
    if (!kinds.has("azure_policy")) out.push({ source: SOURCE_NAMES.azure_policy, ...(await syncPolicy(actor)) });
  }
  if (adoConfigured() && !kinds.has("ado") && !(fixturesEnabled() && kinds.has("demo-ado"))) out.push({ source: SOURCE_NAMES.ado, ...(await syncAdo(actor)) });
  return out;
}
