import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The fast lane: a low-risk design review following adopted patterns, passing every deterministic check, is
// satisfied without positions so the chair may declare it at once. The tier is derived (the submitter can only
// raise it), the pattern claim is checked against the catalogue and its rules, an AI pre-review can veto but never
// grant, any objection or open assessment takes the item out of the lane, and the declaration records the basis.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "archigov-fastlane-"));
delete process.env.AUTH_MODE;
const { db, migrate, uid, nowIso } = await import("../src/db.js");
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
const apps = new Map((db.prepare("SELECT id, name FROM elements WHERE type='application'").all() as any[]).map((a) => [a.name, a.id]));
const da = (db.prepare("SELECT id FROM boards WHERE code='DA'").get() as any).id;
const CLEAN = "## Design\n\nA page on the existing web app.\n\n## Data\n\nEditor-written posts only.\n\n## Security\n\nExisting sign-in; ingress through the gateway.\n\n## Resilience\n\nBest effort.\n";
const submit = async (title: string, extra: any = {}, user = "t.nguyen") => {
  const r = await post("/reviews", user, { type: "design", title, application_id: apps.get("Intranet"), risk_tier: "low", summary: "s", design_md: CLEAN, patterns: ["PAT-001"], ...extra });
  assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.id as string;
};
const lane = async (id: string) => (await get(`/reviews/${id}`)).body.progress;
const failing = (fl: any) => fl.checks.filter((c: any) => !c.ok).map((c: any) => c.id);

test("the demo DA offers the fast lane on design reviews only, and its seeded Intranet review is in it", async () => {
  const b = await get(`/boards/${da}`);
  assert.deepEqual(b.body.policies.design.fast_lane, { enabled: true, require_pattern: true });
  assert.equal(b.body.policies.decision.fast_lane, undefined);
  assert.ok(seeded.fast_lane_review, JSON.stringify(seeded));
  const rev = db.prepare("SELECT id FROM reviews WHERE code=?").get(seeded.fast_lane_review) as any;
  const p = await lane(rev.id);
  assert.equal(p.via_fast_lane, true, JSON.stringify(p.fast_lane?.checks));
  assert.equal(p.ready, true); assert.equal(p.satisfied, true);
  assert.equal(p.fast_lane.risk.tier, "low"); assert.deepEqual(p.fast_lane.patterns.map((x: any) => x.code), ["PAT-001"]);
  assert.ok(p.fast_lane.checks.every((c: any) => c.ok));
  const chair = (await get("/me/work", "j.duduka")).body;
  assert.ok(chair.declare.some((d: any) => d.review.id === rev.id), "the chair is asked to declare it");
  for (const u of ["m.hughes", "p.osei"]) assert.ok(!(await get("/me/work", u)).body.positions.some((x: any) => x.review.id === rev.id), `${u} is not awaited`);
  const r = await put(`/boards/${da}/policies/decision`, "j.duduka", { policy: { ...b.body.policies.decision, fast_lane: { enabled: true } } });
  assert.equal(r.status, 400, "the fast lane applies to design reviews only");
});

test("claims: only adopted patterns, only on design reviews; the submitter alone changes the claim", async () => {
  assert.equal((await post("/reviews", "t.nguyen", { type: "design", title: "x", application_id: apps.get("Intranet"), patterns: ["STD-001"] })).status, 400, "a standard is not a pattern");
  const draft = await post("/artefacts", "s.patel", { kind: "pattern", title: "Draft pattern for the lane", category: "Integration", statement: "s", context: "c", solution: "s" });
  assert.equal((await post("/reviews", "t.nguyen", { type: "design", title: "x", application_id: apps.get("Intranet"), patterns: [draft.body.id] })).status, 400, "a draft pattern cannot be claimed");
  const dec = (db.prepare("SELECT id FROM decisions LIMIT 1").get() as any).id;
  assert.equal((await post("/reviews", "s.patel", { type: "decision", title: "x", decision_id: dec, patterns: ["PAT-001"] })).status, 400);
  const id = await submit("Lane: claim edits", { patterns: [] });
  assert.deepEqual(failing((await lane(id)).fast_lane), ["patterns"], "this board requires a claimed pattern");
  assert.equal((await put(`/reviews/${id}/patterns`, "s.patel", { patterns: ["PAT-001"] })).status, 403, "only the submitter states the claim");
  const r = await put(`/reviews/${id}/patterns`, "t.nguyen", { patterns: ["PAT-001"] });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.progress.via_fast_lane, true);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action='review:patterns' AND entity_id=?").get(id));
});

test("the tier is derived: a critical application, an unclassified one or a declared medium keep a review out", async () => {
  const pf = await post("/reviews", "t.nguyen", { type: "design", title: "Lane: critical app", application_id: apps.get("PatientFlow"), risk_tier: "low", summary: "s", design_md: CLEAN, patterns: ["PAT-001"] });
  const p1 = await lane(pf.body.id);
  assert.equal(p1.fast_lane.risk.tier, "high"); assert.ok(failing(p1.fast_lane).includes("risk")); assert.equal(p1.via_fast_lane, false);
  assert.ok(p1.fast_lane.risk.reasons.some((x: string) => /critical/.test(x)));
  const ph = await post("/reviews", "t.nguyen", { type: "design", title: "Lane: unclassified app", application_id: apps.get("Pharmacy"), risk_tier: "low", summary: "s", design_md: CLEAN, patterns: ["PAT-001"] });
  assert.equal((await lane(ph.body.id)).fast_lane.risk.tier, "medium");
  const med = await submit("Lane: declared medium", { risk_tier: "medium" });
  assert.equal((await lane(med)).fast_lane.risk.tier, "medium", "the submitter can raise the tier, never lower it");
});

