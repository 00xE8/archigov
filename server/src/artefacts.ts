import { db, uid, nowIso, j, audit } from "./db.js";
import { hashOf, standardHash, setVerification } from "./model.js";
import { std } from "./http.js";
import { validateRule, evaluateArtefact, modelContext, lastRuleErrors, type Rule } from "./rules.js";

/**
 * The governance catalogue. Four kinds of artefact share one table (`standards`, kept for compatibility) and one
 * rule engine: a standard or policy with a rule is evaluated exactly like any other, a pattern can carry a checkable
 * constraint, a principle is evidenced through reviews. Every artefact has a lifecycle — only adopted ones produce
 * findings — and a version that bumps when an adopted artefact is revised (the revision is a new draft until a
 * review adopts it again). Lifecycle transitions are made by the review workflow (see setArtefactLifecycle).
 */
export type ArtefactKind = "standard" | "principle" | "pattern" | "policy";
export type Lifecycle = "draft" | "in_review" | "adopted" | "retired";

export const KINDS: { kind: ArtefactKind; prefix: "STD" | "PRN" | "PAT" | "POL"; description: string }[] = [
  { kind: "standard", prefix: "STD", description: "A rule the estate is held to, with control references; evaluated continuously where it has a checkable rule." },
  { kind: "principle", prefix: "PRN", description: "A statement of intent that guides decisions; evidenced through reviews, never evaluated by rule." },
  { kind: "pattern", prefix: "PAT", description: "A reusable solution to a recurring problem — context, solution, applicability — optionally with a checkable constraint." },
  { kind: "policy", prefix: "POL", description: "A mandatory or recommended organisational rule; checkable where the derived model can express it." },
];
export const LIFECYCLES: Lifecycle[] = ["draft", "in_review", "adopted", "retired"];
export const isKind = (k: unknown): k is ArtefactKind => KINDS.some((x) => x.kind === k);
export const prefixOf = (kind: ArtefactKind) => KINDS.find((x) => x.kind === kind)!.prefix;
export const kindOf = (id: string): ArtefactKind | null => ((db.prepare("SELECT kind FROM standards WHERE id=?").get(id) as any)?.kind ?? null);

/** Codes are three digits for every kind (STD-001, PRN-001, PAT-001, POL-001), numbered per prefix; suffixed pack codes (STD-WAF-01) do not collide. */
export function nextArtefactCode(kind: ArtefactKind): string {
  const prefix = prefixOf(kind);
  const row = db.prepare("SELECT max(CAST(substr(code, ?) AS INTEGER)) n FROM standards WHERE code LIKE ?").get(prefix.length + 2, `${prefix}-%`) as any;
  return `${prefix}-${String((row?.n || 0) + 1).padStart(3, "0")}`;
}

export interface ArtefactContent {
  kind: ArtefactKind; title: string; category: string; statement: string; rationale?: string | null; status: string; severity: string;
  rule_json?: string | null; control_refs_json?: string; enforcement?: string | null; context?: string | null; solution?: string | null; applicability?: string | null;
}
/** Content hash. A plain standard hashes exactly as before this round (so nobody's verification drops on migration); the other kinds and the pattern/policy fields widen it. */
export function artefactHash(a: ArtefactContent): string {
  const base = { title: a.title, category: a.category, statement: a.statement, rationale: a.rationale ?? null, status: a.status, severity: a.severity, rule_json: a.rule_json ?? null, control_refs_json: a.control_refs_json ?? "[]" };
  if (a.kind === "standard" && !a.enforcement && !a.context && !a.solution && !a.applicability) return standardHash(base);
  return hashOf({ ...base, kind: a.kind, enforcement: a.enforcement ?? null, context: a.context ?? null, solution: a.solution ?? null, applicability: a.applicability ?? null });
}

export const mapArtefact = (r: any) => ({ ...std(r), kind: r.kind || "standard", lifecycle: r.lifecycle || "adopted", version: r.version ?? 1, board_id: r.board_id ?? null, enforcement: r.enforcement ?? null,
  context: r.context ?? null, solution: r.solution ?? null, applicability: r.applicability ?? null, review_id: r.review_id ?? null, adopted_at: r.adopted_at ?? null, retired_at: r.retired_at ?? null });

