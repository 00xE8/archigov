import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "archigov-raise-"));
process.env.ARCHIGOV_FIXTURES = "1";
process.env.APP_BASE_URL = "https://archigov.example";
delete process.env.AUTH_MODE;
const { migrate, db, uid, nowIso } = await import("../src/db.js");
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
const { WRITEBACK_TIMING, writebackSettings } = await import("../src/writeback.js");
WRITEBACK_TIMING.settleAfterMs = 0; // no test waits for a late answer, except the one about it
const { startRaise, refreshRaised, raisedOf } = await import("../src/raise.js");
const { ADO_FIXTURES } = await import("../src/ado/fixtures.js");
const { syncAdo, handleAdoHook } = await import("../src/ado/sync.js");
startRaise();

// REV-0006 covers epic 1042 and was approved with two conditions
const review = db.prepare("SELECT * FROM reviews WHERE code='REV-0006'").get() as any;
const epic = db.prepare("SELECT * FROM work_items WHERE external_id='1042'").get() as any;
const conds = () => db.prepare("SELECT * FROM conditions WHERE review_id=? ORDER BY created_at, id").all(review.id) as any[];
const addCondition = (text: string, owner: string | null = null) => { const id = uid(); db.prepare("INSERT INTO conditions(id,review_id,text,owner,due_at,status,created_at) VALUES (?,?,?,?,?,?,?)").run(id, review.id, text, owner, "2026-12-01", "open", nowIso()); return id; };
const admin = (body: Record<string, unknown>) => call("POST", "/sources/ado/writeback", "ops.admin", body);
const raise = (id: string, user: string, body: Record<string, unknown> = {}) => call("POST", `/conditions/${id}/raise`, user, body);
const made = () => ADO_FIXTURES.created();
const audits = (action: string) => (db.prepare("SELECT count(*) n FROM audit_log WHERE action=?").get(action) as any).n as number;
const events = (kind: string) => (db.prepare("SELECT count(*) n FROM review_events WHERE review_id=? AND kind=?").get(review.id, kind) as any).n as number;
const quiet = () => Object.assign(ADO_FIXTURES.state, { denyWrites: false, loseAnswers: 0, thenUnreachable: false, saveLateMs: 0, failWrites: 0, unreachable: false, throttled: false, gone: [], latencyMs: 0 });
const submitter = review.submitted_by as string;

test("the demo review is what these tests need: approved with conditions, covering an Azure DevOps epic", () => {
  assert.equal(review.stage, "approved_with_conditions"); assert.equal(epic.review_id, review.id);
  assert.ok(conds().length >= 2); assert.ok(submitter);
});

test("off by default: the review says why a condition cannot be raised, and nothing is created", async () => {
  assert.equal(writebackSettings().raise, false); assert.equal(writebackSettings().raise_type, "Task");
  const r = (await call("GET", `/reviews/${review.id}`, submitter)).body;
  assert.equal(r.raise.available, false); assert.match(r.raise.reason, /is off\. A platform admin turns it on/);
  assert.equal(r.conditions[0].raised, null); assert.equal(r.conditions[0].can_raise, true, "the right is the person's; the switch is the admin's");
  const no = await raise(conds()[0].id, submitter);
  assert.equal(no.status, 409); assert.match(no.body.error, /is off/);
  // write-back on without this capability is still off for raising
  assert.equal((await admin({ enabled: true })).body.capabilities.find((c: any) => c.id === "raise").enabled, false);
  assert.equal((await raise(conds()[0].id, submitter)).status, 409);
  assert.equal(made().length, 0);
});

