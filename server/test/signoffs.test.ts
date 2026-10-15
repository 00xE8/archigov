import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Review dates and periodic sign-offs: every adopted artefact and accepted decision has a next review date from its
// adoption and its kind's cadence; the chair of its owning board — and nobody else — reaffirms it or says it needs a
// revision; a sign-off moves the date; due and overdue ones are the chair's work.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "archigov-signoffs-"));
delete process.env.AUTH_MODE;
const { db, migrate, setSetting } = await import("../src/db.js");
await migrate();
const { seedDemo } = await import("../src/seed.js");
seedDemo("test");
const { seedBoards } = await import("../src/boards/seed.js");
seedBoards("test");
const { Hono } = await import("hono");
const { api } = await import("../src/routes.js");
const app = new Hono();
app.route("/", api);
const call = async (method: string, p: string, user: string, body?: any) => { const r = await app.request(p, { method, headers: { "x-user": user, "content-type": "application/json" }, body: body !== undefined ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
const list = async (user = "a.uditor", q = "") => (await call("GET", `/sign-offs${q}`, user)).body;
const item = (l: any, code: string) => l.items.find((x: any) => x.subject.code === code);
const sub = (l: any, code: string) => { const x = item(l, code); return { subject_kind: x.subject.kind, subject_id: x.subject.id }; };

test("the demo: three items adopted 350 days ago are due soon, each with its owning board", async () => {
  const l = await list();
  assert.deepEqual(l.cadence_months, { artefact: 12, decision: 24 });
  for (const code of ["STD-001", "STD-005", "POL-001"]) assert.equal(item(l, code).status, "due_soon", code);
  assert.equal(item(l, "STD-001").board.code, "DA"); assert.equal(item(l, "POL-001").board.code, "PCB");
  assert.ok(l.items.filter((x: any) => x.subject.kind === "decision").every((x: any) => x.status === "current"), "decisions run on 24 months");
  assert.ok(l.items.every((x: any) => x.can_sign === false), "an auditor signs nothing");
  assert.deepEqual((await list("a.uditor", "?status=due_soon")).items.map((x: any) => x.subject.code).sort(), ["POL-001", "STD-001", "STD-005"]);
});

test("due sign-offs are the owning chair's work, nobody else's", async () => {
  const w = async (u: string) => (await call("GET", "/me/work", u)).body;
  assert.deepEqual((await w("j.duduka")).sign_offs.map((x: any) => x.subject.code).sort(), ["STD-001", "STD-005"]);
  assert.deepEqual((await w("r.khan")).sign_offs.map((x: any) => x.subject.code), ["POL-001"]);
  for (const u of ["m.hughes", "s.patel", "ops.admin"]) assert.deepEqual((await w(u)).sign_offs, [], u);
});

test("only the owning board's chair signs off; a revision needs a note; a sign-off moves the date and is audited", async () => {
  const l = await list("j.duduka");
  assert.equal(item(l, "STD-001").can_sign, true); assert.equal(item(l, "POL-001").can_sign, false);
  for (const u of ["m.hughes", "ops.admin", "r.khan", "a.uditor"]) assert.equal((await call("POST", "/sign-offs", u, { ...sub(l, "STD-001"), outcome: "reaffirmed" })).status, 403, u);
  assert.equal((await call("POST", "/sign-offs", "j.duduka", { ...sub(l, "POL-001"), outcome: "reaffirmed" })).status, 403, "the DA chair does not sign off a PCB policy");
  assert.equal((await call("POST", "/sign-offs", "j.duduka", { ...sub(l, "STD-001"), outcome: "retire" })).status, 400);
  assert.equal((await call("POST", "/sign-offs", "j.duduka", { subject_kind: "artefact", subject_id: "nope", outcome: "reaffirmed" })).status, 404);
  const r = await call("POST", "/sign-offs", "j.duduka", { ...sub(l, "STD-001"), outcome: "reaffirmed", note: "Still our hosting baseline." });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.status, "current");
  assert.ok(r.body.due > new Date(Date.now() + 360 * 86_400_000).toISOString(), "a full cadence ahead");
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action='signoff:reaffirmed'").get());
  assert.equal((await call("POST", "/sign-offs", "j.duduka", { ...sub(l, "STD-005"), outcome: "revision_needed", note: "short" })).status, 400);
  const rv = await call("POST", "/sign-offs", "j.duduka", { ...sub(l, "STD-005"), outcome: "revision_needed", note: "Owner tags must name a team, not a person." });
  assert.equal(rv.status, 200); assert.equal(rv.body.revision_needed, true);
  assert.ok(rv.body.due < new Date(Date.now() + 100 * 86_400_000).toISOString(), "back in three months");
  assert.deepEqual((await call("GET", "/me/work", "j.duduka")).body.sign_offs, [], "nothing left due for the DA chair");
});

test("the cadence is a setting; overdue decisions appear; the metrics count what is in date", async () => {
  setSetting("review.decision_months", "1");
  const l = await list();
  assert.ok(l.items.some((x: any) => x.subject.kind === "decision" && x.status === "overdue"), "decided over a month ago");
  const m = (await call("GET", "/metrics", "a.uditor")).body.coverage.sign_offs;
  assert.ok(m.overdue >= 1 && m.total === l.items.length, JSON.stringify(m));
  setSetting("review.decision_months", "24");
});
