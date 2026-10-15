#!/usr/bin/env bash
# Archigov boards smoke test — boards, board seats, routing, approval policies and the typed-review workflow,
# end to end through the API of a LOCAL-mode seeded instance.
#
#   scripts/smoke-boards.sh [base_url]   default http://localhost:8080
#
# The default x-user ("smoke-boards") is a platform admin ONLY: it configures boards and policies but never
# authors, approves or decides — those act as the seeded cast (s.patel authors, j.duduka/m.hughes decide-make,
# r.khan chairs the PCB). MUTATES the tenant (adds/removes a board member, edits a policy, creates two draft
# policies and their reviews, approves/decides them, declares fast-lane design reviews on the Intranet); reset with
# `docker compose down -v && docker compose up -d`.
set -u
BASE="${1:-http://localhost:8080}"
command -v python3 >/dev/null || { echo "python3 is required"; exit 2; }

python3 - "$BASE" <<'PY'
import json, re, sys
import urllib.request, urllib.error

BASE = sys.argv[1].rstrip("/") + "/api"
AUTHOR = "s.patel"

def call(method, path, body=None, user="smoke-boards"):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, headers={"x-user": user, "Content-Type": "application/json"}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            raw = r.read(); return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try: return e.code, json.loads(raw) if raw else None
        except Exception: return e.code, raw.decode(errors="replace")
get = lambda p, user="smoke-boards": call("GET", p, None, user)
post = lambda p, b=None, user="smoke-boards": call("POST", p, {} if b is None else b, user)
put = lambda p, b, user="smoke-boards": call("PUT", p, b, user)
delete = lambda p, user="smoke-boards": call("DELETE", p, None, user)

results, ctx, mutations = [], {}, []
def step(label, fn):
    try:
        detail = fn() or ""
        results.append((label, True)); print(f"PASS  {label}" + (f"  — {detail}" if detail else ""))
    except AssertionError as e:
        results.append((label, False)); print(f"FAIL  {label}  — {e}")
    except Exception as e:
        results.append((label, False)); print(f"FAIL  {label}  — {type(e).__name__}: {e}")

def s0():
    s, me = get("/auth/me"); assert me["user"]["user_type"] is None and me["user"]["is_platform_admin"] is True and me["user"]["boards"] == [], me["user"]
    s, boards = get("/boards"); assert s == 200 and [b["code"] for b in boards] == ["DA", "PCB"], f"{s} {boards}"
    s, da = get("/boards/DA"); assert s == 200, s
    # the seeded cast (other scripts may have added seats of their own)
    roles = {m["user_id"]: m["board_role"] for m in da["members"]}
    assert {k: roles.get(k) for k in ("j.duduka", "m.hughes", "p.osei", "s.patel", "a.okafor")} == {"j.duduka": "chair", "m.hughes": "decision_maker", "p.osei": "decision_maker", "s.patel": "reviewer", "a.okafor": "secretary"}, roles
    assert {r["review_type"] for r in da["routing"]} >= {"design", "decision", "standard", "pattern"}, da["routing"]
    steps = da["policies"]["design"]["steps"]; assert [s_["kind"] for s_ in steps] == ["pre_review", "approvals", "decision"], steps
    # the Design Authority runs in areas mode: positions per area from the decision makers owning them; the chair declares
    assert steps[1]["mode"] == "areas" and steps[1]["roles"] == ["decision_maker"] and steps[2]["roles"] == ["chair"], steps
    assert len(da["areas"]) == 8 and all(c["owners"] for c in da["area_coverage"]), (da["areas"], da["area_coverage"])
    assert da["can_manage"] is True and da["can"] == {"members": True, "routing": True, "policies": True, "areas": True, "sessions": False}, "the platform admin configures every board but runs no session"
    s, pcb = get("/boards/PCB"); ctx["pcb"] = pcb["id"]; ctx["da"] = da["id"]
    proles = {m["user_id"]: m["board_role"] for m in pcb["members"]}
    assert {k: proles.get(k) for k in ("r.khan", "j.duduka", "m.hughes")} == {"r.khan": "chair", "j.duduka": "decision_maker", "m.hughes": "decision_maker"}, proles
    assert pcb["policies"]["policy"]["steps"][1]["min"] == 2 and pcb["policies"]["policy"]["steps"][1]["mode"] == "count" and set(pcb["policies"]["policy"]["steps"][1]["roles"]) == {"chair", "decision_maker"}, pcb["policies"]["policy"]
    assert '"member"' not in json.dumps([da, pcb]), "the old seat name must not leak"
    s, reviews = get("/reviews"); assert all(r.get("board") and r.get("type") and isinstance(r.get("areas"), list) for r in reviews), "every review carries a type, a board and its areas"
    s, mine = get("/boards/DA", user="a.okafor"); assert mine["can"] == {"members": True, "routing": True, "policies": False, "areas": False, "sessions": True}, mine["can"]
    return f"DA {len(da['members'])} seats over 8 areas (areas mode), PCB {len(pcb['members'])} seats (count mode); {len(reviews)} reviews all typed+routed"
