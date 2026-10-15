import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "archigov-chain-"));
const { db, migrate, audit, verifyAuditChain, backfillAuditChain, uid, nowIso } = await import("../src/db.js");
await migrate();
const { principalStore } = await import("../src/auth/context.js");

test("audit chain: links every row to the previous one and records the role from context", () => {
  audit("alice", "create", "standards", "s1", { title: "one" });
  principalStore.run({ principal: { id: "bob", name: "bob", email: null, roles: ["chair"], via: "session" } }, () => audit("bob", "decide", "reviews", "r1", { outcome: "approved" }));
  audit("system", "evaluate", "run", "run1", { findings: 3, nested: { a: [1, 2] } });
  const rows = db.prepare("SELECT id, actor, role, prev_hash, hash FROM audit_log ORDER BY rowid").all() as any[];
  assert.equal(rows.length, 3);
  assert.equal(rows[0].prev_hash, ""); assert.equal(rows[1].prev_hash, rows[0].hash); assert.equal(rows[2].prev_hash, rows[1].hash);
  assert.equal(rows[1].role, "chair"); assert.equal(rows[0].role, null);
  const v = verifyAuditChain();
  assert.deepEqual({ ok: v.ok, rows: v.rows, broken_at: v.broken_at, head: v.head }, { ok: true, rows: 3, broken_at: null, head: rows[2].hash });
  assert.equal(verifyAuditChain(rows[1].hash).ok, true, "a prefix up to an anchor verifies");
  assert.equal(verifyAuditChain("not-a-real-head").ok, false, "an anchor that is not in the chain does not verify");
});

test("audit chain: a tampered row is detected, naming the first bad row", () => {
  const rows = db.prepare("SELECT id FROM audit_log ORDER BY rowid").all() as any[];
  db.prepare("UPDATE audit_log SET data_json=? WHERE id=?").run(JSON.stringify({ outcome: "rejected" }), rows[1].id);
  const v = verifyAuditChain();
  assert.equal(v.ok, false); assert.equal(v.broken_at, rows[1].id);
  db.prepare("UPDATE audit_log SET data_json=? WHERE id=?").run(JSON.stringify({ outcome: "approved" }), rows[1].id);
  assert.equal(verifyAuditChain().ok, true, "restoring the content restores the chain");
  db.prepare("UPDATE audit_log SET actor=? WHERE id=?").run("mallory", rows[0].id);
  assert.equal(verifyAuditChain().broken_at, rows[0].id);
});

test("backfill: rows written before the chain existed are chained once, idempotently", () => {
  db.exec("DELETE FROM audit_log");
  const ins = db.prepare("INSERT INTO audit_log(id, at, actor, action, entity, entity_id, data_json) VALUES (?,?,?,?,?,?,?)");
  for (let i = 0; i < 4; i++) ins.run(uid(), nowIso(), "legacy", "create", "things", String(i), "{}");
  assert.equal(verifyAuditChain().ok, false, "unhashed rows do not verify");
  assert.equal(backfillAuditChain(), 4);
  assert.equal(verifyAuditChain().ok, true);
  assert.equal(backfillAuditChain(), 0, "nothing left to do");
  audit("after", "create", "things", "5", {});
  assert.equal(verifyAuditChain().rows, 5); assert.equal(verifyAuditChain().ok, true);
});
