import { db, j, uid, nowIso, audit, getSetting, setSetting } from "../db.js";
import { ensureUser, upsertUser, setMembership, demoLoaded } from "../auth/users.js";
import { nextCode } from "../http.js";
import { DEFAULT_POLICY, boardByCode, type Policy } from "./workflow.js";
import { AREA_CATALOGUE } from "./areas.js";
import { createSession } from "./sessions.js";
import { refreshAreas } from "../reviews.js";
import { preReviewArtefact, setArtefactLifecycle } from "../artefacts.js";
import type { BoardRole, UserType } from "../auth/roles.js";

/**
 * Default boards, idempotent, run at boot after the demo seed.
 *   DA   Design Authority            — design, decision, standard and pattern reviews; positions per area of
 *                                      responsibility from the decision makers owning them, the chair declares
 *   PCB  Policy & Compliance Board   — policy, principle and exception reviews; two approvals (chair or decision
 *                                      makers), chair decides (count mode)
 * The boards and their routing/policies always exist (a review must have somewhere to go); the demo users, their
 * seats, the DA's areas and the first planned session are created only when the demo tenant is loaded. The demo
 * cast is versioned: when the shape of the cast changes (DEMO_USERS_VERSION), an existing demo tenant is brought
 * to the new shape once; after that, boot only fills in what is missing, so an admin's later edits survive restarts.
 */
const PCB_POLICY: Policy = { steps: [
  { name: "Automatic pre-review", kind: "pre_review" },
  { name: "Board approval", kind: "approvals", mode: "count", min: 2, roles: ["chair", "decision_maker"] },
  { name: "Chair decision", kind: "decision", roles: ["chair"] },
] };
/** The demo Design Authority: one position per touched area from the decision maker who owns it; the chair has no vote. */
const DA_POLICY: Policy = { steps: [
  { name: "Automatic pre-review", kind: "pre_review" },
  { name: "Positions by area", kind: "approvals", mode: "areas", roles: ["decision_maker"] },
  { name: "Chair declares", kind: "decision", roles: ["chair"] },
] };
const DA_AREAS = AREA_CATALOGUE.map((a) => a.id);

const DEMO_USERS_VERSION = "3";
/** id, display name, system role, platform admin */
const DEMO_USERS: [string, string, UserType | null, boolean][] = [
  ["j.duduka", "Joel Duduka", "author", false],      // chief architect: authors, chairs the DA, decides at the PCB
  ["m.hughes", "Mia Hughes", null, false],           // decision maker on both boards, no system role
  ["p.osei", "Priya Osei", null, false],             // DA decision maker (integration, infrastructure, resilience, cost), no system role
  ["s.patel", "Sanjay Patel", "author", false],      // author, advisory reviewer on the DA
  ["a.okafor", "Ada Okafor", "author", false],       // author, DA secretary
  ["t.nguyen", "Tom Nguyen", "author", false],       // author
  ["r.khan", "Rosa Khan", null, false],              // chairs the PCB, no system role
  ["a.uditor", "Anna Auditor", "auditor", false],
  ["ops.admin", "Omar Adeyemi", null, true],         // platform admin only: runs the instance, no governance identity
  ["svc.ado", "Azure DevOps feed", "service", false],
];
/** board code, user, seat, areas owned (decision makers) */
const DEMO_SEATS: [string, string, BoardRole, string[] | null][] = [
  ["DA", "j.duduka", "chair", null], ["DA", "m.hughes", "decision_maker", ["security", "data", "compliance", "ai"]], ["DA", "p.osei", "decision_maker", ["integration", "infrastructure", "resilience", "cost"]],
  ["DA", "s.patel", "reviewer", null], ["DA", "a.okafor", "secretary", null],
  ["PCB", "r.khan", "chair", null], ["PCB", "j.duduka", "decision_maker", null], ["PCB", "m.hughes", "decision_maker", null],
];

function ensureBoard(code: string, name: string, purpose: string) {
  let b = boardByCode(code);
  if (!b) { db.prepare("INSERT INTO boards(id,code,name,purpose,created_at) VALUES (?,?,?,?,?)").run(uid(), code, name, purpose, nowIso()); b = boardByCode(code)!; }
  return b;
}
const ensurePolicy = (boardId: string, type: string, policy: Policy) =>
  db.prepare("INSERT INTO approval_policies(board_id,review_type,policy_json) VALUES (?,?,?) ON CONFLICT(board_id,review_type) DO NOTHING").run(boardId, type, JSON.stringify(policy));
const assertPolicy = (boardId: string, type: string, policy: Policy) =>
  db.prepare("INSERT INTO approval_policies(board_id,review_type,policy_json) VALUES (?,?,?) ON CONFLICT(board_id,review_type) DO UPDATE SET policy_json=excluded.policy_json").run(boardId, type, JSON.stringify(policy));
const ensureRouting = (boardId: string, type: string) => {
  if (!db.prepare("SELECT 1 FROM board_routing WHERE board_id=? AND review_type=? AND kind IS NULL AND category IS NULL").get(boardId, type))
    db.prepare("INSERT INTO board_routing(id,board_id,review_type,kind,category,priority) VALUES (?,?,?,?,?,?)").run(uid(), boardId, type, null, null, 100);
};
/** Next Tuesday 10:00 UTC — the demo DA sits fortnightly. */
export function nextTuesday10(from = new Date()): string {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), 10, 0, 0));
  const delta = (2 - d.getUTCDay() + 7) % 7 || 7;
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString();
}

