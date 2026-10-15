import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The risk register: risks a decision accepts follow the decision; active exceptions are accepted risks; an author
// logs one, only its owner or whoever logged it changes it and closing needs a note. The architecture debt view is
// derived from records. The AI suggestion of a decision's risks is optional and stores nothing.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "archigov-risks-"));
delete process.env.AUTH_MODE;
delete process.env.LLM_BASE_URL; delete process.env.LLM_MODEL;
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
const call = async (method: string, p: string, user: string, body?: any) => { const r = await app.request(p, { method, headers: { "x-user": user, "content-type": "application/json" }, body: body !== undefined ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
const realFetch = globalThis.fetch;
const apps = new Map((db.prepare("SELECT id, name FROM elements WHERE type='application'").all() as any[]).map((a) => [a.name, a.id]));

test("an author logs a risk with an owner and a review date; nobody else may", async () => {
  const body = { title: "Single-region writes for PatientFlow", description: "A UK South outage stops admissions writes.", severity: "high", owner: "m.hughes", review_by: "2027-01-31", application_ids: [apps.get("PatientFlow")] };
  for (const u of ["ops.admin", "a.uditor", "m.hughes"]) assert.equal((await call("POST", "/risks", u, body)).status, 403, u);
  assert.equal((await call("POST", "/risks", "s.patel", { ...body, title: "x" })).status, 400);
  assert.equal((await call("POST", "/risks", "s.patel", { ...body, severity: "dire" })).status, 400);
  assert.equal((await call("POST", "/risks", "s.patel", { ...body, owner: "nobody" })).status, 400);
  const r = await call("POST", "/risks", "s.patel", body);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.code, "RSK-0001"); assert.equal(r.body.status, "open"); assert.equal(r.body.source, "manual"); assert.equal(r.body.owner, "m.hughes");
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action='risk:log'").get());
});

test("a decision's risks follow the decision: proposed, then accepted, then withdrawn when superseded", async () => {
  const d = await call("POST", "/decisions", "s.patel", { title: "Adopt a message broker", topic: "integration", decision_md: "Use Service Bus.", consequences_md: "We accept vendor lock-in." });
  const r = await call("POST", "/risks", "s.patel", { title: "Lock-in to the broker's API", severity: "medium", decision_id: d.body.id });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.source, "decision"); assert.equal(r.body.status, "proposed"); assert.equal(r.body.decision.code, d.body.code);
  assert.equal((await call("POST", `/decisions/${d.body.id}/status`, "j.duduka", { status: "accepted" })).status, 200);
  const list = async () => (await call("GET", `/risks?decision=${d.body.id}`, "a.uditor")).body.risks;
  assert.equal((await list())[0].status, "accepted");
  assert.equal((await call("POST", `/decisions/${d.body.id}/status`, "j.duduka", { status: "superseded" })).status, 200);
  assert.equal((await list())[0].status, "withdrawn");
});

test("active exceptions are accepted risks, read from the exceptions table and not editable here", async () => {
  const r = (await call("GET", "/risks", "a.uditor")).body;
  const ex = r.risks.filter((x: any) => x.source === "exception");
  assert.ok(ex.length >= 1 && ex.every((x: any) => x.status === "accepted" && x.editable === false && x.review_by), JSON.stringify(ex[0]));
  assert.equal(r.counts.from_exceptions, ex.length);
});

test("only the owner or whoever logged a risk changes it; closing needs a note; a past review date is overdue", async () => {
  const id = (db.prepare("SELECT id FROM risks WHERE code='RSK-0001'").get() as any).id;
  assert.equal((await call("PUT", `/risks/${id}`, "t.nguyen", { status: "mitigated", note: "Added a standby region." })).status, 403, "neither owner nor logger");
  assert.equal((await call("PUT", `/risks/${id}`, "m.hughes", { status: "closed", note: "short" })).status, 400);
  const u = await call("PUT", `/risks/${id}`, "m.hughes", { review_by: "2020-01-01" });
  assert.equal(u.status, 200, JSON.stringify(u.body)); assert.equal(u.body.review_overdue, true);
  const c = await call("PUT", `/risks/${id}`, "m.hughes", { status: "closed", note: "Zone-redundant writes deployed in UK South." });
  assert.equal(c.body.status, "closed"); assert.equal(c.body.closed_by, "m.hughes"); assert.equal(c.body.review_overdue, false);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action='risk:closed' AND entity_id=?").get(id));
});

test("architecture debt is derived from records, by application, and ageing makes a finding debt", async () => {
  const d = (await call("GET", "/debt", "a.uditor")).body;
  for (const k of ["drift", "condition_overdue", "end_of_life", "legacy_assessment_due", "exit_plan_due"]) assert.ok(d.counts[k] >= 1, `${k}: ${JSON.stringify(d.counts)}`);
  assert.equal(d.counts.aged_finding, 0, "the demo's findings are fresh");
  db.prepare("UPDATE findings SET first_seen='2025-01-01T00:00:00.000Z' WHERE status='open' AND decision_id IS NULL AND application_id=?").run(apps.get("Pharmacy"));
  const d2 = (await call("GET", `/debt?application=${apps.get("Pharmacy")}`, "a.uditor")).body;
  assert.ok(d2.counts.aged_finding >= 1 && d2.items.every((i: any) => i.application?.id === apps.get("Pharmacy")), JSON.stringify(d2.counts));
  assert.equal((await call("GET", "/debt?application=nope", "a.uditor")).status, 404);
});

test("the AI suggestion of a decision's risks is optional, the author's, and stores nothing", async () => {
  const dec = (db.prepare("SELECT id FROM decisions WHERE code='ADR-0002'").get() as any).id;
  assert.equal((await call("POST", `/decisions/${dec}/suggest-risks`, "s.patel")).status, 409);
  assert.equal((await call("POST", `/decisions/${dec}/suggest-risks`, "a.uditor")).status, 403);
  await call("POST", "/settings", "ops.admin", { ai_providers: { mistral: { api_key: "test-key" } }, ai_features: { suggest_risks: { enabled: true, provider: "mistral", model: "m" } } });
  globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ risks: [
    { title: "Single-region database", description: "One region.", severity: "high" }, { title: "x", severity: "low" }, { title: "Something vague", severity: "awful" }] }) } }] }), text: async () => "" })) as any;
  try {
    const before = (db.prepare("SELECT count(*) n FROM risks").get() as any).n;
    const r = await call("POST", `/decisions/${dec}/suggest-risks`, "s.patel");
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.origin, "ai");
    assert.deepEqual(r.body.risks.map((x: any) => x.title), ["Single-region database"], "short titles and unknown severities are dropped");
    assert.equal((db.prepare("SELECT count(*) n FROM risks").get() as any).n, before);
    const saved = await call("POST", "/risks", "s.patel", { ...r.body.risks[0], decision_id: dec, origin: "ai_assisted" });
    assert.equal(saved.body.origin, "ai_assisted");
  } finally { globalThis.fetch = realFetch; }
});
