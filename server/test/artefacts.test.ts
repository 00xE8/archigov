import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "archigov-artefacts-"));
const { migrate, db } = await import("../src/db.js");
await migrate();
const { ingestResources } = await import("../src/model.js");
const { createArtefact, updateArtefact, setArtefactLifecycle, retireArtefact, preReviewArtefact, dryRunArtefact, artefactById, kindCounts, importArtefacts } = await import("../src/artefacts.js");
const { evaluateAll } = await import("../src/rules.js");

test("codes are three digits per kind; kind requirements are enforced", () => {
  assert.equal(createArtefact({ kind: "standard", title: "S1", category: "T", statement: "s", control_refs: ["X 1"] }, "t").code, "STD-001");
  assert.equal(createArtefact({ kind: "principle", title: "P1", category: "T", statement: "p" }, "t").code, "PRN-001");
  assert.equal(createArtefact({ kind: "principle", title: "P2", category: "T", statement: "p" }, "t").code, "PRN-002");
  assert.throws(() => createArtefact({ kind: "pattern", title: "no narrative", category: "T", statement: "x" }, "t"), /context and a solution/);
  assert.throws(() => createArtefact({ kind: "policy", title: "no enforcement", category: "T", statement: "x" }, "t"), /mandatory|recommended/);
  assert.throws(() => createArtefact({ kind: "principle", title: "with rule", category: "T", statement: "x", rule: { scope: "application", assert: { op: "hasOwnerTag" } } }, "t"), /evidenced through reviews/);
  assert.throws(() => createArtefact({ kind: "standard", title: "bad rule", category: "T", statement: "x", rule: { scope: "resource", assert: { op: "bogus" } } }, "t"), (e: any) => e.status === 400 && /unknown assert op/.test(e.message));
  assert.equal(createArtefact({ kind: "pattern", title: "Pat", category: "T", statement: "x", context: "c", solution: "s" }, "t").code, "PAT-001");
  assert.equal(createArtefact({ kind: "policy", title: "Pol", category: "T", statement: "x", enforcement: "mandatory" }, "t").code, "POL-001");
  const counts = kindCounts();
  assert.deepEqual(counts.map((k) => [k.kind, k.count, k.adopted]), [["standard", 1, 0], ["principle", 2, 0], ["pattern", 1, 0], ["policy", 1, 0]]);
});

test("lifecycle: draft → in_review → adopted → revised draft v2 → adopted → retired", () => {
  const { id } = createArtefact({ kind: "policy", title: "Lifecycle policy", category: "T", statement: "v1", enforcement: "mandatory", control_refs: ["X 2"] }, "author");
  assert.equal(artefactById(id).lifecycle, "draft");
  setArtefactLifecycle(id, "in_review", "chair", { reviewId: "rev-1" });
  assert.equal(artefactById(id).review_id, "rev-1");
  const adopted = setArtefactLifecycle(id, "adopted", "chair", { reviewId: "rev-1" });
  assert.equal(adopted.lifecycle, "adopted"); assert.ok(adopted.adopted_at); assert.equal(adopted.review_id, null); assert.equal(adopted.version, 1);
  const edit = updateArtefact(id, { statement: "v2" }, "author");
  assert.deepEqual([edit.revised, edit.version, edit.lifecycle], [true, 2, "draft"]);
  assert.equal(updateArtefact(id, { statement: "v2" }, "author").revised, false, "an unchanged edit of a draft is not a revision");
  setArtefactLifecycle(id, "adopted", "chair");
  assert.throws(() => retireArtefact(createArtefact({ kind: "principle", title: "still draft", category: "T", statement: "x" }, "t").id, "chair"), /only an adopted/);
  assert.equal(retireArtefact(id, "chair").lifecycle, "retired");
  assert.throws(() => updateArtefact(id, { statement: "v3" }, "author"), /retired/);
  const trail = db.prepare("SELECT action FROM audit_log WHERE entity_id=? ORDER BY rowid").all(id).map((r: any) => r.action);
  assert.deepEqual(trail, ["create", "lifecycle_in_review", "lifecycle_adopted", "revised", "update", "lifecycle_adopted", "lifecycle_retired"]);
});

