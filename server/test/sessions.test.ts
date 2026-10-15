import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

// Board sessions through the HTTP API on the seeded demo: the planned sitting, attendance and one-hop delegations
// (and what a delegation refuses), positions per area recorded by owners and delegates, a conditional resolved into
// a dependent decision, outcomes held until the decision is decided (and returned when it is rejected), approval
// subject to circulation, the consent agenda, auto-deferral on close, hashed derived minutes, frozen positions,
// and the platform admin kept out of all of it.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "archigov-sessions-"));
delete process.env.AUTH_MODE;
const { db, migrate, canonical } = await import("../src/db.js");
await migrate();
const { seedDemo } = await import("../src/seed.js");
seedDemo("test");
const { seedBoards } = await import("../src/boards/seed.js");
const seeded = seedBoards("test");
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
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const ctx: Record<string, any> = {};
const apps = new Map((db.prepare("SELECT id, name FROM elements WHERE type='application'").all() as any[]).map((a) => [a.name, a.id]));
const design = (title: string, appName: string, md = "## Design\n\nx\n\n## Data\n\nPatient identifiers.\n\n## Security\n\nPrivate endpoints only.") => ({ type: "design", title, application_id: apps.get(appName), risk_tier: "medium", summary: "s", design_md: md });
/** Record `position` on every missing area of a review from one of its owners (the way a sitting would). */
async function fillPositions(rid: string, position = "yes", text: string | null = null) {
  const { body } = await get(`/reviews/${rid}`);
  for (const a of body.progress.areas) if (a.state === "missing") { const r = await post(`/reviews/${rid}/positions`, a.owners[0], { area: a.area, position, text }); assert.equal(r.status, 200, `${a.owners[0]} on ${a.area}: ${JSON.stringify(r.body)}`); }
  return (await get(`/reviews/${rid}`)).body;
}
const audits = (entityId: string) => (db.prepare("SELECT actor, action, data_json FROM audit_log WHERE entity_id=? ORDER BY rowid").all(entityId) as any[]).map((a) => ({ actor: a.actor, action: a.action, data: JSON.parse(a.data_json) }));

test("seed: SES-0001 is planned with the open DA reviews; seeded reviews carry derived areas; the platform admin only reads", async () => {
  assert.equal(seeded.session, "SES-0001"); assert.ok((seeded.reviews_areas_derived as number) >= 4);
  let r = await get("/boards/DA/sessions"); assert.equal(r.status, 200); assert.equal(r.body.length, 1); assert.equal(r.body[0].code, "SES-0001"); assert.equal(r.body[0].status, "planned"); assert.ok(r.body[0].items >= 1);
  r = await get("/sessions/SES-0001", "ops.admin"); assert.equal(r.status, 200, "the platform admin reads");
  assert.equal(r.body.title, "Design Authority — fortnightly"); assert.ok(r.body.scheduled_at.endsWith("T10:00:00.000Z")); assert.equal(r.body.created_by, "a.okafor");
  assert.ok(Object.values(r.body.can).every((v) => v === false), `…and can do nothing: ${JSON.stringify(r.body.can)}`);
  assert.ok(r.body.items.every((i: any) => i.review.stage !== "approved" && i.review.areas.length > 0 && ["awaiting_positions", "open", "blocked", "ready"].includes(i.review.item_state)), JSON.stringify(r.body.items.map((i: any) => [i.review.code, i.review.item_state])));
  ctx.ses1 = r.body.id;
  for (const [p, body] of [[`/sessions/${ctx.ses1}/open`, {}], [`/sessions/${ctx.ses1}/attendance`, { status: "present" }], [`/sessions/${ctx.ses1}/delegations`, { delegate: "s.patel" }], [`/sessions/${ctx.ses1}/agenda/refresh`, {}], ["/boards/DA/sessions", { scheduled_at: "2026-11-03T10:00:00Z" }]] as const) {
    const x = await post(p, "ops.admin", body); assert.equal(x.status, 403, `${p}: ${JSON.stringify(x.body)}`); assert.equal(x.body.is_platform_admin, true);
  }
  const rev7 = (db.prepare("SELECT * FROM reviews WHERE code='REV-0007'").get() as any);
  assert.deepEqual(JSON.parse(rev7.areas_json), ["data", "infrastructure"], "REV-0007 (SMS reminders, Appointments): its Data section and the app's SQL + Web resources; no Security section, no pre-review"); assert.equal(rev7.areas_origin, "derived");
  const list = await get("/reviews?session=" + ctx.ses1); assert.ok(list.body.length >= 1 && list.body.every((x: any) => x.session?.code === "SES-0001"), "the list filters by session and carries it");
});

