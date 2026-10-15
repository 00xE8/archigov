import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// A throwaway data dir, set before db.ts is evaluated, so tests never touch real data.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "archigov-test-"));
const { db, migrate } = await import("../src/db.js");
await migrate();
const { nextCode } = await import("../src/http.js");
const { hashOf } = await import("../src/model.js");
const { loadMigrations } = await import("../src/migrations/index.js");

test("migrations registry: files load in strictly increasing version order", async () => {
  const ms = await loadMigrations();
  assert.ok(ms.length >= 3);
  for (let i = 1; i < ms.length; i++) assert.ok(ms[i].version > ms[i - 1].version, `version ${ms[i].version} after ${ms[i - 1].version}`);
  assert.deepEqual(ms.slice(0, 3).map((m) => m.version), [1, 2, 3]);
});

test("nextCode: per prefix, numeric, STD three digits, ADR/REV four", () => {
  assert.equal(nextCode("standards", "STD"), "STD-001");
  assert.equal(nextCode("decisions", "ADR"), "ADR-0001");
  assert.equal(nextCode("reviews", "REV"), "REV-0001");

  const now = "2026-10-11T00:00:00.000Z";
  const addStd = (id: string, code: string) => db.prepare("INSERT INTO standards(id,code,title,category,statement,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(id, code, "t", "c", "s", now, now);
  addStd("s9", "STD-009");
  addStd("s10b", "STD-010b"); // suffixed codes count by their number, never collide
  assert.equal(nextCode("standards", "STD"), "STD-011");

  db.prepare("INSERT INTO decisions(id,code,title,created_at,updated_at) VALUES (?,?,?,?,?)").run("d12", "ADR-0012", "t", now, now);
  assert.equal(nextCode("decisions", "ADR"), "ADR-0013");
  // a different prefix in another table is sequenced independently
  assert.equal(nextCode("reviews", "REV"), "REV-0001");
});

test("hashOf: deterministic, 16 hex chars, content-sensitive", () => {
  const a = hashOf({ x: 1, y: ["a", "b"] });
  assert.equal(a, hashOf({ x: 1, y: ["a", "b"] }));
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.notEqual(a, hashOf({ x: 2, y: ["a", "b"] }));
});