step("0  boards, seats, routing and policies are seeded in the new vocabulary", s0)

def sa():
    s, b = get("/boards/route?type=policy"); assert s == 200 and b["code"] == "PCB" and b["policy"]["steps"], f"{s} {b}"
    s, b = get("/boards/route?type=design"); assert b["code"] == "DA", b
    s, b = get("/boards/route?type=exception"); assert b["code"] == "PCB", b
    s, _ = get("/boards/route?type=nonsense"); assert s == 400
    return "policy → PCB, design → DA, exception → PCB, nonsense → 400"
step("a  route lookup", sa)

def sb():
    s, r = post(f"/boards/{ctx['pcb']}/members", {"user_id": "t.nguyen", "board_role": "observer"}, user="m.hughes"); assert s == 403 and r.get("capability") == "manage_board", f"decision maker adding members: {s} {r}"
    s, r = post(f"/boards/{ctx['pcb']}/members", {"user_id": "t.nguyen", "board_role": "observer"}, user="r.khan"); assert s == 200, f"PCB chair: {s} {r}"
    s, pcb = get("/boards/PCB"); assert any(m["user_id"] == "t.nguyen" and m["board_role"] == "observer" for m in pcb["members"]), pcb["members"]
    s, r = post(f"/boards/{ctx['pcb']}/members", {"user_id": "t.nguyen", "board_role": "reviewer"}, user="a.okafor"); assert s == 403, f"the DA secretary holds no PCB seat: {s} {r}"
    s, r = post(f"/boards/{ctx['da']}/members", {"user_id": "t.nguyen", "board_role": "reviewer"}, user="a.okafor"); assert s == 200, f"the DA secretary adds to the DA: {s} {r}"
    s, r = post(f"/boards/{ctx['pcb']}/members", {"user_id": "no.such.user", "board_role": "decision_maker"}); assert s == 404, s
    s, r = post(f"/boards/{ctx['pcb']}/members", {"user_id": "t.nguyen", "board_role": "member"}, user="r.khan"); assert s == 400, f"the old seat name is refused: {s}"
    s, r = delete(f"/boards/{ctx['da']}/members/t.nguyen", user="a.okafor"); assert s == 200 and r["ok"], f"{s} {r}"
    s, r = delete(f"/boards/{ctx['pcb']}/members/t.nguyen"); assert s == 200 and r["ok"], f"platform admin removes: {s} {r}"
    s, pcb = get("/boards/PCB"); assert not any(m["user_id"] == "t.nguyen" for m in pcb["members"])
    mutations.append("t.nguyen added to and removed from PCB and DA")
    return "decision maker → 403; PCB chair adds observer; DA secretary adds to DA, not PCB; unknown user → 404; 'member' → 400; secretary and platform admin remove"
step("b  board membership: platform admin, chair or that board's secretary", sb)

