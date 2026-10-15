import { db, audit } from "./db.js";
import { evaluateAll } from "./rules.js";
import { createArtefact } from "./artefacts.js";
import { PACKS, type StandardsPack } from "./packs/index.js";
export { PACKS, CORE_STANDARDS, type PackStandard, type StandardsPack } from "./packs/index.js";

/**
 * Standards packs: importable, versioned sets of governance artefacts. The content lives in ./packs/ (Apache-2.0, so
 * packs can be contributed and reused without the CLA); this loader — listing, lookup and import into the catalogue —
 * is part of the AGPL core. The core pack is what an empty instance needs before Conformance, pre-review and evidence
 * packs mean anything; the demo seeds the same definitions, so each standard has exactly one source of truth.
 */
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
