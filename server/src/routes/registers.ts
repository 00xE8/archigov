import { Hono } from "hono";
import { getElement } from "../model.js";
import { actorOf } from "../http.js";
import { legacyRegister, productCatalogue, refreshSnapshot, setResourceLifecycle, resetResourceLifecycle, legacyOf, assessmentsOfApp, recordLegacyAssessment, lifecycleOf, LEGACY_TEMPLATE, LEGACY_RESULTS } from "../lifecycle.js";
import { draftLegacyAssessment } from "../ai.js";

/**
 * Registers derived from the model. The legacy register: lifecycle-tracked components (OS images, runtimes,
 * engines, Kubernetes) against their vendors' support dates, a person's corrections, and the yearly legacy
 * assessment per application (DORA Art. 8(7)). Reads are open; corrections and assessments are an author's act
 * (capability `verify`); refreshing the lifecycle data is the platform admin's (the default for an unlisted mutation).
 */
export const registers = new Hono();
const fail = (c: any, e: any) => { const status = typeof e?.status === "number" ? e.status : 500; if (status >= 500) throw e; return c.json({ error: e.message }, status); };

registers.get("/lifecycle", (c) => c.json(legacyRegister()));
registers.get("/lifecycle/products", (c) => c.json(productCatalogue()));
registers.post("/lifecycle/refresh", async (c) => c.json(await refreshSnapshot(actorOf(c))));

registers.get("/resources/:id/lifecycle", (c) => { const r = getElement(c.req.param("id")); return r && r.type === "resource" ? c.json(lifecycleOf(r)) : c.json({ error: "not found" }, 404); });
registers.put("/resources/:id/lifecycle", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  try { return c.json(setResourceLifecycle(c.req.param("id"), { components: Array.isArray(b.components) ? b.components : [], reason: String(b.reason || "") }, actorOf(c))); } catch (e) { return fail(c, e); }
});
registers.post("/resources/:id/lifecycle/reset", (c) => { try { return c.json(resetResourceLifecycle(c.req.param("id"), actorOf(c))); } catch (e) { return fail(c, e); } });

registers.get("/applications/:id/legacy", (c) => {
  const a = getElement(c.req.param("id")); if (!a || a.type !== "application") return c.json({ error: "not found" }, 404);
  return c.json({ ...legacyOf(a), history: assessmentsOfApp(a.id), template: LEGACY_TEMPLATE, results: LEGACY_RESULTS });
});
registers.post("/applications/:id/legacy-assessments", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  try { return c.json(recordLegacyAssessment(c.req.param("id"), { result: String(b.result || ""), summary_md: String(b.summary_md || ""), reference: b.reference ?? null }, actorOf(c))); } catch (e) { return fail(c, e); }
});
// AI prefill of the assessment summary from the register's facts — nothing stored; 409 when assessment drafting is off.
registers.post("/applications/:id/legacy-assessments/draft", async (c) => {
  try { return c.json(await draftLegacyAssessment(c.req.param("id"))); }
  catch (e: any) { return e?.status === 404 ? c.json({ error: "not found" }, 404) : c.json({ error: String(e.message || e).slice(0, 300) }, /not enabled/i.test(String(e.message)) ? 409 : e.status || 502); }
});
