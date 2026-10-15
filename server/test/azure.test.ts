import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "archigov-azure-"));
process.env.ARCHIGOV_FIXTURES = "1";
delete process.env.AZURE_SUBSCRIPTIONS;
const { migrate, db } = await import("../src/db.js");
await migrate();
const { normaliseResource, collectResourceGraph, listSubscriptions, RG_API_VERSION } = await import("../src/azure/resourceGraph.js");
const { mapAssessment, importDefender, metaCatalogue, DEFENDER_API_VERSION } = await import("../src/azure/defender.js");
const { mapPolicyState, importPolicy, POLICY_API_VERSION, policyStatesUrl } = await import("../src/azure/policy.js");
const { parseResetsAfter } = await import("../src/azure/client.js");
const { controlForDefender, controlForPolicy } = await import("../src/azure/controls.js");
const { RG_ROWS, FIXTURES, ASSESSMENT_KEYS } = await import("../src/azure/fixtures.js");
const { ensureSource } = await import("../src/sync.js");
const { ingestResources } = await import("../src/model.js");

test("api versions are pinned to the documented ones", () => {
  assert.equal(RG_API_VERSION, "2024-04-01");
  assert.equal(DEFENDER_API_VERSION, "2021-06-01");
  assert.equal(POLICY_API_VERSION, "2024-10-01");
  assert.match(policyStatesUrl("s", "ComplianceState eq 'NonCompliant'"), /policyStates\/latest\/queryResults\?api-version=2024-10-01&\$top=1000&\$filter=ComplianceState%20eq%20'NonCompliant'$/);
});

test("normaliseResource: ARM property names → the props the rules consume", () => {
  const st = normaliseResource(RG_ROWS[0]);
  assert.equal(st.sourceRef, RG_ROWS[0].id.toLowerCase());
  assert.equal(st.props.publicAccess, true);          // allowBlobPublicAccess: true
  assert.equal(st.props.minTlsVersion, "1.0");        // minimumTlsVersion: "TLS1_0"
  assert.equal(st.props.kind, "StorageV2"); assert.equal(st.props.sku, "Standard_LRS");
  assert.equal(st.resourceGroup, "rg-claims-prod"); assert.equal(st.subscription, FIXTURES.subscription.id);
  assert.deepEqual(st.tags, { app: "claims", owner: "claims-team", env: "prod" });
  const web = normaliseResource(RG_ROWS[1]);
  assert.equal(web.props.httpsOnly, true); assert.equal(web.props.minTlsVersion, "1.2"); assert.equal(web.props.publicAccess, true);
  const vm = normaliseResource(RG_ROWS[5]);
  assert.equal(vm.props.osSku, "2012-R2-Datacenter"); assert.equal(vm.props.hardwareProfile_vmSize, "Standard_D2_v2");
  const kv = normaliseResource(RG_ROWS[3]);
  assert.equal(kv.props.enablePurgeProtection, false); assert.equal(kv.props.publicAccess, false);
  const vnet = normaliseResource(RG_ROWS[7]);
  assert.equal(vnet.props.kind, undefined, "empty kind is dropped"); assert.equal(vnet.props.sku, undefined);
  assert.equal(normaliseResource({ id: "/X", name: "x", type: "Microsoft.Unknown/thing", tags: null, properties: { a: 1 } }).props.a, undefined, "unknown types keep no raw properties");
});

test("collectResourceGraph: follows $skipToken across pages, stops when it is absent, de-duplicates, lower-cases ids", async () => {
  const rs = await collectResourceGraph();
  assert.equal(rs.length, RG_ROWS.length);
  assert.ok(rs.every((r) => r.sourceRef === r.sourceRef.toLowerCase()));
  const subs = await listSubscriptions();
  assert.deepEqual(subs, [{ id: FIXTURES.subscription.id, name: FIXTURES.subscription.name }]);
});

test("throttling header parser", () => {
  assert.equal(parseResetsAfter("00:00:03"), 3);
  assert.equal(parseResetsAfter("00:01:30.5"), 90.5);
  assert.equal(parseResetsAfter(null), 0);
});

test("control mapping: policy GUID first, then assessment key, then display name, then fallback", () => {
  assert.equal(controlForPolicy("4fa4b6c0-31ca-4c0d-b10d-24b96f62a751"), "storage-public-access");
  assert.equal(controlForPolicy("/providers/Microsoft.Authorization/policyDefinitions/0B60C0B2-2DC2-4E1C-B5C9-ABBED971DE53"), "kv-purge-protection");
  assert.equal(controlForPolicy("ffffffff-0000-0000-0000-000000000000"), "policy:ffffffff-0000-0000-0000-000000000000");
  assert.equal(controlForDefender({ key: "e1145ab1-eb4f-43d8-911b-36ddf771d13f", displayName: "anything" }), "system-updates");
  assert.equal(controlForDefender({ key: "x", policyDefinitionId: "/providers/Microsoft.Authorization/policyDefinitions/1b8ca024-1d5c-4dec-8995-b1a932b41780", displayName: "y" }), "db-public-network-access");
  assert.equal(controlForDefender({ displayName: "TLS should be updated to the latest version for API apps" }), "min-tls-1.2");
  assert.equal(controlForDefender({ displayName: "Kubernetes API server should be configured with restricted access" }), "defender:kubernetes-api-server-should-be-configured-with-restricted-access");
});

