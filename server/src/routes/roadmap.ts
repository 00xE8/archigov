import { Hono } from "hono";
import { getElement } from "../model.js";
import { roadmap } from "../roadmap.js";

/** The architecture roadmap, derived from decisions, planned changes, conditions, lifecycle dates and exceptions. Read-only. */
export const roadmapRoutes = new Hono();
roadmapRoutes.get("/roadmap", (c) => {
  const app = c.req.query("application") || null;
  if (app && getElement(app)?.type !== "application") return c.json({ error: "application not found" }, 404);
  return c.json(roadmap({ application: app }));
});
