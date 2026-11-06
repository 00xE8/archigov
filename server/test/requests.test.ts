import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "archigov-requests-"));
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
const { WRITEBACK_TIMING, writebackSettings, writebackStatus, sweep } = await import("../src/writeback.js");
WRITEBACK_TIMING.settleAfterMs = 0;
const { startRequests, reconcileRequests } = await import("../src/requests.js");
const { ADO_FIXTURES } = await import("../src/ado/fixtures.js");
const { splitTags } = await import("../src/ado/write.js");
const { handleAdoHook } = await import("../src/ado/sync.js");
startRequests();

const admin = (body: Record<string, unknown>) => call("POST", "/sources/ado/writeback", "ops.admin", body);
const sync = () => call("POST", "/sources/ado/sync", "ops.admin");
const item = (ext: string) => db.prepare("SELECT * FROM work_items WHERE external_id=?").get(ext) as any;
const row = async (ext: string, user = "s.patel") => (await call("GET", "/work-items", user)).body.find((w: any) => String(w.external_id) === ext);
const tagsOf = (ext: string) => splitTags(ADO_FIXTURES.get(ext).fields["System.Tags"]);
const history = (ext: string) => ADO_FIXTURES.written(ext)?.history ?? [];
const audits = (action: string) => (db.prepare("SELECT count(*) n FROM audit_log WHERE action=?").get(action) as any).n as number;
const requests = (ext: string) => db.prepare("SELECT q.* FROM review_requests q JOIN work_items w ON w.id=q.work_item_id WHERE w.external_id=? ORDER BY q.requested_at, q.rowid").all(ext) as any[];
/** The team puts a tag on, or takes it off, at the source; the backfill brings it in. */
const retag = async (ext: string, tags: string[]) => { ADO_FIXTURES.touch(ext, tags.join("; ")); const r = await sync(); assert.equal(r.status, 200, JSON.stringify(r.body)); };
const tick = () => new Promise((r) => setImmediate(r));
const openReview = async (ext: string, user = "s.patel") => {
  const w = item(ext);
  const r = await call("POST", "/reviews", user, { type: "design", title: w.title, application_id: w.application_id, work_item_id: w.id, risk_tier: "medium", summary: w.description, design_md: "## Design\n\nAs described on the work item.\n\n## Data\n\nNone.\n\n## Security\n\nPrivate endpoints.\n\n## Resilience\n\nZone redundant." });
  assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.body));
  await tick(); // the ask is answered at the end of the turn in which the review was opened
  return r.body;
};

test("off by default: the request tag is just a tag", async () => {
  assert.equal(writebackSettings().request, false);
  ADO_FIXTURES.addItem({ external_id: "1101", type: "User Story", title: "Export referral letters as PDF", tags: ["arch:review"], description: "Clinicians want letters as PDF." });
  await retag("1051", ["clinical-safety", "arch:review"]);
  const w = await row("1051");
  assert.equal(w.review_requested, false); assert.equal(w.lifecycle_stage, "needs_decision");
  assert.equal(item("1101"), undefined, "a story the backlog query does not reach is not fetched for a tag nobody is listening for");
  assert.equal((await call("GET", "/me/work", "s.patel")).body.requested.length, 0);
  assert.equal(requests("1051").length, 0);
  const st = (await call("GET", "/sources/ado/writeback", "s.patel")).body;
  assert.equal(st.request_tag, "arch:review"); assert.equal(st.requests_open, 0);
  assert.equal(st.prefix_in_use, 1, "while nobody is listening, arch:review is a tag of the team's under the prefix like any other");
  assert.equal(st.capabilities.find((c: any) => c.id === "request").enabled, false);
});

test("only a platform admin turns it on; from that moment the asks already on the backlog are heard", async () => {
  assert.equal((await call("POST", "/sources/ado/writeback", "s.patel", { enabled: true, request: true })).status, 403);
  // listening for asks alone is a valid choice: nothing else has to be written
  const on = await admin({ enabled: true, link: false, stage: false, comment: false, request: true });
  assert.equal(on.status, 200); assert.equal(on.body.request, true); assert.equal(on.body.requests_open, 1);
  assert.equal(audits("request:seen"), 1);
  const w = await row("1051");
  assert.equal(w.review_requested, true); assert.ok(w.review_requested_at);
  assert.equal(w.lifecycle_stage, "review_requested"); assert.equal(w.needs_decision, true, "it is still an epic without a decision");
  assert.equal(on.body.prefix_in_use, 0, "the request tag is the team's to type under the prefix: not a clash");
  assert.deepEqual(tagsOf("1051"), ["clinical-safety", "arch:review"], "nothing was written: only the request capability is on");
});

