import { Hono } from "hono";
import fs from "node:fs";
import path from "node:path";
import { db, j, nowIso, audit, getSetting, setSetting, backupNow, verifyAuditChain } from "../db.js";
import { listElements, verificationCoverage } from "../model.js";
import { llmSummary, aiStatus, aiTest, AI_PROVIDERS, AI_FEATURES, featureSettings, suggestEvidenceMapping } from "../ai.js";
import { encryptSecret } from "../secrets.js";
import { collectIntervalMinutes, azureConfigured, demoSource } from "../sync.js";
import { actorOf, fnd } from "../http.js";
import { buildEvidencePack, signAndPersist, verifyPack, ensureSigningKeys } from "../evidence-pack.js";
import { authMode, entraConfigured } from "../auth/entra.js";
import { currentPrincipal } from "../auth/context.js";
import { workQueueFor, IN_FLIGHT_SQL } from "../boards/work.js";
import { VERSION } from "../about.js";

export const system = new Hono();

/** The governance pipeline at a glance: where every review stands, what each board has in flight and when it next sits, and what is waiting on someone. */
function pipeline() {
  const count = (sql: string, ...params: any[]) => (db.prepare(sql).get(...params) as any).c as number;
  const by_stage = Object.fromEntries((db.prepare("SELECT stage, count(*) n FROM reviews GROUP BY stage ORDER BY stage").all() as any[]).map((r) => [r.stage, r.n]));
  const sref = (s: any) => (s ? { id: s.id, code: s.code, status: s.status, scheduled_at: s.scheduled_at } : null);
  const nextOf = (boardId: string | null) => db.prepare(`SELECT id, code, status, scheduled_at, board_id FROM board_sessions WHERE status IN ('planned','open')${boardId ? " AND board_id=?" : ""} ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, scheduled_at LIMIT 1`).get(...(boardId ? [boardId] : [])) as any;
  const by_board = (db.prepare("SELECT id, code, name FROM boards ORDER BY code").all() as any[]).map((b) => ({ ...b, in_flight: count(`SELECT count(*) c FROM reviews WHERE board_id=? AND stage IN ${IN_FLIGHT_SQL}`, b.id), next_session: sref(nextOf(b.id)) }));
  const next = nextOf(null);
  const now = nowIso();
  return { by_stage, in_flight: count(`SELECT count(*) c FROM reviews WHERE stage IN ${IN_FLIGHT_SQL}`), by_board,
    next_session: next ? { ...sref(next), board: by_board.map(({ id, code, name }) => ({ id, code, name })).find((b) => b.id === next.board_id) ?? null } : null,
    open_conditions: count("SELECT count(*) c FROM conditions WHERE status IN ('open','overdue')"), overdue_conditions: count("SELECT count(*) c FROM conditions WHERE status='overdue'"),
    circulations: count("SELECT count(*) c FROM reviews WHERE stage='approved_subject_to_circulation'"), circulations_overdue: count("SELECT count(*) c FROM reviews WHERE stage='approved_subject_to_circulation' AND circulation_due IS NOT NULL AND circulation_due < ?", now),
    changed_after_approval: count("SELECT count(*) c FROM work_items WHERE material_change=1"),
    epics_without_decision: count("SELECT count(*) c FROM work_items WHERE type='Epic' AND state<>'Closed' AND decision_id IS NULL AND review_id IS NULL") };
}