/** Kind-specific requirements: a pattern must explain its context and solution, a policy must say how hard it is. Throws a 400-shaped error. */
export function validateKindRequirements(a: { kind: ArtefactKind; context?: string | null; solution?: string | null; enforcement?: string | null; rule?: unknown }) {
  const bad = (m: string) => Object.assign(new Error(m), { status: 400 });
  if (!isKind(a.kind)) throw bad(`kind must be one of ${KINDS.map((k) => k.kind).join(", ")}`);
  if (a.kind === "pattern" && !(a.context && a.solution)) throw bad("a pattern needs a context and a solution");
  if (a.kind === "policy" && !["mandatory", "recommended"].includes(String(a.enforcement))) throw bad("a policy needs enforcement 'mandatory' or 'recommended'");
  if (a.kind === "principle" && a.rule) throw bad("a principle is evidenced through reviews, not a rule; use a standard or policy for a checkable rule");
  // a rule that does not even validate is rejected at save time (400); one that only fails at run time — an invalid
  // regex, say — is still caught by the engine as a rule_error, never a silent pass
  if (a.rule) { try { validateRule(a.rule as Rule); } catch (e: any) { throw bad(`rule: ${e.message}`); } }
}

export function artefactById(id: string): any | null {
  const r = db.prepare("SELECT * FROM standards WHERE id=?").get(id) as any;
  return r ? mapArtefact(r) : null;
}
export function artefactByCode(code: string): any | null {
  const r = db.prepare("SELECT * FROM standards WHERE code=?").get(code) as any;
  return r ? mapArtefact(r) : null;
}

export function listArtefacts(f: { kind?: string | null; lifecycle?: string | null; q?: string | null } = {}) {
  const where: string[] = []; const args: any[] = [];
  if (f.kind) { where.push("kind=?"); args.push(f.kind); }
  if (f.lifecycle) { where.push("lifecycle=?"); args.push(f.lifecycle); }
  if (f.q) { where.push("(lower(code) LIKE ? OR lower(title) LIKE ? OR lower(category) LIKE ? OR lower(control_refs_json) LIKE ?)"); const like = `%${f.q.toLowerCase()}%`; args.push(like, like, like, like); }
  const rows = db.prepare(`SELECT * FROM standards${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY code`).all(...args).map(mapArtefact);
  const counts = db.prepare("SELECT standard_id, status, count(*) c FROM findings GROUP BY standard_id, status").all() as any[];
  const errors = lastRuleErrors();
  return rows.map((s: any) => ({ ...s, open_findings: counts.find((x) => x.standard_id === s.id && x.status === "open")?.c || 0, excepted: counts.find((x) => x.standard_id === s.id && x.status === "excepted")?.c || 0, rule_error: errors[s.code] || null }));
}

export function kindCounts() {
  const rows = db.prepare("SELECT kind, lifecycle, count(*) c FROM standards GROUP BY kind, lifecycle").all() as any[];
  return KINDS.map((k) => ({ ...k, count: rows.filter((r) => r.kind === k.kind).reduce((n, r) => n + r.c, 0), adopted: rows.find((r) => r.kind === k.kind && r.lifecycle === "adopted")?.c || 0,
    drafts: rows.filter((r) => r.kind === k.kind && (r.lifecycle === "draft" || r.lifecycle === "in_review")).reduce((n, r) => n + r.c, 0) }));
}

