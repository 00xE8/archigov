#!/usr/bin/env bash
# Archigov sessions smoke test — areas of responsibility, positions per area, board sessions (agenda, attendance,
# delegation, consent, circulation, deferral, derived minutes) and dependent decisions, end to end through the API
# of a LOCAL-mode seeded instance. Spec: docs/board-sessions.md. Run after smoke-boards.sh on the same instance.
#
#   scripts/smoke-sessions.sh [base_url]   default http://localhost:8080
#
# The default x-user ("smoke-sessions") is a platform admin ONLY and must get 403 on every session and position
# action; everything governance acts as the seeded cast (t.nguyen/s.patel/a.okafor author, m.hughes/p.osei are
# the DA decision makers owning their areas, j.duduka chairs the DA, a.okafor is its secretary, r.khan chairs the
# PCB). MUTATES the tenant (reviews, sessions SES-0002…, an ADR, a draft policy); reset with
# `docker compose down -v && docker compose up -d`.
set -u
BASE="${1:-http://localhost:8080}"
command -v python3 >/dev/null || { echo "python3 is required"; exit 2; }

python3 - "$BASE" <<'PY'
import json, re, sys, hashlib
import urllib.request, urllib.error

BASE = sys.argv[1].rstrip("/") + "/api"
ADMIN = "smoke-sessions"

def call(method, path, body=None, user=ADMIN):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, headers={"x-user": user, "Content-Type": "application/json"}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            raw = r.read(); return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try: return e.code, json.loads(raw) if raw else None
        except Exception: return e.code, raw.decode(errors="replace")
get = lambda p, user=ADMIN: call("GET", p, None, user)
post = lambda p, b=None, user=ADMIN: call("POST", p, {} if b is None else b, user)
put = lambda p, b, user=ADMIN: call("PUT", p, b, user)
delete = lambda p, user=ADMIN: call("DELETE", p, None, user)

results, ctx, mutations = [], {}, []
def step(label, fn):
    try:
        detail = fn() or ""
        results.append((label, True)); print(f"PASS  {label}" + (f"  — {detail}" if detail else ""))
    except AssertionError as e:
        results.append((label, False)); print(f"FAIL  {label}  — {e}")
    except Exception as e:
        results.append((label, False)); print(f"FAIL  {label}  — {type(e).__name__}: {e}")

def canonical(v):
    """db.ts canonical(): keys sorted at every level, no whitespace."""
    return json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
def app_id(name):
    s, apps = get("/applications"); return next(a["id"] for a in apps if a["name"] == name)
def design(title, app, md="## Design\n\nx\n\n## Data\n\nPatient identifiers and appointment times.\n\n## Security\n\nPrivate endpoints; secrets in Key Vault."):
    return {"type": "design", "title": title, "application_id": app_id(app), "risk_tier": "medium", "summary": "smoke-sessions", "design_md": md}
def submit(title, app, areas, user):
    s, r = post("/reviews", design(title, app), user=user); assert s == 200, f"{s} {r}"
    s, x = put(f"/reviews/{r['id']}/areas", {"areas": areas}, user=user); assert s == 200, f"pin areas: {s} {x}"
    mutations.append(f"review {r['code']}"); return r["id"], r["code"]
def fill(rid):
    """Record yes on every missing area from one of its owners."""
    s, rv = get(f"/reviews/{rid}")
    for a in rv["progress"]["areas"]:
        if a["state"] == "missing":
            s, r = post(f"/reviews/{rid}/positions", {"area": a["area"], "position": "yes"}, user=a["owners"][0]); assert s == 200, f"{a['owners'][0]} on {a['area']}: {s} {r}"
    s, rv = get(f"/reviews/{rid}"); return rv

