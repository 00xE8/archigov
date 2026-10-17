#!/usr/bin/env bash
# archigov smoke test — the end-to-end flow from CLAUDE.md ("Run / build / test"), driven through the API.
#
#   scripts/smoke.sh [base_url]          default http://localhost:8080
#
# Runs against a fresh demo tenant (SEED_DEMO=true). Prints PASS/FAIL per step and exits non-zero on any FAIL.
# It MUTATES the demo tenant (a review, an ADR, verification, a perturbed resource, two standards); reset with
# `docker compose down -v && docker compose up -d` or by deleting the data dir.
set -u
BASE="${1:-http://localhost:8080}"
command -v python3 >/dev/null || { echo "python3 is required"; exit 2; }

python3 - "$BASE" <<'PY'
import json, re, sys, datetime
import urllib.request, urllib.error

BASE = sys.argv[1].rstrip("/") + "/api"
HDR = {"x-user": "smoke", "Content-Type": "application/json"}
TEMPLATE_SECTIONS = {"data", "security", "resilience", "oversight", "logging"}
ASSERTION = re.compile(r"\b(is|are|was|were|fully|now)\s+compliant\b|compliance\s+(passed|achieved|confirmed)|\bcertified\b|\bassured\b", re.I)

# The default local user ("smoke") is a platform admin ONLY: it runs sources, imports, evidence and the engine
# but never authors, verifies, approves or decides. Authoring acts as the seeded author, board actions as the
# seeded seats (j.duduka chairs the Design Authority and declares; m.hughes and p.osei are its decision makers,
# each recording positions on the areas they own). `user` overrides the acting user for one call.
AUTHOR, CHAIR, DM, DM2 = "s.patel", "j.duduka", "m.hughes", "p.osei"
def call(method, path, body=None, user=None):
    data = json.dumps(body).encode() if body is not None else None
    hdr = dict(HDR)
    if user: hdr["x-user"] = user
    req = urllib.request.Request(BASE + path, data=data, headers=hdr, method=method)
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try: return e.code, json.loads(raw) if raw else None
        except Exception: return e.code, raw.decode(errors="replace")

get = lambda p, user=None: call("GET", p, None, user)
post = lambda p, b=None, user=None: call("POST", p, {} if b is None else b, user)
put = lambda p, b, user=None: call("PUT", p, b, user)

results, ctx, mutations = [], {}, []
def step(label, fn):
    try:
        detail = fn() or ""
        results.append((label, True)); print(f"PASS  {label}" + (f"  — {detail}" if detail else ""))
    except AssertionError as e:
        results.append((label, False)); print(f"FAIL  {label}  — {e}")
    except Exception as e:
        results.append((label, False)); print(f"FAIL  {label}  — {type(e).__name__}: {e}")

def headings(md): return {m.group(1).lower().strip() for m in re.finditer(r"^#{1,6}\s+(.+?)\s*#*\s*$", md or "", re.M)}
def in_days(n): return (datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=n)).strftime("%Y-%m-%dT%H:%M:%SZ")

# ---------- setup ----------
def setup():
    s, h = get("/health"); assert s == 200 and h.get("ok"), f"health {s} {h}"
    s, me = get("/auth/me"); assert me["user"]["user_type"] is None and me["user"]["is_platform_admin"] is True, f"the default local user must be a platform admin only: {me.get('user')}"
    s, apps = get("/applications"); assert s == 200
    app = next((a for a in apps if a["name"] == "Referral API"), None); assert app, "demo application 'Referral API' not found — is the demo tenant seeded?"
    ctx["app"] = app["id"]
    return f"{len(apps)} applications, target Referral API {app['id'][:8]}; default user is a platform admin only"
step("0  demo tenant reachable", setup)

