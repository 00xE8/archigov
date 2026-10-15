import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Governance metrics from the records (lead times, recycling, the fast lane, conditions, exception ageing,
// conformance, coverage) and the board pack: built deterministically, signed and chained like the evidence pack,
// prepared only by a chair or secretary, read like the evidence pack, its narrative the creator's own.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "archigov-metrics-"));
delete process.env.AUTH_MODE;
delete process.env.LLM_BASE_URL; delete process.env.LLM_MODEL;
const { db, migrate, DATA_DIR } = await import("../src/db.js");
await migrate();
const { seedDemo } = await import("../src/seed.js");
seedDemo("test");
const { seedBoards } = await import("../src/boards/seed.js");
const seeded = seedBoards("test");
const { quantile } = await import("../src/metrics.js");
const { Hono } = await import("hono");
const { ZodError } = await import("zod");
const { api } = await import("../src/routes.js");
const app = new Hono();
app.route("/", api);
app.onError((err, c) => err instanceof ZodError ? c.json({ error: "invalid_request", issues: err.issues }, 400) : c.json({ error: err.message }, (err as any).status >= 400 && (err as any).status < 600 ? (err as any).status : 500));
const call = async (method: string, p: string, user: string, body?: any) => { const r = await app.request(p, { method, headers: { "x-user": user, "content-type": "application/json" }, body: body !== undefined ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; };
const realFetch = globalThis.fetch;

test("quantiles interpolate; an empty series is null, never zero", () => {
  assert.equal(quantile([], 0.5), null);
  assert.equal(quantile([4], 0.9), 4);
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9.1);
});

test("the demo's metrics: realisation, coverage, registers, and a period that is always stated", async () => {
  const r = await call("GET", "/metrics?days=1", "a.uditor");
  assert.equal(r.status, 200); assert.equal(r.body.period_days, 7, "the period is clamped and stated");
  const m = (await call("GET", "/metrics", "a.uditor")).body;
  assert.equal(m.period_days, 90);
  assert.deepEqual(m.decisions.realisation, { realised: 1, in_progress: 1, not_started: 0, not_checkable: 2 });
  assert.deepEqual(m.coverage.legacy_assessments, { current: 1, needed: 6 });
  assert.equal(m.coverage.exit_plans.current, 1);
  assert.equal(m.registers.concentration[0].provider, "Microsoft");
  assert.equal(m.reviews.monthly.length, 6);
  assert.ok(m.conformance.open > 0 && m.conformance.trend.length >= 1);
});

test("reviews: a send-back counts as recycling, and a fast-lane approval is counted as one", async () => {
  const before = (await call("GET", "/metrics", "a.uditor")).body.reviews;
  const fl = db.prepare("SELECT id FROM reviews WHERE code=?").get(seeded.fast_lane_review) as any;
  assert.equal((await call("POST", `/reviews/${fl.id}/decide`, "j.duduka", { outcome: "approved" })).status, 200);
  const intranet = (db.prepare("SELECT id FROM elements WHERE name='Intranet' AND type='application'").get() as any).id;
  const r = await call("POST", "/reviews", "t.nguyen", { type: "design", title: "Metrics: recycled", application_id: intranet, risk_tier: "medium", summary: "s", design_md: "## Design\n\nx" });
  assert.equal((await call("POST", `/reviews/${r.body.id}/decide`, "j.duduka", { outcome: "changes_requested", rationale: "Add the data section." })).status, 200);
  assert.equal((await call("POST", `/reviews/${r.body.id}/resubmit`, "t.nguyen", { note: "Added." })).status, 200);
  assert.equal((await call("POST", `/reviews/${r.body.id}/decide`, "j.duduka", { outcome: "rejected", rationale: "Out of scope." })).status, 200);
  const after = (await call("GET", "/metrics", "a.uditor")).body.reviews;
  assert.equal(after.decided, before.decided + 2);
  assert.equal(after.fast_lane.via_fast_lane, before.fast_lane.via_fast_lane + 1);
  assert.ok(after.recycle_rate > 0, JSON.stringify(after));
  assert.ok(after.lead_time_days.n >= 2 && after.lead_time_days.median !== null);
});

test("a board pack: a chair or secretary prepares it; it is signed, chained, verifiable and read like the evidence pack", async () => {
  for (const u of ["ops.admin", "a.uditor", "s.patel", "m.hughes"]) assert.equal((await call("POST", "/board-packs", u, { days: 90 })).status, 403, u);
  const r = await call("POST", "/board-packs", "a.okafor", { days: 90, title: "Design Authority — October", narrative_md: "Two reviews were decided; one in the fast lane.", narrative_origin: "ai_assisted" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const p = await call("GET", `/board-packs/${r.body.hash}`, "a.uditor");
  assert.equal(p.status, 200);
  assert.equal(p.body.kind, "board_pack"); assert.equal(p.body.title, "Design Authority — October");
  assert.equal(p.body.narrative.origin, "ai_assisted"); assert.equal(p.body.narrative.author, "a.okafor");
  assert.ok(p.body.metrics.reviews && p.body.roadmap.counts && Array.isArray(p.body.registers.exit_plans_due));
  assert.match(p.body.disclaimer, /does not assert compliance/);
  const v = await call("GET", `/evidence-pack/verify?hash=${r.body.hash}`, "a.uditor");
  assert.equal(v.body.hash_ok, true); assert.equal(v.body.signature_ok, true); assert.equal(v.body.chain_ok, true);
  const list = await call("GET", "/board-packs", "a.uditor");
  assert.ok(list.body.some((x: any) => x.hash === r.body.hash && x.narrative_origin === "ai_assisted" && x.created_by === "a.okafor"));
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action='board_pack:create'").get());
  // tampering with the persisted pack is detected
  const file = path.join(DATA_DIR, "evidence-packs", `${r.body.hash}.json`);
  const blob = JSON.parse(fs.readFileSync(file, "utf8")); blob.title = "Something else"; fs.writeFileSync(file, JSON.stringify(blob));
  assert.equal((await call("GET", `/evidence-pack/verify?hash=${r.body.hash}`, "a.uditor")).body.hash_ok, false);
  assert.equal((await call("GET", "/board-packs/0000", "a.uditor")).status, 404);
});

test("the narrative draft is optional, the preparer's to submit, and rests on the figures", async () => {
  assert.equal((await call("POST", "/board-packs/draft-narrative", "j.duduka", { days: 90 })).status, 409, "off by default");
  assert.equal((await call("POST", "/board-packs/draft-narrative", "s.patel", { days: 90 })).status, 403);
  await call("POST", "/settings", "ops.admin", { ai_providers: { mistral: { api_key: "test-key" } }, ai_features: { draft_board_narrative: { enabled: true, provider: "mistral", model: "m" } } });
  let sent: any = null;
  globalThis.fetch = (async (_u: any, init: any) => { sent = JSON.parse(init.body); return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ narrative_md: "Reviews decided: 3." }) } }] }), text: async () => "" } as any; }) as any;
  try {
    const r = await call("POST", "/board-packs/draft-narrative", "j.duduka", { days: 90 });
    assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.origin, "ai"); assert.equal(r.body.narrative_md, "Reviews decided: 3.");
    const facts = JSON.parse(sent.messages[1].content);
    assert.ok(facts.reviews && facts.coverage && !("trend" in facts.conformance), "the figures, without the raw trend series");
    assert.equal((db.prepare("SELECT count(*) n FROM board_packs").get() as any).n, 1, "a draft stores nothing");
  } finally { globalThis.fetch = realFetch; }
});
