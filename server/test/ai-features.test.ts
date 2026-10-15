import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The AI feature catalogue beyond pre-review and drafting: rule drafting (generate→verify), control-reference
// suggestions, assessment prefill, session-notes drafting and evidence-mapping suggestions — each behind its own
// toggle, each gated by the capability of the act it drafts for, none storing anything. Plus secrets management:
// keys are ciphertext at rest, env/Docker-secret keys beat the database, legacy plaintext re-encrypts on read.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "archigov-aifeat-"));
delete process.env.AUTH_MODE;
delete process.env.LLM_BASE_URL; delete process.env.LLM_MODEL;
delete process.env.ARCHIGOV_SECRET_KEY;
const { db, migrate, setSetting, getSetting } = await import("../src/db.js");
await migrate();
const { seedDemo } = await import("../src/seed.js");
seedDemo("test");
const { seedBoards } = await import("../src/boards/seed.js");
seedBoards("test");
const { Hono } = await import("hono");
const { api } = await import("../src/routes.js");
const app = new Hono();
app.route("/", api);
const call = async (method: string, p: string, user: string, body?: any) => {
  const r = await app.request(p, { method, headers: { "x-user": user, "content-type": "application/json" }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const FAKE_KEY = "test-key-for-unit-tests-only";
const realFetch = globalThis.fetch;
let calls: { url: string; init: any }[] = [];
const mockFetch = (reply: (url: string, init: any) => any) => {
  globalThis.fetch = (async (url: any, init: any) => { calls.push({ url: String(url), init }); return { ok: true, status: 200, json: async () => reply(String(url), init), text: async () => "" } as any; }) as any;
};
const restoreFetch = () => { globalThis.fetch = realFetch; };
const asJson = (o: any) => ({ choices: [{ message: { content: JSON.stringify(o) } }] });

test("every draft endpoint answers 409 when its feature is off, and /ai/features is readable by the auditor", async () => {
  const flags = await call("GET", "/ai/features", "a.uditor");
  assert.equal(flags.status, 200);
  assert.deepEqual(Object.values(flags.body), Array(11).fill(false));
  assert.equal((await call("POST", "/decisions/review-draft", "s.patel", { title: "t", decision_md: "d" })).status, 409);
  assert.equal((await call("POST", "/artefacts/draft-rule", "s.patel", { title: "t", statement: "s" })).status, 409);
  assert.equal((await call("POST", "/artefacts/suggest-references", "s.patel", { title: "t", statement: "s" })).status, 409);
  const rev = (db.prepare("SELECT id FROM reviews LIMIT 1").get() as any).id;
  assert.equal((await call("POST", `/reviews/${rev}/assessments/draft`, "s.patel", { type: "impact" })).status, 409);
  const ses = (db.prepare("SELECT id FROM board_sessions LIMIT 1").get() as any).id;
  assert.equal((await call("POST", `/sessions/${ses}/draft-notes`, "j.duduka")).status, 409);
  assert.equal((await call("POST", "/evidence/suggest-mapping", "ops.admin")).status, 409);
  const app = (db.prepare("SELECT id FROM elements WHERE type='application' AND name='Pharmacy'").get() as any).id;
  assert.equal((await call("POST", `/applications/${app}/classification/suggest`, "s.patel")).status, 409);
});

test("keys are ciphertext at rest; legacy plaintext re-encrypts on first read", async () => {
  const on = Object.fromEntries(["draft_rule", "suggest_references", "draft_assessment", "draft_minutes", "suggest_evidence_mapping", "review_decision", "suggest_classification", "draft_board_narrative"].map((f) => [f, { enabled: true, provider: "mistral", model: "m" }]));
  const r = await call("POST", "/settings", "ops.admin", { ai_providers: { mistral: { api_key: FAKE_KEY } }, ai_features: on });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const stored = JSON.parse(getSetting("ai.providers")!);
  assert.ok(stored.mistral.api_key.startsWith("enc:v1:"), "stored key is ciphertext");
  assert.ok(!JSON.stringify(stored).includes(FAKE_KEY), "no plaintext key in the settings table");
  // legacy plaintext (pre-encryption instance): resolves, and the read re-encrypts it in place
  setSetting("ai.providers", JSON.stringify({ ...stored, openai: { api_key: "legacy-plain" } }));
  const s = await call("GET", "/settings", "ops.admin");
  assert.equal(s.body.ai.providers.openai.key_set, true);
  assert.equal(s.body.ai.providers.openai.key_source, "settings");
  assert.ok(JSON.parse(getSetting("ai.providers")!).openai.api_key.startsWith("enc:v1:"), "plaintext re-encrypted on read");
});

test("the operator's secret store beats the database: AI_*_API_KEY and the _FILE convention", async () => {
  process.env.AI_ANTHROPIC_API_KEY = "env-key-anthropic";
  const keyFile = path.join(process.env.DATA_DIR!, "ollama.secret");
  fs.writeFileSync(keyFile, "file-key-ollama\n");
  process.env.AI_OLLAMA_API_KEY_FILE = keyFile;
  try {
    const s = await call("GET", "/settings", "ops.admin");
    assert.equal(s.body.ai.providers.anthropic.key_source, "env");
    assert.equal(s.body.ai.providers.anthropic.configured, true);
    assert.ok(!JSON.stringify(s.body).includes("env-key-anthropic"));
    calls = []; mockFetch(() => ({ content: [{ type: "text", text: "ok" }] }));
    try {
      const t = await call("POST", "/ai/test", "ops.admin", { provider: "anthropic" });
      assert.equal(t.status, 200, JSON.stringify(t.body));
      assert.equal(calls[0].init.headers["x-api-key"], "env-key-anthropic", "the env key is what goes on the wire");
    } finally { restoreFetch(); }
    calls = []; mockFetch(() => asJson({}));
    try {
      await call("POST", "/ai/test", "ops.admin", { provider: "ollama" });
      assert.equal(calls[0].init.headers.Authorization, "Bearer file-key-ollama", "_FILE secret is read and used");
    } finally { restoreFetch(); }
  } finally { delete process.env.AI_ANTHROPIC_API_KEY; delete process.env.AI_OLLAMA_API_KEY_FILE; }
});

test("draft-rule: generate→verify — a valid rule comes back validated with its blast radius, an invalid one is refused in place", async () => {
  calls = []; mockFetch(() => asJson({ rule: { scope: "resource", match: { typePrefix: "microsoft.storage/" }, assert: { path: "props.minTlsVersion", op: "eq", value: "TLS1_2" } }, rationale: "Checks storage TLS floor." }));
  try {
    const r = await call("POST", "/artefacts/draft-rule", "s.patel", { kind: "standard", title: "Storage TLS", statement: "Storage accounts enforce TLS 1.2." });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.origin, "ai");
    assert.equal(r.body.validation.ok, true);
    assert.ok(typeof r.body.impact.findings === "number", "dry run against the live model");
  } finally { restoreFetch(); }
  mockFetch(() => asJson({ rule: { scope: "resource", match: {}, assert: { path: "x", op: "frobnicate", value: 1 } }, rationale: "bad" }));
  try {
    const r = await call("POST", "/artefacts/draft-rule", "s.patel", { kind: "standard", title: "Bad", statement: "s" });
    assert.equal(r.status, 200);
    assert.equal(r.body.validation.ok, false, "an op the engine does not know fails validation");
    assert.ok(r.body.validation.error);
  } finally { restoreFetch(); }
  assert.equal((await call("POST", "/artefacts/draft-rule", "a.uditor", { title: "t", statement: "s" })).status, 403, "auditors author nothing");
});

test("suggest-references returns trimmed refs only; the capability is the author's", async () => {
  mockFetch(() => asJson({ references: [{ ref: "ISO27001:A.8.24", why: "storage crypto" }, { ref: "  ", why: "empty" }, { ref: "DORA:Art.9", why: "ict risk" }] }));
  try {
    const r = await call("POST", "/artefacts/suggest-references", "s.patel", { kind: "standard", title: "Storage TLS", statement: "Storage accounts enforce TLS 1.2." });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.references.map((x: any) => x.ref), ["ISO27001:A.8.24", "DORA:Art.9"]);
  } finally { restoreFetch(); }
  assert.equal((await call("POST", "/artefacts/suggest-references", "ops.admin", { title: "t", statement: "s" })).status, 403, "the platform admin is not an author");
});

test("assessments/draft prefills from the review; the platform admin gets 403", async () => {
  const rev = (db.prepare("SELECT id FROM reviews WHERE type='design' LIMIT 1").get() as any).id;
  mockFetch(() => asJson({ result_md: "## What changes\n\nDrafted.\n" }));
  try {
    const r = await call("POST", `/reviews/${rev}/assessments/draft`, "s.patel", { type: "impact" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.origin, "ai");
    assert.ok(r.body.result_md.includes("Drafted"));
  } finally { restoreFetch(); }
  assert.equal((await call("POST", `/reviews/${rev}/assessments/draft`, "ops.admin", { type: "impact" })).status, 403);
});

test("draft-notes is the secretary's (or chair's); another seat is refused", async () => {
  const ses = (db.prepare("SELECT id FROM board_sessions LIMIT 1").get() as any).id;
  mockFetch(() => asJson({ notes_md: "The sitting opened with quorum." }));
  try {
    const r = await call("POST", `/sessions/${ses}/draft-notes`, "j.duduka");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.notes_md.includes("quorum"));
  } finally { restoreFetch(); }
  assert.equal((await call("POST", `/sessions/${ses}/draft-notes`, "m.hughes")).status, 403, "a decision maker does not write the notes");
});

test("evidence mapping: admin-only, suggestions filtered to the actually-unmapped keys, no model call when nothing is unmapped", async () => {
  assert.equal((await call("POST", "/evidence/suggest-mapping", "s.patel")).status, 403);
  calls = []; mockFetch(() => asJson({ map: {} }));
  try {
    const none = await call("POST", "/evidence/suggest-mapping", "ops.admin");
    if (none.body.unmapped.length === 0) assert.equal(calls.length, 0, "no unmapped keys, no model call");
  } finally { restoreFetch(); }
  db.prepare("INSERT INTO evidence(id, resource_id, source, control, state, severity, observed_at, created_at, updated_at) SELECT 'ev-ai-test', id, 'defender', 'defender:some-unmapped-check', 'fail', 'medium', '2026-01-01', '2026-01-01', '2026-01-01' FROM elements WHERE type='resource' LIMIT 1").run();
  calls = []; mockFetch(() => asJson({ map: { "defender:some-unmapped-check": "min-tls-1.2", "defender:invented-key": "nope" } }));
  try {
    const r = await call("POST", "/evidence/suggest-mapping", "ops.admin");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.map, { "defender:some-unmapped-check": "min-tls-1.2" }, "a key the instance never saw is dropped");
    assert.ok(r.body.unmapped.includes("defender:some-unmapped-check"));
  } finally { restoreFetch(); }
});