def s0():
    s, me = get("/auth/me"); assert me["user"]["user_type"] is None and me["user"]["is_platform_admin"] is True and me["user"]["boards"] == [], me["user"]
    s, da = get("/boards/DA"); assert s == 200, s; ctx["da"] = da["id"]
    assert [a["id"] for a in da["areas"]] == ["security", "data", "integration", "infrastructure", "resilience", "cost", "compliance", "ai"], da["areas"]
    areas = {m["user_id"]: m["areas"] for m in da["members"]}
    assert areas.get("m.hughes") == ["security", "data", "compliance", "ai"] and areas.get("p.osei") == ["integration", "infrastructure", "resilience", "cost"], areas
    assert all(c["owners"] for c in da["area_coverage"]), da["area_coverage"]
    step_ = da["policies"]["design"]["steps"][1]; assert step_["kind"] == "approvals" and step_["mode"] == "areas" and step_["roles"] == ["decision_maker"] and "min" not in step_, step_
    s, pcb = get("/boards/PCB"); ctx["pcb"] = pcb["id"]
    p = pcb["policies"]["policy"]["steps"][1]; assert p["mode"] == "count" and p["min"] == 2 and pcb["areas"] == [], p
    s, sessions = get("/boards/DA/sessions"); assert s == 200 and sessions, f"{s} {sessions}"
    s1 = next((x for x in sessions if x["code"] == "SES-0001"), None); assert s1 and s1["status"] in ("planned", "open", "closed") and s1["items"] >= 1, sessions
    s, view = get(f"/sessions/{s1['id']}"); assert s == 200 and view["title"] == "Design Authority — fortnightly" and not any(view["can"].values()), f"platform admin reads but can do nothing: {view.get('can')}"
    ctx["ses1"] = s1["id"]
    return f"DA 8 areas, m.hughes/p.osei own 4 each, design policy areas mode; PCB count mode (min 2); SES-0001 {s1['status']} with {s1['items']} item(s)"
step("0  seed: DA areas and owners, areas-mode policy, PCB count, SES-0001 planned", s0)

def sa():
    s, r = post("/reviews", design("Smoke-sessions: appointments reminder store", "Appointments"), user="t.nguyen"); assert s == 200, f"{s} {r}"
    rid, code = r["id"], r["code"]; ctx["rev"], ctx["rev_code"] = rid, code; mutations.append(f"review {code}")
    assert {"data", "security", "infrastructure"} <= set(r["areas"]), f"derived areas {r['areas']}"
    s, rv = get(f"/reviews/{rid}", user="t.nguyen"); assert rv["areas"]["origin"] == "derived" and rv["areas"]["mode"] == "areas" and rv["can"]["edit_areas"], rv["areas"]
    s, x = put(f"/reviews/{rid}/areas", {"areas": ["security", "data", "infrastructure"]}, user="t.nguyen"); assert s == 200 and x["progress"]["required"] == 3, f"{s} {x}"
    s, x = post(f"/reviews/{rid}/positions", {"area": "security", "position": "yes"}, user="j.duduka"); assert s == 403 and "chair has no vote" in (x.get("reason") or ""), f"chair: {s} {x}"
    s, x = post(f"/reviews/{rid}/positions", {"area": "security", "position": "yes"}, user="t.nguyen"); assert s == 403 and ("own review" in (x.get("reason") or "") or x.get("capability") == "approve_review"), f"author: {s} {x}"
    s, x = post(f"/reviews/{rid}/positions", {"area": "security", "position": "yes"}); assert s == 403 and x.get("capability") == "approve_review" and x.get("is_platform_admin") is True, f"platform admin: {s} {x}"
    s, x = post(f"/reviews/{rid}/positions", {"area": "security", "position": "yes"}, user="a.uditor"); assert s == 403, f"auditor: {s} {x}"
    s, x = post(f"/reviews/{rid}/positions", {"area": "security", "position": "yes"}, user="s.patel"); assert s == 403 and "advisory" in (x.get("reason") or ""), f"reviewer: {s} {x}"
    s, x = post(f"/reviews/{rid}/positions", {"area": "security", "position": "yes"}, user="p.osei"); assert s == 403 and "do not own" in (x.get("reason") or ""), f"other owner: {s} {x}"
    s, mine = get("/reviews?awaiting=me", user="m.hughes"); assert any(x["id"] == rid for x in mine), "m.hughes is awaited"
    s, chair = get("/reviews?awaiting=me", user="j.duduka"); assert not any(x["id"] == rid for x in chair), "the chair is not awaited until the positions are in"
    return f"{code}: derived {r['areas']} → pinned security/data/infrastructure; chair (no vote), author, platform admin, auditor, reviewer, non-owner → 403"
step("a  a design review: areas derived and pinned; only owners record positions", sa)

