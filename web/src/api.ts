const USER_KEY = "archigov.user";
export const currentUser = () => localStorage.getItem(USER_KEY) || "j.duduka";
export const setCurrentUser = (u: string) => localStorage.setItem(USER_KEY, u);

/**
 * Sign-in mode as reported by /auth/me. The x-user header is a local-mode convenience (scripts and the
 * PoC "switch user"); it is never sent to an Entra-protected API, where the session cookie is the identity.
 */
let authMode: "local" | "entra" | "unknown" = "unknown";
export const setAuthMode = (m: typeof authMode) => { authMode = m; };

export class ApiError extends Error {
  status: number; code?: string; capability?: string; roles?: string[]; login_url?: string;
  /** The parsed error body, for callers that act on it (a 409 "under review" names the review). */
  body?: any;
  constructor(status: number, message: string, extra: Partial<Pick<ApiError, "code" | "capability" | "roles" | "login_url" | "body">> = {}) { super(message); this.status = status; Object.assign(this, extra); }
}

/**
 * Two-level access. Platform admin is a flag (sources, settings, users, boards) and grants nothing in a review —
 * a platform admin is not an author. The system role says what a person does in governance: author (submits
 * designs, authors catalogue drafts and decisions, pre-reviews, verifies), auditor (reads and exports), service
 * account (integrations), or none. Approving and deciding come only from a seat on the review's board: chair
 * (decides), decision maker (approves), reviewer (assesses, no vote), secretary (runs the board, no vote),
 * observer (read-only). Legacy values keep a label so older servers and app-role values still read sensibly,
 * but they are never offered in an editor.
 */
