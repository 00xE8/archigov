import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Third parties: providers derived from resource types and supplier tags, concentration of critical reliance on a
// designated critical third party, exit plans per critical reliance (DORA Art. 28(8)) with substitutability flowing
// into the DORA register, the designations list as admin-kept reference data, and the `assessmentCurrent` exit-plan rule.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "archigov-thirdparties-"));
delete process.env.AUTH_MODE;
delete process.env.LLM_BASE_URL; delete process.env.LLM_MODEL;
const { db, migrate } = await import("../src/db.js");
await migrate();
const { seedDemo } = await import("../src/seed.js");
seedDemo("test");
const { seedBoards } = await import("../src/boards/seed.js");
seedBoards("test");
const { providersOf, DEFAULT_CTP } = await import("../src/suppliers.js");
const { evaluateAll } = await import("../src/rules.js");
const { createArtefact } = await import("../src/artefacts.js");
const { Hono } = await import("hono");
const { ZodError } = await import("zod");
const { api } = await import("../src/routes.js");
const app = new Hono();
app.route("/", api);
app.onError((err, c) => err instanceof ZodError ? c.json({ error: "invalid_request", issues: err.issues }, 400) : c.json({ error: err.message }, (err as any).status >= 400 && (err as any).status < 600 ? (err as any).status : 500));
const call = async (method: string, p: string, user: string, body?: any) => { const r = await app.request(p, { method, headers: { "x-user": user, "content-type": "application/json" }, body: body !== undefined ? JSON.stringify(body) : undefined }); const text = await r.text(); let parsed: any = text; try { parsed = JSON.parse(text); } catch {} return { status: r.status, body: parsed }; };
const apps = new Map((db.prepare("SELECT id, name FROM elements WHERE type='application' AND deleted_at IS NULL").all() as any[]).map((a) => [a.name, a.id]));

test("providers come from the resource type and supplier tags; a tag naming a platform joins it", () => {
  const el = (subtype: string, tags: Record<string, string> = {}) => ({ id: "x", type: "resource", subtype, name: "x", props: {}, tags } as any);
  assert.deepEqual(providersOf(el("Microsoft.Web/sites", { supplier: "SwiftSMS; Azure", vendor: "Ledgerline" })).map((p) => p.provider), ["microsoft", "supplier:swiftsms", "supplier:ledgerline"]);
  assert.deepEqual(providersOf(el("AWS::EC2::Instance")).map((p) => p.provider), ["aws"]);
  assert.deepEqual(providersOf(el("custom/thing", { owner: "x" })), [], "nothing named, nothing relied on");
});

test("the demo: every critical or important application relies on Microsoft, a designated critical third party", async () => {
  const r = await call("GET", "/third-parties", "a.uditor");
  assert.equal(r.status, 200);
  assert.equal(r.body.ctp.instrument, DEFAULT_CTP.instrument);
  const ms = r.body.providers.find((p: any) => p.id === "microsoft");
  assert.equal(ms.ctp.entity, "Microsoft Ireland Operations Limited");
  assert.equal(ms.critical, r.body.counts.critical_applications); assert.ok(ms.regulated_services.includes("Admit and discharge patients"));
  assert.deepEqual(r.body.concentration.map((c: any) => c.provider), ["microsoft"]);
  assert.ok(r.body.providers.some((p: any) => p.id === "supplier:ledgerline" && p.kind === "supplier" && !p.ctp));
  const plans = new Map(r.body.exit_plans.map((e: any) => [`${e.application.name}|${e.provider.name}`, e.status]));
  assert.equal(plans.get("PatientFlow|Microsoft"), "current");
  assert.equal(plans.get("Finance ERP|Ledgerline"), "due");
  assert.ok(!r.body.exit_plans.some((e: any) => e.application.name === "Intranet"), "a standard application needs no exit plan");
});