test("the ask is an author's to pick up, and nobody else's queue", async () => {
  const mine = (await call("GET", "/me/work", "s.patel")).body;
  assert.equal(mine.requested.length, 1); assert.equal(mine.requested[0].work_item.external_id, "1051"); assert.equal(mine.counts.requested, 1);
  for (const user of ["m.hughes", "a.uditor", "ops.admin"]) assert.equal((await call("GET", "/me/work", user)).body.requested.length, 0, user);
});

test("any work item: a story the backlog query does not cover comes in once it carries the tag", async () => {
  assert.equal((await sync()).status, 200);
  const story = await row("1101");
  assert.ok(story, "the tagged story is now a planned change"); assert.equal(story.type, "User Story");
  assert.equal(story.review_requested, true); assert.equal(story.lifecycle_stage, "review_requested"); assert.equal(story.needs_decision, false, "a story does not need a decision of its own");
  assert.equal((await call("GET", "/me/work", "s.patel")).body.requested.length, 2);
});

test("with the stage shown, the work item says the ask was heard; the team's tag is left alone", async () => {
  assert.equal((await admin({ stage: true, link: true, comment: true })).status, 200);
  assert.deepEqual(tagsOf("1051"), ["clinical-safety", "arch:review", "arch:review-requested"]);
  assert.equal(history("1051").length, 0, "hearing an ask is a tag, not a comment");
  assert.equal(writebackStatus().prefix_in_use, 0);
});

test("an author opens the review: the ask is answered, and the work item is told once, with the counts of the automatic checks", async () => {
  const rev = await openReview("1051");
  // an AI pre-review on the review, to show none of it crosses
  db.prepare("INSERT INTO review_events(id,review_id,kind,actor,body_md,data_json,origin,verification,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(uid(), rev.id, "pre_review", "system", "AI SAYS THE DESIGN IS RISKY", JSON.stringify({ engine: "llm", findings: [{ severity: "critical", title: "AI INVENTED FINDING", detail: "…", citations: [] }] }), "ai", "unverified", nowIso());
  const w = await row("1051");
  assert.equal(w.review_requested, false, "answered"); assert.equal(w.lifecycle_stage, "in_review");
  assert.equal(audits("request:answered"), 1);
  const q = requests("1051")[0];
  assert.equal(q.answered_review_id, rev.id); assert.ok(q.answered_at);
  assert.equal((await call("GET", "/me/work", "s.patel")).body.requested.some((x: any) => x.work_item.external_id === "1051"), false);
  await sweep({ force: true });
  const said = history("1051");
  assert.equal(said.length, 1);
  assert.match(said[0], new RegExp(`the review asked for on this item is open as ${rev.code} and is with Design Authority\\.`));
  assert.match(said[0], /The automatic checks against the catalogue and the accepted decisions found (nothing to address|\d+ points? to address \([^)]+\): [A-Z]{3}-\d{3}[^.]*)\./);
  assert.doesNotMatch(said[0], /section/i, "what the template misses in a design that is still the work item's own words is not counted");
  assert.match(said[0], new RegExp(`<a href="https://archigov\\.example/reviews/${rev.id}">Open the review</a>`));
  assert.doesNotMatch(said[0], /AI |INVENTED|RISKY|critical/, "nothing an AI wrote crosses, not even its count");
  assert.deepEqual(tagsOf("1051"), ["clinical-safety", "arch:review", "arch:in-review"], "the stage moves on; the team's tag stays theirs");
  await sweep({ force: true });
  assert.equal(history("1051").length, 1, "said once");
  // the tag left on is not a new ask
  await retag("1051", ["clinical-safety", "arch:review", "arch:in-review"]);
  assert.equal(requests("1051").length, 1); assert.equal((await row("1051")).review_requested, false);
});

test("taking the tag off withdraws an ask nobody has answered; putting it back asks again", async () => {
  await retag("1070", ["decommission", "arch:review"]);
  assert.equal((await row("1070")).lifecycle_stage, "review_requested");
  await retag("1070", ["decommission"]);
  const w = await row("1070");
  assert.equal(w.review_requested, false); assert.equal(w.lifecycle_stage, "needs_decision");
  assert.equal(audits("request:withdrawn"), 1); assert.ok(requests("1070")[0].withdrawn_at);
  await sweep({ force: true });
  assert.equal(history("1070").length, 0, "nothing was ever said about it"); assert.ok(!tagsOf("1070").includes("arch:review-requested"));
  await retag("1070", ["decommission", "arch:review"]);
  assert.equal(requests("1070").length, 2); assert.equal((await row("1070")).review_requested, true);
  await retag("1070", ["decommission"]);
});

