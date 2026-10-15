#!/usr/bin/env bash
# Archigov auth / evidence smoke test — the two-level RBAC with board seats (system roles author / auditor /
# service / none, the platform-admin flag, seats chair / decision maker / reviewer / secretary / observer), the
# audit hash chain, the signed evidence pack, the OSCAL and DORA exports, chart data and run diffs, driven
# through the API of a LOCAL-mode instance.
#
#   scripts/smoke-auth.sh [base_url]     default http://localhost:8080
#
# Expects a seeded demo tenant (SEED_DEMO=true, so the boards and their seats exist) running with AUTH_MODE
# unset/local. MUTATES the tenant (signs in as several users, approves and decides two reviews, adds users and
# seats, drafts an artefact, evaluates); reset with `docker compose down -v && docker compose up -d` or by deleting
# the data dir.
set -u
BASE="${1:-http://localhost:8080}"
command -v python3 >/dev/null || { echo "python3 is required"; exit 2; }

python3 - "$BASE" <<'PY'
import json, re, sys
import urllib.request, urllib.error
from http.cookiejar import CookieJar

BASE = sys.argv[1].rstrip("/") + "/api"
ASSERTION = re.compile(r"\b(is|are|was|were|fully|now)\s+compliant\b|compliance\s+(passed|achieved|confirmed)|\bcertified\b|\bassured\b", re.I)
SEATS = ("chair", "decision_maker", "reviewer", "secretary", "observer")

class Client:
    """One cookie jar per persona; `header_user` is the x-user fallback used when no session cookie exists."""
    def __init__(self, header_user=None):
        self.jar = CookieJar(); self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar)); self.header_user = header_user
    def call(self, method, path, body=None, raw=False):
        data = json.dumps(body).encode() if body is not None else None
        hdr = {"Content-Type": "application/json"}
        if self.header_user: hdr["x-user"] = self.header_user
        req = urllib.request.Request(BASE + path, data=data, headers=hdr, method=method)
        try:
            with self.opener.open(req, timeout=120) as r:
                payload = r.read()
                return r.status, (payload.decode(errors="replace") if raw else (json.loads(payload) if payload else None))
        except urllib.error.HTTPError as e:
            payload = e.read()
            try: return e.code, (payload.decode(errors="replace") if raw else (json.loads(payload) if payload else None))
            except Exception: return e.code, payload.decode(errors="replace")
    def get(self, p, raw=False): return self.call("GET", p, raw=raw)
    def post(self, p, b=None): return self.call("POST", p, {} if b is None else b)
    def put(self, p, b): return self.call("PUT", p, b)

results, ctx = [], {}
def step(label, fn):
    try:
        detail = fn() or ""
        results.append((label, True)); print(f"PASS  {label}" + (f"  — {detail}" if detail else ""))
    except AssertionError as e:
        results.append((label, False)); print(f"FAIL  {label}  — {e}")
    except Exception as e:
        results.append((label, False)); print(f"FAIL  {label}  — {type(e).__name__}: {e}")

admin = Client(header_user="smoke-admin")      # no cookie: x-user fallback → a lazily created platform admin ONLY (no system role, no seats)
chair = Client(header_user="j.duduka")         # seeded: author, chair of the Design Authority, decision maker at the PCB
dm = Client(header_user="m.hughes")            # seeded: no system role, decision maker on DA (security, data, compliance, ai) and PCB
dm2 = Client(header_user="p.osei")             # seeded: no system role, DA decision maker (integration, infrastructure, resilience, cost)
reviewer = Client(header_user="s.patel")       # seeded: author, advisory reviewer on the DA
secretary = Client(header_user="a.okafor")     # seeded: author, DA secretary
service = Client(header_user="svc.ado")        # seeded: service account
observer = Client(header_user="obs.only")      # created in step f: no system role, DA observer
auditor = Client(); author = Client()          # sign in through POST /auth/local

