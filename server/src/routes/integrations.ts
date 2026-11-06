import { Hono } from "hono";
import { z } from "zod";
import { timingSafeEqual } from "node:crypto";
import { actorOf } from "../http.js";
import { testAzure, syncDefender, syncPolicy, syncAdo } from "../sync.js";
import { testAdo, handleAdoHook } from "../ado/sync.js";
import { importResourcesCsv, importRelationsCsv, importArtefactsCsv, csvTemplate } from "../importers/csv.js";
import { importArchimate } from "../importers/archimate.js";
import { writebackStatus, writebackSettings, saveWritebackSettings, sweep, removeStageTags, forgetFailures, testWriteAccess, TAG_PREFIX, type WritebackSettings } from "../writeback.js";
import { audit } from "../db.js";

/** Azure (Resource Graph test, Defender, Azure Policy), Azure DevOps (test, backfill, service hook) and the file importers. */
export const integrations = new Hono();
export { integrations as integrationsRoutes };

const fail = (c: any, e: any, fallback = 500) => c.json({ error: String(e?.message || e) }, e?.status || fallback);

// ---------- Azure ----------
integrations.post("/sources/azure/test", async (c) => c.json(await testAzure()));
integrations.post("/sources/defender/sync", async (c) => { const r = await syncDefender(actorOf(c)); return c.json(r, r.ok ? 200 : 502); });
integrations.post("/sources/policy/sync", async (c) => { const r = await syncPolicy(actorOf(c)); return c.json(r, r.ok ? 200 : 502); });

// ---------- Azure DevOps ----------
integrations.post("/sources/ado/test", async (c) => c.json(await testAdo()));
integrations.post("/sources/ado/sync", async (c) => {
  try { const r = await syncAdo(actorOf(c)); return c.json(r, r.ok ? 200 : 502); } catch (e: any) { return fail(c, e); }
});

/**
 * Service-hook receiver. No session: ADO authenticates with the shared secret, sent either as the
 * x-archigov-hook-secret header or as the password of HTTP basic auth (what the ADO subscription UI offers).
 */
const secretOk = (given: string | null) => {
  const expected = process.env.ADO_HOOK_SECRET || "";
  if (!expected || !given) return false;
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
};
integrations.post("/hooks/ado", async (c) => {
  if (!process.env.ADO_HOOK_SECRET) return c.json({ error: "hook not configured: set ADO_HOOK_SECRET" }, 503);
  let given = c.req.header("x-archigov-hook-secret") || null;
  const basic = c.req.header("authorization");
  if (!given && basic?.toLowerCase().startsWith("basic ")) { try { given = Buffer.from(basic.slice(6), "base64").toString("utf8").split(":").slice(1).join(":"); } catch { given = null; } }
  if (!secretOk(given)) return c.json({ error: "unauthorised" }, 401);
  try { const payload = await c.req.json(); return c.json(handleAdoHook(payload, "ado-hook")); } catch (e: any) { return fail(c, e, 400); }
});

// ---------- Azure DevOps write-back ----------
// Off until a platform admin turns it on (every mutation here is unlisted in ROUTE_RULES, so it needs manage_platform);
// the status is readable by anyone who can read, like the other source summaries: it holds no secret.
integrations.get("/sources/ado/writeback", (c) => c.json(writebackStatus()));
const WritebackIn = z.object({ enabled: z.boolean().optional(), link: z.boolean().optional(), stage: z.boolean().optional(), comment: z.boolean().optional(),
  tag_prefix: z.string().optional(), remove_tags: z.boolean().optional() });