def sb():
    s, x = post("/boards/DA/sessions", {"scheduled_at": "2026-11-03T10:00:00Z"}); assert s == 403 and x.get("is_platform_admin") is True, f"platform admin planning: {s} {x}"
    s, x = post("/boards/DA/sessions", {"scheduled_at": "2026-11-03T10:00:00Z"}, user="m.hughes"); assert s == 403, f"decision maker planning: {s} {x}"
    s, ses = post("/boards/DA/sessions", {"scheduled_at": "2026-11-03T10:00:00Z", "title": "Smoke-sessions sitting"}, user="a.okafor"); assert s == 200, f"{s} {ses}"
    ctx["ses"] = ses["id"]; ctx["ses_code"] = ses["code"]; mutations.append(f"session {ses['code']}")
    assert ses["status"] == "planned" and any(i["review"]["id"] == ctx["rev"] for i in ses["items"]), [i["review"]["code"] for i in ses["items"]]
    assert ses["can"]["manage"] and ses["can"]["record_attendance"] and not ses["can"]["open"], ses["can"]
    sid = ses["id"]
    # the derived agenda also lists whatever else is open at the DA (earlier smoke scripts leave reviews behind); keep this sitting to its item
    s, x = put(f"/sessions/{sid}/agenda", {"items": [{"review_id": ctx["rev"], "position": 1}]}); assert s == 403, f"platform admin reordering: {s} {x}"
    s, x = put(f"/sessions/{sid}/agenda", {"items": [{"review_id": ctx["rev"], "position": 1}]}, user="a.okafor"); assert s == 200 and [i["review"]["id"] for i in x["items"]] == [ctx["rev"]], f"{s} {x}"
    s, x = post(f"/sessions/{sid}/attendance", {"status": "present"}); assert s == 403, f"platform admin attending: {s} {x}"
    s, x = post(f"/sessions/{sid}/attendance", {"status": "present"}, user="p.osei"); assert s == 200, f"{s} {x}"
    s, x = post(f"/sessions/{sid}/delegations", {"delegate": "a.uditor"}, user="m.hughes"); assert s == 400 and "auditor" in x.get("error", ""), f"{s} {x}"
    s, x = post(f"/sessions/{sid}/delegations", {"delegate": "t.nguyen"}, user="m.hughes"); assert s == 400 and "author" in x.get("error", ""), f"{s} {x}"
    s, x = post(f"/sessions/{sid}/delegations", {"delegate": "s.patel"}); assert s == 403, f"platform admin delegating: {s} {x}"
    s, x = post(f"/sessions/{sid}/delegations", {"delegate": "s.patel"}, user="m.hughes"); assert s == 200 and x["delegation"]["areas"] == ["security", "data", "compliance", "ai"], f"{s} {x}"
    sp = next(a for a in x["attendance"] if a["user_id"] == "s.patel"); assert sp["status"] == "present" and sp["on_behalf_of"] == "m.hughes", sp
    s, x = post(f"/sessions/{sid}/open", user="a.okafor"); assert s == 403, f"secretary opening: {s} {x}"
    s, x = post(f"/sessions/{sid}/open"); assert s == 403, f"platform admin opening: {s} {x}"
    s, x = post(f"/sessions/{sid}/open", user="j.duduka"); assert s == 200 and x["status"] == "open", f"{s} {x}"
    assert all(q["covered"] for q in x["quorum"]), x["quorum"]
    assert next(q for q in x["quorum"] if q["area"] == "security")["by"] == ["s.patel"], x["quorum"]
    s, rv = get(f"/reviews/{ctx['rev']}"); assert rv["session"] and rv["session"]["code"] == ses["code"] and rv["session"]["status"] == "open", rv.get("session")
    return f"{ses['code']} planned by the secretary with {ctx['rev_code']}; p.osei present; m.hughes → s.patel (auditor/author → 400); chair opened; quorum covered on all 8 areas"
step("b  session: plan, attendance, delegation, open with quorum", sb)