test("only a platform admin turns it on, and the type must be a type name", async () => {
  assert.equal((await call("POST", "/sources/ado/writeback", submitter, { raise: true })).status, 403);
  assert.equal((await admin({ raise: true, raise_type: "no/such;type" })).status, 400);
  const on = await admin({ raise: true, raise_type: "Task" });
  assert.equal(on.status, 200); assert.equal(on.body.raise, true); assert.equal(on.body.raise_type, "Task");
  const cap = on.body.capabilities.find((c: any) => c.id === "raise");
  assert.equal(cap.enabled, true); assert.equal(cap.available, true); assert.equal(on.body.raised, 0);
  // raising alone is a valid choice: nothing else has to be written
  assert.equal((await admin({ link: false, stage: false, comment: false, raise: true })).status, 200);
  assert.equal((await admin({ link: true, stage: true, comment: true })).status, 200);
  const t = await call("POST", "/sources/ado/writeback/test", "ops.admin");
  assert.equal(t.body.ok, true); assert.deepEqual(t.body.create, { type: "Task", ok: true });
  assert.equal(made().length, 0, "the check creates nothing");
});

test("the owner, the submitter and the board's chair and secretary raise; an admin, an auditor and an onlooker do not", async () => {
  assert.equal(submitter, "m.hughes", "the demo's submitter holds a seat and no author role: the right comes from being the submitter");
  const c = conds()[0];
  for (const user of ["ops.admin", "a.uditor"]) assert.equal((await raise(c.id, user)).status, 403, user);
  const onlooker = "s.patel"; // an author with an advisory seat on the board: neither owner, submitter, chair nor secretary
  assert.ok(onlooker !== submitter && onlooker !== c.owner);
  const no = await raise(c.id, onlooker);
  assert.equal(no.status, 403, onlooker); assert.match(no.body.reason || no.body.error || "", /owner|submitter|chair/);
  assert.equal(made().length, 0);
  const seen = (await call("GET", `/reviews/${review.id}`, onlooker)).body;
  assert.equal(seen.raise.available, true); assert.equal(seen.conditions[0].can_raise, false);
  assert.deepEqual(seen.raise.parents.map((p: any) => p.external_id), ["1042"]); assert.equal(seen.raise.type, "Task");
});

