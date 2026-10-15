import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "archigov-packs-"));
const { migrate, db } = await import("../src/db.js");
await migrate();
const { PACKS, importPack, listPacks, CORE_STANDARDS } = await import("../src/packs.js");
const { evaluateAll, validateRule } = await import("../src/rules.js");

const PREFIX: Record<string, string> = { standard: "STD", principle: "PRN", pattern: "PAT", policy: "POL" };

// Every pack in server/src/packs/ is checked here without being named, so a contributed pack needs no edit to this
// (AGPL) file to be covered — its contribution stays inside the Apache-2.0 folder.
test("packs: the shipped packs first, unique ids and codes, references only, kind requirements met", () => {
  const ids = PACKS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, "pack ids are unique");
  assert.deepEqual(ids.slice(0, 5), ["archigov-core", "archigov-governance-starter", "azure-waf-architecture", "dora-ict-architecture", "ai-act-annex-iv-design"]);
  const codes = PACKS.flatMap((p) => p.standards.map((s) => s.code));
  assert.equal(new Set(codes).size, codes.length, "codes are unique across packs");
  assert.equal(PACKS[0].lifecycle_on_import, "adopted", "the core pack must be effective at once on a first run");
  assert.ok(PACKS.slice(1).every((p) => p.lifecycle_on_import === "draft"), "every other pack lands as drafts for a board");
  for (const p of PACKS) {
    assert.match(p.version, /^\d+\.\d+\.\d+$/);
    for (const s of p.standards) {
      const kind = s.kind || "standard";
      assert.ok(s.code.startsWith(PREFIX[kind] + "-"), `${s.code} carries the ${kind} prefix`);
      assert.ok(s.title && s.statement && s.rationale, s.code);
      assert.ok(s.control_refs.length >= 1, `${s.code} has control references`);
      assert.ok(s.statement.length < 600, `${s.code} statement is a statement, not a reproduced control`);
      assert.ok(["critical", "high", "medium", "low"].includes(s.severity)); assert.ok(["adopt", "trial", "assess", "hold", "retire"].includes(s.status));
      if (kind === "pattern") assert.ok(s.context && s.solution, `${s.code} pattern has context and solution`);
      if (kind === "policy") assert.ok(["mandatory", "recommended"].includes(s.enforcement!), `${s.code} policy has enforcement`);
      if (kind === "principle") assert.equal(s.rule, null, `${s.code} principles carry no rule`);
      if (s.rule) assert.doesNotThrow(() => validateRule(s.rule), `${s.code} rule is valid`);
    }
  }
  const starter = PACKS[1];
  assert.deepEqual(starter.standards.map((s) => s.kind), ["principle", "principle", "principle", "pattern", "pattern", "policy", "policy"]);
  assert.ok(starter.standards.filter((s) => s.kind === "pattern").some((s) => s.rule) && starter.standards.filter((s) => s.kind === "policy").some((s) => s.rule), "at least one checkable pattern and policy");
  const listed = listPacks(); assert.equal(listed.length, PACKS.length);
  assert.deepEqual(listed[1].kinds, { principle: 3, pattern: 2, policy: 2 }); assert.equal(listed[1].lifecycle_on_import, "draft");
});

test("importing: core adopts and is evaluated; other packs land as drafts and are not; re-import skips", () => {
  let imported = 0;
  for (const p of PACKS) imported += importPack(p, "test").imported;
  assert.equal(imported, PACKS.reduce((n, p) => n + p.standards.length, 0));
  const r = evaluateAll("test");
  assert.deepEqual(r.rule_errors, [], JSON.stringify(r.rule_errors));
  assert.equal(r.standards, CORE_STANDARDS.filter((s) => s.rule).length, "only the adopted core rules are evaluated");
  assert.deepEqual(r.by_kind, { standard: CORE_STANDARDS.filter((s) => s.rule).length, principle: 0, pattern: 0, policy: 0 });
  const starterDraft = db.prepare("SELECT lifecycle, kind, enforcement FROM standards WHERE code='POL-GOV-01'").get() as any;
  assert.deepEqual(starterDraft, { lifecycle: "draft", kind: "policy", enforcement: "mandatory" });
  assert.equal((db.prepare("SELECT lifecycle FROM standards WHERE code='STD-001'").get() as any).lifecycle, "adopted");
  for (const p of PACKS) assert.equal(importPack(p, "test").imported, 0);
  assert.equal((db.prepare("SELECT count(*) c FROM standards").get() as any).c, imported);
});
