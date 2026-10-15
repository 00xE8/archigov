import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Assessments: a board seat (chair / decision maker / reviewer) requests due diligence on a review, naming the
// assessor; only the assessor records the result, as themselves; an open request blocks the approving outcomes
// until the result is recorded or the chair waives it with a reason; a resubmission marks completed results stale;
// the assignee sees the request in /me/work; results travel in the evidence pack. The platform admin gets 403 on
// every mutation (segregation of duties).
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "archigov-assess-"));
delete process.env.AUTH_MODE;
const { db, migrate } = await import("../src/db.js");
await migrate();
const { seedDemo } = await import("../src/seed.js");
seedDemo("test");
const { seedBoards } = await import("../src/boards/seed.js");
seedBoards("test");
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

const apps = new Map((db.prepare("SELECT id, name FROM elements WHERE type='application'").all() as any[]).map((a) => [a.name, a.id]));
const submitDesign = async (title: string) => {
  const r = await post("/reviews", "t.nguyen", { type: "design", title, application_id: apps.get("Intranet"), risk_tier: "medium", summary: "s", design_md: "## Design\n\nx\n\n## Data\n\nPatient identifiers leave the tenant.\n" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const a = await put(`/reviews/${r.body.id}/areas`, "t.nguyen", { areas: ["data"] });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  return r.body;
};
const review = async (id: string, user = "a.uditor") => { const r = await get(`/reviews/${id}`, user); assert.equal(r.status, 200); return r.body; };
const ctx: Record<string, any> = {};

test("requesting is a board seat's act: the reviewer requests, the submitter and the platform admin are refused, auditors cannot be assessors", async () => {
  ctx.rev1 = await submitDesign("Assessed design one");
  const id = ctx.rev1.id;
  assert.equal((await post(`/reviews/${id}/assessments`, "ops.admin", { type: "dpia", assigned_to: "t.nguyen" })).status, 403, "platform admin is not a governance identity");
  const self = await post(`/reviews/${id}/assessments`, "t.nguyen", { type: "dpia", assigned_to: "t.nguyen" });
  assert.equal(self.status, 403, "the submitter does not request assessments of their own review");
  assert.equal((await post(`/reviews/${id}/assessments`, "s.patel", { type: "dpia", assigned_to: "a.uditor" })).status, 400, "an auditor changes nothing and cannot assess");
  assert.equal((await post(`/reviews/${id}/assessments`, "s.patel", { type: "other", assigned_to: "t.nguyen" })).status, 400, "a custom assessment needs a title");
  const ok = await post(`/reviews/${id}/assessments`, "s.patel", { type: "dpia", area: "data", assigned_to: "t.nguyen", due_at: "2026-12-01" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.assessments.length, 1);
  const a = ok.body.assessments[0];
  assert.equal(a.status, "requested"); assert.equal(a.type, "dpia"); assert.equal(a.assigned_to, "t.nguyen"); assert.equal(a.requested_by, "s.patel"); assert.equal(a.area, "data");
  ctx.a1 = a;
  const r = await review(id, "s.patel");
  assert.equal(r.can.request_assessment, true);
  assert.equal(r.progress.open_assessments, 1);
  const rSub = await review(id, "t.nguyen");
  assert.equal(rSub.can.request_assessment, false);
  assert.ok(rSub.why.request_assessment);
});

test("an open assessment blocks the approving outcomes even when every position is in; the work queue asks the assignee", async () => {
  const id = ctx.rev1.id;
  const pos = await post(`/reviews/${id}/positions`, "m.hughes", { area: "data", position: "yes" });
  assert.equal(pos.status, 200, JSON.stringify(pos.body));
  assert.equal(pos.body.progress.satisfied, true, "positions are complete");
  assert.equal(pos.body.progress.ready, false, "but the open assessment keeps it not ready");
  const r = await review(id, "j.duduka");
  assert.ok(!r.can.declare_outcomes.includes("approved"), JSON.stringify(r.can.declare_outcomes));
  assert.match(r.why.decide ?? "", /assessments outstanding/i);
  assert.equal((await post(`/reviews/${id}/decide`, "j.duduka", { outcome: "approved" })).status, 403, "declare approved is refused while the assessment is open");
  const w = await get("/me/work", "t.nguyen");
  const mine = w.body.assessments.find((x: any) => x.id === ctx.a1.id);
  assert.ok(mine, JSON.stringify(w.body.assessments));
  assert.equal(mine.review.code, ctx.rev1.code); assert.equal(mine.type, "dpia"); assert.equal(mine.due_at, "2026-12-01");
});

test("only the assessor records the result, as themselves; a recorded result lifts the block and the chair declares", async () => {
  const id = ctx.rev1.id;
  assert.equal((await post(`/assessments/${ctx.a1.id}/result`, "m.hughes", { result: "satisfactory", result_md: "Looks fine to me overall." })).status, 403, "not the assignee");
  assert.equal((await post(`/assessments/${ctx.a1.id}/result`, "t.nguyen", { result: "satisfactory", result_md: "short" })).status, 400, "a real summary is required");
  const done = await post(`/assessments/${ctx.a1.id}/result`, "t.nguyen", { result: "satisfactory_with_remarks", result_md: "DPIA completed; residual risk accepted by the IG lead.", reference: "https://dms.example/dpia-123" });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const a = done.body.assessments.find((x: any) => x.id === ctx.a1.id);
  assert.equal(a.status, "completed"); assert.equal(a.result, "satisfactory_with_remarks"); assert.equal(a.completed_by, "t.nguyen"); assert.equal(a.reference, "https://dms.example/dpia-123"); assert.equal(a.stale, false);
  assert.equal(done.body.progress.open_assessments, 0);
  assert.equal(done.body.progress.ready, true, "recorded result lifts the block");
  assert.equal((await post(`/assessments/${ctx.a1.id}/result`, "t.nguyen", { result: "satisfactory", result_md: "Recording twice is a conflict." })).status, 409);
  const declared = await post(`/reviews/${id}/decide`, "j.duduka", { outcome: "approved" });
  assert.equal(declared.status, 200, JSON.stringify(declared.body));
  assert.equal(declared.body.stage, "approved");
});

test("a resubmission marks completed results stale; the chair waives with a reason, a decision maker cannot", async () => {
  ctx.rev2 = await submitDesign("Assessed design two");
  const id = ctx.rev2.id;
  const req = await post(`/reviews/${id}/assessments`, "s.patel", { type: "supplier", assigned_to: "t.nguyen" });
  assert.equal(req.status, 200);
  const a2 = req.body.assessments[0];
  assert.equal((await post(`/assessments/${a2.id}/result`, "t.nguyen", { result: "unsatisfactory", result_md: "Supplier holds no UK data residency commitment." })).status, 200);
  // an unsatisfactory result does not hard-block: the chair may still send the item back (or approve — boards decide)
  const back = await post(`/reviews/${id}/decide`, "j.duduka", { outcome: "changes_requested", rationale: "Pick a supplier with UK residency." });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  const resub = await post(`/reviews/${id}/resubmit`, "t.nguyen", { note: "Switched supplier." });
  assert.equal(resub.status, 200, JSON.stringify(resub.body));
  const r = await review(id);
  const stale = r.assessments.find((x: any) => x.id === a2.id);
  assert.equal(stale.stale, true, "the result assessed the earlier version");
  assert.equal(stale.status, "completed", "never deleted");
  // a fresh request on the resubmitted version, then the waive path
  const req3 = await post(`/reviews/${id}/assessments`, "s.patel", { type: "security", assigned_to: "m.hughes" });
  assert.equal(req3.status, 200);
  const a3 = req3.body.assessments.find((x: any) => x.status === "requested");
  assert.equal((await post(`/assessments/${a3.id}/waive`, "m.hughes", { reason: "I would rather not do this one." })).status, 403, "a decision maker does not waive");
  assert.equal((await post(`/assessments/${a3.id}/waive`, "j.duduka", { reason: "short" })).status, 400, "a real reason is required");
  const waived = await post(`/assessments/${a3.id}/waive`, "j.duduka", { reason: "Covered by the supplier assessment already on record." });
  assert.equal(waived.status, 200, JSON.stringify(waived.body));
  const w = waived.body.assessments.find((x: any) => x.id === a3.id);
  assert.equal(w.status, "waived"); assert.equal(w.waived_by, "j.duduka");
  assert.equal(waived.body.progress.open_assessments, 0);
});

test("the evidence pack carries each review's assessments, with who asked and who stood behind the result", async () => {
  const pack = await get(`/evidence-pack?application=${apps.get("Intranet")}`, "a.uditor");
  assert.equal(pack.status, 200);
  const intranet = pack.body.applications.find((a: any) => a.name === "Intranet");
  const rev = intranet.reviews.find((r: any) => r.code === ctx.rev1.code);
  assert.ok(rev, "the assessed review is in the pack");
  assert.equal(rev.assessments.length, 1);
  assert.equal(rev.assessments[0].type, "dpia");
  assert.equal(rev.assessments[0].result, "satisfactory_with_remarks");
  assert.equal(rev.assessments[0].assigned_to, "t.nguyen");
  assert.equal(rev.assessments[0].requested_by, "s.patel");
});