def sc():
    rid, sid = ctx["rev"], ctx["ses"]
    s, x = post(f"/reviews/{rid}/positions", {"area": "data", "position": "yes"}, user="s.patel"); assert s == 200 and x["positions"][0]["on_behalf_of"] == "m.hughes" and x["positions"][0]["session_id"] == sid, f"{s} {x}"
    s, x = post(f"/reviews/{rid}/positions", {"area": "security", "position": "conditional", "text": "needs a key-management decision"}, user="s.patel"); assert s == 200, f"{s} {x}"
    s, x = post(f"/reviews/{rid}/positions", {"area": "infrastructure", "position": "yes"}, user="p.osei"); assert s == 200, f"{s} {x}"
    p = x["progress"]; assert p["open_conditionals"] == 1 and not p["satisfied"] and p["received"] == 2 and p["required"] == 3, p
    s, x = post(f"/sessions/{sid}/items/{rid}/call", user="j.duduka"); assert s == 200, f"{s} {x}"
    s, x = post(f"/reviews/{rid}/decide", {"outcome": "approved"}, user="j.duduka"); assert s == 403 and "conditional unresolved" in (x.get("reason") or ""), f"{s} {x}"
    s, rv = get(f"/reviews/{rid}"); pos = next(q for q in rv["positions"] if q["position"] == "conditional" and not q["superseded"]); ctx["pos"] = pos["id"]
    s, x = post(f"/positions/{pos['id']}/resolve", {"resolution": "addressed", "text": "I resolve my own condition."}, user="s.patel"); assert s == 403, f"delegate resolving: {s} {x}"
    s, x = post(f"/positions/{pos['id']}/resolve", {"resolution": "addressed", "text": "Resolved by operations."}); assert s == 403, f"platform admin resolving: {s} {x}"
    s, x = post(f"/positions/{pos['id']}/resolve", {"resolution": "dependent_decision", "text": "Key management is decided separately; this design depends on it.", "create": {"title": "Smoke-sessions: key management for reminders", "topic": "security"}}, user="j.duduka")
    assert s == 200 and x["position"]["resolution"] == "dependent_decision" and re.fullmatch(r"ADR-\d{4}", x["dependency"]["decision"]["code"]) and x["dependency"]["review"]["board"]["code"] == "DA", f"{s} {x}"
    ctx["adr"], ctx["adr_code"], ctx["dep_rev"] = x["dependency"]["decision"]["id"], x["dependency"]["decision"]["code"], x["dependency"]["review"]["id"]; mutations.append(f"decision {ctx['adr_code']} + its review")
    assert x["progress"]["satisfied"] and x["progress"]["open_conditionals"] == 0, x["progress"]
    s, rv = get(f"/reviews/{rid}", user="j.duduka"); assert rv["dependencies"] and rv["dependencies"][0]["decision"]["code"] == ctx["adr_code"] and rv["dependencies"][0]["resolved_state"] is None, rv["dependencies"]
    assert "approved" in rv["can"]["declare_outcomes"], rv["can"]
    s, x = post(f"/reviews/{rid}/decide", {"outcome": "approved", "rationale": "Approved pending the key-management decision."}); assert s == 403, f"platform admin declaring: {s} {x}"
    s, x = post(f"/sessions/{sid}/items/{rid}/declare", {"outcome": "approved", "rationale": "Approved pending the key-management decision."}, user="j.duduka"); assert s == 200 and x["stage"] == "approved_pending_dependencies" and x["pending_outcome"] == "approved", f"{s} {x}"
    s, rv = get(f"/reviews/{rid}"); assert rv["stage"] == "approved_pending_dependencies" and rv["pending_outcome"] == "approved", (rv["stage"], rv.get("pending_outcome"))
    ev = next(e for e in rv["events"] if e["kind"] == "approve"); assert ev["session_id"] == sid and ev.get("session_code") == ctx["ses_code"], ev
    s, view = get(f"/sessions/{sid}"); item = next(i for i in view["items"] if i["review"]["id"] == rid); assert item["state"] == "declared" and item["outcome"] == "approved" and item["review"]["item_state"] == "declared", item
    s, a = get(f"/audit?entity=reviews&entity_id={rid}"); acts = {x_["action"] for x_ in a["rows"]}
    assert {"position:yes", "position:conditional", "position:resolve", "dependency:create", "decide:approved"} <= acts, acts
    assert next(x_ for x_ in a["rows"] if x_["action"] == "decide:approved")["details"]["session_id"] == sid
    return f"delegate yes/conditional + p.osei yes → chair blocked (conditional) → delegate/admin cannot resolve → chair resolved into {ctx['adr_code']} (+ review) → approved_pending_dependencies in {ctx['ses_code']}"
step("c  positions, a conditional resolved into a dependent decision, approval held pending it", sc)