export function seedBoards(actor = "bootstrap") {
  const da = ensureBoard("DA", "Design Authority", "Approves designs and architecture decisions and curates standards and patterns.");
  const pcb = ensureBoard("PCB", "Policy & Compliance Board", "Adopts policies and principles and grants exceptions.");
  const demo = demoLoaded();
  for (const t of ["design", "decision", "standard", "pattern"]) { ensurePolicy(da.id, t, demo ? DA_POLICY : DEFAULT_POLICY); ensureRouting(da.id, t); }
  for (const t of ["policy", "principle", "exception"]) { ensurePolicy(pcb.id, t, PCB_POLICY); ensureRouting(pcb.id, t); }
  const summary: Record<string, unknown> = { boards: ["DA", "PCB"] };

  // reviews that predate boards are design reviews of their application, routed to the Design Authority
  summary.reviews_routed = db.prepare("UPDATE reviews SET board_id=? WHERE board_id IS NULL").run(da.id).changes;

  if (demo) {
    const boards: Record<string, any> = { DA: da, PCB: pcb };
    // first time at this version (a fresh tenant, or one seeded with the old cast): assert the whole cast; afterwards only fill gaps
    const assertCast = getSetting("demo.users_version") !== DEMO_USERS_VERSION;
    for (const [id, name, user_type, is_platform_admin] of DEMO_USERS) assertCast ? upsertUser(id, { name, user_type, is_platform_admin }) : ensureUser(id, { name, user_type, is_platform_admin });
    // the Design Authority's areas of responsibility (and, with the cast, its policies in areas mode)
    if (assertCast || !(j((db.prepare("SELECT areas_json FROM boards WHERE id=?").get(da.id) as any)?.areas_json, []) || []).length) db.prepare("UPDATE boards SET areas_json=? WHERE id=?").run(JSON.stringify(DA_AREAS), da.id);
    if (assertCast) for (const t of ["design", "decision", "standard", "pattern"]) assertPolicy(da.id, t, DA_POLICY);
    for (const [code, id, role, areas] of DEMO_SEATS) {
      const b = boards[code];
      if (assertCast || !db.prepare("SELECT 1 FROM board_members WHERE board_id=? AND user_id=?").get(b.id, id)) setMembership(b.id, id, role, areas);
    }
    if (assertCast) { setSetting("demo.users_version", DEMO_USERS_VERSION); summary.demo_cast_asserted = true; }
    summary.demo_users = DEMO_USERS.length;

    // one policy review in flight at the Policy & Compliance Board, when the catalogue seeded its draft policy
    const pol = db.prepare("SELECT id, code, title, category FROM standards WHERE code='POL-002'").get() as any;
    if (pol && !db.prepare("SELECT 1 FROM reviews WHERE target_id=?").get(pol.id)) {
      try {
        const id = uid(), now = nowIso(), code = nextCode("reviews", "REV");
        db.prepare(`INSERT INTO reviews(id,code,title,application_id,decision_id,work_item_id,risk_tier,stage,summary,design_md,submitted_by,created_at,updated_at,type,target_kind,target_id,board_id,impact) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(id, code, `Adopt ${pol.code}: ${pol.title}`, null, null, null, "medium", "submitted", `Proposed for adoption by the Policy & Compliance Board.`, "", "s.patel", now, now, "policy", "artefact", pol.id, pcb.id, "major");
        db.prepare(`INSERT INTO review_events(id,review_id,kind,actor,body_md,data_json,origin,verification,created_at) VALUES (?,?,?,?,?,?,?,?,?)`).run(uid(), id, "submitted", "s.patel", "Submitted for adoption.", "{}", "human", "verified", now);
        setArtefactLifecycle(pol.id, "in_review", "s.patel", { reviewId: id });
        const pre = preReviewArtefact(pol.id);
        db.prepare(`INSERT INTO review_events(id,review_id,kind,actor,body_md,data_json,origin,verification,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
          .run(uid(), id, "pre_review", "system", `${(pre.checks || []).length} checks; ${pre.impact?.findings ?? 0} finding(s) would open on adoption.`, JSON.stringify({ engine: "rules", summary: "Artefact pre-review", recommendation: pre.ok ? "approve" : "request_changes", checks: pre.checks, impact: pre.impact, findings: [], suggested_conditions: [] }), "rules", "unverified", now);
        db.prepare("UPDATE reviews SET stage='in_review', updated_at=? WHERE id=?").run(now, id);
        audit(actor, "create", "reviews", id, { code, type: "policy", target: pol.code, board: "PCB", seeded: true });
        summary.policy_review = code;
      } catch (e: any) { summary.policy_review_error = String(e?.message || e); }
    }
  }

  // reviews written before areas existed (or by the seed) get their touched areas derived once; a board without areas yields []
  const undone = db.prepare("SELECT id FROM reviews WHERE areas_json IS NULL").all() as any[];
  for (const r of undone) refreshAreas(r.id);
  summary.reviews_areas_derived = undone.length;

  // the first planned sitting of the Design Authority, agenda derived, when the demo is loaded and no session exists yet
  if (demo && !(db.prepare("SELECT count(*) c FROM board_sessions").get() as any).c) {
    try { const s = createSession(da, { scheduled_at: nextTuesday10(), title: "Design Authority — fortnightly" }, "a.okafor"); summary.session = s.code; }
    catch (e: any) { summary.session_error = String(e?.message || e); }
  }
  return summary;
}
