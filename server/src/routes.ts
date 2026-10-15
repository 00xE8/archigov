import { Hono } from "hono";
import { authMiddleware } from "./auth/middleware.js";
import { auth } from "./routes/auth.js";
import { system } from "./routes/system.js";
import { applications } from "./routes/applications.js";
import { standards } from "./routes/standards.js";
import { decisions } from "./routes/decisions.js";
import { reviews } from "./routes/reviews.js";
import { conformance } from "./routes/conformance.js";
import { sources } from "./routes/sources.js";
import { backlog } from "./routes/backlog.js";
import { integrations } from "./routes/integrations.js";
import { exportsRoutes } from "./routes/exports.js";
import { users } from "./routes/users.js";
import { boards } from "./routes/boards.js";
import { artefacts } from "./routes/artefacts.js";
import { sessions } from "./routes/sessions.js";
import { me } from "./routes/me.js";
import { registers } from "./routes/registers.js";
import { roadmapRoutes } from "./routes/roadmap.js";
import { metricsRoutes } from "./routes/metrics.js";

/**
 * /api — one Hono app assembled from domain modules under ./routes/. Each module owns a prefix family
 * (there is no overlap between modules), and inside a module static paths are registered before
 * parameterised ones (e.g. /standards/packs before /standards/:id). Shared helpers live in ./http.ts.
 * The auth middleware runs first for every request: it resolves the principal and gates by capability
 * (see auth/roles.ts); the modules only ever see allowed calls.
 */
export const api = new Hono();
api.use("*", authMiddleware);
api.route("/", auth);
api.route("/", system);
api.route("/", applications);
api.route("/", standards);
api.route("/", decisions);
api.route("/", reviews);
api.route("/", conformance);
api.route("/", sources);
api.route("/", backlog);
api.route("/", integrations);
api.route("/", exportsRoutes);
api.route("/", users);
api.route("/", boards);
api.route("/", artefacts);
api.route("/", sessions);
api.route("/", me);
api.route("/", registers);
api.route("/", roadmapRoutes);
api.route("/", metricsRoutes);