test("a design review: areas derived then pinned by its author; only owners record positions", async () => {
  let r = await post("/reviews", "t.nguyen", design("Sessions: appointments reminder store", "Appointments"));
  assert.equal(r.status, 200); ctx.rev = r.body.id; ctx.revCode = r.body.code;
  assert.ok(["data", "security", "infrastructure"].every((a) => r.body.areas.includes(a)), `derived ${r.body.areas}`);
  r = await get(`/reviews/${ctx.rev}`, "t.nguyen");
  assert.equal(r.body.areas.origin, "derived"); assert.deepEqual(r.body.areas.touched, r.body.areas.derived); assert.equal(r.body.areas.mode, "areas"); assert.equal(r.body.areas.board_areas.length, 8);
  assert.equal(r.body.can.edit_areas, true); assert.equal(r.body.can.record_position, false); assert.equal(r.body.session, null, "created after SES-0001 was planned: on no agenda yet");
  r = await put(`/reviews/${ctx.rev}/areas`, "t.nguyen", { areas: ["data", "security", "nonsense"] }); assert.equal(r.status, 400);
  r = await put(`/reviews/${ctx.rev}/areas`, "p.osei", { areas: ["data"] }); assert.equal(r.status, 403, "a decision maker does not edit areas");
  r = await put(`/reviews/${ctx.rev}/areas`, "t.nguyen", { areas: ["security", "data", "infrastructure"] }); assert.equal(r.status, 200); assert.deepEqual(r.body.areas, ["security", "data", "infrastructure"]); assert.equal(r.body.progress.required, 3);
  const after = await get(`/reviews/${ctx.rev}`); assert.equal(after.body.areas.origin, "human"); assert.ok(after.body.events.some((e: any) => e.kind === "areas_changed"));
  // nobody but the owners
  r = await post(`/reviews/${ctx.rev}/positions`, "j.duduka", { area: "security", position: "yes" }); assert.equal(r.status, 403); assert.match(r.body.reason, /chair has no vote/);
  r = await post(`/reviews/${ctx.rev}/positions`, "t.nguyen", { area: "security", position: "yes" }); assert.equal(r.status, 403, `the author: ${JSON.stringify(r.body)}`);
  r = await post(`/reviews/${ctx.rev}/positions`, "ops.admin", { area: "security", position: "yes" }); assert.equal(r.status, 403); assert.equal(r.body.capability, "approve_review");
  r = await post(`/reviews/${ctx.rev}/positions`, "a.uditor", { area: "security", position: "yes" }); assert.equal(r.status, 403);
  r = await post(`/reviews/${ctx.rev}/positions`, "s.patel", { area: "security", position: "yes" }); assert.equal(r.status, 403); assert.match(r.body.reason, /advisory/);
  r = await post(`/reviews/${ctx.rev}/positions`, "p.osei", { area: "security", position: "yes" }); assert.equal(r.status, 403); assert.match(r.body.reason, /do not own Security/);
  r = await post(`/reviews/${ctx.rev}/positions`, "m.hughes", { area: "security", position: "conditional" }); assert.equal(r.status, 400, "a conditional needs text");
  r = await post(`/reviews/${ctx.rev}/positions`, "m.hughes", { position: "yes" }); assert.equal(r.status, 400, "an area is required in areas mode");
  const mine = await get("/reviews?awaiting=me", "m.hughes"); assert.ok(mine.body.some((x: any) => x.id === ctx.rev)); const ch = await get("/reviews?awaiting=me", "j.duduka"); assert.ok(!ch.body.some((x: any) => x.id === ctx.rev), "the chair is not awaited before the positions are in");
});