// ---------- overview ----------
system.get("/overview", (c) => {
  const count = (sql: string) => (db.prepare(sql).get() as any).c as number;
  const apps = listElements("application");
  const openFindings = db.prepare("SELECT f.*, s.code standard_code, s.title standard_title, s.kind artefact_kind, s.code artefact_code FROM findings f JOIN standards s ON s.id=f.standard_id WHERE f.status='open'").all().map(fnd);
  // the governance catalogue by kind: only adopted artefacts count; drafts and in-review ones are the board's queue
  const byKind = db.prepare("SELECT kind, count(*) c FROM standards WHERE lifecycle='adopted' GROUP BY kind").all() as any[];
  const artefacts = Object.fromEntries(["standard", "principle", "pattern", "policy"].map((k) => [k, byKind.find((r) => r.kind === k)?.c || 0]));
  const bySeverity = openFindings.reduce((m: any, f: any) => ((m[f.severity] = (m[f.severity] || 0) + 1), m), {});
  const byApp = apps.map((a) => ({ id: a.id, name: a.name, open: openFindings.filter((f: any) => f.application_id === a.id).length, verification: a.verification, origin: a.origin,
    resources: (db.prepare("SELECT count(*) c FROM relations WHERE to_id=? AND type='belongs_to' AND deleted_at IS NULL").get(a.id) as any).c }));
  const reviews = db.prepare("SELECT stage, count(*) c FROM reviews GROUP BY stage").all();
  const lastRun = db.prepare("SELECT * FROM runs WHERE kind='evaluate' ORDER BY started_at DESC LIMIT 1").get() as any;
  const lastSync = db.prepare("SELECT * FROM runs WHERE kind='sync' ORDER BY started_at DESC LIMIT 1").get() as any;
  // chart data: open findings over the last evaluate runs (oldest → newest), evidence by source, and the small status mixes
  const trend = (db.prepare("SELECT started_at, stats_json FROM runs WHERE kind='evaluate' AND status='done' ORDER BY started_at DESC LIMIT 30").all() as any[]).reverse()
    .map((r) => { const s = j(r.stats_json, {}); const b = s.bySeverity || {}; return { at: r.started_at, findings_open: s.findings ?? 0, critical: b.critical || 0, high: b.high || 0, medium: b.medium || 0, low: b.low || 0 }; });
  const evidence_by_source = db.prepare("SELECT source, sum(state='pass') pass, sum(state='fail') fail, sum(state='unknown') unknown FROM evidence GROUP BY source ORDER BY source").all();
  const decisions_by_status = db.prepare("SELECT status, count(*) n FROM decisions GROUP BY status ORDER BY status").all();
  const reviews_by_stage = db.prepare("SELECT stage, count(*) n FROM reviews GROUP BY stage ORDER BY stage").all();
  return c.json({
    trend, evidence_by_source, decisions_by_status, reviews_by_stage,
    tenant: getSetting("tenant.name", "Local tenant"),
    counts: { applications: apps.length, resources: count("SELECT count(*) c FROM elements WHERE type='resource' AND deleted_at IS NULL"),
      shared_services: count("SELECT count(*) c FROM elements WHERE type='shared_service' AND deleted_at IS NULL"),
      standards: artefacts.standard, artefacts, drafts_in_review: count("SELECT count(*) c FROM standards WHERE lifecycle IN ('draft','in_review')"),
      decisions: count("SELECT count(*) c FROM decisions"),
      reviews_open: count("SELECT count(*) c FROM reviews WHERE stage IN ('submitted','pre_review','in_review')"),
      conditions_overdue: count("SELECT count(*) c FROM conditions WHERE status='overdue'"),
      exceptions_expired: count("SELECT count(*) c FROM exceptions WHERE status='expired'"),
      epics_without_decision: count("SELECT count(*) c FROM work_items WHERE type='Epic' AND state<>'Closed' AND decision_id IS NULL AND review_id IS NULL"),
      material_changes: count("SELECT count(*) c FROM work_items WHERE material_change=1"),
      findings_open: openFindings.length, evidence_items: count("SELECT count(*) c FROM evidence") },
    // nothing collected yet: the UI shows the get-started path instead of an empty dashboard
    first_run: count("SELECT count(*) c FROM elements WHERE type='resource' AND deleted_at IS NULL") === 0,
    bySeverity, byApp, reviews, verification: verificationCoverage(),
    lastRun: lastRun ? { ...lastRun, stats: j(lastRun.stats_json, {}) } : null,
    lastSync: lastSync ? { ...lastSync, stats: j(lastSync.stats_json, {}) } : null,
    collect_interval_minutes: collectIntervalMinutes(),
    llm: llmSummary(),
    pipeline: pipeline(),
    // what is waiting on the caller (the same count as GET /me/work); nothing for someone without a governance identity
    me: { awaiting: workQueueFor(currentPrincipal()).counts.total },
  });
});