def design(title): return {"type": "design", "title": title, "application_id": ctx["app"], "risk_tier": "low", "summary": "s", "design_md": "## Design\n\nx"}
def fill(rid):
    """The Design Authority runs in areas mode: one yes per touched area from the decision maker owning it (m.hughes or p.osei)."""
    st, rv = admin.get(f"/reviews/{rid}")
    for a in rv["progress"]["areas"]:
        if a["state"] == "missing":
            who = {"m.hughes": dm, "p.osei": dm2}[a["owners"][0]]
            st, b = who.post(f"/reviews/{rid}/positions", {"area": a["area"], "position": "yes"}); assert st == 200, f"{a['owners'][0]} on {a['area']}: {st} {b}"
    return admin.get(f"/reviews/{rid}")[1]
GOV = ("submit_review", "comment", "resubmit", "manage_artefacts", "create_decision", "verify", "approve_review", "request_changes", "decide_review", "manage_board", "grant_exception", "resolve_finding", "close_condition", "set_decision_status")

def s0():
    st, me = admin.get("/auth/me"); assert st == 200, f"{st} {me}"
    u = me["user"]; assert me["mode"] == "local" and me["authenticated"], me
    assert u["user_type"] is None and u["is_platform_admin"] is True and u["boards"] == [], u
    can = me["can"]; assert can["read"] and can["manage_platform"] and can["import_artefacts"] and can["export_evidence"], can
    held = [k for k in GOV if can[k]]; assert not held, f"the admin flag must grant no governance right, holds {held}"
    assert u["roles"] == ["admin"], u["roles"]
    apps = admin.get("/applications")[1]; ctx["app"] = next(a for a in apps if a["name"] == "Appointments")["id"]
    return "x-user fallback → platform admin only: no system role, no seats; runs the platform, imports packs, exports; no governance right"
step("0  /auth/me without a session (x-user) is a platform admin with no governance identity", s0)

def sa():
    st, me = auditor.post("/auth/local", {"user": "ann.auditor", "user_type": "auditor"}); assert st == 200, f"{st} {me}"
    assert me["user"]["user_type"] == "auditor" and me["user"]["is_platform_admin"] is False and me["can"]["read"] and me["can"]["export_evidence"], me
    assert not any(me["can"][k] for k in GOV) and not me["can"]["manage_platform"], me["can"]
    st, me2 = auditor.get("/auth/me"); assert st == 200 and me2["user"]["id"] == "ann.auditor", "session cookie did not stick"
    st, reviews = auditor.get("/reviews"); assert st == 200 and reviews, "auditor cannot read reviews"
    open_ = [r for r in reviews if r["stage"] in ("submitted", "pre_review", "in_review") and r["type"] == "design" and r["submitted_by"] not in ("m.hughes", "j.duduka")]
    assert open_, "no open design review submitted by someone other than the DA chair/decision maker"
    ctx["review"] = open_[0]; rid = ctx["review"]["id"]
    for path, body, cap in [(f"/reviews/{rid}/decide", {"outcome": "approved"}, "decide_review"), (f"/reviews/{rid}/comment", {"body": "x"}, "comment"),
                            (f"/reviews/{rid}/approvals", {"decision": "approve"}, "approve_review"), ("/evaluate", {}, "pre_review"),
                            ("/artefacts", {"kind": "policy", "title": "x", "category": "x", "statement": "x"}, "manage_artefacts"), ("/reviews", design("x"), "submit_review")]:
        st, body = auditor.post(path, body); assert st == 403 and body.get("error") == "forbidden" and body.get("capability") == cap, f"{path}: {st} {body}"
    st, pack = auditor.get("/evidence-pack"); assert st == 200 and pack.get("hash"), "auditor must be able to export evidence"
    return "auditor reads and exports; decide/comment/approve/evaluate/author/submit → 403 with the capability named"
step("a  auditor: read-only, exports allowed, every mutation → 403 with capability", sa)

