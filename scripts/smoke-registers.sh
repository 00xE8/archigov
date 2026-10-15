#!/usr/bin/env bash
# Archigov registers smoke test — criticality classification (derived from tags, set by a person with a reason, reset,
# verified, read by rules as app.*), the business-service dependency map and the DORA register's criticality column;
# the legacy register (lifecycle states, a person's version correction, the yearly legacy assessment); third parties
# (providers, concentration on a designated critical third party, exit plans into the DORA register); the roadmap
# built from records (decision realisation, lanes, per-application view), end to end
# through the API of a LOCAL-mode seeded instance.
#
#   scripts/smoke-registers.sh [base_url]   default http://localhost:8080
#
# Run after smoke-work.sh on the same instance (before smoke-catalogue.sh). The default x-user ("smoke-registers") is
# a platform admin ONLY and must be refused every classification change; authors act as the seeded cast. MUTATES the
# tenant (a classification set and reset, a verification, a draft standard, a version set and reset, a legacy
# assessment, an exit plan); reset with
# `docker compose down -v && docker compose up -d`.
set -u
BASE="${1:-http://localhost:8080}"
command -v python3 >/dev/null || { echo "python3 is required"; exit 2; }

python3 - "$BASE" <<'PY'
import json, sys
import urllib.request, urllib.error

BASE = sys.argv[1].rstrip("/") + "/api"
ADMIN = "smoke-registers"

def call(method, path, body=None, user=ADMIN, raw=False):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, headers={"x-user": user, "Content-Type": "application/json"}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            b = r.read(); return r.status, (b.decode() if raw else (json.loads(b) if b else None))
    except urllib.error.HTTPError as e:
        b = e.read()
        try: return e.code, json.loads(b) if b else None
        except Exception: return e.code, b.decode(errors="replace")
get = lambda p, user=ADMIN, raw=False: call("GET", p, None, user, raw)
post = lambda p, b=None, user=ADMIN: call("POST", p, {} if b is None else b, user)
put = lambda p, b, user=ADMIN: call("PUT", p, b, user)

results, ctx, mutations = [], {}, []
def step(label, fn):
    try:
        detail = fn() or ""
        results.append((label, True)); print(f"PASS  {label}" + (f"  — {detail}" if detail else ""))
    except AssertionError as e:
        results.append((label, False)); print(f"FAIL  {label}  — {e}")
    except Exception as e:
        results.append((label, False)); print(f"FAIL  {label}  — {type(e).__name__}: {e}")

def apps():
    s, a = get("/applications"); assert s == 200, f"{s} {a}"; return {x["name"]: x for x in a}
def cls(name):
    s, a = get(f"/applications/{apps()[name]['id']}"); assert s == 200, f"{s} {a}"; return a["classification"]

# ---------- a. derived from tags ----------
def a():
    A = apps(); assert all(x.get("classification") for x in A.values()), "every application carries a classification (possibly unclassified)"
    pf = A["PatientFlow"]["classification"]
    assert pf["criticality"] == "critical" and pf["regulated"] is True and pf["origin"] == "derived" and pf["verification"] == "verified", pf
    assert A["Pharmacy"]["classification"]["criticality"] is None, A["Pharmacy"]["classification"]
    d = cls("Appointments"); assert d["criticality"] == "important" and d["method"] == "tag:criticality" and d["evidence"], d
    tiers = {}
    for x in A.values(): tiers[x["classification"]["criticality"] or "unclassified"] = tiers.get(x["classification"]["criticality"] or "unclassified", 0) + 1
    return ", ".join(f"{k} {v}" for k, v in sorted(tiers.items())) + "; PatientFlow critical (IBS, verified by the seed)"
step("a  classification derived from tags, with method and evidence", a)

# ---------- b. who may classify ----------
BODY = {"criticality": "critical", "services": [{"name": "Dispense medicines", "kind": "cif"}], "reason": "Dispensing is a critical function under our DORA mapping."}
def b():
    pid = apps()["Pharmacy"]["id"]; ctx["pharmacy"] = pid
    for u in (ADMIN, "a.uditor", "m.hughes"):
        s, r = put(f"/applications/{pid}/classification", BODY, user=u); assert s == 403, f"{u}: {s} {r}"
    s, r = put(f"/applications/{pid}/classification", {**BODY, "reason": "short"}, user="s.patel"); assert s == 400, f"reason: {s} {r}"
    s, r = put(f"/applications/{pid}/classification", {**BODY, "criticality": "important"}, user="s.patel"); assert s == 400 and "critical" in json.dumps(r), f"regulated ⇒ critical: {s} {r}"
    s, r = post(f"/applications/{pid}/classification/suggest", user="s.patel"); assert s == 409, f"AI off ⇒ 409: {s} {r}"
    return "platform admin, auditor and a seat-only decision maker 403; short reason and regulated-but-important 400; AI suggestion 409 while off"
