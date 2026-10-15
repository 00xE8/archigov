import { Hono } from "hono";
import { db, uid, nowIso, audit } from "../db.js";
import { listElements, hashOf } from "../model.js";
import { draftDecisionFromWorkItem } from "../ai.js";
import { actorOf, wi } from "../http.js";

export const backlog = new Hono();

backlog.get("/work-items", (c) => {
  const apps = new Map(listElements("application").map((a) => [a.id, a.name]));
  const rows = db.prepare("SELECT w.*, s.kind source_kind, d.code decision_code, r.code review_code, r.stage review_stage FROM work_items w LEFT JOIN sources s ON s.id=w.source_id LEFT JOIN decisions d ON d.id=w.decision_id LEFT JOIN reviews r ON r.id=w.review_id ORDER BY w.external_id").all().map(wi);
  return c.json(rows.map((w: any) => ({ ...w, application_name: apps.get(w.application_id) || null })));
});

/**
 * Manually logged potential changes: projects and initiatives that exist before any backlog tool knows them.
 * They live in the same table and pipeline as the ADO feed but under their own Manual source with human origin —
 * visibly logged by a person, never pretending to be derived. Items from a real source stay read-only here.
 */
const MANUAL_TYPES = ["Project", "Initiative", "Change"];
const MANUAL_STATES = ["Proposed", "Active", "Closed", "Removed"];
function manualSource(): string {
  const row = db.prepare("SELECT id FROM sources WHERE kind='manual'").get() as any;
  if (row) return row.id;
  const id = uid();
  db.prepare("INSERT INTO sources(id,kind,name,config_json,status,created_at) VALUES (?,?,?,?,?,?)").run(id, "manual", "Manual · planned changes", "{}", "ok", nowIso());
  return id;
}
const sourceKindOf = (w: any): string | null => (db.prepare("SELECT kind FROM sources WHERE id=?").get(w.source_id) as any)?.kind ?? null;

