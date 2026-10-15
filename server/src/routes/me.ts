import { Hono } from "hono";
import { currentPrincipal } from "../auth/context.js";
import { workQueueFor } from "../boards/work.js";

/** What the workflow is waiting on the signed-in principal for; read-only, so the route gate passes it on `read`. */
export const me = new Hono();
me.get("/me/work", (c) => c.json(workQueueFor(currentPrincipal())));