def sb():
    st, me = author.post("/auth/local", {"user": "ed.author", "name": "Ed Author", "user_type": "author"}); assert st == 200, f"{st} {me}"
    u, can = me["user"], me["can"]; assert u["user_type"] == "author" and u["is_platform_admin"] is False and u["boards"] == [], u
    assert can["submit_review"] and can["manage_artefacts"] and can["create_decision"] and can["verify"] and can["pre_review"] and can["import_artefacts"], can
    assert not can["approve_review"] and not can["request_changes"] and not can["decide_review"] and not can["manage_platform"] and not can["manage_board"], can
    st, r = author.post("/reviews", design("smoke-auth: author design review")); assert st == 200 and r["board"]["code"] == "DA" and r["stage"] == "in_review", f"{st} {r}"
    ctx["author_review"] = r["id"]; ctx["author_review_code"] = r["code"]
    st, b = author.post(f"/reviews/{r['id']}/approvals", {"decision": "approve"}); assert st == 403 and b.get("capability") == "approve_review", f"an author holds no seat: {st} {b}"
    st, a = author.post("/artefacts", {"kind": "principle", "title": "smoke-auth: author draft principle", "category": "Smoke", "statement": "Authors draft; a board adopts."}); assert st == 200 and a["lifecycle"] == "draft", f"{st} {a}"
    st, _ = author.post("/evaluate"); assert st == 200, "an author may run the engine (pre_review)"
    st, _ = author.post("/sources/demo/resync"); assert st == 403, "an author must not sync sources"
    st, _ = author.put("/users/ann.auditor", {"is_platform_admin": True}); assert st == 403, "an author must not edit users"
    return f"author submits {r['code']} (DA, in_review), drafts {a['code']}, evaluates; no seat → cannot approve; not a platform admin"
step("b  author: submits, drafts, evaluates; holds no seat and runs nothing", sb)

def sc():
    rid = ctx["review"]["id"]; dec = admin.get("/decisions")[1][0]["id"]
    checks = [("/reviews", design("x"), ("submit_review",)), (f"/reviews/{rid}/comment", {"body": "x"}, ("comment",)),
              (f"/reviews/{rid}/approvals", {"decision": "approve"}, ("approve_review",)), (f"/reviews/{rid}/approvals", {"decision": "request_changes"}, ("approve_review", "request_changes")),
              (f"/reviews/{rid}/decide", {"outcome": "approved", "rationale": "smoke-auth"}, ("decide_review",)), (f"/reviews/{rid}/pre-review", {}, ("pre_review",)),
              ("/artefacts", {"kind": "policy", "title": "x", "category": "x", "statement": "x", "enforcement": "mandatory"}, ("manage_artefacts",)),
              ("/decisions", {"title": "x", "topic": "x"}, ("create_decision",)), (f"/decisions/{dec}/status", {"status": "accepted"}, ("set_decision_status",))]
    for path, body, caps in checks:
        st, b = admin.post(path, body); assert st == 403 and b.get("capability") in caps and b.get("is_platform_admin") is True, f"{path}: {st} {b}"
    st, r = admin.post("/standards/packs/archigov-core/import"); assert st == 200 and r["imported"] == 0 and r["skipped"] == 5, f"a platform admin bootstraps packs: {st} {r}"
    st, _ = admin.post("/sources/demo/resync"); assert st == 200, "a platform admin syncs sources"
    return f"{len(checks)} governance actions → 403 naming the capability; pack import and source sync → 200"
step("c  segregation of duties: the admin flag grants no governance right", sc)

