import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The legacy register: lifecycle states from support dates, components matched from collected facts (never guessed),
// a person's correction with a reason, the yearly legacy assessment (DORA Art. 8(7)) going stale when a new legacy
// component appears, the `lifecycle` and `assessmentCurrent` rule ops, a refresh that keeps what fails, and the
// optional AI draft that stores nothing.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "archigov-lifecycle-"));
delete process.env.AUTH_MODE;
delete process.env.LLM_BASE_URL; delete process.env.LLM_MODEL;
const { db, migrate, getSetting } = await import("../src/db.js");
await migrate();
const { seedDemo } = await import("../src/seed.js");
seedDemo("test");
const { seedBoards } = await import("../src/boards/seed.js");
seedBoards("test");
const { stateOfCycle, matchComponents, lifecycleOf, resetLifecycleCache } = await import("../src/lifecycle.js");
const { evaluateAll } = await import("../src/rules.js");
const { createArtefact } = await import("../src/artefacts.js");
const { Hono } = await import("hono");
const { ZodError } = await import("zod");
const { api } = await import("../src/routes.js");
const app = new Hono();
app.route("/", api);
app.onError((err, c) => err instanceof ZodError ? c.json({ error: "invalid_request", issues: err.issues }, 400) : c.json({ error: err.message }, (err as any).status >= 400 && (err as any).status < 600 ? (err as any).status : 500));
const call = async (method: string, p: string, user: string, body?: any) => { const r = await app.request(p, { method, headers: { "x-user": user, "content-type": "application/json" }, body: body !== undefined ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
const apps = new Map((db.prepare("SELECT id, name FROM elements WHERE type='application' AND deleted_at IS NULL").all() as any[]).map((a) => [a.name, a.id]));
const res = (name: string) => (db.prepare("SELECT id FROM elements WHERE type='resource' AND name=?").get(name) as any).id;
const el = (props: Record<string, unknown>, subtype: string) => ({ id: "x", type: "resource", subtype, name: "x", props, tags: {} } as any);
const realFetch = globalThis.fetch;

test("states: extended inside a paid window, end of life after it, ending within the warning window", () => {
  const today = "2026-10-15";
  assert.equal(stateOfCycle({ cycle: "a", eol: "2023-10-10", extended: "2026-10-13" }, today, 365), "end_of_life");
  assert.equal(stateOfCycle({ cycle: "a", eol: "2026-07-14", extended: "2029-07-17" }, today, 365), "extended");
  assert.equal(stateOfCycle({ cycle: "a", eol: "2027-01-12" }, today, 365), "ending");
  assert.equal(stateOfCycle({ cycle: "a", eol: "2027-01-12" }, today, 30), "supported");
  assert.equal(stateOfCycle({ cycle: "a", eol: true }, today, 365), "end_of_life");
  assert.equal(stateOfCycle({ cycle: "a" }, today, 365), "supported", "no published end of support is not an end of support");
});

test("matching reads only what collection holds: image sku/offer, runtime stack, engine and Kubernetes versions", () => {
  const m = (props: any, t: string) => matchComponents(el(props, t)).map((x) => `${x.product}:${x.key}`);
  assert.deepEqual(m({ osSku: "2012-R2-Datacenter" }, "Microsoft.Compute/virtualMachines"), ["windows-server:2012-r2"]);
  assert.deepEqual(m({ storageProfile_imageReference_offer: "sql2019-ws2019", storageProfile_imageReference_sku: "enterprise" }, "Microsoft.Compute/virtualMachines"), ["mssqlserver:2019", "windows-server:2019"]);
  assert.deepEqual(m({ storageProfile_imageReference_offer: "0001-com-ubuntu-server-jammy", storageProfile_imageReference_sku: "22_04-lts-gen2" }, "Microsoft.Compute/virtualMachines"), ["ubuntu:22.04"]);
  assert.deepEqual(m({ siteConfig_linuxFxVersion: "DOTNETCORE|3.1" }, "Microsoft.Web/sites"), ["dotnet:3.1"]);
  assert.deepEqual(m({ siteConfig_linuxFxVersion: "NODE|18-lts" }, "Microsoft.Web/sites"), ["nodejs:18"]);
  assert.deepEqual(m({ siteConfig_linuxFxVersion: "JAVA|17-java17" }, "Microsoft.Web/sites"), ["microsoft-build-of-openjdk:17"]);
  assert.deepEqual(m({ version: "11" }, "Microsoft.DBforPostgreSQL/flexibleServers"), ["postgresql:11"]);
  assert.deepEqual(m({ kubernetesVersion: "1.27.3" }, "Microsoft.ContainerService/managedClusters"), ["azure-kubernetes-service:1.27"]);
  assert.deepEqual(m({ sku: "Standard_LRS" }, "Microsoft.Storage/storageAccounts"), [], "an untracked type names nothing");
  const sql = lifecycleOf(el({ software: "SQL Server 2016" }, "Microsoft.Compute/virtualMachines"));
  assert.equal(sql.components[0].cycle, "13.0-sp3"); assert.match(sql.components[0].method, /latest service pack assumed/);
  const none = lifecycleOf(el({ siteConfig_ftpsState: "Disabled" }, "Microsoft.Web/sites"));
  assert.equal(none.tracked, true); assert.equal(none.state, "unknown", "a tracked resource without a version fact is unknown, never supported");
});

test("the demo register: end of life, extended support, the unmatched web app, and one current assessment", async () => {
  const r = await call("GET", "/lifecycle", "a.uditor");
  assert.equal(r.status, 200);
  assert.equal(r.body.snapshot.source, "endoflife.date"); assert.equal(r.body.snapshot.licence, "MIT");
  const w2012 = r.body.components.find((c: any) => c.key === "windows-server:2012-r2");
  assert.equal(w2012.state, "end_of_life"); assert.deepEqual(w2012.applications.map((a: any) => a.name), ["Pharmacy"]);
  assert.equal(r.body.components.find((c: any) => c.product === "mssqlserver").state, "extended");
  assert.ok(r.body.unmatched.some((u: any) => u.name === "app-appointments"));
  const byName = new Map(r.body.applications.map((a: any) => [a.name, a]));
  assert.equal((byName.get("Finance ERP") as any).status, "current", "the seed's assessment covers SQL Server 2016");
  assert.equal((byName.get("Pharmacy") as any).status, "due");
  assert.equal((byName.get("Identity Platform") as any).status, "not_needed", "ending is not legacy yet");
  assert.ok(r.body.due >= 4);
});

test("a person corrects a resource's components with a reason; reset hands them back to the facts", async () => {
  const id = res("app-appointments");
  const body = { components: [{ product: "dotnet", cycle: "6" }], reason: "Runs .NET 6 on Windows; confirmed with the team." };
  for (const u of ["ops.admin", "a.uditor"]) assert.equal((await call("PUT", `/resources/${id}/lifecycle`, u, body)).status, 403, u);
  assert.equal((await call("PUT", `/resources/${id}/lifecycle`, "s.patel", { ...body, reason: "short" })).status, 400);
  assert.equal((await call("PUT", `/resources/${id}/lifecycle`, "s.patel", { ...body, components: [{ product: "cobol", cycle: "1" }] })).status, 400);
  assert.equal((await call("PUT", `/resources/${id}/lifecycle`, "s.patel", { ...body, components: [{ product: "dotnet", cycle: "99" }] })).status, 400);
  const r = await call("PUT", `/resources/${id}/lifecycle`, "s.patel", body);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.origin, "human"); assert.equal(r.body.state, "end_of_life"); assert.equal(r.body.components[0].method, "set by a person");
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action='lifecycle:set' AND entity_id=?").get(id));
  const reg = await call("GET", "/lifecycle", "a.uditor");
  assert.ok(!reg.body.unmatched.some((u: any) => u.name === "app-appointments"));
  assert.equal((await call("POST", `/resources/${id}/lifecycle/reset`, "s.patel")).status, 200);
  assert.equal((await call("POST", `/resources/${id}/lifecycle/reset`, "s.patel")).status, 409);
});

test("the yearly legacy assessment: an author records it; a new legacy component makes it stale", async () => {
  const id = apps.get("Pharmacy")!;
  const body = { result: "unsatisfactory", summary_md: "Windows Server 2012 R2 is past ESU; isolate and replace by Q1.", reference: "https://docs.example.org/pharmacy-legacy-2026" };
  for (const u of ["ops.admin", "a.uditor"]) assert.equal((await call("POST", `/applications/${id}/legacy-assessments`, u, body)).status, 403, u);
  assert.equal((await call("POST", `/applications/${id}/legacy-assessments`, "s.patel", { ...body, result: "fine" })).status, 400);
  assert.equal((await call("POST", `/applications/${id}/legacy-assessments`, "s.patel", { ...body, summary_md: "short" })).status, 400);
  assert.equal((await call("POST", `/applications/${id}/legacy-assessments`, "s.patel", { ...body, reference: "file://c:/x.docx" })).status, 400, "a reference is a link, never the document");
  const r = await call("POST", `/applications/${id}/legacy-assessments`, "s.patel", body);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, "current"); assert.deepEqual(r.body.last.components, ["windows-server:2012-r2"]);
  assert.ok(r.body.last.valid_until > new Date(Date.now() + 360 * 86_400_000).toISOString(), "valid for a year");
  // something new and legacy connected to the application: the assessment no longer covers it
  await call("PUT", `/resources/${res("stpharmacyfiles")}/lifecycle`, "s.patel", { components: [{ product: "windows-server", cycle: "2008-r2-sp1" }], reason: "A file share VM image was found behind this account." });
  const d = await call("GET", `/applications/${id}/legacy`, "a.uditor");
  assert.equal(d.body.status, "stale"); assert.deepEqual(d.body.new_since_last, ["windows-server:2008-r2-sp1"]);
  assert.equal(d.body.history.length, 1); assert.ok(d.body.template.includes("## Compensating controls"));
  await call("POST", `/resources/${res("stpharmacyfiles")}/lifecycle/reset`, "s.patel");
});

test("rules: lifecycle states per resource, lifecycle.* in where, assessmentCurrent per application; malformed ones are refused", () => {
  const eol = createArtefact({ kind: "standard", title: "Nothing past end of life", category: "Resilience", statement: "s", status: "adopt", severity: "high",
    rule: { scope: "resource", assert: { op: "lifecycle", states: ["end_of_life"] } }, control_refs: [] } as any, "j.duduka", { lifecycle: "adopted" } as any);
  const ending = createArtefact({ kind: "standard", title: "Web apps plan ahead", category: "Resilience", statement: "s", status: "adopt", severity: "low",
    rule: { scope: "resource", match: { type: "Microsoft.Web/sites", where: [{ path: "lifecycle.state", op: "eq", value: "ending" }] }, assert: { path: "name", op: "missing" } }, control_refs: [] } as any, "j.duduka", { lifecycle: "adopted" } as any);
  const assess = createArtefact({ kind: "policy", enforcement: "mandatory", title: "Legacy assessed yearly", category: "Governance", statement: "s", status: "adopt", severity: "high",
    rule: { scope: "application", assert: { op: "assessmentCurrent", kind: "legacy" } }, control_refs: [] } as any, "j.duduka", { lifecycle: "adopted" } as any);
  assert.throws(() => createArtefact({ kind: "standard", title: "Bad lifecycle rule", category: "Resilience", statement: "s", status: "adopt", severity: "low",
    rule: { scope: "resource", assert: { op: "lifecycle", states: ["ancient"] } }, control_refs: [] } as any, "j.duduka", { lifecycle: "adopted" } as any), /lifecycle states/);
  assert.throws(() => createArtefact({ kind: "policy", enforcement: "mandatory", title: "No kind", category: "Governance", statement: "s", status: "adopt", severity: "low",
    rule: { scope: "application", assert: { op: "assessmentCurrent" } }, control_refs: [] } as any, "j.duduka", { lifecycle: "adopted" } as any), /needs a kind/);
  const run = evaluateAll("test");
  assert.deepEqual(run.rule_errors, []);
  const open = (sid: string) => (db.prepare("SELECT f.message, e.name app FROM findings f LEFT JOIN elements e ON e.id=f.application_id WHERE f.standard_id=? AND f.status='open'").all(sid) as any[]);
  const eolApps = new Set(open(eol.id).map((f) => f.app));
  assert.ok(eolApps.has("Pharmacy") && eolApps.has("Referral API") && !eolApps.has("Finance ERP"), [...eolApps].join(","));
  assert.ok(open(eol.id).some((f) => /windows-server 2012-r2/.test(f.message)), open(eol.id)[0]?.message);
  assert.deepEqual(open(ending.id).map((f) => f.app).sort(), ["Identity Platform", "PatientFlow"], "dotnet 8 is ending");
  const due = new Set(open(assess.id).map((f) => f.app));
  assert.ok(!due.has("Finance ERP") && !due.has("Pharmacy") && due.has("Referral API") && !due.has("Identity Platform"), [...due].join(","));
});

test("refresh: the platform admin's act; a product that fails keeps its data", async () => {
  assert.equal((await call("POST", "/lifecycle/refresh", "s.patel")).status, 403, "an author does not refresh shared reference data");
  globalThis.fetch = (async (url: any) => {
    if (String(url).endsWith("/windows-server.json")) return { ok: true, status: 200, json: async () => [{ cycle: "2012-r2", releaseLabel: "Windows Server 2012 R2", eol: "2030-01-01", extendedSupport: false }] } as any;
    return { ok: false, status: 503, json: async () => ({}) } as any;
  }) as any;
  try {
    const r = await call("POST", "/lifecycle/refresh", "ops.admin");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.failed.includes("dotnet") && !r.body.failed.includes("windows-server"));
    const stored = JSON.parse(getSetting("lifecycle.snapshot")!);
    assert.equal(stored.products["windows-server"].cycles.length, 1); assert.ok(stored.products.dotnet.cycles.length > 5, "a failed product keeps its previous cycles");
    const reg = await call("GET", "/lifecycle", "a.uditor");
    assert.equal(reg.body.components.find((c: any) => c.key === "windows-server:2012-r2").state, "supported");
    assert.equal(reg.body.snapshot.refreshed, true);
  } finally { globalThis.fetch = realFetch; db.prepare("DELETE FROM settings WHERE key='lifecycle.snapshot'").run(); resetLifecycleCache(); }
});

