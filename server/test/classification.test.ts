import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Criticality classification: derived from resource tags with provenance, a regulated service making an application
// critical, a person's classification surviving re-collection, reset back to derivation, verification dropping when
// the derived content changes, rules reading `app.*` in both scopes, the business-service map, the DORA register's
// criticality column, and who may classify.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "archigov-classification-"));
delete process.env.AUTH_MODE;
const { db, migrate } = await import("../src/db.js");
await migrate();
const { seedDemo } = await import("../src/seed.js");
seedDemo("test");
const { seedBoards } = await import("../src/boards/seed.js");
seedBoards("test");
const { ingestResources } = await import("../src/model.js");
const { DEMO_RESOURCES } = await import("../src/collectors/demo.js");
const { deriveClassification, classificationOf, refreshClassifications } = await import("../src/classification.js");
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
const demoSource = (db.prepare("SELECT id FROM sources WHERE kind='demo-azure'").get() as any).id;

test("derivation: the highest tier tag wins, every named service is kept, and a regulated service makes an application critical", () => {
  const el = (name: string, tags: Record<string, string>) => ({ name, tags } as any);
  const d = deriveClassification([el("a", { criticality: "important", "business-service": "Reporting; Billing" }), el("b", { Tier: "tier-3", IBS: "Take payments" })]);
  assert.equal(d.criticality, "critical", "an important business service makes it critical");
  assert.equal(d.method, "regulated-service");
  assert.deepEqual(d.services.map((s) => `${s.kind}:${s.name}`), ["business_service:Billing", "business_service:Reporting", "ibs:Take payments"]);
  assert.ok(d.evidence.some((e) => e.resource === "b" && e.tag === "IBS"));
  const t = deriveClassification([el("a", { criticality: "standard" }), el("b", { "service-tier": "gold" })]);
  assert.equal(t.criticality, "critical"); assert.equal(t.method, "tag:service-tier");
  assert.equal(deriveClassification([el("a", { owner: "x", criticality: "whatever" })]).criticality, null, "an unknown value classifies nothing");
});

test("the demo estate: tags give the classification, the seed's verified ones are verified, Pharmacy stays unclassified", async () => {
  const pf = classificationOf(apps.get("PatientFlow")!)!;
  assert.equal(pf.criticality, "critical"); assert.equal(pf.origin, "derived"); assert.equal(pf.verification, "verified");
  assert.deepEqual(pf.services, [{ name: "Admit and discharge patients", kind: "ibs" }]); assert.equal(pf.regulated, true);
  assert.equal(classificationOf(apps.get("Identity Platform")!)!.services[0].kind, "essential_function");
  assert.equal(classificationOf(apps.get("Intranet")!)!.criticality, "standard");
  assert.equal(classificationOf(apps.get("Pharmacy")!)!.criticality, null);
  const list = await call("GET", "/applications", "a.uditor");
  assert.equal(list.status, 200);
  const ref = list.body.find((a: any) => a.name === "Referral API");
  assert.equal(ref.classification.criticality, "critical"); assert.equal(ref.classification.regulated, true);
  const detail = await call("GET", `/applications/${apps.get("Appointments")}`, "a.uditor");
  assert.equal(detail.body.classification.criticality, "important"); assert.equal(detail.body.classification.method, "tag:criticality");
});

test("who classifies: an author with a reason; never the platform admin, an auditor or a decision maker with no system role", async () => {
  const id = apps.get("Pharmacy")!;
  const body = { criticality: "critical", services: [{ name: "Dispense medicines", kind: "cif" }], reason: "Dispensing is a critical function under our DORA mapping." };
  for (const u of ["ops.admin", "a.uditor", "m.hughes"]) assert.equal((await call("PUT", `/applications/${id}/classification`, u, body)).status, 403, u);
  assert.equal((await call("PUT", `/applications/${id}/classification`, "s.patel", { ...body, reason: "short" })).status, 400, "a reason is required");
  assert.equal((await call("PUT", `/applications/${id}/classification`, "s.patel", { ...body, criticality: "important" })).status, 400, "a regulated service means critical");
  assert.equal((await call("PUT", `/applications/${id}/classification`, "s.patel", { ...body, criticality: "vital" })).status, 400);
  const r = await call("PUT", `/applications/${id}/classification`, "s.patel", body);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.origin, "human"); assert.equal(r.body.verification, "verified"); assert.equal(r.body.verified_by, "s.patel"); assert.equal(r.body.set_by, "s.patel");
  assert.equal(r.body.derived.criticality, null, "the derived view beside it says what the tags say");
  const row = db.prepare("SELECT * FROM audit_log WHERE action='classification:set' AND entity_id=?").get(id) as any;
  assert.ok(row); assert.equal(row.actor, "s.patel");
});

