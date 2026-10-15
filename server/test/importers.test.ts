import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "archigov-import-"));
const { migrate, db } = await import("../src/db.js");
await migrate();
const { parseCsv, csvTemplate, importResourcesCsv, importRelationsCsv, importArtefactsCsv } = await import("../src/importers/csv.js");
const { parseArchimate, importArchimate } = await import("../src/importers/archimate.js");

test("parseCsv: quotes, doubled quotes, embedded commas/newlines, CRLF", () => {
  const rows = parseCsv('a,b,c\r\n1,"x, y","say ""hi"""\n2,"multi\nline",z\n');
  assert.deepEqual(rows, [["a", "b", "c"], ["1", "x, y", 'say "hi"'], ["2", "multi\nline", "z"]]);
});

test("templates parse back to their own columns", () => {
  assert.deepEqual(parseCsv(csvTemplate("resources"))[0], ["id", "name", "type", "location", "resourceGroup", "subscriptionId", "tags", "properties", "dependsOn"]);
  assert.deepEqual(parseCsv(csvTemplate("relations"))[0], ["from_ref", "to_ref", "type"]);
  assert.deepEqual(parseCsv(csvTemplate("artefacts"))[0], ["kind", "title", "category", "statement", "rationale", "control_refs", "rule_json", "enforcement", "severity", "status", "context", "solution", "applicability"]);
});

test("importArtefactsCsv: the template imports as drafts; bad kinds, bad rules and missing narratives are reported by line", () => {
  const r = importArtefactsCsv(csvTemplate("artefacts"), "test", "template.csv");
  assert.equal(r.created, 2); assert.deepEqual(r.errors, []); assert.equal(r.lifecycle, "draft");
  const rows = db.prepare("SELECT code, kind, lifecycle, enforcement, context FROM standards WHERE code IN (?, ?) ORDER BY code").all(...r.codes) as any[];
  assert.deepEqual(rows.map((x) => [x.kind, x.lifecycle]), [["pattern", "draft"], ["policy", "draft"]]);
  assert.equal(rows.find((x) => x.kind === "policy").enforcement, "mandatory");
  const bad = ["kind,title,statement,rule_json,enforcement", "gadget,Nope,x,,", 'standard,Broken rule,x,"{""scope"":""resource"",""assert"":{""op"":""bogus""}}",', "pattern,No narrative,x,,", "policy,No enforcement,x,,"].join("\n");
  const b = importArtefactsCsv(bad, "test");
  assert.equal(b.created, 0); assert.deepEqual(b.errors.map((e) => e.line), [2, 3, 4, 5]);
  assert.match(b.errors[0].message, /kind must be one of/); assert.match(b.errors[1].message, /unknown assert op/); assert.match(b.errors[2].message, /context and a solution/); assert.match(b.errors[3].message, /mandatory|recommended/);
});

test("importResourcesCsv: good rows ingest, bad rows are reported by line, re-import is idempotent", () => {
  const csv = [
    "id,name,type,location,resourceGroup,subscriptionId,tags,properties",
    '/subscriptions/s1/resourcegroups/rg-billing-prod/providers/microsoft.web/sites/app-billing,app-billing,Microsoft.Web/sites,uksouth,rg-billing-prod,s1,app=billing;owner=finance,"{""httpsOnly"":true,""minTlsVersion"":""1.2""}"',
    '/subscriptions/s1/resourcegroups/rg-billing-prod/providers/microsoft.sql/servers/sql-billing,sql-billing,Microsoft.Sql/servers,uksouth,rg-billing-prod,s1,app=billing;owner=finance,"{""publicAccess"":false}"',
    "/subscriptions/s1/resourcegroups/rg-billing-prod/providers/microsoft.keyvault/vaults/kv-billing,kv-billing,Microsoft.KeyVault/vaults,uksouth,rg-billing-prod,s1,app=billing,not-json",
    ",missing-id,Microsoft.Web/sites,,,,,",
  ].join("\n");
  const r = importResourcesCsv(csv, "test", "billing.csv");
  assert.equal(r.created, 2); assert.equal(r.errors.length, 2);
  assert.deepEqual(r.errors.map((e) => e.line), [4, 5]);
  assert.match(r.errors[0].message, /JSON/);
  const app = db.prepare("SELECT * FROM elements WHERE type='application' AND name='Billing'").get() as any;
  assert.ok(app, "application inferred from the app tag");
  const again = importResourcesCsv(csv, "test", "billing.csv");
  assert.equal(again.created, 0); assert.equal(again.unchanged, 2); assert.equal(again.source_id, r.source_id);
  const src = db.prepare("SELECT * FROM sources WHERE id=?").get(r.source_id) as any;
  assert.equal(src.kind, "csv"); assert.equal(src.status, "ok");
});

test("importRelationsCsv: links known refs, reports unknown ones", () => {
  const csv = [
    "from_ref,to_ref,type",
    "/subscriptions/s1/resourcegroups/rg-billing-prod/providers/microsoft.web/sites/app-billing,/subscriptions/s1/resourcegroups/rg-billing-prod/providers/microsoft.sql/servers/sql-billing,depends_on",
    "/subscriptions/s1/resourcegroups/rg-billing-prod/providers/microsoft.web/sites/app-billing,/nope,depends_on",
  ].join("\n");
  const r = importRelationsCsv(csv, "test", "billing.csv");
  assert.equal(r.created, 1); assert.equal(r.errors.length, 1); assert.match(r.errors[0].message, /unknown to_ref/);
  assert.equal(importRelationsCsv(csv, "test", "billing.csv").unchanged, 1);
});

