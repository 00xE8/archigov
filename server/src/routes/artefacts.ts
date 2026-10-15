import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db.js";
import { actorOf, fnd } from "../http.js";
import { lastRuleErrors } from "../rules.js";
import { KINDS, isKind, listArtefacts, kindCounts, artefactById, createArtefact, updateArtefact, retireArtefact, verifyArtefact, preReviewArtefact, dryRunArtefact, importArtefacts, type ArtefactInput } from "../artefacts.js";
import { importArtefactsCsv, csvTemplate } from "../importers/csv.js";
import { draftRule, suggestControlReferences } from "../ai.js";

/**
 * /artefacts — the governance catalogue (standards, principles, patterns, policies) behind one set of routes.
 * The older /standards routes remain as aliases over the same table (see routes/standards.ts).
 */
export const artefacts = new Hono();

const Kind = z.enum(["standard", "principle", "pattern", "policy"]);
export const ArtefactIn = z.object({
  kind: Kind.optional(), code: z.string().optional(), title: z.string().min(1), category: z.string().min(1), statement: z.string().min(1), rationale: z.string().nullable().optional(),
  status: z.string().default("adopt"), severity: z.string().default("medium"), rule: z.any().nullable().optional(), owner: z.string().optional(), control_refs: z.array(z.string()).default([]),
  enforcement: z.string().nullable().optional(), context: z.string().nullable().optional(), solution: z.string().nullable().optional(), applicability: z.string().nullable().optional(),
});

const fail = (c: any, e: any) => c.json({ error: String(e.message || e) }, e.status || 500);

artefacts.get("/artefacts/kinds", (c) => c.json(kindCounts()));
artefacts.get("/artefacts", (c) => {
  const kind = c.req.query("kind") || null;
  if (kind && !isKind(kind)) return c.json({ error: `kind must be one of ${KINDS.map((k) => k.kind).join(", ")}` }, 400);
  return c.json(listArtefacts({ kind, lifecycle: c.req.query("lifecycle") || null, q: c.req.query("q") || null }));
});
artefacts.get("/artefacts/:id/preview", (c) => { try { return c.json(preReviewArtefact(c.req.param("id"))); } catch (e: any) { return fail(c, e); } });
artefacts.get("/artefacts/:id/dry-run", (c) => { try { return c.json(dryRunArtefact(c.req.param("id"))); } catch (e: any) { return fail(c, e); } });
artefacts.get("/artefacts/:id", (c) => {
  const a = artefactById(c.req.param("id")); if (!a) return c.json({ error: "not found" }, 404);
  const findings = db.prepare("SELECT f.*, e.name element_name, ap.name application_name FROM findings f LEFT JOIN elements e ON e.id=f.element_id LEFT JOIN elements ap ON ap.id=f.application_id WHERE f.standard_id=? AND f.status<>'resolved'").all(a.id).map(fnd);
  const exceptions = db.prepare("SELECT e.*, ap.name application_name FROM exceptions e LEFT JOIN elements ap ON ap.id=e.application_id WHERE e.standard_id=?").all(a.id);
  return c.json({ ...a, findings, exceptions, rule_error: lastRuleErrors()[a.code] || null });
});
// AI drafting for the editor — generate→verify: the response carries validation and a dry run, a human saves, a board adopts.
const aiFail = (c: any, e: any) => c.json({ error: String(e.message || e).slice(0, 300) }, /not enabled/i.test(String(e.message)) ? 409 : e.status || 502);
const DraftIn = z.object({ kind: Kind.default("standard"), title: z.string().min(1), statement: z.string().min(1), category: z.string().optional() });
artefacts.post("/artefacts/draft-rule", async (c) => {
  try { return c.json(await draftRule(DraftIn.parse(await c.req.json()))); } catch (e: any) { return aiFail(c, e); }
});
artefacts.post("/artefacts/suggest-references", async (c) => {
  try { return c.json(await suggestControlReferences(DraftIn.parse(await c.req.json()))); } catch (e: any) { return aiFail(c, e); }
});
// A new artefact is a draft until a review adopts it; `lifecycle: "adopted"` is accepted for administrative bootstrap (packs, seeds, migrations of an existing catalogue).
artefacts.post("/artefacts", async (c) => {
  try {
    const raw = await c.req.json(); const b = ArtefactIn.parse(raw);
    return c.json(createArtefact(b as ArtefactInput, actorOf(c), { lifecycle: raw?.lifecycle === "adopted" ? "adopted" : "draft" }));
  } catch (e: any) { return fail(c, e); }
});
artefacts.put("/artefacts/:id", async (c) => {
  try { const b = ArtefactIn.partial().parse(await c.req.json()); return c.json(updateArtefact(c.req.param("id"), b as Partial<ArtefactInput>, actorOf(c))); } catch (e: any) { return fail(c, e); }
});
artefacts.post("/artefacts/:id/retire", (c) => { try { return c.json(retireArtefact(c.req.param("id"), actorOf(c))); } catch (e: any) { return fail(c, e); } });
artefacts.post("/artefacts/:id/verify", async (c) => { const body = await c.req.json().catch(() => ({})); try { verifyArtefact(c.req.param("id"), body.verified !== false, actorOf(c)); return c.json({ ok: true }); } catch (e: any) { return fail(c, e); } });

// Bulk import of artefacts as drafts. (The generic /import/csv and /import/templates/csv routes live in the
// integrations module; these artefact-specific routes sit beside them.)
artefacts.post("/import/artefacts", async (c) => {
  const body = await c.req.json().catch(() => null);
  const items = Array.isArray(body) ? body : Array.isArray(body?.items) ? body.items : null;
  if (!items) return c.json({ error: "send a JSON array of artefacts (or { items: [...] })" }, 400);
  return c.json(importArtefacts(items, actorOf(c), "json"));
});
artefacts.post("/import/artefacts/csv", async (c) => {
  const body = await c.req.json().catch(() => null);
  const csv = typeof body?.csv === "string" ? body.csv : null;
  if (!csv) return c.json({ error: "send { csv: '<text>' }" }, 400);
  try { return c.json(importArtefactsCsv(csv, actorOf(c), body.file)); } catch (e: any) { return fail(c, e); }
});
artefacts.get("/import/artefacts/template.csv", (c) => { c.header("Content-Type", "text/csv; charset=utf-8"); c.header("Content-Disposition", 'attachment; filename="archigov-artefacts-template.csv"'); return c.body(csvTemplate("artefacts")); });
