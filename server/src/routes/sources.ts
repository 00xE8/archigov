import { Hono } from "hono";
import { z } from "zod";
import { db, j } from "../db.js";
import { evaluateAll } from "../rules.js";
import { seedDemo } from "../seed.js";
import { importEvidence } from "../evidence.js";
import { syncAzure, syncDemo, perturbDemo, sourcesOverview } from "../sync.js";
import { actorOf } from "../http.js";

export const sources = new Hono();

// ---------- sources / sync ----------
/** Rows plus the kinds configured by environment (or fixtures) that have never synced; config is the non-secret summary. */
sources.get("/sources", (c) => c.json(sourcesOverview()));
sources.post("/sources/azure/sync", async (c) => { const r = await syncAzure(actorOf(c)); return c.json(r, r.ok ? 200 : 502); });
sources.post("/sources/demo/load", (c) => c.json(seedDemo(actorOf(c))));
sources.post("/sources/demo/resync", async (c) => {
  // re-collect the demo estate (same data unless perturbed) to show that verification survives unchanged content
  const r = await syncDemo(actorOf(c)); if (!r.ok && r.error === "no demo source") return c.json({ error: r.error }, 400);
  return c.json(r);
});
/** Demo-only: change a demo resource's properties and re-collect, so hashes move and verification drops like real drift. */
sources.post("/sources/demo/perturb", async (c) => {
  const b = z.object({ resourceName: z.string().optional(), resourceId: z.string().optional(), props: z.record(z.unknown()) }).parse(await c.req.json());
  try { return c.json(await perturbDemo(actorOf(c), b, b.props)); }
  catch (e: any) { return c.json({ error: e.message }, e.status || 500); }
});

// ---------- imported evidence (Defender for Cloud / Azure Policy / manual) ----------
sources.get("/evidence", (c) => {
  const q = c.req.query();
  const where: string[] = []; const params: any[] = [];
  const eq = (col: string, v?: string) => { if (v) { where.push(`${col}=?`); params.push(v); } };
  eq("ev.source", q.source); eq("ev.control", q.control); eq("ev.state", q.state); eq("ev.resource_id", q.resource_id);
  if (q.q) { const like = `%${q.q.toLowerCase()}%`; where.push("(lower(e.name) LIKE ? OR lower(ev.control) LIKE ? OR lower(a.name) LIKE ?)"); params.push(like, like, like); }
  const rows = db.prepare(`SELECT ev.*, e.name resource_name, e.subtype resource_type, a.id application_id, a.name application_name FROM evidence ev
    JOIN elements e ON e.id=ev.resource_id
    LEFT JOIN relations rel ON rel.from_id=e.id AND rel.type='belongs_to' AND rel.deleted_at IS NULL LEFT JOIN elements a ON a.id=rel.to_id
    ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ev.source, ev.control, e.name`).all(...params) as any[];
  return c.json(rows.map(({ detail_json, ...r }) => ({ ...r, detail: j(detail_json, {}) })));
});
/** What each source has told us, in one place: counts by state plus when it was last imported and what it could not place. */
sources.get("/evidence/summary", (c) => {
  const total = (db.prepare("SELECT count(*) c FROM evidence").get() as any).c;
  const srcs = (db.prepare(`SELECT source, count(DISTINCT control) controls, count(DISTINCT resource_id) resources,
      sum(state='pass') pass, sum(state='fail') fail, sum(state='unknown') unknown, max(updated_at) last_updated FROM evidence GROUP BY source ORDER BY source`).all() as any[]).map((s) => {
    const last = db.prepare("SELECT at, data_json FROM audit_log WHERE action='import_evidence' AND data_json LIKE ? ORDER BY at DESC LIMIT 1").get(`%"source":"${s.source}"%`) as any;
    return { source: s.source, controls: s.controls, resources: s.resources, pass: s.pass, fail: s.fail, unknown: s.unknown,
      last_import: last?.at || s.last_updated, last_unmatched: j(last?.data_json, {}).unmatched_refs || [] };
  });
  return c.json({ total, sources: srcs });
});
const EvidenceImportIn = z.object({ source: z.enum(["defender", "azure_policy", "manual"]), items: z.array(z.object({
  resourceId: z.string().optional(), resourceRef: z.string().optional(), resourceName: z.string().optional(), control: z.string(), state: z.enum(["pass", "fail", "unknown"]),
  observed_at: z.string().optional(), severity: z.string().nullable().optional(), detail: z.record(z.unknown()).optional() })) });
sources.post("/evidence/import", async (c) => {
  const b = EvidenceImportIn.parse(await c.req.json());
  const stats = importEvidence(b.source, b.items, actorOf(c));
  const evaluate = evaluateAll(actorOf(c));
  return c.json({ ...stats, evaluate });
});
