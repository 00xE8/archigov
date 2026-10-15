#!/usr/bin/env bash
# Archigov integrations smoke test — the Azure / Azure DevOps / importer / packs paths, driven through the API.
#
#   scripts/smoke-integrations.sh [base_url] [hook_secret]      default http://localhost:8080  test-secret
#
# Run it against a FRESH seeded instance started in fixture mode:
#   ARCHIGOV_FIXTURES=1 ADO_HOOK_SECRET=test-secret SEED_DEMO=true npm run dev
# Fixture mode replaces every outbound Azure / DevOps call with recorded-shape responses, so the real parsing,
# normalisation and mapping code runs offline. It MUTATES the tenant (a fixture estate, imported evidence, the demo
# backlog, CSV/ArchiMate sources, a standards pack); reset with `docker compose down -v && docker compose up -d`.
set -u
BASE="${1:-http://localhost:8080}"
HOOK_SECRET="${2:-${ADO_HOOK_SECRET:-test-secret}}"
command -v python3 >/dev/null || { echo "python3 is required"; exit 2; }

python3 - "$BASE" "$HOOK_SECRET" <<'PY'
import json, sys, base64
import urllib.request, urllib.error

BASE = sys.argv[1].rstrip("/") + "/api"; SECRET = sys.argv[2]
HDR = {"x-user": "smoke-int", "Content-Type": "application/json"}

