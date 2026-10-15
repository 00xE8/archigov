import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Manually logged potential changes: projects and initiatives no backlog source knows yet. Authors log them
// (log_change); the auditor and the platform admin get 403 (content, not operations); they carry a PC-xxxx id
// under the Manual source, are flagged until a decision or review covers them, and rows that arrived from a
// real source stay read-only here. Nothing is deleted — Removed is a state.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "archigov-manual-"));
delete process.env.AUTH_MODE;
const { db, migrate } = await import("../src/db.js");
await migrate();
const { seedDemo } = await import("../src/seed.js");
seedDemo("test");
const { seedBoards } = await import("../src/boards/seed.js");
seedBoards("test");
const { Hono } = await import("hono");
const { api } = await import("../src/routes.js");
const app = new Hono();
app.route("/", api);
const call = async (method: string, p: string, user: string, body?: any) => {
  const r = await app.request(p, { method, headers: { "x-user": user, "content-type": "application/json" }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const ctx: Record<string, any> = {};

test("an author logs a potential change; it gets a PC code, the Manual source and the no-decision flag", async () => {
  const r = await call("POST", "/work-items", "s.patel", { type: "Project", title: "Patient kiosk rollout phase 2", description: "Procurement under way; no epics exist yet." });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.external_id, "PC-0001");
  assert.equal(r.body.source_kind, "manual");
  assert.equal(r.body.state, "Proposed");
  assert.equal(r.body.needs_decision, true);
  ctx.id = r.body.id;
  const list = await call("GET", "/work-items", "a.uditor");
  const mine = list.body.find((w: any) => w.id === ctx.id);
  assert.ok(mine && mine.source_kind === "manual");
  const audit = db.prepare("SELECT count(*) c FROM audit_log WHERE action='log_change' AND entity_id=?").get(ctx.id) as any;
  assert.equal(audit.c, 1);
});

test("the auditor, the platform admin and a bare decision maker cannot log or edit changes", async () => {
  for (const user of ["a.uditor", "ops.admin", "m.hughes"]) {
    assert.equal((await call("POST", "/work-items", user, { type: "Project", title: "nope nope" })).status, 403, user);
    assert.equal((await call("PUT", `/work-items/${ctx.id}`, user, { title: "rewritten" })).status, 403, user);
  }
});

test("validation: unknown type, short title, unknown application", async () => {
  assert.equal((await call("POST", "/work-items", "s.patel", { type: "Epic", title: "real epics come from the source" })).status, 400);
  assert.equal((await call("POST", "/work-items", "s.patel", { type: "Change", title: "ab" })).status, 400);
  assert.equal((await call("POST", "/work-items", "s.patel", { type: "Change", title: "valid title", application_id: "nope" })).status, 404);
});

test("manual rows are editable, source rows are not; Removed clears the flag but keeps the record", async () => {
  const ado = db.prepare("SELECT w.id FROM work_items w JOIN sources s ON s.id=w.source_id WHERE s.kind<>'manual' LIMIT 1").get() as any;
  assert.equal((await call("PUT", `/work-items/${ado.id}`, "s.patel", { title: "rewriting the feed" })).status, 409);
  const e = await call("PUT", `/work-items/${ctx.id}`, "s.patel", { description: "Scope grew: includes ward kiosks.", state: "Active" });
  assert.equal(e.status, 200, JSON.stringify(e.body));
  assert.equal(e.body.state, "Active");
  assert.ok(e.body.changed_at);
  const gone = await call("PUT", `/work-items/${ctx.id}`, "s.patel", { state: "Removed" });
  assert.equal(gone.body.needs_decision, false, "a removed entry stops asking for a decision");
  assert.ok(db.prepare("SELECT 1 FROM work_items WHERE id=?").get(ctx.id), "nothing is deleted");
});

test("linking a decision clears the flag, like any backlog item", async () => {
  const r = await call("POST", "/work-items", "s.patel", { type: "Initiative", title: "Shared analytics platform" });
  assert.equal(r.body.needs_decision, true);
  const d = db.prepare("SELECT id FROM decisions LIMIT 1").get() as any;
  const linked = await call("POST", `/work-items/${r.body.id}/link`, "s.patel", { decision_id: d.id });
  assert.equal(linked.status, 200);
  assert.equal(linked.body.needs_decision, false);
});