test("raising makes one work item under the planned change, linked back, and says what closing it means", async () => {
  const c = conds()[0];
  const r = await raise(c.id, submitter);
  assert.equal(r.status, 200); assert.equal(r.body.ok, true);
  const raised = r.body.raised;
  assert.equal(raised.type, "Task"); assert.equal(raised.state, "New"); assert.equal(raised.closed, false); assert.equal(raised.raised_by, submitter);
  assert.match(raised.url, /^https:\/\/dev\.azure\.com\/sehealth\/Clinical-Platform\/_workitems\/edit\/\d+$/);
  assert.equal(made().length, 1);
  const item = made()[0];
  assert.equal(String(item.id), raised.external_id);
  assert.equal(item.fields["System.Title"], `Condition of REV-0006: ${c.text}`.slice(0, 255));
  assert.equal(item.fields["System.Tags"], "arch:condition");
  assert.equal(item.fields["System.AreaPath"], ADO_FIXTURES.get("1042").fields["System.AreaPath"], "the same area as the change it belongs under");
  const d = String(item.fields["System.Description"]);
  assert.ok(d.includes(c.text.replace(/&/g, "&amp;")) || d.includes(c.text));
  assert.match(d, /a condition of the approval of review REV-0006/); assert.match(d, /<a href="https:\/\/archigov\.example\/reviews\//);
  assert.match(d, /The board then confirms in archigov that the condition is met/);
  assert.doesNotMatch(d, /Archigov|compliant/);
  assert.deepEqual(item.relations.map((x: any) => x.rel), ["System.LinkTypes.Hierarchy-Reverse", "Hyperlink"]);
  assert.equal(item.relations[1].url, `https://archigov.example/reviews/${review.id}?condition=${c.id}`);
  assert.ok(ADO_FIXTURES.get("1042").relations.some((x: any) => x.rel === "System.LinkTypes.Hierarchy-Forward" && x.url.endsWith(`/${item.id}`)), "the epic shows it as its child");
  // on the record: the audit chain, the review's timeline, the review's answer, the evidence pack
  assert.equal(audits("writeback:raise"), 1); assert.equal(events("condition_raised"), 1);
  const seen = (await call("GET", `/reviews/${review.id}`, submitter)).body.conditions.find((x: any) => x.id === c.id);
  assert.equal(seen.raised.external_id, raised.external_id); assert.ok(["open", "overdue"].includes(seen.status), "raising does not meet the condition");
  assert.equal((await call("GET", "/sources/ado/writeback", submitter)).body.raised, 1);
  // asking again makes nothing
  const again = await raise(c.id, submitter);
  assert.equal(again.status, 409); assert.match(again.body.error, /already raised as Task/); assert.equal(again.body.raised.external_id, raised.external_id);
  assert.equal(made().length, 1);
});

test("the feed leaves a raised work item alone: it is not a planned change, and the hook's word on it is its state", async () => {
  const c = conds()[0], ext = raisedOf(c.id)!.external_id as string;
  const before = (db.prepare("SELECT count(*) n FROM work_items").get() as any).n;
  // a service hook for it (subscriptions cover every work item in the project): a state change, as a field diff
  const hook = handleAdoHook({ eventType: "workitem.updated", resource: { workItemId: Number(ext), rev: 2, fields: { "System.State": { oldValue: "New", newValue: "Active" } }, revision: { rev: 2, fields: { "System.Title": "x", "System.WorkItemType": "Task" } } } });
  assert.equal(hook.outcome, "claimed");
  assert.equal((db.prepare("SELECT count(*) n FROM work_items").get() as any).n, before, "no planned change was made of it");
  assert.equal(raisedOf(c.id)!.state, "Active");
  assert.equal((await syncAdo("test")).ok, true);
  assert.equal((db.prepare("SELECT count(*) n FROM work_items").get() as any).n, before);
});

test("closing the work item is evidence, and prompts the chair: it does not meet the condition", async () => {
  const c = conds()[0], ext = raisedOf(c.id)!.external_id as string;
  ADO_FIXTURES.setState(ext, "Closed");
  const r = await refreshRaised("test");
  assert.equal(r.checked, 1);
  const v = raisedOf(c.id)!;
  assert.equal(v.state, "Closed"); assert.equal(v.closed, true); assert.ok(v.closed_at);
  assert.ok(["open", "overdue"].includes((db.prepare("SELECT status FROM conditions WHERE id=?").get(c.id) as any).status), "the board has not said so yet");
  assert.equal(events("condition_work_closed"), 1); assert.equal(audits("writeback:raised_closed"), 1);
  // the chair of the board is prompted; the owner sees it on their own condition
  const chair = (await call("GET", "/me/work", "j.duduka")).body;
  assert.equal(chair.confirm.length, 1); assert.equal(chair.confirm[0].id, c.id); assert.equal(chair.confirm[0].raised.closed, true);
  assert.equal((await call("GET", "/me/work", "m.hughes")).body.confirm.length, 0, "a decision maker is not asked to confirm");
  // reading back twice says it once
  await refreshRaised("test");
  assert.equal(events("condition_work_closed"), 1);
  // the team reopens it: said too, and the prompt goes
  ADO_FIXTURES.setState(ext, "Active");
  await refreshRaised("test");
  assert.equal(raisedOf(c.id)!.closed, false); assert.equal(events("condition_work_reopened"), 1);
  assert.equal((await call("GET", "/me/work", "j.duduka")).body.confirm.length, 0);
  ADO_FIXTURES.setState(ext, "Closed");
  await refreshRaised("test");
  // the chair confirms: the condition is met by a person, and stops being read back
  assert.equal((await call("POST", `/conditions/${c.id}/close`, "j.duduka", { status: "met" })).status, 200);
  assert.equal((await call("GET", "/me/work", "j.duduka")).body.confirm.length, 0);
  assert.equal((await refreshRaised("test")).checked, 0);
  assert.equal((await raise(c.id, submitter)).status, 409, "a met condition is not raised");
});

test("the evidence pack says where the work was tracked, as evidence of the work and not of the condition", async () => {
  const pack = (await call("GET", `/evidence-pack?application=${review.application_id}`, "a.uditor")).body;
  const rv = (pack.applications || []).flatMap((a: any) => a.reviews || []).find((x: any) => x.code === "REV-0006");
  assert.ok(rv, "the review is in the pack");
  const withItem = rv.conditions.filter((x: any) => x.work_item);
  assert.equal(withItem.length, 1); assert.equal(withItem[0].work_item.source, "azure_devops"); assert.equal(withItem[0].work_item.state, "Closed"); assert.equal(withItem[0].status, "met");
});

test("no answer from Azure DevOps: the request is kept, and asking again finds the work item instead of making another", async () => {
  const id = addCondition("Run a restore test of the document store before go-live", submitter);
  ADO_FIXTURES.state.loseAnswers = 1;
  const first = await raise(id, submitter).finally(quiet);
  assert.equal(first.status, 202); assert.equal(first.body.unconfirmed, true); assert.equal(first.body.raised.unconfirmed, true); assert.equal(first.body.raised.external_id, null);
  assert.equal(made().length, 2, "it had been made");
  assert.equal(audits("writeback:raise_unanswered"), 1);
  const again = await raise(id, submitter);
  assert.equal(again.status, 200); assert.equal(made().length, 2, "found, not made twice");
  assert.equal(again.body.raised.external_id, String(made()[1].id)); assert.equal(again.body.raised.unconfirmed, false);
  assert.equal(audits("writeback:raise"), 2);
});

test("an answer that comes after its error is given time: asked again at once, nothing is made twice", async () => {
  const id = addCondition("Agree the retention schedule with the records manager", submitter);
  WRITEBACK_TIMING.settleAfterMs = 60_000;
  try {
    Object.assign(ADO_FIXTURES.state, { loseAnswers: 1, saveLateMs: 50 });
    assert.equal((await raise(id, submitter)).status, 202);
    assert.equal(made().length, 2, "not made yet when the error came back");
    const early = await raise(id, submitter);
    assert.equal(early.status, 409); assert.equal(early.body.waiting, true);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(made().length, 3, "it landed");
  } finally { WRITEBACK_TIMING.settleAfterMs = 0; quiet(); }
  const r = await raise(id, submitter);
  assert.equal(r.status, 200); assert.equal(made().length, 3, "one work item, however often it was asked");
});

test("a refusal makes nothing and releases the condition, so it can be raised once the cause is fixed", async () => {
  const id = addCondition("Document the break-glass procedure", submitter);
  ADO_FIXTURES.state.denyWrites = true;
  const no = await raise(id, submitter).finally(quiet);
  assert.equal(no.status, 502); assert.match(no.body.error, /Azure DevOps did not create the work item: .*403/);
  assert.equal(raisedOf(id), null); assert.equal(made().length, 3);
  // a type the project does not have: said at the test, and at the click
  await admin({ raise_type: "Impediment" });
  assert.deepEqual((await call("POST", "/sources/ado/writeback/test", "ops.admin")).body.create.ok, false);
  const wrong = await raise(id, submitter);
  assert.equal(wrong.status, 502); assert.match(wrong.body.error, /does not exist in project/); assert.equal(raisedOf(id), null);
  await admin({ raise_type: "Issue" });
  const ok = await raise(id, submitter, { title: "Break-glass procedure, documented and rehearsed" });
  assert.equal(ok.status, 200); assert.equal(ok.body.raised.type, "Issue"); assert.equal(made()[3].fields["System.Title"], "Break-glass procedure, documented and rehearsed");
  await admin({ raise_type: "Task" });
});

test("a review that covers several work items asks which; one that covers none cannot raise", async () => {
  const id = addCondition("Confirm the supplier's data location in writing", submitter);
  db.prepare("UPDATE work_items SET review_id=? WHERE external_id='1051'").run(review.id);
  const several = await raise(id, submitter);
  assert.equal(several.status, 400); assert.match(several.body.error, /several work items/);
  const other = db.prepare("SELECT id FROM work_items WHERE external_id='1051'").get() as any;
  const ok = await raise(id, submitter, { work_item_id: other.id });
  assert.equal(ok.status, 200);
  assert.ok(ADO_FIXTURES.get("1051").relations.some((x: any) => x.rel === "System.LinkTypes.Hierarchy-Forward"));
  db.prepare("UPDATE work_items SET review_id=NULL WHERE external_id='1051'").run();
  // a review with no Azure DevOps work item behind it
  const bare = db.prepare("SELECT r.* FROM reviews r WHERE NOT EXISTS (SELECT 1 FROM work_items w WHERE w.review_id=r.id) AND r.work_item_id IS NULL LIMIT 1").get() as any;
  assert.ok(bare);
  const seen = (await call("GET", `/reviews/${bare.id}`, submitter)).body;
  assert.equal(seen.raise.available, false); assert.match(seen.raise.reason, /covers no Azure DevOps work item/);
});

test("a raised work item deleted at the source is said to be gone; the condition stays the board's", async () => {
  const id = addCondition("Pen-test the upload endpoint", submitter);
  const ext = (await raise(id, submitter)).body.raised.external_id as string;
  ADO_FIXTURES.state.gone = [ext];
  const r = await refreshRaised("test").finally(quiet);
  assert.equal(r.gone, 1); assert.equal(raisedOf(id)!.gone, true); assert.equal(events("condition_work_gone"), 1);
  assert.equal((db.prepare("SELECT status FROM conditions WHERE id=?").get(id) as any).status, "open");
  assert.equal((await refreshRaised("test")).checked, (await refreshRaised("test")).checked, "it is not asked after again");
});

// ---------- what an independent review of the raise path found, each pinned ----------

test("two people raising the same condition at the same moment make one work item", async () => {
  const id = addCondition("Review the firewall rules with the network team", submitter);
  const before = made().length;
  ADO_FIXTURES.state.latencyMs = 40;
  const [a, b] = await Promise.all([raise(id, submitter), raise(id, "j.duduka")]).finally(quiet);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal([a, b].find((x) => x.status === 409)!.body.waiting, true);
  assert.equal(made().length, before + 1); assert.ok(raisedOf(id)!.external_id);
  // a first request that is merely slow: the second does not go ahead of it, however long it takes
  const slow = addCondition("Size the storage for ten years of retention", submitter);
  WRITEBACK_TIMING.settleAfterMs = 20;
  try {
    ADO_FIXTURES.state.latencyMs = 150;
    const first = raise(slow, submitter);
    await new Promise((r) => setTimeout(r, 80)); // past the grace, the first still in flight
    const second = await raise(slow, "j.duduka");
    assert.equal(second.status, 409); assert.equal(second.body.waiting, true);
    assert.equal((await first).status, 200);
  } finally { WRITEBACK_TIMING.settleAfterMs = 0; quiet(); }
  assert.equal(made().length, before + 2);
});

test("a work item made unseen is found again even after the team moved it, or the instance changed address", async () => {
  const moved = addCondition("Name a data owner for the attachment store", submitter);
  ADO_FIXTURES.state.loseAnswers = 1;
  assert.equal((await raise(moved, submitter).finally(quiet)).status, 202);
  const count = made().length, ext = String(made()[count - 1].id);
  ADO_FIXTURES.reparent(ext, "1063"); // the team files it under another epic before anyone asks again
  const again = await raise(moved, submitter);
  assert.equal(again.status, 200); assert.equal(again.body.raised.external_id, ext); assert.equal(made().length, count, "found among the tagged work items, not made twice");
  const rehomed = addCondition("Record the DPIA outcome on the design", submitter);
  ADO_FIXTURES.state.loseAnswers = 1;
  assert.equal((await raise(rehomed, submitter).finally(quiet)).status, 202);
  process.env.APP_BASE_URL = "https://governance.example/"; // the instance moves; the work item's link still carries the old address
  try {
    const r = await raise(rehomed, submitter);
    assert.equal(r.status, 200); assert.equal(made().length, count + 1, "the same work item, recognised by the path of its link");
  } finally { process.env.APP_BASE_URL = "https://archigov.example"; }
});

test("a request nobody asks after again is settled by the read-back: found, or let go", async () => {
  const found = addCondition("Add the service to the DR runbook", submitter);
  ADO_FIXTURES.state.loseAnswers = 1;
  assert.equal((await raise(found, submitter).finally(quiet)).status, 202);
  WRITEBACK_TIMING.settleAfterMs = 60_000;
  assert.equal((await refreshRaised("test")).settled, 0, "not while it may still be landing");
  WRITEBACK_TIMING.settleAfterMs = 0;
  const raisedBefore = audits("writeback:raise");
  assert.equal((await refreshRaised("test")).settled, 1);
  assert.ok(raisedOf(found)!.external_id); assert.equal(raisedOf(found)!.unconfirmed, false); assert.equal(audits("writeback:raise"), raisedBefore + 1);
  // never made at all: the claim is released, and the condition can be raised afresh
  const lost = addCondition("Publish the support rota", submitter);
  const count = made().length;
  ADO_FIXTURES.state.failWrites = 1;
  assert.equal((await raise(lost, submitter).finally(quiet)).status, 202);
  assert.equal(made().length, count);
  assert.equal((await refreshRaised("test")).settled, 1);
  assert.equal(raisedOf(lost), null); assert.equal(audits("writeback:raise_not_found"), 1);
  assert.equal((await raise(lost, submitter)).status, 200); assert.equal(made().length, count + 1);
  // its parent taken out of the backlog meanwhile: still asked again as it was made, and still settled
  const orphan = addCondition("Agree the cut-over window with operations", submitter);
  ADO_FIXTURES.state.loseAnswers = 1;
  assert.equal((await raise(orphan, submitter).finally(quiet)).status, 202);
  db.prepare("UPDATE work_items SET state='Removed' WHERE external_id='1042'").run();
  try {
    const r = await raise(orphan, submitter);
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.ok(raisedOf(orphan)!.external_id);
  } finally { db.prepare("UPDATE work_items SET state='Active' WHERE external_id='1042'").run(); }
});

test("a work item the source does not return is not called gone unless the source can still be read; one that comes back is seen", async () => {
  const id = addCondition("Enable soft delete on the vault", submitter);
  const ext = (await raise(id, submitter)).body.raised.external_id as string;
  const goneEvents = events("condition_work_gone"), backEvents = events("condition_work_back");
  // the identity loses its access: nothing comes back, the parent cannot be read either
  ADO_FIXTURES.state.gone = [ext, "1042"];
  let r = await refreshRaised("test").finally(quiet);
  assert.equal(r.gone, 0); assert.equal(raisedOf(id)!.gone, false); assert.equal(events("condition_work_gone"), goneEvents, "lost access is not a deletion");
  // really deleted: the parent is still there
  ADO_FIXTURES.state.gone = [ext];
  r = await refreshRaised("test").finally(quiet);
  assert.equal(raisedOf(id)!.gone, true); assert.equal(events("condition_work_gone"), goneEvents + 1);
  // restored from the recycle bin: it is asked after on every pass, so it is seen again
  ADO_FIXTURES.setState(ext, "Active");
  await refreshRaised("test");
  assert.equal(raisedOf(id)!.gone, false); assert.equal(raisedOf(id)!.state, "Active"); assert.ok(events("condition_work_back") > backEvents);
  // taken out of the backlog without being done: said, and not taken for done
  ADO_FIXTURES.setState(ext, "Removed");
  await refreshRaised("test");
  assert.equal(raisedOf(id)!.closed, false); assert.ok(events("condition_work_removed") >= 1);
});

test("the hook can be quicker than the answer: a work item carrying the condition tag is never made a planned change", async () => {
  const before = (db.prepare("SELECT count(*) n FROM work_items").get() as any).n;
  const early = handleAdoHook({ eventType: "workitem.created", resource: { id: 9777, rev: 1, fields: { "System.Title": "Condition of REV-0006: something", "System.WorkItemType": "Task", "System.State": "New", "System.Tags": "arch:condition" } } });
  assert.equal(early.outcome, "claimed"); assert.equal((db.prepare("SELECT count(*) n FROM work_items").get() as any).n, before);
  // and should a planned change have been made of one all the same (a payload without its tags), confirming the request takes it out again
  const id = addCondition("Rotate the storage keys", submitter);
  ADO_FIXTURES.state.loseAnswers = 1;
  assert.equal((await raise(id, submitter).finally(quiet)).status, 202);
  const ext = String(made()[made().length - 1].id);
  handleAdoHook({ eventType: "workitem.created", resource: { id: Number(ext), rev: 1, fields: { "System.Title": "Condition of REV-0006: Rotate the storage keys", "System.WorkItemType": "Task", "System.State": "New" } } });
  assert.equal((db.prepare("SELECT state FROM work_items WHERE external_id=?").get(ext) as any).state, "New", "the stray row exists");
  assert.equal((await raise(id, submitter)).status, 200);
  assert.equal((db.prepare("SELECT state FROM work_items WHERE external_id=?").get(ext) as any).state, "Removed", "and is out of the planned changes once the work item is known for what it is");
  assert.ok(!(await call("GET", "/work-items", submitter)).body.some((w: any) => String(w.external_id) === ext && w.state !== "Removed"));
});

test("an owner raises by being the owner, with no role and no seat; an auditor or an admin-only identity named as owner does not", async () => {
  const { upsertUser } = await import("../src/auth/users.js");
  upsertUser("delivery.lead", { name: "Dana Delivery", user_type: null, is_platform_admin: false }); // known to the instance, given no role and no seat
  const id = addCondition("Hand the runbook to the service desk", "delivery.lead");
  const r = await raise(id, "delivery.lead");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const other = addCondition("Something that is not theirs", submitter);
  assert.equal((await raise(other, "delivery.lead")).status, 403, "being signed in is not standing");
  const audited = addCondition("Attest the control", "a.uditor");
  assert.equal((await raise(audited, "a.uditor")).status, 403);
  // the platform admin flag alone runs the instance and changes nothing in governance, even named as owner
  const admins = addCondition("Rotate the signing key", "ops.admin");
  assert.equal((await raise(admins, "ops.admin")).status, 403);
  // (in local mode an unknown x-user is such an identity too: typing a name into the header raises nothing)
  const typed = addCondition("Owner typed in by name", "Dana Delivery");
  assert.equal((await raise(typed, "Dana Delivery")).status, 403);
  // a type name in another language is a type name
  assert.equal((await admin({ raise_type: "Aufgabe für Betrieb" })).status, 200);
  assert.equal((await admin({ raise_type: "Task" })).status, 200);
});

test("the condition tag on something that already is a planned change claims nothing", async () => {
  const epic1063 = db.prepare("SELECT * FROM work_items WHERE external_id='1063'").get() as any;
  // somebody puts the condition tag on an epic, and then its text is edited: the feed must still take the edit in
  const hook = handleAdoHook({ eventType: "workitem.updated", resource: { workItemId: 1063, rev: (epic1063.rev || 0) + 50, revision: { rev: (epic1063.rev || 0) + 50,
    fields: { "System.Title": epic1063.title, "System.WorkItemType": "Epic", "System.State": "Active", "System.Tags": "ai; arch:condition", "System.Description": "<div>An edited description</div>" } } } });
  assert.notEqual(hook.outcome, "claimed"); assert.equal(hook.outcome, "updated");
  assert.match((db.prepare("SELECT description FROM work_items WHERE external_id='1063'").get() as any).description, /An edited description/);
});

test("a request sent under one tag prefix is still found after the prefix changed and the team moved the work item", async () => {
  const id = addCondition("Confirm the archive format with records management", submitter);
  ADO_FIXTURES.state.loseAnswers = 1;
  assert.equal((await raise(id, submitter).finally(quiet)).status, 202);
  const count = made().length, ext = String(made()[count - 1].id);
  assert.equal((await admin({ tag_prefix: "gov/" })).status, 200);
  ADO_FIXTURES.reparent(ext, "1063");
  try {
    const r = await raise(id, submitter);
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.raised.external_id, ext); assert.equal(made().length, count, "looked for under the tag it went out with");
  } finally { await admin({ tag_prefix: "arch:" }); }
});