# ---------- a. low-risk review ----------
def a():
    design = "## Design\n\nAdd a read replica for reporting queries.\n\n## Security\n\nNo change to the exposure of the service."
    body = {"title": "Smoke: read replica for Referral API", "application_id": ctx["app"], "risk_tier": "low", "summary": "Smoke-test review", "design_md": design}
    s, r = post("/reviews", body); assert s == 403 and r.get("capability") == "submit_review", f"a platform admin must not submit reviews: {s} {r}"
    s, r = post("/reviews", body, user=AUTHOR)
    assert s == 200 and re.fullmatch(r"REV-\d{4}", r.get("code", "")), f"{s} {r}"
    ctx["review"], ctx["review_code"], ctx["design"] = r["id"], r["code"], design; mutations.append(f"review {r['code']}")
    s, rv = get(f"/reviews/{r['id']}"); assert rv["stage"] == "in_review", f"stage {rv['stage']} (expected in_review after the automatic pre-review)"
    assert rv["type"] == "design" and rv["board"] and rv["board"]["code"] == "DA", f"routing: type={rv.get('type')} board={rv.get('board')}"
    return r["code"] + " → in_review at " + rv["board"]["code"] + f" (submitted by {AUTHOR}; the platform admin got 403)"
step("a  submit low-risk review as an author", a)

# ---------- b. auto pre-review with resolving citations ----------
def b():
    s, rv = get(f"/reviews/{ctx['review']}")
    ev = [e for e in rv["events"] if e["kind"] == "pre_review"]; assert ev, "no pre_review event"
    e = ev[0]; assert e["origin"] in ("rules", "ai"), e["origin"]
    assert e["verification"] == "unverified", f"pre-review stored as {e['verification']} (machine output must never be stored verified)"
    findings = e["data"]["findings"]; assert findings, "pre-review produced no findings"
    std = {x["code"] for x in get("/standards")[1]}; dec = {x["code"] for x in get("/decisions")[1]}
    res = {r["source_ref"] for r in get(f"/applications/{ctx['app']}")[1]["resources"]}
    secs = TEMPLATE_SECTIONS | headings(ctx["design"])
    bad = []
    for f in findings:
        assert f["citations"], f"finding without citation: {f['title']}"
        for c in f["citations"]:
            ok = (c["kind"] == "standard" and c["ref"] in std) or (c["kind"] == "decision" and c["ref"] in dec) or (c["kind"] == "resource" and c["ref"].lower() in res) or (c["kind"] == "section" and c["ref"].lower() in secs)
            if not ok: bad.append(c)
    assert not bad, f"unresolved citations: {bad}"
    assert any(c["kind"] == "standard" for f in findings for c in f["citations"]), "no finding cites a standard"
    return f"{len(findings)} findings, origin={e['origin']}, all {sum(len(f['citations']) for f in findings)} citations resolve, recommendation={e['data']['recommendation']}"
step("b  auto pre-review: cited findings, unverified", b)

# ---------- c. data-store ADR with allowedTypes ----------
def c():
    s, r = post("/decisions", {"title": "Smoke: Referral API data store is PostgreSQL Flexible Server", "topic": "data-store",
        "constraint": {"allowedTypes": ["Microsoft.DBforPostgreSQL/flexibleServers"]}, "application_ids": [ctx["app"]], "origin": "ai"}, user=AUTHOR)
    assert s == 200 and re.fullmatch(r"ADR-\d{4}", r.get("code", "")), f"{s} {r}"
    ctx["adr"], ctx["adr_code"] = r["id"], r["code"]; mutations.append(f"decision {r['code']} (accepted)")
    s, d = get(f"/decisions/{r['id']}")
    assert d["origin"] == "human" and d["verification"] == "unverified", f"origin={d['origin']} verification={d['verification']} (client-supplied origin must be ignored)"
    assert d["constraint"]["allowedTypes"], "constraint not stored"
    return f"{r['code']} proposed, origin=human, unverified"
step("c  create data-store ADR with allowedTypes", c)

# ---------- d. accept ----------
def d():
    s, r = post(f"/decisions/{ctx['adr']}/status", {"status": "accepted"}); assert s == 403 and r.get("capability") == "set_decision_status", f"a platform admin must not accept decisions: {s} {r}"
    s, r = post(f"/decisions/{ctx['adr']}/status", {"status": "accepted"}, user=AUTHOR); assert s == 403, f"an author without a chair seat must not accept decisions: {s} {r}"
    s, r = post(f"/decisions/{ctx['adr']}/status", {"status": "accepted"}, user=CHAIR); assert s == 200, f"{s} {r}"
    s, dd = get(f"/decisions/{ctx['adr']}"); assert dd["status"] == "accepted" and dd["decided_at"], dd["status"]
    return f"{ctx['adr_code']} accepted by the chair at {dd['decided_at']} (platform admin and author got 403)"
