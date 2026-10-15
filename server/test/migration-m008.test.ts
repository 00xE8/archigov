import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// m008 on a tenant written in the old vocabulary: the users table is rebuilt with a nullable user_type, system
// roles and seats are remapped, the old local default identities become platform admins only, and policies,
// approvals and review events are rewritten. Audit rows are not touched. migrate() then carries on to m009,
// which moves the approval into review_positions (checked in migration-m009.test.ts in depth).
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "archigov-m008-"));
delete process.env.AUTH_MODE;
const { db, migrate, nowIso } = await import("../src/db.js");
const { loadMigrations } = await import("../src/migrations/index.js");

// bring the schema to v7 by hand, then write rows the way v7 code did
db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
for (const m of await loadMigrations()) { if (m.version >= 8) continue; db.exec(m.sql); db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?,?)").run(m.version, nowIso()); }
const now = nowIso();
const ins = db.prepare("INSERT INTO users(id,name,email,user_type,is_platform_admin,created_at,updated_at) VALUES (?,?,?,?,?,?,?)");
ins.run("local-admin", "local-admin", null, "architect", 1, now, now);
ins.run("smoke", "smoke", null, "architect", 1, now, now);              // auto-created by the old x-user default (name = id)
ins.run("j.duduka", "Joel Duduka", null, "architect", 1, now, now);     // a named admin: keeps the flag, becomes an author
ins.run("eng", "Eng", null, "engineer", 0, now, now);
ins.run("sub", "sub", null, "submitter", 0, now, now);
ins.run("bm", "Board Member", null, "board_member", 0, now, now);
ins.run("aud", "Aud", null, "auditor", 0, now, now);
ins.run("svc", "Svc", null, "service", 0, now, now);
ins.run("weird", "Weird", null, "wizard", 0, now, now);
db.prepare("INSERT INTO boards(id,code,name,purpose,created_at) VALUES (?,?,?,?,?)").run("b-da", "DA", "Design Authority", "", now);
const mem = db.prepare("INSERT INTO board_members(board_id,user_id,board_role,added_at) VALUES (?,?,?,?)");
mem.run("b-da", "bm", "member", now); mem.run("b-da", "j.duduka", "chair", now); mem.run("b-da", "eng", "observer", now);
db.prepare("INSERT INTO approval_policies(board_id,review_type,policy_json) VALUES (?,?,?)").run("b-da", "design", JSON.stringify({ steps: [{ name: "pre", kind: "pre_review" }, { name: "Board approval", kind: "approvals", min: 1, roles: ["member", "chair"] }, { name: "Chair decision", kind: "decision", roles: ["chair"] }] }));
db.prepare("INSERT INTO reviews(id,code,title,risk_tier,stage,submitted_by,created_at,updated_at,type,board_id) VALUES (?,?,?,?,?,?,?,?,?,?)").run("r1", "REV-0001", "t", "medium", "in_review", "eng", now, now, "design", "b-da");
db.prepare("INSERT INTO review_approvals(id,review_id,user_id,board_role,decision,comment,at,superseded) VALUES (?,?,?,?,?,?,?,0)").run("a1", "r1", "bm", "member", "approve", null, now);
db.prepare("INSERT INTO review_events(id,review_id,kind,actor,body_md,data_json,origin,verification,created_at) VALUES (?,?,?,?,?,?,?,?,?)").run("e1", "r1", "approval", "bm", "", JSON.stringify({ board_role: "member", board_id: "b-da" }), "human", "verified", now);
db.prepare("INSERT INTO review_events(id,review_id,kind,actor,body_md,data_json,origin,verification,created_at) VALUES (?,?,?,?,?,?,?,?,?)").run("e2", "r1", "comment", "eng", "remember the member list", JSON.stringify({ note: "member" }), "human", "verified", now);

test("m008 remaps users, seats, policies, approvals and events; the schema allows a user without a system role", async () => {
  await migrate();
  assert.ok(db.prepare("SELECT 1 FROM schema_migrations WHERE version=8").get());
  const u = (id: string) => db.prepare("SELECT user_type t, is_platform_admin a, name FROM users WHERE id=?").get(id) as any;
  assert.deepEqual({ t: u("local-admin").t, a: u("local-admin").a }, { t: null, a: 1 }, "local-admin is a platform admin only");
  assert.deepEqual({ t: u("smoke").t, a: u("smoke").a }, { t: null, a: 1 }, "the old auto-created architect+admin is a platform admin only");
  assert.deepEqual({ t: u("j.duduka").t, a: u("j.duduka").a }, { t: "author", a: 1 }, "a named architect+admin stays an admin and becomes an author (the demo seed then drops the flag)");
  assert.equal(u("eng").t, "author"); assert.equal(u("sub").t, "author");
  assert.equal(u("bm").t, null, "board_member had no system role");
  assert.equal(u("aud").t, "auditor"); assert.equal(u("svc").t, "service");
  assert.equal(u("weird").t, null, "an unknown type becomes none");
  assert.equal(db.prepare("SELECT count(*) c FROM users").get() as any && (db.prepare("SELECT count(*) c FROM users").get() as any).c, 9, "no row is lost in the rebuild");
  const col = (db.prepare("PRAGMA table_info(users)").all() as any[]).find((c) => c.name === "user_type");
  assert.equal(col.notnull, 0, "user_type is nullable after the rebuild");
  assert.equal((db.prepare("SELECT board_role r FROM board_members WHERE user_id='bm'").get() as any).r, "decision_maker");
  assert.equal((db.prepare("SELECT board_role r FROM board_members WHERE user_id='j.duduka'").get() as any).r, "chair");
  assert.equal((db.prepare("SELECT board_role r FROM board_members WHERE user_id='eng'").get() as any).r, "observer");
  const pol = JSON.parse((db.prepare("SELECT policy_json p FROM approval_policies WHERE board_id='b-da'").get() as any).p);
  assert.deepEqual(pol.steps[1].roles, ["decision_maker", "chair"]);
  assert.deepEqual(db.prepare("SELECT board_role r, position p FROM review_positions WHERE id='a1'").get(), { r: "decision_maker", p: "yes" }, "the remapped approval travels on into m009's positions");
  assert.deepEqual(JSON.parse((db.prepare("SELECT data_json d FROM review_events WHERE id='e1'").get() as any).d), { board_role: "decision_maker", board_id: "b-da" });
  assert.deepEqual(JSON.parse((db.prepare("SELECT data_json d FROM review_events WHERE id='e2'").get() as any).d), { note: "member" }, "only board_role values are rewritten");
  // a user without a system role can now be written, and the migration does not run twice
  db.prepare("INSERT INTO users(id,name,email,user_type,is_platform_admin,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run("seat.only", "Seat Only", null, null, 0, now, now);
  await migrate();
  assert.equal((db.prepare("SELECT count(*) c FROM users").get() as any).c, 10);
});