test("the AI draft is optional, stores nothing, and the evidence pack carries each application's legacy standing", async () => {
  const id = apps.get("Referral API")!;
  assert.equal((await call("POST", `/applications/${id}/legacy-assessments/draft`, "s.patel")).status, 409, "assessment drafting is off");
  const pack = await call("GET", "/evidence-pack", "a.uditor");
  const erp = pack.body.applications.find((a: any) => a.name === "Finance ERP");
  assert.equal(erp.legacy.status, "current"); assert.equal(erp.legacy.assessment.result, "satisfactory_with_remarks");
  assert.ok(pack.body.applications.find((a: any) => a.name === "Referral API").legacy.components.includes("dotnet:6"));
});

test("collection keeps the version facts matching reads: a MySQL flexible server from Resource Graph is matched", async () => {
  const { normaliseResource } = await import("../src/azure/resourceGraph.js");
  const n = normaliseResource({ id: "/subscriptions/s/resourceGroups/rg/providers/Microsoft.DBforMySQL/flexibleServers/my1", name: "my1", type: "Microsoft.DBforMySQL/flexibleServers", location: "uksouth", properties: { version: "8.0.21", network: { publicNetworkAccess: "Disabled" } } });
  assert.equal(n.props.version, "8.0.21"); assert.equal(n.props.publicAccess, false);
  assert.deepEqual(matchComponents(el(n.props, n.type)).map((x) => `${x.product}:${x.key}`), ["mysql:8.0"]);
});
