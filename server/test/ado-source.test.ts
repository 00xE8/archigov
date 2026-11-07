import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Not in fixture mode: the source row follows the environment, as it does on a real instance (an organisation renamed
// on 7 Nov 2026 kept the old name until this). No call reaches Azure DevOps here: only the row and the upsert are under test.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "archigov-ado-source-"));
delete process.env.ARCHIGOV_FIXTURES;
process.env.ADO_ORG = "old-name"; process.env.ADO_PROJECT = "Clinical-Platform"; process.env.ADO_PAT = "not-a-real-token";
const { migrate, db } = await import("../src/db.js");
await migrate();
const { adoSource, upsertWorkItem } = await import("../src/ado/sync.js");

test("the source row names the organisation and project as configured now, and is renamed, not duplicated, when they change", () => {
  const first = adoSource();
  assert.equal(first.name, "Azure DevOps (old-name/Clinical-Platform)");
  process.env.ADO_ORG = "new-name";
  const again = adoSource(false);
  assert.equal(again.id, first.id, "the same source: an organisation renamed is not a new source");
  assert.equal(again.name, "Azure DevOps (new-name/Clinical-Platform)");
  assert.equal(JSON.parse(again.config_json).org, "new-name");
  const row = db.prepare("SELECT * FROM sources WHERE kind='ado'").get() as any;
  assert.equal(row.name, again.name); assert.equal(row.config_json, again.config_json);
  assert.equal((db.prepare("SELECT count(*) n FROM sources WHERE kind='ado'").get() as any).n, 1);
  assert.deepEqual(adoSource(false), row, "unchanged configuration: the row as it is");
});

test("a work item's address is refreshed even when its revision did not move", () => {
  const src = adoSource();
  const fields = { "System.Title": "Patient self check-in kiosks", "System.WorkItemType": "Epic", "System.State": "New", "System.Tags": "" };
  const made = upsertWorkItem(src.id, { id: 1051, rev: 3, fields, url: "https://dev.azure.com/old-name/_apis/wit/workItems/1051" }, "test");
  assert.equal(made.outcome, "created");
  const audits = () => (db.prepare("SELECT count(*) n FROM audit_log WHERE entity='work_items'").get() as any).n as number;
  const before = audits();
  const same = upsertWorkItem(src.id, { id: 1051, rev: 3, fields, url: "https://dev.azure.com/new-name/_apis/wit/workItems/1051" }, "test");
  assert.equal(same.outcome, "skipped_old_rev", "an equal revision never overwrites the row");
  assert.equal((db.prepare("SELECT url FROM work_items WHERE id=?").get(made.id) as any).url, "https://dev.azure.com/new-name/_apis/wit/workItems/1051", "but the address follows the source");
  assert.equal(audits(), before, "and that is not a change worth an audit row");
});