// ---------- evidence pack (built, hashed, chained and signed in evidence-pack.ts) ----------
system.get("/evidence-pack/verify", (c) => {
  const hash = (c.req.query("hash") || "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) return c.json({ error: "hash must be the pack's 64-hex SHA-256" }, 400);
  return c.json(verifyPack(hash));
});
system.get("/evidence-pack", (c) => {
  const appId = c.req.query("application") || null;
  const pack = buildEvidencePack(appId);
  if (!pack) return c.json({ error: "not found" }, 404);
  signAndPersist(pack);
  // the hash identifies this exact pack; the persisted, signed copy under DATA_DIR/evidence-packs is what an auditor can be handed later
  audit(actorOf(c), "export_evidence_pack", "tenant", appId, { hash: pack.hash, scope: pack.scope, chain_head: pack.chain_head });
  return c.json(pack);
});
/** Walk the whole audit chain and say whether it is intact; `broken_at` names the first row that does not fit. */
system.get("/audit/verify", (c) => { const r = verifyAuditChain(); return c.json({ ok: r.ok, rows: r.rows, broken_at: r.broken_at, head: r.head }); });

// ---------- misc ----------
/** Sign-ins were once audited under the entity `session`; they are read back as `sign_in` (board sittings are `sessions`). Stored rows are chained history and stay as written. */
const SIGN_ACTIONS = ["sign_in", "sign_out"];
const readEntity = (entity: string, action: string) => (entity === "session" && SIGN_ACTIONS.includes(action) ? "sign_in" : entity);
/** The human code and label of the thing an audit row is about, resolved from (entity, entity_id) at read time; unknown entities resolve to nothing. */
function auditItem(entity: string, id: string | null): { item_code: string | null; item_label: string | null } {
  const none = { item_code: null, item_label: null };
  if (!id) return none;
  const one = (sql: string) => db.prepare(sql).get(id) as any;
  switch (entity) {
    case "reviews": case "review": { const r = one("SELECT code, title FROM reviews WHERE id=?"); return r ? { item_code: r.code, item_label: r.title } : none; }
    case "decisions": case "decision": { const r = one("SELECT code, title FROM decisions WHERE id=?"); return r ? { item_code: r.code, item_label: r.title } : none; }
    case "standards": case "standard": case "artefacts": case "artefact": case "policy": case "pattern": case "principle": { const r = one("SELECT code, title FROM standards WHERE id=?"); return r ? { item_code: r.code, item_label: r.title } : none; }
    case "sessions": case "session": { const r = one("SELECT code, title FROM board_sessions WHERE id=?"); return r ? { item_code: r.code, item_label: r.title } : none; }
    case "boards": case "board": { const r = one("SELECT code, name FROM boards WHERE id=?"); return r ? { item_code: r.code, item_label: r.name } : none; }
    case "users": case "user": { const r = one("SELECT name FROM users WHERE id=?"); return r ? { item_code: null, item_label: r.name } : none; }
    case "elements": case "resources": case "resource": case "applications": case "application": { const r = one("SELECT name FROM elements WHERE id=?"); return r ? { item_code: null, item_label: r.name } : none; }
    case "sources": case "source": { const r = one("SELECT name FROM sources WHERE id=?"); return r ? { item_code: null, item_label: r.name } : none; }
    case "work_items": case "work_item": { const r = one("SELECT type, external_id, title FROM work_items WHERE id=?"); return r ? { item_code: `${r.type} ${r.external_id}`, item_label: r.title } : none; }
    case "runs": case "run": { const r = one("SELECT kind, started_at FROM runs WHERE id=?"); return r ? { item_code: r.kind, item_label: `${r.kind} run ${r.started_at}` } : none; }
    default: return none;
  }
}
/** The audit log, filterable the way an auditor asks for it: by entity, actor, action, time window or free text. */
system.get("/audit", (c) => {
  const q = c.req.query();
  const where: string[] = []; const params: any[] = [];
  const eq = (col: string, v?: string) => { if (v) { where.push(`${col}=?`); params.push(v); } };
  // a filter on sign-ins also finds the rows written under the old entity name
  if (q.entity === "sign_in" || q.entity === "session") { where.push("(entity='sign_in' OR (entity='session' AND action IN ('sign_in','sign_out')))"); } else eq("entity", q.entity);
  eq("entity_id", q.entity_id); eq("actor", q.actor); eq("action", q.action);
  if (q.since) { where.push("at>=?"); params.push(q.since); }
  if (q.until) { where.push("at<=?"); params.push(q.until); }
  if (q.q) { const like = `%${q.q}%`; where.push("(action LIKE ? OR entity LIKE ? OR entity_id LIKE ? OR actor LIKE ? OR data_json LIKE ?)"); params.push(like, like, like, like, like); }
  const limit = Math.min(1000, Math.max(1, Number(q.limit) || 200));
  // actors are stable ids; display names come from the profile remembered at sign-in (user.<id>)
  const names = new Map((db.prepare("SELECT key, value FROM settings WHERE key LIKE 'user.%'").all() as any[]).map((r) => [r.key.slice("user.".length), j(r.value, {})?.name]));
  const items = new Map<string, ReturnType<typeof auditItem>>();
  const itemOf = (entity: string, id: string | null) => { const k = `${entity}\u0000${id}`; let v = items.get(k); if (!v) { v = auditItem(entity, id); items.set(k, v); } return v; };
  const rows = (db.prepare(`SELECT * FROM audit_log${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY at DESC LIMIT ?`).all(...params, limit) as any[])
    .map((a) => { const details = j(a.data_json, {}); return { id: a.id, at: a.at, actor: a.actor, actor_name: names.get(a.actor) || a.actor, role: a.role ?? null, action: a.action, entity: readEntity(a.entity, a.action), entity_id: a.entity_id, ...itemOf(a.entity, a.entity_id), details, data: details, hash: a.hash ?? null }; });
  const distinct = (col: string) => db.prepare(`SELECT DISTINCT ${col} v FROM audit_log ORDER BY ${col}`).all().map((r: any) => r.v);
  const entities = [...new Set((db.prepare("SELECT DISTINCT entity, action FROM audit_log").all() as any[]).map((r) => readEntity(r.entity, r.action)))].sort();
  return c.json({ rows, facets: { entities, actors: distinct("actor"), actions: distinct("action") } });
});
/** Global search over codes, names and titles; small groups so the UI can show it as a palette. */
system.get("/search", (c) => {
  const q = (c.req.query("q") || "").trim();
  if (q.length < 2) return c.json({ applications: [], resources: [], standards: [], decisions: [], reviews: [], work_items: [] });
  const like = `%${q.toLowerCase()}%`;
  return c.json({
    applications: db.prepare("SELECT id, name FROM elements WHERE type='application' AND deleted_at IS NULL AND lower(name) LIKE ? ORDER BY name LIMIT 8").all(like),
    resources: db.prepare(`SELECT e.id, e.name, e.subtype, a.id application_id, a.name application_name FROM elements e
      LEFT JOIN relations rel ON rel.from_id=e.id AND rel.type='belongs_to' AND rel.deleted_at IS NULL LEFT JOIN elements a ON a.id=rel.to_id
      WHERE e.type='resource' AND e.deleted_at IS NULL AND (lower(e.name) LIKE ? OR lower(e.subtype) LIKE ?) ORDER BY e.name LIMIT 8`).all(like, like),
    standards: db.prepare("SELECT id, code, title, kind, lifecycle FROM standards WHERE lower(code) LIKE ? OR lower(title) LIKE ? ORDER BY code LIMIT 8").all(like, like),
    decisions: db.prepare("SELECT id, code, title FROM decisions WHERE lower(code) LIKE ? OR lower(title) LIKE ? ORDER BY code LIMIT 8").all(like, like),
    reviews: db.prepare("SELECT id, code, title FROM reviews WHERE lower(code) LIKE ? OR lower(title) LIKE ? ORDER BY code DESC LIMIT 8").all(like, like),
    work_items: db.prepare("SELECT id, external_id, title FROM work_items WHERE lower(external_id) LIKE ? OR lower(title) LIKE ? ORDER BY external_id LIMIT 8").all(like, like),
  });
});
/** Regions the estate is expected to live in; the UI flags deployed regions outside this list. A stored [] flags nothing. */
const DEFAULT_HOME_REGIONS = ["uksouth", "ukwest", "global"];
function homeRegions(): string[] {
  const parsed = j(getSetting("regions.home", ""), null);
  return Array.isArray(parsed) ? parsed.map((s) => String(s)) : DEFAULT_HOME_REGIONS;
}
/** The newest on-demand or nightly backup under DATA_DIR/backups, so an admin can see the schedule is alive. */
function backupsInfo() {
  try {
    const dir = path.join(process.env.DATA_DIR || "../data", "backups");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".db"))
      .map((f) => ({ name: f, at: fs.statSync(path.join(dir, f)).mtime.toISOString() }))
      .sort((a, b) => b.at.localeCompare(a.at));
    return { count: files.length, latest: files[0] ?? null };
  } catch { return { count: 0, latest: null }; }
}