test("decision review: a critical assessment with a tightened argument; the author's capability, nothing stored", async () => {
  assert.equal((await call("POST", "/decisions/review-draft", "a.uditor", { title: "t", decision_md: "d" })).status, 403, "auditors author nothing");
  mockFetch(() => asJson({ verdict: "needs_work", assessment_md: "## Assessment\n\nThe justification asserts cost savings without evidence.", issues: [
    { kind: "unsupported_claim", point: "Cost saving is asserted, never quantified." }, { kind: "risk_not_stated", point: "Vendor lock-in is not acknowledged as an accepted risk." }, { point: "" },
  ], tightened: { decision_md: "Adopt X.", justification_md: "X wins because…", consequences_md: "Accepting this means…; we accept the risk of…" } }));
  try {
    const before = (db.prepare("SELECT count(*) c FROM decisions").get() as any).c;
    const r = await call("POST", "/decisions/review-draft", "s.patel", { title: "Adopt X", decision_md: "Adopt X.", justification_md: "It is cheaper.", consequences_md: "" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.verdict, "needs_work");
    assert.equal(r.body.origin, "ai");
    assert.equal(r.body.issues.length, 2, "an issue without a point is dropped");
    assert.ok(r.body.tightened.consequences_md.includes("we accept the risk"));
    assert.equal((db.prepare("SELECT count(*) c FROM decisions").get() as any).c, before, "a review stores nothing");
  } finally { restoreFetch(); }
});

test("classification suggestion: normalised to the classification invariants, the author's capability, nothing stored", async () => {
  const app = (db.prepare("SELECT id FROM elements WHERE type='application' AND name='Pharmacy'").get() as any).id;
  for (const u of ["ops.admin", "a.uditor"]) assert.equal((await call("POST", `/applications/${app}/classification/suggest`, u)).status, 403, u);
  calls = []; mockFetch(() => asJson({ criticality: "important", rationale: "Dispensing stops if it fails.", services: [
    { name: "Dispense medicines", kind: "cif" }, { name: "Order stock", kind: "kpi" }, { name: "  ", kind: "business_service" },
  ] }));
  try {
    const before = db.prepare("SELECT * FROM app_classifications WHERE application_id=?").get(app);
    const r = await call("POST", `/applications/${app}/classification/suggest`, "s.patel");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.origin, "ai");
    assert.deepEqual(r.body.services, [{ name: "Dispense medicines", kind: "cif" }], "unknown kinds and blank names are dropped");
    assert.equal(r.body.criticality, "critical", "a regulated service makes the suggestion critical, as it would a person's");
    const sent = JSON.parse(calls[0].init.body).messages[1].content;
    assert.ok(sent.includes("stpharmacyfiles") || sent.includes("Pharmacy"), "the model sees the application's own resources");
    assert.deepEqual(db.prepare("SELECT * FROM app_classifications WHERE application_id=?").get(app), before, "a suggestion stores nothing");
  } finally { restoreFetch(); }
  assert.equal((await call("POST", "/applications/not-an-app/classification/suggest", "s.patel")).status, 404);
});