export const USER_TYPE_LABELS: Record<string, string> = { author: "Author", auditor: "Auditor", service: "Service account" };
export const USER_TYPES = Object.keys(USER_TYPE_LABELS);
export const NO_SYSTEM_ROLE = "No system role";
/** Editor items: the three system roles plus none (an empty id). */
export const USER_TYPE_ITEMS = [{ id: "", label: NO_SYSTEM_ROLE }, ...USER_TYPES.map((id) => ({ id, label: USER_TYPE_LABELS[id] }))];
const LEGACY_USER_TYPE_LABELS: Record<string, string> = { architect: "Author (legacy)", engineer: "Author (legacy)", submitter: "Author (legacy)", board_member: "Decision maker (legacy)" };
export const BOARD_ROLE_LABELS: Record<string, string> = { chair: "Chair", decision_maker: "Decision maker", reviewer: "Reviewer", secretary: "Secretary", observer: "Observer" };
export const BOARD_ROLES = Object.keys(BOARD_ROLE_LABELS);
const LEGACY_BOARD_ROLE_LABELS: Record<string, string> = { member: "Decision maker" };
/** The editor value for a stored seat: the legacy "member" meant a decision maker. */
export const normaliseSeat = (r: string) => (r === "member" ? "decision_maker" : r);
/** Seats that count towards an approvals step; a decision step is the chair's. */
export const APPROVAL_SEATS = ["decision_maker", "chair"];
export const DECISION_SEATS = ["chair"];
export const ROLE_LABELS: Record<string, string> = { platform_admin: "Platform admin", ...USER_TYPE_LABELS, admin: "Admin (legacy)", chair: "Chair (legacy)", reviewer: "Reviewer (legacy)", submitter: "Submitter (legacy)", architect: "Architect (legacy)", engineer: "Engineer (legacy)", board_member: "Board member (legacy)" };
export const ROLES = ["platform_admin", ...USER_TYPES];
/** The editor value for a stored system role: legacy names fold into the role they meant; absent, unknown or a seat-like legacy value → none. */
export function normaliseUserType(t: string | null | undefined): string {
  if (!t) return "";
  if (USER_TYPE_LABELS[t]) return t;
  return t === "architect" || t === "engineer" || t === "submitter" ? "author" : "";
}
/** What an older server expects in POST /auth/local { role } for a given system role. */
export const LEGACY_ROLE_FOR_TYPE: Record<string, string> = { author: "reviewer", auditor: "auditor", service: "submitter" };
/** Capabilities an author holds; a platform admin without a system role gets a pointed tooltip for these. */
export const AUTHOR_CAPS = new Set(["submit_review", "submit_design_review", "comment", "resubmit", "manage_artefacts", "manage_standards", "create_decision", "pre_review", "verify"]);
/** Who can do it — what a disabled action's tooltip names. */
export const NEED_FOR: Record<string, string> = {
  manage_platform: "a platform admin", manage_sources: "a platform admin", manage_board: "a platform admin or the board's chair or secretary",
  manage_artefacts: "an author", manage_standards: "an author", import_artefacts: "an author or platform admin",
  approve_review: "a decision maker's seat on the review's board", request_changes: "a reviewer's or decision maker's seat on the review's board",
  decide_review: "the board's chair, once the approval policy is satisfied",
  set_decision_status: "a board chair", grant_exception: "a board chair", resolve_finding: "a board chair", close_condition: "a board chair",
  pre_review: "an author or a board seat", verify: "an author or a board seat", create_decision: "an author",
  submit_design_review: "an author", submit_review: "an author", comment: "an author or a board seat", resubmit: "the review's submitter",
  export_evidence: "any signed-in user", read: "any signed-in user",
};
/** Older servers report older capability names; the UI asks for the new name and falls back to the old one. */
export const CAP_ALIAS: Record<string, string> = { manage_platform: "manage_sources", manage_board: "manage_platform", manage_artefacts: "manage_standards", import_artefacts: "manage_standards", submit_review: "submit_design_review", submit_design_review: "submit_review", resubmit: "submit_review", approve_review: "decide_review", request_changes: "approve_review" };
const VERBS: Record<string, string> = {
  submit_review: "submit reviews", submit_design_review: "submit design reviews", resubmit: "resubmit reviews", comment: "comment", pre_review: "run pre-reviews", approve_review: "approve reviews", request_changes: "request changes", decide_review: "decide reviews", create_decision: "create or edit decisions", set_decision_status: "accept or reject decisions",
  verify: "verify items", grant_exception: "grant exceptions", resolve_finding: "resolve findings", close_condition: "close conditions", manage_standards: "manage the catalogue", manage_artefacts: "manage the catalogue", import_artefacts: "import into the catalogue",
  manage_sources: "manage sources and settings", manage_platform: "administer the platform", manage_board: "manage boards", export_evidence: "export evidence", read: "read",
};
export const capabilityVerb = (c?: string) => (c && VERBS[c]) || (c ? c.replace(/_/g, " ") : "do that");

/** The governance catalogue: four kinds of artefact that share a statement, references and an optional rule. */
export const ARTEFACT_KINDS: { kind: string; prefix: string; label: string; plural: string; description: string }[] = [
  { kind: "standard", prefix: "STD", label: "Standard", plural: "Standards", description: "A technical rule the estate is checked against; usually checkable." },
  { kind: "principle", prefix: "PRN", label: "Principle", plural: "Principles", description: "A durable statement of intent that guides decisions; evidenced through reviews." },
  { kind: "pattern", prefix: "PAT", label: "Pattern", plural: "Patterns", description: "A proven solution for a recurring context; may carry a checkable constraint." },
  { kind: "policy", prefix: "POL", label: "Policy", plural: "Policies", description: "An organisation-wide obligation, mandatory or recommended; checkable where it can be." },
];
export const REVIEW_TYPES = ["design", "decision", "standard", "principle", "pattern", "policy", "exception"];
export const kindOfCode = (code?: string | null) => (ARTEFACT_KINDS.find((k) => String(code || "").startsWith(k.prefix + "-"))?.kind) || "standard";

/**
 * Areas of responsibility: a board's seeded eight. A board may add custom areas; those carry their own label
 * from the API (`board_areas: [{id,label}]`) and an unknown id falls back to sentence case.
 */
