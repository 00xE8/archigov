import { Hono } from "hono";
import { z } from "zod";
import { timingSafeEqual } from "node:crypto";
import { actorOf } from "../http.js";
import { testAzure, syncDefender, syncPolicy, syncAdo } from "../sync.js";
import { testAdo, handleAdoHook } from "../ado/sync.js";
import { importResourcesCsv, importRelationsCsv, importArtefactsCsv, csvTemplate } from "../importers/csv.js";
import { importArchimate } from "../importers/archimate.js";

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
