import fs from "node:fs";
import { db, j, uid, nowIso, audit, getSetting, setSetting } from "./db.js";
import { getElement, resourcesOf } from "./model.js";
import { dryRunForApplication, validateRule, evaluateArtefact, modelContext } from "./rules.js";
import { encryptSecret, decryptSecret, isEncrypted } from "./secrets.js";
import { ASSESSMENT_TYPES } from "./boards/assessments.js";
import { classificationOf, allClassifications, CRITICALITIES, SERVICE_KINDS, REGULATED_KINDS } from "./classification.js";
import { legacyOf, LEGACY_TEMPLATE } from "./lifecycle.js";

/**
 * AI gateway. Providers are configured by the platform admin (Settings · AI); keys live in the settings table
 * inside DATA_DIR — never in the repository, never returned by the API, never written to the audit log.
 * Each AI FEATURE is enabled separately with its own provider and model, so a tenant can run pre-review on a
 * local Ollama and decision drafting on a hosted model — or nothing at all: every feature has a deterministic
 * fallback and the product is whole with no model configured. AI output is always origin='ai', unverified,
 * cited, and never approves anything.
 *
 * The legacy env gateway (LLM_BASE_URL / LLM_API_KEY / LLM_MODEL — any OpenAI-compatible endpoint, e.g.
 * Cloudflare Workers AI, Azure OpenAI, Ollama) still drives every feature that has no explicit configuration,
 * so existing deployments keep working.
 */
export interface AiProviderDef { label: string; kind: "openai" | "anthropic"; base_url: string; needs_key: boolean; placeholder_model: string; json_mode: boolean }
export const AI_PROVIDERS: Record<string, AiProviderDef> = {
  openai: { label: "OpenAI", kind: "openai", base_url: "https://api.openai.com/v1", needs_key: true, placeholder_model: "gpt-4o-mini", json_mode: true },
  anthropic: { label: "Claude (Anthropic)", kind: "anthropic", base_url: "https://api.anthropic.com", needs_key: true, placeholder_model: "claude-sonnet-5-5", json_mode: false },
  mistral: { label: "Mistral", kind: "openai", base_url: "https://api.mistral.ai/v1", needs_key: true, placeholder_model: "mistral-small-latest", json_mode: true },
  ollama: { label: "Ollama (local)", kind: "openai", base_url: "http://localhost:11434/v1", needs_key: false, placeholder_model: "llama3.1", json_mode: false },
};
export const AI_FEATURES = [
  { id: "pre_review", label: "Pre-review", description: "Reads a submitted design against the adopted catalogue on top of the deterministic checks; advisory findings with citations that must resolve. Never approves." },
  { id: "draft_decision", label: "Decision Drafting", description: "Drafts a decision record from a backlog work item for an author to edit and submit. Falls back to an empty template." },
  { id: "draft_rule", label: "Rule Drafting", description: "Drafts a machine-checkable rule (the JSON DSL) from an artefact's statement. Validated and dry-run against the model before anyone saves it; adoption still goes through a board." },
  { id: "suggest_references", label: "Control References", description: "Suggests framework control references (ISO 27001, DORA, DSPT, NIST…) for a draft artefact — references only, never control-body text, for the author to verify." },
  { id: "draft_assessment", label: "Assessment Drafting", description: "Prefills an assessment summary from the review content under the type's template headings. The assessor or submitter edits and records it as their own." },
  { id: "draft_minutes", label: "Session Notes Drafting", description: "Drafts the secretary's narrative notes from the session's own records. The minutes stay derived; only the notes are authored." },
  { id: "suggest_evidence_mapping", label: "Evidence Mapping", description: "Suggests control ids for unmapped Defender and Azure Policy keys. The admin pins accepted mappings into the control map; evaluation never calls a model." },
  { id: "suggest_classification", label: "Classification Suggestion", description: "Suggests how critical an unclassified application is and which business services or regulated functions depend on it, from its name, resources, tags and decisions. Prefills the Classify form only; a person saves it with their own reason, and rules never read a suggestion." },
  { id: "review_decision", label: "Decision Review", description: "A critical assessment of a proposed decision's argument before submission — unsupported claims, options not genuinely compared, risks left unstated — with a tightened version the author may apply. Advisory; the author decides what to submit." },
] as const;
export type AiFeatureId = (typeof AI_FEATURES)[number]["id"];

type ProviderSettings = Record<string, { api_key?: string; base_url?: string }>;
type FeatureSettings = Record<string, { enabled?: boolean; provider?: string; model?: string }>;
const providerSettings = (): ProviderSettings => j(getSetting("ai.providers"), {}) || {};
export const featureSettings = (): FeatureSettings => j(getSetting("ai.features"), {}) || {};