test("a person's classification survives re-collection; reset hands it back to the tags", async () => {
  const id = apps.get("Pharmacy")!;
  ingestResources(demoSource, DEMO_RESOURCES, "test"); evaluateAll("test");
  const kept = classificationOf(id)!;
  assert.equal(kept.origin, "human"); assert.equal(kept.criticality, "critical");
  const r = await call("POST", `/applications/${id}/classification/reset`, "s.patel");
  assert.equal(r.status, 200); assert.equal(r.body.origin, "derived"); assert.equal(r.body.criticality, null); assert.equal(r.body.verification, "unverified");
  assert.equal((await call("POST", `/applications/${id}/classification/reset`, "s.patel")).status, 409, "already derived");
});

test("verification drops when the derived classification changes", async () => {
  const id = apps.get("Intranet")!;
  const v = await call("POST", `/applications/${id}/classification/verify`, "s.patel", {});
  assert.equal(v.status, 200); assert.equal(v.body.verification, "verified");
  const changed = DEMO_RESOURCES.map((r) => (r.name === "app-intranet" ? { ...r, tags: { ...r.tags, criticality: "important" } } : r));
  ingestResources(demoSource, changed, "test"); refreshClassifications([id]);
  const c = classificationOf(id)!;
  assert.equal(c.criticality, "important"); assert.equal(c.verification, "unverified", "a person stood behind 'standard', not 'important'");
  ingestResources(demoSource, DEMO_RESOURCES, "test"); refreshClassifications([id]);
});

test("rules read app.* in both scopes: a resource rule for critical applications only, an application rule matched on regulated", () => {
  const res = createArtefact({ kind: "standard", title: "Critical applications avoid public storage", category: "Security", statement: "s", status: "adopt", severity: "high",
    rule: { scope: "resource", match: { type: "Microsoft.Storage/storageAccounts", where: [{ path: "app.criticality", op: "eq", value: "critical" }] }, assert: { path: "props.publicAccess", op: "eq", value: false } }, control_refs: [] } as any, "j.duduka", { lifecycle: "adopted" } as any);
  const appRule = createArtefact({ kind: "policy", enforcement: "mandatory", title: "Regulated services have an owner", category: "Governance", statement: "s", status: "adopt", severity: "medium",
    rule: { scope: "application", match: { where: [{ path: "app.regulated", op: "eq", value: true }] }, assert: { op: "maxResourcesOfType", type: "Microsoft.Network/publicIPAddresses", max: 0 } }, control_refs: [] } as any, "j.duduka", { lifecycle: "adopted" } as any);
  const run = evaluateAll("test");
  assert.deepEqual(run.rule_errors, []);
  const of = (sid: string) => (db.prepare("SELECT f.*, e.name app FROM findings f JOIN elements e ON e.id=f.application_id WHERE f.standard_id=? AND f.status='open'").all(sid) as any[]).map((f) => f.app).sort();
  // streferralattach is public storage on the critical Referral API; stpharmacyfiles is public too but Pharmacy is unclassified
  assert.deepEqual(of(res.id), ["Referral API"]);
  assert.deepEqual(of(appRule.id), [], "no regulated application owns a public IP");
});

test("the business-service map: each service, the applications behind it and their regions and shared services", async () => {
  const r = await call("GET", "/business-services", "a.uditor");
  assert.equal(r.status, 200);
  const admit = r.body.services.find((s: any) => s.name === "Admit and discharge patients");
  assert.equal(admit.kind, "ibs"); assert.equal(admit.regulated, true);
  assert.deepEqual(admit.applications.map((a: any) => a.name), ["PatientFlow"]);
  assert.ok(admit.resources >= 7); assert.deepEqual(admit.regions, ["uksouth"]);
  assert.ok(admit.shared_services.some((s: any) => /hub/i.test(s.name)), JSON.stringify(admit.shared_services));
  assert.ok(r.body.unclassified.some((a: any) => a.name === "Pharmacy"));
  assert.equal(r.body.counts.applications, apps.size); assert.ok(r.body.counts.critical >= 3);
  assert.ok(r.body.services[0].regulated, "regulated services list first");
});

test("the DORA register takes criticality and the function name from the classification", async () => {
  const r = await call("GET", "/exports/dora-roi.csv", "a.uditor");
  assert.equal(r.status, 200);
  const lines = String(r.body).split("\n");
  const pf = lines.filter((l) => l.includes(apps.get("PatientFlow")!));
  assert.ok(pf.length > 0 && pf.every((l) => l.includes("Admit and discharge patients") && l.includes("Critical or important")), pf[0]);
  const intra = lines.find((l) => l.includes(apps.get("Intranet")!))!;
  assert.ok(intra.includes("Not critical or important"));
  const appt = lines.find((l) => l.includes(apps.get("Appointments")!))!;
  assert.ok(!/critical or important|undefined/i.test(appt), "an important tier is not asserted either way: the entity decides");
  const ph = lines.find((l) => l.includes(apps.get("Pharmacy")!))!;
  assert.ok(!ph.includes("critical or important"), "nobody classified it: the cell stays blank");
});

test("the evidence pack carries each application's classification", async () => {
  const r = await call("GET", "/evidence-pack", "a.uditor");
  const pf = r.body.applications.find((a: any) => a.name === "PatientFlow");
  assert.equal(pf.classification.criticality, "critical"); assert.equal(pf.classification.verification, "verified");
});