def sd():
    rid = ctx["author_review"]
    # the DA runs in areas mode: the reviewer seat is advisory — it sends an item back (a no held on no area) but never records a yes;
    # yes/no per area come from the decision makers owning the touched areas
    st, b = reviewer.post(f"/reviews/{rid}/approvals", {"decision": "approve"}); assert st == 403 and b.get("capability") == "approve_review" and "advisory" in (b.get("reason") or ""), f"{st} {b}"
    st, b = reviewer.post(f"/reviews/{rid}/positions", {"area": "security", "position": "yes"}); assert st == 403 and "advisory" in (b.get("reason") or ""), f"a reviewer records no area position: {st} {b}"
    st, rv = reviewer.get(f"/reviews/{rid}"); can = rv["can"]
    assert can["comment"] and can["pre_review"] and can["create_dependency"] and can["request_changes"] and not can["approve"] and not can["record_position"] and not can["decide"] and not can["resubmit"], can
    st, b = reviewer.post(f"/reviews/{rid}/approvals", {"decision": "request_changes", "comment": "Name the data store"}); assert st == 200 and b["stage"] == "changes_requested" and b["progress"]["changes_requested"], f"{st} {b}"
    assert b["positions"][0]["area"] is None and b["positions"][0]["board_role"] == "reviewer" and b["progress"]["advisory_objections"][0]["by"] == "s.patel", b
    st, b = chair.post(f"/reviews/{rid}/decide", {"outcome": "approved"}); assert st == 403 and "changes were requested" in (b.get("reason") or ""), f"{st} {b}"
    st, b = dm2.post(f"/reviews/{rid}/positions", {"area": "infrastructure", "position": "yes"}); assert st == 403 and "resubmit" in (b.get("reason") or ""), f"no fresh positions until resubmission: {st} {b}"
    st, b = reviewer.post(f"/reviews/{rid}/resubmit", {"note": "x"}); assert st == 403 and b.get("capability") == "resubmit", f"{st} {b}"
    st, rv = author.get(f"/reviews/{rid}"); assert rv["can"]["resubmit"] and not rv["can"]["approve"], rv["can"]
    st, b = author.post(f"/reviews/{rid}/resubmit", {"note": "Data store named"}); assert st == 200 and b["stage"] == "in_review" and b["progress"]["received"] == 0 and not b["progress"]["advisory_objections"], f"{st} {b}"
    # a decision maker's no names its area and sends the item back the same way
    st, b = dm.post(f"/reviews/{rid}/approvals", {"decision": "request_changes", "comment": "Which region?"}); assert st == 200 and b["stage"] == "changes_requested" and all(p["position"] == "no" and p["area"] for p in b["positions"]), f"{st} {b}"
    st, b = author.post(f"/reviews/{rid}/resubmit", {"note": "UK South"}); assert st == 200 and b["stage"] == "in_review", f"{st} {b}"
    st, b = chair.post(f"/reviews/{rid}/decide", {"outcome": "approved"}); assert st == 403 and "outstanding" in (b.get("reason") or ""), f"{st} {b}"
    rv = fill(rid); assert rv["progress"]["satisfied"], rv["progress"]
    st, b = chair.post(f"/reviews/{rid}/decide", {"outcome": "approved", "rationale": "smoke-auth"}); assert st == 200, f"{st} {b}"
    st, rv = author.get(f"/reviews/{rid}"); assert rv["stage"] == "approved", rv["stage"]
    rows = {(a["user_id"], a["board_role"], a["decision"], a["superseded"]) for a in rv["approvals"]}
    assert ("s.patel", "reviewer", "request_changes", True) in rows and ("m.hughes", "decision_maker", "request_changes", True) in rows and ("m.hughes", "decision_maker", "approve", False) in rows, rows
    ctx["areas"] = rv["areas"]["touched"]
    return f"{ctx['author_review_code']}: reviewer approve → 403 (advisory), send-back → changes_requested (no area); chair blocked; resubmit supersedes; m.hughes' no names its area; resubmit; owners record yes on {', '.join(ctx['areas'])}; chair approves"
step("d  reviewer seat is advisory: sends back without an area, never approves; resubmit restarts the policy", sd)

def se():
    rid = ctx["review"]["id"]
    st, b = chair.post(f"/reviews/{rid}/decide", {"outcome": "approved", "rationale": "smoke-auth"}); assert st == 403 and "outstanding" in (b.get("reason") or ""), f"{st} {b}"
    st, b = secretary.post(f"/reviews/{rid}/approvals", {"decision": "approve"}); assert st == 403 and b.get("capability") == "approve_review", f"a secretary does not approve: {st} {b}"
    st, b = chair.post(f"/reviews/{rid}/approvals", {"decision": "approve"}); assert st == 403 and "chair has no vote" in (b.get("reason") or ""), f"the chair has no vote in areas mode: {st} {b}"
    rv = fill(rid); assert rv["progress"]["satisfied"] and rv["progress"]["mode"] == "areas", rv["progress"]
    st, b = chair.post(f"/reviews/{rid}/decide", {"outcome": "approved", "rationale": "smoke-auth"}); assert st == 200, f"{st} {b}"
    st, rv = chair.get(f"/reviews/{rid}"); assert rv["stage"] == "approved" and rv["progress"]["satisfied"], rv["stage"]
    st, _ = chair.post("/sources/demo/resync"); assert st == 403, "the DA chair is an author, not a platform admin: no source sync"
    st, _ = dm.post("/sources/demo/resync"); assert st == 403, "a decision maker is not a platform admin either"
    return f"{ctx['review']['code']}: chair blocked → secretary 403 → chair's own approval 403 (no vote) → owners recorded yes on {', '.join(rv['areas']['touched'])} → j.duduka declared it approved; neither syncs sources"
