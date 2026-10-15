import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "archigov-auth-"));
delete process.env.AUTH_MODE;
const { db, migrate, nowIso } = await import("../src/db.js");
await migrate();
const { Hono } = await import("hono");
const { signToken, verifyToken, SESSION_COOKIE } = await import("../src/auth/session.js");
const { capabilityFor, routeCapabilities, capabilitiesFor, canMap, resolveRoleName, legacyRolesOf, normaliseBoardRole, CAPABILITIES, BOARD_ROLES, APPROVING_ROLES, DECIDING_ROLES } = await import("../src/auth/roles.js");
const { authMiddleware } = await import("../src/auth/middleware.js");
const { mapClaims, mapRoleValues, profileFromGrants } = await import("../src/auth/entra.js");
const { actorOf, roleOf } = await import("../src/http.js");
const { ensureUser, upsertUser, setMembership, getUser } = await import("../src/auth/users.js");

db.prepare("INSERT INTO boards(id,code,name,purpose,created_at) VALUES (?,?,?,?,?)").run("b-da", "DA", "Design Authority", "", nowIso());
const DA = { id: "b-da", code: "DA", name: "Design Authority" };
type Cap = (typeof CAPABILITIES)[number];

test("session tokens: round-trip, tamper-evident, expiring", () => {
  const t = signToken({ id: "alice", mode: "local", exp: Math.floor(Date.now() / 1000) + 60 });
  assert.equal(verifyToken<any>(t)?.id, "alice");
  const [body, mac] = t.split(".");
  assert.equal(verifyToken(`${body}x.${mac}`), null, "payload change must invalidate");
  assert.equal(verifyToken(`${body}.${mac.slice(0, -2)}zz`), null, "mac change must invalidate");
  assert.equal(verifyToken(signToken({ id: "old", exp: Math.floor(Date.now() / 1000) - 1 })), null, "expired");
  assert.equal(verifyToken(""), null); assert.equal(verifyToken("garbage"), null);
});

test("capability matrix: every role × every capability", () => {
  const caps = (user_type: any, is_platform_admin = false, boards: any[] = []) => capabilitiesFor({ user_type, is_platform_admin, boards });
  const seat = (role: string) => caps(null, false, [{ ...DA, role }]);
  // the contract: who holds what. Everything not listed is denied.
  const EXPECTED: Record<string, Cap[]> = {
    "no role": ["read"],
    author: ["read", "export_evidence", "submit_review", "comment", "resubmit", "manage_artefacts", "create_decision", "pre_review", "verify", "import_artefacts", "log_change"],
    auditor: ["read", "export_evidence"],
    service: ["read"],
    "platform admin": ["read", "export_evidence", "manage_platform", "import_artefacts"],
    chair: ["read", "export_evidence", "decide_review", "approve_review", "request_changes", "comment", "pre_review", "manage_board", "grant_exception", "resolve_finding", "close_condition", "set_decision_status"],
    decision_maker: ["read", "export_evidence", "approve_review", "request_changes", "comment", "pre_review"],
    reviewer: ["read", "export_evidence", "comment", "pre_review", "request_changes"],
    secretary: ["read", "export_evidence", "comment", "manage_board"],
    observer: ["read", "export_evidence"],
  };
  const HAVE: Record<string, Set<Cap>> = {
    "no role": caps(null), author: caps("author"), auditor: caps("auditor"), service: caps("service"), "platform admin": caps(null, true),
    ...Object.fromEntries(BOARD_ROLES.map((r) => [r, seat(r)])),
  };
  assert.deepEqual(Object.keys(HAVE).sort(), Object.keys(EXPECTED).sort(), "every role is in the table");
  for (const who of Object.keys(EXPECTED)) for (const cap of CAPABILITIES) assert.equal(HAVE[who].has(cap), EXPECTED[who].includes(cap), `${who} × ${cap}`);
  // combinations add up; the flag is operations only
  const adminAuthor = caps("author", true);
  assert.ok(adminAuthor.has("manage_platform") && adminAuthor.has("submit_review") && !adminAuthor.has("approve_review") && !adminAuthor.has("decide_review"), "the admin flag never grants approval or decision rights");
  const chairAuthor = caps("author", false, [{ ...DA, role: "chair" }]);
  for (const c of CAPABILITIES) assert.equal(chairAuthor.has(c), c !== "manage_platform", `author + chair: ${c}`);
  assert.ok(caps(null, false, [{ ...DA, role: "observer" }, { id: "b-x", code: "X", name: "X", role: "chair" }]).has("decide_review"), "seats on several boards add up");
  assert.deepEqual(APPROVING_ROLES, ["chair", "decision_maker"]); assert.deepEqual(DECIDING_ROLES, ["chair"]);
  assert.equal(Object.keys(canMap(null)).length, CAPABILITIES.length); assert.equal(canMap(null).read, false, "nobody signed in holds nothing");
  assert.deepEqual([...caps("nonsense" as any)], ["read"], "an unknown stored type counts as none");
});

