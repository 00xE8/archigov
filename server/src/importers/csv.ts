import { db, uid, nowIso, audit } from "../db.js";
import { ingestResources, relationHash, type NormalisedResource } from "../model.js";
import { createArtefact, isKind } from "../artefacts.js";

/**
 * CSV import: an existing inventory (a CMDB export, a spreadsheet) becomes a source that feeds the derived model
 * through the same ingest path as a collector, with provenance { method: "csv", file }. Re-importing a file of the
 * same name replaces that file's resources (the source is per file name), exactly like a collector resync.
 */
export const RESOURCE_COLUMNS = ["id", "name", "type", "location", "resourceGroup", "subscriptionId", "tags", "properties", "dependsOn"] as const;
export const RELATION_COLUMNS = ["from_ref", "to_ref", "type"] as const;
/** Governance artefacts (standards, principles, patterns, policies) arrive as drafts for their board to review. */
export const ARTEFACT_COLUMNS = ["kind", "title", "category", "statement", "rationale", "control_refs", "rule_json", "enforcement", "severity", "status", "context", "solution", "applicability"] as const;

/** RFC 4180-style parser: quoted fields, doubled quotes, embedded commas and newlines, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let field = ""; let quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && s[i + 1] === "\n") i++; row.push(field); rows.push(row); row = []; field = ""; }
    else field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export function csvTemplate(kind: "resources" | "relations" | "artefacts"): string {
  if (kind === "artefacts") return `${ARTEFACT_COLUMNS.join(",")}\npolicy,Production data stays in UK regions,Hosting,Every production resource is deployed in a UK region.,Regulatory residency expectation.,UK GDPR Art.44; DSPT 2025 A1.a,"{""scope"":""resource"",""match"":{""where"":[{""path"":""tags.env"",""op"":""eq"",""value"":""prod""}]},""assert"":{""path"":""location"",""op"":""in"",""value"":[""uksouth"",""ukwest""]}}",mandatory,high,adopt,,,\npattern,One Key Vault per application,Security,Each application keeps its secrets in a single vault it owns.,Shared vaults blur ownership.,ISO 27001 A.8.24,,,medium,adopt,Teams create vaults ad hoc.,Provision one vault per application with RBAC.,All applications holding secrets\n`;
  if (kind === "relations") return `${RELATION_COLUMNS.join(",")}\n/subscriptions/0000/resourcegroups/rg-claims-prod/providers/microsoft.web/sites/app-claims-api,/subscriptions/0000/resourcegroups/rg-claims-prod/providers/microsoft.sql/servers/sql-claims,depends_on\n`;
  return `${RESOURCE_COLUMNS.join(",")}\n/subscriptions/0000/resourcegroups/rg-claims-prod/providers/microsoft.web/sites/app-claims-api,app-claims-api,Microsoft.Web/sites,uksouth,rg-claims-prod,0000,app=claims;owner=claims-team;env=prod,"{""httpsOnly"":true,""minTlsVersion"":""1.2""}",\n`;
}

const header = (row: string[]) => row.map((h) => h.trim().replace(/^"|"$/g, ""));
const idx = (cols: string[], name: string) => cols.findIndex((c) => c.toLowerCase() === name.toLowerCase());

function csvSource(file: string | undefined) {
  const name = file ? `CSV import (${file})` : "CSV import";
  let src = db.prepare("SELECT * FROM sources WHERE kind='csv' AND name=?").get(name) as any;
  if (!src) { src = { id: uid(), name }; db.prepare("INSERT INTO sources(id,kind,name,config_json,status,created_at) VALUES (?,?,?,?,?,?)").run(src.id, "csv", name, JSON.stringify({ file: file || null }), "idle", nowIso()); }
  return src;
}

const parseTags = (s: string) => Object.fromEntries(s.split(/[;|]/).map((kv) => kv.split("=")).filter((kv) => kv[0]?.trim()).map(([k, ...v]) => [k.trim(), v.join("=").trim()]));

export function importResourcesCsv(csv: string, actor: string, file?: string) {
  const rows = parseCsv(csv);
  if (rows.length < 2) throw Object.assign(new Error("CSV needs a header row and at least one data row"), { status: 400 });
  const cols = header(rows[0]);
  for (const req of ["id", "name", "type"]) if (idx(cols, req) < 0) throw Object.assign(new Error(`CSV is missing the required column "${req}" (columns: ${RESOURCE_COLUMNS.join(", ")})`), { status: 400 });
  const col = (r: string[], name: string) => { const i = idx(cols, name); return i < 0 ? "" : (r[i] ?? "").trim(); };
  const errors: { line: number; message: string }[] = [];
  const resources: NormalisedResource[] = [];
  const seen = new Set<string>();
  rows.slice(1).forEach((r, k) => {
    const line = k + 2;
    const id = col(r, "id"), name = col(r, "name"), type = col(r, "type");
    if (!id || !name || !type) return void errors.push({ line, message: "id, name and type are required" });
    const ref = id.toLowerCase();
    if (seen.has(ref)) return void errors.push({ line, message: `duplicate id ${id}` });
    let props: Record<string, unknown> = {};
    const rawProps = col(r, "properties");
    if (rawProps) { try { const p = JSON.parse(rawProps); if (!p || typeof p !== "object" || Array.isArray(p)) throw new Error(); props = p; } catch { return void errors.push({ line, message: "properties must be a JSON object" }); } }
    seen.add(ref);
    resources.push({ sourceRef: ref, name, type, location: col(r, "location") || undefined, resourceGroup: col(r, "resourceGroup") || undefined, subscription: col(r, "subscriptionId") || undefined,
      tags: parseTags(col(r, "tags")), props, dependsOn: col(r, "dependsOn").split(/[;|]/).map((x) => x.trim().toLowerCase()).filter(Boolean) });
  });
  const src = csvSource(file);
  const stats = resources.length ? ingestResources(src.id, resources, actor) : { created: 0, updated: 0, unchanged: 0, removed: 0 } as any;
  db.prepare("UPDATE sources SET status=?, last_sync_at=?, last_error=NULL, config_json=? WHERE id=?").run(errors.length && !resources.length ? "error" : "ok", nowIso(), JSON.stringify({ file: file || null, rows: resources.length }), src.id);
  audit(actor, "import_csv", "source", src.id, { kind: "resources", file: file || null, rows: rows.length - 1, created: stats.created, updated: stats.updated, unchanged: stats.unchanged, errors: errors.length });
  return { created: stats.created, updated: stats.updated, unchanged: stats.unchanged, removed: stats.removed ?? 0, errors, source_id: src.id };
}

/** Artefacts CSV → drafts. One row per artefact; bad rows are reported by line and never half-imported. */
export function importArtefactsCsv(csv: string, actor: string, file?: string) {
  const rows = parseCsv(csv);
  if (rows.length < 2) throw Object.assign(new Error("CSV needs a header row and at least one data row"), { status: 400 });
  const cols = header(rows[0]);
  for (const req of ["kind", "title", "statement"]) if (idx(cols, req) < 0) throw Object.assign(new Error(`CSV is missing the required column "${req}" (columns: ${ARTEFACT_COLUMNS.join(", ")})`), { status: 400 });
  const col = (r: string[], name: string) => { const i = idx(cols, name); return i < 0 ? "" : (r[i] ?? "").trim(); };
  const errors: { line: number; message: string }[] = []; const codes: string[] = [];
  let created = 0;
  rows.slice(1).forEach((r, k) => {
    const line = k + 2;
    const kind = col(r, "kind").toLowerCase();
    if (!isKind(kind)) return void errors.push({ line, message: `kind must be one of standard, principle, pattern, policy (got "${kind || "blank"}")` });
    let rule: any = null;
    const rawRule = col(r, "rule_json");
    if (rawRule) { try { rule = JSON.parse(rawRule); } catch { return void errors.push({ line, message: "rule_json must be a JSON object" }); } }
    try {
      const res = createArtefact({ kind, title: col(r, "title"), category: col(r, "category") || "Imported", statement: col(r, "statement"), rationale: col(r, "rationale") || null,
        control_refs: col(r, "control_refs").split(/[;|]/).map((x) => x.trim()).filter(Boolean), rule, enforcement: col(r, "enforcement") || null, severity: col(r, "severity") || "medium", status: col(r, "status") || "adopt",
        context: col(r, "context") || null, solution: col(r, "solution") || null, applicability: col(r, "applicability") || null }, actor);
      created++; codes.push(res.code);
    } catch (e: any) { errors.push({ line, message: String(e.message) }); }
  });
  audit(actor, "import_artefacts", "standards", null, { source: "csv", file: file || null, rows: rows.length - 1, created, errors: errors.length });
  return { created, updated: 0, unchanged: 0, errors, codes, lifecycle: "draft" };
}