step("e  board workflow: positions per area from their owners, then the chair declares; seats run nothing", se)

def sf():
    st, u = admin.post("/users", {"id": "obs.only", "name": "Olive Observer", "user_type": None}); assert st == 200 and u["user_type"] is None, f"{st} {u}"
    da = admin.get("/boards/DA")[1]; pcb = admin.get("/boards/PCB")[1]; ctx["da"] = da["id"]
    st, b = secretary.post(f"/boards/{da['id']}/members", {"user_id": "obs.only", "board_role": "observer"}); assert st == 200, f"the DA secretary adds a member: {st} {b}"
    st, b = secretary.post(f"/boards/{pcb['id']}/members", {"user_id": "obs.only", "board_role": "observer"}); assert st == 403 and b.get("capability") == "manage_board", f"{st} {b}"
    st, b = secretary.put(f"/boards/{da['id']}/policies/design", {"policy": da["policies"]["design"]}); assert st == 403 and b.get("capability") == "manage_board", f"a secretary does not change policies: {st} {b}"
    st, b = secretary.put(f"/boards/{da['id']}/routing", [{"review_type": t} for t in ("design", "decision", "standard", "pattern")]); assert st == 200, f"a secretary sets routing: {st} {b}"
    st, me = observer.get("/auth/me"); u = me["user"]
    assert u["user_type"] is None and any(b_["code"] == "DA" and b_["role"] == "observer" for b_ in u["boards"]) and me["can"]["export_evidence"] and not any(me["can"][k] for k in GOV), me
    rid = ctx["review"]["id"]
    st, rv = observer.get(f"/reviews/{rid}"); assert st == 200 and not any(rv["can"].values()), rv.get("can")
    for path, body, caps in [(f"/reviews/{rid}/comment", {"body": "x"}, ("comment",)), (f"/reviews/{rid}/approvals", {"decision": "approve"}, ("approve_review",)),
                             (f"/reviews/{rid}/approvals", {"decision": "request_changes"}, ("approve_review", "request_changes")), (f"/reviews/{rid}/decide", {"outcome": "approved"}, ("decide_review",)),
                             (f"/reviews/{rid}/resubmit", {}, ("resubmit",)), (f"/reviews/{rid}/pre-review", {}, ("pre_review",)),
                             ("/artefacts", {"kind": "policy", "title": "x", "category": "x", "statement": "x"}, ("manage_artefacts",)), ("/reviews", design("x"), ("submit_review",)),
                             (f"/boards/{da['id']}/members", {"user_id": "obs.only", "board_role": "chair"}, ("manage_board",))]:
        st, b = observer.post(path, body); assert st == 403 and b.get("capability") in caps, f"{path}: {st} {b}"
    st, pack = observer.get("/evidence-pack"); assert st == 200 and pack.get("hash"), "a seat may take evidence away"
    return "secretary: adds a DA member, cannot touch PCB or DA policies, sets DA routing; observer: reads and exports, every mutation 403"
step("f  secretary runs members/routing of their board; observer reads only", sf)

def sg():
    st, me = service.get("/auth/me"); assert st == 200 and me["user"]["user_type"] == "service" and me["can"]["read"] and not me["can"]["export_evidence"], me
    st, r = service.get("/reviews"); assert st == 200, st
    st, b = service.get("/evidence-pack"); assert st == 403 and b.get("capability") == "export_evidence", f"{st} {b}"
    st, b = service.get("/exports/oscal"); assert st == 403, st
    st, b = service.post("/reviews", design("x")); assert st == 403 and b.get("capability") == "submit_review", f"{st} {b}"
    return "svc.ado reads; evidence pack and OSCAL → 403 export_evidence; cannot submit"
