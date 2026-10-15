import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// m009 on a v8 tenant: approvals become positions (approve → yes, request_changes → no, no area, superseded kept),
// review_approvals is dropped, reviews/conditions/events gain their columns, the session tables exist, and a
// second migrate() is a no-op. seedBoards() then derives areas for every review that has none.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "archigov-m009-"));
delete process.env.AUTH_MODE;
const { db, migrate, nowIso } = await import("../src/db.js");
const { loadMigrations } = await import("../src/migrations/index.js");

db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
for (const m of await loadMigrations()) { if (m.version >= 9) continue; db.exec(m.sql); db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?,?)").run(m.version, nowIso()); }
const now = nowIso();
const ins = db.prepare("INSERT INTO users(id,name,email,user_type,is_platform_admin,created_at,updated_at) VALUES (?,?,?,?,?,?,?)");
ins.run("j.duduka", "Joel Duduka", null, "author", 0, now, now); ins.run("bm", "Board Member", null, null, 0, now, now); ins.run("rv", "Reviewer", null, "author", 0, now, now); ins.run("eng", "Eng", null, "author", 0, now, now);
db.prepare("INSERT INTO boards(id,code,name,purpose,created_at) VALUES (?,?,?,?,?)").run("b-da", "DA", "Design Authority", "", now);
const mem = db.prepare("INSERT INTO board_members(board_id,user_id,board_role,added_at) VALUES (?,?,?,?)");
mem.run("b-da", "bm", "decision_maker", now); mem.run("b-da", "j.duduka", "chair", now); mem.run("b-da", "rv", "reviewer", now);
db.prepare("INSERT INTO approval_policies(board_id,review_type,policy_json) VALUES (?,?,?)").run("b-da", "design", JSON.stringify({ steps: [{ name: "pre", kind: "pre_review" }, { name: "Board approval", kind: "approvals", min: 1, roles: ["decision_maker", "chair"] }, { name: "Chair decision", kind: "decision", roles: ["chair"] }] }));
const rev = db.prepare("INSERT INTO reviews(id,code,title,risk_tier,stage,submitted_by,created_at,updated_at,type,target_kind,target_id,board_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
rev.run("r1", "REV-0001", "in flight", "medium", "in_review", "eng", now, now, "design", "application", "app-1", "b-da");
rev.run("r2", "REV-0002", "decided", "medium", "approved_with_conditions", "eng", now, now, "design", "application", "app-1", "b-da");
const app = db.prepare("INSERT INTO review_approvals(id,review_id,user_id,board_role,decision,comment,at,superseded) VALUES (?,?,?,?,?,?,?,?)");
app.run("a1", "r1", "bm", "decision_maker", "approve", null, "2026-01-01T10:00:00.000Z", 0);
app.run("a2", "r1", "rv", "reviewer", "request_changes", "needs work", "2026-01-01T09:00:00.000Z", 1);
app.run("a3", "r2", "j.duduka", "chair", "approve", "fine", "2026-01-02T10:00:00.000Z", 0);
db.prepare("INSERT INTO conditions(id,review_id,text,owner,due_at,status,created_at) VALUES (?,?,?,?,?,?,?)").run("c1", "r2", "raise TLS", "eng", null, "open", now);
db.prepare("INSERT INTO review_events(id,review_id,kind,actor,body_md,data_json,origin,verification,created_at) VALUES (?,?,?,?,?,?,?,?,?)").run("e1", "r1", "approval", "bm", "", "{}", "human", "verified", now);

test("m009: approvals → positions with the right mapping, review_approvals dropped, new columns and tables, idempotent", async () => {
  await migrate();
  assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE version=9").get());
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map((t) => t.name));
  assert.ok(!tables.has("review_approvals"), "review_approvals is dropped");
  for (const t of ["review_positions", "board_sessions", "session_items", "session_attendance", "session_delegations", "review_dependencies", "decision_links"]) assert.ok(tables.has(t), t);
  const pos = db.prepare("SELECT * FROM review_positions ORDER BY id").all() as any[];
  assert.equal(pos.length, 3, "every approval row is carried over");
  const p1 = pos.find((p) => p.id === "a1"), p2 = pos.find((p) => p.id === "a2"), p3 = pos.find((p) => p.id === "a3");
  assert.deepEqual({ r: p1.review_id, u: p1.user_id, role: p1.board_role, pos: p1.position, area: p1.area, text: p1.text, at: p1.at, sup: p1.superseded, sess: p1.session_id, obo: p1.on_behalf_of, res: p1.resolution },
    { r: "r1", u: "bm", role: "decision_maker", pos: "yes", area: null, text: null, at: "2026-01-01T10:00:00.000Z", sup: 0, sess: null, obo: null, res: null }, "approve → yes, count mode (no area)");
  assert.deepEqual({ pos: p2.position, text: p2.text, sup: p2.superseded, role: p2.board_role }, { pos: "no", text: "needs work", sup: 1, role: "reviewer" }, "request_changes → no, comment and superseded kept");
  assert.deepEqual({ pos: p3.position, text: p3.text, role: p3.board_role }, { pos: "yes", text: "fine", role: "chair" });
  const cols = (table: string) => new Set((db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map((c) => c.name));
  for (const c of ["areas_json", "areas_derived_json", "areas_origin", "session_id", "pending_outcome", "circulation_due", "deferred_count", "deferred_reason", "last_deferred_at"]) assert.ok(cols("reviews").has(c), `reviews.${c}`);
  assert.ok(cols("review_events").has("session_id")); assert.ok(cols("conditions").has("area") && cols("conditions").has("position_id"));
  assert.ok(cols("boards").has("areas_json") && cols("board_members").has("areas_json"));
  assert.deepEqual(db.prepare("SELECT areas_json a, deferred_count d, session_id s FROM reviews WHERE id='r1'").get(), { a: null, d: 0, s: null }, "areas are not derived yet (seedBoards does that)");
  assert.equal((db.prepare("SELECT areas_json a FROM boards WHERE id='b-da'").get() as any).a, "[]");
  assert.equal((db.prepare("SELECT count(*) c FROM conditions").get() as any).c, 1); assert.equal((db.prepare("SELECT count(*) c FROM review_events").get() as any).c, 1);
  await migrate();
  assert.equal((db.prepare("SELECT count(*) c FROM review_positions").get() as any).c, 3, "a second migrate changes nothing");
  // the old code path still reads: the approvals adapter and count-mode progress see the carried-over rows
  const { approvalsOf, approvalProgress } = await import("../src/boards/workflow.js");
  assert.deepEqual(approvalsOf("r1").map((a) => [a.user_id, a.decision, a.superseded]), [["rv", "request_changes", true], ["bm", "approve", false]]);
  const prog = approvalProgress(db.prepare("SELECT * FROM reviews WHERE id='r1'").get() as any);
  assert.equal(prog.mode, "count"); assert.equal(prog.received, 1); assert.equal(prog.satisfied, true);
  // boot: areas are derived for every review that has none; a board without areas yields [] (count mode stays)
  const { seedBoards } = await import("../src/boards/seed.js");
  const s = seedBoards("test");
  assert.equal(s.reviews_areas_derived, 2);
  assert.deepEqual(db.prepare("SELECT areas_json a, areas_origin o FROM reviews WHERE id='r1'").get(), { a: "[]", o: "derived" });
  assert.equal(seedBoards("test").reviews_areas_derived, 0);
});