def sc():
    pol = {"policy": {"steps": [{"name": "Automatic pre-review", "kind": "pre_review"}, {"name": "One approval", "kind": "approvals", "min": 1, "roles": ["decision_maker", "chair"]}, {"name": "Chair decision", "kind": "decision", "roles": ["chair"]}]}}
    s, r = put(f"/boards/{ctx['pcb']}/policies/exception", pol, user="m.hughes"); assert s == 403 and r.get("capability") == "manage_board", f"decision maker editing policies: {s} {r}"
    s, r = put(f"/boards/{ctx['da']}/policies/design", pol, user="a.okafor"); assert s == 403 and r.get("capability") == "manage_board", f"secretary editing policies: {s} {r}"
    s, r = put(f"/boards/{ctx['pcb']}/policies/exception", {"policy": {"steps": []}}); assert s == 400, s
    s, r = put(f"/boards/{ctx['pcb']}/policies/exception", {"policy": {"steps": [{"kind": "approvals", "min": 1, "roles": ["reviewer"]}, {"kind": "decision", "roles": ["chair"]}]}}); assert s == 400 and "advisory" in r.get("error", ""), f"{s} {r}"
    s, r = put(f"/boards/{ctx['pcb']}/policies/exception", {"policy": {"steps": [{"kind": "approvals", "min": 1, "roles": ["chair"]}, {"kind": "decision", "roles": ["decision_maker"]}]}}); assert s == 400 and "does not decide" in r.get("error", ""), f"{s} {r}"
    s, r = put(f"/boards/{ctx['pcb']}/policies/exception", pol, user="r.khan"); assert s == 200 and r["policy"]["steps"][1]["min"] == 1, f"the PCB chair sets their own policy: {s} {r}"
    legacy = {"policy": {"steps": [{"kind": "pre_review"}, {"name": "One approval", "kind": "approvals", "min": 1, "roles": ["member", "chair"]}, {"kind": "decision", "roles": ["chair"]}]}}
    s, r = put(f"/boards/{ctx['pcb']}/policies/exception", legacy); assert s == 200 and r["policy"]["steps"][1]["roles"] == ["decision_maker", "chair"], f"old seat name normalised: {s} {r}"
    s, pcb = get("/boards/PCB"); assert pcb["policies"]["exception"]["steps"][1]["min"] == 1
    mutations.append("PCB exception policy → one approval")
    return "decision maker / secretary → 403; empty, reviewer-approves, decision-maker-decides → 400; chair and platform admin set it; 'member' normalised"
step("c  approval policy edit: chair of the board or platform admin, validated", sc)

def sd():
    s, a = post("/artefacts", {"kind": "policy", "title": "Smoke: production secrets live in Key Vault", "category": "Security", "statement": "Production secrets are stored in Azure Key Vault, never in app settings or code.", "rationale": "Smoke test of the adoption workflow.", "severity": "high", "enforcement": "mandatory", "control_refs": ["ISO 27001 A.8.24"]}, user=AUTHOR)
    assert s == 200 and a.get("id") and re.fullmatch(r"POL-\d{3}", a.get("code", "")), f"{s} {a}"
    assert a.get("lifecycle") == "draft", a.get("lifecycle")
    ctx["art"] = a["id"]; ctx["art_code"] = a["code"]; mutations.append(f"policy {a['code']} (draft → adopted)")
    body = {"type": "policy", "artefact_id": a["id"], "title": f"Adopt {a['code']}", "impact": "major"}
    s, r = post("/reviews", body, user="m.hughes"); assert s == 403 and r.get("capability") == "submit_review", f"a seat without a system role does not submit: {s} {r}"
    s, r = post("/reviews", body, user="svc.ado"); assert s == 403 and r.get("capability") == "submit_review", f"a service account does not submit: {s} {r}"
    s, r = post("/reviews", body); assert s == 403 and r.get("capability") == "submit_review", f"the platform admin does not submit: {s} {r}"
    s, r = post("/reviews", body, user=AUTHOR); assert s == 200, f"{s} {r}"
    assert r["board"]["code"] == "PCB" and r["stage"] == "in_review", r
    ctx["rev"] = r["id"]; ctx["rev_code"] = r["code"]
    s, rv = get(f"/reviews/{r['id']}")
    assert rv["type"] == "policy" and rv["target"]["kind"] == "artefact" and rv["target"]["code"] == a["code"], rv["target"]
    pre = [e for e in rv["events"] if e["kind"] == "pre_review"]; assert pre and pre[0]["origin"] == "rules" and pre[0]["verification"] == "unverified", pre
    assert isinstance(pre[0]["data"].get("checks"), list) and pre[0]["data"]["checks"] and "impact" in pre[0]["data"], pre[0]["data"]
    s, art = get(f"/artefacts/{a['id']}"); assert art["lifecycle"] == "in_review", art.get("lifecycle")
    assert rv["progress"]["required"] == 2 and rv["progress"]["received"] == 0, rv["progress"]
    return f"{a['code']} draft → {r['code']} at PCB, in_review; pre-review has {len(pre[0]['data']['checks'])} checks + impact; artefact lifecycle in_review; needs 2 approvals"
step("d  an author's draft policy submitted for adoption: routed, pre-reviewed, lifecycle in_review", sd)