def sd():
    sid, dep = ctx["ses"], ctx["dep_rev"]
    s, x = post(f"/sessions/{sid}/agenda/refresh", user="a.okafor"); assert s == 200 and x["added"] >= 1, f"{s} {x}"
    s, x = post(f"/sessions/{sid}/items/{dep}/call", user="j.duduka"); assert s == 200, f"{s} {x}"
    rv = fill(dep); assert rv["type"] == "decision" and rv["progress"]["satisfied"], (rv["type"], rv["progress"])
    s, x = post(f"/sessions/{sid}/items/{dep}/declare", {"outcome": "approved", "rationale": "Decided."}, user="j.duduka"); assert s == 200 and x["effective"], f"{s} {x}"
    s, rv = get(f"/reviews/{ctx['rev']}"); assert rv["stage"] == "approved" and rv["pending_outcome"] is None and rv["dependencies"][0]["resolved_state"] == "accepted", (rv["stage"], rv["dependencies"])
    ev = next(e for e in rv["events"] if e["kind"] == "became_effective"); assert ev["origin"] == "derived" and ev["verification"] == "unverified", ev
    s, a = get(f"/audit?entity=reviews&entity_id={ctx['rev']}&action=review:effective"); assert a["rows"], "review:effective audited"
    s, d = get(f"/decisions/{ctx['adr']}"); assert d["status"] == "accepted" and any(x_["review"]["code"] == ctx["rev_code"] for x_ in d["dependents"]), (d["status"], d.get("dependents"))
    s, x = post(f"/sessions/{sid}/close", {"notes_md": "Smoke-sessions: first sitting."}, user="j.duduka"); assert s == 200 and x["status"] == "closed" and x["minutes_hash"], f"{s} {x}"
    return f"{ctx['adr_code']}'s review approved in {ctx['ses_code']} → {ctx['rev_code']} effective (approved), became_effective + review:effective; ADR accepted; session closed"
step("d  the dependency decided → the dependent review becomes effective", sd)

def se():
    ctx["y"], ctx["y_code"] = submit("Smoke-sessions: circulation item (cost)", "Intranet", ["cost"], "s.patel")
    ctx["x"], ctx["x_code"] = submit("Smoke-sessions: consent item (data)", "Intranet", ["data"], "a.okafor")
    ctx["z"], ctx["z_code"] = submit("Smoke-sessions: pulled item (ai)", "Intranet", ["ai"], "a.okafor")
    ctx["n"], ctx["n_code"] = submit("Smoke-sessions: never reached (security)", "Intranet", ["security"], "t.nguyen")
    fill(ctx["x"]); fill(ctx["z"])
    s, ses = post("/boards/DA/sessions", {"scheduled_at": "2026-11-17T10:00:00Z"}, user="a.okafor"); assert s == 200, f"{s} {ses}"
    sid = ses["id"]; ctx["ses3"], ctx["ses3_code"] = sid, ses["code"]; mutations.append(f"session {ses['code']}")
    assert [i["review"]["item_state"] for i in ses["items"][:2]] == ["ready", "ready"], [(i["review"]["code"], i["review"]["item_state"]) for i in ses["items"]]
    assert {ctx["x"], ctx["z"], ctx["y"], ctx["n"]} <= {i["review"]["id"] for i in ses["items"]}, [i["review"]["code"] for i in ses["items"]]
    s, ses = put(f"/sessions/{sid}/agenda", {"items": [{"review_id": ctx[k], "position": n} for n, k in enumerate(("x", "z", "y", "n"), 1)]}, user="a.okafor"); assert s == 200 and len(ses["items"]) == 4, f"{s} {ses}"
    s, x = post(f"/sessions/{sid}/attendance", {"status": "present"}, user="m.hughes"); assert s == 200
    s, x = post(f"/sessions/{sid}/attendance", {"user_id": "p.osei", "status": "apologies"}, user="a.okafor"); assert s == 200, f"{s} {x}"
    s, x = post(f"/sessions/{sid}/open", user="j.duduka"); assert s == 200, f"{s} {x}"
    assert not next(q for q in x["quorum"] if q["area"] == "cost")["covered"] and next(q for q in x["quorum"] if q["area"] == "data")["covered"], x["quorum"]
    assert {i["review"]["id"] for i in x["items"] if i["consent"]} == {ctx["x"], ctx["z"]} and x["consent_count"] == 2, [(i["review"]["code"], i["consent"]) for i in x["items"]]
    y = ctx["y"]
    s, x = post(f"/sessions/{sid}/items/{y}/call", user="j.duduka"); assert s == 200
    s, x = post(f"/sessions/{sid}/items/{y}/declare", {"outcome": "approved_subject_to_circulation"}, user="j.duduka"); assert s == 400, f"circulation_due required: {s} {x}"
    s, x = post(f"/sessions/{sid}/items/{y}/declare", {"outcome": "approved_subject_to_circulation", "circulation_due": "2026-11-24", "rationale": "Cost to confirm by circulation."}, user="j.duduka"); assert s == 200 and x["stage"] == "approved_subject_to_circulation", f"{s} {x}"
    s, rv = get(f"/reviews/{y}", user="p.osei"); assert rv["stage"] == "approved_subject_to_circulation" and rv["circulation_due"] == "2026-11-24" and rv["can"]["record_position"], (rv["stage"], rv.get("can"))
    s, x = post(f"/reviews/{y}/positions", {"area": "cost", "position": "yes"}, user="m.hughes"); assert s == 403, f"not cost's owner: {s} {x}"
    s, x = post(f"/reviews/{y}/positions", {"area": "cost", "position": "yes"}, user="p.osei"); assert s == 200 and x["stage"] == "approved", f"{s} {x}"
    s, rv = get(f"/reviews/{y}"); assert rv["stage"] == "approved" and any(e["kind"] == "became_effective" for e in rv["events"]), rv["stage"]
    return f"{ctx['ses3_code']}: p.osei apologies → {ctx['y_code']} approved subject to circulation (due 2026-11-24) → p.osei's yes later made it effective"
