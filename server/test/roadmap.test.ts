import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The roadmap is built from records: decisions with their realisation (conforming resources against open drift),
// planned changes nested under their decision, conditions, lifecycle deadlines and expiring exceptions, laid into
// Now / Next / Later / Done by deterministic rules — and it moves when the records move.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "archigov-roadmap-"));
delete process.env.AUTH_MODE;
const { db, migrate, nowIso } = await import("../src/db.js");
await migrate();
const { seedDemo } = await import("../src/seed.js");
seedDemo("test");
const { seedBoards } = await import("../src/boards/seed.js");
seedBoards("test");
const { Hono } = await import("hono");
const { api } = await import("../src/routes.js");
const app = new Hono();
app.route("/", api);
const get = async (p: string, user = "a.uditor") => { const r = await app.request(p, { headers: { "x-user": user } }); return { status: r.status, body: await r.json().catch(() => null) }; };
const all = (rm: any) => Object.entries(rm.lanes).flatMap(([lane, l]: [string, any]) => l.map((i: any) => ({ ...i, lane })));
const byCode = (rm: any, code: string) => all(rm).find((i: any) => i.code === code);
const apps = new Map((db.prepare("SELECT id, name FROM elements WHERE type='application'").all() as any[]).map((a) => [a.name, a.id]));

test("decisions are placed by realisation: in progress now, realised done, proposed and unmeasurable next", async () => {
  const r = await get("/roadmap");
  assert.equal(r.status, 200);
  const adr2 = byCode(r.body, "ADR-0002");
  assert.equal(adr2.lane, "now"); assert.equal(adr2.status, "in_progress"); assert.deepEqual(adr2.progress, { done: 1, total: 2 });
  assert.match(adr2.detail, /1 resource still drifts/);
  assert.equal(byCode(r.body, "ADR-0005").lane, "done");
  assert.equal(byCode(r.body, "ADR-0004").status, "proposed");
  const adr1 = byCode(r.body, "ADR-0001");
  assert.equal(adr1.status, "not_checkable"); assert.match(adr1.detail, /not measured/);
  assert.equal(r.body.counts.total, all(r.body).length);
});

test("planned changes nest under their decision; the rest stand alone by state", async () => {
  const r = await get("/roadmap");
  const linked = (db.prepare("SELECT w.id, d.code FROM work_items w JOIN decisions d ON d.id=w.decision_id LIMIT 1").get() as any);
  assert.ok(byCode(r.body, linked.code).changes.some((c: any) => c.id === linked.id));
  assert.ok(!all(r.body).some((i: any) => i.id === `change:${linked.id}`), "a linked change is not listed twice");
  const active = all(r.body).filter((i: any) => i.kind === "change" && i.status === "active");
  assert.ok(active.length && active.every((i: any) => i.lane === "now"));
});

test("deadlines: end-of-life components and overdue conditions are now; extended support years away is later", async () => {
  const r = await get("/roadmap");
  const lc = all(r.body).filter((i: any) => i.kind === "lifecycle");
  assert.equal(lc.find((i: any) => i.title === "Upgrade Windows Server 2012 R2").lane, "now");
  assert.equal(lc.find((i: any) => /SQL Server 2016/.test(i.title)).lane, "later");
  const overdue = all(r.body).find((i: any) => i.kind === "condition" && i.status === "overdue");
  assert.ok(overdue && overdue.lane === "now" && overdue.link.kind === "review");
  assert.ok(all(r.body).some((i: any) => i.kind === "exception" && i.due));
});

test("the roadmap moves with the records: drift resolved realises a decision; a met condition is done", async () => {
  const d = db.prepare("SELECT id FROM decisions WHERE code='ADR-0002'").get() as any;
  db.prepare("UPDATE findings SET status='resolved' WHERE decision_id=? AND status='open'").run(d.id);
  const c = db.prepare("SELECT id FROM conditions WHERE status IN ('open','overdue') LIMIT 1").get() as any;
  db.prepare("UPDATE conditions SET status='met', closed_at=? WHERE id=?").run(nowIso(), c.id);
  const r = await get("/roadmap");
  assert.equal(byCode(r.body, "ADR-0002").lane, "done"); assert.equal(byCode(r.body, "ADR-0002").status, "realised");
  assert.equal(all(r.body).find((i: any) => i.id === `condition:${c.id}`).lane, "done");
});

test("one application's roadmap keeps tenant-wide decisions; an unknown application is 404", async () => {
  const id = apps.get("Referral API")!;
  const r = await get(`/roadmap?application=${id}`);
  assert.equal(r.status, 200); assert.equal(r.body.application.name, "Referral API");
  assert.ok(all(r.body).every((i: any) => i.applications.some((a: any) => a.id === id) || (i.kind === "decision" && !i.applications.length)));
  assert.ok(all(r.body).some((i: any) => i.title === "Upgrade .NET 6"));
  assert.equal((await get("/roadmap?application=nope")).status, 404);
  assert.equal((await get("/roadmap", "ops.admin")).status, 200, "reading the roadmap changes nothing");
});