step("g  service account: reads, cannot export or act", sg)

def sh():
    st, u = admin.post("/users", {"id": "new.person", "name": "New Person", "user_type": "author"}); assert st == 200 and u["user_type"] == "author" and u["boards"] == [], f"{st} {u}"
    st, u = admin.put("/users/new.person", {"user_type": "auditor"}); assert st == 200 and u["user_type"] == "auditor", f"{st} {u}"
    st, me = Client(header_user="new.person").get("/auth/me"); assert me["user"]["user_type"] == "auditor" and not me["can"]["submit_review"], "type change must apply on the next request"
    st, u = admin.put("/users/new.person", {"user_type": None}); assert st == 200 and u["user_type"] is None, f"null clears the system role: {st} {u}"
    st, users = admin.get("/users"); by = {x["id"]: x for x in users}
    assert by["new.person"]["user_type"] is None, by["new.person"]
    assert not any(x["user_type"] in ("architect", "engineer", "board_member", "submitter") for x in users), "old type names must not leak"
    assert all(b["role"] in SEATS for x in users for b in x["boards"]), "old seat names must not leak"
    assert by["j.duduka"]["user_type"] == "author" and by["j.duduka"]["is_platform_admin"] is False, by["j.duduka"]
    assert by["m.hughes"]["user_type"] is None and by["r.khan"]["user_type"] is None, (by["m.hughes"], by["r.khan"])
    assert by["ops.admin"]["user_type"] is None and by["ops.admin"]["is_platform_admin"] is True and by["ops.admin"]["boards"] == [], by["ops.admin"]
    assert by["svc.ado"]["user_type"] == "service" and by["a.uditor"]["user_type"] == "auditor", (by["svc.ado"], by["a.uditor"])
    st, _ = auditor.put("/users/new.person", {"is_platform_admin": True}); assert st == 403, "auditor could edit users"
    st, _ = dm.put("/users/new.person", {"is_platform_admin": True}); assert st == 403, "a decision maker could edit users"
    return "platform admin creates/changes/clears a user's type; it applies at once; the seeded cast is as documented; others 403"
step("h  users API: platform admin edits types, others cannot; new vocabulary only", sh)

def si():
    def grant(user, role):
        st, b = admin.post("/auth/roles", {"user": user, "role": role}); assert st == 200, f"{role}: {st} {b}"
        st, me = Client(header_user=user).get("/auth/me"); return me
    seat = lambda me, code, role: any(b["code"] == code and b["role"] == role for b in me["user"]["boards"])
    me = grant("legacy.chair", "chair"); u = me["user"]
    assert u["user_type"] == "author" and u["is_platform_admin"] is False and seat(me, "DA", "chair") and "chair" in u["roles"] and me["can"]["decide_review"], u
    me = grant("legacy.reviewer", "reviewer"); u = me["user"]
    assert u["user_type"] == "author" and seat(me, "DA", "reviewer") and "reviewer" in u["roles"] and me["can"]["request_changes"] and not me["can"]["approve_review"], u
    me = grant("legacy.bm", "board_member"); u = me["user"]
    assert u["user_type"] is None and seat(me, "DA", "decision_maker") and me["can"]["approve_review"] and not me["can"]["submit_review"], u
    me = grant("legacy.admin", "admin"); u = me["user"]
    assert u["user_type"] is None and u["is_platform_admin"] is True and u["boards"] == [] and not me["can"]["submit_review"] and me["can"]["manage_platform"], u
    for n in ("submitter", "engineer", "architect"):
        me = grant(f"legacy.{n}", n); assert me["user"]["user_type"] == "author" and me["user"]["is_platform_admin"] is False and me["user"]["boards"] == [], (n, me["user"])
    me = grant("legacy.pcb", "PCB:member"); assert seat(me, "PCB", "decision_maker"), me["user"]
    me = grant("legacy.pcb2", "board/PCB/decision_maker"); assert seat(me, "PCB", "decision_maker"), me["user"]
    me = grant("legacy.dotted", "arb.chair"); assert me["user"]["user_type"] == "author" and seat(me, "DA", "chair"), "a dotted value keeps the legacy-suffix meaning"
    st, roles = admin.get("/auth/roles"); assert any(r["user"] == "legacy.chair" and r["role"] == "chair" for r in roles), roles[:2]
    st, b = admin.post("/auth/roles", {"user": "x", "role": "nonsense"}); assert st == 400 and "decision_maker" in b.get("error", ""), f"{st} {b}"
    st, _ = auditor.post("/auth/roles", {"user": "x", "role": "admin"}); assert st == 403, "auditor could assign roles"
    return "chair → author + DA chair; reviewer → author + DA reviewer; board_member → DA decision maker only; admin → flag only; submitter/engineer/architect → author; PCB:member → PCB decision maker"