system.get("/settings", (c) => {
  // what is wired up, from the environment only (never the secrets themselves); fixture mode stands in for every cloud source
  const fixtures = process.env.ARCHIGOV_FIXTURES === "1";
  const subscriptions = (process.env.AZURE_SUBSCRIPTIONS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const adoConfigured = !!(process.env.ADO_ORG && process.env.ADO_PROJECT && (process.env.ADO_PAT || azureConfigured()));
  return c.json({
    tenant: getSetting("tenant.name", "Local tenant"), llm: llmSummary(), demo_loaded: !!demoSource(), dataDir: process.env.DATA_DIR || "../data", collect_interval_minutes: collectIntervalMinutes(),
    home_regions: homeRegions(),
    version: VERSION, backups: backupsInfo(),
    // the instance's evidence-signing public key: travels inside every pack; hand it to verifiers out of band so they can pin it
    signing_public_key: ensureSigningKeys().pubPem,
    // tenant overrides for the Defender/Policy → control mapping (azure/controls.ts holds the built-ins)
    evidence_control_map: j(getSetting("evidence.control_map"), {}) || {},
    // AI providers and per-feature enablement; keys are summarised as key_set, never returned
    ai: aiStatus(),
    auth: { mode: authMode(), entra_configured: entraConfigured() },
    azure: { configured: azureConfigured() || fixtures, subscriptions, fixtures }, azure_configured: azureConfigured(),
    defender: { configured: azureConfigured() || fixtures, fixtures },
    policy: { configured: azureConfigured() || fixtures, fixtures },
    ado: { configured: adoConfigured || fixtures, org: process.env.ADO_ORG || null, project: process.env.ADO_PROJECT || null, hook_url: "/api/hooks/ado", hook_secret_configured: !!process.env.ADO_HOOK_SECRET, fixtures },
  });
});
system.post("/settings", async (c) => {
  const b = await c.req.json(); const changed: Record<string, unknown> = {};
  if (b.tenant) { setSetting("tenant.name", b.tenant); changed.tenant = b.tenant; }
  if (b.collect_interval_minutes !== undefined) { const n = Math.max(1, Number(b.collect_interval_minutes) || 60); setSetting("collect_interval_minutes", String(n)); changed.collect_interval_minutes = n; }
  if (Array.isArray(b.home_regions)) { const regions = [...new Set(b.home_regions.map((s: unknown) => String(s).trim().toLowerCase()).filter(Boolean))]; setSetting("regions.home", JSON.stringify(regions)); changed.home_regions = regions; }
  if (b.evidence_control_map !== undefined) {
    const m = b.evidence_control_map;
    const valid = m && typeof m === "object" && !Array.isArray(m) && Object.entries(m).every(([k, v]) => k.trim() && typeof v === "string" && (v as string).trim());
    if (!valid) return c.json({ error: 'evidence_control_map must be a JSON object mapping a source key to a control id, e.g. {"defender:<assessment key>": "min-tls-1.2"} — an empty object {} removes every override' }, 400);
    setSetting("evidence.control_map", JSON.stringify(m)); changed.evidence_control_map = m;
  }
  if (b.ai_providers !== undefined) {
    const incoming = b.ai_providers;
    if (!incoming || typeof incoming !== "object" || Array.isArray(incoming) || Object.keys(incoming).some((k) => !AI_PROVIDERS[k]))
      return c.json({ error: `ai_providers must map a provider id (${Object.keys(AI_PROVIDERS).join(", ")}) to {api_key?, base_url?}` }, 400);
    const current = j(getSetting("ai.providers"), {}) || {};
    for (const [id, v] of Object.entries(incoming) as [string, any][]) {
      const cur = { ...(current[id] || {}) };
      // api_key: undefined keeps the stored key, "" clears it, anything else replaces it. Stored encrypted (secrets.ts); the plaintext never leaves this handler.
      if (v.api_key !== undefined) { if (String(v.api_key).trim() === "") delete cur.api_key; else cur.api_key = encryptSecret(String(v.api_key).trim()); }
      if (v.base_url !== undefined) { const u = String(v.base_url).trim(); if (!u || u === AI_PROVIDERS[id].base_url) delete cur.base_url; else { if (!/^https?:\/\//.test(u)) return c.json({ error: `base_url for ${id} must be http(s)` }, 400); cur.base_url = u; } }
      if (Object.keys(cur).length) current[id] = cur; else delete current[id];
    }
    setSetting("ai.providers", JSON.stringify(current));
    changed.ai_providers = Object.fromEntries((Object.entries(incoming) as [string, any][]).map(([id, v]) => [id, { api_key: v.api_key === undefined ? "kept" : String(v.api_key).trim() === "" ? "cleared" : "set", ...(v.base_url !== undefined ? { base_url: String(v.base_url).trim() || "default" } : {}) }]));
  }
  if (b.ai_features !== undefined) {
    const incoming = b.ai_features;
    const ids = new Set(AI_FEATURES.map((f) => f.id as string));
    const valid = incoming && typeof incoming === "object" && !Array.isArray(incoming) && Object.entries(incoming).every(([k, v]: [string, any]) =>
      ids.has(k) && v && typeof v === "object" && (v.provider === undefined || AI_PROVIDERS[v.provider]) && (v.model === undefined || typeof v.model === "string"));
    if (!valid) return c.json({ error: `ai_features must map a feature id (${AI_FEATURES.map((f) => f.id).join(", ")}) to {enabled, provider, model}` }, 400);
    const current = featureSettings();
    for (const [id, v] of Object.entries(incoming) as [string, any][]) current[id] = { enabled: !!v.enabled, provider: v.provider || current[id]?.provider, model: typeof v.model === "string" ? v.model.trim() : current[id]?.model };
    setSetting("ai.features", JSON.stringify(current));
    changed.ai_features = current;
  }
  audit(actorOf(c), "update", "settings", null, changed);
  return c.json({ ok: true, ...changed });
});
// Which AI features are live — readable by every role, so pages can show or hide their Draft buttons; no keys, no providers.
system.get("/ai/features", (c) => {
  const st = aiStatus();
  return c.json(Object.fromEntries(Object.entries(st.features).map(([id, f]: [string, any]) => [id, f.enabled])));
});
// Suggest→pin: AI proposes control ids for unmapped Defender/Policy keys; the admin pins them via the control-map editor.
system.post("/evidence/suggest-mapping", async (c) => {
  try { const r = await suggestEvidenceMapping(); audit(actorOf(c), "ai:suggest_mapping", "settings", null, { unmapped: r.unmapped.length, suggested: Object.keys(r.map).length }); return c.json(r); }
  catch (e: any) { return c.json({ error: String(e.message || e).slice(0, 300) }, /not enabled/i.test(String(e.message)) ? 409 : e.status || 502); }
});
// A one-line round-trip through a configured provider; manage_platform via the default route rule for unlisted mutations.
system.post("/ai/test", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  try {
    const r = await aiTest(String(b.provider || ""), b.model ? String(b.model) : undefined);
    audit(actorOf(c), "ai:test", "settings", null, { provider: r.provider, model: r.model, ok: true });
    return c.json(r);
  } catch (e: any) {
    return c.json({ ok: false, error: String(e.message || e).slice(0, 300) }, 502);
  }
});
system.post("/backup", (c) => { const p = backupNow(); audit(actorOf(c), "backup", "tenant", null, { path: p }); return c.json({ path: p }); });
system.get("/health", (c) => c.json({ ok: true, time: nowIso() }));
