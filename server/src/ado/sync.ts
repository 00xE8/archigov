// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The Archigov Authors
import { db, uid, nowIso, audit } from "../db.js";
import { hashOf, listElements } from "../model.js";
import { fixturesEnabled } from "../azure/client.js";
import { adoConfig, adoConfigured, wiql, workItemsBatch, ADO_FIELDS } from "./client.js";

/**
 * Azure DevOps as a feed, never a gate. Work items are upserted by (source, external id); their content hash is
 * what reviews are approved against (work_items.approved_hash), so a change after approval is a material change
 * the Design Authority sees — the same semantics the demo and the simulate-change tool already use.
 */
export interface AdoWorkItem { id: number; rev: number; fields: Record<string, any>; url?: string }

/** The ADO source row. In fixture mode the demo backlog *is* the ADO project, so fixtures update it in place. */
export function adoSource(create = true): any {
  const demo = fixturesEnabled() ? (db.prepare("SELECT * FROM sources WHERE kind='demo-ado'").get() as any) : null;
  if (demo) return demo;
  let src = db.prepare("SELECT * FROM sources WHERE kind='ado'").get() as any;
  if (!src && create) {
    const { org, project, wiql: q } = adoConfig();
    src = { id: uid(), kind: "ado", name: `Azure DevOps (${org}/${project})` };
    db.prepare("INSERT INTO sources(id,kind,name,config_json,status,created_at) VALUES (?,?,?,?,?,?)").run(src.id, "ado", src.name, JSON.stringify({ org, project, wiql: q }), "idle", nowIso());
  }
  return src;
}

