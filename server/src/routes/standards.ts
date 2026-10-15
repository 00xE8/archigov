import { Hono } from "hono";
import { db } from "../db.js";
import { lastRuleErrors } from "../rules.js";
import { listPacks, getPack, importPack } from "../packs.js";
import { actorOf, fnd } from "../http.js";
import { listArtefacts, artefactById, createArtefact, updateArtefact, verifyArtefact, type ArtefactInput } from "../artefacts.js";
import { ArtefactIn } from "./artefacts.js";

/**
 * /standards — compatibility aliases over the governance catalogue (see routes/artefacts.ts). GET /standards returns
 * every kind; packs live here because the first-run flow and the smoke scripts call /standards/packs.
 */
export const standards = new Hono();
const fail = (c: any, e: any) => c.json({ error: String(e.message || e) }, e.status || 500);

standards.get("/standards", (c) => c.json(listArtefacts({ kind: c.req.query("kind") || null, lifecycle: c.req.query("lifecycle") || null, q: c.req.query("q") || null })));
// Packs: importable sets of artefacts (control references only, never control-body text). Registered before /standards/:id.
standards.get("/standards/packs", (c) => c.json(listPacks()));
standards.post("/standards/packs/:id/import", (c) => {
  const pack = getPack(c.req.param("id")); if (!pack) return c.json({ error: "pack not found" }, 404);
  return c.json(importPack(pack, actorOf(c)));
});
standards.get("/standards/:id", (c) => {
  const a = artefactById(c.req.param("id")); if (!a) return c.json({ error: "not found" }, 404);
  const findings = db.prepare("SELECT f.*, e.name element_name, ap.name application_name FROM findings f LEFT JOIN elements e ON e.id=f.element_id LEFT JOIN elements ap ON ap.id=f.application_id WHERE f.standard_id=? AND f.status<>'resolved'").all(a.id).map(fnd);
  const exceptions = db.prepare("SELECT e.*, ap.name application_name FROM exceptions e LEFT JOIN elements ap ON ap.id=e.application_id WHERE e.standard_id=?").all(a.id);
  return c.json({ ...a, findings, exceptions, rule_error: lastRuleErrors()[a.code] || null });
});
// A new artefact is a draft until a review adopts it; `lifecycle: "adopted"` is accepted for administrative bootstrap.
standards.post("/standards", async (c) => {
  try {
    const raw = await c.req.json(); const b = ArtefactIn.parse(raw);
    return c.json(createArtefact(b as ArtefactInput, actorOf(c), { lifecycle: raw?.lifecycle === "adopted" ? "adopted" : "draft" }));
  } catch (e: any) { return fail(c, e); }
});
standards.put("/standards/:id", async (c) => {
  try { const b = ArtefactIn.partial().parse(await c.req.json()); return c.json(updateArtefact(c.req.param("id"), b as Partial<ArtefactInput>, actorOf(c))); } catch (e: any) { return fail(c, e); }
});
standards.post("/standards/:id/verify", async (c) => { const body = await c.req.json().catch(() => ({})); try { verifyArtefact(c.req.param("id"), body.verified !== false, actorOf(c)); return c.json({ ok: true }); } catch (e: any) { return fail(c, e); } });
