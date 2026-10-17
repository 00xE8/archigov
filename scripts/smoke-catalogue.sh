#!/usr/bin/env bash
# archigov governance-catalogue smoke test — standards, principles, patterns and policies through one engine, via the API.
#
#   scripts/smoke-catalogue.sh [base_url]     default http://localhost:8080
#
# Run it against a FRESH seeded instance (SEED_DEMO=true). It MUTATES the tenant (new drafts, a revised pattern,
# a retired policy, imported artefacts, the governance starter pack); reset with `docker compose down -v && docker compose up -d`.
set -u
BASE="${1:-http://localhost:8080}"
command -v python3 >/dev/null || { echo "python3 is required"; exit 2; }

python3 - "$BASE" <<'PY'
import json, sys
import urllib.request, urllib.error

BASE = sys.argv[1].rstrip("/") + "/api"
# the catalogue is authored: every step acts as the seeded author (an unknown x-user would be a platform admin
# only, which imports packs but never drafts, revises, retires or verifies an artefact)
HDR = {"x-user": "s.patel", "Content-Type": "application/json"}

def call(method, path, body=None, headers=None, raw=None):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(BASE + path, data=data, headers={**HDR, **(headers or {})}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            payload = r.read(); ct = r.headers.get("Content-Type", "")
            return r.status, (json.loads(payload) if "json" in ct and payload else payload.decode(errors="replace"))
    except urllib.error.HTTPError as e:
        payload = e.read()
        try: return e.code, json.loads(payload) if payload else None
        except Exception: return e.code, payload.decode(errors="replace")

get = lambda p, **k: call("GET", p, **k)
post = lambda p, b=None, **k: call("POST", p, {} if b is None else b, **k)
put = lambda p, b=None, **k: call("PUT", p, {} if b is None else b, **k)

results, ctx, mutations = [], {}, []
def step(label, fn):
    try:
        detail = fn() or ""
        results.append((label, True)); print(f"PASS  {label}" + (f"  — {detail}" if detail else ""))
    except AssertionError as e:
        results.append((label, False)); print(f"FAIL  {label}  — {e}")
    except Exception as e:
        results.append((label, False)); print(f"FAIL  {label}  — {type(e).__name__}: {e}")

def by_code(code):
    s, rows = get("/standards"); assert s == 200, rows
    row = next((x for x in rows if x["code"] == code), None); assert row, f"{code} not in catalogue"
    return row

# ---------- a. kinds ----------
def a():
    s, h = get("/health"); assert s == 200 and h.get("ok"), f"health {s} {h}"
    s, kinds = get("/artefacts/kinds"); assert s == 200, kinds
    k = {x["kind"]: x for x in kinds}
    assert [x["kind"] for x in kinds] == ["standard", "principle", "pattern", "policy"], kinds
    assert all(x["prefix"] for x in kinds) and all(x["description"] for x in kinds)
    assert k["standard"]["adopted"] >= 12 and k["principle"]["adopted"] >= 1 and k["pattern"]["adopted"] >= 1 and k["policy"]["adopted"] >= 1, {x: (k[x]["count"], k[x]["adopted"]) for x in k}
    assert k["policy"]["drafts"] >= 1, "the demo seeds a draft policy (POL-002)"
    ctx["adopted_std"] = k["standard"]["adopted"]
    return "; ".join(f"{x}: {k[x]['adopted']} adopted / {k[x]['count']} total" for x in k)
step("a  four kinds listed with counts", a)

# ---------- b. overview ----------
def b():
    s, ov = get("/overview"); c = ov["counts"]
    a = c["artefacts"]; assert a["standard"] == ctx["adopted_std"] and a["principle"] >= 1 and a["pattern"] >= 1 and a["policy"] >= 1, a
    assert c["standards"] == c["artefacts"]["standard"] and c["drafts_in_review"] >= 1, c
    return f"counts.artefacts={c['artefacts']}, drafts_in_review={c['drafts_in_review']}"
step("b  overview counts artefacts by kind", b)

# ---------- c. create a pattern ----------
def c_():
    s, r = post("/artefacts", {"kind": "pattern", "title": "Smoke pattern: queue between services", "category": "Integration", "statement": "Services exchange work through a queue, never by direct call."})
    assert s == 400 and "context" in json.dumps(r), f"a pattern without context/solution must be rejected: {s} {r}"
    s, r = post("/artefacts", {"kind": "pattern", "title": "Smoke pattern: queue between services", "category": "Integration", "statement": "Services exchange work through a queue, never by direct call.",
                               "context": "Synchronous calls couple release cadences.", "solution": "Publish to a queue; consumers scale independently.", "applicability": "Internal integrations", "control_refs": ["Azure WAF Reliability: decoupling"]})
    assert s == 200 and r["code"].startswith("PAT-") and len(r["code"]) == 7 and r["lifecycle"] == "draft", f"{s} {r}"
    ctx["pat"] = r; mutations.append(f"pattern {r['code']} (draft)")
    row = by_code(r["code"]); assert row["kind"] == "pattern" and row["version"] == 1 and row["context"], row
    return f"{r['code']} created as a draft (missing narrative was rejected with 400)"
step("c  create a draft pattern (narrative required)", c_)

# ---------- d. create a policy ----------
def d():
    s, r = post("/artefacts", {"kind": "policy", "title": "Smoke policy: every application has an owner tag", "category": "Governance", "statement": "x"})
    assert s == 400 and "enforcement" in json.dumps(r), f"{s} {r}"
    s, r = post("/artefacts", {"kind": "policy", "enforcement": "mandatory", "title": "Smoke policy: every application has an owner tag", "category": "Governance", "statement": "Every application carries an owner tag on its resources.",
                               "control_refs": ["ISO 27001 A.5.9"], "rule": {"scope": "application", "assert": {"op": "hasOwnerTag"}}})
    assert s == 200 and r["code"].startswith("POL-") and r["lifecycle"] == "draft", f"{s} {r}"
    ctx["pol"] = r; mutations.append(f"policy {r['code']} (draft)")
    return f"{r['code']} created as a draft (missing enforcement was rejected with 400)"
step("d  create a draft policy (enforcement required)", d)

# ---------- e. preview ----------
def e():
    s, pv = get(f"/artefacts/{ctx['pol']['id']}/preview"); assert s == 200, pv
    names = [c["name"] for c in pv["checks"]]
    for want in ["Rule is valid", "Control references", "Unique title", "Control references overlap", "Enforcement"]: assert want in names, names
    assert isinstance(pv["ok"], bool) and set(pv["impact"]) == {"findings", "applications", "sample"}, pv
    overlap = next(c for c in pv["checks"] if c["name"] == "Control references overlap")
    assert overlap["state"] == "warn" and "STD-005" in overlap["detail"], overlap  # STD-005 shares ISO 27001 A.5.9
    pol1 = by_code("POL-001"); s, pv1 = get(f"/artefacts/{pol1['id']}/preview"); assert s == 200 and pv1["impact"]["findings"] >= 1, pv1["impact"]
    return f"draft policy: ok={pv['ok']}, {len(pv['checks'])} checks, overlap warns about STD-005; POL-001 preview shows {pv1['impact']['findings']} finding(s) on {pv1['impact']['applications']} application(s)"
step("e  pre-review preview: checks and impact", e)

# ---------- f. findings by kind ----------
def f():
    s, run = post("/evaluate"); assert s == 200 and run.get("rule_errors") == [], run
    bk = run["by_kind"]; assert bk["pattern"] >= 1 and bk["policy"] >= 1 and bk["standard"] >= 10 and bk["principle"] == 0, bk
    pat = by_code("PAT-001"); pol = by_code("POL-001")
    assert pat["open_findings"] >= 2, f"PAT-001 should flag the demo's untagged public IPs, got {pat['open_findings']}"
    assert pol["open_findings"] >= 1, f"POL-001 should flag the undecided AI system, got {pol['open_findings']}"
    s, det = get(f"/artefacts/{pat['id']}"); assert s == 200 and det["kind"] == "pattern" and len(det["findings"]) >= 2, det.get("findings")
    s, conf = get("/conformance"); last = conf["runs"][0]; assert last["stats"]["by_kind"]["pattern"] >= 1, last["stats"]
    return f"evaluated by kind {bk}; PAT-001 {pat['open_findings']} open, POL-001 {pol['open_findings']} open"
step("f  adopted artefacts of every kind run through the same engine", f)

# ---------- g. revise an adopted artefact ----------
def g():
    pat = by_code("PAT-001")
    s, r = put(f"/artefacts/{pat['id']}", {"statement": pat["statement"] + " (revised in the smoke test)"}); assert s == 200, f"{s} {r}"
    assert r["revised"] is True and r["version"] == 2 and r["lifecycle"] == "draft", r
    mutations.append("PAT-001 revised → draft v2")
    s, run = post("/evaluate"); assert run["by_kind"]["pattern"] == 0, run["by_kind"]
    assert by_code("PAT-001")["open_findings"] == 0, "a draft revision is not evaluated; its findings resolve"
    return "PAT-001 → draft v2; no longer evaluated until adopted again"
step("g  editing an adopted artefact makes a new draft version", g)

# ---------- h. retire ----------
def h():
    pol = by_code("POL-001")
    s, r = post(f"/artefacts/{pol['id']}/retire"); assert s == 200 and r["lifecycle"] == "retired" and r["retired_at"], f"{s} {r}"
    s, r2 = post(f"/artefacts/{pol['id']}/retire"); assert s == 409, f"retiring twice should be 409, got {s}"
    s, r3 = post(f"/artefacts/{ctx['pol']['id']}/retire"); assert s == 409, f"retiring a draft should be 409, got {s}"
    post("/evaluate"); assert by_code("POL-001")["open_findings"] == 0
    mutations.append("POL-001 retired")
    return "POL-001 retired (second retire and retiring a draft → 409); its findings resolved"
step("h  retire an adopted artefact", h)

# ---------- i. CSV import ----------
def i():
    s, tpl = get("/import/artefacts/template.csv"); assert s == 200 and tpl.startswith("kind,title,category"), tpl[:80]
    s, r = post("/import/artefacts/csv", {"csv": tpl, "file": "smoke.csv"}); assert s == 200 and r["created"] == 2 and r["errors"] == [], r
    s, bad = post("/import/artefacts/csv", {"csv": "kind,title,statement\ngadget,Nope,x\n"}); assert s == 200 and bad["created"] == 0 and bad["errors"][0]["line"] == 2, bad
    mutations.append(f"CSV artefacts {r['codes']}")
    for code in r["codes"]: assert by_code(code)["lifecycle"] == "draft"
    return f"template imported {r['codes']} as drafts; a bad kind is reported by line"
step("i  CSV artefact import", i)

# ---------- j. JSON import ----------
def j_():
    s, r = post("/import/artefacts", [{"kind": "principle", "title": "Smoke principle: automate the boring parts", "category": "Principle", "statement": "If a check can be automated it is."},
                                       {"kind": "pattern", "title": "Smoke broken pattern", "category": "x", "statement": "no narrative"}])
    assert s == 200 and r["created"] == 1 and len(r["errors"]) == 1 and r["errors"][0]["index"] == 1, r
    mutations.append(f"JSON artefact {r['codes']}")
    return f"1 created ({r['codes'][0]}), 1 rejected (pattern without narrative)"
step("j  JSON artefact import", j_)

# ---------- k. ArchiMate motivation ----------
def k():
    xml = """<model xmlns="http://www.opengroup.org/xsd/archimate/3.0/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" identifier="id-smoke-gov"><name>Smoke governance model</name><elements>
      <element identifier="id-p1" xsi:type="Principle"><name>Smoke: reuse before buy before build</name></element>
      <element identifier="id-c1" xsi:type="Constraint"><name>Smoke: clinical data never leaves the tenant</name></element>
      <element identifier="id-r1" xsi:type="Requirement"><name>Smoke: 99.9% availability</name></element>
    </elements></model>"""
    s, r = post("/import/archimate", raw=xml.encode(), headers={"Content-Type": "application/xml"}); assert s == 200, f"{s} {r}"
    assert r["artefacts"] == {"principle": 1, "policy": 1, "skipped": 0}, r["artefacts"]
    assert any("Requirement" in w for w in r["warnings"]), r["warnings"]
    pol = next(x for x in get("/standards")[1] if x["title"] == "Smoke: clinical data never leaves the tenant")
    assert pol["kind"] == "policy" and pol["lifecycle"] == "draft" and pol["enforcement"] == "mandatory", pol
    mutations.append("ArchiMate motivation: 1 principle, 1 policy (drafts)")
    return "Principle → draft principle, Constraint → draft mandatory policy, Requirement reported"
step("k  ArchiMate motivation elements import into the catalogue", k)

# ---------- l. starter pack ----------
def l():
    s, packs = get("/standards/packs"); assert s == 200, packs
    starter = next((p for p in packs if p["id"] == "archigov-governance-starter"), None); assert starter, [p["id"] for p in packs]
    assert starter["lifecycle_on_import"] == "draft" and starter["kinds"] == {"principle": 3, "pattern": 2, "policy": 2}, starter
    core = next(p for p in packs if p["id"] == "archigov-core"); assert core["lifecycle_on_import"] == "adopted", core
    s, r = post("/standards/packs/archigov-governance-starter/import"); assert s == 200 and r["imported"] == 7 and r["lifecycle"] == "draft", r
    mutations.append("pack archigov-governance-starter (7 drafts)")
    rows = {x["code"]: x for x in get("/standards")[1]}
    for code in r["codes"]: assert rows[code]["lifecycle"] == "draft", (code, rows[code]["lifecycle"])
    s, pv = get(f"/artefacts/{rows['PAT-GOV-01']['id']}/preview"); assert s == 200 and next(c for c in pv["checks"] if c["name"] == "Rule is valid")["state"] == "pass", pv["checks"]
    s, again = post("/standards/packs/archigov-governance-starter/import"); assert again["imported"] == 0 and again["skipped"] == 7, again
    return "7 artefacts imported as drafts (3 principles, 2 patterns, 2 policies); PAT-GOV-01's rule previews valid; re-import skipped"
step("l  governance starter pack imports as drafts", l)

# ---------- m. aliases ----------
def m():
    s, rows = get("/standards"); kinds = {x["kind"] for x in rows}; assert kinds == {"standard", "principle", "pattern", "policy"}, kinds
    s, pol = get(f"/standards/{ctx['pol']['id']}"); assert s == 200 and pol["kind"] == "policy" and "findings" in pol, pol
    s, r = post("/standards", {"title": "Smoke alias standard", "category": "Smoke", "statement": "x", "control_refs": ["X 1"]}); assert s == 200 and r["code"].startswith("STD-") and r["lifecycle"] == "draft", r
    mutations.append(f"standard {r['code']} (draft, via /standards alias)")
    s, v = post(f"/standards/{r['id']}/verify"); assert s == 200 and v["ok"], v
    s, k = get("/standards?kind=principle"); assert s == 200 and all(x["kind"] == "principle" for x in k) and len(k) >= 2, [x["code"] for x in k]
    return f"/standards lists every kind; detail, create ({r['code']}), verify and ?kind= all work through the alias"
step("m  /standards aliases keep working", m)

passed = sum(1 for _, ok in results if ok); failed = len(results) - passed
print(f"\n{passed} passed, {failed} failed  ({BASE})")
print("mutations made to the demo tenant: " + "; ".join(mutations))
sys.exit(1 if failed else 0)
PY