test("session: plan, attend, delegate (and what a delegation refuses), open with quorum", async () => {
  let r = await post("/boards/DA/sessions", "m.hughes", { scheduled_at: "2026-11-03T10:00:00Z" }); assert.equal(r.status, 403, "a decision maker does not plan sessions");
  r = await post("/boards/DA/sessions", "a.okafor", { scheduled_at: "2026-11-03T10:00:00Z", title: "Sessions test sitting" }); assert.equal(r.status, 200, JSON.stringify(r.body));
  ctx.ses = r.body.id; assert.equal(r.body.code, "SES-0002"); assert.equal(r.body.status, "planned");
  assert.deepEqual(r.body.items.map((i: any) => i.review.code), [ctx.revCode], "only the review not already on SES-0001");
  assert.deepEqual(r.body.can, { manage: true, open: false, close: false, call: false, declare: false, consent: false, attend_self: true, delegate_self: false, record_attendance: true, nominate: false });
  assert.ok(r.body.attendance.every((a: any) => a.status === "absent") && r.body.attendance.some((a: any) => a.user_id === "p.osei" && a.areas.length === 4), "every member listed, absent by default");
  r = await post(`/sessions/${ctx.ses}/attendance`, "p.osei", { status: "present" }); assert.equal(r.status, 200);
  r = await post(`/sessions/${ctx.ses}/attendance`, "p.osei", { user_id: "m.hughes", status: "present" }); assert.equal(r.status, 403, "a decision maker records only their own attendance");
  r = await post(`/sessions/${ctx.ses}/attendance`, "t.nguyen", { status: "present" }); assert.equal(r.status, 403, "not a member of the DA");
  // delegations: one hop, never to an auditor, a service account, the author of an item, or a second seat's delegate
  r = await post(`/sessions/${ctx.ses}/delegations`, "m.hughes", { delegate: "a.uditor" }); assert.equal(r.status, 400); assert.match(r.body.error, /auditor/);
  r = await post(`/sessions/${ctx.ses}/delegations`, "m.hughes", { delegate: "svc.ado" }); assert.equal(r.status, 400); assert.match(r.body.error, /service/);
  r = await post(`/sessions/${ctx.ses}/delegations`, "m.hughes", { delegate: "t.nguyen" }); assert.equal(r.status, 400); assert.match(r.body.error, /author of an agenda item/);
  r = await post(`/sessions/${ctx.ses}/delegations`, "m.hughes", { delegate: "nobody.here" }); assert.equal(r.status, 404);
  r = await post(`/sessions/${ctx.ses}/delegations`, "m.hughes", { delegate: "s.patel", areas: ["cost"] }); assert.equal(r.status, 400); assert.match(r.body.error, /does not own cost/);
  r = await post(`/sessions/${ctx.ses}/delegations`, "a.okafor", { delegate: "s.patel" }); assert.equal(r.status, 400); assert.match(r.body.error, /no decision-maker seat/);
  r = await post(`/sessions/${ctx.ses}/delegations`, "a.okafor", { delegator: "m.hughes", delegate: "s.patel" }); assert.equal(r.status, 400); assert.match(r.body.error, /on_instruction/);
  r = await post(`/sessions/${ctx.ses}/delegations`, "p.osei", { delegator: "m.hughes", delegate: "s.patel", on_instruction: true }); assert.equal(r.status, 403, "only the secretary records for someone else");
  r = await post(`/sessions/${ctx.ses}/delegations`, "m.hughes", { delegate: "s.patel" }); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.delegation.areas, ["security", "data", "compliance", "ai"]); assert.equal(r.body.delegation.on_instruction, false); ctx.del = r.body.delegation.id;
  const sp = r.body.attendance.find((a: any) => a.user_id === "s.patel"); assert.equal(sp.status, "present"); assert.equal(sp.on_behalf_of, "m.hughes");
  r = await post(`/sessions/${ctx.ses}/delegations`, "p.osei", { delegate: "s.patel" }); assert.equal(r.status, 400); assert.match(r.body.error, /another seat/);
  r = await post(`/sessions/${ctx.ses}/delegations`, "a.okafor", { delegator: "p.osei", delegate: "r.khan", on_instruction: true }); assert.equal(r.status, 200, "the secretary records on instruction"); assert.equal(r.body.delegation.on_instruction, true); assert.equal(r.body.delegation.recorded_by, "a.okafor");
  r = await call("DELETE", `/sessions/${ctx.ses}/delegations/${r.body.delegation.id}`, "m.hughes"); assert.equal(r.status, 403, "only the delegator or secretary revokes");
  r = await call("DELETE", `/sessions/${ctx.ses}/delegations/${(await get(`/sessions/${ctx.ses}`)).body.delegations.find((d: any) => d.delegate === "r.khan").id}`, "p.osei"); assert.equal(r.status, 200);
  r = await post(`/sessions/${ctx.ses}/open`, "a.okafor"); assert.equal(r.status, 403, "the secretary does not open");
  r = await post(`/sessions/${ctx.ses}/open`, "j.duduka"); assert.equal(r.status, 200); assert.equal(r.body.status, "open"); assert.equal(r.body.opened_by, "j.duduka");
  const opener = r.body.attendance.find((a: any) => a.user_id === "j.duduka"); assert.equal(opener.status, "present", "the opener is in the room"); assert.equal(opener.recorded_by, "j.duduka", "…self-recorded");
  assert.ok(r.body.quorum.every((q: any) => q.covered), `quorum: ${JSON.stringify(r.body.quorum)}`);
  assert.deepEqual(r.body.quorum.find((q: any) => q.area === "security").by, ["s.patel"]); assert.deepEqual(r.body.quorum.find((q: any) => q.area === "cost").by, ["p.osei"]);
  assert.equal(r.body.items[0].consent, false, "nothing was ready at opening");
  r = await post(`/sessions/${ctx.ses}/open`, "j.duduka"); assert.equal(r.status, 409);
  const rev = await get(`/reviews/${ctx.rev}`); assert.deepEqual(rev.body.session, { id: ctx.ses, code: "SES-0002", status: "open" });
  assert.deepEqual(rev.body.progress.areas.find((a: any) => a.area === "security").owners, ["m.hughes", "s.patel"], "the delegate is an owner while the session is open");
});