export function importRelationsCsv(csv: string, actor: string, file?: string) {
  const rows = parseCsv(csv);
  if (rows.length < 2) throw Object.assign(new Error("CSV needs a header row and at least one data row"), { status: 400 });
  const cols = header(rows[0]);
  for (const req of ["from_ref", "to_ref"]) if (idx(cols, req) < 0) throw Object.assign(new Error(`CSV is missing the required column "${req}" (columns: ${RELATION_COLUMNS.join(", ")})`), { status: 400 });
  const col = (r: string[], name: string) => { const i = idx(cols, name); return i < 0 ? "" : (r[i] ?? "").trim(); };
  const byRef = db.prepare("SELECT id FROM elements WHERE lower(source_ref)=? AND deleted_at IS NULL");
  const exists = db.prepare("SELECT id, deleted_at FROM relations WHERE from_id=? AND to_id=? AND type=?");
  const ins = db.prepare(`INSERT INTO relations(id,from_id,to_id,type,provenance_json,confidence,origin,content_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(from_id,to_id,type) DO UPDATE SET deleted_at=NULL, provenance_json=excluded.provenance_json`);
  const src = csvSource(file);
  const errors: { line: number; message: string }[] = [];
  let created = 0, unchanged = 0;
  db.transaction(() => {
    rows.slice(1).forEach((r, k) => {
      const line = k + 2;
      const from = col(r, "from_ref").toLowerCase(), to = col(r, "to_ref").toLowerCase(), type = col(r, "type") || "depends_on";
      if (!from || !to) return void errors.push({ line, message: "from_ref and to_ref are required" });
      if (!/^[a-z_]+$/.test(type)) return void errors.push({ line, message: `invalid relation type "${type}"` });
      const a = byRef.get(from) as any, b = byRef.get(to) as any;
      if (!a) return void errors.push({ line, message: `unknown from_ref ${from}` });
      if (!b) return void errors.push({ line, message: `unknown to_ref ${to}` });
      const cur = exists.get(a.id, b.id, type) as any;
      if (cur && !cur.deleted_at) { unchanged++; return; }
      const provenance_json = JSON.stringify({ method: "csv", file: file || null, imported_by: actor });
      ins.run(uid(), a.id, b.id, type, provenance_json, 1, "derived", relationHash({ from_id: a.id, to_id: b.id, type, provenance_json }), nowIso());
      created++;
    });
  })();
  audit(actor, "import_csv", "source", src.id, { kind: "relations", file: file || null, rows: rows.length - 1, created, unchanged, errors: errors.length });
  return { created, updated: 0, unchanged, errors, source_id: src.id };
}