step("d  accept the ADR", d)

# ---------- e. approve review with a condition ----------
def e():
    text = "Raise sql-referrals minimum TLS to 1.2 before go-live (smoke)"
    decision = {"outcome": "approved_with_conditions", "rationale": "Smoke approval", "conditions": [{"text": text, "owner": "smoke", "due_at": in_days(30)}]}
    # the Design Authority policy: one position per touched area from the decision maker owning it, then the chair
    # declares — in that order; the review touches security (its design section) plus what the app's resources add
    s, r = post(f"/reviews/{ctx['review']}/decide", decision, user=CHAIR)
    assert s == 403 and "outstanding" in (r.get("reason") or ""), f"the chair must be blocked until the policy is satisfied: {s} {r}"
    s, rv = get(f"/reviews/{ctx['review']}"); assert rv["progress"]["mode"] == "areas" and "security" in rv["areas"]["touched"], rv.get("areas")
    s, r = post(f"/reviews/{ctx['review']}/approvals", {"decision": "approve", "comment": "Looks fine (smoke)"}, user=DM)
    assert s == 200 and all(p["user_id"] == DM for p in r["positions"]) and r["progress"]["received"] >= 1, f"{s} {r}"
    # the areas the other decision maker owns, if the review touches any, are hers to record
    for a in r["progress"]["areas"]:
        if a["state"] == "missing":
            assert a["owners"] == [DM2], f"an unowned area: {a}"
            s, r2 = post(f"/reviews/{ctx['review']}/positions", {"area": a["area"], "position": "yes"}, user=DM2); assert s == 200, f"{s} {r2}"
    s, rv = get(f"/reviews/{ctx['review']}"); assert rv["progress"]["satisfied"], rv["progress"]
    s, r = post(f"/reviews/{ctx['review']}/decide", decision, user=CHAIR); assert s == 200, f"{s} {r}"
    s, rv = get(f"/reviews/{ctx['review']}")
    assert rv["stage"] == "approved_with_conditions", rv["stage"]
    cond = [x for x in rv["conditions"] if x["text"] == text]; assert cond and cond[0]["status"] == "open", rv["conditions"]
    assert any(a["user_id"] == DM and a["decision"] == "approve" and a["board_role"] == "decision_maker" and a["area"] for a in rv["approvals"]), rv["approvals"]
    ctx["condition"] = text; mutations.append(f"positions by {DM}/{DM2}, decision by {CHAIR} + 1 condition on that review")
    return f"chair blocked before the positions; {DM} (and {DM2} where she owns an area) recorded yes per area ({', '.join(rv['areas']['touched'])}); {CHAIR} → approved_with_conditions, condition open"
step("e  approve review with a condition", e)

# ---------- f. conformance: drift against the new ADR, "no decision" resolves ----------
def f():
    s, r = post("/evaluate"); assert s == 200 and "findings" in r, f"a platform admin may re-run the engine: {s} {r}"
    s, conf = get("/conformance")
    drift = [x for x in conf["decisionDrift"] if x["decision_id"] == ctx["adr"]]
    assert any(x["element_name"] == "sql-referrals" for x in drift), f"no drift finding for sql-referrals against {ctx['adr_code']}: {[x['element_name'] for x in drift]}"
    nodec = [x for x in conf["findings"] if x["standard_code"] == "STD-006" and x["application_id"] == ctx["app"]]
    assert not nodec, f"STD-006 'no decision' finding still present: {[x['status'] for x in nodec]}"
    assert any(x["text"] == ctx["condition"] for x in conf["conditions"]), "approval condition not visible in conformance"
    run = conf["runs"][0]
    return f"{len(drift)} drift finding(s) on {ctx['adr_code']}, STD-006 resolved for Referral API, condition listed; run: {run['stats'].get('findings')} open / {run['stats'].get('excepted')} excepted"
