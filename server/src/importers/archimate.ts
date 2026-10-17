// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: The archigov Authors
import { db, uid, nowIso, audit } from "../db.js";
import { ingestResources, hashOf, relationHash, listElements, type NormalisedResource } from "../model.js";
import { createArtefact } from "../artefacts.js";

/**
 * ArchiMate import. Accepts the Open Group ArchiMate Model Exchange File Format (http://www.opengroup.org/xsd/archimate/3.0/:
 * <model><elements><element identifier xsi:type><name>…</name></element></elements><relationships><relationship source target xsi:type/></relationships></model>)
 * and Archi's native .archimate file (elements with xsi:type="archimate:ApplicationComponent" and a name attribute;
 * relationships as elements whose type ends in "Relationship").
 *
 * An existing repository is a *source* for the derived model, not a hand-authored truth: application components
 * become applications and technology elements become resources, each with provenance { method: "archimate" } and
 * unverified until a person stands behind them. Everything else (business, motivation, strategy layers) is skipped
 * and reported, because it has no place in a model that is checked against a cloud estate.
 */
export const APP_TYPES = new Set(["ApplicationComponent", "ApplicationCollaboration"]);
export const TECH_TYPES = new Set(["Node", "Device", "SystemSoftware", "TechnologyService", "TechnologyInterface", "CommunicationNetwork", "Path", "Artifact", "Equipment", "Facility"]);
/** Motivation elements that map onto the governance catalogue: a Principle is a principle, a Constraint is a mandatory policy. Requirements are reported, not imported. */
export const MOTIVATION_TYPES: Record<string, "principle" | "policy"> = { Principle: "principle", Constraint: "policy" };
/** source → target relation kinds that mean "target is realised/served by source" (so target depends on source). */
const DEPENDENCY_RELATIONS = new Set(["Serving", "Flow", "Triggering", "Realization", "Assignment", "Composition", "Aggregation", "Access"]);

export interface AmElement { id: string; type: string; name: string }
export interface AmRelationship { id: string; type: string; source: string; target: string }

const decode = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, "&").trim();
const attrs = (tag: string): Record<string, string> => { const out: Record<string, string> = {}; for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = decode(m[2]); return out; };
const local = (qname: string) => qname.split(":").pop()!;

/** Tolerant single-pass scan: no dependency, handles both file formats, ignores what it does not know. */
export function parseArchimate(xml: string): { name: string | null; elements: AmElement[]; relationships: AmRelationship[] } {
  const elements: AmElement[] = []; const relationships: AmRelationship[] = [];
  const tagRe = /<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;
  let modelName: string | null = null;
  const nameAfter = (from: number, closing: string): string | null => {
    // the element's own <name> child, before its closing tag (or the next sibling start tag)
    const end = xml.indexOf(closing, from); const scope = xml.slice(from, end < 0 ? Math.min(xml.length, from + 4000) : end);
    const m = scope.match(/<(?:[\w.-]+:)?name\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?name>/);
    return m ? decode(m[1]) : null;
  };
  for (const m of xml.matchAll(tagRe)) {
    const [whole, close, qname, attrText, selfClose] = m; if (close) continue;
    const n = local(qname); const a = attrs(attrText);
    const xsiType = (a["xsi:type"] || a.type || "").replace(/^archimate:/, "");
    const after = m.index! + whole.length;
    if (n === "model" && modelName === null) { modelName = a.name || nameAfter(after, "<elements") || nameAfter(after, "<folder") || null; continue; }
    if (n === "relationship" || (n === "element" && /Relationship$/.test(xsiType))) {
      const id = a.identifier || a.id; if (!id || !a.source || !a.target) continue;
      relationships.push({ id, type: xsiType.replace(/Relationship$/, ""), source: a.source, target: a.target }); continue;
    }
    if (n === "element") {
      const id = a.identifier || a.id; if (!id || !xsiType) continue;
      const name = a.name || (selfClose ? null : nameAfter(after, "</" + qname + ">")) || id;
      elements.push({ id, type: xsiType, name });
    }
  }
  return { name: modelName, elements, relationships };
}

