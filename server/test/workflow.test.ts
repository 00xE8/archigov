import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Policy satisfaction: min approvals from the listed seats, approvals before a resubmission don't count,
// request_changes blocks (a reviewer's is advisory), and only a decision-step seat may decide — on a scratch database.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "archigov-workflow-"));
delete process.env.AUTH_MODE;
const { db, migrate, uid, nowIso } = await import("../src/db.js");
await migrate();
const { ensureUser, setMembership } = await import("../src/auth/users.js");
const { principalFrom } = await import("../src/auth/middleware.js");
const { approvalProgress, canApprove, canRequestChanges, canActOn, canDecide, recordApproval, supersedeApprovals, normalisePolicy, routeBoard, boardByCode, policyFor, awaitingMe } = await import("../src/boards/workflow.js");

const now = nowIso();
db.prepare("INSERT INTO boards(id,code,name,purpose,created_at) VALUES (?,?,?,?,?)").run("b-da", "DA", "Design Authority", "", now);
db.prepare("INSERT INTO boards(id,code,name,purpose,created_at) VALUES (?,?,?,?,?)").run("b-pcb", "PCB", "Policy Board", "", now);
db.prepare("INSERT INTO approval_policies(board_id,review_type,policy_json) VALUES (?,?,?)").run("b-pcb", "policy", JSON.stringify({ steps: [{ name: "pre", kind: "pre_review" }, { name: "Board approval", kind: "approvals", min: 2, roles: ["chair", "decision_maker"] }, { name: "Chair decision", kind: "decision", roles: ["chair"] }] }));
// a policy still stored with the old seat name reads as decision_maker
db.prepare("INSERT INTO approval_policies(board_id,review_type,policy_json) VALUES (?,?,?)").run("b-pcb", "exception", JSON.stringify({ steps: [{ name: "Board approval", kind: "approvals", min: 1, roles: ["member"] }, { name: "Chair decision", kind: "decision", roles: ["chair"] }] }));
const user = (id: string, type: any, admin = false, memberships: [string, any][] = []) => { ensureUser(id, { name: id, user_type: type, is_platform_admin: admin }); for (const [b, r] of memberships) setMembership(b, id, r); return principalFrom({ id, name: id, email: null, user_type: type, is_platform_admin: admin, created_at: now, updated_at: now }, "session"); };
const chair = user("chair", null, false, [["b-pcb", "chair"]]);
const dm = user("dm", null, false, [["b-pcb", "decision_maker"]]);
const dm2 = user("dm2", "author", false, [["b-pcb", "decision_maker"]]);
const reviewer = user("reviewer", "author", false, [["b-pcb", "reviewer"]]);
const secretary = user("secretary", "author", false, [["b-pcb", "secretary"]]);
const seatOnlySecretary = user("secretary2", null, false, [["b-pcb", "secretary"]]);
const observer = user("observer", null, false, [["b-pcb", "observer"]]);
const admin = user("admin", null, true);
const submitter = user("submitter", "author", false, [["b-pcb", "decision_maker"]]);
const author = user("author", "author");
const daOnly = user("da.dm", null, false, [["b-da", "decision_maker"]]);

