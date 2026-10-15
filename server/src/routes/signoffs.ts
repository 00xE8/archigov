import { Hono } from "hono";
import { actorOf } from "../http.js";
import { currentPrincipal } from "../auth/context.js";
import { forbidden } from "../auth/middleware.js";
import { signOffs, signOff, cadenceMonths } from "../signoffs.js";

/** Review dates and periodic sign-offs: read by everyone; signed off by the chair of the owning board (checked in signoffs.ts). */
export const signOffRoutes = new Hono();
signOffRoutes.get("/sign-offs", (c) => c.json({ items: signOffs(currentPrincipal(), { status: c.req.query("status") || null }), cadence_months: { artefact: cadenceMonths("artefact"), decision: cadenceMonths("decision") } }));
signOffRoutes.post("/sign-offs", async (c) => {
  const b = await c.req.json().catch(() => ({}));
  try { return c.json(signOff(currentPrincipal(), { subject_kind: String(b.subject_kind || ""), subject_id: String(b.subject_id || ""), outcome: String(b.outcome || ""), note: b.note ?? null }, actorOf(c))); }
  catch (e: any) { const status = typeof e?.status === "number" ? e.status : 500; if (status === 403) return forbidden(c, "decide_review", currentPrincipal(), e.message); if (status >= 500) throw e; return c.json({ error: e.message }, status); }
});