test("the read-back settling a request and a person asking again at the same moment do not trip over each other", async () => {
  const id = addCondition("Check the retention labels in the test tenant", submitter);
  ADO_FIXTURES.state.loseAnswers = 1;
  assert.equal((await raise(id, submitter).finally(quiet)).status, 202);
  const count = made().length;
  const [settled, clicked] = await Promise.all([refreshRaised("test"), raise(id, submitter)]);
  assert.ok([200, 409].includes(clicked.status), JSON.stringify(clicked.body));
  if (clicked.status === 200) assert.ok(clicked.body.raised?.external_id, "a click that goes through answers with the work item");
  else assert.equal(settled.settled >= 1, true);
  if (!raisedOf(id)?.external_id) await refreshRaised("test");
  assert.ok(raisedOf(id)!.external_id, "one way or the other it is on record"); assert.equal(made().length, count, "and there is one work item");
});

test("turned off again: nothing more can be raised, and what was raised goes on being read back", async () => {
  const open = conds().find((c) => c.status === "open" && raisedOf(c.id)?.external_id && !raisedOf(c.id)!.gone)!;
  assert.equal((await admin({ raise: false })).status, 200);
  const fresh = addCondition("One more thing", submitter);
  assert.equal((await raise(fresh, submitter)).status, 409);
  ADO_FIXTURES.setState(open && raisedOf(open.id)!.external_id as string, "Resolved");
  await refreshRaised("test");
  assert.equal(raisedOf(open.id)!.closed, true, "Resolved is the team saying the work is done, too");
  const seen = (await call("GET", `/reviews/${review.id}`, submitter)).body;
  assert.equal(seen.raise.available, false); assert.ok(seen.conditions.find((x: any) => x.id === open.id).raised.external_id);
  await admin({ enabled: false });
  assert.equal((await refreshRaised("test")).checked >= 1, true, "reading back needs no switch");
});