step("f  evaluate → ADR drift appears, 'no decision' resolves", f)

# ---------- g. verify-all ----------
def g():
    s, r = post(f"/applications/{ctx['app']}/verify-all"); assert s == 403 and r.get("capability") == "verify", f"a platform admin must not verify: {s} {r}"
    s, r = post(f"/applications/{ctx['app']}/verify-all", user=AUTHOR); assert s == 200, f"{s} {r}"
    s, app = get(f"/applications/{ctx['app']}")
    assert app["verification"] == "verified" and app["verified_by"] == AUTHOR, (app["verification"], app["verified_by"])
    for res in app["resources"]:
        assert res["verification"] == "verified" and res["verified_by"] == AUTHOR, f"{res['name']} {res['verification']} by {res['verified_by']}"
        assert res["verified_hash"] == res["content_hash"], f"{res['name']} verified_hash != content_hash"
        assert res["belongs"]["verification"] == "verified", f"belongs_to for {res['name']} not verified"
    mutations.append(f"verify-all on Referral API ({len(app['resources'])} resources)")
    return f"app + {len(app['resources'])} resources + their belongs_to verified by {AUTHOR} (platform admin got 403)"
step("g  verify-all on the application", g)

# ---------- h. resync with unchanged content keeps verification ----------
def h():
    s, r = post("/sources/demo/resync"); assert s == 200 and r.get("ok"), f"{s} {r}"
    assert r["stats"]["reverified_needed"] == 0, r["stats"]
    s, app = get(f"/applications/{ctx['app']}")
    assert all(res["verification"] == "verified" for res in app["resources"]), [(x["name"], x["verification"]) for x in app["resources"]]
    mutations.append("demo resync")
    return f"unchanged={r['stats']['unchanged']}, reverified_needed=0, all still verified"
step("h  demo resync keeps verification (unchanged hashes)", h)

# ---------- i. perturb a resource → drops to unverified, verifier cleared ----------
def i():
    s, r = post("/sources/demo/perturb", {"resourceName": "sql-referrals", "props": {"minTlsVersion": "1.2"}}); assert s == 200 and r.get("ok"), f"{s} {r}"
    assert r["stats"]["reverified_needed"] == 1, r["stats"]
    el = r["element"]; assert el["verification"] == "unverified", el
    assert el["verified_by"] is None and el["verified_at"] is None, f"stale verifier retained: {el}"
    s, app = get(f"/applications/{ctx['app']}")
    others = [x for x in app["resources"] if x["name"] != "sql-referrals"]
    assert all(x["verification"] == "verified" for x in others), [(x["name"], x["verification"]) for x in others]
    mutations.append("perturbed sql-referrals props.minTlsVersion → 1.2 (demo override, in-memory)")
    return "sql-referrals → unverified, verified_by/at cleared; other resources untouched"
step("i  perturb resource → verification drops, verifier cleared", i)

# ---------- j. audit trail ----------
def j():
    s, a = get("/audit"); rows = a["rows"]
    have = {(a["actor"], a["action"]) for a in rows}
    need = [(AUTHOR, "create"), (CHAIR, "status:accepted"), (DM, "position:yes"), (CHAIR, "decide:approved_with_conditions"), (AUTHOR, "verify_all"), ("smoke", "perturb"), ("smoke", "ingest"), ("smoke", "evaluate"), ("system", "pre_review")]
    missing = [n for n in need if n not in have]; assert not missing, f"missing audit rows: {missing}"
    roles = {(x["actor"], x["action"]): x.get("role") for x in rows}
    assert roles.get((CHAIR, "decide:approved_with_conditions")) == "author" and roles.get((DM, "position:yes")) == "decision_maker" and (roles.get(("smoke", "evaluate")) or "") == "platform_admin", roles
    return f"{len(rows)} recent rows; all expected actions present; rows carry author / decision_maker / platform_admin"
step("j  audit log records every mutation with who acted as what", j)