step("e  circulation: an absent owner's area is approved subject to circulation, effective on their yes", se)

def sf():
    sid = ctx["ses3"]
    s, x = post(f"/sessions/{sid}/items/{ctx['z']}/pull", user="a.okafor"); assert s == 403, f"secretary pulling: {s} {x}"
    s, x = post(f"/sessions/{sid}/items/{ctx['z']}/pull", user="j.duduka"); assert s == 200, f"{s} {x}"
    s, x = post(f"/sessions/{sid}/consent/declare"); assert s == 403, f"platform admin: {s} {x}"
    s, x = post(f"/sessions/{sid}/consent/declare", user="j.duduka"); assert s == 200 and x["declared"] == 1 and x["skipped"] == [], f"{s} {x}"
    s, rx = get(f"/reviews/{ctx['x']}"); assert rx["stage"] == "approved" and any(e["kind"] == "consent_declared" for e in rx["events"]), rx["stage"]
    s, rz = get(f"/reviews/{ctx['z']}"); assert rz["stage"] == "in_review", rz["stage"]
    return f"{ctx['x_code']} approved on the consent agenda (consent_declared); pulled {ctx['z_code']} untouched"
step("f  consent agenda: ready items declared together; a pulled item is not", sf)

def sg():
    sid = ctx["ses3"]
    s, x = post(f"/sessions/{sid}/close", user="j.duduka"); assert s == 200 and x["status"] == "closed", f"{s} {x}"
    n = next(i for i in x["items"] if i["review"]["id"] == ctx["n"]); assert n["state"] == "deferred" and n["note"] == "not reached" and n["review"]["deferred_count"] == 1, n
    s, m = get(f"/sessions/{sid}/minutes", user="a.uditor"); assert s == 200 and m["minutes"] and m["markdown"], s
    assert m["minutes_hash"] == x["minutes_hash"] and hashlib.sha256(canonical(m["minutes"]).encode()).hexdigest() == m["minutes_hash"], "minutes_hash = sha256(canonical(minutes))"
    assert m["minutes"]["origin"] == "derived" and any(i["code"] == ctx["x_code"] and i["outcome"] == "approved" for i in m["minutes"]["items"]), m["minutes"]["items"]
    s, a = get(f"/audit?action=session:close&entity_id={sid}"); assert a["rows"] and a["rows"][0]["details"]["minutes_hash"] == m["minutes_hash"], a["rows"][:1]
    s, v = get("/audit/verify"); assert v["ok"] is True and v["broken_at"] is None, v
    s, x = post(f"/reviews/{ctx['x']}/positions", {"area": "data", "position": "no", "text": "second thoughts"}, user="m.hughes"); assert s == 409, f"frozen: {s} {x}"
    s, x = post(f"/reviews/{ctx['rev']}/approvals", {"decision": "approve"}, user="p.osei"); assert s == 409, f"frozen (alias): {s} {x}"
    s, x = post(f"/positions/{ctx['pos']}/resolve", {"resolution": "addressed", "text": "re-resolving a frozen one"}, user="j.duduka"); assert s == 409, f"frozen (resolve): {s} {x}"
    return f"{ctx['ses3_code']} closed: {ctx['n_code']} auto-deferred (not reached, count 1); minutes derived, hash verified; audit chain intact; positions on declared items → 409"
step("g  close: auto-deferral, derived minutes with a verified hash, frozen positions", sg)