test("the address a person opens follows the organisation the service answers from; other hosts are left alone", async () => {
  const { webAddressFollowing } = await import("../src/ado/raise.js");
  const html = "https://dev.azure.com/jacint/342d7bf6-10d7-4d5e-bf8e-113ab66a94d5/_workitems/edit/5";
  assert.equal(webAddressFollowing(html, "https://dev.azure.com/archigovcustomer/_apis/wit/workItems/5"), "https://dev.azure.com/archigovcustomer/342d7bf6-10d7-4d5e-bf8e-113ab66a94d5/_workitems/edit/5", "renamed: every address moves with it");
  assert.equal(webAddressFollowing(html, "https://dev.azure.com/jacint/_apis/wit/workItems/5"), html, "same organisation: unchanged");
  assert.equal(webAddressFollowing(html, "https://ado.example.local/tfs/_apis/wit/workItems/5"), html, "another host says nothing about dev.azure.com addresses");
  assert.equal(webAddressFollowing(html, null), html); assert.equal(webAddressFollowing(null, "https://dev.azure.com/x/_apis/wit/workItems/5"), null);
});

test("the read-back moves a stored address to the organisation the service answers from, and a collection run by hand reads back too", async () => {
  const open = conds().find((c) => c.status === "open" && raisedOf(c.id)?.external_id && !raisedOf(c.id)!.gone)!;
  const ext = raisedOf(open.id)!.external_id as string;
  const was = raisedOf(open.id)!.url as string;
  assert.match(was, new RegExp(`^https://dev\\.azure\\.com/${ADO_FIXTURES.org}/`));
  // the organisation was renamed: the address on record still names the old one
  db.prepare("UPDATE condition_work_items SET url=? WHERE condition_id=?").run(was.replace(`/${ADO_FIXTURES.org}/`, "/old-name/"), open.id);
  assert.match(raisedOf(open.id)!.url as string, /old-name/);
  await refreshRaised("test");
  assert.equal(raisedOf(open.id)!.url, was, "the REST url of the read-back names the organisation, and the address follows it");
  // a collection run by hand (POST /sources/ado/sync) reads back as the scheduler does: a reopened work item is seen
  ADO_FIXTURES.setState(ext, "To Do");
  const r = await call("POST", "/sources/ado/sync", "ops.admin"); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(raisedOf(open.id)!.closed, false, "reopened at the source, seen by the collection without a sweep or a hook");
});
