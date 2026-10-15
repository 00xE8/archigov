import { db, j } from "../db.js";
import { resourcesOf } from "../model.js";

/**
 * Areas of responsibility. A board carries a list of areas (the seeded eight, or custom ones), each decision maker
 * owns some of them, and every review touches some: derived from what the review is about (categories of the
 * catalogue items its pre-review cites, the sections of a design, the resource types of the application, the
 * topic of a decision), restricted to the board's areas and kept in the board's order. The chair declares an
 * outcome only when every touched area has a position from the decision maker who owns it (areas mode); a board
 * with no areas runs its policies in count mode and its reviews touch nothing.
 */
export interface Area { id: string; label: string }
export const AREA_CATALOGUE: Area[] = [
  { id: "security", label: "Security" }, { id: "data", label: "Data" }, { id: "integration", label: "Integration" },
  { id: "infrastructure", label: "Infrastructure" }, { id: "resilience", label: "Resilience & operations" }, { id: "cost", label: "Cost" },
  { id: "compliance", label: "Privacy & compliance" }, { id: "ai", label: "AI" },
];
export const AREA_LABELS: Record<string, string> = Object.fromEntries(AREA_CATALOGUE.map((a) => [a.id, a.label]));
export const areaLabel = (id: string, boardAreas?: Area[]) => boardAreas?.find((a) => a.id === id)?.label ?? AREA_LABELS[id] ?? id;
export const slugArea = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

/** A board's areas as stored (`areas_json`: ids of seeded areas or `{id,label}` objects for custom ones), normalised to {id,label}. */
export function parseBoardAreas(json: string | null | undefined): Area[] {
  const raw = j(json, []);
  if (!Array.isArray(raw)) return [];
  const out: Area[] = [];
  for (const x of raw) {
    const id = typeof x === "string" ? slugArea(x) : typeof x?.id === "string" ? slugArea(x.id) : "";
    if (!id || out.some((a) => a.id === id)) continue;
    out.push({ id, label: typeof x === "object" && typeof x?.label === "string" && x.label.trim() ? x.label.trim().slice(0, 80) : AREA_LABELS[id] ?? id });
  }
  return out;
}
export const boardAreas = (boardId: string | null | undefined): Area[] => boardId ? parseBoardAreas((db.prepare("SELECT areas_json FROM boards WHERE id=?").get(boardId) as any)?.areas_json) : [];
/** Validate a client-supplied area list for a board: seeded ids by name, anything else as a custom `{id,label}`. Throws a readable message. */
export function normaliseAreasInput(input: unknown): Area[] {
  if (!Array.isArray(input)) throw new Error("areas must be an array");
  const out: Area[] = [];
  for (const x of input) {
    if (typeof x === "string") { const id = slugArea(x); if (!id) throw new Error("an area id cannot be empty"); if (!AREA_LABELS[id]) throw new Error(`unknown area "${x}": give a custom area as { id, label }`); if (!out.some((a) => a.id === id)) out.push({ id, label: AREA_LABELS[id] }); continue; }
    if (x && typeof x === "object" && typeof (x as any).id === "string") {
      const id = slugArea((x as any).id); if (!id) throw new Error("an area id cannot be empty");
      const label = typeof (x as any).label === "string" && (x as any).label.trim() ? String((x as any).label).trim().slice(0, 80) : AREA_LABELS[id];
      if (!label) throw new Error(`custom area "${id}" needs a label`);
      if (!out.some((a) => a.id === id)) out.push({ id, label }); continue;
    }
    throw new Error("each area is an id (seeded) or { id, label } (custom)");
  }
  return out;
}
/** The areas a member owns, kept to the board's areas and order. */
export const memberAreas = (boardId: string, userId: string): string[] => {
  const ids = boardAreas(boardId).map((a) => a.id);
  const own: unknown = j((db.prepare("SELECT areas_json FROM board_members WHERE board_id=? AND user_id=?").get(boardId, userId) as any)?.areas_json, []);
  return Array.isArray(own) ? ids.filter((id) => own.includes(id)) : [];
};