export interface ArtefactInput {
  kind?: ArtefactKind; code?: string; title: string; category: string; statement: string; rationale?: string | null; status?: string; severity?: string;
  rule?: any; owner?: string; control_refs?: string[]; enforcement?: string | null; context?: string | null; solution?: string | null; applicability?: string | null;
}
/** Create an artefact as a draft (packs and the seed pass `lifecycle` to adopt immediately). Origin human, unverified: it is the author's claim until a review adopts it. */
export function createArtefact(input: ArtefactInput, actor: string, opts: { lifecycle?: Lifecycle; origin?: string; verification?: "verified" | "unverified"; verified_by?: string | null; verified_at?: string | null; created_at?: string | null; board_id?: string | null } = {}) {
  const kind: ArtefactKind = input.kind || "standard";
  validateKindRequirements({ kind, context: input.context, solution: input.solution, enforcement: input.enforcement, rule: input.rule ?? null });
  const code = input.code || nextArtefactCode(kind);
  if (db.prepare("SELECT 1 FROM standards WHERE code=?").get(code)) throw Object.assign(new Error(`${code} already exists`), { status: 409 });
  const id = uid(); const now = opts.created_at || nowIso();
  const content: ArtefactContent = { kind, title: input.title, category: input.category, statement: input.statement, rationale: input.rationale ?? null, status: input.status || "adopt", severity: input.severity || "medium",
    rule_json: input.rule ? JSON.stringify(input.rule) : null, control_refs_json: JSON.stringify(input.control_refs || []), enforcement: kind === "policy" ? input.enforcement : null,
    context: kind === "pattern" ? input.context : null, solution: kind === "pattern" ? input.solution : null, applicability: kind === "pattern" ? input.applicability ?? null : null };
  const hash = artefactHash(content);
  const lifecycle: Lifecycle = opts.lifecycle || "draft";
  db.prepare(`INSERT INTO standards(id,code,title,category,statement,rationale,status,severity,rule_json,owner,control_refs_json,origin,verification,verified_by,verified_at,content_hash,verified_hash,created_at,updated_at,
      kind,lifecycle,version,board_id,enforcement,context,solution,applicability,adopted_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?)`)
    .run(id, code, content.title, content.category, content.statement, content.rationale, content.status, content.severity, content.rule_json, input.owner || actor, content.control_refs_json,
      opts.origin || "human", opts.verification || "unverified", opts.verified_by ?? null, opts.verified_at ?? null, hash, opts.verification === "verified" ? hash : null, now, now,
      kind, lifecycle, opts.board_id ?? null, content.enforcement, content.context, content.solution, content.applicability, lifecycle === "adopted" ? now : null);
  audit(actor, "create", kind, id, { code, kind, lifecycle, title: content.title });
  return { id, code, kind, lifecycle };
}

/** Edit. An adopted artefact becomes a new draft version (the adopted text stays what reviews approved until the revision is adopted); drafts are edited in place. Verification drops when the content changes. */
export function updateArtefact(id: string, patch: Partial<ArtefactInput>, actor: string) {
  const cur = db.prepare("SELECT * FROM standards WHERE id=?").get(id) as any;
  if (!cur) throw Object.assign(new Error("not found"), { status: 404 });
  if (cur.lifecycle === "retired") throw Object.assign(new Error("a retired artefact cannot be edited; create a new one"), { status: 409 });
  const kind: ArtefactKind = cur.kind;
  const next: ArtefactContent = { kind, title: patch.title ?? cur.title, category: patch.category ?? cur.category, statement: patch.statement ?? cur.statement, rationale: patch.rationale === undefined ? cur.rationale : patch.rationale,
    status: patch.status ?? cur.status, severity: patch.severity ?? cur.severity, rule_json: patch.rule === undefined ? cur.rule_json : patch.rule ? JSON.stringify(patch.rule) : null,
    control_refs_json: patch.control_refs ? JSON.stringify(patch.control_refs) : cur.control_refs_json, enforcement: patch.enforcement === undefined ? cur.enforcement : patch.enforcement,
    context: patch.context === undefined ? cur.context : patch.context, solution: patch.solution === undefined ? cur.solution : patch.solution, applicability: patch.applicability === undefined ? cur.applicability : patch.applicability };
  validateKindRequirements({ kind, context: next.context, solution: next.solution, enforcement: next.enforcement, rule: next.rule_json ? j(next.rule_json) : null });
  const content_hash = artefactHash(next);
  const changed = content_hash !== cur.content_hash;
  const drop = cur.verification === "verified" && cur.verified_hash !== content_hash;
  const revise = cur.lifecycle === "adopted" && changed;
  db.prepare(`UPDATE standards SET title=?, category=?, statement=?, rationale=?, status=?, severity=?, rule_json=?, owner=?, control_refs_json=?, enforcement=?, context=?, solution=?, applicability=?, content_hash=?, updated_at=?
    ${drop ? ", verification='unverified', verified_by=NULL, verified_at=NULL" : ""}${revise ? ", lifecycle='draft', version=version+1, review_id=NULL" : ""} WHERE id=?`)
    .run(next.title, next.category, next.statement, next.rationale, next.status, next.severity, next.rule_json, patch.owner ?? cur.owner, next.control_refs_json, next.enforcement, next.context, next.solution, next.applicability, content_hash, nowIso(), id);
  audit(actor, revise ? "revised" : "update", kind, id, { code: cur.code, changed, verification_dropped: drop, ...(revise ? { version: cur.version + 1, previous_lifecycle: "adopted" } : {}) });
  return { ok: true, changed, verification_dropped: drop, revised: revise, version: revise ? cur.version + 1 : cur.version, lifecycle: revise ? "draft" : cur.lifecycle };
}