# ---------- k. evidence pack ----------
def k():
    s, pack = get(f"/evidence-pack?application={ctx['app']}"); assert s == 200, f"{s} {pack}"
    assert re.fullmatch(r"[0-9a-f]{64}", pack.get("hash", "")), f"no sha256 hash: {pack.get('hash')}"
    assert "disclaimer" in pack and "not assurance" in pack["disclaimer"].lower(), "disclaimer missing"
    m = ASSERTION.search(json.dumps(pack)); assert not m, f"assurance wording in pack: {m.group(0)!r}"
    assert pack["scope"] == "application" and len(pack["applications"]) == 1, pack["scope"]
    assert pack["audit_trail"], "empty audit trail"
    assert any(r.get("evidence") for r in pack["applications"][0]["resources"]), "no imported evidence in pack resources"
    s, a = get("/audit?action=export_evidence_pack")
    exp = [x for x in a["rows"] if x["details"].get("hash") == pack["hash"]]; assert exp, "export not audited with hash"
    return f"hash {pack['hash'][:12]}…, {len(pack['audit_trail'])} scoped audit rows, disclaimer present, no assertion wording"
step("k  evidence pack: hashed, scoped, disclaimed, no assurance", k)

# ---------- l. code generation: STD-nnn, no collision ----------
def l():
    codes = []
    for n in (1, 2):
        s, r = post("/standards", {"title": f"Smoke code-width test {n}", "category": "Smoke", "statement": "Temporary standard created by scripts/smoke.sh.", "severity": "low", "status": "hold"}, user=AUTHOR)
        assert s == 200, f"create #{n}: {s} {r}"
        codes.append(r["code"]); ctx.setdefault("smoke_stds", []).append(r["id"])
    assert all(re.fullmatch(r"STD-\d{3}", c) for c in codes), codes
    assert codes[0] != codes[1] and int(codes[1][4:]) == int(codes[0][4:]) + 1, codes
    mutations.append(f"standards {codes[0]}, {codes[1]} (status hold)")
    return f"{codes[0]}, {codes[1]}"
step("l  nextCode: STD-nnn, sequential, no collision", l)

# ---------- m. imported evidence drives the CSPM-class standards ----------
def m():
    s, app = get(f"/applications/{ctx['app']}")
    assert all(isinstance(r.get("evidence"), list) for r in app["resources"]), "resources lack evidence arrays"
    fails = [(r["name"], e["control"]) for r in app["resources"] for e in r["evidence"] if e["state"] == "fail"]
    assert fails, "no failing imported evidence on Referral API"
    s, conf = get("/conformance")
    f2 = [x for x in conf["findings"] if x["standard_code"] == "STD-002" and x["element_name"] == "streferralattach"]
    assert f2 and f2[0]["evidence"].get("source") == "defender" and f2[0]["evidence"].get("state") == "fail", f"STD-002 finding not evidence-based: {f2[:1]}"
    unknown = [x for x in conf["findings"] if x["evidence"].get("state") == "unknown"]
    assert any(x["element_name"] == "stpharmacyfiles" for x in unknown), "missing-evidence path not exercised (stpharmacyfiles should be unassessed)"
    s, apps = get("/applications"); ref = next(a for a in apps if a["id"] == ctx["app"])
    assert ref.get("evidence_fail_count", 0) >= len(fails), ref.get("evidence_fail_count")
    return f"{len(fails)} failing assessments on Referral API, STD-002 finding cites defender evidence, {len(unknown)} 'no evidence imported' finding(s)"
step("m  imported evidence (Defender/Policy) drives findings", m)

# ---------- n. shared services are not applications ----------
def n():
    s, ov = get("/overview"); names = [a["name"] for a in ov["byApp"]]
    assert "Network" not in names and not any("hub" in x.lower() for x in names), names
    assert ov["counts"].get("shared_services", 0) >= 1, ov["counts"]
    s, shared = get("/shared-services"); assert any(any(r["name"] == "vnet-hub" for r in x["resources"]) for x in shared), shared
    return f"{ov['counts']['applications']} applications, {ov['counts']['shared_services']} shared service(s): {[x['name'] for x in shared]}"
step("n  hub network is a shared service, not an application", n)