test("a change whose review is in flight is not asked about; one a board has already spoken on can be asked about again", async () => {
  // 1077 is in review: asking now is answered by that review, there and then
  await retag("1077", ["third-party", "data", "arch:review"]);
  const during = requests("1077");
  assert.equal(during.length, 1); assert.equal(during[0].answered_review_id, item("1077").review_id);
  assert.equal((await row("1077")).review_requested, false, "nothing for an author to pick up");
  await sweep({ force: true });
  assert.match(history("1077")[history("1077").length - 1], /the review asked for on this item is open as REV-0007/, "the team is told which review it is");
  // and when the board then decides, no second look is owed for an ask that was already answered
  db.prepare("UPDATE reviews SET stage='approved', decided_at=? WHERE id=?").run(nowIso(), item("1077").review_id);
  reconcileRequests("test");
  assert.equal(requests("1077").length, 1); assert.equal((await row("1077")).review_requested, false);
  // 1042 was approved with conditions: the team wants another look
  await retag("1042", ["architecture-needed", "data", "arch:review"]);
  const w = await row("1042");
  assert.equal(w.review_requested, true); assert.notEqual(w.lifecycle_stage, "review_requested", "the board's outcome still stands as the stage");
  const mine = (await call("GET", "/me/work", "s.patel")).body.requested.find((x: any) => x.work_item.external_id === "1042");
  assert.equal(mine.again_after, "REV-0006");
  // the same review still covering it does not answer the ask; a new one does
  reconcileRequests("test");
  assert.equal((await row("1042")).review_requested, true);
  const rev = await openReview("1042");
  assert.equal((await row("1042")).review_requested, false); assert.equal(requests("1042")[0].answered_review_id, rev.id);
});

test("an ask answered by a review that is then withdrawn stands again, and the next review answers it in its own right", async () => {
  await retag("1101", ["arch:review"]);
  db.prepare("UPDATE work_items SET application_id=(SELECT application_id FROM work_items WHERE external_id='1051') WHERE external_id='1101'").run(); // a design review needs an application
  assert.equal((await row("1101")).review_requested, true);
  const first = await openReview("1101");
  await sweep({ force: true });
  const told = history("1101").length;
  assert.equal(told, 1); assert.equal((await row("1101")).review_requested, false);
  // the author withdraws it; the tag is still on the story
  const gone = await call("POST", `/reviews/${first.id}/decide`, "s.patel", { outcome: "withdrawn", rationale: "Opened too early." });
  assert.equal(gone.status, 200, JSON.stringify(gone.body));
  await tick();
  const again = await row("1101");
  assert.equal(again.review_requested, true, "the ask was not met after all"); assert.equal(again.lifecycle_stage, "review_requested");
  assert.ok((await call("GET", "/me/work", "s.patel")).body.requested.some((x: any) => x.work_item.external_id === "1101"));
  assert.equal(requests("1101").length, 2);
  await sweep({ force: true });
  assert.equal(history("1101").length, told, "reopening an ask is not a comment");
  const second = await openReview("1101");
  await sweep({ force: true });
  assert.equal(history("1101").length, told + 1); assert.match(history("1101")[told], new RegExp(`is open as ${second.code}`));
  await sweep({ force: true });
  assert.equal(history("1101").length, told + 1);
});

test("a tag put on through the service hook is heard at once, on any type of work item", async () => {
  const before = audits("request:seen");
  const hook = await call("POST", "/hooks/ado", "", { eventType: "workitem.created", resource: { id: 1202, rev: 1, fields: { "System.Title": "Bug: attachments time out", "System.WorkItemType": "Bug", "System.State": "New", "System.Tags": "arch:review", "System.AreaPath": "Clinical-Platform\\Integration" } } });
  // the hook route needs its secret; the handler itself is what is under test here
  if (hook.status !== 200) { handleAdoHook({ eventType: "workitem.created", resource: { id: 1202, rev: 1, fields: { "System.Title": "Bug: attachments time out", "System.WorkItemType": "Bug", "System.State": "New", "System.Tags": "arch:review", "System.AreaPath": "Clinical-Platform\\Integration" } } }); await tick(); }
  assert.equal(audits("request:seen"), before + 1);
  assert.equal((await row("1202")).review_requested, true);
});

test("turned off, asks are no longer shown or listened for; what was said stays", async () => {
  await retag("1070", ["decommission", "arch:review"]); // an ask nobody has answered
  assert.equal((await row("1070")).lifecycle_stage, "review_requested");
  await sweep({ force: true });
  assert.ok(tagsOf("1070").includes("arch:review-requested"));
  assert.equal((await admin({ request: false })).status, 200);
  assert.equal((await row("1070")).review_requested, false); assert.notEqual((await row("1070")).lifecycle_stage, "review_requested");
  assert.equal((await call("GET", "/me/work", "s.patel")).body.requested.length, 0);
  await sweep({ force: true });
  assert.ok(!tagsOf("1070").includes("arch:review-requested"), "the stage tag follows the stage");
  assert.ok(tagsOf("1070").includes("arch:review"), "the team's own tag is still theirs");
  assert.equal(history("1051").length, 1, "the answer already given is history");
  await admin({ request: true });
  assert.equal((await row("1070")).review_requested, true, "still asked for when it is listened for again");
  await admin({ enabled: false });
});