step("b  classifying is an author's act, with a reason", b)

# ---------- c. set by a person, survives re-evaluation ----------
def c_():
    s, r = put(f"/applications/{ctx['pharmacy']}/classification", BODY, user="s.patel"); assert s == 200, f"{s} {r}"
    mutations.append("Pharmacy classified critical (CIF Dispense medicines)")
    assert r["origin"] == "human" and r["verification"] == "verified" and r["set_by"] == "s.patel" and r["derived"]["criticality"] is None, r
    s, run = post("/evaluate", user="s.patel"); assert s == 200, f"{s} {run}"
    k = cls("Pharmacy"); assert k["origin"] == "human" and k["criticality"] == "critical", k
    s, au = get(f"/audit?entity=applications&entity_id={ctx['pharmacy']}&action=classification:set"); assert s == 200 and au["rows"] and au["rows"][0]["actor"] == "s.patel", au
    return "origin human, verified by the setter, audited; a conformance run keeps it"
step("c  a person's classification is kept across evaluation", c_)

# ---------- d. business services and the DORA register ----------
def d():
    s, bs = get("/business-services", user="a.uditor"); assert s == 200, f"{s} {bs}"
    svc = next((x for x in bs["services"] if x["name"] == "Dispense medicines"), None)
    assert svc and svc["kind"] == "cif" and svc["regulated"] and [x["name"] for x in svc["applications"]] == ["Pharmacy"], svc
    assert not any(x["name"] == "Pharmacy" for x in bs["unclassified"]), bs["unclassified"]
    admit = next(x for x in bs["services"] if x["name"] == "Admit and discharge patients"); assert admit["regions"] and admit["resources"] > 0, admit
    s, csv = get("/exports/dora-roi.csv", user="a.uditor", raw=True); assert s == 200, s
    rows = [l for l in csv.splitlines() if ctx["pharmacy"] in l]; assert rows and all("Dispense medicines" in l and "Critical or important" in l for l in rows), rows[:1]
    return f"{len(bs['services'])} service(s), {bs['counts']['critical']} critical app(s); Pharmacy now behind CIF 'Dispense medicines' and critical in the DORA register"
step("d  the service map and the DORA register follow the classification", d)

# ---------- e. rules read app.* ----------
def e():
    rule = {"scope": "resource", "match": {"type": "Microsoft.Storage/storageAccounts", "where": [{"path": "app.criticality", "op": "eq", "value": "critical"}]},
            "assert": {"path": "props.publicAccess", "op": "eq", "value": False}}
    s, r = post("/artefacts", {"kind": "standard", "title": "Smoke registers: critical applications keep storage private", "category": "Security", "statement": "Storage behind a critical application is never public.", "severity": "high", "rule": rule}, user="s.patel")
    assert s == 200 and r["lifecycle"] == "draft", f"{s} {r}"; mutations.append(f"standard {r['code']} (draft)")
    s, dr = get(f"/artefacts/{r['id']}/dry-run", user="s.patel"); assert s == 200, f"{s} {dr}"
    hit = sorted({f["application_name"] for f in dr["findings"]})
    assert "Pharmacy" in hit and "Referral API" in hit, hit
    crit = {n for n, x in apps().items() if x["classification"]["criticality"] == "critical"}
    assert set(hit) <= crit, f"only critical applications are matched: {hit} vs {crit}"
    return f"{r['code']} dry run flags public storage on {', '.join(hit)} — critical applications only"
step("e  a rule matched on app.criticality", e)