test("mapAssessment: list items joined with the assessmentMetadata catalogue", () => {
  const items = FIXTURES.defenderAssessments(); const cat = metaCatalogue(FIXTURES.assessmentMetadata());
  const storage = mapAssessment(items[0], cat)!;
  assert.equal(storage.control, "storage-public-access"); assert.equal(storage.state, "fail"); assert.equal(storage.severity, "medium");
  assert.equal(storage.resourceRef, RG_ROWS[0].id.toLowerCase());
  assert.equal((storage.detail as any).policy_definition_id, "/providers/Microsoft.Authorization/policyDefinitions/4fa4b6c0-31ca-4c0d-b10d-24b96f62a751");
  assert.equal(mapAssessment(items[1], cat)!.control, "db-public-network-access");
  assert.equal(mapAssessment(items[2], cat)!.control, "web-https-only"); assert.equal(mapAssessment(items[2], cat)!.state, "pass");
  assert.equal(mapAssessment(items[3], cat)!.control, "min-tls-1.2");
  const su = mapAssessment(items[4], cat)!; assert.equal(su.control, "system-updates"); assert.equal(su.severity, "high"); assert.equal(items[4].name, ASSESSMENT_KEYS.systemUpdates);
  assert.equal(mapAssessment(items[5], cat)!.control, "cognitive-public-access");
  const na = mapAssessment(items[6], cat)!; assert.equal(na.state, "unknown"); assert.equal(na.control, "defender:private-endpoint-connections-on-azure-sql-database-should-be-enabled");
  const noMeta = mapAssessment(items[7], cat)!; assert.match(noMeta.control, /^defender:kubernetes-api-server/); assert.equal(noMeta.severity, null);
  assert.equal(mapAssessment(items[0])!.control, "storage-public-access", "without a catalogue the display name still maps");
  assert.equal(mapAssessment({ name: "x", properties: { resourceDetails: { source: "OnPremise", machineName: "m" }, displayName: "y", status: { code: "Unhealthy" } } }), null);
  assert.equal(mapAssessment({ name: "x", properties: { resourceDetails: { source: "Azure", Id: "/UPPER/Case/Id" }, displayName: "y", status: { code: "Unhealthy" } } })!.resourceRef, "/upper/case/id");
});

test("mapPolicyState: built-in definition GUIDs → control keys; unknown → policy:<guid>; complianceState drives state", () => {
  const items = FIXTURES.policyStates();
  assert.equal(mapPolicyState(items[0])!.control, "kv-purge-protection"); assert.equal(mapPolicyState(items[0])!.state, "fail");
  assert.equal(mapPolicyState(items[1])!.control, "kv-soft-delete"); assert.equal(mapPolicyState(items[1])!.state, "pass");
  assert.equal(mapPolicyState(items[2])!.control, "min-tls-1.2");
  assert.equal(mapPolicyState(items[6])!.control, "cognitive-local-auth");
  assert.equal(mapPolicyState(items[7])!.control, "policy:0e246bcf-5f6f-4f87-bc6f-775d4712c7ea");
  assert.equal(mapPolicyState({ ...items[0], complianceState: "Exempt", isCompliant: true })!.state, "unknown", "isCompliant is ignored");
  assert.equal(mapPolicyState({}), null);
});

test("importDefender / importPolicy attach to known resources and report the unmatched ones", async () => {
  const src = ensureSource("azure");
  ingestResources(src.id, await collectResourceGraph(), "test");
  const d = await importDefender("test");
  assert.equal(d.fetched, 9); assert.equal(d.created, 8, `defender created ${d.created}`);
  assert.deepEqual(d.unmatched, [FIXTURES.unmatched.storage.toLowerCase()]);
  const p = await importPolicy("test");
  assert.equal(p.fetched, 9); assert.equal(p.created, 8, `policy created ${p.created}`);
  assert.deepEqual(p.unmatched, [FIXTURES.unmatched.vault.toLowerCase()]);
  const again = await importDefender("test");
  assert.equal(again.created, 0); assert.equal(again.unchanged + again.updated, d.created);
  const n = (db.prepare("SELECT count(*) c FROM evidence").get() as any).c;
  assert.equal(n, d.created + p.created);
  // controls that only Azure Policy built-ins produce never arrive from the Defender importer; App Service TLS is a real Defender assessment, storage TLS is Policy-only
  const policyOnly = db.prepare("SELECT DISTINCT source FROM evidence WHERE control IN ('kv-purge-protection','cognitive-local-auth','kv-soft-delete')").all() as any[];
  assert.deepEqual(policyOnly.map((s) => s.source), ["azure_policy"]);
  const storageTls = db.prepare("SELECT ev.source FROM evidence ev JOIN elements e ON e.id=ev.resource_id WHERE ev.control='min-tls-1.2' AND e.name='stclaimsdocs'").all() as any[];
  assert.deepEqual(storageTls.map((s) => s.source), ["azure_policy"]);
  const webTls = db.prepare("SELECT ev.source FROM evidence ev JOIN elements e ON e.id=ev.resource_id WHERE ev.control='min-tls-1.2' AND e.name='app-claims-api'").all() as any[];
  assert.deepEqual(webTls.map((s) => s.source), ["defender"]);
});
