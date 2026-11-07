import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "archigov-writeback-"));
process.env.ARCHIGOV_FIXTURES = "1";
process.env.APP_BASE_URL = "https://archigov.example";
delete process.env.AUTH_MODE;
const { migrate, db } = await import("../src/db.js");
await migrate();
const { seedDemo } = await import("../src/seed.js");
seedDemo("test");
const { seedBoards } = await import("../src/boards/seed.js");
seedBoards("test");
const { Hono } = await import("hono");
const { api } = await import("../src/routes.js");
const app = new Hono();
app.route("/", api);
const call = async (method: string, p: string, user: string, body?: any) => {
  const r = await app.request(p, { method, headers: { "x-user": user, "content-type": "application/json" }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) as any };
};
const { changeStage, plannedChanges, CHANGE_STAGES } = await import("../src/stage.js");
const { sweep, writebackSettings, saveWritebackSettings, writebackStatus, testWriteAccess, shownFor, TAG_PREFIX, WRITEBACK_TIMING } = await import("../src/writeback.js");
WRITEBACK_TIMING.settleAfterMs = 0; // no test waits for a late save, except the one about it
const { buildPatch, splitTags, writeToWorkItem } = await import("../src/ado/write.js");
const { getWorkItem, patchWorkItem } = await import("../src/ado/client.js");
const { ADO_FIXTURES } = await import("../src/ado/fixtures.js");

const item = (ext: string) => db.prepare("SELECT * FROM work_items WHERE external_id=?").get(ext) as any;
const fx = (ext: string) => ADO_FIXTURES.written(ext);
const tagsOf = (ext: string) => splitTags(ADO_FIXTURES.get(ext).fields["System.Tags"]);
const audits = (action: string) => (db.prepare("SELECT count(*) n FROM audit_log WHERE action=?").get(action) as any).n as number;
const stageOf = (ext: string) => plannedChanges("WHERE w.external_id=?", ext)[0].lifecycle_stage;
const ours = (ext: string) => tagsOf(ext).filter((t) => /^(arch:|gov\/)/.test(t));
const row = (ext: string) => db.prepare("SELECT wb.* FROM work_item_writeback wb JOIN work_items w ON w.id=wb.work_item_id WHERE w.external_id=?").get(ext) as any;
const admin = (body: Record<string, unknown>) => call("POST", "/sources/ado/writeback", "ops.admin", body);
const reviewOf = (ext: string) => item(ext).review_id as string;

test("the stage of a change is read from its review, its decision, its conditions and what happened since", () => {
  const w = (o: Record<string, unknown>) => ({ type: "Epic", state: "Active", material_change: 0, decision_id: null, review_id: null, ...o }) as any;
  assert.equal(changeStage(w({})), "needs_decision");
  assert.equal(changeStage(w({ type: "Feature" })), null, "a feature without a decision is not flagged: epics are");
  assert.equal(changeStage(w({ state: "Closed" })), null);
  assert.equal(changeStage(w({ state: "Removed", review_id: "r", review_stage: "approved" })), null);
  assert.equal(changeStage(w({ decision_id: "d", decision_status: "proposed" })), "decision_proposed");
  assert.equal(changeStage(w({ decision_id: "d", decision_status: "accepted" })), "approved");
  assert.equal(changeStage(w({ decision_id: "d", decision_status: "rejected" })), "rejected");
  for (const s of ["submitted", "pre_review", "in_review", "approved_pending_dependencies", "approved_subject_to_circulation"]) assert.equal(changeStage(w({ review_id: "r", review_stage: s })), "in_review", s);
  assert.equal(changeStage(w({ review_id: "r", review_stage: "changes_requested" })), "changes_requested");
  assert.equal(changeStage(w({ review_id: "r", review_stage: "rejected" })), "rejected");
  assert.equal(changeStage(w({ review_id: "r", review_stage: "approved" })), "approved");
  assert.equal(changeStage(w({ review_id: "r", review_stage: "approved_with_conditions", open_conditions: 2 })), "approved_with_conditions");
  assert.equal(changeStage(w({ review_id: "r", review_stage: "approved_with_conditions", open_conditions: 0 })), "approved", "once every condition is met it is simply approved");
  // a withdrawn review covers nothing: the decision behind it speaks, or nothing does
  assert.equal(changeStage(w({ review_id: "r", review_stage: "withdrawn", decision_id: "d", decision_status: "proposed" })), "decision_proposed");
  // what happened after approval comes first
  assert.equal(changeStage(w({ review_id: "r", review_stage: "approved", material_change: 1 })), "changed_after_approval");
  assert.equal(changeStage(w({ review_id: "r", review_stage: "approved_with_conditions", open_conditions: 1, material_change: 1 })), "changed_after_approval");
  // ...and only after approval: the baseline is taken at submission, so the flag is also set under an open or a rejected review
  assert.equal(changeStage(w({ review_id: "r", review_stage: "in_review", material_change: 1 })), "in_review");
  assert.equal(changeStage(w({ review_id: "r", review_stage: "changes_requested", material_change: 1 })), "changes_requested");
  assert.equal(changeStage(w({ review_id: "r", review_stage: "rejected", material_change: 1 })), "rejected");
  // a withdrawn review with nothing behind it leaves the epic where it started
  assert.equal(changeStage(w({ review_id: "r", review_stage: "withdrawn" })), "needs_decision");
  // a rejected decision is not outweighed by an approved review beside it; a review still open is the live word
  assert.equal(changeStage(w({ review_id: "r", review_stage: "approved", decision_id: "d", decision_status: "rejected" })), "rejected");
  assert.equal(changeStage(w({ review_id: "r", review_stage: "in_review", decision_id: "d", decision_status: "rejected" })), "in_review");
  // finished work asks for nothing, whatever the process template calls finished
  for (const done of ["Closed", "Done", "Resolved"]) assert.equal(changeStage(w({ state: done })), null, done);
  const accepted = { review_id: "r", review_stage: "approved", decision_id: "d", decision_status: "accepted" };
  assert.equal(changeStage(w(accepted), { drift: 2, realised: false }), "drift");
  assert.equal(changeStage(w(accepted), { drift: 0, realised: true }), "built_as_approved");
  assert.equal(changeStage(w(accepted), { drift: 0, realised: false }), "approved");
  assert.equal(changeStage(w({ ...accepted, review_stage: "approved_with_conditions", open_conditions: 1 }), { drift: 0, realised: true }), "approved_with_conditions", "not built as approved while a condition is open");
  assert.equal(changeStage(w({ review_id: "r", review_stage: "in_review", decision_id: "d", decision_status: "accepted" }), { drift: 3, realised: false }), "in_review", "drift is said of what was approved, not of what is still in review");
  assert.equal(new Set(CHANGE_STAGES.map((s) => s.id)).size, CHANGE_STAGES.length);
});