backlog.post("/work-items", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  if (!MANUAL_TYPES.includes(b.type)) return c.json({ error: `type must be one of: ${MANUAL_TYPES.join(", ")}` }, 400);
  const title = String(b.title || "").trim();
  if (title.length < 3) return c.json({ error: "a title of at least 3 characters is required" }, 400);
  if (b.application_id && !listElements("application").some((a) => a.id === b.application_id)) return c.json({ error: "application not found" }, 404);
  const n = (db.prepare("SELECT max(CAST(substr(external_id, 4) AS INTEGER)) n FROM work_items WHERE external_id LIKE 'PC-%'").get() as any)?.n || 0;
  const external_id = `PC-${String(n + 1).padStart(4, "0")}`;
  const id = uid(), now = nowIso(), description = String(b.description || "").trim();
  db.prepare(`INSERT INTO work_items(id,source_id,external_id,type,title,state,description,tags_json,application_id,content_hash,created_at,changed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, manualSource(), external_id, b.type, title, "Proposed", description, JSON.stringify(Array.isArray(b.tags) ? b.tags.map(String) : []), b.application_id || null, hashOf([title, description]), now, now);
  audit(actorOf(c), "log_change", "work_items", id, { external_id, type: b.type, title, application_id: b.application_id || null });
  return c.json(wi(db.prepare("SELECT w.*, s.kind source_kind FROM work_items w LEFT JOIN sources s ON s.id=w.source_id WHERE w.id=?").get(id)));
});

backlog.put("/work-items/:id", async (c) => {
  const w = db.prepare("SELECT * FROM work_items WHERE id=?").get(c.req.param("id")) as any;
  if (!w) return c.json({ error: "not found" }, 404);
  if (sourceKindOf(w) !== "manual") return c.json({ error: "this item arrived from a backlog source — change it at the source; only manually logged changes are edited here" }, 409);
  const b = await c.req.json().catch(() => ({}));
  const title = b.title !== undefined ? String(b.title).trim() : w.title;
  if (title.length < 3) return c.json({ error: "a title of at least 3 characters is required" }, 400);
  const description = b.description !== undefined ? String(b.description).trim() : w.description;
  const state = b.state !== undefined ? String(b.state) : w.state;
  if (!MANUAL_STATES.includes(state)) return c.json({ error: `state must be one of: ${MANUAL_STATES.join(", ")}` }, 400);
  const application_id = "application_id" in b ? b.application_id || null : w.application_id;
  if (application_id && !listElements("application").some((a) => a.id === application_id)) return c.json({ error: "application not found" }, 404);
  const h = hashOf([title, description]);
  const material = w.approved_hash != null && w.approved_hash !== h;
  // the same changed-after-approval comparison the ADO hook applies: editing an approved item is drift, whoever typed it
  db.prepare("UPDATE work_items SET title=?, description=?, state=?, application_id=?, content_hash=?, changed_at=?, material_change=CASE WHEN approved_hash IS NOT NULL AND approved_hash<>? THEN 1 ELSE material_change END WHERE id=?")
    .run(title, description, state, application_id, h, nowIso(), h, w.id);
  audit(actorOf(c), "work_item_changed", "work_items", w.id, { external_id: w.external_id, manual: true, state, material_change: material });
  return c.json(wi(db.prepare("SELECT w.*, s.kind source_kind FROM work_items w LEFT JOIN sources s ON s.id=w.source_id WHERE w.id=?").get(w.id)));
});
backlog.post("/work-items/:id/link", async (c) => {
  const b = await c.req.json().catch(() => ({})); const id = c.req.param("id");
  if (!db.prepare("SELECT 1 FROM work_items WHERE id=?").get(id)) return c.json({ error: "not found" }, 404);
  if (b.decision_id && !db.prepare("SELECT 1 FROM decisions WHERE id=?").get(b.decision_id)) return c.json({ error: "decision not found" }, 404);
  if (b.review_id && !db.prepare("SELECT 1 FROM reviews WHERE id=?").get(b.review_id)) return c.json({ error: "review not found" }, 404);
  db.prepare("UPDATE work_items SET application_id=COALESCE(?,application_id), decision_id=COALESCE(?,decision_id), review_id=COALESCE(?,review_id) WHERE id=?").run(b.application_id || null, b.decision_id || null, b.review_id || null, id);
  audit(actorOf(c), "link", "work_items", id, { application_id: b.application_id || null, decision_id: b.decision_id || null, review_id: b.review_id || null });
  return c.json(wi(db.prepare("SELECT w.*, d.code decision_code, r.code review_code, r.stage review_stage FROM work_items w LEFT JOIN decisions d ON d.id=w.decision_id LEFT JOIN reviews r ON r.id=w.review_id WHERE w.id=?").get(id)));
});
backlog.post("/work-items/:id/acknowledge-change", (c) => {
  const w = db.prepare("SELECT * FROM work_items WHERE id=?").get(c.req.param("id")) as any;
  db.prepare("UPDATE work_items SET material_change=0, approved_hash=content_hash WHERE id=?").run(w.id);
  audit(actorOf(c), "acknowledge_change", "work_items", w.id); return c.json({ ok: true });
});
backlog.post("/work-items/:id/draft-decision", async (c) => c.json(await draftDecisionFromWorkItem(c.req.param("id"))));
/** Simulate an ADO service hook: a work item changed after its design was approved. */
backlog.post("/work-items/:id/simulate-change", async (c) => {
  const { description } = await c.req.json(); const w = db.prepare("SELECT * FROM work_items WHERE id=?").get(c.req.param("id")) as any;
  const h = hashOf([w.title, description]);
  const material = w.approved_hash != null && w.approved_hash !== h;
  db.prepare("UPDATE work_items SET description=?, content_hash=?, changed_at=?, material_change=CASE WHEN approved_hash IS NOT NULL AND approved_hash<>? THEN 1 ELSE material_change END WHERE id=?").run(description, h, nowIso(), h, w.id);
  audit(actorOf(c), "work_item_changed", "work_items", w.id, { external_id: w.external_id, material_change: material, simulated: true });
  return c.json({ ok: true, material_change: material });
});