def se():
    rid = ctx["rev"]
    s, r = post(f"/reviews/{rid}/decide", {"outcome": "approved", "rationale": "x"}, user="r.khan"); assert s == 403 and "outstanding" in (r.get("reason") or ""), f"{s} {r}"
    s, r = post(f"/reviews/{rid}/approvals", {"decision": "approve"}, user=AUTHOR); assert s == 403 and "own review" in (r.get("reason") or ""), f"submitter approving: {s} {r}"
    s, r = post(f"/reviews/{rid}/approvals", {"decision": "approve"}, user="a.okafor"); assert s == 403 and r.get("capability") == "approve_review", f"DA secretary on a PCB review: {s} {r}"
    s, r = post(f"/reviews/{rid}/approvals", {"decision": "approve"}, user="t.nguyen"); assert s == 403 and r.get("capability") == "approve_review", f"author without a seat: {s} {r}"
    s, r = post(f"/reviews/{rid}/approvals", {"decision": "approve", "comment": "ok"}, user="j.duduka"); assert s == 200 and r["progress"]["received"] == 1 and not r["progress"]["satisfied"], f"{s} {r}"
    s, r = post(f"/reviews/{rid}/decide", {"outcome": "approved"}, user="r.khan"); assert s == 403, "still one short"
    s, r = post(f"/reviews/{rid}/approvals", {"decision": "approve", "comment": "ok"}, user="m.hughes"); assert s == 200 and r["progress"]["satisfied"], f"{s} {r}"
    s, r = post(f"/reviews/{rid}/decide", {"outcome": "approved"}, user="j.duduka"); assert s == 403 and "does not decide" in (r.get("reason") or ""), f"a PCB decision maker deciding: {s} {r}"
    s, r = post(f"/reviews/{rid}/decide", {"outcome": "approved"}); assert s == 403 and r.get("capability") == "decide_review", f"the platform admin deciding: {s} {r}"
    s, r = post(f"/reviews/{rid}/decide", {"outcome": "approved", "rationale": "Adopted (smoke)"}, user="r.khan"); assert s == 200, f"{s} {r}"
    s, rv = get(f"/reviews/{rid}"); assert rv["stage"] == "approved", rv["stage"]
    assert {(a_["user_id"], a_["board_role"]) for a_ in rv["approvals"]} == {("j.duduka", "decision_maker"), ("m.hughes", "decision_maker")}, rv["approvals"]
    s, art = get(f"/artefacts/{ctx['art']}"); assert art["lifecycle"] == "adopted", art.get("lifecycle")
    s, a = get(f"/audit?entity=reviews&entity_id={rid}"); acts = {(x["actor"], x["action"]) for x in a["rows"]}
    assert ("j.duduka", "position:yes") in acts and ("m.hughes", "position:yes") in acts and ("r.khan", "decide:approved") in acts, acts
    return f"decide blocked ×2 with reasons; submitter / other board / no seat / platform admin → 403; 2 decision-maker approvals → r.khan adopted {ctx['art_code']}; audited"
step("e  approval policy enforced: decision makers approve, the chair adopts", se)

def sf():
    s, a = post("/artefacts", {"kind": "policy", "title": "Smoke: changes-requested flow", "category": "Security", "statement": "A second draft policy for the request-changes path.", "severity": "low", "enforcement": "recommended", "control_refs": ["ISO 27001 A.5.1"]}, user=AUTHOR); assert s == 200, f"{s} {a}"
    mutations.append(f"policy {a['code']} (draft, review with changes requested then adopted)")
    s, r = post("/reviews", {"type": "policy", "artefact_id": a["id"], "title": f"Adopt {a['code']}"}, user=AUTHOR); assert s == 200, f"{s} {r}"
    rid = r["id"]
    s, x = post(f"/reviews/{rid}/approvals", {"decision": "approve"}, user="j.duduka"); assert s == 200
    s, x = post(f"/reviews/{rid}/approvals", {"decision": "request_changes", "comment": "Tighten the statement"}, user="m.hughes"); assert s == 200 and x["stage"] == "changes_requested", x
    s, x = post(f"/reviews/{rid}/decide", {"outcome": "approved"}, user="r.khan"); assert s == 403 and "changes were requested" in (x.get("reason") or ""), x
    s, x = post(f"/reviews/{rid}/resubmit", {"note": "Statement tightened"}, user="m.hughes"); assert s == 403 and x.get("capability") == "resubmit", f"only the submitter resubmits: {s} {x}"
    s, x = post(f"/reviews/{rid}/resubmit", {"note": "Statement tightened"}, user="t.nguyen"); assert s == 403, "another author is not the submitter either"
    s, x = post(f"/reviews/{rid}/resubmit", {"note": "Statement tightened"}, user=AUTHOR); assert s == 200 and x["stage"] == "in_review" and x["progress"]["received"] == 0, x
    s, rv = get(f"/reviews/{rid}"); assert all(a_["superseded"] for a_ in rv["approvals"]), "earlier approvals must be superseded, not deleted"
    for u in ("j.duduka", "m.hughes"): s, x = post(f"/reviews/{rid}/approvals", {"decision": "approve"}, user=u); assert s == 200
    s, x = post(f"/reviews/{rid}/decide", {"outcome": "approved"}, user="r.khan"); assert s == 200
    s, art = get(f"/artefacts/{a['id']}"); assert art["lifecycle"] == "adopted"
    return f"{a['code']}: approve + request_changes → changes_requested → decide blocked → resubmit resets approvals (kept as superseded) → adopted"