test("positions by a delegate and an owner; a conditional the chair resolves into a dependent decision; approved pending it", async () => {
  let r = await post(`/reviews/${ctx.rev}/positions`, "s.patel", { area: "data", position: "yes" }); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.positions[0].on_behalf_of, "m.hughes"); assert.equal(r.body.positions[0].user_id, "s.patel"); assert.equal(r.body.positions[0].session_id, ctx.ses);
  r = await post(`/reviews/${ctx.rev}/positions`, "s.patel", { area: "security", position: "conditional", text: "needs a key-management decision" }); assert.equal(r.status, 200);
  r = await post(`/reviews/${ctx.rev}/positions`, "p.osei", { area: "infrastructure", position: "yes" }); assert.equal(r.status, 200);
  assert.equal(r.body.progress.open_conditionals, 1); assert.equal(r.body.progress.satisfied, false); assert.equal(r.body.progress.received, 2); assert.equal(r.body.stage, "in_review");
  r = await post(`/sessions/${ctx.ses}/items/${ctx.rev}/call`, "j.duduka"); assert.equal(r.status, 200);
  const s = await get(`/sessions/${ctx.ses}`, "j.duduka"); assert.equal(s.body.items[0].state, "called"); assert.equal(s.body.items[0].review.item_state, "open");
  r = await post(`/reviews/${ctx.rev}/decide`, "j.duduka", { outcome: "approved" }); assert.equal(r.status, 403); assert.match(r.body.reason, /conditional unresolved/);
  const pos = (await get(`/reviews/${ctx.rev}`)).body.positions.find((p: any) => p.position === "conditional" && !p.superseded); ctx.pos = pos.id;
  r = await post(`/positions/${pos.id}/resolve`, "s.patel", { resolution: "addressed", text: "I resolve my own condition" }); assert.equal(r.status, 403); assert.equal(r.body.capability, "decide_review");
  r = await post(`/positions/${pos.id}/resolve`, "j.duduka", { resolution: "addressed", text: "short" }); assert.equal(r.status, 400, "an explanation of at least 10 characters");
  r = await post(`/positions/${pos.id}/resolve`, "j.duduka", { resolution: "dependent_decision", text: "Key management will be decided separately." }); assert.equal(r.status, 400);
  r = await post(`/positions/${pos.id}/resolve`, "j.duduka", { resolution: "dependent_decision", text: "Key management will be decided separately.", create: { title: "Key management for appointments reminders", topic: "security" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.position.resolution, "dependent_decision"); assert.equal(r.body.position.resolved_by, "j.duduka"); assert.match(r.body.dependency.decision.code, /^ADR-\d{4}$/); assert.equal(r.body.dependency.review.board.code, "DA");
  ctx.adr = r.body.dependency.decision.id; ctx.depRev = r.body.dependency.review.id;
  assert.equal(r.body.progress.open_conditionals, 0); assert.equal(r.body.progress.satisfied, true);
  const adr = (await get(`/decisions/${ctx.adr}`)).body; assert.equal(adr.status, "proposed"); assert.equal(adr.author, "t.nguyen", "the ADR is the submitter's"); assert.equal(adr.origin, "human"); assert.equal(adr.verification, "unverified");
  assert.deepEqual(adr.dependents.map((d: any) => d.review.code), [ctx.revCode]);
  const rev = (await get(`/reviews/${ctx.rev}`, "j.duduka")).body;
  assert.equal(rev.dependencies.length, 1); assert.equal(rev.dependencies[0].resolved_state, null); assert.equal(rev.dependencies[0].review.id, ctx.depRev);
  assert.ok(rev.can.declare_outcomes.includes("approved") && rev.can.declare_outcomes.includes("approved_subject_to_circulation") === false, JSON.stringify(rev.can.declare_outcomes));
  r = await post(`/sessions/${ctx.ses}/items/${ctx.rev}/declare`, "j.duduka", { outcome: "approved", rationale: "Approved pending the key-management decision." }); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.stage, "approved_pending_dependencies"); assert.equal(r.body.pending_outcome, "approved"); assert.equal(r.body.effective, false);
  const after = (await get(`/reviews/${ctx.rev}`)).body;
  assert.equal(after.stage, "approved_pending_dependencies"); assert.equal(after.pending_outcome, "approved"); assert.equal(after.session.code, "SES-0002");
  const ev = after.events.find((e: any) => e.kind === "approve"); assert.equal(ev.session_id, ctx.ses); assert.equal(ev.session_code, "SES-0002");
  const item = (await get(`/sessions/${ctx.ses}`)).body.items[0]; assert.equal(item.state, "declared"); assert.equal(item.outcome, "approved"); assert.equal(item.review.item_state, "declared");
  const a = audits(ctx.rev).map((x) => x.action);
  for (const need of ["position:yes", "position:conditional", "position:resolve", "dependency:create", "decide:approved"]) assert.ok(a.includes(need), need);
  assert.equal(audits(ctx.rev).find((x) => x.action === "decide:approved")!.data.session_id, ctx.ses);
  // the dependency's review goes on this session's agenda (refresh) and is decided there
  r = await post(`/sessions/${ctx.ses}/agenda/refresh`, "a.okafor"); assert.equal(r.status, 200); assert.equal(r.body.added, 1);
  r = await post(`/sessions/${ctx.ses}/items/${ctx.depRev}/call`, "j.duduka"); assert.equal(r.status, 200);
  const dep = await fillPositions(ctx.depRev);
  assert.ok(dep.areas.touched.includes("security"), `topic security → ${dep.areas.touched}`); assert.equal(dep.progress.satisfied, true);
  r = await post(`/sessions/${ctx.ses}/items/${ctx.depRev}/declare`, "j.duduka", { outcome: "approved", rationale: "Decided." }); assert.equal(r.status, 200); assert.equal(r.body.effective, true);
  const done = (await get(`/reviews/${ctx.rev}`)).body;
  assert.equal(done.stage, "approved", "the dependent item became effective"); assert.equal(done.pending_outcome, null); assert.equal(done.dependencies[0].resolved_state, "accepted");
  assert.ok(done.events.some((e: any) => e.kind === "became_effective" && e.origin === "derived" && e.verification === "unverified"));
  assert.ok(audits(ctx.rev).some((x) => x.action === "review:effective"));
  assert.equal((await get(`/decisions/${ctx.adr}`)).body.status, "accepted");
});

