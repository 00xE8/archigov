/**
 * Two-level RBAC with board seats.
 *
 *  Operations   — `is_platform_admin`, a flag: sources, settings, users, boards, backups, demo tools, evidence
 *                 import and the first-run pack bootstrap. It is not a governance identity: a platform admin never
 *                 submits, comments, approves or decides (segregation of duties) and usually has no system role.
 *  System role  — `user_type`, at most one: author (submits every kind of review, authors drafts and decisions,
 *                 verifies, imports), auditor (reads and exports), service (reads; integrations carry their own
 *                 secret) or none — someone whose rights come only from board seats, or an operations identity.
 *  Board seats  — a role on a board: chair, decision_maker, reviewer (advisory), secretary, observer. Approving
 *                 and deciding reviews come from the seat and the board's approval policy, never from a global
 *                 role; a seat's rights apply to the reviews routed to that board.
 *
 * Capabilities are what routes are gated on. The type, the flag and each seat map to a fixed set; seat-held
 * capabilities pass the route gate when held on ANY board and the review/board handlers then check the specific
 * board. Legacy names (admin, architect, engineer, submitter, chair, reviewer, board_member, auditor; the board
 * role "member") are still accepted from stored settings, Entra app-role values and request bodies, and expand
 * to the new model.
 */
export const USER_TYPES = ["author", "auditor", "service"] as const;
export type UserType = (typeof USER_TYPES)[number];
export const BOARD_ROLES = ["chair", "decision_maker", "reviewer", "secretary", "observer"] as const;
export type BoardRole = (typeof BOARD_ROLES)[number];