test("role names: user types, platform_admin, <BOARD>:<seat>, legacy aliases, dotted suffixes", () => {
  assert.deepEqual(resolveRoleName("author"), { user_type: "author" });
  assert.deepEqual(resolveRoleName("Platform_Admin"), { is_platform_admin: true });
  assert.deepEqual(resolveRoleName("PCB:chair"), { board: { code: "PCB", role: "chair" } });
  assert.deepEqual(resolveRoleName("board/pcb/decision_maker"), { board: { code: "PCB", role: "decision_maker" } });
  assert.deepEqual(resolveRoleName("DA:member"), { board: { code: "DA", role: "decision_maker" } }, "member is the old name of the decision-maker seat");
  assert.deepEqual(resolveRoleName("DA:Decision-Maker"), { board: { code: "DA", role: "decision_maker" } });
  assert.deepEqual(resolveRoleName("arb.chair"), { user_type: "author", board: { code: "DA", role: "chair" } }, "dotted values keep the legacy suffix meaning");
  assert.deepEqual(resolveRoleName("admin"), { is_platform_admin: true }, "admin is the operations flag alone, no system role");
  assert.deepEqual(resolveRoleName("chair"), { user_type: "author", board: { code: "DA", role: "chair" } });
  assert.deepEqual(resolveRoleName("reviewer"), { user_type: "author", board: { code: "DA", role: "reviewer" } });
  for (const n of ["submitter", "engineer", "architect"]) assert.deepEqual(resolveRoleName(n), { user_type: "author" }, n);
  assert.deepEqual(resolveRoleName("board_member"), { board: { code: "DA", role: "decision_maker" } }, "a board member has no system role");
  assert.deepEqual(resolveRoleName("archigov.auditor"), { user_type: "auditor" });
  assert.equal(resolveRoleName("nonsense"), null); assert.equal(resolveRoleName("DA:nonsense"), null);
  assert.equal(normaliseBoardRole("member"), "decision_maker"); assert.equal(normaliseBoardRole("Observer"), "observer"); assert.equal(normaliseBoardRole("x"), null);
  assert.deepEqual(legacyRolesOf({ user_type: "author", is_platform_admin: true, boards: [{ ...DA, role: "chair" }] }).sort(), ["admin", "chair"]);
  assert.deepEqual(legacyRolesOf({ user_type: "author", is_platform_admin: false, boards: [{ ...DA, role: "reviewer" }] }), ["reviewer"]);
  assert.deepEqual(legacyRolesOf({ user_type: "author", is_platform_admin: false, boards: [] }), ["submitter"]);
  assert.deepEqual(legacyRolesOf({ user_type: null, is_platform_admin: true, boards: [] }), ["admin"]);
  assert.deepEqual(legacyRolesOf({ user_type: null, is_platform_admin: false, boards: [{ ...DA, role: "decision_maker" }] }), []);
});

test("capability map: routes, any-of rules, defaults and exemptions", () => {
  assert.equal(capabilityFor("GET", "/applications"), "read");
  assert.equal(capabilityFor("GET", "/evidence-pack/verify"), "export_evidence");
  assert.equal(capabilityFor("POST", "/reviews"), "submit_review");
  assert.equal(capabilityFor("POST", "/reviews/abc/comment"), "comment");
  assert.equal(capabilityFor("POST", "/reviews/abc/resubmit"), "resubmit");
  assert.deepEqual(routeCapabilities("POST", "/reviews/abc/approvals"), ["approve_review", "request_changes"]);
  assert.deepEqual(routeCapabilities("POST", "/reviews/abc/decide"), ["decide_review", "submit_review"]);
  assert.equal(capabilityFor("POST", "/reviews/abc/decide"), "decide_review", "a refusal names the first capability");
  assert.equal(capabilityFor("POST", "/artefacts"), "manage_artefacts");
  assert.equal(capabilityFor("POST", "/artefacts/packs/core/import"), "import_artefacts");
  assert.equal(capabilityFor("POST", "/import/csv"), "import_artefacts");
  assert.equal(capabilityFor("POST", "/boards"), "manage_platform"); assert.equal(capabilityFor("PUT", "/boards/x"), "manage_platform");
  assert.deepEqual(routeCapabilities("POST", "/boards/x/members"), ["manage_board", "manage_platform"]);
  assert.deepEqual(routeCapabilities("DELETE", "/boards/x/members/u"), ["manage_board", "manage_platform"]);
  assert.deepEqual(routeCapabilities("PUT", "/boards/x/policies/design"), ["manage_board", "manage_platform"]);
  assert.deepEqual(routeCapabilities("PUT", "/boards/x/routing"), ["manage_board", "manage_platform"]);
  assert.deepEqual(routeCapabilities("POST", "/evaluate"), ["pre_review", "manage_platform"]);
  assert.equal(capabilityFor("PUT", "/users/x"), "manage_platform");
  assert.equal(capabilityFor("POST", "/sources/demo/load"), "manage_platform");
  assert.equal(capabilityFor("POST", "/findings/x/resolve"), "resolve_finding"); assert.equal(capabilityFor("POST", "/exceptions"), "grant_exception");
  assert.equal(capabilityFor("POST", "/some/new/route"), "manage_platform", "unknown mutations are closed by default");
  assert.equal(capabilityFor("GET", "/health"), "exempt"); assert.equal(capabilityFor("POST", "/auth/local"), "exempt"); assert.equal(capabilityFor("POST", "/hooks/ado"), "exempt");
});