def sh():
    s, a = post("/artefacts", {"kind": "policy", "title": "Smoke-sessions: count mode policy", "category": "Governance", "statement": "The PCB still counts approvals.", "severity": "low", "enforcement": "recommended", "control_refs": ["ISO 27001 A.5.1"]}, user="s.patel"); assert s == 200, f"{s} {a}"
    s, r = post("/reviews", {"type": "policy", "artefact_id": a["id"], "title": f"Adopt {a['code']}"}, user="s.patel"); assert s == 200 and r["board"]["code"] == "PCB", f"{s} {r}"
    rid = r["id"]; mutations.append(f"policy {a['code']} + review {r['code']}")
    s, rv = get(f"/reviews/{rid}"); assert rv["progress"]["mode"] == "count" and rv["progress"]["required"] == 2 and rv["areas"]["touched"] == [], rv["progress"]
    s, x = post(f"/reviews/{rid}/approvals", {"decision": "approve"}, user="j.duduka"); assert s == 200 and x["approval"]["decision"] == "approve" and x["approval"]["area"] is None, f"{s} {x}"
    s, x = post(f"/reviews/{rid}/approvals", {"decision": "approve", "comment": "ok"}, user="m.hughes"); assert s == 200 and x["progress"]["satisfied"], f"{s} {x}"
    s, x = post(f"/reviews/{rid}/decide", {"outcome": "approved"}, user="r.khan"); assert s == 200 and x["stage"] == "approved", f"{s} {x}"
    s, rv = get(f"/reviews/{rid}"); assert {(q["user_id"], q["decision"]) for q in rv["approvals"]} == {("j.duduka", "approve"), ("m.hughes", "approve")}, rv["approvals"]
    s, art = get(f"/artefacts/{a['id']}"); assert art["lifecycle"] == "adopted", art.get("lifecycle")
    return f"{r['code']} at the PCB: 2 approvals through /approvals (count), r.khan adopted {a['code']}"
step("h  count mode untouched: the PCB still approves by count", sh)

def si():
    rid, code = submit("Smoke-sessions: alias (infrastructure + cost)", "Intranet", ["infrastructure", "cost"], "t.nguyen")
    s, x = post(f"/reviews/{rid}/approvals", {"decision": "approve"}, user="m.hughes"); assert s == 403 and "own none" in (x.get("reason") or ""), f"{s} {x}"
    s, x = post(f"/reviews/{rid}/approvals", {"decision": "approve"}, user="p.osei"); assert s == 200 and [q["area"] for q in x["positions"]] == ["infrastructure", "cost"] and x["progress"]["satisfied"], f"{s} {x}"
    s, rv = get(f"/reviews/{rid}"); assert {(q["user_id"], q["area"], q["decision"]) for q in rv["approvals"]} == {("p.osei", "infrastructure", "approve"), ("p.osei", "cost", "approve")}, rv["approvals"]
    return f"{code}: /approvals approve by p.osei → yes on infrastructure + cost; by m.hughes → 403 (owns none)"
step("i  legacy /approvals alias maps to the caller's areas", si)

def sj():
    s, a = get("/audit?limit=1"); acts = set(a["facets"]["actions"])
    need = {"session:create", "session:open", "session:close", "session:attendance", "session:delegate", "session:call", "session:pull", "session:defer", "session:consent_declare", "session:agenda",
            "position:yes", "position:conditional", "position:resolve", "dependency:create", "review:effective", "review:areas", "decide:approved", "decide:approved_subject_to_circulation"}
    missing = need - acts; assert not missing, f"missing audit actions: {sorted(missing)}"
    s, pack = get("/evidence-pack", user="a.uditor"); assert s == 200, s
    ses = next((x for x in pack["sessions"] if x["code"] == ctx["ses3_code"]), None); assert ses and ses["status"] == "closed" and ses["minutes_hash"] and ses["board"] == "DA", pack.get("sessions")
    assert any(i["code"] == ctx["x_code"] and i["outcome"] == "approved" for i in ses["items"]), ses["items"]
    assert not re.search(r"\b(is|are|was|were|fully|now)\s+compliant\b|\bcertified\b|\bassured\b", json.dumps(pack), re.I), "the pack asserts compliance"
    s, v = get(f"/evidence-pack/verify?hash={pack['hash']}"); assert v["hash_ok"] and v["signature_ok"] and v["chain_ok"], v
    return f"{len(need)} new audit actions present; evidence pack lists {ses['code']} with its minutes hash; pack verifies"
step("j  audit facets and evidence pack carry sessions", sj)