function archimateSource(modelName: string | null, file: string | undefined) {
  const name = `ArchiMate: ${modelName || file || "model"}`;
  let src = db.prepare("SELECT * FROM sources WHERE kind='archimate' AND name=?").get(name) as any;
  if (!src) { src = { id: uid(), name }; db.prepare("INSERT INTO sources(id,kind,name,config_json,status,created_at) VALUES (?,?,?,?,?,?)").run(src.id, "archimate", name, JSON.stringify({ model: modelName, file: file || null }), "idle", nowIso()); }
  return src;
}

export function importArchimate(xml: string, actor: string, file?: string) {
  if (!/<\s*(?:[\w.-]+:)?(model|archimate:model)\b/i.test(xml) && !/<\s*(?:[\w.-]+:)?element\b/i.test(xml)) throw Object.assign(new Error("Not an ArchiMate exchange file: no <model> or <element> found"), { status: 400 });
  const parsed = parseArchimate(xml);
  const src = archimateSource(parsed.name, file);
  const now = nowIso();
  const warnings: string[] = [];
  const byId = new Map(parsed.elements.map((e) => [e.id, e]));
  const apps = parsed.elements.filter((e) => APP_TYPES.has(e.type));
  const techs = parsed.elements.filter((e) => TECH_TYPES.has(e.type));
  const motivation = parsed.elements.filter((e) => MOTIVATION_TYPES[e.type]);
  const skipped = parsed.elements.filter((e) => !APP_TYPES.has(e.type) && !TECH_TYPES.has(e.type) && !MOTIVATION_TYPES[e.type]);
  const skippedByType = skipped.reduce((m: Record<string, number>, e) => ((m[e.type] = (m[e.type] || 0) + 1), m), {});
  for (const [t, n] of Object.entries(skippedByType)) warnings.push(t === "Requirement" ? `${n} Requirement element${n > 1 ? "s" : ""} skipped: a requirement belongs in a backlog item or a design review, not the catalogue` : `${n} ${t} element${n > 1 ? "s" : ""} skipped (not part of the derived model)`);

  // motivation → governance catalogue, as drafts for the board (re-importing the same title is a no-op)
  const artefacts = { principle: 0, policy: 0, skipped: 0 };
  const titled = db.prepare("SELECT 1 FROM standards WHERE lower(title)=?");
  for (const m of motivation) {
    const kind = MOTIVATION_TYPES[m.type];
    if (titled.get(m.name.toLowerCase())) { artefacts.skipped++; continue; }
    try {
      createArtefact({ kind, title: m.name, category: "Imported", statement: m.name, rationale: `Imported from ArchiMate model ${parsed.name || file || "model"} (${m.type} ${m.id}).`, control_refs: [],
        enforcement: kind === "policy" ? "mandatory" : null, severity: kind === "policy" ? "medium" : "low" }, actor);
      artefacts[kind]++;
    } catch (e: any) { warnings.push(`${m.type} "${m.name}" not imported: ${e.message}`); artefacts.skipped++; }
  }

  // which application a technology element serves: the first app it is related to, either direction
  const owner = new Map<string, AmElement>();
  const appDeps: [string, string][] = []; // [dependent app id, dependency app id]
  const techDeps = new Map<string, Set<string>>();
  let unresolved = 0;
  for (const r of parsed.relationships) {
    const s = byId.get(r.source), t = byId.get(r.target);
    if (!s || !t) { unresolved++; continue; }
    const sApp = APP_TYPES.has(s.type), tApp = APP_TYPES.has(t.type), sTech = TECH_TYPES.has(s.type), tTech = TECH_TYPES.has(t.type);
    if (sTech && tApp && !owner.has(s.id)) owner.set(s.id, t);
    else if (sApp && tTech && !owner.has(t.id)) owner.set(t.id, s);
    if (sApp && tApp && DEPENDENCY_RELATIONS.has(r.type) && s.id !== t.id) appDeps.push([t.id, s.id]);
    if (sTech && tTech && DEPENDENCY_RELATIONS.has(r.type) && s.id !== t.id) { if (!techDeps.has(t.id)) techDeps.set(t.id, new Set()); techDeps.get(t.id)!.add(s.id); }
  }
  if (unresolved) warnings.push(`${unresolved} relationship${unresolved > 1 ? "s" : ""} referenced elements not in the file`);

  const ref = (id: string) => `archimate:${id}`.toLowerCase();
  const appIds = new Map<string, string>();
  const stats = { applications: 0, resources: 0, relations: 0 };
  db.transaction(() => {
    // applications: explicit elements with provenance; a person verifies them later
    const find = db.prepare("SELECT * FROM elements WHERE type='application' AND (source_ref=? OR replace(lower(name),' ','-')=?) AND deleted_at IS NULL");
    for (const a of apps) {
      const key = a.name.toLowerCase().replace(/\s+/g, "-");
      const cur = find.get(ref(a.id), key) as any;
      const provenance = JSON.stringify({ method: "archimate", file: file || null, model: parsed.name, archimateId: a.id, archimateType: a.type, imported_by: actor });
      if (cur) { db.prepare("UPDATE elements SET provenance_json=?, updated_at=? WHERE id=?").run(provenance, now, cur.id); appIds.set(a.id, cur.id); continue; }
      const id = uid();
      db.prepare(`INSERT INTO elements(id,type,subtype,name,props_json,tags_json,source_id,source_ref,provenance_json,origin,confidence,verification,content_hash,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,'unverified',?,?,?)`).run(id, "application", a.type, a.name, "{}", "{}", src.id, ref(a.id), provenance, "derived", 0.9, hashOf({ name: a.name, type: a.type }), now, now);
      appIds.set(a.id, id); stats.applications++;
    }
    // technology elements → resources through the normal ingest (so grouping, hashing and verification behave like a collector)
    const resources: NormalisedResource[] = techs.map((t) => {
      const tags: Record<string, string> = {};
      if (owner.has(t.id)) tags.app = owner.get(t.id)!.name;
      return { sourceRef: ref(t.id), name: t.name, type: `ArchiMate/${t.type}`, tags, props: { archimateType: t.type, archimateId: t.id }, dependsOn: Array.from(techDeps.get(t.id) || []).map(ref) };
    });
    if (resources.length) { const s = ingestResources(src.id, resources, actor); stats.resources = s.created + s.updated + s.unchanged; }
    // application → application dependencies
    const insRel = db.prepare(`INSERT INTO relations(id,from_id,to_id,type,provenance_json,confidence,origin,content_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(from_id,to_id,type) DO UPDATE SET deleted_at=NULL`);
    for (const [dependent, dependency] of appDeps) {
      const a = appIds.get(dependent), b = appIds.get(dependency); if (!a || !b || a === b) continue;
      const provenance_json = JSON.stringify({ method: "archimate", model: parsed.name });
      insRel.run(uid(), a, b, "depends_on", provenance_json, 0.9, "derived", relationHash({ from_id: a, to_id: b, type: "depends_on", provenance_json }), now);
      stats.relations++;
    }
    stats.relations += Array.from(techDeps.values()).reduce((n, s) => n + s.size, 0);
  })();
  db.prepare("UPDATE sources SET status='ok', last_sync_at=?, last_error=NULL, config_json=? WHERE id=?").run(now, JSON.stringify({ model: parsed.name, file: file || null, elements: parsed.elements.length }), src.id);
  audit(actor, "import_archimate", "source", src.id, { model: parsed.name, file: file || null, ...stats, artefacts, skipped: skipped.length, warnings: warnings.length });
  // applications known after import (for the response)
  const appNames = listElements("application").filter((a) => apps.some((x) => appIds.get(x.id) === a.id)).map((a) => a.name);
  return { elements: { applications: stats.applications, resources: stats.resources, skipped: skipped.length }, relations: stats.relations, artefacts, source_id: src.id, warnings, model: parsed.name, application_names: appNames };
}