test("a rejected dependency returns the dependent item to the agenda", async () => {
  let r = await post("/reviews", "t.nguyen", design("Sessions: depends on the AI decision", "Data Platform")); assert.equal(r.status, 200); const rid = r.body.id;
  r = await put(`/reviews/${rid}/areas`, "t.nguyen", { areas: ["ai"] }); assert.equal(r.status, 200);
  // ADR-0004 is carried by the seeded design review REV-0008 (submitted): deciding it directly is refused while that review is in flight
  const adr4 = (db.prepare("SELECT id FROM decisions WHERE code='ADR-0004'").get() as any).id;
  r = await post(`/decisions/${adr4}/status`, "j.duduka", { status: "rejected" }); assert.equal(r.status, 409); assert.equal(r.body.error, "under review"); assert.equal(r.body.review.code, "REV-0008"); assert.equal(r.body.review.board.code, "DA");
  assert.ok(audits(adr4).some((x) => x.action === "status:refused_under_review" && x.data.review === "REV-0008"));
  assert.equal((await get(`/decisions/${adr4}`)).body.status, "proposed", "untouched");
  // a decision with no review in flight is decided directly by a chair
  r = await post("/decisions", "t.nguyen", { title: "Sessions: a dependency decided directly", topic: "ai" }); assert.equal(r.status, 200); const adrX = r.body.id;
  r = await post(`/reviews/${rid}/dependencies`, "a.uditor", { decision_id: adrX }); assert.equal(r.status, 403);
  r = await post(`/reviews/${rid}/dependencies`, "t.nguyen", { decision_id: adrX }); assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.decision.id, adrX);
  r = await post(`/reviews/${rid}/dependencies`, "t.nguyen", { decision_id: adrX }); assert.equal(r.status, 409, "linked once");
  await fillPositions(rid);
  r = await post(`/reviews/${rid}/decide`, "j.duduka", { outcome: "approved_with_conditions", conditions: [{ text: "Hazard log before go-live", area: "ai" }] }); assert.equal(r.status, 200); assert.equal(r.body.stage, "approved_pending_dependencies");
  assert.equal((await get(`/reviews/${rid}`)).body.conditions[0].area, "ai");
  r = await post(`/decisions/${adrX}/status`, "j.duduka", { status: "rejected" }); assert.equal(r.status, 200);
  const back = (await get(`/reviews/${rid}`)).body;
  assert.equal(back.stage, "in_review"); assert.equal(back.pending_outcome, null); assert.equal(back.dependencies[0].resolved_state, "rejected");
  assert.ok(back.events.some((e: any) => e.kind === "dependency_rejected")); assert.ok(audits(rid).some((x) => x.action === "dependency:rejected"));
  r = await post(`/decisions/${adrX}/status`, "j.duduka", { status: "proposed" }); assert.equal(r.status, 200);
  // the chair sends it back for rework (a rationale is mandatory); the author must resubmit before new positions
  r = await post(`/reviews/${rid}/decide`, "j.duduka", { outcome: "changes_requested" }); assert.equal(r.status, 400);
  r = await post(`/reviews/${rid}/decide`, "j.duduka", { outcome: "changes_requested", rationale: "Rework without the AI decision." }); assert.equal(r.status, 200); assert.equal(r.body.stage, "changes_requested");
  r = await post(`/reviews/${rid}/positions`, "m.hughes", { area: "ai", position: "yes" }); assert.equal(r.status, 403); assert.match(r.body.reason, /resubmit/);
  ctx.rejectedDep = rid;
});

