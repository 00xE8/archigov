import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "archigov-exports-"));
delete process.env.AUTH_MODE;
const { migrate, db } = await import("../src/db.js");
await migrate();
const { seedDemo } = await import("../src/seed.js");
const { evaluateAll } = await import("../src/rules.js");
const { Hono } = await import("hono");
const { exportsRoutes } = await import("../src/routes/exports.js");
const { system } = await import("../src/routes/system.js");
const { buildEvidencePack, signAndPersist, verifyPack, ensureSigningKeys } = await import("../src/evidence-pack.js");

seedDemo("test");
evaluateAll("test");
const app = new Hono();
app.route("/", exportsRoutes);
app.route("/", system);

// wording that would turn evidence into an assertion; the smoke test uses the same pattern
const ASSERTION = /\b(is|are|was|were|fully|now)\s+compliant\b|compliance\s+(passed|achieved|confirmed)|\bcertified\b|\bassured\b/i;
// OSCAL datatypes: v4/v5 uuid, NCName-ish token, date-time with an explicit zone
const UUID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[45][0-9A-Fa-f]{3}-[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}$/;
const TOKEN = /^[A-Za-z_][A-Za-z0-9._-]*$/;
const ZONED = /(Z|[+-]\d{2}:\d{2})$/;

test("OSCAL export: required 1.1.2 structure incl. reviewed-controls, datatypes, findings per checkable standard, no assurance wording", async () => {
  const r = await app.request("/exports/oscal");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-disposition") || "", /attachment; filename="archigov-oscal-assessment-results\.json"/);
  const doc: any = await r.json();
  const ar = doc["assessment-results"];
  assert.match(ar.uuid, UUID);
  assert.ok(ar.metadata?.title && ar.metadata.version && ar.metadata["oscal-version"] === "1.1.2"); assert.match(ar.metadata["last-modified"], ZONED);
  assert.ok(ar["import-ap"]?.href);
  const res = ar.results[0];
  assert.match(res.uuid, UUID); assert.ok(res.title && res.description); assert.match(res.start, ZONED);
  const sel = res["reviewed-controls"]?.["control-selections"];
  assert.ok(Array.isArray(sel) && sel.length >= 1, "reviewed-controls.control-selections is required");
  const included = sel[0]["include-controls"];
  assert.ok(included.length > 0 && included.every((c: any) => TOKEN.test(c["control-id"])), "control-ids are tokens");
  assert.ok(res.observations.length > 0 && res.findings.length > 0);
  for (const o of res.observations) { assert.match(o.uuid, UUID); assert.ok(o.description); assert.ok(Array.isArray(o.methods) && o.methods.length >= 1 && o.methods.includes("TEST")); assert.match(o.collected, ZONED); }
  const obsIds = new Set(res.observations.map((o: any) => o.uuid));
  for (const f of res.findings) {
    assert.match(f.uuid, UUID); assert.ok(f.title && f.description && f.target);
    assert.equal(f.target.type, "objective-id"); assert.match(f.target["target-id"], TOKEN); assert.match(f.target["target-id"], /^(STD|PRN|PAT|POL)-/);
    assert.ok(["satisfied", "not-satisfied"].includes(f.target.status.state));
    assert.ok(included.some((c: any) => c["control-id"] === f.target["target-id"]), "every finding targets a reviewed control");
    for (const ro of f["related-observations"] || []) { assert.match(ro["observation-uuid"], UUID); assert.ok(obsIds.has(ro["observation-uuid"]), "related observations resolve"); }
  }
  assert.ok(res.findings.some((f: any) => f.target.status.state === "not-satisfied"), "the demo has open findings");
  assert.ok(!ASSERTION.test(JSON.stringify(doc)), "never asserts compliance");
  const checkable = (db.prepare("SELECT count(*) c FROM standards WHERE rule_json IS NOT NULL").get() as any).c;
  assert.equal(res.findings.length, checkable, "one finding per checkable standard");
  // application scope
  const app1 = db.prepare("SELECT id FROM elements WHERE type='application' AND deleted_at IS NULL LIMIT 1").get() as any;
  const r2 = await app.request(`/exports/oscal?application=${app1.id}`);
  assert.equal(r2.status, 200);
  assert.equal((await app.request("/exports/oscal?application=nope")).status, 404);
});