test("the demo backlog reads as the lifecycle says, on the list the page shows", async () => {
  assert.equal(stageOf("1042"), "changed_after_approval");
  assert.equal(stageOf("1051"), "needs_decision");
  assert.equal(stageOf("1063"), "in_review");
  assert.equal(stageOf("1077"), "in_review");
  assert.equal(stageOf("1088"), null);
  const r = await call("GET", "/work-items", "s.patel");
  assert.equal(r.status, 200);
  const row = r.body.find((w: any) => w.external_id === "1042");
  assert.equal(row.lifecycle_stage, "changed_after_approval"); assert.equal(row.writeback, null); assert.equal(row.needs_decision, false);
  assert.ok(Array.isArray(row.tags) && row.review_code === "REV-0006");
});

test("a patch is built against the item as it stands, revision tested first", () => {
  const it = { rev: 5, fields: { "System.Tags": "data; Arch:In-Review; team-a" }, relations: [{ rel: "Hyperlink", url: "https://archigov.example/reviews/1" }, { rel: "System.LinkTypes.Hierarchy-Reverse", url: "https://dev.azure.com/x/_apis/wit/workItems/1" }] };
  const p = buildPatch(it, { removeTags: ["arch:in-review"], addTags: ["arch:approved"], addLinks: [{ url: "https://archigov.example/reviews/1", comment: "there already" }, { url: "https://archigov.example/decisions/2", comment: "archigov decision ADR-0002" }], comment: "<div>said</div>" });
  assert.deepEqual(p.ops[0], { op: "test", path: "/rev", value: 5 });
  // `replace`, never `add`: on tags the service merges on add, so the old stage tag would stay beside the new one
  assert.deepEqual(p.ops[1], { op: "replace", path: "/fields/System.Tags", value: "data; team-a; arch:approved" }, "the team's tags are kept, in their order; ours is replaced whatever its case");
  assert.deepEqual(p.ops[2], { op: "add", path: "/relations/-", value: { rel: "Hyperlink", url: "https://archigov.example/decisions/2", attributes: { comment: "archigov decision ADR-0002" } } });
  assert.deepEqual(p.ops[3], { op: "add", path: "/fields/System.History", value: "<div>said</div>" });
  assert.equal(p.ops.length, 4); assert.deepEqual(p.added_links, ["https://archigov.example/decisions/2"]);
  // nothing to do is no document at all: no revision, no notification
  assert.deepEqual(buildPatch(it, { addTags: ["DATA"], addLinks: [{ url: "https://archigov.example/reviews/1" }] }).ops, []);
  // taking the only tag off empties the field; an item with no tags yet gets its first by `add`
  assert.deepEqual(buildPatch({ rev: 2, fields: { "System.Tags": "arch:approved" }, relations: [] }, { removeTags: ["arch:approved"] }).ops, [{ op: "test", path: "/rev", value: 2 }, { op: "replace", path: "/fields/System.Tags", value: "" }]);
  assert.deepEqual(buildPatch({ rev: 2, fields: {}, relations: [] }, { addTags: ["arch:approved"] }).ops, [{ op: "test", path: "/rev", value: 2 }, { op: "add", path: "/fields/System.Tags", value: "arch:approved" }]);
  assert.deepEqual(buildPatch({ rev: 2, fields: {}, relations: [] }, { removeTags: ["arch:approved"] }).ops, []);
});

test("off by default: nothing is written, whoever asks", async () => {
  assert.deepEqual(writebackSettings(), { enabled: false, link: true, stage: true, comment: true, raise: false, request: false, tag_prefix: "arch:", raise_type: "Task" });
  const r = await sweep();
  assert.equal(r.enabled, false); assert.equal(r.written, 0);
  assert.equal(fx("1042"), null); assert.equal(audits("writeback:write"), 0);
  assert.equal((await call("POST", "/sources/ado/writeback/run", "ops.admin")).status, 409);
  const st = (await call("GET", "/sources/ado/writeback", "s.patel")).body;
  assert.equal(st.enabled, false); assert.equal(st.available, true); assert.equal(st.in_scope, 7); assert.equal(st.shown, 0);
  assert.deepEqual(st.capabilities.map((c: any) => [c.id, c.enabled, c.available]), [["link", true, true], ["stage", true, true], ["comment", true, true], ["raise", false, true], ["request", false, true]]);
  assert.equal(st.stages.find((s: any) => s.id === "in_review").tag, "arch:in-review");
  assert.equal((await call("GET", "/settings", "ops.admin")).body.ado.writeback.enabled, false);
});

test("only a platform admin turns it on; an author, an auditor and a chair cannot", async () => {
  for (const user of ["s.patel", "j.duduka", "m.hughes"]) assert.equal((await call("POST", "/sources/ado/writeback", user, { enabled: true })).status, 403, user);
  assert.equal((await call("POST", "/sources/ado/writeback/test", "s.patel")).status, 403);
  assert.equal(writebackSettings().enabled, false);
  assert.equal((await call("POST", "/sources/ado/writeback", "ops.admin", { tag_prefix: "no separator" })).status, 400);
  assert.equal((await call("POST", "/sources/ado/writeback", "ops.admin", { enabled: true, link: false, stage: false, comment: false })).status, 400);
  for (const ok of ["arch:", "archigov/", "gov-", "a:"]) assert.ok(TAG_PREFIX.test(ok), ok);
  for (const bad of ["", ":", "arch", "arch;", "a,b:", " arch:", "x".repeat(21) + ":"]) assert.ok(!TAG_PREFIX.test(bad), bad);
});