const app = new Hono();
app.use("*", authMiddleware);
app.get("/applications", (c) => c.json({ actor: actorOf(c), role: roleOf() }));
app.post("/reviews", (c) => c.json({ actor: actorOf(c) }));
app.post("/reviews/:id/approvals", (c) => c.json({ ok: true }));
app.post("/reviews/:id/decide", (c) => c.json({ decided: true }));
app.post("/sources/demo/load", (c) => c.json({ ok: true }));
app.post("/evaluate", (c) => c.json({ ok: true }));
app.get("/health", (c) => c.json({ ok: true }));
const cookie = (payload: Record<string, unknown>) => ({ cookie: `${SESSION_COOKIE}=${signToken({ exp: Math.floor(Date.now() / 1000) + 60, ...payload })}` });

test("local mode: an unknown x-user is a platform admin only; stored types and seats are enforced; sessions win", async () => {
  delete process.env.AUTH_MODE;
  let r = await app.request("/applications", { headers: { "x-user": "alice" } });
  assert.equal(r.status, 200); assert.deepEqual(await r.json(), { actor: "alice", role: null });
  assert.deepEqual({ t: getUser("alice")?.user_type, a: getUser("alice")?.is_platform_admin }, { t: null, a: true }, "created lazily as platform admin, no system role");
  r = await app.request("/sources/demo/load", { method: "POST", headers: { "x-user": "alice" } }); assert.equal(r.status, 200, "bootstrap users run the platform");
  r = await app.request("/evaluate", { method: "POST", headers: { "x-user": "alice" } }); assert.equal(r.status, 200, "…and may re-run the engine");
  r = await app.request("/reviews", { method: "POST", headers: { "x-user": "alice" } });
  assert.equal(r.status, 403); let body = await r.json(); assert.equal(body.capability, "submit_review"); assert.equal(body.user_type, null); assert.equal(body.is_platform_admin, true);
  r = await app.request("/reviews/x/approvals", { method: "POST", headers: { "x-user": "alice" } }); assert.equal(r.status, 403); assert.equal((await r.json()).capability, "approve_review", "an any-of refusal names the first capability");
  r = await app.request("/reviews/x/decide", { method: "POST", headers: { "x-user": "alice" } }); assert.equal(r.status, 403, "…and never decides");
  upsertUser("alice", { user_type: "auditor", is_platform_admin: false });
  r = await app.request("/reviews", { method: "POST", headers: { "x-user": "alice" } });
  assert.equal(r.status, 403); body = await r.json(); assert.equal(body.capability, "submit_review"); assert.equal(body.user_type, "auditor");
  r = await app.request("/evaluate", { method: "POST", headers: { "x-user": "alice" } }); assert.equal(r.status, 403, "an auditor changes nothing");
  upsertUser("alice", { user_type: "author" });
  r = await app.request("/reviews", { method: "POST", headers: { "x-user": "alice" } }); assert.equal(r.status, 200, "an author submits");
  r = await app.request("/reviews/x/approvals", { method: "POST", headers: { "x-user": "alice" } }); assert.equal(r.status, 403, "…but holds no seat");
  ensureUser("carol", { name: "Carol", user_type: null, is_platform_admin: false }); setMembership("b-da", "carol", "chair");
  r = await app.request("/reviews/x/decide", { method: "POST", headers: { ...cookie({ id: "carol", mode: "local" }), "x-user": "alice" } });
  assert.equal(r.status, 200, "a chair's session decides even when the header says someone else");
  r = await app.request("/applications", { headers: cookie({ id: "dave", name: "Dave", mode: "local" }) });
  assert.equal(r.status, 200); assert.deepEqual({ t: getUser("dave")?.user_type, a: getUser("dave")?.is_platform_admin }, { t: null, a: true }, "a session for an unknown local user bootstraps the same way");
});