const EXCHANGE = `<?xml version="1.0" encoding="UTF-8"?>
<model xmlns="http://www.opengroup.org/xsd/archimate/3.0/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" identifier="id-model">
  <name xml:lang="en">Claims platform</name>
  <elements>
    <element identifier="id-app-1" xsi:type="ApplicationComponent"><name xml:lang="en">Claims Portal</name></element>
    <element identifier="id-app-2" xsi:type="ApplicationComponent"><name xml:lang="en">Policy Admin</name></element>
    <element identifier="id-node-1" xsi:type="Node"><name xml:lang="en">web-claims-01</name></element>
    <element identifier="id-sw-1" xsi:type="SystemSoftware"><name xml:lang="en">PostgreSQL 16</name></element>
    <element identifier="id-actor" xsi:type="BusinessActor"><name xml:lang="en">Claims handler</name></element>
  </elements>
  <relationships>
    <relationship identifier="id-r1" source="id-node-1" target="id-app-1" xsi:type="Realization"/>
    <relationship identifier="id-r2" source="id-sw-1" target="id-node-1" xsi:type="Assignment"/>
    <relationship identifier="id-r3" source="id-app-2" target="id-app-1" xsi:type="Serving"><name xml:lang="en">policy lookup</name></relationship>
    <relationship identifier="id-r4" source="id-actor" target="id-app-1" xsi:type="Association"/>
  </relationships>
</model>`;

test("parseArchimate: exchange format and Archi native format", () => {
  const p = parseArchimate(EXCHANGE);
  assert.equal(p.name, "Claims platform");
  assert.deepEqual(p.elements.map((e) => e.type), ["ApplicationComponent", "ApplicationComponent", "Node", "SystemSoftware", "BusinessActor"]);
  assert.equal(p.elements[0].name, "Claims Portal");
  assert.equal(p.relationships.length, 4); assert.equal(p.relationships[2].type, "Serving");
  const archi = `<archimate:model xmlns:archimate="http://www.archimatetool.com/archimate" name="Native" id="m1"><folder name="Application" type="application">
    <element xsi:type="archimate:ApplicationComponent" name="Billing Engine" id="e1"/></folder><folder name="Relations" type="relations">
    <element xsi:type="archimate:ServingRelationship" id="r1" source="e1" target="e2"/></folder></archimate:model>`;
  const q = parseArchimate(archi);
  assert.equal(q.name, "Native"); assert.deepEqual(q.elements, [{ id: "e1", type: "ApplicationComponent", name: "Billing Engine" }]);
  assert.deepEqual(q.relationships, [{ id: "r1", type: "Serving", source: "e1", target: "e2" }]);
});

test("importArchimate: applications, resources, dependencies, skipped layers", () => {
  const r = importArchimate(EXCHANGE, "test", "claims.xml");
  assert.equal(r.elements.applications, 2); assert.equal(r.elements.resources, 2); assert.equal(r.elements.skipped, 1);
  assert.ok(r.relations >= 2, `relations ${r.relations}`); // Policy Admin → Claims Portal, PostgreSQL → node
  assert.ok(r.warnings.some((w) => /BusinessActor/.test(w)));
  const apps = db.prepare("SELECT name, origin, verification FROM elements WHERE type='application' AND source_ref LIKE 'archimate:%' ORDER BY name").all() as any[];
  assert.deepEqual(apps.map((a) => a.name), ["Claims Portal", "Policy Admin"]);
  assert.ok(apps.every((a) => a.origin === "derived" && a.verification === "unverified"));
  const node = db.prepare("SELECT * FROM elements WHERE type='resource' AND name='web-claims-01'").get() as any;
  assert.ok(node); assert.equal(JSON.parse(node.tags_json).app, "Claims Portal");
  const link = db.prepare("SELECT count(*) c FROM relations r JOIN elements a ON a.id=r.to_id WHERE r.from_id=? AND r.type='belongs_to' AND a.name='Claims Portal'").get(node.id) as any;
  assert.equal(link.c, 1, "the node belongs to the application it realises");
  const again = importArchimate(EXCHANGE, "test", "claims.xml");
  assert.equal(again.elements.applications, 0); assert.equal(again.source_id, r.source_id);
  assert.throws(() => importArchimate("<html></html>", "test"), /Not an ArchiMate/);
});

test("importArchimate: motivation elements become draft principles and policies; requirements are reported, not imported", () => {
  const MOTIVATION = `<model xmlns="http://www.opengroup.org/xsd/archimate/3.0/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" identifier="id-m2"><name>Governance model</name><elements>
    <element identifier="id-p1" xsi:type="Principle"><name>Buy before build</name></element>
    <element identifier="id-c1" xsi:type="Constraint"><name>Patient data stays in the UK</name></element>
    <element identifier="id-r1" xsi:type="Requirement"><name>Support 500 concurrent users</name></element>
  </elements></model>`;
  const r = importArchimate(MOTIVATION, "test", "governance.xml");
  assert.deepEqual(r.artefacts, { principle: 1, policy: 1, skipped: 0 });
  assert.ok(r.warnings.some((w) => /Requirement/.test(w)), r.warnings);
  const pol = db.prepare("SELECT kind, lifecycle, enforcement, origin FROM standards WHERE title='Patient data stays in the UK'").get() as any;
  assert.deepEqual(pol, { kind: "policy", lifecycle: "draft", enforcement: "mandatory", origin: "human" });
  assert.equal((db.prepare("SELECT kind FROM standards WHERE title='Buy before build'").get() as any).kind, "principle");
  const again = importArchimate(MOTIVATION, "test", "governance.xml");
  assert.deepEqual(again.artefacts, { principle: 0, policy: 0, skipped: 2 }, "re-import is a no-op for the catalogue");
});