# ---------- o. a broken rule is an error, never a pass ----------
def o():
    # a rule that does not validate is refused at save time
    s, r = post("/standards", {"title": "Smoke: broken rule", "category": "Smoke", "statement": "Rule with an unknown op.", "severity": "low", "status": "adopt",
        "rule": {"scope": "resource", "match": {}, "assert": {"path": "name", "op": "bogus"}}}, user=AUTHOR); assert s == 400 and "bogus" in json.dumps(r), f"unknown op must be rejected at save: {s} {r}"
    # one that only fails at run time (an invalid regex) surfaces as a rule error on the run and on the standard — never as a pass;
    # `lifecycle: adopted` is the administrative bootstrap path, otherwise a new standard is a draft and is not evaluated
    s, r = post("/standards", {"title": "Smoke: rule failing at run time", "category": "Smoke", "statement": "Rule with an invalid regex.", "severity": "low", "status": "adopt", "lifecycle": "adopted",
        "rule": {"scope": "resource", "match": {"type": "Microsoft.Web/sites"}, "assert": {"path": "name", "op": "matches", "value": "("}}}, user=AUTHOR); assert s == 200 and r["lifecycle"] == "adopted", f"{s} {r}"
    code, sid = r["code"], r["id"]; mutations.append(f"standard {code} (run-time rule error, then deprecated)")
    s, run = post("/evaluate", user=AUTHOR); errs = {e["standard"]: e["message"] for e in run.get("rule_errors", [])}
    assert code in errs, f"rule error not reported: {run.get('rule_errors')}"
    s, stds = get("/standards"); me = next(x for x in stds if x["code"] == code)
    assert me["rule_error"] and me["open_findings"] == 0, (me["rule_error"], me["open_findings"])
    s, r = put(f"/standards/{sid}", {"status": "deprecated"}); assert s == 403, f"a platform admin must not edit standards: {s}"
    s, r = put(f"/standards/{sid}", {"status": "deprecated"}, user=AUTHOR); assert s == 200
    return f"unknown op → 400 at save; {code}: '{errs[code]}' surfaced on run + standard; no false pass"
step("o  invalid rule → 400 at save; run-time rule error → rule_error, not a silent pass", o)

# ---------- p. standards packs ----------
def p():
    s, packs = get("/standards/packs"); assert s == 200 and any(x["id"] == "archigov-core" for x in packs), f"{s} {packs}"
    core = next(x for x in packs if x["id"] == "archigov-core"); assert len(core["standards"]) == 5 and core["version"], core
    s, r = post("/standards/packs/archigov-core/import"); assert s == 200, f"a platform admin bootstraps packs: {s} {r}"
    assert r["imported"] == 0 and r["skipped"] == 5, r
    s, _ = post("/standards/packs/no-such-pack/import"); assert s == 404, s
    return f"archigov-core v{core['version']} lists {len(core['standards'])}; import on the seeded tenant → imported 0, skipped 5; unknown pack → 404"
step("p  standards packs: list + idempotent import", p)

# ---------- q. search ----------
def q():
    s, r = get("/search?q=referral"); assert s == 200, f"{s} {r}"
    assert any(a["name"] == "Referral API" for a in r["applications"]), r["applications"]
    assert r["resources"] and all("application_id" in x for x in r["resources"]), r["resources"][:2]
    s, e = get("/search?q=r"); assert all(v == [] for v in e.values()), e
    return f"q=referral → {len(r['applications'])} app(s), {len(r['resources'])} resources, {len(r['reviews'])} review(s); 1-char query → empty groups"
step("q  search finds the application and its resources", q)

# ---------- r. audit filters + facets ----------
def r_():
    s, a = get(f"/audit?actor={AUTHOR}&action=verify_all"); assert s == 200 and a["rows"], f"{s} {a}"
    assert all(x["actor"] == AUTHOR and x["action"] == "verify_all" for x in a["rows"]), a["rows"][:2]
    assert "verify_all" in a["facets"]["actions"] and AUTHOR in a["facets"]["actors"] and "application" in a["facets"]["entities"], a["facets"]
    s, lim = get("/audit?limit=2"); assert len(lim["rows"]) == 2, len(lim["rows"])
    s, ent = get(f"/audit?entity=decisions&entity_id={ctx['adr']}"); assert ent["rows"] and all(x["entity_id"] == ctx["adr"] for x in ent["rows"]), ent["rows"][:1]
    s, txt = get("/audit?q=perturb"); assert txt["rows"] and all("perturb" in json.dumps(x) for x in txt["rows"]), txt["rows"][:1]
    return f"actor+action → {len(a['rows'])} rows; {len(a['facets']['actions'])} action facets; limit, entity/entity_id and q filters honoured"
