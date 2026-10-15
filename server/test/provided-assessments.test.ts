import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Submitter-provided assessments: the board REQUESTS due diligence (blocking); the submitter PROVIDES it
// (supporting information, recorded by its author, never blocking). Each type carries a template; only the
// author updates a provided assessment, and an update re-affirms it (stale clears after a resubmission).
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "archigov-provided-"));
delete process.env.AUTH_MODE;
const { migrate } = await import("../src/db.js");
await migrate();
const { seedDemo } = await import("../src/seed.js");
seedDemo("test");
const { seedBoards } = await import("../src/boards/seed.js");
seedBoards("test");
const { Hono } = await import("hono");
const { ZodError } = await import("zod");
const { api } = await import("../src/routes.js");
const { db } = await import("../src/db.js");
const app = new Hono();
app.route("/", api);
app.onError((err, c) => err instanceof ZodError ? c.json({ error: "invalid_request", issues: err.issues }, 400) : c.json({ error: err.message }, (err as any).status >= 400 && (err as any).status < 600 ? (err as any).status : 500));
const call = async (method: string, p: string, user: string, body?: any) => {
  const r = await app.request(p, { method, headers: { "x-user": user, "content-type": "application/json" }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const apps = new Map((db.prepare("SELECT id, name FROM elements WHERE type='application'").all() as any[]).map((a) => [a.name, a.id]));
const ctx: Record<string, any> = {};

test("the type catalogue serves a template per type, including impact and scope", async () => {
  const r = await call("GET", "/assessments/types", "a.uditor");
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 9);
  for (const t of r.body) assert.ok(t.template.includes("##"), `${t.type} has a structured template`);
  assert.ok(r.body.some((t: any) => t.type === "impact") && r.body.some((t: any) => t.type === "scope"));
});

test("the submitter provides an assessment; it arrives completed and never blocks", async () => {
  const r = await call("POST", "/reviews", "t.nguyen", { type: "design", title: "Kiosk design", application_id: apps.get("Intranet"), risk_tier: "medium", summary: "s", design_md: "## Design\n\nx\n" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  ctx.review = r.body.id;
  const p = await call("POST", `/reviews/${ctx.review}/assessments/provide`, "t.nguyen", { type: "impact", result: "satisfactory_with_remarks", result_md: "## What changes\n\nKiosks added to reception.\n", reference: "https://dms.example/ia-7" });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  const a = p.body.assessments[0];
  assert.equal(a.provided, true);
  assert.equal(a.status, "completed");
  assert.equal(a.completed_by, "t.nguyen");
  assert.equal(p.body.progress.open_assessments, 0, "a provided assessment never blocks");
  ctx.a = a.id;
});

test("only the submitter provides; only the author updates; a requested result is not editable this way", async () => {
  assert.equal((await call("POST", `/reviews/${ctx.review}/assessments/provide`, "s.patel", { type: "scope", result: "satisfactory", result_md: "not my review……" })).status, 403);
  assert.equal((await call("POST", `/reviews/${ctx.review}/assessments/provide`, "ops.admin", { type: "scope", result: "satisfactory", result_md: "admin cannot either" })).status, 403);
  assert.equal((await call("PUT", `/assessments/${ctx.a}/provided`, "s.patel", { result_md: "rewritten by someone else" })).status, 403);
  const ok = await call("PUT", `/assessments/${ctx.a}/provided`, "t.nguyen", { result: "satisfactory", result_md: "## What changes\n\nKiosks added; scope now excludes wards.\n" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  // a board-requested assessment's recorded result stands: the provided-update path refuses it
  const req = await call("POST", `/reviews/${ctx.review}/assessments`, "m.hughes", { type: "security", assigned_to: "t.nguyen" });
  assert.equal(req.status, 200, JSON.stringify(req.body));
  const reqId = req.body.assessments.find((x: any) => !x.provided).id;
  await call("POST", `/assessments/${reqId}/result`, "t.nguyen", { result: "satisfactory", result_md: "Controls reviewed; fine." });
  assert.equal((await call("PUT", `/assessments/${reqId}/provided`, "t.nguyen", { result_md: "trying to rewrite the record" })).status, 409);
});

test("a resubmission marks it stale; the author's update re-affirms it", async () => {
  await call("POST", `/reviews/${ctx.review}/comment`, "m.hughes", { body: "please resubmit with ward detail" });
  const back = await call("POST", `/reviews/${ctx.review}/decide`, "j.duduka", { outcome: "changes_requested", rationale: "ward kiosks missing from the design" });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  const re = await call("POST", `/reviews/${ctx.review}/resubmit`, "t.nguyen", { design_md: "## Design\n\nx and wards\n" });
  assert.equal(re.status, 200, JSON.stringify(re.body));
  const r1 = await call("GET", `/reviews/${ctx.review}`, "a.uditor");
  const mine = r1.body.assessments.find((x: any) => x.id === ctx.a);
  assert.equal(mine.stale, true, "provided result is stale after resubmission");
  await call("PUT", `/assessments/${ctx.a}/provided`, "t.nguyen", { result_md: "## What changes\n\nIncludes ward kiosks now.\n" });
  const r2 = await call("GET", `/reviews/${ctx.review}`, "a.uditor");
  assert.equal(r2.body.assessments.find((x: any) => x.id === ctx.a).stale, false, "an update re-affirms it");
});
