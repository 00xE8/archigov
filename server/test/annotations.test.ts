import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Design annotations: notes pinned to a generated ArchiMate view or one element in it. Writing takes the
// `comment` capability (authors and acting seats; never the auditor or the platform admin — segregation of
// duties), only the author edits or deletes their own note, every write lands in the audit chain, and the
// Design tab's payload carries the active notes.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "archigov-annotations-"));
delete process.env.AUTH_MODE;
const { db, migrate } = await import("../src/db.js");
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
  return { status: r.status, body: await r.json().catch(() => null) };
};

const appId = (db.prepare("SELECT id FROM elements WHERE type='application' AND name='PatientFlow'").get() as any).id;
const views = (await call("GET", `/applications/${appId}/views`, "a.uditor")).body;
const deploy = views.views[0];
const resourceEl = deploy.nodes.find((n: any) => n.parent && n.elementId)!.elementId;
const ctx: Record<string, any> = {};

test("an author annotates an element and a view; the payload and audit carry it", async () => {
  const r = await call("POST", `/applications/${appId}/annotations`, "s.patel", { view_id: deploy.id, element_id: resourceEl, text: "Check the TLS baseline here." });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.author, "s.patel");
  ctx.ann = r.body.id;
  const v = await call("POST", `/applications/${appId}/annotations`, "s.patel", { view_id: deploy.id, text: "View-level note." });
  assert.equal(v.status, 200);
  assert.equal(v.body.element_id, null);
  const after = (await call("GET", `/applications/${appId}/views`, "a.uditor")).body;
  assert.equal(after.annotations.length, 2);
  assert.ok(after.annotations[0].author_name, "author resolves to a display name");
  const audit = db.prepare("SELECT count(*) c FROM audit_log WHERE action='annotation:add' AND entity_id=?").get(appId) as any;
  assert.equal(audit.c, 2);
});

test("the auditor and the platform admin change nothing; only the author deletes", async () => {
  assert.equal((await call("POST", `/applications/${appId}/annotations`, "a.uditor", { view_id: deploy.id, text: "nope" })).status, 403);
  assert.equal((await call("POST", `/applications/${appId}/annotations`, "ops.admin", { view_id: deploy.id, text: "nope" })).status, 403);
  assert.equal((await call("DELETE", `/annotations/${ctx.ann}`, "m.hughes")).status, 403, "another seat cannot delete someone else's note");
  assert.equal((await call("PUT", `/annotations/${ctx.ann}`, "m.hughes", { text: "rewrite" })).status, 403);
  assert.equal((await call("PUT", `/annotations/${ctx.ann}`, "s.patel", { text: "Check the TLS baseline before adoption." })).status, 200);
  assert.equal((await call("DELETE", `/annotations/${ctx.ann}`, "s.patel")).status, 200);
  const after = (await call("GET", `/applications/${appId}/views`, "a.uditor")).body;
  assert.equal(after.annotations.length, 1, "soft-deleted notes leave the payload");
  assert.equal((await call("DELETE", `/annotations/${ctx.ann}`, "s.patel")).status, 404, "already deleted");
});

test("validation: unknown view, element outside the view, empty and oversized text", async () => {
  assert.equal((await call("POST", `/applications/${appId}/annotations`, "s.patel", { view_id: "nope", text: "xxxx" })).status, 400);
  assert.equal((await call("POST", `/applications/${appId}/annotations`, "s.patel", { view_id: deploy.id, element_id: "nope", text: "xxxx" })).status, 400);
  assert.equal((await call("POST", `/applications/${appId}/annotations`, "s.patel", { view_id: deploy.id, text: "" })).status, 400);
  assert.equal((await call("POST", `/applications/${appId}/annotations`, "s.patel", { view_id: deploy.id, text: "x".repeat(2001) })).status, 400);
  assert.equal((await call("POST", `/applications/nope/annotations`, "s.patel", { view_id: deploy.id, text: "xxxx" })).status, 404);
});
