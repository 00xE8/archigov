import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// AI providers: the admin configures OpenAI / Claude (Anthropic) / Mistral / Ollama and enables each AI feature
// separately with its own provider and model. Keys live in the settings table and never come back out — not in
// GET /settings, not in the audit log, not in an error. Everything is off by default and the deterministic
// behaviour carries the product when nothing is configured.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "archigov-ai-"));
delete process.env.AUTH_MODE;
delete process.env.LLM_BASE_URL; delete process.env.LLM_API_KEY; delete process.env.LLM_MODEL;
const { db, migrate } = await import("../src/db.js");
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
const appId = (db.prepare("SELECT id FROM elements WHERE type='application' AND name='Intranet'").get() as any).id;
const realFetch = globalThis.fetch;
let calls: { url: string; init: any }[] = [];
const mockFetch = (reply: () => any) => {
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    return { ok: true, status: 200, json: async () => reply(), text: async () => JSON.stringify(reply()) } as any;
  }) as any;
};
const restoreFetch = () => { globalThis.fetch = realFetch; };

test("defaults: nothing enabled, settings carry the catalogue, no provider configured", async () => {
  const r = await call("GET", "/settings", "ops.admin");
  assert.equal(r.status, 200);
  assert.equal(Object.keys(r.body.ai.providers).length, 4);
  assert.equal(r.body.ai.providers.ollama.needs_key, false);
  assert.equal(r.body.ai.providers.ollama.configured, true, "a local endpoint needs no key");
  assert.equal(r.body.ai.providers.mistral.configured, false);
  assert.equal(r.body.ai.features.pre_review.enabled, false);
  assert.equal(r.body.llm.configured, false);
});

test("only the platform admin configures or tests AI", async () => {
  assert.equal((await call("POST", "/settings", "s.patel", { ai_providers: { mistral: { api_key: FAKE_KEY } } })).status, 403);
  assert.equal((await call("POST", "/ai/test", "s.patel", { provider: "mistral" })).status, 403);
});