test("entra mode: no session → 401 with login_url, x-user ignored, local sessions not accepted, entra sessions are", async () => {
  process.env.AUTH_MODE = "entra";
  try {
    let r = await app.request("/applications", { headers: { "x-user": "alice" } });
    assert.equal(r.status, 401); assert.deepEqual(await r.json(), { error: "sign_in_required", login_url: "/api/auth/login" });
    r = await app.request("/health"); assert.equal(r.status, 200, "exempt routes still answer");
    r = await app.request("/applications", { headers: cookie({ id: "alice", mode: "local" }) });
    assert.equal(r.status, 401, "a local-mode session is not valid in entra mode");
    ensureUser("tid-1:oid-1", { name: "Dee", email: "dee@example.org", user_type: "author", is_platform_admin: false });
    r = await app.request("/applications", { headers: cookie({ id: "tid-1:oid-1", mode: "entra" }) });
    assert.equal(r.status, 200); assert.deepEqual(await r.json(), { actor: "tid-1:oid-1", role: "author" }, "the actor is the stable id, never the unverified email");
    r = await app.request("/reviews/x/approvals", { method: "POST", headers: cookie({ id: "tid-1:oid-1", mode: "entra" }) });
    assert.equal(r.status, 403, "an author without a seat does not approve");
    r = await app.request("/applications", { headers: cookie({ id: "tid-9:oid-9", mode: "entra" }) });
    assert.equal(r.status, 401, "an entra session for an unknown user is nobody");
  } finally { delete process.env.AUTH_MODE; }
});

test("entra claims: issuer/tenant/nonce checks, tid:oid identity, app-role values → type, flag and seat grants", () => {
  process.env.ENTRA_TENANT_ID = "11111111-2222-3333-4444-555555555555";
  const base = { iss: "https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0", tid: "11111111-2222-3333-4444-555555555555", oid: "a1b2c3d4-0000-4e5f-8a9b-000000000002", sub: "pairwise-sub", name: "Eve", preferred_username: "eve@contoso.com", email: "eve@contoso.com", nonce: "n1" };
  const u = mapClaims({ ...base, roles: ["board_member", "PCB:chair", "not-a-role"] }, "n1");
  assert.equal(u.id, `${base.tid}:${base.oid}`); assert.equal(u.user_type, null, "seats alone give no system role"); assert.equal(u.is_platform_admin, false);
  assert.deepEqual(u.grants, [{ board: { code: "DA", role: "decision_maker" } }, { board: { code: "PCB", role: "chair" } }]);
  const adm = mapClaims({ ...base, roles: ["platform_admin", "author"] }, "n1");
  assert.equal(adm.is_platform_admin, true); assert.equal(adm.user_type, "author");
  assert.equal(mapClaims({ ...base, roles: ["platform_admin"] }, "n1").user_type, null, "platform_admin alone is not an author");
  assert.equal(mapClaims({ ...base }, "n1").user_type, null, "no recognised type → no system role (read only)");
  process.env.ENTRA_DEFAULT_ROLE = "auditor"; assert.equal(mapClaims({ ...base }, "n1").user_type, "auditor"); delete process.env.ENTRA_DEFAULT_ROLE;
  assert.throws(() => mapClaims({ ...base }, "other-nonce"), /nonce/);
  assert.throws(() => mapClaims({ ...base, tid: "99999999-2222-3333-4444-555555555555", iss: "https://login.microsoftonline.com/99999999-2222-3333-4444-555555555555/v2.0" }, "n1"), /tenant/);
  assert.throws(() => mapClaims({ ...base, iss: "https://evil.example/v2.0" }, "n1"), /issuer/);
  assert.throws(() => mapClaims({ ...base, oid: undefined }, "n1"), /oid/);
  // legacy app-role values still work, de-duplicated, mapped through ENTRA_ROLE_MAP; a dotted value keeps the legacy-suffix meaning
  assert.deepEqual(mapRoleValues(["arb.chair", "Archigov.Reviewer", "reviewer", "something-else"]), [{ user_type: "author", board: { code: "DA", role: "chair" } }, { user_type: "author", board: { code: "DA", role: "reviewer" } }]);
  assert.deepEqual(mapRoleValues(["board/PCB/member"]), [{ board: { code: "PCB", role: "decision_maker" } }]);
  process.env.ENTRA_ROLE_MAP = "arb.chair=chair, platform.owner = platform_admin";
  assert.deepEqual(profileFromGrants(mapRoleValues(["platform.owner", "engineer"])), { user_type: "author", is_platform_admin: true });
  delete process.env.ENTRA_ROLE_MAP;
  assert.deepEqual(mapRoleValues(undefined), []);
  delete process.env.ENTRA_TENANT_ID;
});