test("consent agenda, pull, circulation to an absent owner, deferral, close with hashed minutes, frozen positions", async () => {
  // three more items: X ready before the sitting (consent), Z ready but pulled, Y touching only the absent owner's area
  const mk = async (title: string, areas: string[], user = "a.okafor", appName = "Intranet") => { const r = await post("/reviews", user, design(title, appName)); assert.equal(r.status, 200); const p = await put(`/reviews/${r.body.id}/areas`, user, { areas }); assert.equal(p.status, 200); return r.body.id as string; };
  const X = await mk("Sessions: consent item", ["data"]); const Z = await mk("Sessions: pulled item", ["ai"]); const Y = await mk("Sessions: circulation item", ["cost"], "s.patel");
  await fillPositions(X); await fillPositions(Z);
  let r = await post(`/sessions/${ctx.ses}/agenda/refresh`, "a.okafor"); assert.equal(r.status, 200); assert.ok(r.body.added >= 3);
  const view = (await get(`/sessions/${ctx.ses}`, "j.duduka")).body;
  const codes = Object.fromEntries(view.items.map((i: any) => [i.review.id, i]));
  assert.equal(codes[X].consent, false, "consent is set when the session opens, not on refresh"); assert.equal(codes[X].review.item_state, "ready");
  r = await post(`/sessions/${ctx.ses}/items/${X}/call`, "j.duduka"); assert.equal(r.status, 200);
  r = await post(`/sessions/${ctx.ses}/close`, "j.duduka", {}); assert.equal(r.status, 409, "a called item must be declared or deferred first"); assert.match(r.body.error, /called items/);
  r = await post(`/sessions/${ctx.ses}/items/${X}/defer`, "j.duduka", { reason: "Out of time; carried to the next sitting." }); assert.equal(r.status, 200);
  // close: the remaining listed items are deferred as not reached
  r = await post(`/sessions/${ctx.ses}/close`, "j.duduka", { notes_md: "First sitting closed." }); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, "closed"); assert.ok(r.body.minutes); assert.match(r.body.minutes_hash, /^[0-9a-f]{64}$/);
  const deferred = r.body.items.filter((i: any) => i.state === "deferred"); assert.ok(deferred.length >= 3, "listed-but-never-called items are auto-deferred");
  assert.ok(deferred.filter((i: any) => i.review.id !== X).every((i: any) => i.note === "not reached" && i.review.deferred_count === 1 && i.review.deferred_reason === "not reached"), JSON.stringify(deferred.map((i: any) => [i.review.code, i.note])));
  assert.equal(deferred.find((i: any) => i.review.id === X).note, "Out of time; carried to the next sitting.");
  const closedSes = ctx.ses;
  // frozen: the item declared approved in the closed session takes no more positions or resolutions
  r = await post(`/reviews/${ctx.rev}/positions`, "m.hughes", { area: "security", position: "no", text: "second thoughts" }); assert.equal(r.status, 409); assert.match(r.body.error, /frozen/);
  r = await post(`/positions/${ctx.pos}/resolve`, "j.duduka", { resolution: "addressed", text: "trying to re-resolve a frozen one" }); assert.equal(r.status, 409);
  r = await post(`/reviews/${ctx.rev}/approvals`, "p.osei", { decision: "approve" }); assert.equal(r.status, 409);
  // minutes: derived, hashed as stored, markdown rendered, audited
  const m = await get(`/sessions/${closedSes}/minutes`, "a.uditor"); assert.equal(m.status, 200);
  const stored = (db.prepare("SELECT minutes_json, minutes_hash FROM board_sessions WHERE id=?").get(closedSes) as any);
  assert.equal(m.body.minutes_hash, stored.minutes_hash); assert.equal(sha256(canonical(JSON.parse(stored.minutes_json))), stored.minutes_hash, "hash = sha256(canonical(minutes))");
  assert.equal(m.body.minutes.origin, "derived"); assert.equal(m.body.minutes.code, "SES-0002"); assert.equal(m.body.minutes.notes_md, "First sitting closed."); assert.equal(m.body.minutes.chair.user_id, "j.duduka");
  const mi = m.body.minutes.items.find((i: any) => i.code === ctx.revCode);
  assert.equal(mi.outcome, "approved"); assert.ok(mi.positions.some((p: any) => p.area === "security" && p.resolution === "dependent_decision" && p.on_behalf_of === "m.hughes")); assert.equal(mi.dependencies_created.length, 1);
  assert.ok(m.body.minutes.delegations.some((d: any) => d.delegator === "m.hughes" && d.delegate === "s.patel"));
  assert.ok(m.body.markdown.includes("# SES-0002") && m.body.markdown.includes(ctx.revCode));
  const close = (db.prepare("SELECT data_json FROM audit_log WHERE entity_id=? AND action='session:close'").get(closedSes) as any); assert.equal(JSON.parse(close.data_json).minutes_hash, stored.minutes_hash);
  assert.equal((await get("/audit/verify")).body.ok, true);
  r = await post(`/sessions/${closedSes}/attendance`, "p.osei", { status: "present" }); assert.equal(r.status, 409, "a closed session takes no attendance");
  // the next sitting: X and Z are ready → consent; Y waits on cost's owner p.osei, who sends apologies
  r = await post("/boards/DA/sessions", "a.okafor", { scheduled_at: "2026-11-17T10:00:00Z" }); assert.equal(r.status, 200); const ses3 = r.body.id; assert.equal(r.body.code, "SES-0003");
  assert.deepEqual(r.body.items.slice(0, 2).map((i: any) => i.review.item_state), ["ready", "ready"], "ready items first");
  assert.ok(r.body.items.every((i: any) => i.review.id !== ctx.rev), "a decided item is not re-listed");
  r = await post(`/sessions/${ses3}/attendance`, "m.hughes", { status: "present" }); assert.equal(r.status, 200);
  r = await post(`/sessions/${ses3}/attendance`, "a.okafor", { user_id: "p.osei", status: "apologies" }); assert.equal(r.status, 200);
  r = await post(`/sessions/${ses3}/open`, "j.duduka"); assert.equal(r.status, 200);
  assert.equal(r.body.quorum.find((q: any) => q.area === "cost").covered, false); assert.equal(r.body.quorum.find((q: any) => q.area === "data").covered, true);
  const consent = r.body.items.filter((i: any) => i.consent).map((i: any) => i.review.id); assert.deepEqual(consent.sort(), [X, Z].sort()); assert.equal(r.body.consent_count, 2);
  r = await post(`/sessions/${ses3}/items/${Z}/pull`, "a.okafor"); assert.equal(r.status, 403);
  r = await post(`/sessions/${ses3}/items/${Z}/pull`, "j.duduka"); assert.equal(r.status, 200);
  r = await post(`/sessions/${ses3}/consent/declare`, "a.okafor"); assert.equal(r.status, 403);
  r = await post(`/sessions/${ses3}/consent/declare`, "j.duduka", {}); assert.equal(r.status, 200); assert.equal(r.body.declared, 1); assert.deepEqual(r.body.skipped, []);
  assert.equal((await get(`/reviews/${X}`)).body.stage, "approved"); assert.ok((await get(`/reviews/${X}`)).body.events.some((e: any) => e.kind === "consent_declared"));
  assert.equal((await get(`/reviews/${Z}`)).body.stage, "in_review", "a pulled item is not declared");
  // circulation: cost's owner is away; the chair approves subject to circulation with a due date
  r = await post(`/sessions/${ses3}/items/${Y}/call`, "j.duduka"); assert.equal(r.status, 200);
  r = await post(`/reviews/${Y}/decide`, "j.duduka", { outcome: "approved_subject_to_circulation" }); assert.equal(r.status, 400, "circulation_due is required");
  r = await post(`/reviews/${X}/decide`, "j.duduka", { outcome: "approved_subject_to_circulation", circulation_due: "2026-11-24" }); assert.equal(r.status, 403, "X is already decided");
  r = await post(`/sessions/${ses3}/items/${Y}/declare`, "j.duduka", { outcome: "approved_subject_to_circulation", circulation_due: "2026-11-24", rationale: "Cost to confirm by circulation." }); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.stage, "approved_subject_to_circulation"); assert.equal(r.body.pending_outcome, "approved");
  let y = (await get(`/reviews/${Y}`, "p.osei")).body; assert.equal(y.circulation_due, "2026-11-24"); assert.equal(y.can.record_position, true, "the absent owner may still record");
  r = await post(`/reviews/${Y}/positions`, "m.hughes", { area: "cost", position: "yes" }); assert.equal(r.status, 403);
  // Z deferred explicitly with a reason; then close: Z deferred_count counts up, Y stays in circulation
  r = await post(`/sessions/${ses3}/items/${Z}/defer`, "j.duduka", { reason: "AI hazard log not ready" }); assert.equal(r.status, 200);
  assert.equal((await get(`/reviews/${Z}`)).body.deferred_count, 2); assert.equal((await get(`/reviews/${Z}`)).body.deferred_reason, "AI hazard log not ready");
  r = await post(`/sessions/${ses3}/close`, "j.duduka", {}); assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.items.find((i: any) => i.review.id === Y).outcome, "approved_subject_to_circulation");
  // the absent owner's position arrives: the approval takes effect
  r = await post(`/reviews/${Y}/positions`, "p.osei", { area: "cost", position: "yes" }); assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.stage, "approved");
  y = (await get(`/reviews/${Y}`)).body; assert.equal(y.stage, "approved"); assert.ok(y.events.some((e: any) => e.kind === "became_effective")); assert.ok(audits(Y).some((x) => x.action === "review:effective"));
  // an objection in circulation would have sent it back instead: a second circulated item
  const W = await mk("Sessions: circulation objection", ["cost"], "s.patel");
  r = await post("/boards/DA/sessions", "a.okafor", { scheduled_at: "2026-12-01T10:00:00Z" }); const ses4 = r.body.id;
  await post(`/sessions/${ses4}/attendance`, "m.hughes", { status: "present" }); await post(`/sessions/${ses4}/open`, "j.duduka");
  r = await post(`/sessions/${ses4}/items/${W}/declare`, "j.duduka", { outcome: "approved_subject_to_circulation", circulation_due: "2026-12-08" }); assert.equal(r.status, 200);
  await post(`/sessions/${ses4}/close`, "j.duduka", {});
  r = await post(`/reviews/${W}/positions`, "p.osei", { area: "cost", position: "no", text: "Not within budget." }); assert.equal(r.status, 200); assert.equal(r.body.stage, "in_review");
  assert.ok((await get(`/reviews/${W}`)).body.events.some((e: any) => e.kind === "circulation_objection"));
  // the sessions list and the evidence pack carry the closed sittings with their hashes
  const list = await get("/sessions?board=DA&status=closed"); assert.deepEqual(list.body.map((s: any) => s.code).sort(), ["SES-0002", "SES-0003", "SES-0004"]);
  const pack = await get("/evidence-pack", "a.uditor"); assert.equal(pack.status, 200);
  const ps = pack.body.sessions.find((s: any) => s.code === "SES-0002"); assert.equal(ps.minutes_hash, stored.minutes_hash); assert.equal(ps.board, "DA"); assert.ok(ps.items.some((i: any) => i.code === ctx.revCode && i.outcome === "approved"));
  assert.ok(!/\b(is|are|was|were|fully|now)\s+compliant\b|\bcertified\b|\bassured\b/i.test(JSON.stringify(pack.body)), "nothing asserts compliance");
  const appPack = await get(`/evidence-pack?application=${apps.get("Appointments")}`, "a.uditor"); assert.ok(appPack.body.sessions.some((s: any) => s.code === "SES-0002") && !appPack.body.sessions.some((s: any) => s.code === "SES-0003"), "per application: only sessions that declared one of its reviews");
  assert.equal((await get("/audit/verify")).body.ok, true);
  const facets = (await get("/audit?limit=1")).body.facets.actions;
  for (const a of ["session:create", "session:open", "session:close", "session:attendance", "session:delegate", "session:revoke_delegation", "session:call", "session:pull", "session:defer", "session:consent_declare", "session:agenda", "position:yes", "position:no", "position:conditional", "position:resolve", "dependency:create", "review:effective", "review:areas", "decide:approved", "decide:deferred", "decide:approved_subject_to_circulation"]) assert.ok(facets.includes(a), a);
});