/** ADO descriptions are HTML; the model keeps text. */
export const stripHtml = (s: unknown) => String(s ?? "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|h\d)>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/[ \t]+\n/g, "\n").trim();

/** Service hooks (resourceVersion ≥ 2) send changed fields as { oldValue, newValue }; the 1.0 shape and the batch API send plain values. */
export function fieldValue(fields: Record<string, any>, name: string): any {
  const v = fields?.[name];
  return v && typeof v === "object" && !Array.isArray(v) && ("newValue" in v || "oldValue" in v) ? v.newValue : v;
}

const slugify = (s: string) => s.toLowerCase().replace(/\s+/g, "-");

/** Which application a work item belongs to: an explicit `app:<name>` tag or Custom.Application field, else an area path that names an application. */
function applicationFor(fields: Record<string, any>, tags: string[]): string | null {
  const apps = listElements("application");
  const byKey = new Map(apps.map((a) => [slugify(a.name), a.id]));
  const explicit = tags.find((t) => /^app:/i.test(t))?.slice(4).trim() || fieldValue(fields, "Custom.Application");
  if (explicit) { const id = byKey.get(slugify(String(explicit))); if (id) return id; }
  const area = String(fieldValue(fields, "System.AreaPath") || "").split("\\").pop() || "";
  return byKey.get(slugify(area)) || null;
}

export function mapWorkItem(w: AdoWorkItem) {
  const f = w.fields || {};
  const tags = String(fieldValue(f, "System.Tags") || "").split(";").map((t) => t.trim()).filter(Boolean);
  const title = String(fieldValue(f, "System.Title") || `#${w.id}`);
  const description = stripHtml(fieldValue(f, "System.Description"));
  return {
    external_id: String(w.id), rev: Number(w.rev ?? 0) || null, title, description,
    type: String(fieldValue(f, "System.WorkItemType") || "Work item"), state: fieldValue(f, "System.State") ? String(fieldValue(f, "System.State")) : null,
    area: String(fieldValue(f, "System.AreaPath") || "").split("\\").pop() || null, iteration: fieldValue(f, "System.IterationPath") ? String(fieldValue(f, "System.IterationPath")) : null,
    priority: fieldValue(f, "Microsoft.VSTS.Common.Priority") != null ? Number(fieldValue(f, "Microsoft.VSTS.Common.Priority")) : null,
    tags, changed_at: fieldValue(f, "System.ChangedDate") ? String(fieldValue(f, "System.ChangedDate")) : nowIso(),
    url: w.url || null, content_hash: hashOf([title, description]), application_id: applicationFor(f, tags),
  };
}

export type UpsertOutcome = { outcome: "created" | "updated" | "unchanged" | "skipped_old_rev"; material_change: boolean; id: string };

/**
 * Upsert one work item. Idempotent on (id, rev): an older or equal revision never overwrites a newer one. Links
 * a person made (application/decision/review) are kept; application is only filled when it was empty.
 */
export function upsertWorkItem(sourceId: string, w: AdoWorkItem, actor: string, via: "sync" | "hook" = "sync"): UpsertOutcome {
  const m = mapWorkItem(w);
  const cur = db.prepare("SELECT * FROM work_items WHERE source_id=? AND external_id=?").get(sourceId, m.external_id) as any;
  if (!cur) {
    const id = uid();
    db.prepare(`INSERT INTO work_items(id,source_id,external_id,type,title,state,area,description,tags_json,application_id,content_hash,material_change,changed_at,created_at,rev,url,iteration,priority)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?)`).run(id, sourceId, m.external_id, m.type, m.title, m.state, m.area, m.description, JSON.stringify(m.tags), m.application_id, m.content_hash, m.changed_at, nowIso(), m.rev, m.url, m.iteration, m.priority);
    audit(actor, "work_item_created", "work_items", id, { external_id: m.external_id, rev: m.rev, via });
    return { outcome: "created", material_change: false, id };
  }
  if (m.rev != null && cur.rev != null && m.rev <= cur.rev) return { outcome: "skipped_old_rev", material_change: !!cur.material_change, id: cur.id };
  const changed = cur.content_hash !== m.content_hash;
  const material = cur.approved_hash != null && cur.approved_hash !== m.content_hash;
  db.prepare(`UPDATE work_items SET type=?, title=?, state=?, area=?, description=?, tags_json=?, application_id=COALESCE(application_id, ?), content_hash=?, changed_at=?,
    material_change=CASE WHEN approved_hash IS NOT NULL AND approved_hash<>? THEN 1 ELSE material_change END, rev=?, url=?, iteration=?, priority=? WHERE id=?`)
    .run(m.type, m.title, m.state, m.area, m.description, JSON.stringify(m.tags), m.application_id, m.content_hash, m.changed_at, m.content_hash, m.rev, m.url, m.iteration, m.priority, cur.id);
  if (changed) audit(actor, "work_item_changed", "work_items", cur.id, { external_id: m.external_id, rev: m.rev, material_change: material, via });
  return { outcome: changed ? "updated" : "unchanged", material_change: material, id: cur.id };
}

/** WIQL backfill: ids from the configured query, fields in batches of 200, upserted; recorded as a sync run. */
export async function syncAdo(actor: string) {
  if (!adoConfigured()) throw Object.assign(new Error("Azure DevOps is not configured (ADO_ORG, ADO_PROJECT and ADO_PAT or an Entra identity)"), { status: 400 });
  const src = adoSource();
  const runId = uid();
  db.prepare("INSERT INTO runs(id,kind,source_id,started_at) VALUES (?,?,?,?)").run(runId, "sync", src.id, nowIso());
  try {
    const { wiql: query } = adoConfig();
    const ids = (await wiql(query)).workItems.map((w) => w.id);
    const items = await workItemsBatch(ids);
    const stats = { fetched: items.length, created: 0, updated: 0, unchanged: 0, skipped_old_rev: 0, material_changes: 0 };
    db.transaction(() => { for (const w of items) { const r = upsertWorkItem(src.id, w, actor, "sync"); stats[r.outcome]++; if (r.material_change) stats.material_changes++; } })();
    db.prepare("UPDATE sources SET status='ok', last_sync_at=?, last_error=NULL WHERE id=?").run(nowIso(), src.id);
    db.prepare("UPDATE runs SET finished_at=?, status='done', stats_json=? WHERE id=?").run(nowIso(), JSON.stringify(stats), runId);
    audit(actor, "sync", "source", src.id, { kind: "ado", ...stats });
    return { ok: true as const, run_id: runId, ...stats };
  } catch (e: any) {
    db.prepare("UPDATE sources SET status='error', last_error=? WHERE id=?").run(String(e.message), src.id);
    db.prepare("UPDATE runs SET finished_at=?, status='error', error=? WHERE id=?").run(nowIso(), String(e.message), runId);
    return { ok: false as const, run_id: runId, error: String(e.message) };
  }
}

/** "Test connection": run the configured WIQL and report how many items it covers. */
export async function testAdo() {
  const { org, project } = adoConfig();
  if (!adoConfigured()) return { ok: false, org, project, error: "Azure DevOps is not configured (ADO_ORG, ADO_PROJECT and ADO_PAT or an Entra identity)" };
  try { const r = await wiql(adoConfig().wiql); return { ok: true, org, project, work_item_count: r.workItems.length, fixtures: fixturesEnabled() }; }
  catch (e: any) { return { ok: false, org, project, error: String(e.message) }; }
}

/**
 * A service-hook delivery (workitem.created / updated / deleted / restored). The payload carries the item's
 * fields at that revision, so no call back to ADO is needed. Deleted items are kept with state 'Removed'.
 * https://learn.microsoft.com/azure/devops/service-hooks/events#work-item-events
 */
export function handleAdoHook(payload: any, actor = "ado-hook") {
  const type = String(payload?.eventType || "");
  if (!/^workitem\.(created|updated|deleted|restored|commented)$/.test(type)) throw Object.assign(new Error(`unsupported eventType "${type}"`), { status: 400 });
  const res = payload.resource || {};
  const id = Number(res.workItemId ?? res.id); if (!id) throw Object.assign(new Error("payload has no work item id"), { status: 400 });
  // updated events (resourceVersion >= 2) carry the full item under resource.revision and field diffs under resource.fields
  const fields: Record<string, any> = { ...(res.revision?.fields || {}), ...(res.fields || {}) };
  if (type === "workitem.deleted") fields["System.State"] = "Removed";
  const rev = Number(res.rev ?? res.revision?.rev ?? 0);
  const src = adoSource();
  const r = upsertWorkItem(src.id, { id, rev, fields, url: res.url || res.revision?.url }, actor, "hook");
  audit(actor, "ado_hook", "work_items", r.id, { eventType: type, external_id: String(id), rev, outcome: r.outcome, material_change: r.material_change });
  return { ok: true, work_item_id: r.id, external_id: String(id), outcome: r.outcome, material_change: r.material_change };
}

export { ADO_FIELDS };