export const CAPABILITIES = [
  "read", "export_evidence",
  "submit_review", "comment", "resubmit", "manage_artefacts", "create_decision", "pre_review", "verify", "import_artefacts", "log_change",
  "manage_platform", "manage_board",
  "approve_review", "request_changes", "decide_review", "grant_exception", "resolve_finding", "close_condition", "set_decision_status",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export interface Membership { id: string; code: string; name: string; role: BoardRole; /** areas of responsibility owned on that board (decision makers) */ areas?: string[] }
/** What capabilities are computed from: the system role (or none), the admin flag and the board seats. */
export interface Profile { user_type: UserType | null; is_platform_admin: boolean; boards: Membership[] }

export const isUserType = (v: unknown): v is UserType => typeof v === "string" && (USER_TYPES as readonly string[]).includes(v);
export const isBoardRole = (v: unknown): v is BoardRole => typeof v === "string" && (BOARD_ROLES as readonly string[]).includes(v);
/** Seat spellings still met in stored policies, Entra values and old clients → the seat they mean ("member" was the decision-maker seat). */
export function normaliseBoardRole(v: unknown): BoardRole | null {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (s === "member" || s === "decisionmaker") return "decision_maker";
  return isBoardRole(s) ? s : null;
}

const TYPE_CAPS: Record<UserType, Capability[]> = {
  author: ["export_evidence", "submit_review", "comment", "resubmit", "manage_artefacts", "create_decision", "pre_review", "verify", "import_artefacts", "log_change"],
  // auditors read everything and take evidence away; they change nothing
  auditor: ["export_evidence"],
  // integrations: inbound hooks carry their own secret; a service account otherwise only reads
  service: [],
};
/** The operations flag: run the platform and bootstrap packs; never a governance right. */
const ADMIN_CAPS: Capability[] = ["export_evidence", "manage_platform", "import_artefacts"];
/**
 * What a seat grants on its board. The chair's exception/finding/condition/decision-status rights are a documented
 * simplification: they are not scoped to one board (a chair of any board holds them).
 */
export const SEAT_CAPS: Record<BoardRole, Capability[]> = {
  chair: ["decide_review", "approve_review", "request_changes", "comment", "pre_review", "manage_board", "grant_exception", "resolve_finding", "close_condition", "set_decision_status"],
  decision_maker: ["approve_review", "request_changes", "comment", "pre_review"],
  // advisory: may send a review back for changes, but an approval from this seat never counts
  reviewer: ["comment", "pre_review", "request_changes"],
  // runs the board: members and routing, not its approval policies
  secretary: ["comment", "manage_board"],
  observer: [],
};
export const seatHas = (role: BoardRole, cap: Capability) => SEAT_CAPS[role].includes(cap);
/** Seats whose approval counts towards an approvals step / may be named in a decision step. */
export const APPROVING_ROLES: BoardRole[] = BOARD_ROLES.filter((r) => seatHas(r, "approve_review"));
export const DECIDING_ROLES: BoardRole[] = BOARD_ROLES.filter((r) => seatHas(r, "decide_review"));

export function capabilitiesFor(p: Profile | null | undefined): Set<Capability> {
  const out = new Set<Capability>();
  if (!p) return out;
  out.add("read");
  if (isUserType(p.user_type)) for (const c of TYPE_CAPS[p.user_type]) out.add(c);
  if (p.is_platform_admin) for (const c of ADMIN_CAPS) out.add(c);
  for (const m of p.boards || []) {
    if (!isBoardRole(m.role)) continue;
    out.add("export_evidence");
    for (const c of SEAT_CAPS[m.role]) out.add(c);
  }
  return out;
}
export function canMap(p: Profile | null | undefined): Record<Capability, boolean> {
  const have = capabilitiesFor(p);
  return Object.fromEntries(CAPABILITIES.map((c) => [c, have.has(c)])) as Record<Capability, boolean>;
}

// ---------- legacy role names ----------
/** The old global role names a profile is still reported under (/auth/me.roles, /auth/roles). */
export const ROLES = ["admin", "chair", "reviewer", "submitter", "auditor"] as const;
export type Role = (typeof ROLES)[number];
export type LegacyRole = Role;
export const isRole = (r: unknown): r is Role => typeof r === "string" && (ROLES as readonly string[]).includes(r);

export interface RoleGrant { user_type?: UserType; is_platform_admin?: boolean; board?: { code: string; role: BoardRole } }
/** Every old name, expressed in the new model (DA = the Design Authority board). admin is the operations flag alone. */
export const LEGACY_PROFILE: Record<string, RoleGrant> = {
  admin: { is_platform_admin: true },
  architect: { user_type: "author" },
  engineer: { user_type: "author" },
  submitter: { user_type: "author" },
  chair: { user_type: "author", board: { code: "DA", role: "chair" } },
  reviewer: { user_type: "author", board: { code: "DA", role: "reviewer" } },
  board_member: { board: { code: "DA", role: "decision_maker" } },
  auditor: { user_type: "auditor" },
};
export const LEGACY_NAMES = Object.keys(LEGACY_PROFILE);
/**
 * One role value (an Entra app-role value, a stored setting, a request body) → what it grants. Accepts the user
 * types themselves, the literal platform_admin, a seat qualified with a colon or slash ("PCB:chair",
 * "board/PCB/decision_maker"; "member" still means decision_maker) and the legacy names. Case-insensitive; for
 * dotted values the last segment is tried ("archigov.author", "arb.chair" → the legacy chair), which is what
 * ENTRA_ROLE_MAP examples rely on.
 */
export function resolveRoleName(v: unknown): RoleGrant | null {
  if (typeof v !== "string") return null;
  const raw = v.trim(), lower = raw.toLowerCase();
  if (!lower) return null;
  if (lower === "platform_admin" || lower === "platform-admin") return { is_platform_admin: true };
  if (isUserType(lower)) return { user_type: lower };
  if (LEGACY_PROFILE[lower]) return { ...LEGACY_PROFILE[lower] };
  const bm = raw.match(/^(?:board[:/])?([A-Za-z][A-Za-z0-9_-]{1,15})[:/]([A-Za-z_-]+)$/);
  if (bm) { const role = normaliseBoardRole(bm[2]); if (role) return { board: { code: bm[1].toUpperCase(), role } }; }
  const tail = lower.split(/[.:/]/).pop() || "";
  if (tail === "platform_admin" || tail === "platform-admin") return { is_platform_admin: true };
  if (isUserType(tail)) return { user_type: tail };
  if (LEGACY_PROFILE[tail]) return { ...LEGACY_PROFILE[tail] };
  return null;
}
/** The legacy names a profile still answers to, for callers that have not moved yet. */
export function legacyRolesOf(p: Profile | null | undefined): Role[] {
  if (!p) return [];
  const out = new Set<Role>();
  if (p.is_platform_admin) out.add("admin");
  for (const m of p.boards || []) { if (m.code === "DA" && m.role === "chair") out.add("chair"); if (m.code === "DA" && m.role === "reviewer") out.add("reviewer"); }
  if (p.user_type === "auditor") out.add("auditor");
  if (p.user_type === "author" && !out.size) out.add("submitter");
  return [...out];
}

/**
 * Route → capability. Matched top-down on method + path (path relative to /api). Anything that mutates and is
 * not listed falls back to `manage_platform`, so a new POST route is closed until someone opens it. "exempt"
 * routes do their own gatekeeping (health, the sign-in dance, inbound webhooks with their own secret). A rule
 * may list several capabilities: holding any one passes the gate (the first is the one a refusal names) and the
 * handler does the exact check. Seat-held capabilities pass here when held on ANY board; the review/board
 * handlers then check the review's own board and policy.
 */
type Verb = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "*";
interface RouteRule { method: Verb; pattern: RegExp; capability: Capability | Capability[] | "exempt" }
export const ROUTE_RULES: RouteRule[] = [
  { method: "*", pattern: /^\/health$/, capability: "exempt" },
  { method: "*", pattern: /^\/auth\/(me|local|login|callback|logout)$/, capability: "exempt" },
  { method: "GET", pattern: /^\/auth\/roles$/, capability: "read" },
  { method: "POST", pattern: /^\/auth\/roles$/, capability: "manage_platform" },
  { method: "*", pattern: /^\/hooks(\/|$)/, capability: "exempt" },
  { method: "GET", pattern: /^\/(evidence-pack|exports)(\/|$)/, capability: "export_evidence" },
  { method: "GET", pattern: /.*/, capability: "read" },
  { method: "POST", pattern: /^\/users$/, capability: "manage_platform" },
  { method: "PUT", pattern: /^\/users\/[^/]+$/, capability: "manage_platform" },
  // boards themselves are platform configuration; a board's members, routing, policies and areas are also run from its chair/secretary seats
  { method: "POST", pattern: /^\/boards$/, capability: "manage_platform" },
  { method: "PUT", pattern: /^\/boards\/[^/]+$/, capability: ["manage_platform", "manage_board"] },
  { method: "*", pattern: /^\/boards\/[^/]+\/(members|routing|policies)(\/|$)/, capability: ["manage_board", "manage_platform"] },
  // sessions are the board's own business: seats only — the platform admin never passes here (operations, not governance);
  // `comment` lets any seat record its own attendance, the handlers check the seat on the session's board
  { method: "*", pattern: /^\/boards\/[^/]+\/sessions(\/|$)/, capability: ["manage_board", "approve_review", "decide_review", "comment"] },
  { method: "*", pattern: /^\/sessions(\/|$)/, capability: ["manage_board", "approve_review", "decide_review", "comment"] },
  // reviews: the per-type capability (artefact types need manage_artefacts, decisions create_decision) is checked in the handler
  { method: "POST", pattern: /^\/reviews$/, capability: "submit_review" },
  { method: "POST", pattern: /^\/reviews\/[^/]+\/comment$/, capability: "comment" },
  { method: "POST", pattern: /^\/reviews\/[^/]+\/resubmit$/, capability: "resubmit" },
  { method: "POST", pattern: /^\/reviews\/[^/]+\/pre-review$/, capability: "pre_review" },
  { method: "POST", pattern: /^\/reviews\/[^/]+\/approvals$/, capability: ["approve_review", "request_changes"] },
  { method: "POST", pattern: /^\/reviews\/[^/]+\/positions$/, capability: ["approve_review", "request_changes"] },
  { method: "PUT", pattern: /^\/reviews\/[^/]+\/areas$/, capability: ["submit_review", "manage_board", "comment"] },
  { method: "POST", pattern: /^\/reviews\/[^/]+\/dependencies$/, capability: ["comment", "submit_review"] },
  { method: "POST", pattern: /^\/positions\/[^/]+\/resolve$/, capability: "decide_review" },
  // assessments: a board seat requests (handler checks the seat on the review's board); the assignee records the
  // result (handler checks identity — `comment` passes authors and every acting seat); the chair waives
  // the submitter PROVIDES an assessment as supporting information (the handler checks it is their own review)
  { method: "POST", pattern: /^\/reviews\/[^/]+\/assessments\/draft$/, capability: ["comment", "submit_review"] },
  { method: "POST", pattern: /^\/reviews\/[^/]+\/assessments\/provide$/, capability: "submit_review" },
  { method: "PUT", pattern: /^\/assessments\/[^/]+\/provided$/, capability: "submit_review" },
  { method: "POST", pattern: /^\/reviews\/[^/]+\/assessments$/, capability: ["approve_review", "request_changes"] },
  { method: "PUT", pattern: /^\/assessments\/[^/]+$/, capability: ["approve_review", "request_changes"] },
  { method: "POST", pattern: /^\/assessments\/[^/]+\/result$/, capability: ["comment", "submit_review"] },
  { method: "POST", pattern: /^\/assessments\/[^/]+\/waive$/, capability: "decide_review" },
  // withdrawing is the submitter's own act; the handler lets nobody else through on submit_review
  { method: "POST", pattern: /^\/reviews\/[^/]+\/decide$/, capability: ["decide_review", "submit_review"] },
  { method: "POST", pattern: /^\/review-events\/[^/]+\/verify$/, capability: "verify" },
  { method: "POST", pattern: /^\/conditions\/[^/]+\/close$/, capability: "close_condition" },
  // AI review of a decision draft: the same right as authoring the decision it reviews
  { method: "POST", pattern: /^\/decisions\/review-draft$/, capability: "create_decision" },
  // evidence on a proposed decision: the author's act (the handler locks it to the decision's author)
  { method: "POST", pattern: /^\/decisions\/[^/]+\/assessments(\/provide)?$/, capability: "create_decision" },
  { method: "POST", pattern: /^\/decisions$/, capability: "create_decision" },
  { method: "PUT", pattern: /^\/decisions\/[^/]+$/, capability: "create_decision" },
  { method: "POST", pattern: /^\/decisions\/[^/]+\/status$/, capability: "set_decision_status" },
  { method: "POST", pattern: /^\/decisions\/[^/]+\/verify$/, capability: "verify" },
  { method: "POST", pattern: /^\/(elements|standards|artefacts)\/[^/]+\/verify$/, capability: "verify" },
  { method: "POST", pattern: /^\/applications\/[^/]+\/verify-all$/, capability: "verify" },
  // design annotations: commentary beside the generated views — authors and acting seats; the handler locks edit/delete to the author
  { method: "POST", pattern: /^\/applications\/[^/]+\/annotations$/, capability: "comment" },
  { method: "*", pattern: /^\/annotations\/[^/]+$/, capability: "comment" },
  { method: "POST", pattern: /^\/resources\/[^/]+\/move$/, capability: "verify" },
  { method: "POST", pattern: /^\/(standards|artefacts)\/packs\/[^/]+\/import$/, capability: "import_artefacts" },
  { method: "POST", pattern: /^\/import(\/|$)/, capability: "import_artefacts" },
  // AI drafting for the catalogue editor: the same right as authoring the artefact it drafts for
  { method: "POST", pattern: /^\/(standards|artefacts)\/(draft-rule|suggest-references)$/, capability: "manage_artefacts" },
  { method: "POST", pattern: /^\/(standards|artefacts)$/, capability: "manage_artefacts" },
  { method: "PUT", pattern: /^\/(standards|artefacts)\/[^/]+$/, capability: "manage_artefacts" },
  { method: "POST", pattern: /^\/(standards|artefacts)\/[^/]+\/(retire|submit)$/, capability: "manage_artefacts" },
  // re-running the conformance engine is also an operations action (the scheduler and every source sync do it)
  { method: "POST", pattern: /^\/evaluate$/, capability: ["pre_review", "manage_platform"] },
  { method: "POST", pattern: /^\/findings\/[^/]+\/resolve$/, capability: "resolve_finding" },
  { method: "POST", pattern: /^\/exceptions$/, capability: "grant_exception" },
  // manual planned changes: an author's act (a potential change is governance content, so the platform admin gets 403)
  { method: "POST", pattern: /^\/work-items$/, capability: "log_change" },
  { method: "PUT", pattern: /^\/work-items\/[^/]+$/, capability: "log_change" },
  { method: "POST", pattern: /^\/work-items\/[^/]+\/(link|acknowledge-change|draft-decision)$/, capability: "comment" },
  // POST/PUT under /sources, /settings, /backup, /evidence/import, demo tools: default below → platform admin
];
/** The capabilities that open a route (any one suffices), or "exempt". */
export function routeCapabilities(method: string, path: string): Capability[] | "exempt" {
  const m = method.toUpperCase();
  for (const r of ROUTE_RULES) if ((r.method === "*" || r.method === m) && r.pattern.test(path)) return r.capability === "exempt" ? "exempt" : Array.isArray(r.capability) ? r.capability : [r.capability];
  return m === "GET" || m === "HEAD" || m === "OPTIONS" ? ["read"] : ["manage_platform"];
}
/** The capability a refusal of this route is reported under (the first of routeCapabilities). */
export function capabilityFor(method: string, path: string): Capability | "exempt" {
  const r = routeCapabilities(method, path);
  return r === "exempt" ? r : r[0];
}
