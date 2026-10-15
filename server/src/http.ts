import { db, j } from "./db.js";
import { currentPrincipal } from "./auth/context.js";

/**
 * Who is acting, as recorded in audit rows: the signed-in principal's stable id ("<tid>:<oid>" from Entra —
 * never the mutable, unverified email — or the chosen user name in local mode), falling back to the x-user
 * header in local mode for scripts and the old PoC behaviour. Display names are resolved from `user.<id>`.
 */
export const actorOf = (c: any) => { const p = currentPrincipal() || (c as any)?.get?.("principal"); return p ? p.id : (c.req.header("x-user") || "local-admin"); };
/** The acting principal's system user type (the admin flag is separate: `currentPrincipal()?.is_platform_admin`). */
export const roleOf = () => currentPrincipal()?.user_type ?? null;

// Row → API shape: JSON columns parsed once, here, so every module returns the same shapes.
export const std = (r: any) => ({ ...r, control_refs: j(r.control_refs_json, []), rule: j(r.rule_json, null) });
export const dec = (r: any) => ({ ...r, options: j(r.options_json, []), constraint: j(r.constraint_json, null), application_ids: j(r.application_ids_json, []), standard_ids: j(r.standard_ids_json, []) });
export const fnd = (r: any) => ({ ...r, evidence: j(r.evidence_json, {}) });
/** Item types that warrant an architecture decision while open: ADO epics and every manually logged change. */
export const NEEDS_DECISION_TYPES = ["Epic", "Project", "Initiative", "Change"];
export const wi = (r: any) => ({ ...r, tags: j(r.tags_json, []),
  needs_decision: NEEDS_DECISION_TYPES.includes(r.type) && !["Closed", "Removed"].includes(r.state) && !r.decision_id && !r.review_id });
export const ev = (r: any) => ({ ...r, data: j(r.data_json, {}) });
export const ownerOf = (r: { tags: Record<string, string> }) => r.tags.owner || r.tags.Owner;
/** An ADR with an empty application list applies to every application. */
export const DECISIONS_FOR_APP = "(application_ids_json LIKE ? OR application_ids_json='[]')";

// Human codes: STD-nnn, ADR-nnnn, REV-nnnn, SES-nnnn. Next number is per prefix and numeric, so codes never
// collide whatever the string sort order or the suffixes (STD-006b) in play.
const CODE_WIDTH: Record<string, number> = { STD: 3, ADR: 4, REV: 4, SES: 4 };
export const nextCode = (table: string, prefix: string) => {
  const row = db.prepare(`SELECT max(CAST(substr(code, ?) AS INTEGER)) n FROM ${table} WHERE code LIKE ?`).get(prefix.length + 2, `${prefix}-%`) as any;
  return `${prefix}-${String((row?.n || 0) + 1).padStart(CODE_WIDTH[prefix] ?? 4, "0")}`;
};