integrations.post("/sources/ado/writeback", async (c) => {
  const b = WritebackIn.parse(await c.req.json().catch(() => ({})));
  const before = writebackSettings(), status = writebackStatus();
  if (b.tag_prefix !== undefined && !TAG_PREFIX.test(b.tag_prefix)) return c.json({ error: "tag_prefix is 2 to 20 characters, starts with a letter or digit and ends in : / or - (for example arch:), so archigov's tags stay apart from the team's own" }, 400);
  const next: WritebackSettings = { enabled: b.enabled ?? before.enabled, link: b.link ?? before.link, stage: b.stage ?? before.stage, comment: b.comment ?? before.comment, tag_prefix: b.tag_prefix ?? before.tag_prefix };
  if (next.enabled && !status.available) return c.json({ error: "Azure DevOps is not connected: write-back needs the backlog source it writes to" }, 409);
  if (next.enabled && !next.link && !next.stage && !next.comment) return c.json({ error: "turn on at least one of link, stage and comment, or turn write-back off" }, 400);
  const actor = actorOf(c), turningOff = before.enabled && !next.enabled;
  // Saved first: once it is off no sweep starts, and one in flight stops at its next item, so the clean-up below is
  // not undone behind its back.
  saveWritebackSettings(next);
  audit(actor, next.enabled === before.enabled ? "writeback:update" : next.enabled ? "writeback:enable" : "writeback:disable", "settings", null, { ...next });
  // Turning it off takes the stage tags off (they say what is true now) unless the caller keeps them (remove_tags:
  // false). Already off, remove_tags: true tries again for tags a failed clean-up left behind.
  let cleanup: Awaited<ReturnType<typeof removeStageTags>> | null = null;
  if (!next.enabled && (turningOff ? b.remove_tags !== false : b.remove_tags === true)) cleanup = await removeStageTags(actor);
  if (turningOff) forgetFailures();
  // turning it on (or changing what is shown) writes everything that is already true, so the backlog is not waiting for the next change
  const first = next.enabled ? await sweep({ actor, force: true }) : null;
  return c.json({ ok: true, ...writebackStatus(), ...(cleanup ? { cleanup } : {}), ...(first ? { sweep: { written: first.written, failed: first.failed, unchanged: first.unchanged } } : {}) });
});
integrations.post("/sources/ado/writeback/test", async (c) => { const r = await testWriteAccess(); audit(actorOf(c), "writeback:test", "settings", null, { ok: r.ok }); return c.json(r); });
/** What would be written now, with the saved switches or with the ones in the query (the form's, before saving). Sends nothing. */
integrations.get("/sources/ado/writeback/preview", async (c) => {
  const q = c.req.query(); const flag = (k: string) => (q[k] === undefined ? undefined : q[k] === "1" || q[k] === "true");
  const as: Partial<WritebackSettings> = {};
  for (const k of ["link", "stage", "comment"] as const) { const v = flag(k); if (v !== undefined) as[k] = v; }
  if (q.tag_prefix && TAG_PREFIX.test(q.tag_prefix)) as.tag_prefix = q.tag_prefix;
  return c.json(await sweep({ dry: true, as }));
});
integrations.post("/sources/ado/writeback/run", async (c) => {
  if (!writebackSettings().enabled) return c.json({ error: "write-back is off" }, 409);
  return c.json(await sweep({ actor: actorOf(c), force: true }));
});

// ---------- importers ----------
// kind 'artefacts' (governance catalogue: standards, principles, patterns, policies) delegates to the catalogue importer
const CsvIn = z.object({ kind: z.enum(["resources", "relations", "artefacts"]), csv: z.string().min(1), file: z.string().optional() });
integrations.post("/import/csv", async (c) => {
  const b = CsvIn.parse(await c.req.json());
  try { return c.json(b.kind === "resources" ? importResourcesCsv(b.csv, actorOf(c), b.file) : b.kind === "artefacts" ? importArtefactsCsv(b.csv, actorOf(c), b.file) : importRelationsCsv(b.csv, actorOf(c), b.file)); }
  catch (e: any) { return fail(c, e); }
});
integrations.get("/import/templates/csv", (c) => {
  const q = c.req.query("kind");
  const kind = q === "relations" ? "relations" : q === "artefacts" ? "artefacts" : "resources";
  return c.body(csvTemplate(kind), 200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="archigov-${kind}-template.csv"` });
});
integrations.post("/import/archimate", async (c) => {
  const xml = await c.req.text();
  const file = c.req.query("file") || c.req.header("x-file-name") || undefined;
  try { return c.json(importArchimate(xml, actorOf(c), file)); } catch (e: any) { return fail(c, e); }
});