step("f  request changes → resubmit → approvals restart", sf)

def sg():
    s, a = post("/artefacts", {"kind": "standard", "title": "Smoke: awaiting-me check", "category": "Smoke", "statement": "Draft standard to populate the queue.", "severity": "low", "control_refs": ["Internal"]}, user=AUTHOR); assert s == 200, f"{s} {a}"
    s, r = post("/reviews", {"type": "standard", "artefact_id": a["id"], "title": f"Adopt {a['code']}"}, user=AUTHOR); assert s == 200 and r["board"]["code"] == "DA", r
    mutations.append(f"standard {a['code']} (draft, review left open)")
    # an unknown category derives no area, so the item gates on the DA's first area (security), which m.hughes owns
    s, rv = get(f"/reviews/{r['id']}"); assert rv["areas"]["touched"] == ["security"] and rv["progress"]["mode"] == "areas", rv["areas"]
    s, mine = get("/reviews?awaiting=me", user="m.hughes"); assert any(x["id"] == r["id"] for x in mine), [x["code"] for x in mine]
    s, chair = get("/reviews?awaiting=me", user="j.duduka"); assert not any(x["id"] == r["id"] for x in chair), "the chair has no vote: not awaited until the positions are in"
    s, other = get("/reviews?awaiting=me", user="p.osei"); assert not any(x["id"] == r["id"] for x in other), "p.osei owns none of its areas"
    s, mine2 = get("/reviews?awaiting=me", user="a.uditor"); assert not mine2, "an auditor has nothing awaiting"
    s, adv = get("/reviews?awaiting=me", user="a.okafor"); assert not any(x["id"] == r["id"] for x in adv), "a secretary is not awaited"
    s, byboard = get("/reviews?board=DA&type=standard"); assert any(x["id"] == r["id"] for x in byboard) and all(x["board"]["code"] == "DA" for x in byboard)
    s, rv = get(f"/reviews/{r['id']}", user="r.khan"); assert not any(v for v in rv["can"].values()), f"the PCB chair holds no DA seat: {rv['can']}"
    return f"{r['code']} touches security and awaits m.hughes only (DA, areas mode); chair, p.osei, auditor and secretary queues empty; board/type filters work; a PCB seat can do nothing on it"
step("g  awaiting=me, board/type filters, seats are board-scoped", sg)

def sh():
    s, r = post("/auth/roles", {"user": "legacy.reviewer", "role": "reviewer"}); assert s == 200, f"{s} {r}"
    s, me = get("/auth/me", user="legacy.reviewer"); u = me["user"]
    assert u["user_type"] == "author" and any(b["code"] == "DA" and b["role"] == "reviewer" for b in u["boards"]) and "reviewer" in u["roles"], u
    assert me["can"]["request_changes"] and not me["can"]["approve_review"] and not me["can"]["decide_review"], me["can"]
    s, r = post("/auth/roles", {"user": "legacy.bm", "role": "board_member"}); assert s == 200, f"{s} {r}"
    s, me = get("/auth/me", user="legacy.bm"); u = me["user"]
    assert u["user_type"] is None and any(b["code"] == "DA" and b["role"] == "decision_maker" for b in u["boards"]) and me["can"]["approve_review"] and not me["can"]["submit_review"], u
    s, me = get("/auth/me"); assert me["user"]["is_platform_admin"] and me["user"]["user_type"] is None and not me["can"]["decide_review"] and not me["can"]["approve_review"], "platform admin alone cannot decide"
    return "legacy 'reviewer' → author + DA reviewer (advisory); 'board_member' → DA decision maker, no system role; platform admin alone never approves or decides"