export const AREA_LABELS: Record<string, string> = { security: "Security", data: "Data", integration: "Integration", infrastructure: "Infrastructure", resilience: "Resilience & operations", cost: "Cost", compliance: "Privacy & compliance", ai: "AI" };
export const SEEDED_AREAS = Object.keys(AREA_LABELS);
/** The label for an area id: the board's own list first (custom areas), then the seeded labels, then sentence case. */
export const areaLabel = (id?: string | null, boardAreas?: { id: string; label?: string }[] | null) => { if (!id) return "—"; const own = (boardAreas || []).find((a) => a.id === id)?.label; return own || AREA_LABELS[id] || sentence(id); };
/** A decision maker's position on one area; `resolved` and `missing` are derived states of an area, not positions anyone records. */
export const POSITIONS = ["yes", "no", "conditional", "not_my_area"];
export const RESOLUTIONS = ["accepted_condition", "addressed", "dependent_decision"];
/** What the chair may declare; `approved_pending_dependencies` is never chosen (it is how an approval is stored while dependencies are undecided). */
export const OUTCOMES = ["approved", "approved_with_conditions", "approved_subject_to_circulation", "changes_requested", "deferred", "referred", "rejected", "withdrawn"];
export const OUTCOME_HELP: Record<string, string> = {
  approved: "Effective now, or once any dependent decisions are decided.",
  approved_with_conditions: "Effective now; each condition is tracked with an owner and a due date.",
  approved_subject_to_circulation: "Approved by those present; the absent areas record their position by the due date, and a no brings it back to the next session.",
  changes_requested: "Back to the submitter to revise and resubmit; positions are superseded on resubmission.",
  deferred: "Stays in review and goes on the next agenda; the reason is recorded.",
  referred: "Moves to another board, which derives its own areas; positions recorded here are superseded.",
  rejected: "Closed. The item stays on record with its positions and audit trail.",
  withdrawn: "Closed by the submitter. Nothing is decided.",
};
/** Outcomes that need a written reason before they can be declared. */
export const OUTCOMES_NEEDING_REASON = ["changes_requested", "deferred", "referred", "rejected"];

/**
 * Criticality classification of applications: how critical each one is, and the services it supports — an important
 * business service (PRA/FCA), a critical or important function (DORA), an essential function (NCSC CAF) or a plain
 * business service. Supporting one of the first three makes an application critical.
 */
export const CRITICALITIES = ["critical", "important", "standard"];
export const SERVICE_KINDS = ["ibs", "cif", "essential_function", "business_service"];
export const REGULATED_KINDS = ["ibs", "cif", "essential_function"];

/** Assessments: due diligence a board seat requests on a review; the named assessor records the result themselves. */
export const ASSESSMENT_TYPES = ["dpia", "security", "supplier", "clinical-safety", "ai-impact", "accessibility", "impact", "scope", "other"];
export const ASSESSMENT_RESULTS = ["satisfactory", "satisfactory_with_remarks", "unsatisfactory", "not_applicable"];

const headers = (extra?: Record<string, string>) => { const h: Record<string, string> = { ...(extra || {}) }; if (authMode !== "entra") h["x-user"] = currentUser(); return h; };