# ---------- f. reset and verify ----------
def f():
    s, r = post(f"/applications/{ctx['pharmacy']}/classification/reset", user="s.patel"); assert s == 200 and r["origin"] == "derived" and r["criticality"] is None and r["verification"] == "unverified", f"{s} {r}"
    s, r2 = post(f"/applications/{ctx['pharmacy']}/classification/reset", user="s.patel"); assert s == 409, f"already derived: {s} {r2}"
    iid = apps()["Intranet"]["id"]
    s, v = post(f"/applications/{iid}/classification/verify", {}, user="a.okafor"); assert s == 200 and v["verification"] == "verified" and v["verified_by"] == "a.okafor", f"{s} {v}"
    mutations.append("Intranet classification verified by a.okafor")
    s, v2 = post(f"/applications/{iid}/classification/verify", {}, user="ops.admin"); assert s == 403, f"platform admin verifies nothing: {s}"
    s, ch = get("/audit/verify"); assert ch["ok"] is True, ch
    return f"reset hands Pharmacy back to the tags (unclassified, 409 on repeat); Intranet verified; audit chain intact over {ch['rows']} rows"
step("f  reset to derived; verify; audit chain intact", f)

# ---------- g. the legacy register ----------
def g():
    s, lc = get("/lifecycle", user="a.uditor"); assert s == 200, f"{s} {lc}"
    assert lc["snapshot"]["source"] == "endoflife.date" and lc["counts"]["end_of_life"] >= 1, lc["counts"]
    w = next(c_ for c_ in lc["components"] if c_["key"] == "windows-server:2012-r2"); assert w["state"] == "end_of_life" and w["label"] == "2012 R2", w
    apps_ = {a_["name"]: a_ for a_ in lc["applications"]}
    assert apps_["Finance ERP"]["status"] == "current" and apps_["Pharmacy"]["status"] == "due", {k: v["status"] for k, v in apps_.items()}
    assert any(u["name"] == "app-appointments" for u in lc["unmatched"]), lc["unmatched"]
    return f"{lc['counts']['end_of_life']} end-of-life, {lc['counts']['extended']} extended, {lc['counts']['ending']} ending component(s); {lc['due']} application(s) due; Finance ERP assessed"
step("g  the legacy register: states from support dates, the seeded assessment, an unknown version", g)

def h():
    rid = next(u["id"] for u in get("/lifecycle", user="a.uditor")[1]["unmatched"] if u["name"] == "app-appointments")
    body = {"components": [{"product": "dotnet", "cycle": "6"}], "reason": "Runs .NET 6 on Windows; confirmed with the team."}
    for u in (ADMIN, "a.uditor"):
        s, r = put(f"/resources/{rid}/lifecycle", body, user=u); assert s == 403, f"{u}: {s} {r}"
    s, r = put(f"/resources/{rid}/lifecycle", body, user="s.patel"); assert s == 200 and r["origin"] == "human" and r["state"] == "end_of_life", f"{s} {r}"
    s, r = post(f"/resources/{rid}/lifecycle/reset", user="s.patel"); assert s == 200, f"{s} {r}"
    s, r = post(f"/resources/{rid}/lifecycle/reset", user="s.patel"); assert s == 409, f"already derived: {s} {r}"
    mutations.append("app-appointments version set and reset")
    pid = apps()["Pharmacy"]["id"]
    ab = {"result": "unsatisfactory", "summary_md": "Windows Server 2012 R2 is past ESU; isolate and replace by Q1.", "reference": "https://docs.example.org/pharmacy-legacy"}
    s, r = post(f"/applications/{pid}/legacy-assessments", ab); assert s == 403, f"platform admin: {s} {r}"
    s, r = post(f"/applications/{pid}/legacy-assessments", {**ab, "reference": "c:/x.docx"}, user="s.patel"); assert s == 400, f"a reference is a link: {s} {r}"
    s, r = post(f"/applications/{pid}/legacy-assessments", ab, user="s.patel"); assert s == 200 and r["status"] == "current", f"{s} {r}"
    mutations.append("Pharmacy legacy assessment (unsatisfactory)")
    s, r = post(f"/applications/{pid}/legacy-assessments/draft", user="s.patel"); assert s == 409, f"AI drafting off: {s} {r}"
    s, r = post("/lifecycle/refresh", user="s.patel"); assert s == 403, f"an author does not refresh the lifecycle data: {s} {r}"
    s, au = get(f"/audit?entity=applications&entity_id={pid}&action=legacy:assess"); assert au["rows"] and au["rows"][0]["actor"] == "s.patel", au["rows"][:1]
    return "a version set by an author (403 platform admin/auditor) and reset (409 on repeat); Pharmacy assessed → current, audited; draft 409 while AI is off; refresh is the platform admin's"
