import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The work queue (GET /me/work) by role on the seeded demo — a decision maker is asked for positions, the chair to
// declare and resolve, an author to resubmit and to look at changed backlog items, nobody else for anything —
// plus the overview pipeline it feeds, the decisions list/detail with the review in flight (and the 409 that keeps
// acceptance inside the review), the audit rows resolved to codes (sign-ins read back as `sign_in`), and the
// pre-review findings joined to the areas they belong to.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "archigov-work-"));
delete process.env.AUTH_MODE;
const { db, migrate, audit } = await import("../src/db.js");
await migrate();
const { seedDemo } = await import("../src/seed.js");
seedDemo("test");
const { seedBoards } = await import("../src/boards/seed.js");
seedBoards("test");
const { areaOfCategory } = await import("../src/boards/areas.js");
const { Hono } = await import("hono");
const { ZodError } = await import("zod");
const { api } = await import("../src/routes.js");
const app = new Hono();
app.route("/", api);
app.onError((err, c) => err instanceof ZodError ? c.json({ error: "invalid_request", issues: err.issues }, 400) : c.json({ error: err.message }, (err as any).status >= 400 && (err as any).status < 600 ? (err as any).status : 500));
const call = async (method: string, p: string, user: string, body?: any) => { const r = await app.request(p, { method, headers: { "x-user": user, "content-type": "application/json" }, body: body !== undefined ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
const get = (p: string, user = "a.uditor") => call("GET", p, user);
const post = (p: string, user: string, body: any = {}) => call("POST", p, user, body);
const put = (p: string, user: string, body: any) => call("PUT", p, user, body);
const work = async (user: string) => { const r = await get("/me/work", user); assert.equal(r.status, 200, `${user}: ${JSON.stringify(r.body)}`); return r.body; };
const LISTS = ["positions", "declare", "resolve", "sessions", "conditions", "circulations", "resubmit", "changed", "no_decision"];
const ctx: Record<string, any> = {};
const apps = new Map((db.prepare("SELECT id, name FROM elements WHERE type='application'").all() as any[]).map((a) => [a.name, a.id]));
const design = (title: string, appName: string, md = "## Design\n\nx\n\n## Data\n\nPatient identifiers.\n\n## Security\n\nPrivate endpoints only.") => ({ type: "design", title, application_id: apps.get(appName), risk_tier: "medium", summary: "s", design_md: md });
const submit = async (title: string, areas: string[], user = "t.nguyen", appName = "Intranet", extra: any = {}) => { const r = await post("/reviews", user, { ...design(title, appName), ...extra }); assert.equal(r.status, 200, JSON.stringify(r.body)); const p = await put(`/reviews/${r.body.id}/areas`, user, { areas }); assert.equal(p.status, 200, JSON.stringify(p.body)); return r.body; };
const countsAddUp = (w: any) => { assert.equal(w.counts.total, LISTS.reduce((n, k) => n + w[k].length, 0), JSON.stringify(w.counts)); for (const k of LISTS) assert.equal(w.counts[k], w[k].length, k); };

test("nobody without a governance identity has work: platform admin, auditor, service account, and an unknown x-user", async () => {
  for (const u of ["ops.admin", "a.uditor", "svc.ado", "nobody.yet"]) {
    const w = await work(u);
    assert.deepEqual(w.user, { id: u, name: w.user.name }); assert.equal(w.counts.total, 0, `${u}: ${JSON.stringify(w.counts)}`);
    for (const k of LISTS) assert.deepEqual(w[k], [], `${u}.${k}`);
    countsAddUp(w);
  }
  const ov = await get("/overview", "ops.admin"); assert.equal(ov.body.me.awaiting, 0);
});

test("a decision maker is asked for positions on the areas she owns; a planned sitting she sits on is listed; her conditions come overdue first", async () => {
  const w = await work("m.hughes");
  // REV-0007 (in_review, data + infrastructure): data is hers, infrastructure is p.osei's
  const r7 = w.positions.find((x: any) => x.review.code === "REV-0007"); assert.ok(r7, JSON.stringify(w.positions.map((x: any) => x.review.code)));
  assert.deepEqual(r7.areas, ["data"]); assert.equal(r7.review.board.code, "DA"); assert.equal(r7.review.type, "design"); assert.equal(r7.review.stage, "in_review"); assert.equal(r7.review.deferred_count, 0);
  assert.equal(r7.session?.code, "SES-0001", "listed on the seeded planned sitting"); assert.equal(r7.session.status, "planned"); assert.ok(r7.session.scheduled_at);
  assert.ok(w.positions.every((x: any) => x.review.board.code === "DA" || x.areas.length === 0), "count-mode items (the PCB policy review) carry no areas");
  assert.ok(w.positions.some((x: any) => x.review.board.code === "PCB" && x.areas.length === 0), "the PCB policy review needs her yes (count mode)");
  assert.equal(w.declare.length, 0, "a decision maker declares nothing"); assert.equal(w.resolve.length, 0);
  const s1 = w.sessions.find((s: any) => s.code === "SES-0001"); assert.ok(s1, JSON.stringify(w.sessions));
  assert.equal(s1.my_role, "decision_maker"); assert.equal(s1.my_attendance, null, "nothing recorded yet"); assert.equal(s1.board.code, "DA"); assert.equal(s1.status, "planned"); assert.ok(s1.items >= 1); assert.equal(s1.consent_count, 0);
  // the seeded conditions on REV-0006 are hers: the overdue one first
  assert.equal(w.conditions.length, 2); assert.equal(w.conditions[0].status, "overdue"); assert.equal(w.conditions[1].status, "open"); assert.equal(w.conditions[0].review.code, "REV-0006"); assert.ok(w.conditions[0].text && w.conditions[0].due_at); assert.equal(w.conditions[0].area, null);
  // epic 1042 changed after REV-0006 — which she submitted — was approved
  assert.deepEqual(w.changed.map((x: any) => [x.work_item.external_id, x.review.code]), [["1042", "REV-0006"]]); assert.equal(w.changed[0].work_item.type, "Epic"); assert.ok(w.changed[0].work_item.title);
  assert.deepEqual(w.no_decision, [], "only authors are prompted about undecided epics");
  assert.deepEqual(w.resubmit, []); assert.deepEqual(w.circulations, []);
  countsAddUp(w);
  assert.equal((await get("/overview", "m.hughes")).body.me.awaiting, w.counts.total);
  // p.osei is awaited on infrastructure for the same review and owns no condition
  const po = await work("p.osei"); assert.deepEqual(po.positions.find((x: any) => x.review.code === "REV-0007").areas, ["infrastructure"]); assert.deepEqual(po.conditions, []); assert.deepEqual(po.changed, []);
});

test("the chair declares what is ready and resolves conditionals; the author never acts on their own item", async () => {
  const ready = await submit("Work: ready item (data)", ["data"]); ctx.ready = ready.id;
  const cond = await submit("Work: conditional item (security)", ["security"]); ctx.cond = cond.id;
  const mixed = await submit("Work: half done (data + cost)", ["data", "cost"]); ctx.mixed = mixed.id;
  let w = await work("j.duduka");
  assert.ok(!w.declare.some((x: any) => [ready.id, cond.id, mixed.id].includes(x.review.id)), "nothing to declare before the positions are in");
  assert.deepEqual(w.positions.filter((x: any) => x.review.board.code === "DA"), [], "the chair has no vote in areas mode");
  assert.ok(w.positions.some((x: any) => x.review.board.code === "PCB"), "…but counts at the PCB");
  let r = await post(`/reviews/${ready.id}/positions`, "m.hughes", { area: "data", position: "yes" }); assert.equal(r.status, 200);
  r = await post(`/reviews/${cond.id}/positions`, "m.hughes", { area: "security", position: "conditional", text: "Needs a key-management decision." }); assert.equal(r.status, 200); ctx.pos = r.body.positions[0].id;
  r = await post(`/reviews/${mixed.id}/positions`, "m.hughes", { area: "data", position: "yes" }); assert.equal(r.status, 200);
  w = await work("j.duduka");
  const d = w.declare.find((x: any) => x.review.id === ready.id); assert.ok(d, JSON.stringify(w.declare.map((x: any) => x.review.code)));
  assert.equal(d.ready, true); assert.deepEqual(d.outstanding, []); assert.equal(d.session, null); assert.equal(d.review.board.code, "DA");
  assert.ok(!w.declare.some((x: any) => x.review.id === mixed.id), "cost is still missing: not ready, not on an open sitting");
  assert.ok(!w.declare.some((x: any) => x.review.id === cond.id), "an open conditional is not ready");
  const rs = w.resolve.find((x: any) => x.review.id === cond.id); assert.ok(rs, JSON.stringify(w.resolve));
  assert.equal(rs.area, "security"); assert.equal(rs.label, "Security"); assert.equal(rs.by, "m.hughes"); assert.equal(rs.by_name, "Mia Hughes"); assert.equal(rs.on_behalf_of, null); assert.equal(rs.text, "Needs a key-management decision."); assert.equal(rs.position_id, ctx.pos);
  countsAddUp(w);
  // m.hughes is done with these three; the rest of her queue is untouched
  const mh = await work("m.hughes"); assert.ok(!mh.positions.some((x: any) => [ready.id, cond.id, mixed.id].includes(x.review.id)));
  assert.deepEqual((await work("p.osei")).positions.find((x: any) => x.review.id === mixed.id)?.areas, ["cost"]);
  // the author of these items sees none of them as work for the board
  const tn = await work("t.nguyen"); for (const k of ["positions", "declare", "resolve"]) assert.ok(!tn[k].some((x: any) => [ready.id, cond.id, mixed.id].includes(x.review.id)), k);
  // the reviewer seat (s.patel) is advisory: nothing to record, nothing to declare
  const sp = await work("s.patel"); assert.deepEqual(sp.positions.filter((x: any) => x.review.board.code === "DA"), []); assert.deepEqual(sp.declare, []); assert.deepEqual(sp.resolve, []);
});

test("an open sitting puts every listed item on the chair's declare list; the secretary sees the sitting, not the items", async () => {
  let r = await post("/boards/DA/sessions", "a.okafor", { scheduled_at: "2026-11-10T10:00:00Z", title: "Work queue sitting" }); assert.equal(r.status, 200); ctx.ses = r.body.id; ctx.sesCode = r.body.code;
  r = await put(`/sessions/${ctx.ses}/agenda`, "a.okafor", { items: [{ review_id: ctx.mixed, position: 1 }, { review_id: ctx.cond, position: 2 }] }); assert.equal(r.status, 200);
  let w = await work("j.duduka");
  assert.ok(!w.declare.some((x: any) => x.review.id === ctx.mixed), "planned, not open: not yet");
  const sec = await work("a.okafor"); assert.ok(sec.sessions.some((s: any) => s.id === ctx.ses && s.my_role === "secretary" && s.items === 2)); assert.deepEqual(sec.declare, []); assert.deepEqual(sec.positions, []);
  r = await post(`/sessions/${ctx.ses}/open`, "j.duduka"); assert.equal(r.status, 200);
  w = await work("j.duduka");
  const m = w.declare.find((x: any) => x.review.id === ctx.mixed); assert.ok(m, JSON.stringify(w.declare.map((x: any) => x.review.code)));
  assert.equal(m.ready, false); assert.deepEqual(m.outstanding, ["Cost"]); assert.equal(m.session.id, ctx.ses); assert.equal(m.session.status, "open");
  assert.ok(w.declare.some((x: any) => x.review.id === ctx.cond && x.ready === false), "the conditional item is on the open agenda too");
  assert.equal(w.resolve.find((x: any) => x.review.id === ctx.cond).session.code, ctx.sesCode);
  const s = w.sessions.find((x: any) => x.id === ctx.ses); assert.equal(s.status, "open"); assert.equal(s.my_role, "chair"); assert.equal(s.my_attendance, "present", "the opener is present");
  assert.equal(w.sessions[0].id, ctx.ses, "the open sitting leads");
  // the planned SES-0001 stays behind the open one for m.hughes too; p.osei's position on cost is still asked for, now with the sitting
  const po = await work("p.osei"); assert.equal(po.positions.find((x: any) => x.review.id === ctx.mixed).session.id, ctx.ses);
  // chair declares the mixed item approved subject to circulation: p.osei is away (no record = absent)
  r = await post(`/sessions/${ctx.ses}/items/${ctx.mixed}/call`, "j.duduka"); assert.equal(r.status, 200);
  r = await post(`/sessions/${ctx.ses}/items/${ctx.mixed}/declare`, "j.duduka", { outcome: "approved_subject_to_circulation", circulation_due: "2020-01-01", rationale: "Cost by circulation." }); assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await post(`/sessions/${ctx.ses}/items/${ctx.cond}/defer`, "j.duduka", { reason: "Awaiting the decision." }); assert.equal(r.status, 200);
  r = await post(`/sessions/${ctx.ses}/close`, "j.duduka", {}); assert.equal(r.status, 200);
  // circulation: the absent owner sees it (mine), the chair sees it (not mine), overdue because the due date passed
  const poc = (await work("p.osei")).circulations.find((x: any) => x.review.id === ctx.mixed); assert.ok(poc); assert.equal(poc.mine, true); assert.equal(poc.overdue, true); assert.deepEqual(poc.missing, ["Cost"]); assert.equal(poc.circulation_due, "2020-01-01");
  assert.deepEqual((await work("p.osei")).positions.find((x: any) => x.review.id === ctx.mixed).areas, ["cost"], "and the position is still asked for");
  const chc = (await work("j.duduka")).circulations.find((x: any) => x.review.id === ctx.mixed); assert.ok(chc); assert.equal(chc.mine, false);
  assert.ok(!(await work("m.hughes")).circulations.some((x: any) => x.review.id === ctx.mixed), "data is recorded: nothing for her");
  // the deferred conditional is still the chair's to resolve, now with no sitting
  const rs = (await work("j.duduka")).resolve.find((x: any) => x.review.id === ctx.cond); assert.ok(rs); assert.equal(rs.session, null); assert.equal(rs.review.deferred_count, 1);
});

test("an author is asked to resubmit what was sent back and to look at backlog items that changed after approval; undecided epics are the author's prompt", async () => {
  const epic = db.prepare("SELECT id, external_id FROM work_items WHERE type='Epic' AND decision_id IS NULL AND review_id IS NULL AND state<>'Closed' ORDER BY external_id LIMIT 1").get() as any; assert.ok(epic);
  const before = await work("t.nguyen");
  assert.ok(before.no_decision.some((x: any) => x.work_item.id === epic.id), JSON.stringify(before.no_decision)); assert.equal(before.no_decision.length, (await get("/overview", "t.nguyen")).body.pipeline.epics_without_decision);
  assert.ok(before.no_decision.every((x: any) => x.work_item.type === "Epic" && "application_name" in x.work_item && "application_id" in x.work_item));
  // a design linked to the epic: the epic leaves the undecided list; a later material change puts it on the author's changed list
  const linked = await submit("Work: design for the epic", ["data"], "t.nguyen", "Intranet", { work_item_id: epic.id });
  let w = await work("t.nguyen"); assert.ok(!w.no_decision.some((x: any) => x.work_item.id === epic.id)); assert.deepEqual(w.changed, []);
  let r = await post(`/work-items/${epic.id}/simulate-change`, "ops.admin", { description: "Scope changed after the design was submitted." }); assert.equal(r.status, 200); assert.equal(r.body.material_change, true);
  w = await work("t.nguyen"); assert.deepEqual(w.changed.map((x: any) => [x.work_item.external_id, x.review.id]), [[epic.external_id, linked.id]]);
  assert.ok(!(await work("s.patel")).changed.some((x: any) => x.review.id === linked.id), "another author's item");
  // sent back by a position (areas mode) and by a reviewer's objection: both are resubmit work, naming who and why
  const back = await submit("Work: sent back", ["security"]);
  r = await post(`/reviews/${back.id}/positions`, "m.hughes", { area: "security", position: "no", text: "No threat model." }); assert.equal(r.status, 200); assert.equal(r.body.stage, "changes_requested");
  w = await work("t.nguyen");
  const rb = w.resubmit.find((x: any) => x.review.id === back.id); assert.ok(rb, JSON.stringify(w.resubmit)); assert.equal(rb.requested_by, "m.hughes"); assert.equal(rb.requested_by_name, "Mia Hughes"); assert.equal(rb.text, "No threat model."); assert.ok(rb.requested_at); assert.equal(rb.review.stage, "changes_requested");
  assert.ok(!(await work("m.hughes")).positions.some((x: any) => x.review.id === back.id), "a sent-back item waits on its author, not the board");
  r = await post(`/reviews/${back.id}/resubmit`, "t.nguyen", { note: "Threat model attached." }); assert.equal(r.status, 200);
  w = await work("t.nguyen"); assert.ok(!w.resubmit.some((x: any) => x.review.id === back.id));
  const adv = await submit("Work: reviewer objection", ["cost"]);
  r = await post(`/reviews/${adv.id}/positions`, "s.patel", { position: "no", text: "Unclear scope." }); assert.equal(r.status, 200);
  const ra = (await work("t.nguyen")).resubmit.find((x: any) => x.review.id === adv.id); assert.ok(ra); assert.equal(ra.requested_by, "s.patel"); assert.equal(ra.text, "Unclear scope.");
  countsAddUp(await work("t.nguyen"));
});

test("overview: the pipeline and what is waiting on the caller; every existing field stays", async () => {
  const ov = (await get("/overview", "j.duduka")).body;
  for (const k of ["trend", "evidence_by_source", "decisions_by_status", "reviews_by_stage", "tenant", "counts", "first_run", "bySeverity", "byApp", "reviews", "verification", "lastRun", "lastSync", "collect_interval_minutes", "llm"]) assert.ok(k in ov, k);
  const p = ov.pipeline;
  assert.deepEqual(p.by_stage, Object.fromEntries(ov.reviews_by_stage.map((r: any) => [r.stage, r.n])));
  const inFlight = ["submitted", "pre_review", "in_review", "changes_requested", "approved_pending_dependencies", "approved_subject_to_circulation"].reduce((n, s) => n + (p.by_stage[s] || 0), 0);
  assert.equal(p.in_flight, inFlight); assert.ok(p.in_flight > 0);
  assert.deepEqual(p.by_board.map((b: any) => b.code), ["DA", "PCB"]); assert.equal(p.by_board.reduce((n: number, b: any) => n + b.in_flight, 0), p.in_flight);
  const da = p.by_board[0]; assert.equal(da.next_session.code, "SES-0001", "the closed sitting is not next"); assert.equal(da.next_session.status, "planned"); assert.ok(da.next_session.scheduled_at); assert.equal(p.by_board[1].next_session, null);
  assert.equal(p.next_session.code, "SES-0001"); assert.deepEqual(p.next_session.board, { id: da.id, code: "DA", name: da.name });
  assert.equal(p.open_conditions, 2); assert.equal(p.overdue_conditions, 1); assert.equal(p.circulations, 1); assert.equal(p.circulations_overdue, 1);
  assert.equal(p.changed_after_approval, (db.prepare("SELECT count(*) c FROM work_items WHERE material_change=1").get() as any).c); assert.equal(p.epics_without_decision, ov.counts.epics_without_decision);
  assert.equal(ov.me.awaiting, (await work("j.duduka")).counts.total); assert.ok(ov.me.awaiting > 0);
  assert.equal((await get("/overview", "a.uditor")).body.me.awaiting, 0);
});

test("decisions: the review in flight and the link counts; accepting or rejecting directly is refused while it is under review", async () => {
  let r = await post("/decisions", "t.nguyen", { title: "Work: messaging platform", topic: "integration" }); assert.equal(r.status, 200); const adr = r.body.id, code = r.body.code;
  let rows = (await get("/decisions")).body; let row = rows.find((d: any) => d.id === adr);
  assert.equal(row.review, null); assert.deepEqual(row.links, { depends_on: 0, blocks: 0 });
  r = await post("/reviews", "t.nguyen", { type: "decision", decision_id: adr, title: `Decide ${code}` }); assert.equal(r.status, 200); const rev = r.body;
  row = (await get("/decisions")).body.find((d: any) => d.id === adr);
  assert.deepEqual(row.review, { id: rev.id, code: rev.code, stage: "in_review", board: { id: rev.board.id, code: "DA", name: rev.board.name }, session: null });
  const det = (await get(`/decisions/${adr}`)).body; assert.deepEqual(det.review_in_flight, row.review); assert.deepEqual(det.links, { depends_on: 0, blocks: 0 });
  // the chair cannot short-circuit the review
  for (const status of ["accepted", "rejected"]) {
    r = await post(`/decisions/${adr}/status`, "j.duduka", { status }); assert.equal(r.status, 409, status); assert.equal(r.body.error, "under review"); assert.equal(r.body.review.code, rev.code); assert.equal(r.body.review.board.code, "DA"); assert.equal(r.body.review.stage, "in_review");
  }
  assert.equal((await get(`/decisions/${adr}`)).body.status, "proposed");
  const refused = db.prepare("SELECT action, data_json FROM audit_log WHERE entity='decisions' AND entity_id=? AND action='status:refused_under_review'").all(adr) as any[];
  assert.equal(refused.length, 2); assert.equal(JSON.parse(refused[0].data_json).review, rev.code); assert.equal(JSON.parse(refused[0].data_json).status, "accepted");
  r = await post(`/decisions/${adr}/status`, "j.duduka", { status: "superseded" }); assert.equal(r.status, 200, "other statuses stay allowed");
  r = await post(`/decisions/${adr}/status`, "j.duduka", { status: "proposed" }); assert.equal(r.status, 200);
  r = await post(`/decisions/nope/status`, "j.duduka", { status: "accepted" }); assert.equal(r.status, 404);
  // a dependency on it from another review counts as a link; when the review is declared the decision is decided and leaves the in-flight list
  const dep = await submit("Work: depends on the messaging decision", ["integration"]);
  r = await post(`/reviews/${dep.id}/dependencies`, "t.nguyen", { decision_id: adr }); assert.equal(r.status, 200);
  row = (await get("/decisions")).body.find((d: any) => d.id === adr); assert.deepEqual(row.links, { depends_on: 0, blocks: 1 });
  const dr = (await get(`/reviews/${rev.id}`)).body; for (const a of dr.progress.areas) { r = await post(`/reviews/${rev.id}/positions`, a.owners[0], { area: a.area, position: "yes" }); assert.equal(r.status, 200); }
  r = await post(`/reviews/${rev.id}/decide`, "j.duduka", { outcome: "approved" }); assert.equal(r.status, 200); assert.equal(r.body.effective, true);
  row = (await get("/decisions")).body.find((d: any) => d.id === adr); assert.equal(row.status, "accepted"); assert.equal(row.review, null);
  r = await post(`/decisions/${adr}/status`, "j.duduka", { status: "rejected" }); assert.equal(r.status, 200, "no review in flight any more: a chair may change it directly");
});

test("review detail: each area says whether it is mine and carries the pre-review findings that belong to it; the pre-review is summarised", async () => {
  // Referral API has rule findings in the demo (public storage, missing decisions…); the rules pre-review cites their standards
  const r = await post("/reviews", "t.nguyen", design("Work: findings per area", "Referral API", "## Design\n\nx\n\n## Data\n\nReferral attachments.\n\n## Security\n\nPrivate endpoints.")); assert.equal(r.status, 200);
  const body = (await get(`/reviews/${r.body.id}`, "m.hughes")).body;
  assert.ok(body.pre_review, "summarised"); assert.ok(["approve", "approve_with_conditions", "request_changes", "reject"].includes(body.pre_review.recommendation)); assert.equal(body.pre_review.checks_failed, 0, "a design pre-review has no checks"); assert.ok(body.pre_review.at);
  const pre = [...body.events].reverse().find((e: any) => e.kind === "pre_review"); assert.equal(body.pre_review.findings, pre.data.findings.length); assert.ok(body.pre_review.findings > 0, "the demo estate yields findings");
  const stdCat = new Map((db.prepare("SELECT code, category FROM standards").all() as any[]).map((s) => [s.code, s.category]));
  let joined = 0;
  for (const a of body.progress.areas) {
    assert.equal(typeof a.mine, "boolean"); assert.equal(a.findings_count, a.findings.length);
    for (const f of a.findings) { joined++; assert.equal(areaOfCategory(stdCat.get(f.code)), a.area, `${f.code} (${stdCat.get(f.code)}) sits under ${a.area}`); assert.ok(f.severity && f.title && f.label && f.kind, JSON.stringify(f)); }
    // every finding of the pre-review citing a standard whose category maps to this area is listed once
    const expected = new Set(pre.data.findings.filter((f: any) => f.citations.some((c: any) => c.kind === "standard" && areaOfCategory(stdCat.get(c.ref)) === a.area)).map((f: any) => f.title));
    assert.deepEqual(new Set(a.findings.map((f: any) => f.title)), expected, a.area);
  }
  assert.ok(joined > 0, `some finding joined an area: ${JSON.stringify(body.progress.areas.map((a: any) => [a.area, a.findings_count]))}`);
  assert.equal(body.progress.areas.find((a: any) => a.area === "data").mine, true, "m.hughes owns data"); assert.equal(body.progress.areas.find((a: any) => a.area === "infrastructure")?.mine ?? false, false);
  const asChair = (await get(`/reviews/${r.body.id}`, "j.duduka")).body; assert.ok(asChair.progress.areas.every((a: any) => a.mine === false), "the chair has no vote");
  const asAuthor = (await get(`/reviews/${r.body.id}`, "t.nguyen")).body; assert.ok(asAuthor.progress.areas.every((a: any) => a.mine === false));
  const pcb = (db.prepare("SELECT id FROM reviews WHERE type='policy' ORDER BY created_at LIMIT 1").get() as any); const pb = (await get(`/reviews/${pcb.id}`, "r.khan")).body;
  assert.equal(pb.pre_review.findings, 0); assert.equal(typeof pb.pre_review.checks_failed, "number"); assert.deepEqual(pb.progress.areas, [], "count mode: no areas");
  // the list keeps the lean progress shape
  const listed = (await get("/reviews", "m.hughes")).body.find((x: any) => x.id === r.body.id); assert.ok(listed.progress.areas.length > 0); assert.ok(!("mine" in listed.progress.areas[0]));
});

test("audit rows resolve to the code and label of what they are about; sign-ins are read back under `sign_in`, legacy rows included", async () => {
  let r = await post("/auth/local", "x", { user: "work.signin", name: "Work Sign-in", user_type: "author" }); assert.equal(r.status, 200);
  audit("legacy.user", "sign_in", "session", null, { mode: "local", legacy: true }); // what auth.ts wrote before this round
  audit("legacy.user", "sign_out", "session", null, { mode: "local", legacy: true });
  const all = (await get("/audit?limit=1000", "a.uditor")).body;
  const fresh = all.rows.find((x: any) => x.actor === "work.signin" && x.action === "sign_in"); assert.ok(fresh); assert.equal(fresh.entity, "sign_in"); assert.equal(fresh.item_code, null);
  assert.equal((db.prepare("SELECT entity FROM audit_log WHERE actor='work.signin' AND action='sign_in'").get() as any).entity, "sign_in", "written as sign_in");
  const legacy = all.rows.filter((x: any) => x.actor === "legacy.user"); assert.equal(legacy.length, 2); assert.ok(legacy.every((x: any) => x.entity === "sign_in"), "read back as sign_in");
  assert.equal((db.prepare("SELECT entity FROM audit_log WHERE actor='legacy.user' AND action='sign_in'").get() as any).entity, "session", "the chained row is never rewritten");
  assert.ok(all.facets.entities.includes("sign_in")); assert.ok(!all.facets.entities.includes("session"), JSON.stringify(all.facets.entities)); assert.ok(all.facets.entities.includes("sessions"), "board sittings keep their entity");
  const byEntity = (await get("/audit?entity=sign_in", "a.uditor")).body.rows; assert.ok(byEntity.length >= 3 && byEntity.every((x: any) => x.entity === "sign_in"), "the filter finds both spellings");
  assert.equal((await get("/audit/verify")).body.ok, true);
  // codes and labels
  const rev = (db.prepare("SELECT id, code, title FROM reviews WHERE code='REV-0007'").get() as any);
  const comment = await post(`/reviews/${rev.id}/comment`, "j.duduka", { body: "For the audit test." }); assert.equal(comment.status, 200);
  const rr = (await get(`/audit?entity=reviews&entity_id=${rev.id}`, "a.uditor")).body.rows; assert.ok(rr.length); assert.ok(rr.every((x: any) => x.item_code === "REV-0007" && x.item_label === rev.title), JSON.stringify(rr[0]));
  const pre = all.rows.find((x: any) => x.entity === "review" && x.action === "pre_review"); assert.ok(pre, "pre-reviews audit under the singular entity"); assert.match(pre.item_code, /^REV-\d{4}$/);
  const dec = all.rows.find((x: any) => x.entity === "decisions" && x.item_code); assert.match(dec.item_code, /^ADR-\d{4}$/); assert.ok(dec.item_label);
  const ses = all.rows.find((x: any) => x.entity === "sessions" && x.action === "session:open"); assert.equal(ses.item_code, ctx.sesCode); assert.equal(ses.item_label, "Work queue sitting");
  const wi = all.rows.find((x: any) => x.entity === "work_items"); assert.match(wi.item_code, /^Epic \d+$/); assert.ok(wi.item_label);
  const usr = all.rows.find((x: any) => x.entity === "user" && x.entity_id); if (usr) { assert.equal(usr.item_code, null); assert.ok(usr.item_label); }
  const run = all.rows.find((x: any) => x.entity === "run" && x.entity_id); if (run) assert.ok(run.item_code && run.item_label);
  assert.ok(all.rows.filter((x: any) => x.entity === "tenant").every((x: any) => x.item_code === null && x.item_label === null), "unknown entities resolve to nothing");
});

test("GET /sessions: board and status filters, my_role, counts, forthcoming first then closed newest first", async () => {
  const chair = (await get("/sessions", "j.duduka")).body;
  assert.ok(chair.length >= 2); assert.ok(chair.every((s: any) => s.board?.code && typeof s.items === "number" && typeof s.declared === "number" && typeof s.deferred === "number" && typeof s.consent_count === "number"));
  assert.ok(chair.every((s: any) => s.my_role === "chair")); assert.ok((await get("/sessions", "a.uditor")).body.every((s: any) => s.my_role === null)); assert.ok((await get("/sessions", "m.hughes")).body.every((s: any) => s.my_role === "decision_maker"));
  const rank = (s: any) => (s.status === "open" ? 0 : s.status === "planned" ? 1 : 2);
  for (let i = 1; i < chair.length; i++) assert.ok(rank(chair[i - 1]) <= rank(chair[i]), "forthcoming before closed");
  const closed = chair.filter((s: any) => s.status === "closed"); for (let i = 1; i < closed.length; i++) assert.ok(closed[i - 1].scheduled_at >= closed[i].scheduled_at, "closed: newest first");
  const planned = (await get("/sessions?status=planned,open")).body; assert.ok(planned.length >= 1 && planned.every((s: any) => s.status === "planned" || s.status === "open"));
  for (let i = 1; i < planned.length; i++) assert.ok(planned[i - 1].scheduled_at <= planned[i].scheduled_at, "forthcoming: soonest first");
  assert.deepEqual((await get("/sessions?status=closed")).body.map((s: any) => s.code), [ctx.sesCode]);
  assert.equal((await get("/sessions?board=PCB")).body.length, 0); assert.equal((await get("/sessions?board=da")).body.length, chair.length);
  const daId = (db.prepare("SELECT id FROM boards WHERE code='DA'").get() as any).id; assert.equal((await get(`/sessions?board=${daId}&status=closed`)).body.length, 1);
  const closedRow = (await get("/sessions?status=closed")).body[0]; assert.equal(closedRow.declared, 1); assert.equal(closedRow.deferred, 1);
});