step("i  legacy role names expand to the new model", si)

def sj():
    st, v = admin.get("/audit/verify"); assert st == 200, f"{st} {v}"
    assert v["ok"] is True and v["rows"] > 0 and v["broken_at"] is None and v.get("head"), v
    st, rows = admin.get("/audit?action=sign_in&limit=5"); assert st == 200
    signin = [r for r in rows["rows"] if r["action"] == "sign_in"]
    assert signin and all(r.get("hash") and "actor_name" in r for r in signin), "sign-ins are audited, hashed and carry a display name"
    st, dec = admin.get(f"/audit?entity=reviews&entity_id={ctx['review']['id']}&limit=50"); assert st == 200
    decided = [r for r in dec["rows"] if r["actor"] == "j.duduka" and r["action"].startswith("decide:")]
    assert decided and decided[0].get("role") == "author" and decided[0]["details"].get("board_role") == "chair", f"the decision row carries the system role and the seat: {decided[:1]}"
    approved = [r for r in dec["rows"] if r["actor"] in ("m.hughes", "p.osei") and r["action"] == "position:yes"]
    assert approved and all(r["details"].get("board_role") == "decision_maker" and r.get("role") == "decision_maker" and r["details"].get("area") for r in approved), f"a seat-only user's row carries the seats held and the area: {approved[:1]}"
    st, sent = admin.get(f"/audit?entity=reviews&entity_id={ctx['author_review']}&action=position:no"); back = sent["rows"]
    assert back and back[0]["actor"] == "m.hughes" and back[0]["details"].get("board_role") == "decision_maker" and back[0]["details"].get("area"), back[:1]
    return f"chain intact over {v['rows']} rows; decision row role=author seat=chair; position rows role=decision_maker with their area; the no carries its area too"
step("j  audit chain verifies; approvals and decisions carry roles and seats", sj)

def sk():
    st, pack = admin.get("/evidence-pack"); assert st == 200, st
    for k in ("hash", "signature", "public_key", "signed_at", "chain_head", "chain_rows", "disclaimer"): assert pack.get(k) not in (None, ""), f"missing {k}"
    assert "BEGIN PUBLIC KEY" in pack["public_key"], "public key is SPKI PEM"
    assert not ASSERTION.search(json.dumps(pack)), "pack asserts compliance"
    st, v = admin.get(f"/evidence-pack/verify?hash={pack['hash']}"); assert st == 200, f"{st} {v}"
    assert v["found"] and v["hash_ok"] and v["signature_ok"] and v["chain_ok"] and v["key_is_current"], v
    st, bad = admin.get("/evidence-pack/verify?hash=" + "0" * 64); assert st == 200 and bad["found"] is False, bad
    st, _ = admin.get("/evidence-pack/verify?hash=nope"); assert st == 400
    return f"hash {pack['hash'][:12]}…, chain_rows={pack['chain_rows']}, all verify flags true"
step("k  evidence pack is signed, chain-anchored and verifies", sk)

def sl():
    st, doc = admin.get("/exports/oscal"); assert st == 200, st
    ar = doc["assessment-results"]; res = ar["results"][0]
    assert ar["metadata"]["oscal-version"] == "1.1.2" and ar["import-ap"]["href"], ar["metadata"]
    assert res["findings"] and res["observations"], "findings/observations present"
    f = res["findings"][0]; assert f["target"]["type"] == "objective-id" and f["target"]["status"]["state"] in ("satisfied", "not-satisfied"), f
    assert not ASSERTION.search(json.dumps(doc)), "OSCAL asserts compliance"
    st, _ = auditor.get("/exports/oscal"); assert st == 200, "auditor must be able to export OSCAL"
    return f"{len(res['findings'])} findings, {len(res['observations'])} observations"