/** Turns a non-2xx response into an ApiError; 401/403 also raise window events the shell turns into the sign-in page / a "not allowed" toast. */
async function fail(res: Response): Promise<never> {
  let body: any = null; try { body = await res.json(); } catch {}
  if (res.status === 401 && body?.error === "sign_in_required") {
    window.dispatchEvent(new CustomEvent("archigov:signin", { detail: { login_url: body.login_url } }));
    throw new ApiError(401, "Sign in to continue", { code: "sign_in_required", login_url: body.login_url });
  }
  if (res.status === 403 && body?.error === "forbidden") {
    const roles: string[] = body.roles || [];
    const msg = `Your role (${roles.map((r) => ROLE_LABELS[r] || r).join(", ") || "none"}) can't ${capabilityVerb(body.capability)}`;
    window.dispatchEvent(new CustomEvent("archigov:forbidden", { detail: { message: msg } }));
    throw new ApiError(403, msg, { code: "forbidden", capability: body.capability, roles });
  }
  throw new ApiError(res.status, body?.error || res.statusText, { body });
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, { method, credentials: "same-origin", headers: headers({ "Content-Type": "application/json" }), body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) await fail(res);
  if (res.status === 204) return undefined as T;
  // An unknown /api path falls through to the SPA's index.html with a 200; say what that means instead of a JSON parse error.
  if (!(res.headers.get("content-type") || "").includes("json")) throw new Error(`${path.split("?")[0]} is not available on this server`);
  return res.json();
}
export const get = <T,>(p: string) => req<T>("GET", p);
export const post = <T,>(p: string, b?: unknown) => req<T>("POST", p, b);
export const put = <T,>(p: string, b?: unknown) => req<T>("PUT", p, b);
export const del = <T,>(p: string) => req<T>("DELETE", p);

/** POST a raw body (CSV text, ArchiMate XML) with its own content type. */
export async function postRaw<T>(path: string, body: string, contentType: string): Promise<T> {
  const res = await fetch(`/api${path}`, { method: "POST", credentials: "same-origin", headers: headers({ "Content-Type": contentType }), body });
  if (!res.ok) await fail(res);
  if (!(res.headers.get("content-type") || "").includes("json")) throw new Error(`${path.split("?")[0]} is not available on this server`);
  return res.json();
}

/** Downloads a file the API produces (JSON, CSV) as the current user; the server's Content-Disposition names it when present. */
export async function download(path: string, fallbackName: string): Promise<string> {
  const res = await fetch(`/api${path}`, { credentials: "same-origin", headers: headers() });
  if (!res.ok) await fail(res);
  if ((res.headers.get("content-type") || "").includes("text/html")) throw new Error(`${path.split("?")[0]} is not available on this server`);
  const blob = await res.blob();
  const m = /filename\*?="?([^";]+)"?/.exec(res.headers.get("content-disposition") || "");
  const name = m ? m[1].replace(/^UTF-8''/, "") : fallbackName;
  const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
  return name;
}