// ---------- derivation ----------
/** Category / topic → area. Case-insensitive; a category may carry a suffix ("Security & identity"). Unknown → ignored. */
const CATEGORY_MAP: [string[], string][] = [
  [["security"], "security"],
  [["data", "storage", "database", "data-store"], "data"],
  [["networking", "network", "integration", "messaging", "api"], "integration"],
  [["hosting", "compute", "infrastructure", "platform", "cloud"], "infrastructure"],
  [["resilience", "availability", "operations", "backup"], "resilience"],
  [["cost", "finops"], "cost"],
  [["governance", "compliance", "privacy", "regulatory", "principle"], "compliance"],
  [["ai", "ml", "ai-system"], "ai"],
];
export function areaOfCategory(category: string | null | undefined): string | null {
  const cat = String(category || "").trim().toLowerCase();
  if (!cat) return null;
  const head = cat.split(/[^a-z0-9-]+/)[0] || cat;
  for (const [keys, area] of CATEGORY_MAP) for (const k of keys) if (cat === k || head === k || cat.startsWith(k + " ") || cat.startsWith(k + "-") || cat.startsWith(k + "/")) return area;
  return null;
}
const RESOURCE_MAP: [RegExp, string][] = [
  [/^microsoft\.(sql|storage|documentdb|dbforpostgresql)\//i, "data"],
  [/^microsoft\.network\//i, "integration"],
  [/^microsoft\.(compute|web|containerservice)\//i, "infrastructure"],
  [/^microsoft\.(cognitiveservices|machinelearning)/i, "ai"],
  [/^microsoft\.keyvault\//i, "security"],
];
export function areaOfResourceType(type: string | null | undefined): string | null {
  const t = String(type || "");
  for (const [re, area] of RESOURCE_MAP) if (re.test(t)) return area;
  return null;
}
const SECTION_MAP: [string, string][] = [["data", "data"], ["security", "security"], ["resilience", "resilience"]];
/** Headings of the design whose body is not empty (a template hint left in place is stored empty, so it does not count). */
function nonEmptySections(md: string | null | undefined): string[] {
  const out: string[] = [];
  for (const chunk of String(md || "").split(/(?=^#{1,6}\s)/m)) {
    const m = chunk.match(/^(#{1,6})\s+([^\n]*)\n?([\s\S]*)$/);
    if (!m || !m[3].trim()) continue;
    out.push(m[2].toLowerCase().trim());
  }
  return out;
}
const categoryOfStandard = (code: string) => (db.prepare("SELECT category FROM standards WHERE code=?").get(code) as any)?.category ?? null;
const categoryOfStandardId = (id: string) => (db.prepare("SELECT category FROM standards WHERE id=?").get(id) as any)?.category ?? null;

/**
 * The areas a review touches, derived from its content and restricted to its board's areas (board order). Empty
 * → the board's first area, so an item always has at least one gate; a board without areas → [] (count mode).
 */
export function deriveAreas(review: { id: string; type: string; board_id: string | null; application_id?: string | null; design_md?: string | null; target_kind?: string | null; target_id?: string | null; decision_id?: string | null }, boardId: string | null = review.board_id): string[] {
  const board = boardAreas(boardId);
  if (!board.length) return [];
  const found = new Set<string>();
  const add = (a: string | null) => { if (a) found.add(a); };
  if (review.type === "design") {
    // the catalogue items the latest pre-review cites
    const pre = db.prepare("SELECT data_json FROM review_events WHERE review_id=? AND kind='pre_review' ORDER BY created_at DESC LIMIT 1").get(review.id) as any;
    for (const f of j(pre?.data_json, {})?.findings || []) for (const c of f?.citations || []) if (c?.kind === "standard" && c.ref) add(areaOfCategory(categoryOfStandard(String(c.ref))));
    for (const h of nonEmptySections(review.design_md)) for (const [key, area] of SECTION_MAP) if (h === key || h.split(/\W+/).includes(key)) add(area);
    if (review.application_id) for (const r of resourcesOf(review.application_id)) add(areaOfResourceType(r.subtype));
  } else if (review.type === "decision") {
    const d = db.prepare("SELECT topic, standard_ids_json FROM decisions WHERE id=?").get(review.target_id || review.decision_id || "") as any;
    add(areaOfCategory(d?.topic));
    for (const id of j(d?.standard_ids_json, []) || []) add(areaOfCategory(categoryOfStandardId(String(id))));
  } else if (review.type === "exception") {
    const f = review.target_kind === "finding" && review.target_id ? (db.prepare("SELECT s.category FROM findings f JOIN standards s ON s.id=f.standard_id WHERE f.id=?").get(review.target_id) as any) : null;
    add(areaOfCategory(f?.category ?? (review.target_kind === "artefact" && review.target_id ? categoryOfStandardId(review.target_id) : null)));
  } else if (review.target_id) { // standard, principle, pattern, policy
    add(areaOfCategory(categoryOfStandardId(review.target_id)));
  }
  const touched = board.map((a) => a.id).filter((id) => found.has(id));
  return touched.length ? touched : [board[0].id];
}
/** Area ids a review touches as stored; NULL (not derived yet) is derived on the fly without being stored. */
export const touchedAreas = (review: Parameters<typeof deriveAreas>[0] & { areas_json?: string | null }): string[] => {
  const stored = review.areas_json == null ? null : j(review.areas_json, null);
  return Array.isArray(stored) ? stored.filter((x): x is string => typeof x === "string") : deriveAreas(review);
};