test("an author records an exit plan; it flows into the DORA register's substitutability", async () => {
  const id = apps.get("Finance ERP")!;
  const body = { provider: "supplier:ledgerline", result: "satisfactory_with_remarks", substitutability: "medium_complexity", tested_at: "2026-09-01", summary_md: "Migrate to the ERP vendor's SaaS edition or a rival within two quarters.", reference: "https://docs.example.org/erp-exit" };
  for (const u of ["ops.admin", "a.uditor"]) assert.equal((await call("POST", `/applications/${id}/exit-plans`, u, body)).status, 403, u);
  assert.equal((await call("POST", `/applications/${id}/exit-plans`, "s.patel", { ...body, provider: "aws" })).status, 400, "Finance ERP does not rely on AWS");
  assert.equal((await call("POST", `/applications/${id}/exit-plans`, "s.patel", { ...body, substitutability: "easy" })).status, 400);
  assert.equal((await call("POST", `/applications/${id}/exit-plans`, "s.patel", { ...body, tested_at: "2099-01-01" })).status, 400, "a test date in the future");
  assert.equal((await call("POST", `/applications/${id}/exit-plans`, "s.patel", { ...body, summary_md: "short" })).status, 400);
  const r = await call("POST", `/applications/${id}/exit-plans`, "s.patel", body);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const led = r.body.find((p: any) => p.provider === "supplier:ledgerline");
  assert.equal(led.exit.status, "current"); assert.equal(led.exit.last.details.substitutability, "medium_complexity"); assert.equal(led.exit.last.details.tested_at, "2026-09-01");
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action='exit_plan:record' AND entity_id=?").get(id));
  const csv = String((await call("GET", "/exports/dora-roi.csv", "a.uditor")).body).split("\n");
  assert.ok(csv.some((l) => l.includes(id) && l.includes("Ledgerline") && l.includes("Medium complexity in terms of substitutability")), "the supplier row carries the plan's substitutability");
  assert.ok(csv.filter((l) => l.includes(apps.get("PatientFlow")!)).every((l) => l.includes("Highly complex substitutability")), "the seeded plan fills PatientFlow's rows");
});

test("the designations list is reference data the platform admin keeps current", async () => {
  const next = { ...DEFAULT_CTP, entries: [...DEFAULT_CTP.entries, { provider: "supplier:ledgerline", entity: "Ledgerline Ltd" }] };
  assert.equal((await call("PUT", "/third-parties/ctp", "s.patel", next)).status, 403, "an author does not edit the designations");
  assert.equal((await call("PUT", "/third-parties/ctp", "ops.admin", { entries: [] })).status, 400, "the designating instrument is required");
  const r = await call("PUT", "/third-parties/ctp", "ops.admin", next);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const v = await call("GET", "/third-parties", "a.uditor");
  assert.equal(v.body.providers.find((p: any) => p.id === "supplier:ledgerline").ctp.entity, "Ledgerline Ltd");
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action='ctp:set'").get());
  db.prepare("DELETE FROM settings WHERE key='suppliers.ctp'").run();
});

test("the exit-plan rule finds critical reliance without a plan; the AI draft is optional and stores nothing", async () => {
  const s = createArtefact({ kind: "policy", enforcement: "mandatory", title: "Exit plans for critical reliance", category: "Resilience", statement: "s", status: "adopt", severity: "high",
    rule: { scope: "application", assert: { op: "assessmentCurrent", kind: "exit_plan" } }, control_refs: [] } as any, "j.duduka", { lifecycle: "adopted" } as any);
  evaluateAll("test");
  const hit = new Set((db.prepare("SELECT e.name FROM findings f JOIN elements e ON e.id=f.application_id WHERE f.standard_id=? AND f.status='open'").all(s.id) as any[]).map((x) => x.name));
  assert.ok(hit.has("Referral API") && hit.has("Finance ERP") && !hit.has("PatientFlow") && !hit.has("Intranet"), [...hit].join(","));
  const fe = db.prepare("SELECT message FROM findings WHERE standard_id=? AND application_id=?").get(s.id, apps.get("Finance ERP")) as any;
  assert.match(fe.message, /Microsoft/); assert.doesNotMatch(fe.message, /Ledgerline/, "the plan just recorded covers Ledgerline");
  const id = apps.get("Referral API")!;
  assert.equal((await call("POST", `/applications/${id}/exit-plans/draft`, "s.patel", { provider: "microsoft" })).status, 409);
  const pack = await call("GET", "/evidence-pack", "a.uditor");
  const pf = pack.body.applications.find((a: any) => a.name === "PatientFlow");
  assert.equal(pf.third_parties.find((t: any) => t.provider === "microsoft").exit_plan.substitutability, "highly_complex");
  assert.equal(pf.third_parties.find((t: any) => t.provider === "microsoft").designated_ctp, "Microsoft Ireland Operations Limited");
});