test("DORA register CSV: labelled as simplified, ITS column codes in the header, one row per function × service family × region, nothing invented", async () => {
  const { DORA_COLUMNS } = await import("../src/routes/exports.js");
  const r = await app.request("/exports/dora-roi.csv");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") || "", /text\/csv/);
  const lines = (await r.text()).trim().split("\n");
  assert.ok(lines[0].startsWith("# Simplified register of information") && /B_05\.01/.test(lines[0]) && /B_02\.02/.test(lines[0]) && /NOT the official/.test(lines[0]));
  assert.equal(lines[1], DORA_COLUMNS.join(","));
  for (const code of ["B_06.01.0010", "B_06.01.0050", "B_05.01.0050", "B_02.02.0010", "B_02.02.0060", "B_02.02.0130", "B_02.02.0140", "B_02.02.0150", "B_02.02.0160", "B_02.02.0170", "B_02.02.0180", "B_07.01"]) assert.ok(lines[1].includes(code), `header carries ${code}`);
  const data = lines.slice(2).map((l) => l.split(","));
  assert.ok(data.length >= 8, `expected a row per function×service, got ${data.length}`);
  const col = (name: string) => DORA_COLUMNS.indexOf(name);
  for (const row of data) {
    assert.equal(row.length, DORA_COLUMNS.length);
    assert.match(row[col("B_06.01.0010_function_identifier")], /^F\d+$/);
    // the cloud platform, or a supplier named on the resources' tags (the demo's ERP vendor)
    assert.ok(["Microsoft", "Ledgerline"].includes(row[col("B_05.01.0050_provider_legal_name")]), row[col("B_05.01.0050_provider_legal_name")]);
    assert.equal(row[col("B_02.02.0060_type_of_ict_services")], "", "Annex III codes are not invented");
    assert.equal(row[col("B_05.01.0010_provider_identification_code")], "", "LEIs are not inferred");
    // substitutability only where an exit plan records it (the demo's PatientFlow plan), never inferred
    assert.ok(["", "Highly complex substitutability"].includes(row[col("B_07.01_substitutability")]), row[col("B_07.01_substitutability")]);
    assert.match(row[col("B_02.02.0130_country_of_provision")], /^([A-Z]{2})?$/, "ISO 3166-1 alpha-2 or blank");
  }
  assert.ok(data.some((row) => row[col("B_02.02.0130_country_of_provision")] === "GB" && row[col("B_02.02.0140_storage_of_data")] === "Yes" && row[col("B_02.02.0150_data_at_rest_country")] === "GB"));
  assert.ok(!ASSERTION.test(lines.join("\n")));
});

test("runs/:id carries the findings a run opened, resolved and reopened", async () => {
  const first = db.prepare("SELECT id FROM runs WHERE kind='evaluate' ORDER BY started_at ASC LIMIT 1").get() as any;
  const r = await app.request(`/runs/${first.id}`);
  assert.equal(r.status, 200);
  const run: any = await r.json();
  assert.ok(Array.isArray(run.changes.opened) && Array.isArray(run.changes.resolved) && Array.isArray(run.changes.reopened));
  assert.ok(run.changes.opened.length > 0, "the first evaluation opens the demo findings");
  const f = run.changes.opened[0];
  assert.ok(f.id && f.severity && f.standard_code && f.message);
  assert.equal((await app.request("/runs/does-not-exist")).status, 404);
});

test("evidence pack: hashed, chain-anchored, signed, and verifiable from the persisted file", async () => {
  ensureSigningKeys();
  const pack = signAndPersist(buildEvidencePack(null)!);
  assert.match(pack.hash, /^[0-9a-f]{64}$/); assert.ok(pack.signature && pack.public_key.includes("BEGIN PUBLIC KEY") && pack.chain_head && pack.chain_rows > 0 && pack.signed_at);
  const v = verifyPack(pack.hash);
  assert.deepEqual({ found: v.found, hash_ok: v.hash_ok, signature_ok: v.signature_ok, chain_ok: v.chain_ok, key_is_current: v.key_is_current }, { found: true, hash_ok: true, signature_ok: true, chain_ok: true, key_is_current: true });
  // tamper with the persisted file → hash and signature both fail
  const file = path.join(process.env.DATA_DIR!, "evidence-packs", `${pack.hash}.json`);
  const blob = JSON.parse(fs.readFileSync(file, "utf8")); blob.disclaimer = "Fully compliant."; fs.writeFileSync(file, JSON.stringify(blob));
  const t = verifyPack(pack.hash);
  assert.equal(t.hash_ok, false); assert.equal(t.signature_ok, false);
  assert.equal(verifyPack("0".repeat(64)).found, false);
  // the API shape
  const r = await app.request(`/evidence-pack/verify?hash=${pack.hash}`);
  assert.equal(r.status, 200); assert.equal((await r.json()).found, true);
  assert.equal((await app.request("/evidence-pack/verify?hash=xyz")).status, 400);
});
