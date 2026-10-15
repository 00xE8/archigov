import { Hono } from "hono";
import { actorOf } from "../http.js";
import { getElement } from "../model.js";
import { riskRegister, logRisk, updateRisk, architectureDebt, RISK_SEVERITIES, RISK_STATUSES } from "../risks.js";
import { suggestDecisionRisks } from "../ai.js";

/** The risk register (read by everyone; logged by authors; changed by the owner or whoever logged it) and the derived architecture debt. */
export const riskRoutes = new Hono();
const fail = (c: any, e: any) => { const status = typeof e?.status === "number" ? e.status : 500; if (status >= 500) throw e; return c.json({ error: e.message }, status); };
riskRoutes.get("/risks", (c) => c.json({ ...riskRegister({ application: c.req.query("application") || null, decision: c.req.query("decision") || null }), severities: RISK_SEVERITIES, statuses: RISK_STATUSES }));
riskRoutes.post("/risks", async (c) => { try { return c.json(logRisk(await c.req.json().catch(() => ({})), actorOf(c))); } catch (e) { return fail(c, e); } });
riskRoutes.put("/risks/:id", async (c) => { try { return c.json(updateRisk(c.req.param("id"), await c.req.json().catch(() => ({})), actorOf(c))); } catch (e) { return fail(c, e); } });
riskRoutes.get("/debt", (c) => {
  const app = c.req.query("application") || null;
  if (app && getElement(app)?.type !== "application") return c.json({ error: "application not found" }, 404);
  const d = architectureDebt();
  return c.json(app ? { ...d, items: d.items.filter((i: any) => i.application?.id === app), by_application: d.by_application.filter((g: any) => g.application?.id === app) } : d);
});
// AI: the risks a decision accepts, read from its text — nothing stored; 409 when the feature is off
riskRoutes.post("/decisions/:id/suggest-risks", async (c) => {
  try { return c.json(await suggestDecisionRisks(c.req.param("id"))); }
  catch (e: any) { return e?.status === 404 ? c.json({ error: "not found" }, 404) : c.json({ error: String(e.message || e).slice(0, 300) }, /not enabled/i.test(String(e.message)) ? 409 : e.status || 502); }
});
