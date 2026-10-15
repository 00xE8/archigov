import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "archigov-ado-"));
process.env.ARCHIGOV_FIXTURES = "1";
const { migrate, db } = await import("../src/db.js");
await migrate();
const { mapWorkItem, upsertWorkItem, stripHtml, fieldValue, adoSource, syncAdo, handleAdoHook } = await import("../src/ado/sync.js");
const { wiql, workItemsBatch, ADO_API_VERSION, ADO_SCOPE } = await import("../src/ado/client.js");
const { fixtureWorkItem, HOOK_SAMPLE } = await import("../src/ado/fixtures.js");

test("client constants match the documented API", () => {
  assert.equal(ADO_API_VERSION, "7.1");
  assert.equal(ADO_SCOPE, "https://app.vssps.visualstudio.com/.default");
});

test("stripHtml / fieldValue", () => {
  assert.equal(stripHtml("<div>Move <b>attachments</b><br/>to a service &amp; audit</div>"), "Move attachments\nto a service & audit");
  assert.equal(fieldValue({ "System.Title": { oldValue: "a", newValue: "b" } }, "System.Title"), "b");
  assert.equal(fieldValue({ "System.Title": "plain" }, "System.Title"), "plain");
});

test("mapWorkItem: ADO fields → work item row shape", () => {
  const m = mapWorkItem(fixtureWorkItem("1042")!);
  assert.equal(m.external_id, "1042"); assert.equal(m.type, "Epic"); assert.equal(m.state, "Active"); assert.equal(m.rev, 7);
  assert.deepEqual(m.tags, ["architecture-needed", "data"]);
  assert.equal(m.area, "Integration"); assert.match(m.description, /bulk export/); assert.doesNotMatch(m.description, /<b>/);
  assert.match(m.content_hash, /^[0-9a-f]{16}$/);
});

test("wiql + batch fixtures return the demo backlog through the real client", async () => {
  const q = await wiql("SELECT [System.Id] FROM WorkItems WHERE [System.State] <> 'Removed'");
  assert.ok(q.workItems.length >= 7);
  const items = await workItemsBatch(q.workItems.map((w) => w.id));
  assert.equal(items.length, q.workItems.length);
  assert.ok(items.every((w) => typeof w.rev === "number" && w.fields["System.Title"]));
});

test("upsertWorkItem: create → update → old revision ignored → material change against approved_hash", () => {
  const src = adoSource();
  assert.equal(src.kind, "ado", "no demo-ado row in this DB, so the ado source is created");
  const w = fixtureWorkItem("1051")!;
  const a = upsertWorkItem(src.id, w, "test"); assert.equal(a.outcome, "created"); assert.equal(a.material_change, false);
  const same = upsertWorkItem(src.id, w, "test"); assert.equal(same.outcome, "skipped_old_rev");
  const newer = { ...w, rev: w.rev + 1, fields: { ...w.fields, "System.Description": "<p>Kiosks with NHS login and offline mode.</p>" } };
  const b = upsertWorkItem(src.id, newer, "test"); assert.equal(b.outcome, "updated"); assert.equal(b.material_change, false, "nothing approved yet");
  // a review approved the item at this content; the next change is material
  db.prepare("UPDATE work_items SET approved_hash=content_hash WHERE id=?").run(b.id);
  const c = upsertWorkItem(src.id, { ...newer, rev: newer.rev + 1, fields: { ...newer.fields, "System.Description": "Kiosks, plus a payment terminal." } }, "test");
  assert.equal(c.outcome, "updated"); assert.equal(c.material_change, true);
  const row = db.prepare("SELECT material_change, rev FROM work_items WHERE id=?").get(c.id) as any;
  assert.equal(row.material_change, 1); assert.equal(row.rev, newer.rev + 1);
  const unchanged = upsertWorkItem(src.id, { ...newer, rev: newer.rev + 2, fields: { ...newer.fields, "System.Description": "Kiosks, plus a payment terminal." } }, "test");
  assert.equal(unchanged.outcome, "unchanged");
});

test("syncAdo backfills through WIQL → batch and records a run", async () => {
  const r = await syncAdo("test");
  assert.ok(r.ok, JSON.stringify(r));
  if (r.ok) { assert.ok(r.fetched >= 7); assert.ok(r.created + r.updated + r.unchanged + r.skipped_old_rev === r.fetched); }
  const run = db.prepare("SELECT * FROM runs WHERE kind='sync' ORDER BY started_at DESC LIMIT 1").get() as any;
  assert.equal(run.status, "done");
});

test("handleAdoHook: parses a workitem.updated payload, idempotent on rev", () => {
  const r1 = handleAdoHook(HOOK_SAMPLE, "hook");
  assert.equal(r1.ok, true); assert.equal(r1.external_id, "1042"); assert.ok(["updated", "created"].includes(r1.outcome));
  const r2 = handleAdoHook(HOOK_SAMPLE, "hook");
  assert.equal(r2.outcome, "skipped_old_rev");
  assert.throws(() => handleAdoHook({ eventType: "build.complete", resource: {} }), /unsupported eventType/);
  // v2-style payload: diffs under resource.fields, full item under resource.revision
  const v2 = { eventType: "workitem.updated", resource: { workItemId: 1042, rev: 99, fields: { "System.Description": { oldValue: "a", newValue: "<p>Final scope agreed.</p>" } }, revision: { id: 1042, rev: 99, fields: { ...HOOK_SAMPLE.resource.fields } } } };
  const r3 = handleAdoHook(v2, "hook"); assert.equal(r3.outcome, "updated");
  const row = db.prepare("SELECT description FROM work_items WHERE external_id='1042'").get() as any;
  assert.equal(row.description, "Final scope agreed.");
});