step("r  audit log: filters and facets", r_)

# ---------- s. evidence views ----------
def s_():
    s, summ = get("/evidence/summary"); assert s == 200 and summ["total"] > 0, f"{s} {summ}"
    d = next((x for x in summ["sources"] if x["source"] == "defender"), None); assert d, summ["sources"]
    assert d["pass"] > 0 and d["fail"] > 0 and d["controls"] > 0 and d["resources"] > 0 and d["last_import"] and isinstance(d["last_unmatched"], list), d
    s, rows = get("/evidence?source=defender&state=fail"); assert rows and all(x["source"] == "defender" and x["state"] == "fail" and x["resource_name"] for x in rows), rows[:1]
    assert any(x.get("application_name") for x in rows), "no application on evidence rows"
    s, one = get(f"/evidence?resource_id={rows[0]['resource_id']}"); assert one and all(x["resource_id"] == rows[0]["resource_id"] for x in one)
    s, imp = post("/evidence/import", {"source": "manual", "items": [{"resourceName": "no-such-resource", "control": "smoke-check", "state": "pass"}, {"resourceName": "sql-referrals", "control": "smoke-check", "state": "pass"}]})
    assert s == 200 and imp["unmatched"] == ["no-such-resource"] and imp["created"] == 1, imp
    mutations.append("manual evidence 'smoke-check' on sql-referrals")
    s, summ2 = get("/evidence/summary"); m = next(x for x in summ2["sources"] if x["source"] == "manual"); assert m["last_unmatched"] == ["no-such-resource"], m
    return f"{summ['total']} items; defender {d['pass']} pass / {d['fail']} fail over {d['resources']} resources, last import {d['last_import'][:16]}; import returns the unmatched list"
step("s  evidence: summary, filters, unmatched reported", s_)

# ---------- t. runs carry kind / source / deltas ----------
def t():
    s, conf = get("/conformance"); runs = conf["runs"]; assert runs, "no runs"
    ev = next(x for x in runs if x["kind"] == "evaluate"); sy = next((x for x in runs if x["kind"] == "sync"), None)
    assert all(k in ev["stats"] for k in ("opened", "resolved", "reopened")), ev["stats"]
    assert ev["source_name"] is None and ev["status"] and ev["started_at"], ev
    assert sy and sy["source_name"], f"no sync run with a source name: {sy}"
    return f"evaluate run: opened {ev['stats']['opened']} / resolved {ev['stats']['resolved']} / reopened {ev['stats']['reopened']}; sync run from '{sy['source_name']}'"
step("t  runs: kind, source, opened/resolved deltas", t)

# ---------- u. shared services ----------
def u():
    s, shared = get("/shared-services"); hub = next((x for x in shared if "hub" in x["name"].lower()), None); assert hub, shared
    assert hub["resource_count"] == 3 and isinstance(hub["used_by"], list) and hub["locations"], hub
    assert "verification" in hub and "origin" in hub, hub
    return f"{hub['name']}: {hub['resource_count']} resources in {hub['locations']}; used_by {[a['name'] for a in hub['used_by']] or 'none (no provider references point at it)'}"
step("u  shared services: counts, locations, used_by", u)