/** Lifecycle transitions are the review workflow's to make; this records them with the review that caused them. */
export function setArtefactLifecycle(id: string, lifecycle: Lifecycle, actor: string, ctx: { reviewId?: string | null } = {}): any {
  const cur = db.prepare("SELECT * FROM standards WHERE id=?").get(id) as any;
  if (!cur) throw Object.assign(new Error("not found"), { status: 404 });
  if (!LIFECYCLES.includes(lifecycle)) throw Object.assign(new Error(`unknown lifecycle "${lifecycle}"`), { status: 400 });
  const now = nowIso();
  const sets: string[] = ["lifecycle=?", "updated_at=?"]; const args: any[] = [lifecycle, now];
  if (lifecycle === "in_review") { sets.push("review_id=?"); args.push(ctx.reviewId ?? null); }
  if (lifecycle === "adopted") { sets.push("review_id=NULL", "adopted_at=?", "retired_at=NULL"); args.push(now); }
  if (lifecycle === "retired") { sets.push("review_id=NULL", "retired_at=?"); args.push(now); }
  if (lifecycle === "draft") sets.push("review_id=NULL");
  db.prepare(`UPDATE standards SET ${sets.join(", ")} WHERE id=?`).run(...args, id);
  audit(actor, `lifecycle_${lifecycle}`, cur.kind, id, { code: cur.code, from: cur.lifecycle, to: lifecycle, review_id: ctx.reviewId ?? null, version: cur.version });
  return artefactById(id);
}

export function retireArtefact(id: string, actor: string) {
  const cur = artefactById(id);
  if (!cur) throw Object.assign(new Error("not found"), { status: 404 });
  if (cur.lifecycle !== "adopted") throw Object.assign(new Error(`only an adopted artefact can be retired (this one is ${cur.lifecycle})`), { status: 409 });
  return setArtefactLifecycle(id, "retired", actor);
}

export const verifyArtefact = (id: string, verified: boolean, actor: string) => setVerification("standards", id, verified, actor);

/** Evaluate one artefact's rule against the live model without writing findings: what it would flag today. */
export function dryRunArtefact(id: string): { findings: { element_name: string; application_name: string | null; message: string }[]; applications: number } {
  const s = db.prepare("SELECT * FROM standards WHERE id=?").get(id) as any;
  if (!s) throw Object.assign(new Error("not found"), { status: 404 });
  const rule: Rule | null = j(s.rule_json, null);
  if (!rule) return { findings: [], applications: 0 };
  const ctx = modelContext();
  const names = new Map<string, string>();
  for (const a of ctx.apps) names.set(a.id, a.name);
  for (const r of ctx.allResources) names.set(r.id, r.name);
  const found = evaluateArtefact(s, rule, ctx);
  const apps = new Set(found.map((f) => f.application_id).filter(Boolean));
  return { findings: found.map((f) => ({ element_name: names.get(f.element_id || "") || "", application_name: f.application_id ? names.get(f.application_id) || null : null, message: f.message })), applications: apps.size };
}