def call(method, path, body=None, headers=None, raw=None):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(BASE + path, data=data, headers={**HDR, **(headers or {})}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            payload = r.read(); ct = r.headers.get("Content-Type", "")
            return r.status, (json.loads(payload) if "json" in ct and payload else payload.decode(errors="replace"))
    except urllib.error.HTTPError as e:
        payload = e.read()
        try: return e.code, json.loads(payload) if payload else None
        except Exception: return e.code, payload.decode(errors="replace")

get = lambda p, **k: call("GET", p, **k)
post = lambda p, b=None, **k: call("POST", p, {} if b is None else b, **k)

results, ctx, mutations = [], {}, []
def step(label, fn):
    try:
        detail = fn() or ""
        results.append((label, True)); print(f"PASS  {label}" + (f"  — {detail}" if detail else ""))
    except AssertionError as e:
        results.append((label, False)); print(f"FAIL  {label}  — {e}")
    except Exception as e:
        results.append((label, False)); print(f"FAIL  {label}  — {type(e).__name__}: {e}")

def open_findings():
    s, o = get("/overview"); assert s == 200, o; return o["counts"]["findings_open"]

# ---------- 0. fixture mode is on and the sources say so ----------
def s0():
    s, h = get("/health"); assert s == 200 and h.get("ok"), f"health {s} {h}"
    s, srcs = get("/sources"); assert s == 200, srcs
    kinds = {x["kind"]: x for x in srcs}
    for k in ["azure", "defender", "azure_policy"]:
        assert k in kinds, f"source kind {k} not listed (is ARCHIGOV_FIXTURES=1 set?)"
        assert kinds[k]["configured"] and kinds[k]["fixtures"], f"{k}: {kinds[k]}"
        assert kinds[k]["status"] == "never", f"{k} should be 'never' before the first sync: {kinds[k]['status']}"
    ado = kinds.get("ado") or kinds.get("demo-ado"); assert ado and ado["configured"] and ado["fixtures"], f"ado: {ado}"
    assert "hook_url" in ado["config"], ado["config"]
    ctx["open0"] = open_findings()
    return f"{len(srcs)} sources; azure/defender/azure_policy configured via fixtures, 'never' synced; {ctx['open0']} open findings to start"
step("0  sources advertise fixture mode", s0)

# ---------- a. Azure test connection ----------
def a():
    s, r = post("/sources/azure/test"); assert s == 200 and r.get("ok"), f"{s} {r}"
    assert r["subscriptions"] and r["subscriptions"][0]["id"].endswith("fixture00001"), r["subscriptions"]
    return f"tenant={r.get('tenant')} subscriptions={[x['name'] for x in r['subscriptions']]}"
step("a  Azure test connection lists the fixture subscription", a)

# ---------- b. Azure sync: created once, idempotent after ----------
def b():
    s, r = post("/sources/azure/sync"); assert s == 200 and r.get("ok"), f"{s} {r}"
    assert r["stats"]["created"] == 8 and r["collected"] == 8, r["stats"]; mutations.append("azure fixture estate (8 resources)")
    s, r2 = post("/sources/azure/sync"); assert s == 200 and r2["stats"]["unchanged"] == 8 and r2["stats"]["created"] == 0, r2["stats"]
    s, srcs = get("/sources"); az = next(x for x in srcs if x["kind"] == "azure"); assert az["status"] == "ok" and az["last_sync_at"], az
    # the run is recorded against the source (checked here: the runs list only keeps the most recent ones)
    s, conf = get("/conformance"); run = next((x for x in conf["runs"] if x.get("id") == r2.get("run_id", r2.get("runId"))), None)
    assert run and run.get("kind") == "sync" and run.get("source_name") == "Azure (Resource Graph)", (r2.get("run_id"), [(x.get("kind"), x.get("source_name")) for x in conf["runs"][:5]])
    s, apps = get("/applications"); names = {x["name"] for x in apps}
    assert "Claims" in names, names
    s, shared = get("/shared-services"); assert any("fixture" in x["name"].lower() for x in shared), [x["name"] for x in shared]
    ctx["open_after_azure"] = open_findings()
    return f"first sync created 8 (apps incl. Claims, hub vnet → shared service); second sync unchanged 8; open findings now {ctx['open_after_azure']}"
step("b  Azure Resource Graph sync is idempotent", b)

# ---------- c/d. Defender and Azure Policy evidence ----------
def c():
    s, r = post("/sources/defender/sync"); assert s == 200 and r.get("ok"), f"{s} {r}"
    assert r["imported"]["created"] >= 7, r["imported"]; assert any("stghost" in u for u in r["unmatched"]), r["unmatched"]
    mutations.append("defender fixture evidence")
    s, ev = get("/evidence?source=defender"); assert any(e["control"] == "storage-public-access" and e["state"] == "fail" and e["resource_name"] == "stclaimsdocs" for e in ev)
    return f"created {r['imported']['created']}, unmatched {r['unmatched']}"
step("c  Defender for Cloud assessments imported as evidence (unmatched reported)", c)
def d():
    s, r = post("/sources/policy/sync"); assert s == 200 and r.get("ok"), f"{s} {r}"
    assert r["imported"]["created"] >= 5, r["imported"]; assert any("kv-ghost" in u for u in r["unmatched"]), r["unmatched"]
    mutations.append("azure policy fixture evidence")
    s, ev = get("/evidence?source=azure_policy"); controls = {e["control"] for e in ev}
    assert "kv-purge-protection" in controls and any(c.startswith("policy:") for c in controls), controls
    s, summ = get("/evidence/summary"); by = {x["source"]: x for x in summ["sources"]}
    assert by["defender"]["last_unmatched"] and by["azure_policy"]["last_unmatched"], summ
    return f"created {r['imported']['created']}; controls incl. mapped + fallback: {sorted(controls)[:4]}…"
step("d  Azure Policy states imported as evidence (mapped GUIDs + fallback key)", d)

# ---------- e. evaluate: evidence-backed findings on the fixture estate ----------
def e():
    s, r = post("/evaluate"); assert s == 200, r
    s, conf = get("/conformance"); open_now = open_findings()
    fx = [f for f in conf["findings"] if f.get("element_name") in ("stclaimsdocs", "sql-claims", "vm-billing-01", "oai-billing-assist", "kv-claims")]
    assert fx, "no findings on fixture resources"
    assert any(f["evidence"].get("source") == "defender" and f["evidence"].get("state") == "fail" for f in fx), [f["evidence"] for f in fx][:3]
    return (f"{open_now} open findings (was {ctx['open0']} before the fixture estate: the 8 new resources add their own evidence-backed and "
            f"architecture findings; the demo's 19 are unchanged); {len(fx)} on fixture resources, incl. imported Defender fails")
step("e  evaluate turns imported evidence into findings", e)

# ---------- f/g. Azure DevOps ----------
def f():
    s, r = post("/sources/ado/test"); assert s == 200 and r.get("ok"), f"{s} {r}"
    assert r["work_item_count"] >= 7 and r["org"] == "sehealth", r
    return f"{r['org']}/{r['project']}: {r['work_item_count']} work items in the configured WIQL"
step("f  Azure DevOps test connection", f)
def g():
    s, r = post("/sources/ado/sync"); assert s == 200 and r.get("ok"), f"{s} {r}"
    assert r["fetched"] >= 7 and r["material_changes"] >= 1, r; mutations.append("demo backlog refreshed from ADO fixtures (1042 changed)")
    s, items = get("/work-items"); w = next(x for x in items if x["external_id"] == "1042")
    assert w["material_change"] == 1 and "bulk export" in w["description"], w["description"]
    ctx["wi1042"] = w["id"]
    return f"fetched {r['fetched']}, updated {r['updated']}, material changes {r['material_changes']}; 1042 now carries the new description"
step("g  ADO WIQL backfill updates the backlog and flags the material change", g)

# ---------- h. service hook ----------
def h():
    payload = {"eventType": "workitem.updated", "publisherId": "tfs", "resource": {"id": 1042, "rev": 8, "fields": {
        "System.Title": "Replace referral attachments store with managed document service", "System.WorkItemType": "Epic", "System.State": "Active",
        "System.Description": "<div>Move referral attachments to a managed document service with retention, audit, eDiscovery, bulk export <b>and a 30-day legal hold</b>.</div>",
        "System.Tags": "architecture-needed; data", "System.AreaPath": "Clinical-Platform\\Integration", "System.ChangedDate": "2026-10-12T08:00:00Z"}}, "resourceVersion": "1.0"}
    s, r = post("/hooks/ado", payload, headers={"x-user": ""}); assert s == 401, f"no secret should be 401, got {s} {r}"
    s, r = post("/hooks/ado", payload, headers={"x-archigov-hook-secret": "wrong"}); assert s == 401, f"wrong secret should be 401, got {s}"
    s, r = post("/hooks/ado", payload, headers={"x-archigov-hook-secret": SECRET}); assert s == 200 and r.get("ok"), f"{s} {r}"
    assert r["outcome"] == "updated" and r["material_change"] is True, r
    basic = base64.b64encode(f":{SECRET}".encode()).decode()
    s, r2 = post("/hooks/ado", {**payload, "resource": {**payload["resource"], "rev": 8}}, headers={"Authorization": f"Basic {basic}"}); assert s == 200 and r2["outcome"] == "skipped_old_rev", r2
    s, items = get("/work-items"); w = next(x for x in items if x["external_id"] == "1042"); assert "legal hold" in w["description"], w["description"]
    mutations.append("hook update on 1042 (rev 8)")
    return "401 without/with wrong secret; header auth → updated + material; basic auth replay of rev 8 → skipped_old_rev; description updated"
step("h  ADO service hook: secret enforced, idempotent on rev", h)

# ---------- i. CSV import ----------
def i():
    s, t = get("/import/templates/csv?kind=resources"); assert s == 200 and t.startswith("id,name,type"), t[:60]
    csv = ("id,name,type,location,resourceGroup,subscriptionId,tags,properties\n"
           "/subscriptions/s9/resourcegroups/rg-payroll-prod/providers/microsoft.web/sites/app-payroll,app-payroll,Microsoft.Web/sites,uksouth,rg-payroll-prod,s9,app=payroll;owner=hr-systems;env=prod,\"{\"\"httpsOnly\"\":true,\"\"minTlsVersion\"\":\"\"1.2\"\"}\"\n"
           "/subscriptions/s9/resourcegroups/rg-payroll-prod/providers/microsoft.sql/servers/sql-payroll,sql-payroll,Microsoft.Sql/servers,uksouth,rg-payroll-prod,s9,app=payroll;owner=hr-systems;env=prod,\"{\"\"publicAccess\"\":false,\"\"minTlsVersion\"\":\"\"1.2\"\"}\"\n"
           "/subscriptions/s9/resourcegroups/rg-payroll-prod/providers/microsoft.keyvault/vaults/kv-payroll,kv-payroll,Microsoft.KeyVault/vaults,uksouth,rg-payroll-prod,s9,app=payroll,oops\n")
    s, r = post("/import/csv", {"kind": "resources", "csv": csv, "file": "payroll.csv"}); assert s == 200, r
    assert r["created"] == 2 and len(r["errors"]) == 1 and r["errors"][0]["line"] == 4, r; mutations.append("csv source payroll.csv (2 resources)")
    rel = ("from_ref,to_ref,type\n/subscriptions/s9/resourcegroups/rg-payroll-prod/providers/microsoft.web/sites/app-payroll,"
           "/subscriptions/s9/resourcegroups/rg-payroll-prod/providers/microsoft.sql/servers/sql-payroll,depends_on\n")
    s, r2 = post("/import/csv", {"kind": "relations", "csv": rel, "file": "payroll.csv"}); assert s == 200 and r2["created"] == 1, r2
    s, srcs = get("/sources"); assert any(x["kind"] == "csv" and x["status"] == "ok" for x in srcs), [x["kind"] for x in srcs]
    s, apps = get("/applications"); assert any(a["name"] == "Payroll" for a in apps), "Payroll application inferred from the app tag"
    return f"template ok; resources created 2 / 1 error (line 4: {r['errors'][0]['message']}); relation created 1; csv source listed; Payroll application derived"
step("i  CSV import: template, resources with error lines, relations", i)

# ---------- j. ArchiMate import ----------
def j_():
    xml = """<?xml version="1.0" encoding="UTF-8"?>
<model xmlns="http://www.opengroup.org/xsd/archimate/3.0/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" identifier="id-m">
  <name xml:lang="en">Smoke exchange model</name>
  <elements>
    <element identifier="a1" xsi:type="ApplicationComponent"><name xml:lang="en">Bed Management</name></element>
    <element identifier="a2" xsi:type="ApplicationComponent"><name xml:lang="en">Theatre Scheduling</name></element>
    <element identifier="n1" xsi:type="Node"><name xml:lang="en">bedmgmt-app-01</name></element>
    <element identifier="b1" xsi:type="BusinessProcess"><name xml:lang="en">Admit patient</name></element>
  </elements>
  <relationships>
    <relationship identifier="r1" source="n1" target="a1" xsi:type="Realization"/>
    <relationship identifier="r2" source="a2" target="a1" xsi:type="Serving"/>
  </relationships>
</model>"""
    s, r = call("POST", "/import/archimate?file=smoke.xml", raw=xml.encode(), headers={"Content-Type": "application/xml"}); assert s == 200, r
    assert r["elements"]["applications"] == 2 and r["elements"]["resources"] == 1 and r["elements"]["skipped"] == 1 and r["relations"] >= 1, r
    assert any("BusinessProcess" in w for w in r["warnings"]), r["warnings"]; mutations.append("archimate source 'Smoke exchange model'")
    s, apps = get("/applications"); names = {a["name"] for a in apps}; assert {"Bed Management", "Theatre Scheduling"} <= names, names
    return f"2 applications, 1 resource, 1 skipped (BusinessProcess warned), {r['relations']} relations; source {r['model']!r}"
step("j  ArchiMate exchange import", j_)

# ---------- k. packs ----------
def k():
    s, packs = get("/standards/packs"); assert s == 200, packs
    ids = [p["id"] for p in packs]; assert ids == ["archigov-core", "archigov-governance-starter", "azure-waf-architecture", "dora-ict-architecture", "ai-act-annex-iv-design"], ids
    s, r = post("/standards/packs/azure-waf-architecture/import"); assert s == 200 and r["imported"] == 8 and r["lifecycle"] == "draft", r; mutations.append("pack azure-waf-architecture (8 standards, drafts)")
    s, r2 = post("/standards/packs/dora-ict-architecture/import"); assert s == 200 and r2["imported"] == 5, r2; mutations.append("pack dora-ict-architecture (5)")
    s, r3 = post("/standards/packs/ai-act-annex-iv-design/import"); assert s == 200 and r3["imported"] == 5, r3; mutations.append("pack ai-act-annex-iv-design (5)")
    s, ev = post("/evaluate"); assert s == 200 and ev.get("rule_errors") == [], ev.get("rule_errors")
    s, stds = get("/standards"); waf = [x for x in stds if x["code"].startswith("STD-WAF-")]
    assert len(waf) == 8 and all(x["verification"] == "unverified" and x["lifecycle"] == "draft" for x in waf), [(x["code"], x["verification"], x["lifecycle"]) for x in waf]
    # drafts are not evaluated, so every imported rule is checked through its pre-review preview instead
    checked = 0
    for x in stds:
        if x["code"] in r["codes"] + r2["codes"] + r3["codes"] and x.get("rule"):
            s, pv = get(f"/artefacts/{x['id']}/preview"); assert s == 200, pv
            rv = next((c for c in pv["checks"] if c["name"] == "Rule is valid"), None); assert rv and rv["state"] == "pass", (x["code"], pv["checks"])
            checked += 1
    assert checked >= 10, checked
    return f"5 packs listed; imported 8 + 5 + 5 artefacts as drafts; {checked} rules validated by preview; evaluate ran with no rule errors"
step("k  standards packs: list, import as drafts, every rule valid", k)

# ---------- l. runs ----------
def l():
    s, conf = get("/conformance"); runs = conf["runs"]
    syncs = [r for r in runs if r.get("kind") == "sync"]
    names = {r.get("source_name") for r in syncs}
    for want in ["Microsoft Defender for Cloud", "Azure Policy"]: assert want in names, f"{want} missing from {names} (the Azure Resource Graph run was checked in step b; the list keeps only recent runs)"
    assert any(r.get("source_name") and "DevOps" in r["source_name"] for r in syncs), names
    return f"{len(syncs)} recent sync runs incl. {sorted(n for n in names if n)[:4]}"
step("l  runs record each integration sync with its source", l)

# ---------- summary ----------
passed = sum(1 for _, ok in results if ok); failed = len(results) - passed
print(f"\n{passed} passed, {failed} failed  ({BASE})")
if mutations: print("mutations made to the tenant: " + "; ".join(mutations))
sys.exit(1 if failed else 0)
PY
