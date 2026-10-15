import { Hono } from "hono";
import { z } from "zod";
import { actorOf } from "../http.js";
import { currentPrincipal } from "../auth/context.js";
import { forbidden } from "../auth/middleware.js";
import { governanceMetrics } from "../metrics.js";
import { buildBoardPack, boardPacks } from "../boardpack.js";
import { readPack } from "../evidence-pack.js";
import { draftBoardNarrative } from "../ai.js";

/**
 * Governance metrics (read: everyone who reads the model) and board packs: signed snapshots a chair or secretary
 * prepares (POST, seat-checked here), read like the evidence pack (`export_evidence`), verified with
 * GET /evidence-pack/verify?hash=.
 */
export const metricsRoutes = new Hono();
const days = (c: any) => { const n = Number(c.req.query("days")); return Number.isFinite(n) && n > 0 ? n : 90; };
/** Chairs and secretaries prepare board packs; the platform admin and the auditor do not. */
const preparesPacks = () => { const p = currentPrincipal(); return !!p && p.boards.some((b) => b.role === "chair" || b.role === "secretary"); };

metricsRoutes.get("/metrics", (c) => c.json(governanceMetrics({ days: days(c) })));
metricsRoutes.get("/board-packs", (c) => c.json(boardPacks()));
metricsRoutes.post("/board-packs/draft-narrative", async (c) => {
  if (!preparesPacks()) return forbidden(c, "manage_board", currentPrincipal(), "only a board's chair or secretary prepares a board pack");
  const b = z.object({ days: z.number().int().min(7).max(730).optional() }).parse(await c.req.json().catch(() => ({})));
  try { return c.json(await draftBoardNarrative(governanceMetrics({ days: b.days }))); }
  catch (e: any) { return c.json({ error: String(e.message || e).slice(0, 300) }, /not enabled/i.test(String(e.message)) ? 409 : e.status || 502); }
});
metricsRoutes.post("/board-packs", async (c) => {
  if (!preparesPacks()) return forbidden(c, "manage_board", currentPrincipal(), "only a board's chair or secretary prepares a board pack");
  const b = z.object({ days: z.number().int().min(7).max(730).optional(), title: z.string().max(200).optional(), board_id: z.string().nullable().optional(),
    narrative_md: z.string().max(20000).nullable().optional(), narrative_origin: z.enum(["human", "ai_assisted"]).optional() }).parse(await c.req.json().catch(() => ({})));
  return c.json(buildBoardPack(b, actorOf(c)));
});
metricsRoutes.get("/board-packs/:hash", (c) => {
  const p = readPack(c.req.param("hash"));
  if (!p || p.kind !== "board_pack") return c.json({ error: "not found" }, 404);
  if (c.req.query("download")) { c.header("Content-Disposition", `attachment; filename="archigov-board-pack-${p.hash.slice(0, 12)}.json"`); }
  return c.json(p);
});
