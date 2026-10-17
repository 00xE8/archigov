import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Routing by application: a rule may name applications or an owner tag; it matches only reviews whose applications it
// all covers, and it is more specific than a kind or category condition — on a scratch database.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "archigov-routing-"));
delete process.env.AUTH_MODE;
const { db, migrate, nowIso } = await import("../src/db.js");
await migrate();
const { routeBoard, applicationOwners } = await import("../src/boards/workflow.js");

const now = nowIso();
const board = (id: string, code: string) => db.prepare("INSERT INTO boards(id,code,name,purpose,created_at) VALUES (?,?,?,?,?)").run(id, code, code, "", now);
const element = (id: string, type: string, tags: Record<string, string> = {}) =>
  db.prepare("INSERT INTO elements(id,type,name,tags_json,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(id, type, id, JSON.stringify(tags), now, now);
const belongs = (res: string, app: string) => db.prepare("INSERT INTO relations(id,from_id,to_id,type,created_at) VALUES (?,?,?,?,?)").run(`${res}>${app}`, res, app, "belongs_to", now);
const rule = (board: string, type: string, o: { kind?: string; category?: string; apps?: string[]; owner?: string; priority?: number } = {}) =>
  db.prepare("INSERT INTO board_routing(id,board_id,review_type,kind,category,priority,application_ids_json,owner) VALUES (?,?,?,?,?,?,?,?)")
    .run(`${board}-${type}-${Math.random()}`, board, type, o.kind ?? null, o.category ?? null, o.priority ?? 100, o.apps ? JSON.stringify(o.apps) : null, o.owner ?? null);

board("b-da", "DA"); board("b-clin", "CLIN"); board("b-plat", "PLAT"); board("b-data", "DATA");
element("app-a", "application"); element("app-b", "application"); element("app-c", "application"); element("app-d", "application");
element("vm-a", "Microsoft.Compute/virtualMachines", { owner: "Clinical-Systems" }); belongs("vm-a", "app-a");
element("sql-b", "Microsoft.Sql/servers", { owner: "clinical-systems" }); belongs("sql-b", "app-b");
element("aks-c", "Microsoft.ContainerService/managedClusters", { owner: "data-platform" }); belongs("aks-c", "app-c");
element("st-d", "Microsoft.Storage/storageAccounts", {}); belongs("st-d", "app-d");

rule("b-da", "design"); rule("b-da", "decision"); rule("b-da", "exception");
rule("b-clin", "design", { owner: "clinical-systems" }); rule("b-clin", "decision", { owner: "clinical-systems" });
rule("b-plat", "design", { apps: ["app-c"] });
rule("b-data", "decision", { category: "data-store" });

test("owners come from the resources' owner tags, lower-cased", () => {
  assert.deepEqual([...applicationOwners("app-a")], ["clinical-systems"]);
  assert.deepEqual([...applicationOwners("app-d")], []);
});

test("a design for an application the team owns goes to the team's board", () => {
  assert.equal(routeBoard("design", null, null, ["app-a"])?.code, "CLIN", "owner tag matched, whatever its case");
  assert.equal(routeBoard("design", null, null, ["app-c"])?.code, "PLAT", "an application listed by id");
  assert.equal(routeBoard("design", null, null, ["app-d"])?.code, "DA", "an application nobody claims stays with the general rule");
  assert.equal(routeBoard("design")?.code, "DA", "no application: an application rule never matches");
});

test("an application condition is more specific than a category", () => {
  assert.equal(routeBoard("decision", null, "data-store", ["app-a"])?.code, "CLIN", "the team's decision on a data store stays with the team");
  assert.equal(routeBoard("decision", null, "data-store", ["app-d"])?.code, "DATA", "unclaimed: the topic rule decides");
  assert.equal(routeBoard("decision", null, "data-store", [])?.code, "DATA", "a decision for no particular application");
});

test("every application of a decision must be covered", () => {
  assert.equal(routeBoard("decision", null, "general", ["app-a", "app-b"])?.code, "CLIN", "both owned by the team");
  assert.equal(routeBoard("decision", null, "general", ["app-a", "app-c"])?.code, "DA", "crosses teams: the general rule");
});

test("catalogue reviews are routed as before", () => {
  rule("b-data", "standard", { category: "Data" });
  assert.equal(routeBoard("standard", "standard", "Data", [])?.code, "DATA");
  assert.equal(routeBoard("standard", "standard", "Security", [])?.code, "DA", "no rule: the board coded DA");
});