step("h  legacy aliases and segregation", sh)

FAST_DESIGN = "## Design\n\nA page on the existing web app.\n\n## Data\n\nEditor-written posts only.\n\n## Security\n\nExisting sign-in; ingress through the gateway.\n\n## Resilience\n\nBest effort.\n"
def si():
    s, da = get("/boards/DA"); fl = da["policies"]["design"].get("fast_lane"); assert fl == {"enabled": True, "require_pattern": True}, fl
    s, r = put(f"/boards/{da['id']}/policies/decision", {"policy": {**da["policies"]["decision"], "fast_lane": {"enabled": True}}}, user="j.duduka"); assert s == 400, f"design reviews only: {s} {r}"
    s, apps = get("/applications"); intranet = next(a for a in apps if a["name"] == "Intranet")["id"]
    body = {"type": "design", "application_id": intranet, "risk_tier": "low", "summary": "smoke-boards fast lane", "design_md": FAST_DESIGN, "patterns": ["PAT-001"]}
    s, x = post("/reviews", {**body, "patterns": ["STD-001"], "title": "x"}, user="t.nguyen"); assert s == 400, f"a standard is not a pattern: {s} {x}"
    s, a = post("/reviews", {**body, "title": "Smoke-boards: fast lane one"}, user="t.nguyen"); assert s == 200, f"{s} {a}"
    s, b = post("/reviews", {**body, "title": "Smoke-boards: fast lane two"}, user="t.nguyen"); assert s == 200, f"{s} {b}"
    mutations.append(f"fast-lane reviews {a['code']}, {b['code']}")
    s, ra = get(f"/reviews/{a['id']}"); p = ra["progress"]
    assert p["via_fast_lane"] and p["ready"], [c for c in (p.get("fast_lane") or {}).get("checks", []) if not c["ok"]]
    s, w = get("/me/work", user="j.duduka"); assert any(d["review"]["id"] == a["id"] for d in w["declare"]), "the chair is asked to declare it"
    s, w = get("/me/work", user="m.hughes"); assert not any(d["review"]["id"] == a["id"] for d in w["positions"]), "no position is awaited in the lane"
    # an owner pulls one out: a no on an area it touches
    area = next(x["area"] for x in p["areas"] if "m.hughes" in x["owners"])
    s, x = post(f"/reviews/{b['id']}/positions", {"area": area, "position": "no", "text": "Editors need MFA first."}, user="m.hughes"); assert s == 200, f"{s} {x}"
    s, rb = get(f"/reviews/{b['id']}"); assert not rb["progress"]["via_fast_lane"] and any(c["id"] == "objections" and not c["ok"] for c in rb["progress"]["fast_lane"]["checks"]), rb["progress"]["fast_lane"]
    s, x = post(f"/boards/{da['id']}/fast-lane/declare", {"review_ids": [a["id"]]}); assert s == 403, f"platform admin: {s} {x}"
    s, x = post(f"/boards/{da['id']}/fast-lane/declare", {"review_ids": [a["id"], b["id"]]}, user="j.duduka"); assert s == 200, f"{s} {x}"
    assert [d["id"] for d in x["declared"]] == [a["id"]] and [k["id"] for k in x["skipped"]] == [b["id"]], x
    s, ra = get(f"/reviews/{a['id']}"); assert ra["stage"] == "approved", ra["stage"]
    s, au = get(f"/audit?entity=reviews&entity_id={a['id']}&action=decide:approved"); assert au["rows"] and au["rows"][0]["data"].get("basis") == "fast_lane", au["rows"][:1]
    return f"{a['code']} in the lane (low, PAT-001, every check passing) → declared by the chair with basis fast_lane; {b['code']} taken out by m.hughes's no and skipped; policy guard and 403 for the platform admin"
step("i  fast lane: eligibility, an owner's veto, the chair's board-wide declaration", si)

passed = sum(1 for _, ok in results if ok); failed = len(results) - passed
print(f"\n{passed} passed, {failed} failed  ({BASE})")
if mutations: print("mutations made to the demo tenant: " + "; ".join(mutations))
sys.exit(1 if failed else 0)
PY