const review = (stage = "in_review", type = "policy") => { const id = uid(); db.prepare("INSERT INTO reviews(id,code,title,risk_tier,stage,submitted_by,created_at,updated_at,type,target_kind,target_id,board_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(id, `REV-T${id.slice(0, 4)}`, "t", "medium", stage, "submitter", now, now, type, "artefact", "art-1", "b-pcb"); return db.prepare("SELECT * FROM reviews WHERE id=?").get(id) as any; };

test("policy normalisation: nonsense rejected, a decision step required, only approving/deciding seats, old names normalised", () => {
  assert.throws(() => normalisePolicy({}), /steps/);
  assert.throws(() => normalisePolicy({ steps: [{ kind: "approvals", roles: ["decision_maker"] }] }), /decision/);
  assert.throws(() => normalisePolicy({ steps: [{ kind: "approvals", roles: [] }, { kind: "decision", roles: ["chair"] }] }), /board role/);
  assert.throws(() => normalisePolicy({ steps: [{ kind: "approvals", roles: ["reviewer"] }, { kind: "decision", roles: ["chair"] }] }), /advisory/);
  assert.throws(() => normalisePolicy({ steps: [{ kind: "approvals", roles: ["secretary", "observer"] }, { kind: "decision", roles: ["chair"] }] }), /does not approve/);
  assert.throws(() => normalisePolicy({ steps: [{ kind: "approvals", roles: ["chair"] }, { kind: "decision", roles: ["decision_maker"] }] }), /does not decide/);
  const p = normalisePolicy({ steps: [{ kind: "approvals", roles: ["member", "nonsense", "Member"], min: 0 }, { kind: "decision", roles: ["chair"] }] });
  assert.deepEqual(p.steps[0], { name: "approvals", kind: "approvals", mode: "count", min: 1, roles: ["decision_maker"] });
  assert.deepEqual(policyFor("b-pcb", "exception").steps[0].roles, ["decision_maker"], "a stored policy with the old name reads as decision_maker");
  // areas mode: min is dropped, roles default to the decision makers, a reviewer still cannot be listed
  const a = normalisePolicy({ steps: [{ kind: "approvals", mode: "areas", min: 3 }, { kind: "decision", roles: ["chair"] }] });
  assert.deepEqual(a.steps[0], { name: "approvals", kind: "approvals", mode: "areas", roles: ["decision_maker"] });
  assert.throws(() => normalisePolicy({ steps: [{ kind: "approvals", mode: "areas", roles: ["reviewer"] }, { kind: "decision", roles: ["chair"] }] }), /advisory/);
  assert.equal(normalisePolicy({ steps: [{ kind: "approvals", mode: "nonsense", roles: ["chair"] }, { kind: "decision", roles: ["chair"] }] }).steps[0].mode, "count", "an unknown mode is count");
});

test("routing: most specific rule wins, then priority, DA is the fallback", () => {
  db.prepare("INSERT INTO board_routing(id,board_id,review_type,kind,category,priority) VALUES (?,?,?,?,?,?)").run("r1", "b-da", "standard", null, null, 100);
  db.prepare("INSERT INTO board_routing(id,board_id,review_type,kind,category,priority) VALUES (?,?,?,?,?,?)").run("r2", "b-pcb", "standard", null, "AI", 100);
  db.prepare("INSERT INTO board_routing(id,board_id,review_type,kind,category,priority) VALUES (?,?,?,?,?,?)").run("r3", "b-pcb", "policy", null, null, 100);
  assert.equal(routeBoard("standard", "standard", "Security")?.code, "DA");
  assert.equal(routeBoard("standard", "standard", "AI")?.code, "PCB", "category-specific rule beats the general one");
  assert.equal(routeBoard("policy")?.code, "PCB");
  assert.equal(routeBoard("exception")?.code, "DA", "no rule → the board coded DA");
  assert.equal(boardByCode("da")?.code, "DA");
});

test("approvals: min distinct approvals from the listed seats; reviewer, secretary, observer, submitter, outsider and platform admin cannot approve", () => {
  const r = review();
  assert.equal(canApprove(observer, r).ok, false); assert.match(canApprove(observer, r).reason!, /observer/);
  assert.equal(canApprove(reviewer, r).ok, false); assert.match(canApprove(reviewer, r).reason!, /advisory/);
  assert.equal(canApprove(secretary, r).ok, false); assert.match(canApprove(secretary, r).reason!, /secretary/);
  assert.equal(canApprove(submitter, r).ok, false, "submitter of the review");
  assert.equal(canApprove(admin, r).ok, false, "platform admin with no seat"); assert.match(canApprove(admin, r).reason!, /not a member/);
  assert.equal(canApprove(author, r).ok, false, "an author without a seat"); assert.equal(canApprove(daOnly, r).ok, false, "a seat on another board");
  assert.equal(canApprove(dm, r).ok, true); assert.equal(canApprove(chair, r).ok, true);
  let prog = approvalProgress(r);
  assert.equal(prog.required, 2); assert.equal(prog.received, 0); assert.equal(prog.satisfied, false);
  assert.equal(awaitingMe(dm, r), true); assert.equal(awaitingMe(reviewer, r), false, "an advisory seat is not awaited"); assert.equal(awaitingMe(chair, r), true, "the chair's approval counts too");
  recordApproval(r, dm, "decision_maker", "approve", null, "dm");
  recordApproval(r, dm, "decision_maker", "approve", null, "dm"); // same user twice counts once
  prog = approvalProgress(r); assert.equal(prog.received, 1); assert.equal(prog.satisfied, false);
  assert.equal(awaitingMe(dm, r), false);
  assert.equal(canDecide(chair, r).ok, false); assert.match(canDecide(chair, r).reason!, /outstanding/);
  recordApproval(r, dm2, "decision_maker", "approve", null, "dm2");
  prog = approvalProgress(r); assert.equal(prog.received, 2); assert.equal(prog.satisfied, true);
  assert.equal(canDecide(dm, r).ok, false, "a decision maker holds no decision-step seat"); assert.match(canDecide(dm, r).reason!, /does not decide/);
  assert.equal(canDecide(admin, r).ok, false, "segregation: a platform admin without a seat cannot decide");
  assert.equal(canDecide(chair, r).ok, true);
  assert.equal(canDecide(submitter, r).ok, false);
  assert.equal(canDecide(submitter, r, "withdrawn").ok, true, "a submitter may withdraw their own review");
  assert.equal(canDecide(author, r, "withdrawn").ok, false, "…nobody else may");
});

test("request changes: chair, decision maker and reviewer may; a reviewer's request blocks the decision; a resubmission supersedes everything", () => {
  const r = review();
  assert.equal(canRequestChanges(reviewer, r).ok, true); assert.equal(canRequestChanges(dm, r).ok, true); assert.equal(canRequestChanges(chair, r).ok, true);
  assert.equal(canRequestChanges(observer, r).ok, false); assert.equal(canRequestChanges(secretary, r).ok, false); assert.match(canRequestChanges(secretary, r).reason!, /secretary/);
  assert.equal(canRequestChanges(submitter, r).ok, false); assert.match(canRequestChanges(submitter, r).reason!, /own review/);
  assert.equal(canRequestChanges(daOnly, r).ok, false); assert.equal(canRequestChanges(admin, r).ok, false);
  recordApproval(r, dm, "decision_maker", "approve", null, "dm");
  recordApproval(r, reviewer, "reviewer", "request_changes", "needs work", "reviewer");
  let prog = approvalProgress(r);
  assert.equal(prog.changes_requested, true); assert.equal(prog.satisfied, false); assert.equal(prog.received, 1);
  assert.match(canDecide(chair, r).reason!, /changes were requested/);
  const n = supersedeApprovals(r.id); assert.equal(n, 2);
  prog = approvalProgress(r); assert.equal(prog.received, 0); assert.equal(prog.changes_requested, false);
  recordApproval(r, reviewer, "reviewer", "approve", null, "reviewer");
  assert.equal(approvalProgress(r).received, 0, "an approval recorded from a reviewer seat never counts");
  recordApproval(r, dm, "decision_maker", "approve", null, "dm"); recordApproval(r, chair, "chair", "approve", null, "chair");
  assert.equal(approvalProgress(r).satisfied, true, "chair approvals count towards an approvals step that lists chair");
  assert.equal(canDecide(chair, r).ok, true);
  const closed = review("approved");
  assert.equal(canApprove(dm, closed).ok, false); assert.equal(canRequestChanges(reviewer, closed).ok, false); assert.equal(canDecide(chair, closed).ok, false);
});

test("canActOn: a system role acts everywhere, a seat only on its own board, the flag nowhere", () => {
  const r = review();
  assert.equal(canActOn(author, r, "comment").ok, true, "an author comments on any review");
  assert.equal(canActOn(author, r, "pre_review").ok, true);
  assert.equal(canActOn(dm, r, "comment").ok, true); assert.equal(canActOn(reviewer, r, "pre_review").ok, true); assert.equal(canActOn(secretary, r, "comment").ok, true);
  assert.equal(canActOn(observer, r, "comment").ok, false); assert.match(canActOn(observer, r, "comment").reason!, /observer seat does not comment/);
  assert.equal(canActOn(secretary, r, "pre_review").ok, true, "…because that secretary is also an author");
  assert.equal(canActOn(seatOnlySecretary, r, "comment").ok, true); assert.equal(canActOn(seatOnlySecretary, r, "pre_review").ok, false, "a secretary seat alone does not pre-review");
  assert.equal(canActOn(daOnly, r, "comment").ok, false); assert.match(canActOn(daOnly, r, "comment").reason!, /not a member/);
  assert.equal(canActOn(admin, r, "comment").ok, false, "a platform admin never comments");
  assert.equal(canActOn(null, r, "comment").ok, false);
});

// ---------- areas mode ----------
// The Design Authority board of this file runs its design reviews in areas mode: one position per touched area from
// the decision maker owning it (or a delegate), a conditional the chair resolves, and no vote for the chair.
const { resolvePosition } = await import("../src/boards/declare.js");
const { canRecordPosition, recordPosition, recordableAreas, livePositions, declareOutcomes } = await import("../src/boards/workflow.js");
db.prepare("UPDATE boards SET areas_json=? WHERE id='b-da'").run(JSON.stringify(["security", "data", "infrastructure", "cost"]));
db.prepare("INSERT INTO approval_policies(board_id,review_type,policy_json) VALUES (?,?,?)").run("b-da", "design", JSON.stringify({ steps: [{ kind: "pre_review" }, { name: "Positions by area", kind: "approvals", mode: "areas" }, { name: "Chair declares", kind: "decision", roles: ["chair"] }] }));
const daChair = user("da.chair", "author", false, [["b-da", "chair"]]);
const dmA = user("dm.a", null, false, [["b-da", "decision_maker"]]); setMembership("b-da", "dm.a", "decision_maker", ["security", "data"]);
const dmB = user("dm.b", null, false, [["b-da", "decision_maker"]]); setMembership("b-da", "dm.b", "decision_maker", ["security"]);
const dmC = user("dm.c", null, false, [["b-da", "decision_maker"]]); setMembership("b-da", "dm.c", "decision_maker", ["infrastructure", "cost"]);
const daReviewer = user("da.rev", "author", false, [["b-da", "reviewer"]]);
const daSubmitter = user("da.sub", "author", false, [["b-da", "decision_maker"]]); setMembership("b-da", "da.sub", "decision_maker", ["cost"]);
const daReview = (areas: string[], stage = "in_review") => { const id = uid(); db.prepare("INSERT INTO reviews(id,code,title,risk_tier,stage,submitted_by,created_at,updated_at,type,target_kind,target_id,board_id,areas_json,areas_derived_json,areas_origin) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id, `REV-A${id.slice(0, 5)}`, "t", "medium", stage, "da.sub", now, now, "design", "application", "app-1", "b-da", JSON.stringify(areas), JSON.stringify(areas), "derived"); return db.prepare("SELECT * FROM reviews WHERE id=?").get(id) as any; };
const rec = (r: any, p: any, area: string, position: any, text: string | null = null) => { const chk = canRecordPosition(p, r, area); assert.equal(chk.ok, true, `${p.id} on ${area}: ${chk.reason}`); return recordPosition(r, p, chk, area, position, text, p.id); };
const areaState = (r: any, area: string) => approvalProgress(r).areas.find((a) => a.area === area)!;
const positionsOfCount = (id: string) => (db.prepare("SELECT count(*) c FROM review_positions WHERE review_id=?").get(id) as any).c as number;

test("areas mode: progress per touched area; precedence no > conditional > resolved/yes > not_my_area > missing; the chair resolves", async () => {
  const r = daReview(["security", "data", "infrastructure", "cost"]);
  let prog = approvalProgress(r);
  assert.equal(prog.mode, "areas"); assert.equal(prog.required, 4); assert.equal(prog.received, 0); assert.equal(prog.satisfied, false);
  assert.deepEqual(prog.areas.map((a) => a.state), ["missing", "missing", "missing", "missing"]);
  assert.deepEqual(prog.areas.map((a) => a.label), ["Security", "Data", "Infrastructure", "Cost"]);
  assert.ok(areaState(r, "security").owners.includes("dm.a") && areaState(r, "security").owners.includes("dm.b"), "owners are the decision makers holding the area");
  assert.ok(prog.outstanding.every((o) => "area" in o && o.owners.length > 0), "outstanding lists missing areas with their owners");
  // a wrongly derived area is dropped with a reason
  rec(r, dmC, "cost", "not_my_area", "cost is not touched by this design");
  prog = approvalProgress(r); assert.equal(prog.required, 3); assert.equal(areaState(r, "cost").state, "not_my_area");
  rec(r, dmA, "data", "yes"); rec(r, dmC, "infrastructure", "yes");
  prog = approvalProgress(r); assert.equal(prog.received, 2); assert.equal(prog.satisfied, false); assert.deepEqual(prog.outstanding.map((o: any) => o.area), ["security"]);
  // conditional beats a co-owner's yes
  rec(r, dmB, "security", "yes"); rec(r, dmA, "security", "conditional", "needs a key-management decision");
  prog = approvalProgress(r);
  assert.equal(areaState(r, "security").state, "conditional"); assert.equal(areaState(r, "security").by, "dm.a"); assert.equal(prog.open_conditionals, 1); assert.equal(prog.satisfied, false); assert.equal(prog.received, 2);
  assert.match(canDecide(daChair, r, "approved").reason!, /conditional unresolved: Security/);
  // no beats the conditional and blocks
  rec(r, dmB, "security", "no", "not like this");
  prog = approvalProgress(r); assert.equal(areaState(r, "security").state, "no"); assert.equal(prog.blocked, true); assert.equal(prog.changes_requested, true);
  assert.match(canDecide(daChair, r, "approved").reason!, /changes were requested/);
  // the same user flipping back supersedes their own no; the conditional is live again
  rec(r, dmB, "security", "yes");
  assert.equal(areaState(r, "security").state, "conditional"); assert.equal(livePositions(r.id).filter((p) => p.user_id === "dm.b").length, 1, "one live position per user and area");
  assert.equal(positionsOfCount(r.id), 7, "positions are superseded, never deleted");
  // the chair resolves it as addressed: resolved counts as received
  const pos = livePositions(r.id).find((p) => p.area === "security" && p.position === "conditional")!;
  await resolvePosition(r, pos, { resolution: "addressed", text: "Key management is covered by ADR-0001; confirmed in discussion." }, daChair, "da.chair");
  prog = approvalProgress(r);
  assert.equal(areaState(r, "security").state, "resolved"); assert.equal(areaState(r, "security").resolution, "addressed"); assert.equal(prog.open_conditionals, 0); assert.equal(prog.received, 3); assert.equal(prog.satisfied, true); assert.equal(prog.ready, true);
  assert.equal(canDecide(daChair, r, "approved").ok, true);
  const step = prog.steps.find((s) => s.kind === "approvals")!; assert.equal(step.mode, "areas"); assert.equal(step.received, 3); assert.equal(step.satisfied, true); assert.deepEqual([...step.approvers].sort(), ["dm.a", "dm.c"]);
  assert.ok(db.prepare("SELECT 1 FROM review_events WHERE review_id=? AND kind='position_resolved'").get(r.id), "a resolution is on the timeline");
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE entity_id=? AND action='position:resolve'").get(r.id));
});
test("areas mode: owners and delegates record; the chair has no vote; the reviewer is advisory; the submitter never; awaiting follows", () => {
  const r = daReview(["security", "data"]);
  assert.equal(canRecordPosition(dmA, r, "security").ok, true); assert.equal(canRecordPosition(dmA, r, "data").ok, true);
  const none = canRecordPosition(dmC, r, "security"); assert.equal(none.ok, false); assert.match(none.reason!, /own none of the areas/); assert.match(none.reason!, /Security: /, "…and the reason says who owns them");
  const other = canRecordPosition(dmB, r, "data"); assert.equal(other.ok, false); assert.match(other.reason!, /do not own Data/);
  const ch = canRecordPosition(daChair, r, "security"); assert.equal(ch.ok, false); assert.match(ch.reason!, /chair has no vote/);
  const rv = canRecordPosition(daReviewer, r, "security"); assert.equal(rv.ok, false); assert.match(rv.reason!, /advisory/);
  assert.match(canRecordPosition(daSubmitter, { ...r, areas_json: JSON.stringify(["cost"]) }, "cost").reason!, /own review/, "the submitter owns cost but it is their item");
  assert.match(canRecordPosition(admin, r, "security").reason!, /not a member/);
  assert.match(canRecordPosition(author, r, "security").reason!, /not a member/);
  assert.match(canRecordPosition(dmA, r, "cost").reason!, /does not touch/);
  assert.match(canRecordPosition(dmA, r, null).reason!, /area is required/);
  assert.deepEqual(recordableAreas(dmA, r).map((x) => x.area), ["security", "data"]); assert.deepEqual(recordableAreas(daChair, r), []);
  assert.equal(canApprove(daChair, r).ok, false);
  // the advisory seat still sends an item back: a no held on no area, which blocks like any no and never counts as an approval
  const adv = canRequestChanges(daReviewer, r); assert.equal(adv.ok, true); assert.equal(adv.area, null); assert.equal(adv.role, "reviewer");
  assert.equal(canRequestChanges(daChair, r).ok, false, "the chair declares changes requested instead of voting");
  assert.equal(canRequestChanges(dmA, r).area, "security", "an owner's send-back names the first area they own");
  const cr = { ...daReview(["security"]), stage: "changes_requested" };
  assert.match(canRecordPosition(dmA, cr, "security").reason!, /resubmit/, "no fresh positions after changes were requested");
  assert.match(canRecordPosition(dmA, { ...r, stage: "approved" }, "security").reason!, /review is approved/);
  // awaiting: an owner without a live position; the chair once the item is ready
  assert.equal(awaitingMe(dmA, r), true); assert.equal(awaitingMe(dmC, r), false); assert.equal(awaitingMe(daChair, r), false); assert.equal(awaitingMe(daReviewer, r), false); assert.equal(awaitingMe(admin, r), false);
  rec(r, dmA, "security", "yes"); rec(r, dmA, "data", "yes");
  assert.equal(awaitingMe(dmA, r), false); assert.equal(awaitingMe(dmB, r), true, "a co-owner without their own position is still awaited"); assert.equal(awaitingMe(daChair, r), true, "ready: the chair is awaited");
  rec(r, dmB, "security", "conditional", "pending the DPIA");
  assert.equal(awaitingMe(daChair, r), true, "an open conditional awaits the chair");
  // a reviewer's send-back: held on no area, it blocks the item and is reported as an advisory objection; the owners' positions stand
  const r2 = daReview(["security"]); rec(r2, dmA, "security", "yes");
  assert.equal(approvalProgress(r2).ready, true);
  recordPosition(r2, daReviewer, canRequestChanges(daReviewer, r2), null, "no", "name the data store", daReviewer.id);
  const pr = approvalProgress(r2);
  assert.equal(pr.blocked, true); assert.equal(pr.satisfied, false); assert.equal(pr.received, 1);
  assert.deepEqual(pr.advisory_objections.map((o) => [o.by, o.board_role, o.text]), [[daReviewer.id, "reviewer", "name the data store"]]);
  assert.equal(canDecide(daChair, r2, "approved").ok, false);
});

test("canDecide per outcome: send-back, defer, refer, reject need the seat; approvals need the positions; circulation needs an open session; withdraw is the submitter's", () => {
  const r = daReview(["security"]);
  for (const o of ["changes_requested", "deferred", "referred", "rejected"]) assert.equal(canDecide(daChair, r, o).ok, true, o);
  assert.equal(canDecide(daChair, r, "approved").ok, false); assert.match(canDecide(daChair, r, "approved").reason!, /positions outstanding: Security \(dm\.a\/dm\.b\)/);
  assert.equal(canDecide(daChair, r, "approved_with_conditions").ok, false);
  const circ = canDecide(daChair, r, "approved_subject_to_circulation"); assert.equal(circ.ok, false); assert.match(circ.reason!, /open session/);
  assert.equal(canDecide(dmA, r, "rejected").ok, false); assert.match(canDecide(dmA, r, "rejected").reason!, /does not decide/);
  assert.equal(canDecide(daSubmitter, r, "withdrawn").ok, true); assert.equal(canDecide(dmA, r, "withdrawn").ok, false); assert.equal(canDecide(daSubmitter, r, "rejected").ok, false);
  assert.equal(canDecide(admin, r, "rejected").ok, false, "segregation: the platform admin declares nothing");
  assert.deepEqual(declareOutcomes(daChair, r), ["changes_requested", "deferred", "referred", "rejected"]);
  assert.deepEqual(declareOutcomes(daSubmitter, r), ["withdrawn"]);
  assert.deepEqual(declareOutcomes(dmA, r), []);
  rec(r, dmA, "security", "yes");
  assert.deepEqual(declareOutcomes(daChair, r), ["approved", "approved_with_conditions", "changes_requested", "deferred", "referred", "rejected"]);
  // after changes were requested the chair may still send back / defer / refer / reject, never approve
  const cr = { ...r, stage: "changes_requested" };
  assert.equal(canDecide(daChair, cr, "rejected").ok, true); assert.match(canDecide(daChair, cr, "approved").reason!, /resubmit/);
  // a chair who authored the item never decides it
  assert.match(canDecide(daChair, { ...r, submitted_by: "da.chair" }, "rejected").reason!, /cannot decide their own review/);
  // count mode is untouched: the PCB chair decides once the count is met
  const pr = review(); recordApproval(pr, dm, "decision_maker", "approve", null, "dm"); recordApproval(pr, dm2, "decision_maker", "approve", null, "dm2");
  assert.equal(approvalProgress(pr).mode, "count"); assert.equal(canDecide(chair, pr, "approved").ok, true); assert.equal(canDecide(chair, pr, "approved_subject_to_circulation").ok, false);
  assert.equal(canRecordPosition(chair, pr, null).ok, true, "in count mode the chair's approval counts when the policy lists it");
});
