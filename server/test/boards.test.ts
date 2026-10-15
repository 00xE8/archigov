import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Boards and users through the HTTP layer: who runs a board (platform admin, chair, secretary), membership,
// policies, routing lookup, the demo cast and the legacy role settings.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "archigov-boards-"));
delete process.env.AUTH_MODE;
const { db, migrate, setSetting } = await import("../src/db.js");
await migrate();
const { Hono } = await import("hono");
const { ZodError } = await import("zod");
const { authMiddleware } = await import("../src/auth/middleware.js");
const { boards } = await import("../src/routes/boards.js");
const { users } = await import("../src/routes/users.js");
const { seedBoards } = await import("../src/boards/seed.js");
const { migrateLegacyRoles, getUser, upsertUser, membershipsOf } = await import("../src/auth/users.js");

setSetting("demo.loaded", "test");
const seeded = seedBoards("test");
assert.deepEqual(seeded.boards, ["DA", "PCB"]);

const app = new Hono();
app.use("*", authMiddleware);
app.route("/", users); app.route("/", boards);
// as index.ts: a body that fails validation is the caller's problem
app.onError((err, c) => err instanceof ZodError ? c.json({ error: "invalid_request", issues: err.issues }, 400) : c.json({ error: err.message }, 500));
const as = (user: string) => ({ "x-user": user, "content-type": "application/json" });
const call = async (method: string, p: string, user: string, body?: any) => { const r = await app.request(p, { method, headers: as(user), body: body !== undefined ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
const OLD_NAMES = /"(architect|engineer|board_member|submitter)"|"board_role":"member"|"role":"member"/;

test("seed: boards, the demo cast, policies and routing exist in the new vocabulary and are idempotent", async () => {
  const again = seedBoards("test"); assert.equal(again.reviews_routed, 0); assert.equal(again.demo_cast_asserted, undefined, "the cast is asserted once");
  const { status, body } = await call("GET", "/boards", "ops.admin");
  assert.equal(status, 200); assert.deepEqual(body.map((b: any) => b.code), ["DA", "PCB"]);
  const da = (await call("GET", "/boards/DA", "j.duduka")).body;
  const daRoles = Object.fromEntries(da.members.map((m: any) => [m.user_id, m.board_role]));
  assert.deepEqual(daRoles, { "j.duduka": "chair", "m.hughes": "decision_maker", "p.osei": "decision_maker", "s.patel": "reviewer", "a.okafor": "secretary" });
  // the Design Authority runs in areas mode: eight areas, split between its two decision makers, no vote for the chair
  assert.deepEqual(da.areas.map((a: any) => a.id), ["security", "data", "integration", "infrastructure", "resilience", "cost", "compliance", "ai"]);
  const areasOf = Object.fromEntries(da.members.map((m: any) => [m.user_id, m.areas]));
  assert.deepEqual(areasOf["m.hughes"], ["security", "data", "compliance", "ai"]); assert.deepEqual(areasOf["p.osei"], ["integration", "infrastructure", "resilience", "cost"]); assert.deepEqual(areasOf["j.duduka"], []);
  assert.ok(da.area_coverage.every((c: any) => c.owners.length === 1), "every DA area has exactly one owner");
  const daStep = da.policies.design.steps.find((s: any) => s.kind === "approvals"); assert.equal(daStep.mode, "areas"); assert.deepEqual(daStep.roles, ["decision_maker"]); assert.equal(daStep.min, undefined);
  for (const t of ["decision", "standard", "pattern"]) assert.equal(da.policies[t].steps.find((s: any) => s.kind === "approvals").mode, "areas", t);
  assert.ok(da.policies.design.steps.some((s: any) => s.kind === "decision"));
  assert.ok(da.routing.some((r: any) => r.review_type === "design"));
  assert.equal(da.can_manage, true, "the chair manages their board"); assert.deepEqual(da.can, { members: true, routing: true, policies: true, areas: true, sessions: true });
  assert.equal(da.sessions_planned, 1, "one planned sitting is seeded"); assert.equal(da.sessions[0].code, "SES-0001");
  const pcb = (await call("GET", "/boards/PCB", "m.hughes")).body;
  assert.equal(pcb.can_manage, false, "a decision maker does not"); assert.equal(pcb.can.sessions, false);
  const pcbRoles = Object.fromEntries(pcb.members.map((m: any) => [m.user_id, m.board_role]));
  assert.deepEqual(pcbRoles, { "r.khan": "chair", "j.duduka": "decision_maker", "m.hughes": "decision_maker" });
  assert.deepEqual(pcb.areas, [], "the PCB has no areas: count mode");
  const step = pcb.policies.policy.steps.find((s: any) => s.kind === "approvals"); assert.equal(step.min, 2); assert.equal(step.mode, "count"); assert.deepEqual(step.roles, ["chair", "decision_maker"]);
  const all = (await call("GET", "/users", "ops.admin")).body; const byId = Object.fromEntries(all.map((u: any) => [u.id, u]));
  assert.deepEqual({ t: byId["j.duduka"].user_type, a: byId["j.duduka"].is_platform_admin }, { t: "author", a: false }, "the DA chair is an author, not a platform admin");
  assert.equal(byId["m.hughes"].user_type, null); assert.equal(byId["r.khan"].user_type, null);
  assert.deepEqual({ t: byId["ops.admin"].user_type, a: byId["ops.admin"].is_platform_admin, b: byId["ops.admin"].boards }, { t: null, a: true, b: [] });
  assert.equal(byId["p.osei"].user_type, null); assert.deepEqual(byId["p.osei"].boards.map((b: any) => [b.code, b.role, b.areas]), [["DA", "decision_maker", ["integration", "infrastructure", "resilience", "cost"]]]);
  assert.equal(byId["svc.ado"].user_type, "service"); assert.equal(byId["a.uditor"].user_type, "auditor");
  for (const id of ["s.patel", "a.okafor", "t.nguyen"]) assert.equal(byId[id].user_type, "author", id);
  assert.ok(!OLD_NAMES.test(JSON.stringify([all, da, pcb])), "no old names leak out of the API");
});

test("seed migrates an existing demo tenant to the new cast once, then leaves edits alone", async () => {
  // an old-shape tenant: the chair carried the admin flag, s.patel held a member seat, the DA ran in count mode without areas
  db.prepare("UPDATE users SET is_platform_admin=1 WHERE id='j.duduka'").run();
  db.prepare("UPDATE board_members SET board_role='decision_maker' WHERE user_id='s.patel'").run();
  db.prepare("UPDATE boards SET areas_json='[]' WHERE code='DA'").run();
  db.prepare("UPDATE approval_policies SET policy_json=? WHERE review_type='design'").run(JSON.stringify({ steps: [{ kind: "approvals", min: 1, roles: ["decision_maker", "chair"] }, { kind: "decision", roles: ["chair"] }] }));
  db.prepare("DELETE FROM settings WHERE key='demo.users_version'").run();
  const r = seedBoards("test"); assert.equal(r.demo_cast_asserted, true);
  assert.equal(getUser("j.duduka")?.is_platform_admin, false);
  assert.equal(membershipsOf("s.patel").find((m) => m.code === "DA")?.role, "reviewer");
  const da = (await call("GET", "/boards/DA", "j.duduka")).body;
  assert.equal(da.areas.length, 8, "the DA's areas are asserted with the cast"); assert.equal(da.policies.design.steps.find((s: any) => s.kind === "approvals").mode, "areas", "…and its policies move to areas mode");
  assert.equal(da.sessions.length, 1, "no second session is seeded while one exists");
  // once at the current version, an admin's change survives the next boot
  upsertUser("t.nguyen", { user_type: "auditor" });
  seedBoards("test");
  assert.equal(getUser("t.nguyen")?.user_type, "auditor");
  upsertUser("t.nguyen", { user_type: "author" });
});

test("route lookup answers which board receives a review", async () => {
  assert.equal((await call("GET", "/boards/route?type=policy", "a.okafor")).body.code, "PCB");
  assert.equal((await call("GET", "/boards/route?type=design", "a.okafor")).body.code, "DA");
  assert.equal((await call("GET", "/boards/route?type=nonsense", "a.okafor")).status, 400);
});

test("membership: platform admin, that board's chair or its secretary; others 403; unknown users 404", async () => {
  let r = await call("POST", "/users", "ops.admin", { id: "new.member", name: "New Member", user_type: null });
  assert.equal(r.status, 200); assert.equal(r.body.user_type, null);
  r = await call("POST", "/users", "r.khan", { id: "nope", name: "Nope" }); assert.equal(r.status, 403, "a chair does not create users"); assert.equal(r.body.capability, "manage_platform");
  const pcbId = (await call("GET", "/boards/PCB", "ops.admin")).body.id, daId = (await call("GET", "/boards/DA", "ops.admin")).body.id;
  r = await call("POST", `/boards/${pcbId}/members`, "m.hughes", { user_id: "new.member", board_role: "decision_maker" });
  assert.equal(r.status, 403, "a decision maker cannot add members"); assert.equal(r.body.capability, "manage_board");
  r = await call("POST", `/boards/${pcbId}/members`, "r.khan", { user_id: "new.member", board_role: "decision_maker" });
  assert.equal(r.status, 200, "the PCB chair can");
  r = await call("POST", `/boards/${pcbId}/members`, "a.okafor", { user_id: "new.member", board_role: "observer" });
  assert.equal(r.status, 403, "the DA secretary holds no seat on the PCB");
  r = await call("POST", `/boards/${daId}/members`, "a.okafor", { user_id: "new.member", board_role: "observer" });
  assert.equal(r.status, 200, "a secretary manages the members of their own board");
  r = await call("POST", `/boards/${pcbId}/members`, "r.khan", { user_id: "ghost", board_role: "decision_maker" }); assert.equal(r.status, 404);
  r = await call("POST", `/boards/${pcbId}/members`, "r.khan", { user_id: "new.member", board_role: "member" }); assert.equal(r.status, 400, "the old seat name is not accepted on the API");
  assert.deepEqual(membershipsOf("new.member").map((m) => [m.code, m.role]), [["DA", "observer"], ["PCB", "decision_maker"]]);
  // areas owned: validated against the board's areas; chair/secretary/admin set them; the PCB has none to give
  r = await call("PUT", `/boards/${daId}/members/new.member`, "m.hughes", { areas: ["cost"] }); assert.equal(r.status, 403);
  r = await call("PUT", `/boards/${daId}/members/new.member`, "a.okafor", { areas: ["cost", "nonsense"] }); assert.equal(r.status, 400); assert.match(r.body.error, /nonsense/);
  r = await call("PUT", `/boards/${daId}/members/new.member`, "a.okafor", { areas: ["cost"] }); assert.equal(r.status, 200); assert.deepEqual(r.body.areas, ["cost"]);
  assert.deepEqual(r.body.area_coverage.find((x: any) => x.area === "cost").owners, ["p.osei"], "an observer's areas are stored but only decision makers count as owners");
  r = await call("PUT", `/boards/${pcbId}/members/new.member`, "r.khan", { areas: ["cost"] }); assert.equal(r.status, 400, "no areas on the PCB");
  r = await call("POST", `/boards/${daId}/members`, "j.duduka", { user_id: "new.member", board_role: "decision_maker", areas: ["cost", "ai"] }); assert.equal(r.status, 200); assert.deepEqual(r.body.areas, ["cost", "ai"]);
  assert.deepEqual(membershipsOf("new.member").find((m) => m.code === "DA")?.areas, ["cost", "ai"]);
  // the board's areas: chair or platform admin; removing one strips it from the members; custom areas need a label
  r = await call("PUT", `/boards/${daId}`, "a.okafor", { areas: ["security"] }); assert.equal(r.status, 403, "a secretary does not set areas"); assert.equal(r.body.capability, "manage_board");
  r = await call("PUT", `/boards/${daId}`, "j.duduka", { name: "x" }); assert.equal(r.status, 403, "a chair does not rename a board");
  r = await call("PUT", `/boards/${daId}`, "j.duduka", { areas: ["security", { id: "Clinical safety" }] }); assert.equal(r.status, 400); assert.match(r.body.error, /label/);
  r = await call("PUT", `/boards/${daId}`, "j.duduka", { areas: ["security", "data", "integration", "infrastructure", "resilience", "compliance", "ai", { id: "Clinical safety", label: "Clinical safety" }] });
  assert.equal(r.status, 200); assert.deepEqual(r.body.areas.map((a: any) => a.id), ["security", "data", "integration", "infrastructure", "resilience", "compliance", "ai", "clinical-safety"]);
  assert.deepEqual(membershipsOf("new.member").find((m) => m.code === "DA")?.areas, ["ai"], "cost was removed from the board, so from the member");
  assert.deepEqual(membershipsOf("p.osei").find((m) => m.code === "DA")?.areas, ["integration", "infrastructure", "resilience"]);
  r = await call("PUT", `/boards/${daId}`, "ops.admin", { areas: ["security", "data", "integration", "infrastructure", "resilience", "cost", "compliance", "ai"] }); assert.equal(r.status, 200, "the platform admin restores them (configuration)");
  r = await call("PUT", `/boards/${daId}/members/p.osei`, "ops.admin", { areas: ["integration", "infrastructure", "resilience", "cost"] }); assert.equal(r.status, 200);
  r = await call("DELETE", `/boards/${pcbId}/members/new.member`, "ops.admin"); assert.equal(r.status, 200, "a platform admin can remove");
  r = await call("DELETE", `/boards/${daId}/members/new.member`, "a.okafor"); assert.equal(r.status, 200);
  assert.equal(membershipsOf("new.member").length, 0);
});

test("policies: platform admin or the chair; the secretary does routing but not policies; validated", async () => {
  const pcbId = (await call("GET", "/boards/PCB", "ops.admin")).body.id, daId = (await call("GET", "/boards/DA", "ops.admin")).body.id;
  const ok = { policy: { steps: [{ name: "One approval", kind: "approvals", min: 1, roles: ["chair", "decision_maker"] }, { name: "Chair", kind: "decision", roles: ["chair"] }] } };
  let r = await call("PUT", `/boards/${pcbId}/policies/policy`, "m.hughes", ok); assert.equal(r.status, 403); assert.equal(r.body.capability, "manage_board");
  r = await call("PUT", `/boards/${pcbId}/policies/policy`, "a.okafor", ok); assert.equal(r.status, 403, "not on the PCB");
  r = await call("PUT", `/boards/${daId}/policies/design`, "a.okafor", ok); assert.equal(r.status, 403, "a secretary does not change policies");
  r = await call("PUT", `/boards/${pcbId}/policies/policy`, "r.khan", ok); assert.equal(r.status, 200, "a chair sets their own board's policy"); assert.equal(r.body.policy.steps[0].min, 1);
  r = await call("PUT", `/boards/${pcbId}/policies/policy`, "ops.admin", { policy: { steps: [{ kind: "approvals", roles: [] }] } }); assert.equal(r.status, 400);
  r = await call("PUT", `/boards/${pcbId}/policies/policy`, "ops.admin", { policy: { steps: [{ kind: "approvals", min: 1, roles: ["reviewer"] }, { kind: "decision", roles: ["chair"] }] } });
  assert.equal(r.status, 400); assert.match(r.body.error, /advisory/);
  r = await call("PUT", `/boards/${pcbId}/policies/policy`, "ops.admin", { policy: { steps: [{ kind: "approvals", min: 1, roles: ["chair"] }, { kind: "decision", roles: ["decision_maker"] }] } });
  assert.equal(r.status, 400); assert.match(r.body.error, /does not decide/);
  r = await call("PUT", `/boards/${pcbId}/policies/policy`, "ops.admin", { policy: { steps: [{ name: "Two", kind: "approvals", min: 2, roles: ["member", "chair"] }, { name: "Chair", kind: "decision", roles: ["chair"] }] } });
  assert.equal(r.status, 200); assert.deepEqual(r.body.policy.steps[0].roles, ["decision_maker", "chair"], "the old seat name is normalised in a policy");
  r = await call("PUT", `/boards/${pcbId}/routing`, "m.hughes", [{ review_type: "policy" }]); assert.equal(r.status, 403);
  r = await call("PUT", `/boards/${pcbId}/routing`, "r.khan", [{ review_type: "policy" }, { review_type: "standard", category: "AI", priority: 10 }]);
  assert.equal(r.status, 200); assert.equal(r.body.routing.length, 2);
  assert.equal((await call("GET", "/boards/route?type=standard&category=AI", "a.okafor")).body.code, "PCB");
  r = await call("PUT", `/boards/${daId}/routing`, "a.okafor", [{ review_type: "design" }, { review_type: "decision" }, { review_type: "standard" }, { review_type: "pattern" }]);
  assert.equal(r.status, 200, "a secretary sets their own board's routing");
  r = await call("POST", "/boards", "r.khan", { code: "SRB", name: "Security Review Board" }); assert.equal(r.status, 403); assert.equal(r.body.capability, "manage_platform");
  r = await call("POST", "/boards", "ops.admin", { code: "srb", name: "Security Review Board" }); assert.equal(r.status, 200); assert.equal(r.body.code, "SRB");
  r = await call("PUT", `/boards/${r.body.id}`, "r.khan", { name: "x" }); assert.equal(r.status, 403);
});

test("legacy role settings migrate into users and DA seats", async () => {
  setSetting("roles.old.chair", "chair"); setSetting("roles.old.auditor", "auditor"); setSetting("roles.old.member", "board_member"); setSetting("roles.old.admin", "admin");
  assert.equal(migrateLegacyRoles(), 4);
  assert.equal(getUser("old.chair")?.user_type, "author");
  assert.ok(membershipsOf("old.chair").some((m) => m.code === "DA" && m.role === "chair"));
  assert.equal(getUser("old.auditor")?.user_type, "auditor");
  assert.equal(getUser("old.member")?.user_type, null); assert.ok(membershipsOf("old.member").some((m) => m.code === "DA" && m.role === "decision_maker"));
  assert.deepEqual({ t: getUser("old.admin")?.user_type, a: getUser("old.admin")?.is_platform_admin }, { t: null, a: true });
  assert.equal(migrateLegacyRoles(), 0, "idempotent");
});