test("a decision argues in three parts: justification round-trips through create, read and update", async () => {
  const r = await call("POST", "/decisions", "s.patel", { title: "Adopt PostgreSQL Flexible Server", topic: "data-store", decision_md: "Use PostgreSQL Flexible Server.", justification_md: "Managed HA and the team's existing operational experience outweigh Cosmos DB's scale we do not need.", consequences_md: "All new services use PostgreSQL; we accept single-region write latency." });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d1 = await call("GET", `/decisions/${r.body.id}`, "a.uditor");
  assert.ok(d1.body.justification_md.includes("operational experience"));
  await call("PUT", `/decisions/${r.body.id}`, "s.patel", { justification_md: "Revised: managed HA wins." });
  const d2 = await call("GET", `/decisions/${r.body.id}`, "a.uditor");
  assert.equal(d2.body.justification_md, "Revised: managed HA wins.");
  assert.equal(d2.body.decision_md, "Use PostgreSQL Flexible Server.", "an untouched field keeps its value");
});

test("the evidence flow: trigger on a draft decision, complete it, submit for review — associations tracked end to end", async () => {
  // the AI suggests evidence; the author triggers it on their proposed decision
  mockFetch(() => asJson({ verdict: "needs_work", assessment_md: "a", issues: [], tightened: null, suggested_assessments: [
    { type: "impact", title: "Cost claim", reason: "Cost saving asserted without analysis." }, { type: "skynet", title: "x", reason: "invalid type is dropped" },
  ] }));
  let suggestion: any;
  try {
    const rr = await call("POST", "/decisions/review-draft", "s.patel", { title: "Adopt X", decision_md: "Adopt X.", justification_md: "cheaper" });
    assert.equal(rr.status, 200);
    assert.equal(rr.body.suggested_assessments.length, 1, "unknown types are dropped");
    suggestion = rr.body.suggested_assessments[0];
  } finally { restoreFetch(); }
  const dec = await call("POST", "/decisions", "s.patel", { title: "Adopt X", topic: "general", decision_md: "Adopt X.", justification_md: "cheaper", consequences_md: "we accept risk Y" });
  assert.equal(dec.status, 200);
  // only the author triggers or provides; others and non-authors are refused
  assert.equal((await call("POST", `/decisions/${dec.body.id}/assessments`, "a.okafor", { type: "impact" })).status, 403, "another author is not this decision's author");
  assert.equal((await call("POST", `/decisions/${dec.body.id}/assessments`, "ops.admin", { type: "impact" })).status, 403, "the platform admin authors nothing");
  const trig = await call("POST", `/decisions/${dec.body.id}/assessments`, "s.patel", { type: suggestion.type, title: suggestion.title, assigned_to: "m.hughes" });
  assert.equal(trig.status, 200, JSON.stringify(trig.body));
  const aId = trig.body.assessments[0].id;
  assert.equal(trig.body.assessments[0].status, "requested");
  // only the assessor completes it
  assert.equal((await call("POST", `/assessments/${aId}/result`, "s.patel", { result: "satisfactory", result_md: "not mine to record" })).status, 403);
  const res = await call("POST", `/assessments/${aId}/result`, "m.hughes", { result: "satisfactory_with_remarks", result_md: "Cost analysis done; saving is 12%, not 'obvious'." });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  // the author also provides evidence directly
  const prov = await call("POST", `/decisions/${dec.body.id}/assessments/provide`, "s.patel", { type: "scope", result: "satisfactory", result_md: "## In scope\n\nNew services only." });
  assert.equal(prov.status, 200, JSON.stringify(prov.body));
  // the decision page carries both; the review it is submitted to shows them as on_decision, never blocking
  const dd = await call("GET", `/decisions/${dec.body.id}`, "a.uditor");
  assert.equal(dd.body.assessments.length, 2);
  const rev = await call("POST", "/reviews", "s.patel", { type: "decision", decision_id: dec.body.id, title: `${dec.body.code} · Adopt X`, summary: "Adopt X." });
  assert.equal(rev.status, 200, JSON.stringify(rev.body));
  const rd = await call("GET", `/reviews/${rev.body.id}`, "a.uditor");
  const onDecision = rd.body.assessments.filter((x: any) => x.on_decision);
  assert.equal(onDecision.length, 2, "the decision's evidence follows it onto the review");
  assert.equal(rd.body.progress.open_assessments ?? 0, 0, "decision-attached evidence never blocks");
  // once under review (still 'proposed'), triggering more evidence still works for the author; after acceptance it is closed
  assert.equal((await call("POST", `/assessments/${aId}/waive`, "j.duduka", { reason: "cannot waive what never blocks" })).status, 409);
});