test("only adopted artefacts are evaluated, of any kind; dry run previews without writing", () => {
  ingestResources("src-test", [
    { sourceRef: "/s/rg-a/pip-a", name: "pip-a", type: "Microsoft.Network/publicIPAddresses", location: "uksouth", tags: { app: "alpha" }, props: {} },
    { sourceRef: "/s/rg-a/pip-gw", name: "pip-gw", type: "Microsoft.Network/publicIPAddresses", location: "uksouth", tags: { app: "alpha", purpose: "gateway" }, props: {} },
    { sourceRef: "/s/rg-a/web-a", name: "web-a", type: "Microsoft.Web/sites", location: "uksouth", tags: { app: "alpha" }, props: {} },
  ] as any, "test");
  const rule = { scope: "resource", match: { type: "Microsoft.Network/publicIPAddresses" }, assert: { path: "tags.purpose", op: "in", value: ["gateway"] } };
  const pat = createArtefact({ kind: "pattern", title: "Governed ingress", category: "Net", statement: "x", context: "c", solution: "s", rule, control_refs: ["X 3"] }, "t");
  const pol = createArtefact({ kind: "policy", title: "Hosting decided", category: "Gov", statement: "x", enforcement: "mandatory", rule: { scope: "application", assert: { op: "hasDecision", topic: "hosting" } }, control_refs: ["X 4"] }, "t");
  // drafts: evaluated by nobody
  let r = evaluateAll("test");
  assert.equal(r.by_kind.pattern + r.by_kind.policy, 0); assert.equal(r.findings, 0);
  // dry run previews the draft pattern against the model: one untagged public IP
  const dry = dryRunArtefact(pat.id);
  assert.equal(dry.findings.length, 1); assert.equal(dry.findings[0].element_name, "pip-a"); assert.equal(dry.applications, 1);
  assert.equal((db.prepare("SELECT count(*) c FROM findings").get() as any).c, 0, "dry run writes nothing");
  // adopt both: the same engine now produces findings for a pattern and a policy
  setArtefactLifecycle(pat.id, "adopted", "chair"); setArtefactLifecycle(pol.id, "adopted", "chair");
  r = evaluateAll("test");
  assert.deepEqual([r.by_kind.pattern, r.by_kind.policy], [1, 1]);
  const open = db.prepare("SELECT s.kind, count(*) c FROM findings f JOIN standards s ON s.id=f.standard_id WHERE f.status='open' GROUP BY s.kind ORDER BY s.kind").all();
  assert.deepEqual(open, [{ kind: "pattern", c: 1 }, { kind: "policy", c: 1 }]);
  // retiring stops evaluation and resolves the finding
  retireArtefact(pol.id, "chair"); r = evaluateAll("test");
  assert.equal(r.by_kind.policy, 0);
  assert.equal((db.prepare("SELECT status FROM findings WHERE standard_id=?").get(pol.id) as any).status, "resolved");
});

test("preReviewArtefact: rule, references, duplicates, overlap, kind requirements, impact", () => {
  const ok = createArtefact({ kind: "standard", title: "Reviewed standard", category: "T", statement: "x", control_refs: ["ISO 27001 A.8.20"], rule: { scope: "resource", match: { type: "Microsoft.Web/sites" }, assert: { path: "tags.app", op: "exists" } } }, "t");
  const p = preReviewArtefact(ok.id);
  assert.equal(p.ok, true);
  assert.deepEqual(p.checks.map((c) => [c.name, c.state]), [["Rule is valid", "pass"], ["Control references", "pass"], ["Unique title", "pass"], ["Control references overlap", "pass"]]);
  assert.equal(p.impact.findings, 0);
  setArtefactLifecycle(ok.id, "adopted", "chair");
  const dup = createArtefact({ kind: "policy", title: "reviewed standard", category: "T", statement: "y", enforcement: "recommended", control_refs: ["ISO 27001 A.8.20"] }, "t");
  const q = preReviewArtefact(dup.id);
  assert.equal(q.ok, false);
  assert.equal(q.checks.find((c) => c.name === "Unique title")!.state, "fail");
  assert.equal(q.checks.find((c) => c.name === "Control references overlap")!.state, "warn");
  assert.equal(q.checks.find((c) => c.name === "Enforcement")!.state, "pass");
  const bare = createArtefact({ kind: "standard", title: "No references", category: "T", statement: "z" }, "t");
  assert.equal(preReviewArtefact(bare.id).checks.find((c) => c.name === "Control references")!.state, "fail");
  const prn = createArtefact({ kind: "principle", title: "No references needed", category: "T", statement: "z" }, "t");
  assert.equal(preReviewArtefact(prn.id).ok, true);
});

test("importArtefacts: drafts in, errors reported per item", () => {
  const r = importArtefacts([
    { kind: "principle", title: "Imported principle", category: "T", statement: "s" },
    { kind: "pattern", title: "Imported pattern without narrative", category: "T", statement: "s" } as any,
  ], "importer");
  assert.equal(r.created, 1); assert.equal(r.errors.length, 1); assert.equal(r.errors[0].index, 1);
  assert.equal((db.prepare("SELECT lifecycle FROM standards WHERE code=?").get(r.codes[0]) as any).lifecycle, "draft");
});