interface Resolved { provider: string; kind: "openai" | "anthropic"; base_url: string; api_key?: string; model: string; json_mode: boolean }
const legacyEnv = () => {
  const baseUrl = process.env.LLM_BASE_URL?.replace(/\/$/, "");
  return baseUrl && process.env.LLM_MODEL ? { base_url: baseUrl, api_key: process.env.LLM_API_KEY, model: process.env.LLM_MODEL } : null;
};
/** `AI_<PROVIDER>_API_KEY` (or `_FILE`, the Docker/K8s secrets convention) — the operator's secret store beats the database. */
const envProviderKey = (id: string): string | undefined => {
  const name = `AI_${id.toUpperCase()}_API_KEY`;
  const direct = process.env[name];
  if (direct && direct.trim()) return direct.trim();
  const file = process.env[`${name}_FILE`];
  if (file && file.trim()) { try { const v = fs.readFileSync(file.trim(), "utf8").trim(); if (v) return v; } catch { /* an unreadable secret file counts as unset */ } }
  return undefined;
};
/** Stored keys are ciphertext; a plaintext key from before encryption-at-rest is re-encrypted the first time it is read. */
function providerSettingsSecured(): ProviderSettings {
  const cur = providerSettings();
  let dirty = false;
  for (const v of Object.values(cur)) if (v?.api_key && !isEncrypted(v.api_key)) { v.api_key = encryptSecret(v.api_key); dirty = true; }
  if (dirty) setSetting("ai.providers", JSON.stringify(cur));
  return cur;
}
function resolveProvider(id: string): { base_url: string; api_key?: string; key_source: "env" | "settings" | null; configured: boolean; def: AiProviderDef } | null {
  const def = AI_PROVIDERS[id];
  if (!def) return null;
  const s = providerSettingsSecured()[id] || {};
  const envKey = envProviderKey(id);
  // an undecryptable stored key (rotated master key) resolves to null: the provider reads as unconfigured and the admin re-enters it
  const stored = s.api_key ? decryptSecret(s.api_key) : null;
  const api_key = envKey || stored || undefined;
  return { base_url: (s.base_url || def.base_url).replace(/\/$/, ""), api_key, key_source: envKey ? "env" : stored ? "settings" : null, configured: !def.needs_key || !!api_key, def };
}

/** The provider+model a feature runs on, or null when it must stay deterministic. Explicit settings win; the legacy env stands in unless the admin switched the feature off. */
export function featureResolved(featureId: AiFeatureId): Resolved | null {
  const f = featureSettings()[featureId];
  if (f?.enabled && f.provider && f.model) {
    const p = resolveProvider(f.provider);
    if (p?.configured) return { provider: f.provider, kind: p.def.kind, base_url: p.base_url, api_key: p.api_key, model: f.model, json_mode: p.def.json_mode };
  }
  if (f?.enabled === false || (f?.enabled && f.provider)) return null; // explicitly off, or on but pointing at an unconfigured provider
  const env = legacyEnv();
  return env ? { provider: "env", kind: "openai", base_url: env.base_url, api_key: env.api_key, model: env.model, json_mode: true } : null;
}

/** What the Settings page and the overview show: per-provider configured state (never the keys) and per-feature resolution. */
export function aiStatus() {
  const providers = Object.fromEntries(Object.entries(AI_PROVIDERS).map(([id, def]) => {
    const p = resolveProvider(id)!;
    return [id, { label: def.label, needs_key: def.needs_key, base_url: p.base_url, default_base_url: def.base_url, key_set: !!p.api_key, key_source: p.key_source, configured: p.configured, placeholder_model: def.placeholder_model }];
  }));
  const saved = featureSettings();
  const features = Object.fromEntries(AI_FEATURES.map((f) => {
    const r = featureResolved(f.id);
    const s = saved[f.id] || {};
    return [f.id, { label: f.label, description: f.description, enabled: !!r, provider: s.provider || (r?.provider ?? null), model: s.model || (r && r.provider === "env" ? r.model : null), saved_enabled: s.enabled ?? null, source: r ? (r.provider === "env" ? "env" : "settings") : null }];
  }));
  return { providers, features, env_gateway: !!legacyEnv() };
}
/** Back-compat summary (the old `llm` settings/overview field). */
export function llmSummary() {
  const r = featureResolved("pre_review");
  return { configured: !!r, model: r?.model ?? null, provider: r?.provider ?? "none" };
}

/** Models wrap JSON in prose or fences often enough that parsing must shave to the outermost object. */
export function parseJsonLoose(text: string): any {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(t); } catch { /* fall through to the outermost braces */ }
  const start = t.indexOf("{"), end = t.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("model returned no JSON object");
  return JSON.parse(t.slice(start, end + 1));
}