test("keys go in and never come back: GET masks, audit holds no key material", async () => {
  const r = await call("POST", "/settings", "ops.admin", { ai_providers: { mistral: { api_key: FAKE_KEY }, ollama: { base_url: "http://models.internal:11434/v1" } }, ai_features: { pre_review: { enabled: true, provider: "mistral", model: "mistral-small-latest" } } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(!JSON.stringify(r.body).includes(FAKE_KEY), "the response never echoes the key");
  const s = await call("GET", "/settings", "ops.admin");
  assert.equal(s.body.ai.providers.mistral.key_set, true);
  assert.equal(s.body.ai.providers.mistral.configured, true);
  assert.equal(s.body.ai.providers.ollama.base_url, "http://models.internal:11434/v1");
  assert.ok(!JSON.stringify(s.body).includes(FAKE_KEY), "GET /settings never returns a key");
  assert.equal(s.body.ai.features.pre_review.enabled, true);
  assert.equal(s.body.llm.configured, true, "back-compat summary follows pre_review");
  const auditRows = db.prepare("SELECT data_json FROM audit_log").all() as any[];
  assert.ok(!JSON.stringify(auditRows).includes(FAKE_KEY), "the audit log never holds a key");
});

test("validation: unknown provider or feature is refused", async () => {
  assert.equal((await call("POST", "/settings", "ops.admin", { ai_providers: { skynet: { api_key: "x" } } })).status, 400);
  assert.equal((await call("POST", "/settings", "ops.admin", { ai_features: { terminate: { enabled: true } } })).status, 400);
  assert.equal((await call("POST", "/settings", "ops.admin", { ai_providers: { mistral: { base_url: "ftp://nope" } } })).status, 400);
});

test("mistral pre-review goes to the Mistral endpoint with a Bearer key and native JSON mode", async () => {
  calls = [];
  mockFetch(() => ({ choices: [{ message: { content: JSON.stringify({ summary: "AI summary", recommendation: "approve_with_conditions", findings: [
    { severity: "high", title: "Real citation", detail: "d", citations: [{ kind: "section", ref: "data" }] },
    { severity: "high", title: "Invented citation", detail: "d", citations: [{ kind: "standard", ref: "STD-999" }] },
  ], suggested_conditions: ["c1"] }) } }] }));
  try {
    const rev = await call("POST", "/reviews", "s.patel", { type: "design", title: "AI path", application_id: appId, risk_tier: "low", summary: "s", design_md: "## Design\n\nx\n" });
    assert.equal(rev.status, 200, JSON.stringify(rev.body));
    assert.ok(calls.length >= 1, "submission ran the pre-review through the model");
    const req = calls[0];
    assert.ok(req.url.startsWith("https://api.mistral.ai/v1/chat/completions"), req.url);
    assert.equal(req.init.headers.Authorization, `Bearer ${FAKE_KEY}`);
    const body = JSON.parse(req.init.body);
    assert.equal(body.model, "mistral-small-latest");
    assert.deepEqual(body.response_format, { type: "json_object" });
    const detail = await call("GET", `/reviews/${rev.body.id}`, "a.uditor");
    const pre = detail.body.events.filter((e: any) => e.kind === "pre_review").pop();
    assert.equal(pre.origin, "ai");
    assert.equal(pre.data.engine, "llm");
    assert.equal(pre.data.provider, "mistral");
    const titles = pre.data.findings.map((f: any) => f.title);
    assert.ok(titles.includes("Real citation") && !titles.includes("Invented citation"), "unresolvable citations are discarded");
  } finally { restoreFetch(); }
});

test("anthropic adapter speaks the Messages API: x-api-key, system field, JSON instruction", async () => {
  await call("POST", "/settings", "ops.admin", { ai_providers: { anthropic: { api_key: FAKE_KEY } }, ai_features: { draft_decision: { enabled: true, provider: "anthropic", model: "claude-sonnet-5-5" } } });
  const w = db.prepare("SELECT id FROM work_items WHERE external_id IS NOT NULL LIMIT 1").get() as any;
  calls = [];
  mockFetch(() => ({ content: [{ type: "text", text: JSON.stringify({ title: "Drafted", topic: "general", context_md: "c", options: [], decision_md: "", consequences_md: "" }) }] }));
  try {
    const r = await call("POST", `/work-items/${w.id}/draft-decision`, "s.patel");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.origin, "ai");
    assert.equal(r.body.title, "Drafted");
    const req = calls[0];
    assert.ok(req.url.startsWith("https://api.anthropic.com/v1/messages"), req.url);
    assert.equal(req.init.headers["x-api-key"], FAKE_KEY);
    assert.equal(req.init.headers["anthropic-version"], "2023-06-01");
    assert.equal(req.init.headers.Authorization, undefined, "no Bearer header on Anthropic");
    const body = JSON.parse(req.init.body);
    assert.ok(body.system.includes("only a valid JSON object"), "JSON mode is an instruction");
    assert.ok(body.messages.every((m: any) => m.role !== "system"));
    assert.equal(body.response_format, undefined);
  } finally { restoreFetch(); }
});

test("ollama needs no key and gets no response_format; /ai/test round-trips", async () => {
  calls = [];
  mockFetch(() => ({ choices: [{ message: { content: "ok" } }] }));
  try {
    const r = await call("POST", "/ai/test", "ops.admin", { provider: "ollama", model: "llama3.1" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.reply, "ok");
    const req = calls[0];
    assert.ok(req.url.startsWith("http://models.internal:11434/v1/chat/completions"), "uses the overridden base URL");
    assert.equal(req.init.headers.Authorization, undefined);
    assert.equal(JSON.parse(req.init.body).response_format, undefined);
  } finally { restoreFetch(); }
  const fail = await call("POST", "/ai/test", "ops.admin", { provider: "openai" });
  assert.equal(fail.status, 502);
  assert.ok(/no API key/i.test(fail.body.error));
});

test("switching a feature off restores the deterministic path without touching the network", async () => {
  await call("POST", "/settings", "ops.admin", { ai_features: { pre_review: { enabled: false, provider: "mistral", model: "mistral-small-latest" } } });
  calls = [];
  mockFetch(() => { throw new Error("must not be called"); });
  try {
    const rev = await call("POST", "/reviews", "s.patel", { type: "design", title: "Rules path", application_id: appId, risk_tier: "low", summary: "s", design_md: "## Design\n\nx\n" });
    assert.equal(rev.status, 200);
    assert.equal(calls.length, 0, "no model call for a disabled feature");
    const detail = await call("GET", `/reviews/${rev.body.id}`, "a.uditor");
    const pre = detail.body.events.filter((e: any) => e.kind === "pre_review").pop();
    assert.equal(pre.origin, "rules");
  } finally { restoreFetch(); }
});

test("a key is replaced or cleared, never read: empty string clears, absent keeps", async () => {
  await call("POST", "/settings", "ops.admin", { ai_providers: { mistral: { base_url: "https://mistral.internal/v1" } } });
  let s = await call("GET", "/settings", "ops.admin");
  assert.equal(s.body.ai.providers.mistral.key_set, true, "an absent api_key keeps the stored one");
  await call("POST", "/settings", "ops.admin", { ai_providers: { mistral: { api_key: "" } } });
  s = await call("GET", "/settings", "ops.admin");
  assert.equal(s.body.ai.providers.mistral.key_set, false, "an empty api_key clears it");
  assert.equal(s.body.ai.features.pre_review.enabled, false, "a feature pointing at an unconfigured provider is off");
});