test("the pre-review gates it: a missing section, or an AI finding of medium or above, vetoes the lane", async () => {
  const thin = await submit("Lane: thin design", { design_md: "## Design\n\nA page.\n" });
  assert.ok(failing((await lane(thin)).fast_lane).includes("pre_review"));
  const id = await submit("Lane: AI veto");
  assert.equal((await lane(id)).via_fast_lane, true);
  // an AI pre-review on the same version that finds something serious takes it out; the deterministic checks never put it back
  db.prepare("INSERT INTO review_events(id,review_id,kind,actor,body_md,data_json,origin,verification,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(uid(), id, "pre_review", "system", "AI", JSON.stringify({ engine: "llm", findings: [{ severity: "medium", title: "Editors' accounts are not covered by MFA", detail: "d", citations: [{ kind: "section", ref: "security" }] }] }), "ai", "unverified", nowIso());
  const p = await lane(id);
  assert.equal(p.via_fast_lane, false); assert.deepEqual(failing(p.fast_lane), ["pre_review"]);
  assert.match(p.fast_lane.checks.find((c: any) => c.id === "pre_review").detail, /AI pre-review/);
});

test("any owner takes an item out of the lane: a no, an open conditional, or an assessment request", async () => {
  const a = await submit("Lane: objection");
  assert.equal((await post(`/reviews/${a}/positions`, "m.hughes", { area: "security", position: "no", text: "Editors need MFA first." })).status, 200);
  const p = await lane(a);
  assert.equal(p.via_fast_lane, false); assert.ok(failing(p.fast_lane).includes("objections"));
  assert.equal((await post(`/reviews/${a}/decide`, "j.duduka", { outcome: "approved" })).status, 403, "the chair can no longer declare it");
  const c = await submit("Lane: conditional");
  assert.equal((await post(`/reviews/${c}/positions`, "p.osei", { area: "resilience", position: "conditional", text: "Only if the feed degrades on its own." })).status, 200);
  assert.ok(failing((await lane(c)).fast_lane).includes("objections"), "an unresolved conditional is an objection until the chair resolves it");
  const b = await submit("Lane: assessment");
  assert.equal((await post(`/reviews/${b}/assessments`, "s.patel", { type: "security", assigned_to: "t.nguyen" })).status, 200);
  assert.ok(failing((await lane(b)).fast_lane).includes("assessments"));
});

test("the chair declares a fast-lane item approved and the basis is recorded; a decision maker cannot", async () => {
  const id = await submit("Lane: declare one");
  assert.equal((await post(`/reviews/${id}/decide`, "m.hughes", { outcome: "approved" })).status, 403);
  const r = await post(`/reviews/${id}/decide`, "j.duduka", { outcome: "approved", rationale: "Standard change." });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.stage, "approved");
  const ev = db.prepare("SELECT data_json FROM review_events WHERE review_id=? AND kind='approve'").get(id) as any;
  assert.deepEqual(JSON.parse(ev.data_json).fast_lane.patterns, ["PAT-001"]);
  const au = db.prepare("SELECT data_json FROM audit_log WHERE action='decide:approved' AND entity_id=?").get(id) as any;
  assert.equal(JSON.parse(au.data_json).basis, "fast_lane");
});

test("board-wide: the chair declares every fast-lane item together; others are refused; a stale pre-review after resubmission waits", async () => {
  const x = await submit("Lane: bulk one"), y = await submit("Lane: bulk two");
  const list = await get(`/boards/${da}/fast-lane`, "j.duduka");
  assert.equal(list.status, 200); assert.ok([x, y].every((id) => list.body.some((i: any) => i.id === id && i.can_declare)));
  for (const u of ["m.hughes", "ops.admin", "t.nguyen"]) assert.equal((await post(`/boards/${da}/fast-lane/declare`, u, { review_ids: [x] })).status, 403, u);
  const r = await post(`/boards/${da}/fast-lane/declare`, "j.duduka", { review_ids: [x, y, "nope"] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.declared.map((d: any) => d.id).sort(), [x, y].sort());
  assert.deepEqual(r.body.skipped.map((s: any) => s.reason), ["not found"]);
  // sent back and resubmitted: the old pre-review assessed the old version, so the lane waits for a fresh one
  const z = await submit("Lane: resubmitted");
  assert.equal((await post(`/reviews/${z}/decide`, "j.duduka", { outcome: "changes_requested", rationale: "Name the editors." })).status, 200);
  assert.equal((await post(`/reviews/${z}/resubmit`, "t.nguyen", { note: "Editors named." })).status, 200);
  assert.ok(failing((await lane(z)).fast_lane).includes("pre_review"));
  assert.equal((await post(`/reviews/${z}/pre-review`, "s.patel")).status, 200);
  assert.equal((await lane(z)).via_fast_lane, true);
});