test("the preview says what would be written and writes nothing", async () => {
  const r = await call("GET", "/sources/ado/writeback/preview", "ops.admin");
  assert.equal(r.status, 200); assert.equal(r.body.in_scope, 7);
  const by = Object.fromEntries(r.body.items.map((i: any) => [i.external_id, i]));
  assert.deepEqual(by["1042"].tag, { from: null, to: "arch:changed-after-approval" });
  assert.deepEqual(by["1042"].comments, ["outcome:approved_with_conditions", "changed_after_approval"]);
  assert.equal(by["1042"].links.length, 1); assert.match(by["1042"].links[0], /^https:\/\/archigov\.example\/reviews\//);
  assert.equal(by["1063"].links.length, 2, "a decision and a review");
  assert.deepEqual(by["1051"].tag, { from: null, to: "arch:needs-decision" });
  assert.equal(by["1088"], undefined, "a closed feature with nothing behind it shows nothing");
  // the form's unsaved switches
  const tagsOnly = (await call("GET", "/sources/ado/writeback/preview?link=0&comment=0&tag_prefix=gov-", "ops.admin")).body;
  assert.ok(tagsOnly.items.every((i: any) => i.links.length === 0 && i.comments.length === 0 && i.tag.to.startsWith("gov-")));
  assert.equal(fx("1042"), null); assert.equal(writebackStatus().shown, 0);
});

test("the write access check changes nothing", async () => {
  const ok = await testWriteAccess();
  assert.equal(ok.ok, true); assert.equal(fx(String((ok as any).checked)), null);
  ADO_FIXTURES.state.denyWrites = true;
  const no = await testWriteAccess();
  assert.equal(no.ok, false); assert.match((no as any).error, /403/);
  ADO_FIXTURES.state.denyWrites = false;
});

test("turning it on writes what is already true: a link, one stage tag, the outcome", async () => {
  const r = await call("POST", "/sources/ado/writeback", "ops.admin", { enabled: true });
  assert.equal(r.status, 200); assert.equal(r.body.enabled, true); assert.equal(r.body.sweep.failed, 0);
  assert.equal(r.body.sweep.written, 6); assert.equal(r.body.shown, 6); assert.equal(r.body.tagged, 6);
  assert.equal(audits("writeback:enable"), 1); assert.equal(audits("writeback:write"), 6);
  // 1042: approved with conditions, then changed
  assert.deepEqual(tagsOf("1042"), ["architecture-needed", "data", "arch:changed-after-approval"], "the team's tags are untouched");
  const w = fx("1042")!;
  assert.deepEqual(w.relations.map((x) => [x.rel, x.url, x.attributes?.comment]), [["Hyperlink", `https://archigov.example/reviews/${item("1042").review_id}`, "archigov review REV-0006: Referral API: managed document service for attachments"]]);
  assert.equal(w.history.length, 1, "one comment, one notification");
  assert.match(w.history[0], /Review REV-0006 was approved with conditions by .+ on \d{1,2} \w{3} \d{4}: 2 conditions to meet\./);
  assert.match(w.history[0], /changed after review REV-0006 covered it/);
  assert.match(w.history[0], /<a href="https:\/\/archigov\.example\/reviews\//);
  assert.doesNotMatch(w.history[0], /compliant|Archigov/, "facts, not verdicts; the name stays lowercase");
  // an item in review: tagged and linked, nothing commented
  assert.deepEqual(tagsOf("1077"), ["third-party", "data", "arch:in-review"]);
  assert.equal(fx("1077")!.history.length, 0); assert.equal(fx("1077")!.relations.length, 1);
  assert.equal(fx("1063")!.relations.length, 2);
  assert.deepEqual(tagsOf("1051"), ["clinical-safety", "arch:needs-decision"]);
  assert.equal(fx("1088"), null);
  const row = (await call("GET", "/work-items", "s.patel")).body.find((x: any) => x.external_id === "1077");
  assert.equal(row.writeback.tag, "arch:in-review"); assert.equal(row.writeback.links, 1); assert.ok(row.writeback.written_at); assert.equal(row.writeback.error, null);
});

test("a second sweep sends nothing, and the echo from the source changes nothing", async () => {
  const before = fx("1042")!.rev;
  const r = await sweep();
  assert.equal(r.written, 0); assert.equal(r.unchanged, 7); assert.equal(fx("1042")!.rev, before);
  // the backlog syncs our own tag back in: it is not a change to the requirement, so nothing is flagged or rewritten
  const { syncAdo } = await import("../src/ado/sync.js");
  const s = await syncAdo("test");
  assert.equal(s.ok, true);
  assert.ok(JSON.parse(item("1077").tags_json).includes("arch:in-review"));
  assert.equal(item("1077").material_change, 0);
  assert.equal((await sweep()).written, 0);
});

test("an outcome is commented once, when a board declares it", async () => {
  const w = item("1077");
  db.prepare("UPDATE reviews SET stage='approved', decided_at=?, updated_at=? WHERE id=?").run("2026-11-06T10:00:00.000Z", "2026-11-06T10:00:00.000Z", w.review_id);
  let r = await sweep();
  assert.equal(r.written, 1);
  assert.deepEqual(tagsOf("1077"), ["third-party", "data", "arch:approved"], "the stage tag is replaced, never stacked");
  assert.equal(fx("1077")!.history.length, 1);
  assert.match(fx("1077")!.history[0], /Review REV-0007 was approved by .+ on 6 Nov 2026\./);
  assert.equal((await sweep()).written, 0);
  assert.equal(fx("1077")!.history.length, 1, "said once");
  // sent back, resubmitted, sent back again: each is its own fact
  db.prepare("UPDATE reviews SET stage='changes_requested' WHERE id=?").run(w.review_id);
  await sweep();
  assert.match(fx("1077")!.history[1], /Changes were requested on review REV-0007/);
  db.prepare("UPDATE reviews SET stage='in_review' WHERE id=?").run(w.review_id);
  await sweep();
  assert.equal(fx("1077")!.history.length, 2, "going back into review is a stage, not an outcome");
  assert.ok(tagsOf("1077").includes("arch:in-review"));
  db.prepare("UPDATE reviews SET stage='changes_requested' WHERE id=?").run(w.review_id);
  await sweep();
  assert.equal(fx("1077")!.history.length, 3);
  assert.equal(fx("1077")!.relations.length, 1, "the link is added once");
});

test("acknowledging the change moves the stage on without another comment", async () => {
  const w = item("1042");
  assert.equal((await call("POST", `/work-items/${w.id}/acknowledge-change`, "s.patel")).status, 200);
  await sweep();
  assert.deepEqual(tagsOf("1042"), ["architecture-needed", "data", "arch:approved-with-conditions"]);
  assert.equal(fx("1042")!.history.length, 1);
  // it changes again: that is a new fact, said once however often the text is then edited
  db.prepare("UPDATE work_items SET material_change=1, content_hash='another-text' WHERE id=?").run(w.id);
  await sweep();
  assert.equal(fx("1042")!.history.length, 2); assert.match(fx("1042")!.history[1], /changed after review REV-0006/);
  assert.ok(tagsOf("1042").includes("arch:changed-after-approval"));
  db.prepare("UPDATE work_items SET content_hash='and-another' WHERE id=?").run(w.id);
  assert.equal((await sweep()).written, 0); assert.equal(fx("1042")!.history.length, 2);
});

test("a write that fails is recorded once, tried again later, and never blocks the others", async () => {
  const w = item("1077");
  db.prepare("UPDATE reviews SET stage='approved' WHERE id=?").run(w.review_id);
  ADO_FIXTURES.state.denyWrites = true;
  let r = await sweep();
  assert.equal(r.failed, 1); assert.match(r.items[0].error!, /403/);
  assert.equal(audits("writeback:error"), 1);
  const st = writebackStatus();
  assert.equal(st.errors, 1); assert.equal(st.last_error!.external_id, "1077");
  assert.match((await call("GET", "/work-items", "s.patel")).body.find((x: any) => x.external_id === "1077").writeback.error, /403/);
  r = await sweep();
  assert.equal(r.waiting, 1, "not hammered: it waits before the next try"); assert.equal(r.failed, 0); assert.equal(audits("writeback:error"), 1);
  ADO_FIXTURES.state.denyWrites = false;
  db.prepare("UPDATE work_item_writeback SET retry_after=? WHERE work_item_id=?").run("2020-01-01T00:00:00.000Z", w.id);
  r = await sweep();
  assert.equal(r.written, 1); assert.equal(writebackStatus().errors, 0);
  assert.ok(tagsOf("1077").includes("arch:approved"));
});

test("a stale revision is retried against the item as it now stands", async () => {
  const before = await getWorkItem("1070");
  await patchWorkItem("1070", [{ op: "test", path: "/rev", value: before.rev }, { op: "add", path: "/fields/System.Tags", value: "decommission; arch:needs-decision; someone-elses" }]);
  await assert.rejects(() => patchWorkItem("1070", [{ op: "test", path: "/rev", value: before.rev }, { op: "add", path: "/fields/System.History", value: "x" }]), /412.*VS403351: Test Operation for path \/rev failed/);
  const r = await writeToWorkItem("1070", { addTags: ["arch:in-review"], removeTags: ["arch:needs-decision"] });
  assert.equal(r.changed, true);
  assert.deepEqual(tagsOf("1070"), ["decommission", "someone-elses", "arch:in-review"], "a tag someone added meanwhile is kept");
  await writeToWorkItem("1070", { addTags: ["arch:needs-decision"], removeTags: ["arch:in-review"] });
});

test("the switches are separate: a new prefix replaces the tags, stage off takes them off, links stay", async () => {
  let r = await call("POST", "/sources/ado/writeback", "ops.admin", { tag_prefix: "gov/" });
  assert.equal(r.status, 200); assert.equal(audits("writeback:update"), 1);
  assert.ok(tagsOf("1077").includes("gov/approved") && !tagsOf("1077").some((t) => t.startsWith("arch:")));
  r = await call("POST", "/sources/ado/writeback", "ops.admin", { stage: false });
  assert.equal(r.body.tagged, 0);
  assert.ok(!tagsOf("1077").some((t) => t.startsWith("gov/")));
  assert.deepEqual(tagsOf("1077").slice(0, 2), ["third-party", "data"]);
  assert.equal(fx("1077")!.relations.length, 1);
  r = await call("POST", "/sources/ado/writeback", "ops.admin", { stage: true, tag_prefix: "arch:" });
  assert.ok(tagsOf("1077").includes("arch:approved"));
});

test("turning it off takes the stage tags off and leaves the links and comments as history", async () => {
  const history = fx("1042")!.history.length, links = fx("1042")!.relations.length;
  const r = await call("POST", "/sources/ado/writeback", "ops.admin", { enabled: false });
  assert.equal(r.status, 200); assert.equal(r.body.enabled, false);
  assert.equal(r.body.cleanup.failed, 0); assert.ok(r.body.cleanup.removed >= 6); assert.equal(r.body.tagged, 0);
  for (const ext of ["1042", "1051", "1063", "1070", "1077", "1081"]) assert.ok(!tagsOf(ext).some((t) => t.startsWith("arch:")), ext);
  assert.deepEqual(tagsOf("1042"), ["architecture-needed", "data"]);
  assert.equal(fx("1042")!.history.length, history); assert.equal(fx("1042")!.relations.length, links);
  assert.equal(audits("writeback:disable"), 1); assert.equal(audits("writeback:cleanup"), 1);
  const revs = fx("1042")!.rev;
  assert.equal((await sweep()).enabled, false); assert.equal(fx("1042")!.rev, revs);
});

test("turned on again, the tags come back and nothing already said is said twice", async () => {
  const history = fx("1042")!.history.length;
  const r = await call("POST", "/sources/ado/writeback", "ops.admin", { enabled: true });
  assert.equal(r.body.sweep.failed, 0);
  assert.ok(tagsOf("1042").includes("arch:changed-after-approval"));
  assert.equal(fx("1042")!.history.length, history); assert.equal(fx("1042")!.relations.length, 1);
  // kept on request when turning off
  const off = await call("POST", "/sources/ado/writeback", "ops.admin", { enabled: false, remove_tags: false });
  assert.equal(off.body.cleanup, undefined); assert.ok(tagsOf("1042").includes("arch:changed-after-approval"));
});

test("every audit row asks for a sweep, but only while it is on, and never for its own rows", async () => {
  const { startWriteback } = await import("../src/writeback.js");
  const { audit } = await import("../src/db.js");
  startWriteback();
  await call("POST", "/sources/ado/writeback", "ops.admin", { enabled: true });
  const w = item("1051");
  db.prepare("UPDATE work_items SET state='Removed' WHERE external_id='1070'").run();
  const dec = db.prepare("SELECT id FROM decisions WHERE status='proposed' LIMIT 1").get() as any;
  assert.ok(dec, "the demo has a proposed decision");
  assert.equal((await call("POST", `/work-items/${w.id}/link`, "s.patel", { decision_id: dec.id })).status, 200);
  await new Promise((r) => setTimeout(r, 1900)); // the sweep follows the change by itself
  assert.ok(tagsOf("1051").includes("arch:decision-proposed"), tagsOf("1051").join(", "));
  assert.equal(fx("1051")!.relations.length, 1);
  const writes = audits("writeback:write");
  audit("test", "writeback:write", "work_items", w.id, {});
  await new Promise((r) => setTimeout(r, 1700));
  assert.equal(audits("writeback:write"), writes + 1, "its own rows start nothing");
  await call("POST", "/sources/ado/writeback", "ops.admin", { enabled: false });
});

// ---------- what two independent reviews of the write path found, each pinned ----------
const TEAM = "arch:platform-team"; // a tag of the team's own that happens to share the prefix
const stageTagsOn = (ext: string) => ours(ext).filter((t) => t !== TEAM);
const history = (ext: string) => fx(ext)?.history ?? [];
const quiet = () => Object.assign(ADO_FIXTURES.state, { denyWrites: false, loseAnswers: 0, thenUnreachable: false, saveLateMs: 0, failWrites: 0, unreachable: false, throttled: false, gone: [], latencyMs: 0 });
const setReview = (ext: string, stage: string, more: Record<string, string | null> = {}) => {
  const cols = Object.keys(more);
  db.prepare(`UPDATE reviews SET stage=?${cols.map((c) => `, ${c}=?`).join("")} WHERE id=?`).run(stage, ...cols.map((c) => more[c]), reviewOf(ext));
};

test("the fixture treats tags as the service does: add merges, replace sets", async () => {
  const before = await getWorkItem("1088");
  await patchWorkItem("1088", [{ op: "test", path: "/rev", value: before.rev }, { op: "add", path: "/fields/System.Tags", value: "one; two" }]);
  let now = await getWorkItem("1088");
  await patchWorkItem("1088", [{ op: "test", path: "/rev", value: now.rev }, { op: "add", path: "/fields/System.Tags", value: "TWO; three" }]);
  assert.deepEqual(tagsOf("1088"), ["one", "two", "three"], "add never takes a tag off");
  now = await getWorkItem("1088");
  await patchWorkItem("1088", [{ op: "test", path: "/rev", value: now.rev }, { op: "replace", path: "/fields/System.Tags", value: "three" }]);
  assert.deepEqual(tagsOf("1088"), ["three"]);
  now = await getWorkItem("1088");
  await assert.rejects(() => patchWorkItem("1088", [{ op: "test", path: "/rev", value: now.rev }, { op: "remove", path: "/fields/System.Tags" }]), /unsupported operation/);
  await writeToWorkItem("1088", { removeTags: ["three"] });
  assert.deepEqual(tagsOf("1088"), []);
});

test("only a tag archigov knows it wrote is ever taken off, and the page is told when the prefix is already in use", async () => {
  // before adoption the team tagged an epic by hand, once with what happens to be a stage tag
  const theirs = ["decommission", "arch:approved", TEAM];
  db.prepare("UPDATE work_items SET state='New', tags_json=? WHERE external_id='1070'").run(JSON.stringify(theirs));
  ADO_FIXTURES.touch("1070", theirs.join("; "));
  assert.equal((await call("GET", "/sources/ado/writeback/preview", "ops.admin")).body.prefix_in_use, 1, "said before anything is turned on");
  assert.equal((await call("GET", "/sources/ado/writeback/preview?tag_prefix=gov-", "ops.admin")).body.prefix_in_use, 0);
  const r = await admin({ enabled: true });
  assert.equal(r.body.prefix_in_use, 1);
  assert.deepEqual(tagsOf("1070"), [...theirs, "arch:needs-decision"], "theirs stay, even the one spelled like a stage tag");
  // the team tidies its own; the rest of these tests read more easily without it
  const tidy = ["decommission", TEAM, "arch:needs-decision"];
  ADO_FIXTURES.touch("1070", tidy.join("; "));
  db.prepare("UPDATE work_items SET tags_json=? WHERE external_id='1070'").run(JSON.stringify(tidy));
});

test("a withdrawn review covers nothing: it is neither linked nor named", () => {
  const s = { ...writebackSettings(), enabled: true };
  const w = { id: "x", type: "Epic", state: "Active", material_change: 0, decision_id: "d1", decision_code: "ADR-0009", decision_title: "t", decision_status: "accepted", review_id: "r1", review_code: "REV-0099", review_title: "t", review_stage: "withdrawn" };
  const shown = shownFor(w, s, () => null, "https://archigov.example");
  assert.deepEqual(shown.links.map((l) => l.url), ["https://archigov.example/decisions/d1"]);
  assert.equal(shown.outcome, null); assert.equal(shown.stage, "approved");
});

test("a change before any approval is not written as changed after approval", async () => {
  const w = item("1063"), said = history("1063").length;
  db.prepare("UPDATE work_items SET material_change=1 WHERE id=?").run(w.id);
  await sweep();
  assert.equal(stageOf("1063"), "in_review");
  assert.deepEqual(ours("1063"), ["arch:in-review"]);
  assert.equal(history("1063").length, said, "nothing was approved, so nothing is said about what was approved");
  const listed = (await call("GET", "/work-items", "s.patel")).body.find((x: any) => x.external_id === "1063");
  assert.ok(listed.material_change, "the page still has the flag to show");
  db.prepare("UPDATE work_items SET material_change=0 WHERE id=?").run(w.id);
});

test("comments switched off and on again repeat nothing", async () => {
  const before = ["1042", "1077"].map((e) => history(e).length);
  assert.equal((await admin({ comment: false })).status, 200);
  assert.ok(row("1042").outcome, "what was said is still on record");
  assert.equal((await admin({ comment: true })).status, 200);
  assert.deepEqual(["1042", "1077"].map((e) => history(e).length), before);
});

test("changes requested a second time is said again, with its own date, even when the round between never reached the source", async () => {
  setReview("1077", "changes_requested", { decided_at: "2026-01-05T10:00:00.000Z", resubmitted_at: null });
  db.prepare("INSERT INTO review_events(id,review_id,kind,actor,body_md,data_json,origin,verification,created_at) VALUES ('wb-ev-1',?,'request_changes','j.duduka','','{}','human','verified','2026-11-03T09:00:00.000Z')").run(reviewOf("1077"));
  await sweep();
  const said = history("1077").length;
  assert.match(history("1077")[said - 1], /Changes were requested on review REV-0007 by .+ on 3 Nov 2026\./, "the day it was sent back, not an older decided_at");
  // resubmitted, but the source refuses the write: the record still holds the first round
  ADO_FIXTURES.state.denyWrites = true;
  setReview("1077", "in_review", { resubmitted_at: "2026-11-04T09:00:00.000Z" });
  assert.equal((await sweep()).failed, 1);
  setReview("1077", "changes_requested");
  quiet();
  const r = await sweep({ force: true });
  assert.equal(r.written, 1); assert.equal(history("1077").length, said + 1, "the second round is its own fact");
  assert.equal((await sweep()).written, 0);
});

test("Run tries again at once what a failure put off; an error is over when nothing is left to send", async () => {
  ADO_FIXTURES.state.denyWrites = true;
  setReview("1077", "rejected");
  assert.equal((await sweep()).failed, 1);
  assert.equal(row("1077").pending_json, null, "a refusal saved nothing: nothing is kept to settle");
  quiet();
  assert.equal((await sweep()).waiting, 1, "the background sweep still waits its turn");
  const run = await call("POST", "/sources/ado/writeback/run", "ops.admin");
  assert.equal(run.body.written, 1, "a person asked: now"); assert.deepEqual(ours("1077"), ["arch:rejected"]);
  // a failure whose cause went away: the stage is back to what the item already shows
  ADO_FIXTURES.state.denyWrites = true;
  setReview("1077", "approved");
  assert.equal((await sweep()).failed, 1); assert.equal(writebackStatus().errors, 1);
  setReview("1077", "rejected");
  quiet();
  const r = await sweep();
  assert.equal(r.written, 0); assert.equal(r.failed, 0); assert.equal(writebackStatus().errors, 0);
  assert.equal((await call("GET", "/work-items", "s.patel")).body.find((x: any) => x.external_id === "1077").writeback.error, null);
});

test("an item taken out of the backlog loses its stage tag; one deleted at the source is simply closed", async () => {
  assert.equal(ours("1081").length, 1);
  db.prepare("UPDATE work_items SET state='Removed' WHERE external_id='1081'").run();
  let r = await sweep();
  assert.equal(r.written, 1); assert.deepEqual(ours("1081"), []); assert.equal(row("1081").tag, null);
  assert.equal(r.in_scope, writebackStatus().in_scope, "it is no longer counted in scope");
  assert.equal((await sweep()).written, 0);
  db.prepare("UPDATE work_items SET state='New' WHERE external_id='1081'").run();
  await sweep();
  assert.equal(ours("1081").length, 1);
  // deleted: the source answers 404, there is nothing to take a tag off, and it must not fail for ever
  db.prepare("UPDATE work_items SET state='Removed' WHERE external_id='1081'").run();
  ADO_FIXTURES.state.gone = ["1081"];
  r = await sweep();
  assert.equal(r.failed, 0); assert.equal(row("1081").tag, null); assert.equal(writebackStatus().errors, 0);
  assert.equal((await sweep()).failed, 0);
  quiet();
  db.prepare("UPDATE work_items SET state='New' WHERE external_id='1081'").run();
  await sweep();
});

test("an answer that never arrives: the write is settled against what it carried, and its comment is not left twice", async () => {
  const approvals = () => history("1063").filter((h) => /was approved by/.test(h)).length;
  // saved, the answer lost: nothing is resent blind; the next sweep reads the item and takes the write as done
  let said = history("1063").length, writes = audits("writeback:write");
  setReview("1063", "approved", { decided_at: "2026-11-05T10:00:00.000Z" });
  ADO_FIXTURES.state.loseAnswers = 1;
  let r = await sweep();
  assert.equal(r.failed, 1); assert.ok(row("1063").pending_json, "what was sent is kept until its answer is known");
  assert.equal(history("1063").length, said + 1, "it had been saved");
  r = await sweep({ force: true });
  assert.equal(r.failed, 0); assert.equal(r.written, 0); assert.equal(history("1063").length, said + 1, "and is not said again");
  assert.equal(row("1063").pending_json, null); assert.equal(row("1063").tag, "arch:approved"); assert.equal(writebackStatus().errors, 0);
  assert.equal(audits("writeback:write"), writes + 1, "the write is on the audit chain once it is known to have landed");
  // ...even when what is wanted has moved on by then: the lost write is judged by what IT carried
  setReview("1063", "in_review"); await sweep();
  said = history("1063").length; const before = approvals();
  setReview("1063", "approved", { resubmitted_at: "2026-11-05T12:00:00.000Z" });
  ADO_FIXTURES.state.loseAnswers = 1;
  assert.equal((await sweep()).failed, 1);
  db.prepare("UPDATE work_items SET material_change=1 WHERE external_id='1063'").run(); // the text changes before the retry
  r = await sweep({ force: true });
  assert.equal(r.failed, 0); assert.equal(approvals(), before + 1, "the approval is on the item once, not twice");
  assert.equal(history("1063").length, said + 2); assert.match(history("1063")[said + 1], /changed after review REV-0008 covered it/);
  assert.deepEqual(ours("1063"), ["arch:changed-after-approval"]);
  db.prepare("UPDATE work_items SET material_change=0 WHERE external_id='1063'").run(); await sweep();
  // not saved at all: the item is where it was, so the whole write goes again, comment included
  said = history("1063").length;
  setReview("1063", "rejected");
  ADO_FIXTURES.state.failWrites = 1;
  assert.equal((await sweep()).failed, 1); assert.equal(history("1063").length, said);
  r = await sweep({ force: true });
  assert.equal(r.written, 1); assert.equal(history("1063").length, said + 1); assert.deepEqual(ours("1063"), ["arch:rejected"]);
  // not saved, and somebody else edits the item meanwhile: their revision is not mistaken for ours
  said = history("1063").length;
  setReview("1063", "approved", { resubmitted_at: "2026-11-05T14:00:00.000Z" });
  ADO_FIXTURES.state.failWrites = 1;
  assert.equal((await sweep()).failed, 1);
  ADO_FIXTURES.touch("1063");
  r = await sweep({ force: true });
  assert.equal(r.written, 1); assert.equal(history("1063").length, said + 1);
});

test("a save that lands after its error is given time, then recognised", async () => {
  const said = history("1063").length;
  WRITEBACK_TIMING.settleAfterMs = 60_000;
  try {
    setReview("1063", "rejected", { resubmitted_at: "2026-11-05T16:00:00.000Z" });
    Object.assign(ADO_FIXTURES.state, { loseAnswers: 1, saveLateMs: 40 });
    assert.equal((await sweep()).failed, 1);
    assert.equal(history("1063").length, said, "the error came back before the save");
    const early = await sweep({ force: true });
    assert.equal(early.waiting, 1, "the same revision, moments later, does not yet mean it was not saved"); assert.equal(early.written, 0);
    await new Promise((r) => setTimeout(r, 90));
    assert.equal(history("1063").length, said + 1, "the save landed");
  } finally { WRITEBACK_TIMING.settleAfterMs = 0; quiet(); }
  const r = await sweep({ force: true });
  assert.equal(r.failed, 0); assert.equal(history("1063").length, said + 1, "one comment, not two");
  assert.deepEqual(ours("1063"), ["arch:rejected"]);
});

test("with only comments on, a lost one is taken as said and the next fact is still said in its own right", async () => {
  await admin({ stage: false });
  const said = history("1063").length;
  setReview("1063", "changes_requested", { resubmitted_at: "2026-11-05T18:00:00.000Z" });
  ADO_FIXTURES.state.loseAnswers = 1;
  assert.equal((await sweep()).failed, 1);
  assert.match(history("1063")[said], /Changes were requested/);
  setReview("1063", "approved", { resubmitted_at: "2026-11-05T19:00:00.000Z" }); // resubmitted and approved before the retry
  const r = await sweep({ force: true });
  assert.equal(r.failed, 0);
  assert.equal(history("1063").length, said + 2); assert.match(history("1063")[said + 1], /was approved by/, "the item's last word is the approval");
  // a lone comment, straight through the connector: sent once, and the caller is told it may have been saved
  const lone = history("1051").length;
  ADO_FIXTURES.state.loseAnswers = 1;
  await assert.rejects(() => writeToWorkItem("1051", { comment: "<div>once</div>" }), (e: any) => e.sent === "unanswered" && e.unreachable === true);
  assert.equal(history("1051").length, lone + 1);
  await admin({ stage: true });
});

test("when the source stops answering or throttles, the rest of a sweep waits instead of timing out item by item", async () => {
  saveWritebackSettings({ ...writebackSettings(), tag_prefix: "gov/" }); // every tagged item now needs a write
  ADO_FIXTURES.state.unreachable = true;
  let r = await sweep({ force: true }).finally(quiet);
  assert.equal(r.failed, 3); assert.ok(r.waiting >= 2, `waiting ${r.waiting}`);
  ADO_FIXTURES.state.throttled = true;
  r = await sweep({ force: true }).finally(quiet);
  assert.equal(r.failed, 3, "a throttled source is left alone just the same");
  r = await sweep({ force: true });
  assert.equal(r.failed, 0); assert.ok(r.written >= 5);
  assert.ok(!["1042", "1051", "1063", "1070", "1077", "1081"].some((e) => stageTagsOn(e).some((t) => t.startsWith("arch:"))), "the old prefix is gone everywhere");
});

test("turning it off is not undone by a sweep in flight or by a change that lands meanwhile", async () => {
  const { audit } = await import("../src/db.js");
  saveWritebackSettings({ ...writebackSettings(), tag_prefix: "arch:" });
  ADO_FIXTURES.state.latencyMs = 60;
  const running = sweep({ force: true }); // retagging every item, slowly
  await new Promise((r) => setTimeout(r, 90));
  const off = admin({ enabled: false });
  audit("test", "work_item_changed", "work_items", item("1042").id, {}); // what a service-hook echo of the clean-up looks like
  const [swept, res] = await Promise.all([running, off]).finally(quiet);
  assert.ok(swept.written < 5, `the sweep stopped once it was off (wrote ${swept.written})`);
  assert.equal(res.body.enabled, false); assert.equal(res.body.cleanup.failed, 0); assert.equal(res.body.tagged, 0);
  await new Promise((r) => setTimeout(r, 1800));
  for (const e of ["1042", "1051", "1063", "1070", "1077", "1081"]) assert.deepEqual(stageTagsOn(e), [], e);
  assert.equal(writebackStatus().tagged, 0);
});

test("a clean-up that could not reach the source says so, and can be asked again", async () => {
  await admin({ enabled: true });
  const tagged = writebackStatus().tagged;
  assert.ok(tagged >= 5);
  ADO_FIXTURES.state.unreachable = true;
  let r = await admin({ enabled: false }).finally(quiet);
  assert.equal(r.body.enabled, false, "it is off all the same");
  assert.equal(r.body.cleanup.removed, 0); assert.equal(r.body.cleanup.failed, tagged);
  assert.equal(r.body.tagged, tagged, "the tags stay on record"); assert.equal(r.body.errors, 0, "nothing is being tried again while it is off");
  r = await admin({ enabled: false, remove_tags: true });
  assert.equal(r.body.cleanup.removed, tagged); assert.equal(r.body.tagged, 0);
  for (const e of ["1042", "1051", "1063", "1070", "1077", "1081"]) assert.deepEqual(stageTagsOn(e), [], e);
  // off and clean: asking again does nothing
  assert.equal((await admin({ enabled: false, remove_tags: true })).body.cleanup.removed, 0);
});

test("turned off, a tag that was written unseen is found and taken off too; a deleted item does not hold the clean-up up", async () => {
  // on: the first write is saved, its answer lost, and the source gone before anything can be read again
  saveWritebackSettings({ ...writebackSettings(), enabled: true });
  Object.assign(ADO_FIXTURES.state, { loseAnswers: 1, thenUnreachable: true });
  const on = await sweep({ force: true }).finally(quiet);
  assert.ok(on.failed >= 1);
  const unseen = ["1042", "1051", "1063", "1070", "1077", "1081"].find((e) => stageTagsOn(e).length === 1)!;
  assert.ok(unseen, "one item carries a tag the record does not know"); assert.equal(row(unseen).tag, null); assert.ok(row(unseen).pending_json);
  assert.ok(writebackStatus().tagged >= 1, "it counts as possibly tagged until it is settled");
  await sweep({ force: true }); // the rest get their tags
  // one of them is then deleted at the source
  db.prepare("UPDATE work_items SET state='Removed' WHERE external_id='1081'").run();
  ADO_FIXTURES.state.gone = ["1081"];
  const r = await admin({ enabled: false }).finally(quiet);
  assert.equal(r.body.cleanup.failed, 0); assert.equal(r.body.tagged, 0);
  for (const e of ["1042", "1051", "1063", "1070", "1077"]) assert.deepEqual(stageTagsOn(e), [], e);
  db.prepare("UPDATE work_items SET state='New' WHERE external_id='1081'").run();
});

test("turned off moments after a write whose save is still landing: it is not judged early, and nothing is said twice", async () => {
  saveWritebackSettings({ ...writebackSettings(), enabled: true });
  await sweep({ force: true });
  const said = history("1042").length;
  WRITEBACK_TIMING.settleAfterMs = 60_000;
  let off: any;
  try {
    db.prepare("UPDATE work_items SET material_change=0 WHERE external_id='1042'").run(); // its stage moves: a tag to replace
    Object.assign(ADO_FIXTURES.state, { loseAnswers: 1, saveLateMs: 60 });
    assert.equal((await sweep({ force: true })).failed, 1);
    off = await admin({ enabled: false }); // inside the gap: the error is back, the save is not
    assert.equal(off.body.cleanup.failed, 1, "the item is left on record, not judged unsaved");
    assert.ok(off.body.tagged >= 1); assert.ok(row("1042").pending_json);
    await new Promise((r) => setTimeout(r, 120)); // the save lands
    assert.deepEqual(stageTagsOn("1042"), ["arch:approved-with-conditions"]);
  } finally { WRITEBACK_TIMING.settleAfterMs = 0; quiet(); }
  const again = await admin({ enabled: false, remove_tags: true });
  assert.equal(again.body.cleanup.failed, 0); assert.equal(again.body.tagged, 0);
  assert.deepEqual(stageTagsOn("1042"), [], "the tag that landed late is found and taken off");
  const lines = history("1042").length;
  await admin({ enabled: true });
  assert.equal(history("1042").length, lines, "turned on again, nothing it already said is said again");
  db.prepare("UPDATE work_items SET material_change=1 WHERE external_id='1042'").run();
  await sweep({ force: true });
  assert.ok(said <= lines);
});

test("the clean-up lets go of what it can do nothing about, so it can finish", async () => {
  // on, everything tagged; then one item is deleted at the source without archigov hearing of it, and one moves project
  assert.ok(stageTagsOn("1051").length === 1 && stageTagsOn("1077").length === 1);
  ADO_FIXTURES.state.gone = ["1051"];
  const r = await admin({ enabled: false }).finally(quiet);
  assert.equal(r.body.cleanup.failed, 0); assert.equal(r.body.cleanup.let_go, 1); assert.equal(r.body.tagged, 0);
  assert.equal(row("1051").tag, null);
  // when the source answers for no item at all, a 404 is more likely lost access: the records are kept
  await admin({ enabled: true });
  const tagged = writebackStatus().tagged;
  ADO_FIXTURES.state.gone = ["1042", "1051", "1063", "1070", "1077", "1081"];
  const none = await admin({ enabled: false }).finally(quiet);
  assert.equal(none.body.cleanup.failed, tagged); assert.equal(none.body.tagged, tagged);
  // an item now in another project is not written to, and is let go
  process.env.ADO_PROJECT = "Another-Project";
  try {
    const moved = await admin({ enabled: false, remove_tags: true });
    assert.equal(moved.body.cleanup.failed, 0); assert.equal(moved.body.cleanup.let_go, tagged); assert.equal(moved.body.tagged, 0);
  } finally { delete process.env.ADO_PROJECT; }
  // (their tags are still on those items in the fixture: put the house in order for what follows)
  for (const e of ["1042", "1051", "1063", "1070", "1077", "1081"]) { const mine = stageTagsOn(e); if (mine.length) await writeToWorkItem(e, { removeTags: mine }); }
});

test("writes that get no answer stop a sweep after three in a row, even while reads still answer", async () => {
  await admin({ enabled: true });
  saveWritebackSettings({ ...writebackSettings(), tag_prefix: "gov/" }); // every tagged item needs a write
  ADO_FIXTURES.state.failWrites = 99;
  let r = await sweep({ force: true });
  assert.equal(r.failed, 3, "first time round");
  r = await sweep({ force: true }).finally(quiet); // now three of them have a kept document to settle first: the read answers, the write does not
  assert.equal(r.failed, 3, "a read that answers does not reset the count");
  saveWritebackSettings({ ...writebackSettings(), tag_prefix: "arch:" });
  r = await sweep({ force: true });
  assert.equal(r.failed, 0);
  await admin({ enabled: false });
});

test("nothing is written outside the configured project, when it is given by name", async () => {
  process.env.ADO_PROJECT = "Another-Project";
  try {
    await assert.rejects(() => writeToWorkItem("1051", { addTags: ["arch:in-review"] }), /belongs to the project Clinical-Platform: write-back writes only inside Another-Project/);
    assert.ok(!tagsOf("1051").includes("arch:in-review"));
    const t = await testWriteAccess();
    assert.equal(t.ok, false); assert.match((t as any).error, /writes only inside/);
    // given as an ID there is no name to compare: the request is left to the identity's permissions
    process.env.ADO_PROJECT = "6ce954b1-ce1f-45d1-b94d-e6bf2464ba2c";
    assert.equal((await testWriteAccess()).ok, true);
  } finally { delete process.env.ADO_PROJECT; }
});