test("count mode untouched: the PCB policy review still runs through /approvals; the legacy alias maps to owned areas on the DA", async () => {
  const pcbRev = (db.prepare("SELECT * FROM reviews WHERE type='policy' AND board_id=(SELECT id FROM boards WHERE code='PCB') ORDER BY created_at LIMIT 1").get() as any);
  let r = await get(`/reviews/${pcbRev.id}`, "r.khan"); assert.equal(r.body.progress.mode, "count"); assert.equal(r.body.progress.required, 2); assert.deepEqual(r.body.areas.touched, []);
  r = await post(`/reviews/${pcbRev.id}/positions`, "j.duduka", { position: "conditional", text: "x" }); assert.equal(r.status, 400, "count mode takes yes or no");
  r = await post(`/reviews/${pcbRev.id}/approvals`, "j.duduka", { decision: "approve" }); assert.equal(r.status, 200); assert.equal(r.body.approval.decision, "approve"); assert.equal(r.body.approval.area, null); assert.equal(r.body.progress.received, 1);
  r = await post(`/reviews/${pcbRev.id}/approvals`, "m.hughes", { decision: "approve", comment: "ok" }); assert.equal(r.status, 200); assert.equal(r.body.progress.satisfied, true);
  r = await post(`/reviews/${pcbRev.id}/decide`, "r.khan", { outcome: "approved" }); assert.equal(r.status, 200); assert.equal(r.body.stage, "approved");
  assert.deepEqual((await get(`/reviews/${pcbRev.id}`)).body.approvals.map((a: any) => [a.user_id, a.decision, a.board_role]), [["j.duduka", "approve", "decision_maker"], ["m.hughes", "approve", "decision_maker"]]);
  // the alias on an areas-mode review: yes on every touched area the caller owns, 403 when none
  r = await post("/reviews", "t.nguyen", design("Sessions: alias", "Appointments")); const rid = r.body.id;
  await put(`/reviews/${rid}/areas`, "t.nguyen", { areas: ["infrastructure", "cost"] });
  r = await post(`/reviews/${rid}/approvals`, "m.hughes", { decision: "approve" }); assert.equal(r.status, 403); assert.match(r.body.reason, /own none/);
  r = await post(`/reviews/${rid}/approvals`, "p.osei", { decision: "request_changes" }); assert.equal(r.status, 400, "a comment is required");
  r = await post(`/reviews/${rid}/approvals`, "p.osei", { decision: "approve" }); assert.equal(r.status, 200); assert.deepEqual(r.body.positions.map((p: any) => p.area), ["infrastructure", "cost"]); assert.equal(r.body.progress.satisfied, true);
  r = await post(`/reviews/${rid}/approvals`, "p.osei", { decision: "request_changes", comment: "Over budget." }); assert.equal(r.status, 200); assert.equal(r.body.stage, "changes_requested"); assert.equal(r.body.progress.blocked, true);
  assert.equal((await get(`/reviews/${rid}`)).body.approvals.filter((a: any) => !a.superseded).length, 2, "one live position per area");
  r = await post(`/reviews/${rid}/resubmit`, "t.nguyen", { note: "Budget trimmed." }); assert.equal(r.status, 200); assert.equal(r.body.progress.received, 0);
  r = await post(`/reviews/${rid}/decide`, "j.duduka", { outcome: "rejected" }); assert.equal(r.status, 400, "a rationale is required");
  r = await post(`/reviews/${rid}/decide`, "j.duduka", { outcome: "referred", rationale: "Policy question.", board_id: (db.prepare("SELECT id FROM boards WHERE code='PCB'").get() as any).id }); assert.equal(r.status, 200);
  const ref = (await get(`/reviews/${rid}`)).body; assert.equal(ref.board.code, "PCB"); assert.equal(ref.stage, "in_review"); assert.deepEqual(ref.areas.touched, [], "re-derived against a board without areas"); assert.equal(ref.progress.mode, "count");
  r = await post(`/reviews/${rid}/decide`, "t.nguyen", { outcome: "withdrawn" }); assert.equal(r.status, 200); assert.equal((await get(`/reviews/${rid}`)).body.stage, "withdrawn");
});