step("l  OSCAL assessment results export", sl)

def sm():
    st, text = admin.get("/exports/dora-roi.csv", raw=True); assert st == 200, st
    lines = text.strip().split("\n"); assert lines[0].startswith("#") and "B_05.01" in lines[0] and "NOT the official" in lines[0], lines[0]
    hdr = lines[1].split(","); assert hdr[0] == "B_06.01.0010_function_identifier" and "B_02.02.0130_country_of_provision" in hdr and "B_07.01_substitutability" in hdr, lines[1]
    rows = [l.split(",") for l in lines[2:]]; assert rows, "no data rows"
    assert all(len(r) == len(hdr) for r in rows) and all(r[hdr.index("B_02.02.0060_type_of_ict_services")] == "" for r in rows), "Annex III codes must stay blank"
    return f"{len(rows)} rows, {len(hdr)} columns with ITS codes"
step("m  DORA register of information CSV", sm)

def sn():
    st, ov = admin.get("/overview"); assert st == 200
    for k in ("trend", "evidence_by_source", "decisions_by_status", "reviews_by_stage"): assert isinstance(ov.get(k), list), f"{k} missing"
    assert ov["trend"] and {"at", "findings_open", "critical", "high", "medium", "low"} <= set(ov["trend"][-1]), ov["trend"][-1:]
    assert ov["evidence_by_source"] and {"source", "pass", "fail", "unknown"} <= set(ov["evidence_by_source"][0]), ov["evidence_by_source"][:1]
    return f"trend {len(ov['trend'])} points, sources {[e['source'] for e in ov['evidence_by_source']]}"
step("n  overview carries chart data", sn)

def so():
    st, run = admin.post("/evaluate"); assert st == 200 and run.get("runId"), f"a platform admin may re-run the engine: {st} {run}"
    st, r = admin.get(f"/runs/{run['runId']}"); assert st == 200, f"{st} {r}"
    assert r["kind"] == "evaluate" and {"opened", "resolved", "reopened"} <= set(r["changes"]) and all(isinstance(r["changes"][k], list) for k in r["changes"]), r
    st, _ = admin.get("/runs/nope"); assert st == 404
    return f"run {run['runId'][:8]}: opened {len(r['changes']['opened'])} / resolved {len(r['changes']['resolved'])} / reopened {len(r['changes']['reopened'])}"
step("o  run diff endpoint", so)

def sp():
    st, s = admin.get("/settings"); assert st == 200
    assert s["auth"]["mode"] == "local" and "entra_configured" in s["auth"], s["auth"]
    for k in ("azure", "defender", "policy", "ado"): assert "configured" in s[k] and "fixtures" in s[k], f"{k}: {s.get(k)}"
    assert s["ado"]["hook_url"] == "/api/hooks/ado", s["ado"]
    return "auth/azure/defender/policy/ado blocks present"
step("p  settings expose configuration state", sp)

def sq():
    st, body = auditor.post("/auth/logout"); assert st == 200 and body.get("ok"), body
    st, me = auditor.get("/auth/me"); assert st == 200 and me["user"]["id"] == "local-admin" and me["user"]["user_type"] is None and me["user"]["is_platform_admin"] is True, "after logout the local fallback (platform admin only) applies again"
    return "logout clears the session; the fallback is local-admin, platform admin only"
step("q  logout", sq)

passed = sum(1 for _, ok in results if ok); failed = len(results) - passed
print(f"\n{passed} passed, {failed} failed  ({BASE})")
print("mutations made: sessions for ann.auditor/ed.author/smoke-admin; reviews", ctx.get("review", {}).get("code"), "and", ctx.get("author_review_code"), "approved; a draft principle; users obs.only/new.person and legacy.* created; evaluate runs; an evidence pack")
sys.exit(1 if failed else 0)
PY