/** The automatic pre-review of a governance artefact: is it well-formed, does it duplicate or overlap adopted artefacts, and what would it flag? */
export function preReviewArtefact(id: string): { ok: boolean; checks: { name: string; state: "pass" | "warn" | "fail"; detail: string }[]; impact: { findings: number; applications: number; sample: { element_name: string; application_name: string | null; message: string }[] } } {
  const a = artefactById(id);
  if (!a) throw Object.assign(new Error("not found"), { status: 404 });
  const checks: { name: string; state: "pass" | "warn" | "fail"; detail: string }[] = [];
  const kind: ArtefactKind = a.kind;
  // rule
  if (a.rule) { try { validateRule(a.rule); checks.push({ name: "Rule is valid", state: "pass", detail: `${a.rule.scope}-scoped ${a.rule.assert?.op} rule` }); } catch (e: any) { checks.push({ name: "Rule is valid", state: "fail", detail: String(e.message) }); } }
  else checks.push({ name: "Rule", state: kind === "principle" ? "pass" : "warn", detail: kind === "principle" ? "Principles are evidenced through reviews, not rules." : "No checkable rule: this artefact will be evidenced through reviews only." });
  // control references
  const refs: string[] = a.control_refs || [];
  if (refs.length) checks.push({ name: "Control references", state: "pass", detail: refs.join(" · ") });
  else checks.push({ name: "Control references", state: kind === "standard" || kind === "policy" ? "fail" : kind === "pattern" ? "warn" : "pass", detail: kind === "principle" ? "Principles need no control references." : "No control references: auditors cannot map this to a framework." });
  // duplicates and overlap among adopted artefacts
  const adopted = (db.prepare("SELECT id, code, title, control_refs_json FROM standards WHERE lifecycle='adopted' AND id<>?").all(id) as any[]);
  const dup = adopted.find((x) => x.title.trim().toLowerCase() === String(a.title).trim().toLowerCase());
  checks.push(dup ? { name: "Unique title", state: "fail", detail: `${dup.code} already has this title` } : { name: "Unique title", state: "pass", detail: "No adopted artefact has this title." });
  const overlap = adopted.filter((x) => (j(x.control_refs_json, []) as string[]).some((r) => refs.includes(r))).map((x) => x.code);
  checks.push(overlap.length ? { name: "Control references overlap", state: "warn", detail: `Shares control references with ${overlap.join(", ")} — check this is not a duplicate.` } : { name: "Control references overlap", state: "pass", detail: "No adopted artefact shares these references." });
  // kind-specific
  if (kind === "pattern") checks.push(a.context && a.solution ? { name: "Pattern narrative", state: "pass", detail: "Context and solution are described." } : { name: "Pattern narrative", state: "fail", detail: "A pattern needs a context and a solution." });
  if (kind === "policy") checks.push(["mandatory", "recommended"].includes(String(a.enforcement)) ? { name: "Enforcement", state: "pass", detail: a.enforcement } : { name: "Enforcement", state: "fail", detail: "A policy must say whether it is mandatory or recommended." });
  // impact
  let impact = { findings: 0, applications: 0, sample: [] as { element_name: string; application_name: string | null; message: string }[] };
  try { const d = dryRunArtefact(id); impact = { findings: d.findings.length, applications: d.applications, sample: d.findings.slice(0, 5) }; }
  catch (e: any) { checks.push({ name: "Impact preview", state: "warn", detail: `Could not evaluate: ${e.message}` }); }
  return { ok: !checks.some((c) => c.state === "fail"), checks, impact };
}

/** Bulk import of artefact objects (JSON or a parsed CSV) as drafts; errors reported per item, nothing partial inside one item. */
export function importArtefacts(items: ArtefactInput[], actor: string, source = "json") {
  const out = { created: 0, errors: [] as { index: number; message: string }[], codes: [] as string[] };
  items.forEach((it, index) => {
    try { const r = createArtefact({ ...it, kind: it.kind || "standard" }, actor); out.created++; out.codes.push(r.code); }
    catch (e: any) { out.errors.push({ index, message: String(e.message) }); }
  });
  audit(actor, "import_artefacts", "standards", null, { source, received: items.length, created: out.created, errors: out.errors.length });
  return out;
}
