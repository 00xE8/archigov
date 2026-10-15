import { ZodError } from "zod";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { logger } from "hono/logger";
import fs from "node:fs";
import path from "node:path";
import { migrate, DATA_DIR, backupNow, getSetting, backfillAuditChain } from "./db.js";
import { api } from "./routes.js";
import { seedDemo } from "./seed.js";
import { evaluateAll } from "./rules.js";
import { backfillHashes } from "./model.js";
import { syncAll, collectIntervalMinutes } from "./sync.js";
import { ensureSigningKeys } from "./evidence-pack.js";
import { authMode, entraConfigured } from "./auth/entra.js";
import { migrateLegacyRoles } from "./auth/users.js";
import { seedBoards } from "./boards/seed.js";

await migrate();
backfillHashes();
// audit rows written before the hash chain existed are chained once; evidence packs are signed with a per-instance key
const chained = backfillAuditChain();
if (chained) console.log(`audit chain: hashed ${chained} pre-existing rows`);
if (ensureSigningKeys().created) console.log(`evidence signing key created under ${DATA_DIR}/keys`);
if (authMode() === "entra" && !entraConfigured()) console.error("AUTH_MODE=entra but ENTRA_TENANT_ID, ENTRA_CLIENT_ID or APP_BASE_URL is missing: nobody will be able to sign in");
console.log(`auth mode: ${authMode()}`);

// First boot of an empty database: load the demo estate unless told not to.
if (process.env.SEED_DEMO !== "false" && !getSetting("demo.loaded")) {
  const r = seedDemo("bootstrap");
  if (!(r as any).skipped) console.log("Loaded demo tenant:", JSON.stringify((r as any).ingest));
}
// users carried over from the old `roles.<user>` settings, then the default boards (and the demo members when the demo is loaded)
const legacyUsers = migrateLegacyRoles();
if (legacyUsers) console.log(`users: migrated ${legacyUsers} legacy role setting(s)`);
console.log("boards:", JSON.stringify(seedBoards("bootstrap")));

const app = new Hono();
app.use("*", logger((s) => { if (!s.includes("/assets/")) console.log(s); }));
app.route("/api", api);
app.onError((err, c) => {
  // a request that fails validation is the caller's problem, not an outage
  if (err instanceof ZodError) return c.json({ error: "invalid_request", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, 400);
  const status = (err as any)?.status;
  if (typeof status === "number" && status >= 400 && status < 600) return c.json({ error: err.message }, status as 400);
  console.error(err); return c.json({ error: err.message }, 500);
});

// static UI (built by web/) — resolved relative to this file so it works from dist/ and from tsx
const here = path.dirname(new URL(import.meta.url).pathname);
const candidates = [path.resolve(here, "../public"), path.resolve(here, "../../web/dist")];
const publicDir = candidates.find((p) => fs.existsSync(path.join(p, "index.html")));
if (publicDir) {
  const rel = path.relative(process.cwd(), publicDir);
  app.use("/*", serveStatic({ root: rel }));
  app.get("*", (c) => c.html(fs.readFileSync(path.join(publicDir, "index.html"), "utf8")));
} else {
  app.get("/", (c) => c.text("archigov API is running. Build the web UI (npm run build in web/) to serve it from here."));
}

// nightly backup, keep the last 14
setInterval(() => {
  try {
    backupNow();
    const dir = path.join(DATA_DIR, "backups");
    const files = fs.readdirSync(dir).filter((f) => f.startsWith("backup-")).sort();
    for (const f of files.slice(0, Math.max(0, files.length - 14))) fs.unlinkSync(path.join(dir, f));
  } catch (e) { console.error("backup failed", e); }
}, 24 * 3600 * 1000).unref();

// re-evaluate conformance every hour so exceptions/conditions expire on time
setInterval(() => { try { evaluateAll("scheduler"); } catch (e) { console.error(e); } }, 3600 * 1000).unref();

// continuous conformance on the deployed side: re-collect every configured source (then evaluate) on the
// `collect_interval_minutes` setting. Re-read each cycle so a settings change takes effect; never runs on boot.
const scheduleCollection = () => {
  const t = setTimeout(async () => {
    try { const r = await syncAll("scheduler"); if (r.length) console.log("scheduled collection:", JSON.stringify(r.map((x: any) => ({ source: x.source, ok: x.ok, stats: x.stats, error: x.error })))); }
    catch (e) { console.error("scheduled collection failed", e); }
    scheduleCollection();
  }, collectIntervalMinutes() * 60 * 1000);
  t.unref();
};
scheduleCollection();

const port = Number(process.env.PORT || 8080);
serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, () => {
  console.log(`archigov listening on http://0.0.0.0:${port}  data: ${DATA_DIR}  ui: ${publicDir || "not built"}`);
});

for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => { console.log(`${sig}: checkpointing and exiting`); try { backupNow(); } catch {} process.exit(0); });