test("attendance follows the acts: the opener is present, and so is an owner who records a position in the open sitting", async () => {
  let r = await post("/reviews", "t.nguyen", design("Sessions: attendance by acting", "Appointments")); assert.equal(r.status, 200); const V = r.body.id;
  r = await put(`/reviews/${V}/areas`, "t.nguyen", { areas: ["data", "cost"] }); assert.equal(r.status, 200);
  r = await post("/boards/DA/sessions", "a.okafor", { scheduled_at: "2026-12-15T10:00:00Z" }); assert.equal(r.status, 200); const ses = r.body.id;
  assert.ok(r.body.items.some((i: any) => i.review.id === V)); assert.ok(r.body.attendance.every((a: any) => a.status === "absent"), "nothing recorded before the sitting");
  r = await post(`/sessions/${ses}/open`, "j.duduka"); assert.equal(r.status, 200);
  const chair = r.body.attendance.find((a: any) => a.user_id === "j.duduka"); assert.equal(chair.status, "present"); assert.equal(chair.recorded_by, "j.duduka"); assert.equal(chair.on_behalf_of, null);
  assert.equal(r.body.attendance.find((a: any) => a.user_id === "m.hughes").status, "absent");
  // m.hughes has no attendance record; recording a position in the open sitting puts her in the room, self-recorded
  r = await post(`/reviews/${V}/positions`, "m.hughes", { area: "data", position: "yes" }); assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.positions[0].session_id, ses);
  let view = (await get(`/sessions/${ses}`)).body;
  const mh = view.attendance.find((a: any) => a.user_id === "m.hughes"); assert.equal(mh.status, "present"); assert.equal(mh.recorded_by, "m.hughes"); assert.equal(mh.on_behalf_of, null);
  assert.ok(view.quorum.find((q: any) => q.area === "data").covered);
  assert.ok(audits(ses).some((x) => x.action === "session:attendance" && x.actor === "m.hughes" && x.data.user_id === "m.hughes" && x.data.self === true));
  // an existing record is not overwritten by a position: p.osei sent apologies, records on cost anyway, and stays as recorded
  r = await post(`/sessions/${ses}/attendance`, "a.okafor", { user_id: "p.osei", status: "apologies" }); assert.equal(r.status, 200);
  r = await post(`/reviews/${V}/positions`, "p.osei", { area: "cost", position: "yes" }); assert.equal(r.status, 200);
  view = (await get(`/sessions/${ses}`)).body; assert.equal(view.attendance.find((a: any) => a.user_id === "p.osei").status, "apologies");
  r = await post(`/sessions/${ses}/close`, "j.duduka", {}); assert.equal(r.status, 200);
  assert.equal((await get("/audit/verify")).body.ok, true);
});