# ---------- v. a human closes a finding with a reason; it reopens on the next evaluation ----------
def v():
    s, conf = get("/conformance")
    f = next(x for x in conf["findings"] if x["standard_code"] == "STD-001" and x["status"] == "open"); fid = f["id"]
    s, r = post(f"/findings/{fid}/resolve", {"reason": "x"}); assert s == 403 and r.get("capability") == "resolve_finding", f"resolving a finding needs a board chair, got {s}"
    s, _ = post(f"/findings/{fid}/resolve", {"reason": "x"}, user=AUTHOR); assert s == 403, f"an author without a chair seat must not resolve findings, got {s}"
    s, _ = post(f"/findings/{fid}/resolve", {}, user=CHAIR); assert s == 400, f"resolve without a reason should be 400, got {s}"
    s, r = post(f"/findings/{fid}/resolve", {"reason": "Smoke: migration to UK South scheduled (epic 1081)"}, user=CHAIR); assert s == 200, f"{s} {r}"
    assert r["finding"]["status"] == "resolved" and r["finding"]["resolved_by"] == CHAIR and "epic 1081" in r["finding"]["resolution"], r["finding"]
    s, a = get(f"/audit?entity=findings&entity_id={fid}&action=resolve"); assert a["rows"] and "epic 1081" in a["rows"][0]["details"]["reason"], a["rows"][:1]
    s, run = post("/evaluate"); assert run["reopened"] >= 1, run
    s, conf = get("/conformance"); f2 = next(x for x in conf["findings"] if x["id"] == fid)
    assert f2["status"] == "open" and not f2.get("resolved_by") and not f2.get("resolution"), f2
    s, a2 = get(f"/audit?entity=findings&entity_id={fid}&action=reopened"); assert a2["rows"] and a2["rows"][0]["details"]["previously_resolved_by"] == CHAIR, a2["rows"][:1]
    mutations.append(f"finding {fid[:8]} resolved by {CHAIR} with a reason, then reopened by evaluate")
    return f"platform admin and author → 403; no reason → 400; resolved (resolved_by={CHAIR}, audited with the reason); evaluate reopened it, cleared the resolution, audited 'reopened'"
step("v  resolve finding with reason → audited → reopened on evaluate", v)

# ---------- w. citations carry ids the UI can link ----------
def w():
    s, rv = get(f"/reviews/{ctx['review']}"); e = next(x for x in rv["events"] if x["kind"] == "pre_review")
    cites = [c for f in e["data"]["findings"] for c in f["citations"]]
    std = [c for c in cites if c["kind"] == "standard"]; res = [c for c in cites if c["kind"] == "resource"]
    assert std and all(c.get("id") and c.get("label") for c in std), std[:2]
    assert res and all(c.get("id") and c.get("application_id") == ctx["app"] for c in res), res[:2]
    assert rv["submitted_by"] == AUTHOR, rv.get("submitted_by")
    return f"{len(std)} standard citations with id+label, {len(res)} resource citations with id+application_id; submitted_by present"
step("w  pre-review citations resolve to ids", w)

# ---------- x. suggested conditions are an array; template hints are never stored ----------
def x():
    s, rv = get(f"/reviews/{ctx['review']}"); e = next(x for x in rv["events"] if x["kind"] == "pre_review")
    assert isinstance(e["data"]["suggested_conditions"], list), type(e["data"]["suggested_conditions"])
    hint = "## Design\n\nWhat is being built or changed, and how it fits the current estate.\n\n## Data\n\nReal content here.\n\n## Security\n\nIdentity, network exposure, secrets.\n"
    s, r = post("/reviews", {"title": "Smoke: template hints", "application_id": ctx["app"], "risk_tier": "medium", "design_md": hint}, user=AUTHOR); assert s == 200, f"{s} {r}"
    mutations.append(f"review {r['code']} (template-hint check)")
    s, rv2 = get(f"/reviews/{r['id']}"); md = rv2["design_md"]
    assert "What is being built" not in md and "Identity, network exposure" not in md and "Real content here." in md and "## Design" in md, md
    return f"suggested_conditions is a list ({len(e['data']['suggested_conditions'])}); hint-only sections stored empty, real content and headings kept"
step("x  suggested_conditions is an array; template hints stripped", x)

# ---------- summary ----------
passed = sum(1 for _, ok in results if ok); failed = len(results) - passed
print(f"\n{passed} passed, {failed} failed  ({BASE})")
if mutations: print("mutations made to the demo tenant: " + "; ".join(mutations))
sys.exit(1 if failed else 0)
PY