export const fmtDate = (s?: string | null) => (s ? new Date(s).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—");
export const fmtDateTime = (s?: string | null) => (s ? new Date(s).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
export const shortType = (t?: string | null) => (t || "").replace(/^Microsoft\./, "");
/** Date → YYYY-MM-DD (local), the format the API expects for due/expiry dates. */
export const toYMD = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const slug = (s: string) => String(s || "").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "export";

export const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"];
export const UK_REGIONS = ["uksouth", "ukwest", "global"];

/** Sentence-case fallback for any enum the API sends raw (open → Open, pre_review → Pre review). */
export const sentence = (s?: string | null) => {
  if (s === null || s === undefined || s === "") return "";
  const t = String(s).replace(/[_-]+/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/**
 * Human labels for every enum shown in the UI. Status is always rendered as colour + icon + word
 * (see StatusTag in components.tsx); these are the words.
 */
export const LABELS: Record<string, Record<string, string>> = {
  severity: { critical: "Critical", high: "High", medium: "Medium", low: "Low", info: "Info" },
  stage: { submitted: "Submitted", pre_review: "Pre-reviewed", in_review: "In review", changes_requested: "Changes requested", approved: "Approved", approved_with_conditions: "Approved with conditions", approved_pending_dependencies: "Approved pending dependencies", approved_subject_to_circulation: "Approved subject to circulation", rejected: "Rejected", withdrawn: "Withdrawn" },
  // board sessions: positions per area, how the chair resolved a conditional, session and agenda-item states, attendance, quorum, declared outcomes
  position: { yes: "Yes", no: "No", conditional: "Conditional", not_my_area: "Not my area", resolved: "Resolved", missing: "Awaiting position" },
  resolution: { accepted_condition: "Accepted as tracked condition", addressed: "Addressed in session", dependent_decision: "Dependent decision" },
  session_status: { planned: "Planned", open: "Open", closed: "Closed" },
  item_state: { awaiting_positions: "Awaiting positions", open: "Conditional open", blocked: "Blocked", ready: "Ready", declared: "Declared", deferred: "Deferred", withdrawn: "Withdrawn", listed: "Listed", called: "Called" },
  attendance: { present: "Present", apologies: "Apologies", absent: "Absent" },
  quorum: { covered: "Covered", uncovered: "Uncovered" },
  area: AREA_LABELS,
  outcome: { approved: "Approved", approved_with_conditions: "Approved with conditions", approved_subject_to_circulation: "Approved subject to circulation", approved_pending_dependencies: "Approved pending dependencies", changes_requested: "Changes requested", deferred: "Deferred", referred: "Referred to another board", rejected: "Rejected", withdrawn: "Withdrawn" },
  kind: { standard: "Standard", principle: "Principle", pattern: "Pattern", policy: "Policy" },
  lifecycle: { draft: "Draft", in_review: "In review", adopted: "Adopted", retired: "Retired" },
  review_type: { design: "Design", decision: "Decision", standard: "Standard", principle: "Principle", pattern: "Pattern", policy: "Policy", exception: "Exception" },
  enforcement: { mandatory: "Mandatory", recommended: "Recommended" },
  // decision topics; sentence() would produce "Ai system"
  topic: { general: "General", hosting: "Hosting", "data-store": "Data store", integration: "Integration", "ai-system": "AI system", security: "Security", identity: "Identity", resilience: "Resilience" },
  // assessments: what was asked for, where it stands, and what the assessor concluded
  assessment_type: { dpia: "DPIA", security: "Security", supplier: "Supplier", "clinical-safety": "Clinical safety", "ai-impact": "AI impact", accessibility: "Accessibility", impact: "Impact", scope: "Scope", other: "Custom" },
  assessment_status: { requested: "Requested", completed: "Completed", waived: "Waived" },
  assessment_result: { satisfactory: "Satisfactory", satisfactory_with_remarks: "Satisfactory with remarks", unsatisfactory: "Unsatisfactory", not_applicable: "Not applicable" },
  impact: { minor: "Minor change", major: "Major change" },
  criticality: { critical: "Critical", important: "Important", standard: "Standard" },
  service_kind: { ibs: "Important business service", cif: "Critical or important function", essential_function: "Essential function", business_service: "Business service" },
  lifecycle_state: { supported: "Supported", ending: "Support ending", extended: "Extended support", end_of_life: "End of life", unknown: "Unknown" },
  legacy_status: { current: "Assessed", stale: "Assessment stale", due: "Assessment due", not_needed: "Not needed" },
  signoff_status: { current: "In date", due_soon: "Due soon", overdue: "Overdue" },
  signoff_outcome: { reaffirmed: "Reaffirmed", revision_needed: "Revision needed" },
  roadmap_kind: { decision: "Decision", change: "Planned change", condition: "Condition", lifecycle: "End of support", exception: "Exception" },
  roadmap_status: { realised: "Realised", in_progress: "In progress", not_started: "Not started", not_checkable: "Not checkable", proposed: "Proposed", active: "Active", new: "New", proposed_change: "Proposed", closed: "Closed", open: "Open", overdue: "Overdue", met: "Met", end_of_life: "End of life", extended: "Extended support", ending: "Support ending", excepted: "Excepted" },
  exit_status: { current: "Plan in date", due: "Plan due", not_needed: "Not needed" },
  substitutability: { not_substitutable: "Not substitutable", highly_complex: "Highly complex", medium_complexity: "Medium complexity", easily_substitutable: "Easily substitutable" },
  provider_kind: { platform: "Cloud platform", supplier: "Named supplier" },
  service_kind_short: { ibs: "IBS", cif: "CIF", essential_function: "Essential function", business_service: "Business service" },
  approval: { approve: "Approved", request_changes: "Changes requested" },
  step: { pre_review: "Pre-review", approvals: "Approvals", decision: "Decision" },
  user_type: { ...LEGACY_USER_TYPE_LABELS, ...USER_TYPE_LABELS },
  board_role: { ...LEGACY_BOARD_ROLE_LABELS, ...BOARD_ROLE_LABELS },
  precheck: { pass: "Pass", warn: "Warning", fail: "Fail" },
  decision: { proposed: "Proposed", accepted: "Accepted", rejected: "Rejected", superseded: "Superseded", deprecated: "Deprecated" },
  finding: { open: "Open", excepted: "Excepted", resolved: "Resolved" },
  condition: { open: "Open", met: "Met", overdue: "Overdue", waived: "Waived" },
  exception: { active: "Active", expired: "Expired", revoked: "Revoked" },
  risk: { low: "Low risk", medium: "Medium risk", high: "High risk" },
  radar: { adopt: "Adopt", trial: "Trial", assess: "Assess", hold: "Hold", retire: "Retire" },
  origin: { derived: "Derived", inferred: "Inferred", human: "Human", ai: "AI", rules: "Rules engine", template: "Template" },
  verification: { verified: "Human verified", unverified: "Not human verified" },
  work: { Active: "Active", Closed: "Closed", New: "New", Proposed: "Proposed", Resolved: "Resolved", Removed: "Removed" },
  source: { ok: "OK", error: "Error", never: "Never synced", idle: "Idle" },
  source_kind: { "demo-azure": "Demo Azure estate", "demo-ado": "Demo Azure DevOps", azure: "Azure Resource Graph", defender: "Defender for Cloud", azure_policy: "Azure Policy", ado: "Azure DevOps", csv: "CSV import", archimate: "ArchiMate import", manual: "Manual entry" },
  evidence: { pass: "Pass", fail: "Fail", unknown: "Unknown" },
  evidence_source: { defender: "Defender", azure_policy: "Azure Policy", manual: "Manual" },
  llm: { configured: "Configured", missing: "Not configured" },
  configured: { configured: "Configured", missing: "Not configured", fixtures: "Fixture mode" },
  check: { ok: "Valid", failed: "Failed", unknown: "Unknown" },
  auth_mode: { local: "Local sign-in (PoC)", entra: "Microsoft Entra ID" },
  role: ROLE_LABELS,
  attention: { open: "Open", overdue: "Overdue", expired: "Expired", decision: "Needs decision", changed: "Changed after approval", region: "Outside home regions" },
  citation: { standard: "Standard", principle: "Principle", pattern: "Pattern", policy: "Policy", decision: "Decision", resource: "Resource", section: "Section" },
  run_kind: { sync: "Sync", evaluate: "Evaluate" },
  run: { done: "Done", error: "Error", running: "Running" },
  // audit log entities as the server names them (some plural, some not)
  entity: { sign_in: "Sign-in", sessions: "Session", session: "Session", reviews: "Review", review: "Review", decisions: "Decision", decision: "Decision", boards: "Board", board: "Board", standard: "Standard", principle: "Principle", pattern: "Pattern", policy: "Policy", artefact: "Catalogue item", artefacts: "Catalogue item", evidence: "Evidence", run: "Run", source: "Source", tenant: "Tenant", application: "Application", applications: "Application", element: "Element", work_item: "Backlog item", work_items: "Backlog item", user: "User", users: "User", finding: "Finding", exception: "Exception", condition: "Condition", settings: "Settings", position: "Position", positions: "Position" },
};
export const labelFor = (kind: string, v?: string | null) => (v === null || v === undefined || v === "" ? "—" : LABELS[kind]?.[v] ?? sentence(v));
/** Kept for callers that index by stage directly. */
export const stageLabel = LABELS.stage;