async function chatOpenAI(r: Resolved, messages: { role: string; content: string }[], jsonMode: boolean): Promise<string> {
  const res = await fetch(`${r.base_url}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(r.api_key ? { Authorization: `Bearer ${r.api_key}` } : {}) },
    body: JSON.stringify({ model: r.model, messages, temperature: 0.1, ...(jsonMode && r.json_mode ? { response_format: { type: "json_object" } } : {}) }),
  });
  if (!res.ok) throw new Error(`${r.provider} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data: any = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}
/** Anthropic's Messages API: system is a top-level field, the key travels in x-api-key, and JSON mode is an instruction. */
async function chatAnthropic(r: Resolved, messages: { role: string; content: string }[], jsonMode: boolean): Promise<string> {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  const rest = messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }));
  const res = await fetch(`${r.base_url}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": r.api_key || "", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: r.model, max_tokens: 4096, temperature: 0.1, ...(system || jsonMode ? { system: `${system}${jsonMode ? "\nRespond with only a valid JSON object — no prose, no code fences." : ""}`.trim() } : {}), messages: rest }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data: any = await res.json();
  return (data.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
}
async function chatVia(r: Resolved, messages: { role: string; content: string }[], jsonMode: boolean): Promise<string> {
  // Providers without native JSON mode get the instruction in the system prompt instead.
  const msgs = jsonMode && !r.json_mode && r.kind === "openai"
    ? [{ role: "system", content: "Respond with only a valid JSON object — no prose, no code fences." }, ...messages] : messages;
  return r.kind === "anthropic" ? chatAnthropic(r, msgs, jsonMode) : chatOpenAI(r, msgs, jsonMode);
}
async function chatFor(featureId: AiFeatureId, messages: { role: string; content: string }[], jsonMode = true): Promise<{ text: string; model: string; provider: string }> {
  const r = featureResolved(featureId);
  if (!r) throw new Error(`AI is not enabled for ${featureId}`);
  return { text: await chatVia(r, messages, jsonMode), model: r.model, provider: r.provider };
}

/** A one-line round-trip for the Settings Test button. The error text never carries the key. */
export async function aiTest(providerId: string, model?: string): Promise<{ ok: true; provider: string; model: string; reply: string }> {
  const p = resolveProvider(providerId);
  if (!p) throw new Error(`unknown provider: ${providerId}`);
  if (!p.configured) throw new Error(`${p.def.label} has no API key configured`);
  const m = model?.trim() || p.def.placeholder_model;
  const r: Resolved = { provider: providerId, kind: p.def.kind, base_url: p.base_url, api_key: p.api_key, model: m, json_mode: p.def.json_mode };
  const text = await chatVia(r, [{ role: "user", content: "Reply with exactly: ok" }], false);
  return { ok: true, provider: providerId, model: m, reply: text.trim().slice(0, 80) };
}

export interface PreReviewFinding { severity: "critical" | "high" | "medium" | "low" | "info"; title: string; detail: string; citations: { kind: "standard" | "decision" | "resource" | "section"; ref: string }[]; }
export interface PreReview { engine: "rules" | "llm"; model?: string; provider?: string; summary: string; recommendation: "approve" | "approve_with_conditions" | "request_changes" | "reject"; findings: PreReviewFinding[]; suggested_conditions: string[]; }

/** The sections the design template expects; "section" citations may point at these or at a heading in the design. */
const TEMPLATE_SECTIONS = ["data", "security", "resilience", "oversight", "logging"];
/** Markdown headings (any level), lower-cased and trimmed. */
export const headingsOf = (md: string | null | undefined) => Array.from(String(md || "").matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)).map((m) => m[1].toLowerCase().trim());
const hasSection = (headings: string[], section: string) => headings.some((h) => h === section || h.split(/\W+/).includes(section));

/** The placeholder prose the submission form pre-fills under each heading. A section whose body is still the placeholder was not provided. */
const TEMPLATE_HINTS = new Set([
  "what is being built or changed, and how it fits the current estate.",
  "what data is involved, where it lives, who can see it.",
  "identity, network exposure, secrets.",
  "availability, backup, failure modes.",
]);
/** Store a section the submitter left as the template hint as empty — never as if the hint were their content. */
export function stripTemplateHints(md: string): string {
  return md.split(/(?=^#{1,6}\s)/m).map((chunk) => {
    const m = chunk.match(/^(#{1,6}\s+[^\n]*\n)([\s\S]*)$/);
    if (!m) return chunk;
    return TEMPLATE_HINTS.has(m[2].trim().toLowerCase()) ? `${m[1]}\n` : chunk;
  }).join("");
}

/** Deterministic pre-review: rule findings against the application, missing sections, decision conflicts. Always available. */
export function rulesPreReview(reviewId: string): PreReview {
  const review = db.prepare("SELECT * FROM reviews WHERE id=?").get(reviewId) as any;
  const findings: PreReviewFinding[] = [];
  const design = (review.design_md || "").toLowerCase();
  const headings = headingsOf(review.design_md);
  for (const section of TEMPLATE_SECTIONS) {
    const needed = section === "oversight" || section === "logging" ? /\bai\b|openai|model|summaris/.test(design + (review.summary || "").toLowerCase()) : true;
    if (needed && !hasSection(headings, section)) {
      findings.push({ severity: section === "oversight" ? "high" : "medium", title: `No "${section}" section in the design`, detail: `The template expects a ${section} section. Reviewers cannot assess ${section} without it.`, citations: [{ kind: "section", ref: section }] });
    }
  }
  if (review.application_id) {
    for (const f of dryRunForApplication(review.application_id)) {
      findings.push({ severity: f.error ? "low" : f.standard.severity, title: f.error ? `${f.standard.code}: rule could not be evaluated` : `${f.standard.code}: ${f.standard.title}`, detail: f.message,
        citations: [{ kind: "standard", ref: f.standard.code }, ...(f.evidence?.resource ? [{ kind: "resource" as const, ref: f.evidence.resource }] : []), ...(f.evidence?.decision ? [{ kind: "decision" as const, ref: f.evidence.decision }] : [])] });
    }
    // decision conflicts mentioned in the design text (an ADR with no application list applies to all)
    const decisions = db.prepare("SELECT * FROM decisions WHERE status='accepted'").all() as any[];
    for (const d of decisions) {
      const apps: string[] = j(d.application_ids_json, []);
      if (apps.length > 0 && !apps.includes(review.application_id)) continue;
      const c = j(d.constraint_json, null);
      if (c?.allowedTypes && /cosmos|documentdb/.test(design) && !c.allowedTypes.some((t: string) => /documentdb/i.test(t)))
        findings.push({ severity: "high", title: `Conflicts with ${d.code}`, detail: `${d.title}. The design introduces a database type outside the accepted set.`, citations: [{ kind: "decision", ref: d.code }] });
    }
  }
  const worst = findings.reduce((m, f) => Math.max(m, ["info", "low", "medium", "high", "critical"].indexOf(f.severity)), 0);
  const recommendation = worst >= 4 ? "reject" : worst >= 3 ? "request_changes" : worst >= 2 ? "approve_with_conditions" : "approve";
  return { engine: "rules", summary: `${findings.length} finding${findings.length === 1 ? "" : "s"} from the standards catalogue and template checks.`, recommendation, findings,
    suggested_conditions: findings.filter((f) => f.severity === "high" || f.severity === "critical").map((f) => `Resolve: ${f.title}`) };
}

export async function llmPreReview(reviewId: string): Promise<PreReview> {
  const review = db.prepare("SELECT * FROM reviews WHERE id=?").get(reviewId) as any;
  const app = review.application_id ? getElement(review.application_id) : null;
  const resources = app ? resourcesOf(app.id) : [];
  const standards = db.prepare("SELECT code,title,statement,severity,status FROM standards").all();
  const decisions = db.prepare("SELECT code,title,status,decision_md,constraint_json FROM decisions WHERE status IN ('accepted','proposed')").all();
  const base = rulesPreReview(reviewId);
  const system = `You are an architecture review pre-reviewer. You never approve. You produce findings a human Design Authority will verify.
Every finding must cite its evidence: a standard code (STD-xxx), a decision code (ADR-xxxx), a resource id, or a design section. Do not invent resources or standards.
Respond with JSON: {"summary": string, "recommendation": "approve"|"approve_with_conditions"|"request_changes"|"reject", "findings": [{"severity":"critical"|"high"|"medium"|"low"|"info","title":string,"detail":string,"citations":[{"kind":"standard"|"decision"|"resource"|"section","ref":string}]}], "suggested_conditions": string[]}. Keep it short.`;
  const user = JSON.stringify({
    review: { code: review.code, title: review.title, risk_tier: review.risk_tier, summary: review.summary, design_md: review.design_md },
    application: app ? { name: app.name, resources: resources.map((r) => ({ id: r.source_ref, name: r.name, type: r.subtype, props: r.props, tags: r.tags })) } : null,
    standards, decisions, deterministic_findings: base.findings,
  });
  const { text, model, provider } = await chatFor("pre_review", [{ role: "system", content: system }, { role: "user", content: user }]);
  const parsed = parseJsonLoose(text);
  // keep only citations that resolve, so the AI cannot invent evidence: a standard code, a decision code, a resource
  // of this application, or a section that exists in the design (or that the template expects)
  const stdCodes = new Set((standards as any[]).map((s) => s.code)), decCodes = new Set((decisions as any[]).map((d) => d.code)), resRefs = new Set(resources.map((r) => r.source_ref));
  const sections = new Set([...TEMPLATE_SECTIONS, ...headingsOf(review.design_md)]);
  const findings: PreReviewFinding[] = (parsed.findings || []).map((f: any) => ({ ...f, citations: (f.citations || []).filter((c: any) =>
    (c.kind === "standard" && stdCodes.has(c.ref)) || (c.kind === "decision" && decCodes.has(c.ref)) || (c.kind === "resource" && resRefs.has(String(c.ref).toLowerCase()))
    || (c.kind === "section" && sections.has(String(c.ref).toLowerCase().trim()))) }))
    .filter((f: PreReviewFinding) => f.citations.length > 0);
  return { engine: "llm", model, provider, summary: parsed.summary, recommendation: parsed.recommendation, findings, suggested_conditions: parsed.suggested_conditions || [] };
}

export async function runPreReview(reviewId: string, actor: string): Promise<{ eventId: string; result: PreReview }> {
  let result: PreReview;
  let origin = "rules";
  try {
    if (featureResolved("pre_review")) { result = await llmPreReview(reviewId); origin = "ai"; }
    else result = rulesPreReview(reviewId);
  } catch (e: any) {
    result = rulesPreReview(reviewId);
    result.summary = `LLM unavailable (${String(e.message).slice(0, 80)}); deterministic pre-review used. ` + result.summary;
  }
  const eventId = uid();
  const now = nowIso();
  // a pre-review is machine output whatever produced it: nobody has stood behind it yet, so it is never stored as verified
  db.prepare(`INSERT INTO review_events(id,review_id,kind,actor,body_md,data_json,origin,verification,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(eventId, reviewId, "pre_review", actor, result.summary, JSON.stringify(result), origin, "unverified", now);
  db.prepare("UPDATE reviews SET stage = CASE WHEN stage='submitted' THEN 'pre_review' ELSE stage END, updated_at=? WHERE id=?").run(now, reviewId);
  audit(actor, "pre_review", "review", reviewId, { engine: result.engine, findings: result.findings.length });
  return { eventId, result };
}

/** Draft an ADR from a work item (epic). Falls back to a template when no LLM is configured. */
export async function draftDecisionFromWorkItem(workItemId: string): Promise<{ origin: "ai" | "template"; title: string; topic: string; context_md: string; options: any[]; decision_md: string; justification_md: string; consequences_md: string }> {
  const w = db.prepare("SELECT * FROM work_items WHERE id=?").get(workItemId) as any;
  const standards = db.prepare("SELECT code,title,statement FROM standards WHERE status='adopt'").all();
  const template = { origin: "template" as const, title: `Decision for: ${w.title}`, topic: "general",
    context_md: `${w.description}\n\n_Drafted from ${w.type} ${w.external_id}. Fill in the forces and constraints._`,
    options: [{ name: "Option A", pros: "", cons: "" }, { name: "Option B", pros: "", cons: "" }], decision_md: "", justification_md: "", consequences_md: "" };
  if (!featureResolved("draft_decision")) return template;
  try {
    const { text } = await chatFor("draft_decision", [
      { role: "system", content: `Draft a MADR architecture decision record from a backlog item. Respond JSON: {"title","topic" (one of hosting,data-store,integration,ai-system,security,general),"context_md","options":[{"name","pros","cons"}],"decision_md" (the recommended option),"justification_md" (why it wins against the alternatives),"consequences_md" (what accepting it means and which risks are accepted)}. Reference applicable standards by code. Be concise and do not invent facts about the estate.` },
      { role: "user", content: JSON.stringify({ work_item: { id: w.external_id, type: w.type, title: w.title, description: w.description, tags: j(w.tags_json, []) }, standards }) },
    ]);
    const p = parseJsonLoose(text);
    return { origin: "ai", title: p.title || template.title, topic: p.topic || "general", context_md: p.context_md || "", options: p.options || [], decision_md: p.decision_md || "", justification_md: p.justification_md || "", consequences_md: p.consequences_md || "" };
  } catch { return template; }
}

/** The rule DSL contract the drafting prompt teaches; kept beside the validator so the two cannot drift silently. */
const RULE_DSL_DOC = `A rule is JSON: {"scope":"resource"|"application","match":{"type"|"typeIn"|"typePrefix"|"where":[{"path","op","value"}]},"assert":{"path","op","value"} | {"op":"decisionConstraint","topic"} | {"op":"evidence","control","source"?,"state"?} | {"op":"hasDecision","topic","type"?} | {"op":"hasOwnerTag"} | {"op":"maxResourcesOfType","type","max"}}.
Ops: eq neq in notIn exists missing gte lte matches. Normalised props: props.publicAccess, props.minTlsVersion, props.osSku, props.location, props.httpsOnly, tags.owner. Azure types look like microsoft.storage/storageaccounts.
A fact about resource configuration must assert on imported evidence (op:"evidence" with a control id), never invent one.`;

/**
 * Draft a checkable rule from an artefact's statement — generate→verify: the model proposes, validateRule and a
 * dry run against the derived model prove it, and only a human saves it into a draft a board must still adopt.
 */
export async function draftRule(input: { kind: string; title: string; statement: string; category?: string }) {
  const examples = (db.prepare("SELECT title, rule_json FROM standards WHERE rule_json IS NOT NULL LIMIT 3").all() as any[])
    .map((s) => ({ title: s.title, rule: j(s.rule_json, null) }));
  const controls = knownControls();
  const { text, model, provider } = await chatFor("draft_rule", [
    { role: "system", content: `You draft ONE machine-checkable rule for an architecture governance engine from a human statement.\n${RULE_DSL_DOC}\nKnown evidence control ids: ${controls.join(", ") || "none"}.\nRespond JSON: {"rule": <the rule or null when the statement is not checkable>, "rationale": string (one sentence: what the rule checks and any simplification made)}.` },
    { role: "user", content: JSON.stringify({ artefact: input, examples }) },
  ]);
  const p = parseJsonLoose(text);
  const result: any = { origin: "ai", provider, model, rule: p.rule ?? null, rationale: p.rationale || "", validation: { ok: false as boolean, error: null as string | null }, impact: null as any };
  if (!result.rule) { result.validation = { ok: false, error: "The model judged the statement not checkable as a rule." }; return result; }
  try {
    validateRule(result.rule);
    result.validation = { ok: true, error: null };
    // dry-run the raw rule against the live model so the author sees the blast radius before saving
    const ctx = modelContext();
    const stub = { id: "draft", code: "DRAFT", title: input.title, severity: "medium" };
    const found = evaluateArtefact(stub, result.rule, ctx);
    const names = new Map<string, string>();
    for (const a of ctx.apps) names.set(a.id, a.name);
    for (const r of ctx.allResources) names.set(r.id, r.name);
    result.impact = { findings: found.length, applications: new Set(found.map((f) => f.application_id).filter(Boolean)).size, sample: found.slice(0, 5).map((f) => ({ element_name: names.get(f.element_id || "") || "", application_name: f.application_id ? names.get(f.application_id) || null : null, message: f.message })) };
  } catch (e: any) { result.validation = { ok: false, error: String(e.message || e) }; }
  return result;
}

/** Suggest control references for a draft artefact — references only, the author verifies every one. */
export async function suggestControlReferences(input: { kind: string; title: string; statement: string; category?: string }) {
  const existing = (db.prepare("SELECT control_refs_json FROM standards WHERE control_refs_json IS NOT NULL LIMIT 50").all() as any[])
    .flatMap((r) => j(r.control_refs_json, []) as string[]);
  const styles = [...new Set(existing)].slice(0, 20);
  const { text, model, provider } = await chatFor("suggest_references", [
    { role: "system", content: `Suggest framework control references for an architecture governance artefact (ISO 27001 Annex A, DORA, NHS DSPT, NIST SP 800-53, CIS...). References ONLY — identifiers like "ISO27001:A.8.24" — never the control body text. Follow the reference style already used in this catalogue where one fits. Respond JSON: {"references":[{"ref": string, "why": string (one short clause)}]} with at most 6.` },
    { role: "user", content: JSON.stringify({ artefact: input, existing_reference_styles: styles }) },
  ]);
  const p = parseJsonLoose(text);
  const references = (Array.isArray(p.references) ? p.references : []).filter((r: any) => r && typeof r.ref === "string" && r.ref.trim()).slice(0, 6)
    .map((r: any) => ({ ref: String(r.ref).trim(), why: String(r.why || "").slice(0, 200) }));
  return { origin: "ai", provider, model, references };
}

/** Prefill an assessment summary from the review content under the template's headings; the human owns the result. */
export async function draftAssessmentSummary(reviewId: string, type: string, template: string) {
  const review = db.prepare("SELECT code, title, risk_tier, summary, design_md FROM reviews WHERE id=?").get(reviewId) as any;
  if (!review) throw Object.assign(new Error("not found"), { status: 404 });
  const { text, model, provider } = await chatFor("draft_assessment", [
    { role: "system", content: `Draft an assessment summary for an architecture review. Fill the given markdown template headings from the review content. Where the review does not answer a heading, write "To be confirmed: ..." naming what is missing — never invent facts. Keep each section to a few sentences. Respond JSON: {"result_md": string}.` },
    { role: "user", content: JSON.stringify({ assessment_type: type, template, review }) },
  ]);
  const p = parseJsonLoose(text);
  if (!p.result_md || typeof p.result_md !== "string") throw new Error("model returned no result_md");
  return { origin: "ai", provider, model, result_md: p.result_md };
}

/** Draft the secretary's narrative notes from the session's own records; derive→narrate — the minutes stay derived. */
export async function draftSessionNotes(sessionData: unknown) {
  const { text, model, provider } = await chatFor("draft_minutes", [
    { role: "system", content: `Draft a board session's secretary notes (markdown, no top-level heading) from its records: a short narrative of how the sitting went — attendance and delegations worth noting, how each item moved and why, conditions and circulations left open. State only what the records say; never invent discussion that is not recorded. Respond JSON: {"notes_md": string}.` },
    { role: "user", content: JSON.stringify(sessionData) },
  ]);
  const p = parseJsonLoose(text);
  if (!p.notes_md || typeof p.notes_md !== "string") throw new Error("model returned no notes_md");
  return { origin: "ai", provider, model, notes_md: p.notes_md };
}

/** Control ids the engine already knows: mapped evidence plus every control cited by a rule. */
function knownControls(): string[] {
  const fromEvidence = (db.prepare("SELECT DISTINCT control FROM evidence WHERE control NOT LIKE 'defender:%' AND control NOT LIKE 'policy:%'").all() as any[]).map((r) => r.control);
  const fromRules = (db.prepare("SELECT rule_json FROM standards WHERE rule_json LIKE '%\"evidence\"%'").all() as any[])
    .map((r) => j(r.rule_json, null)?.assert?.control).filter(Boolean);
  return [...new Set([...fromEvidence, ...fromRules])].sort();
}

/** Suggest→pin: propose control ids for unmapped Defender/Policy keys; the admin pins accepted ones into evidence.control_map. */
export async function suggestEvidenceMapping() {
  if (!featureResolved("suggest_evidence_mapping")) throw new Error("AI is not enabled for suggest_evidence_mapping");
  const unmapped = (db.prepare("SELECT DISTINCT control FROM evidence WHERE control LIKE 'defender:%' OR control LIKE 'policy:%'").all() as any[]).map((r) => r.control);
  const known = knownControls();
  if (unmapped.length === 0) return { origin: "ai" as const, provider: null, model: null, map: {}, unmapped, known };
  const { text, model, provider } = await chatFor("suggest_evidence_mapping", [
    { role: "system", content: `Map raw cloud-assessment keys to this instance's control ids. Keys look like defender:<assessment slug> or policy:<policy definition name/guid>. Prefer an existing control id when one plainly covers the same check; propose a new kebab-case id only when nothing fits; omit keys you cannot map confidently. Respond JSON: {"map": {"<key>": "<control id>"}}.` },
    { role: "user", content: JSON.stringify({ unmapped_keys: unmapped, known_control_ids: known }) },
  ]);
  const p = parseJsonLoose(text);
  const map: Record<string, string> = {};
  for (const [k, v] of Object.entries(p.map || {})) if (unmapped.includes(k) && typeof v === "string" && (v as string).trim()) map[k] = (v as string).trim();
  return { origin: "ai" as const, provider, model, map, unmapped, known };
}

/**
 * A critical review of a decision draft's ARGUMENT, before submission — generate→verify in reverse: the human
 * generated, the model tests the logic (claims without support, alternatives not genuinely weighed, consequences
 * and accepted risks left unstated, contradictions with what is already adopted or accepted) and offers a
 * tightened version. Nothing is stored; the author applies or ignores it, and the board still decides.
 */
export async function reviewDecisionDraft(input: { title: string; topic?: string; context_md?: string; options?: { name: string; pros?: string; cons?: string }[]; decision_md?: string; justification_md?: string; consequences_md?: string }) {
  const adopted = db.prepare("SELECT code, title FROM standards WHERE lifecycle='adopted'").all();
  const accepted = db.prepare("SELECT code, title FROM decisions WHERE status='accepted'").all();
  const { text, model, provider } = await chatFor("review_decision", [
    { role: "system", content: `You are a critical reviewer of an architecture decision record's ARGUMENT. Assess, harshly but fairly:
1. Does the recommended option actually follow from the context and the options considered?
2. Is every alternative genuinely weighed (real pros AND cons), or are there strawmen and missing options?
3. Is the justification a logical argument — name every unsupported claim, circular step or appeal to preference.
4. Do the consequences state what accepting the decision MEANS (what becomes mandatory or excluded) and WHICH RISKS ARE ACCEPTED? Unstated risks are the most important gap.
5. Does anything contradict the adopted standards or accepted decisions listed (cite their codes)?
6. Where a CRITICAL claim has no evidence behind it (a cost claim with no analysis, a security claim with no assessment, personal data with no DPIA), suggest which assessment would evidence it — types: dpia, security, supplier, clinical-safety, ai-impact, accessibility, impact, scope, other.
Then tighten the argument: a minimal rewrite that keeps the author's position but makes it a logical argument — do not change the recommendation itself.
Respond JSON: {"verdict":"sound"|"needs_work","assessment_md":string (the critical assessment, markdown, concrete and specific),"issues":[{"kind":"unsupported_claim"|"options_not_compared"|"risk_not_stated"|"contradiction"|"logic_gap","point":string}],"tightened":{"decision_md":string,"justification_md":string,"consequences_md":string},"suggested_assessments":[{"type":string (one of the types above),"title":string (short, names the claim to evidence),"reason":string}]}. Suggest at most 3 assessments and only where evidence is genuinely missing.` },
    { role: "user", content: JSON.stringify({ draft: input, adopted_standards: adopted, accepted_decisions: accepted }) },
  ]);
  const p = parseJsonLoose(text);
  return {
    origin: "ai" as const, provider, model,
    verdict: p.verdict === "sound" ? "sound" : "needs_work",
    assessment_md: String(p.assessment_md || ""),
    issues: (Array.isArray(p.issues) ? p.issues : []).filter((i: any) => i && i.point).map((i: any) => ({ kind: String(i.kind || "logic_gap"), point: String(i.point).slice(0, 400) })),
    tightened: p.tightened && typeof p.tightened === "object" ? { decision_md: String(p.tightened.decision_md || ""), justification_md: String(p.tightened.justification_md || ""), consequences_md: String(p.tightened.consequences_md || "") } : null,
    // evidence the argument is missing: each suggestion can be triggered as an assessment on the draft decision
    suggested_assessments: (Array.isArray(p.suggested_assessments) ? p.suggested_assessments : [])
      .filter((s: any) => s && (ASSESSMENT_TYPES as readonly string[]).includes(s.type) && s.reason)
      .slice(0, 3).map((s: any) => ({ type: String(s.type), title: String(s.title || "").slice(0, 120) || null, reason: String(s.reason).slice(0, 300) })),
  };
}

/**
 * Suggest a criticality classification for an application the tags leave open — suggest→confirm: nothing is stored,
 * the Classify form is prefilled and a person saves it with their own reason. The output is normalised to the same
 * invariants a person's classification must meet (known tiers and kinds; a regulated service means critical).
 */
export async function suggestClassification(appId: string) {
  const app = getElement(appId);
  if (!app || app.type !== "application") throw Object.assign(new Error("not found"), { status: 404 });
  if (!featureResolved("suggest_classification")) throw new Error("AI is not enabled for suggest_classification");
  const resources = resourcesOf(appId).slice(0, 60).map((r) => ({ name: r.name, type: r.subtype, location: r.props.location || null, tags: r.tags || {} }));
  const decisions = (db.prepare("SELECT code, title, status FROM decisions WHERE application_ids_json LIKE ? ORDER BY code").all(`%${appId}%`) as any[]).slice(0, 20);
  const changes = (db.prepare("SELECT title FROM work_items WHERE application_id=? AND COALESCE(state,'') <> 'Removed' LIMIT 20").all(appId) as any[]).map((w) => w.title);
  // service names the estate already uses, so a suggestion joins an existing service instead of coining a near-duplicate
  const known = [...new Map([...allClassifications().values()].flatMap((c) => c.services).map((x) => [`${x.kind}|${x.name}`, x])).values()].slice(0, 40);
  const { text, model, provider } = await chatFor("suggest_classification", [
    { role: "system", content: `Suggest an operational-resilience classification for one application in an IT estate.
criticality: "critical" (its failure would cause intolerable harm to customers, patients, market integrity or the firm's viability), "important" (material disruption, tolerable for a while), "standard" (neither), or null when the facts given do not support a call.
services: the business services or functions that depend on it, each {"name": short verb phrase like "Take card payments", "kind": "ibs" (important business service, PRA SS1/21 / FCA SYSC 15A) | "cif" (critical or important function, DORA) | "essential_function" (NCSC CAF / NIS) | "business_service"}. Reuse a known service name when one fits. Name a regulated kind (ibs, cif, essential_function) only when the facts plainly support it — a regulated service makes the application critical.
Base everything on the facts given; never invent facts. Say in the rationale which facts led to the call and what a person should confirm.
Respond JSON: {"criticality": string|null, "services": [{"name": string, "kind": string}], "rationale": string (2-4 sentences)}.` },
    { role: "user", content: JSON.stringify({ application: { name: app.name, current: classificationOf(appId)?.derived ?? null }, resources, decisions, planned_changes: changes, known_services: known }) },
  ]);
  const p = parseJsonLoose(text);
  const services = (Array.isArray(p.services) ? p.services : [])
    .filter((x: any) => x && typeof x.name === "string" && x.name.trim() && (SERVICE_KINDS as readonly string[]).includes(x.kind))
    .slice(0, 5).map((x: any) => ({ name: String(x.name).trim().slice(0, 120), kind: x.kind as (typeof SERVICE_KINDS)[number] }));
  let criticality: string | null = (CRITICALITIES as readonly string[]).includes(p.criticality) ? p.criticality : null;
  const regulated = services.some((x: any) => REGULATED_KINDS.includes(x.kind));
  if (regulated) criticality = "critical";
  return { origin: "ai" as const, provider, model, criticality, services, rationale: String(p.rationale || "").slice(0, 800) };
}

/** Prefill a legacy assessment (DORA Art. 8(7)) from the register's facts under its template; derive→narrate, the author records it as their own. */
export async function draftLegacyAssessment(appId: string) {
  const app = getElement(appId);
  if (!app || app.type !== "application") throw Object.assign(new Error("not found"), { status: 404 });
  if (!featureResolved("draft_assessment")) throw new Error("AI is not enabled for draft_assessment");
  const l = legacyOf(app);
  const facts = { application: app.name, criticality: classificationOf(app.id)?.criticality ?? null, status: l.status,
    components: l.components.map((c) => ({ resource: c.resource_name, product: c.product_label, version: c.label, state: c.state, end_of_support: c.eol, extended_until: c.extended })),
    previous: l.last ? { result: l.last.result, assessed_at: l.last.assessed_at, summary: String(l.last.summary_md).slice(0, 2000) } : null };
  const { text, model, provider } = await chatFor("draft_assessment", [
    { role: "system", content: `Draft the yearly risk assessment of an application's legacy ICT components (DORA Art. 8(7)). Fill the given markdown template headings from the facts only. Name each legacy component with its resource and support dates. Where the facts do not answer a heading (compensating controls, the plan, owners), write "To be confirmed: ..." naming what the assessor must add — never invent controls, plans or dates. Keep each section to a few sentences. Respond JSON: {"summary_md": string}.` },
    { role: "user", content: JSON.stringify({ template: LEGACY_TEMPLATE, facts }) },
  ]);
  const p = parseJsonLoose(text);
  if (!p.summary_md || typeof p.summary_md !== "string") throw new Error("model returned no summary_md");
  return { origin: "ai" as const, provider, model, summary_md: p.summary_md };
}