def sk():
    rid, code = submit("Smoke-sessions: assessed design (data)", "Intranet", ["data"], "t.nguyen")
    # requesting is a board seat's act: the platform admin and the submitter get 403; a reviewer seat requests, naming the submitter as assessor
    s, x = post(f"/reviews/{rid}/assessments", {"type": "dpia", "assigned_to": "t.nguyen"}); assert s == 403, f"admin: {s} {x}"
    s, x = post(f"/reviews/{rid}/assessments", {"type": "dpia", "assigned_to": "t.nguyen"}, user="t.nguyen"); assert s == 403, f"submitter: {s} {x}"
    s, x = post(f"/reviews/{rid}/assessments", {"type": "dpia", "area": "data", "assigned_to": "t.nguyen", "due_at": "2026-12-01"}, user="s.patel"); assert s == 200 and x["assessments"][0]["status"] == "requested", f"{s} {x}"
    aid = x["assessments"][0]["id"]
    # positions complete, but the open assessment blocks every approving outcome
    s, x = post(f"/reviews/{rid}/positions", {"area": "data", "position": "yes"}, user="m.hughes"); assert s == 200 and x["progress"]["satisfied"] and not x["progress"]["ready"], f"{s} {x}"
    s, rv = get(f"/reviews/{rid}", user="j.duduka"); assert "approved" not in rv["can"]["declare_outcomes"] and "assessments outstanding" in (rv["why"]["decide"] or ""), (rv["can"], rv["why"])
    s, x = post(f"/reviews/{rid}/decide", {"outcome": "approved"}, user="j.duduka"); assert s == 403, f"blocked declare: {s} {x}"
    # the assignee sees it in their queue and records the result themselves — nobody else does
    s, w = get("/me/work", user="t.nguyen"); assert any(q["id"] == aid for q in w["assessments"]), w["assessments"]
    s, x = post(f"/assessments/{aid}/result", {"result": "satisfactory", "result_md": "DPIA done; no residual high risks."}, user="m.hughes"); assert s == 403, f"not assignee: {s} {x}"
    s, x = post(f"/assessments/{aid}/result", {"result": "satisfactory_with_remarks", "result_md": "DPIA done; retention needs a schedule.", "reference": "https://dms.example/dpia-9"}, user="t.nguyen")
    assert s == 200 and x["progress"]["ready"] and x["assessments"][0]["result"] == "satisfactory_with_remarks", f"{s} {x}"
    # a second request is waived by the chair with a real reason; the item then approves, and the pack carries both
    s, x = post(f"/reviews/{rid}/assessments", {"type": "security", "assigned_to": "m.hughes"}, user="s.patel"); assert s == 200, f"{s} {x}"
    wid = next(q["id"] for q in x["assessments"] if q["status"] == "requested")
    s, x = post(f"/assessments/{wid}/waive", {"reason": "nope"}, user="j.duduka"); assert s == 400, f"short reason: {s} {x}"
    s, x = post(f"/assessments/{wid}/waive", {"reason": "Covered by the recorded DPIA."}, user="m.hughes"); assert s == 403, f"dm waive: {s} {x}"
    s, x = post(f"/assessments/{wid}/waive", {"reason": "Covered by the recorded DPIA."}, user="j.duduka"); assert s == 200 and x["progress"]["open_assessments"] == 0, f"{s} {x}"
    s, x = post(f"/reviews/{rid}/decide", {"outcome": "approved"}, user="j.duduka"); assert s == 200 and x["stage"] == "approved", f"{s} {x}"
    s, a = get("/audit?limit=1"); need = {"assessment:request", "assessment:result", "assessment:waive"} - set(a["facets"]["actions"])
    assert not need, f"missing audit actions: {sorted(need)}"
    s, pack = get("/evidence-pack", user="a.uditor"); assert s == 200, s
    app = next(x for x in pack["applications"] if x["name"] == "Intranet")
    rvp = next((x for x in app["reviews"] if x["code"] == code), None); assert rvp and len(rvp["assessments"]) == 2, rvp and rvp["assessments"]
    mutations.append(f"review {code}: DPIA recorded by t.nguyen, security assessment waived by j.duduka, approved")
    return f"{code}: admin+submitter 403; open DPIA blocked approval; assignee-only result; chair-only waive; pack carries both"
step("k  assessments: request → block → result / waive → approve", sk)

passed = sum(1 for _, ok in results if ok); failed = len(results) - passed
print(f"\n{passed} passed, {failed} failed  ({BASE})")
if mutations: print("mutations made to the demo tenant: " + "; ".join(mutations))
sys.exit(1 if failed else 0)
PY