step("h  corrections and the yearly legacy assessment", h)

# ---------- i. third parties ----------
def i_():
    s, tp = get("/third-parties", user="a.uditor"); assert s == 200, f"{s} {tp}"
    ms = next(p for p in tp["providers"] if p["id"] == "microsoft"); assert ms["ctp"]["entity"] == "Microsoft Ireland Operations Limited", ms["ctp"]
    assert any(k["provider"] == "microsoft" for k in tp["concentration"]), tp["concentration"]
    assert any(p["id"] == "supplier:ledgerline" for p in tp["providers"]), [p["id"] for p in tp["providers"]]
    erp = apps()["Finance ERP"]["id"]
    body = {"provider": "supplier:ledgerline", "result": "satisfactory_with_remarks", "substitutability": "medium_complexity", "tested_at": "2026-09-01", "summary_md": "Move to the vendor's SaaS edition or a rival within two quarters.", "reference": "https://docs.example.org/erp-exit"}
    s, r = post(f"/applications/{erp}/exit-plans", body); assert s == 403, f"platform admin: {s} {r}"
    s, r = post(f"/applications/{erp}/exit-plans", {**body, "provider": "aws"}, user="s.patel"); assert s == 400, f"not relied on: {s} {r}"
    s, r = post(f"/applications/{erp}/exit-plans", body, user="s.patel"); assert s == 200 and next(p for p in r if p["provider"] == "supplier:ledgerline")["exit"]["status"] == "current", f"{s} {r}"
    mutations.append("Finance ERP exit plan for Ledgerline")
    s, csv = get("/exports/dora-roi.csv", user="a.uditor", raw=True)
    assert any(erp in l and "Ledgerline" in l and "Medium complexity in terms of substitutability" in l for l in csv.splitlines()), "the supplier row carries the plan's substitutability"
    s, r = put("/third-parties/ctp", {"instrument": "x", "entries": []}, user="s.patel"); assert s == 403, f"an author does not edit the designations: {s} {r}"
    return f"{tp['counts']['critical_on_ctp']} critical application(s) on a designated CTP; Ledgerline exit plan recorded and in the DORA register; designations are the platform admin's"
step("i  third parties: concentration, exit plans, the DORA register", i_)

# ---------- j. the roadmap ----------
def j_():
    s, rm = get("/roadmap", user="a.uditor"); assert s == 200, f"{s} {rm}"
    items = [dict(i, lane=l) for l, xs in rm["lanes"].items() for i in xs]
    assert rm["counts"]["total"] == len(items) and all(rm["counts"][l] == len(rm["lanes"][l]) for l in ("now", "next", "later", "done")), rm["counts"]
    adr = {i["code"]: i for i in items if i["kind"] == "decision"}
    assert adr["ADR-0002"]["status"] in ("in_progress", "realised") and adr["ADR-0002"]["progress"]["total"] >= 1, adr["ADR-0002"]
    assert adr["ADR-0005"]["lane"] == "done" and adr["ADR-0001"]["status"] == "not_checkable", (adr["ADR-0005"], adr["ADR-0001"]["status"])
    assert any(i["kind"] == "lifecycle" and i["lane"] == "now" for i in items), "end-of-life upgrades are due now"
    pid = apps()["Pharmacy"]["id"]
    s, one = get(f"/roadmap?application={pid}", user="a.uditor"); assert s == 200 and one["application"]["name"] == "Pharmacy", one.get("application")
    assert all(any(a_["id"] == pid for a_ in i["applications"]) or (i["kind"] == "decision" and not i["applications"]) for l in one["lanes"].values() for i in l)
    s, x = get("/roadmap?application=nope", user="a.uditor"); assert s == 404, s
    return f"{rm['counts']['now']} now · {rm['counts']['next']} next · {rm['counts']['later']} later · {rm['counts']['done']} done; ADR-0002 {adr['ADR-0002']['status']} ({adr['ADR-0002']['progress']['done']}/{adr['ADR-0002']['progress']['total']}); Pharmacy's own roadmap"
step("j  the roadmap: built from records, by lane, per application", j_)

passed = sum(1 for _, ok in results if ok); failed = len(results) - passed
print(f"\n{passed} passed, {failed} failed  ({BASE})")
if mutations: print("mutations made to the demo tenant: " + "; ".join(mutations))
sys.exit(1 if failed else 0)
PY
