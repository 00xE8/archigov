#!/usr/bin/env bash
# Archigov work-queue smoke test — GET /me/work by role, the overview pipeline, decisions under review (409), the
# per-area findings join on a review, the sessions list filters, attendance by acting, and audit rows resolved to
# codes (sign-ins under `sign_in`), end to end through the API of a LOCAL-mode seeded instance.
#
#   scripts/smoke-work.sh [base_url]   default http://localhost:8080
#
# Run after smoke-sessions.sh on the same instance (before smoke-catalogue.sh). The default x-user ("smoke-work")
# is a platform admin ONLY and must see an empty queue; everything governance acts as the seeded cast. MUTATES the
# tenant (reviews, a session, an ADR, a sign-in); reset with `docker compose down -v && docker compose up -d`.
set -u
BASE="${1:-http://localhost:8080}"
command -v python3 >/dev/null || { echo "python3 is required"; exit 2; }

python3 - "$BASE" <<'PY'
import json, re, sys
import urllib.request, urllib.error

BASE = sys.argv[1].rstrip("/") + "/api"
ADMIN = "smoke-work"
LISTS = ["positions", "declare", "resolve", "sessions", "conditions", "circulations", "resubmit", "changed", "no_decision", "sign_offs"]

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

results, ctx, mutations = [], {}, []
def step(label, fn):
    try:
        detail = fn() or ""
        results.append((label, True)); print(f"PASS  {label}" + (f"  — {detail}" if detail else ""))
    except AssertionError as e:
        results.append((label, False)); print(f"FAIL  {label}  — {e}")
    except Exception as e:
        results.append((label, False)); print(f"FAIL  {label}  — {type(e).__name__}: {e}")

def work(user):
    s, w = get("/me/work", user=user); assert s == 200, f"{user}: {s} {w}"
    assert w["counts"]["total"] == sum(len(w[k]) for k in LISTS) and all(w["counts"][k] == len(w[k]) for k in LISTS), f"{user}: counts do not add up: {w['counts']}"
    return w
def app_id(name):
    s, apps = get("/applications"); return next(a["id"] for a in apps if a["name"] == name)
def design(title, app, md="## Design\n\nx\n\n## Data\n\nPatient identifiers and appointment times.\n\n## Security\n\nPrivate endpoints; secrets in Key Vault."):
    return {"type": "design", "title": title, "application_id": app_id(app), "risk_tier": "medium", "summary": "smoke-work", "design_md": md}
def submit(title, areas, user="t.nguyen", app="Intranet", extra=None):
    s, r = post("/reviews", {**design(title, app), **(extra or {})}, user=user); assert s == 200, f"{s} {r}"
    s, x = put(f"/reviews/{r['id']}/areas", {"areas": areas}, user=user); assert s == 200, f"pin areas: {s} {x}"
    mutations.append(f"review {r['code']}"); return r["id"], r["code"]
def has(lst, rid): return next((x for x in lst if x["review"]["id"] == rid), None)

def s0():
    for u in (ADMIN, "a.uditor", "svc.ado"):
        w = work(u); assert w["counts"]["total"] == 0 and all(w[k] == [] for k in LISTS), f"{u} has work: {w['counts']}"
        assert w["user"]["id"] == u, w["user"]
    s, ov = get("/overview"); assert s == 200 and ov["me"]["awaiting"] == 0, ov.get("me")
    return "platform admin, auditor and service account: empty queue, overview.me.awaiting 0"
step("0  nobody without a governance identity has work", s0)

def sa():
    w = work("m.hughes")
    assert w["positions"], "m.hughes is awaited somewhere (REV-0007 data at least)"
    mine = {"security", "data", "compliance", "ai"}
    for x in w["positions"]:
        assert x["review"]["id"] and x["review"]["code"] and x["review"]["board"]["code"] and x["review"]["stage"], x
        if x["review"]["board"]["code"] == "DA": assert x["areas"] and set(x["areas"]) <= mine, f"not her areas: {x}"
        else: assert x["areas"] == [], f"count mode carries no areas: {x}"
    r7 = next((x for x in w["positions"] if x["review"]["code"] == "REV-0007"), None); assert r7 and r7["areas"] == ["data"], r7
    assert w["sessions"] and all(s_["my_role"] == "decision_maker" and s_["board"]["code"] == "DA" and s_["status"] in ("planned", "open") and "my_attendance" in s_ and "consent_count" in s_ for s_ in w["sessions"]), w["sessions"]
    assert w["declare"] == [] and w["resolve"] == [], "a decision maker declares and resolves nothing"
    for a, b in zip(w["conditions"], w["conditions"][1:]): assert not (a["status"] == "open" and b["status"] == "overdue"), "overdue first"
    assert all(c["review"]["code"] and c["text"] and c["status"] in ("open", "overdue") for c in w["conditions"]), w["conditions"]
    assert any(c_["work_item"]["external_id"] == "1042" and c_["review"]["code"] == "REV-0006" for c_ in w["changed"]), f"epic 1042 changed after REV-0006 (hers) was approved: {w['changed']}"
    assert w["no_decision"] == [], "only authors are prompted about undecided epics"
    s, ov = get("/overview", user="m.hughes"); assert ov["me"]["awaiting"] == w["counts"]["total"], (ov["me"], w["counts"])
    po = work("p.osei"); assert has(po["positions"], r7["review"]["id"])["areas"] == ["infrastructure"], po["positions"]
    return f"m.hughes: {w['counts']['positions']} position(s) (REV-0007 → data), {w['counts']['sessions']} sitting(s), {w['counts']['conditions']} condition(s) overdue first, epic 1042 changed; p.osei: REV-0007 → infrastructure"
step("a  a decision maker: positions on her areas, her sittings, her conditions, her changed backlog", sa)

def sb():
    ctx["r1"], c1 = submit("Smoke-work: ready item (data)", ["data"])
    ctx["r2"], c2 = submit("Smoke-work: conditional item (security)", ["security"])
    ctx["r3"], c3 = submit("Smoke-work: half done (data + cost)", ["data", "cost"])
    ctx["r4"], c4 = submit("Smoke-work: recorded in the sitting (ai)", ["ai"])
    w = work("j.duduka"); assert not any(has(w["declare"], ctx[k]) for k in ("r1", "r2", "r3")), "nothing to declare before the positions"
    assert not any(x["review"]["board"]["code"] == "DA" for x in w["positions"]), "the chair has no vote at the DA"
    s, x = post(f"/reviews/{ctx['r1']}/positions", {"area": "data", "position": "yes"}, user="m.hughes"); assert s == 200, f"{s} {x}"
    s, x = post(f"/reviews/{ctx['r2']}/positions", {"area": "security", "position": "conditional", "text": "Needs a key-management decision."}, user="m.hughes"); assert s == 200, f"{s} {x}"; ctx["pos"] = x["positions"][0]["id"]
    s, x = post(f"/reviews/{ctx['r3']}/positions", {"area": "data", "position": "yes"}, user="m.hughes"); assert s == 200, f"{s} {x}"
    w = work("j.duduka")
    d = has(w["declare"], ctx["r1"]); assert d and d["ready"] is True and d["outstanding"] == [] and d["session"] is None and d["review"]["code"] == c1, d
    assert not has(w["declare"], ctx["r3"]) and not has(w["declare"], ctx["r2"]), "half done / open conditional are not ready"
    rs = has(w["resolve"], ctx["r2"]); assert rs and rs["area"] == "security" and rs["label"] == "Security" and rs["by"] == "m.hughes" and rs["by_name"] and rs["position_id"] == ctx["pos"] and rs["text"], rs
    assert has(work("p.osei")["positions"], ctx["r3"])["areas"] == ["cost"], "p.osei still owes cost"
    tn = work("t.nguyen"); assert not any(has(tn[k], ctx[r]) for k in ("positions", "declare", "resolve") for r in ("r1", "r2", "r3")), "the author never acts on their own item"
    sp = work("s.patel"); assert not any(x["review"]["board"]["code"] == "DA" for x in sp["positions"]) and sp["declare"] == [] and sp["resolve"] == [], "the reviewer seat is advisory"
    return f"chair: declare {c1} (ready), resolve {c2}'s conditional; {c3} waits on p.osei (cost); author and reviewer see none of it"
step("b  the chair declares what is ready and resolves conditionals; author and reviewer are not asked", sb)

def sc():
    s, ses = post("/boards/DA/sessions", {"scheduled_at": "2026-11-10T10:00:00Z", "title": "Smoke-work sitting"}, user="a.okafor"); assert s == 200, f"{s} {ses}"
    sid = ses["id"]; ctx["ses"], ctx["ses_code"] = sid, ses["code"]; mutations.append(f"session {ses['code']}")
    s, x = put(f"/sessions/{sid}/agenda", {"items": [{"review_id": ctx["r3"], "position": 1}, {"review_id": ctx["r2"], "position": 2}, {"review_id": ctx["r4"], "position": 3}]}, user="a.okafor"); assert s == 200 and len(x["items"]) == 3, f"{s} {x}"
    sec = work("a.okafor"); ss = next((q for q in sec["sessions"] if q["id"] == sid), None); assert ss and ss["my_role"] == "secretary" and ss["my_attendance"] is None and ss["items"] == 3, ss
    assert sec["declare"] == [] and sec["positions"] == [], "the secretary runs the sitting, not its items"
    assert not has(work("j.duduka")["declare"], ctx["r3"]), "planned, not open"
    s, x = post(f"/sessions/{sid}/open", user="j.duduka"); assert s == 200, f"{s} {x}"
    op = next(a for a in x["attendance"] if a["user_id"] == "j.duduka"); assert op["status"] == "present" and op["recorded_by"] == "j.duduka", f"the opener is present, self-recorded: {op}"
    assert next(a for a in x["attendance"] if a["user_id"] == "m.hughes")["status"] == "absent", "nothing recorded for m.hughes yet"
    w = work("j.duduka")
    m = has(w["declare"], ctx["r3"]); assert m and m["ready"] is False and m["outstanding"] == ["Cost"] and m["session"]["id"] == sid and m["session"]["status"] == "open", m
    assert has(w["declare"], ctx["r2"]) and has(w["resolve"], ctx["r2"])["session"]["code"] == ctx["ses_code"], "the conditional item is on the open agenda"
    assert w["sessions"][0]["id"] == sid and w["sessions"][0]["my_attendance"] == "present" and w["sessions"][0]["my_role"] == "chair", w["sessions"][:1]
    # m.hughes records in the open sitting with no attendance record: she is in the room
    s, x = post(f"/reviews/{ctx['r4']}/positions", {"area": "ai", "position": "yes"}, user="m.hughes"); assert s == 200 and x["positions"][0]["session_id"] == sid, f"{s} {x}"
    s, v = get(f"/sessions/{sid}"); mh = next(a for a in v["attendance"] if a["user_id"] == "m.hughes"); assert mh["status"] == "present" and mh["recorded_by"] == "m.hughes" and mh["on_behalf_of"] is None, mh
    s, a = get(f"/audit?entity=sessions&entity_id={sid}&action=session:attendance"); assert any(r_["actor"] == "m.hughes" and r_["details"].get("self") is True for r_ in a["rows"]), a["rows"][:2]
    s, x = post(f"/sessions/{sid}/items/{ctx['r4']}/call", user="j.duduka"); assert s == 200
    s, x = post(f"/sessions/{sid}/items/{ctx['r4']}/declare", {"outcome": "approved", "rationale": "Approved in the sitting."}, user="j.duduka"); assert s == 200 and x["effective"], f"{s} {x}"
    s, x = post(f"/sessions/{sid}/items/{ctx['r3']}/call", user="j.duduka"); assert s == 200
    s, x = post(f"/sessions/{sid}/items/{ctx['r3']}/declare", {"outcome": "approved_subject_to_circulation", "circulation_due": "2020-01-01", "rationale": "Cost by circulation."}, user="j.duduka"); assert s == 200 and x["stage"] == "approved_subject_to_circulation", f"{s} {x}"
    s, x = post(f"/sessions/{sid}/items/{ctx['r2']}/defer", {"reason": "Awaiting the decision."}, user="j.duduka"); assert s == 200, f"{s} {x}"
    s, x = post(f"/sessions/{sid}/close", user="j.duduka"); assert s == 200 and x["status"] == "closed", f"{s} {x}"
    return f"{ses['code']}: secretary sees the sitting; opener present; every listed item on the chair's declare list; m.hughes present by recording; closed (1 approved, 1 circulated, 1 deferred)"
step("c  an open sitting: the chair's declare list, attendance by acting", sc)

def sd():
    po = work("p.osei"); c = has(po["circulations"], ctx["r3"]); assert c and c["mine"] is True and c["overdue"] is True and c["missing"] == ["Cost"] and c["circulation_due"] == "2020-01-01", c
    assert has(po["positions"], ctx["r3"])["areas"] == ["cost"], "her position is still asked for"
    ch = has(work("j.duduka")["circulations"], ctx["r3"]); assert ch and ch["mine"] is False, ch
    assert not has(work("m.hughes")["circulations"], ctx["r3"]), "data is recorded: nothing for her"
    rs = has(work("j.duduka")["resolve"], ctx["r2"]); assert rs and rs["session"] is None and rs["review"]["deferred_count"] == 1, rs
    s, x = post(f"/reviews/{ctx['r3']}/positions", {"area": "cost", "position": "yes"}, user="p.osei"); assert s == 200 and x["stage"] == "approved", f"{s} {x}"
    assert not has(work("p.osei")["circulations"], ctx["r3"]) and not has(work("j.duduka")["circulations"], ctx["r3"]), "effective: off the circulation list"
    return "circulation: p.osei (mine, overdue, Cost) and the chair (not mine) saw it; her yes made it effective; the deferred conditional stays with the chair"
step("d  circulations by owner and chair; the deferred conditional stays with the chair", sd)

def se():
    s, ov = get("/overview", user="t.nguyen"); n = ov["pipeline"]["epics_without_decision"]
    s, items = get("/work-items"); free = [w for w in items if w["needs_decision"]]; assert len(free) == n, (len(free), n)
    before = work("t.nguyen"); assert len(before["no_decision"]) == n and all(x["work_item"]["type"] == "Epic" and "application_name" in x["work_item"] for x in before["no_decision"]), before["no_decision"]
    assert free, "the demo has an undecided epic"
    epic = free[0]
    ctx["r6"], c6 = submit("Smoke-work: design for an epic", ["data"], extra={"work_item_id": epic["id"]})
    w = work("t.nguyen"); assert not any(x["work_item"]["id"] == epic["id"] for x in w["no_decision"]) and not has(w["changed"], ctx["r6"]), "linked: no longer undecided, not yet changed"
    s, x = post(f"/work-items/{epic['id']}/simulate-change", {"description": "Scope changed after the design was submitted (smoke-work)."}); assert s == 200 and x["material_change"] is True, f"{s} {x}"
    mutations.append(f"work item {epic['external_id']} changed")
    w = work("t.nguyen"); ch = has(w["changed"], ctx["r6"]); assert ch and ch["work_item"]["external_id"] == epic["external_id"] and ch["work_item"]["title"], w["changed"]
    assert not has(work("s.patel")["changed"], ctx["r6"]), "another author's item"
    ctx["r5"], c5 = submit("Smoke-work: sent back", ["security"])
    s, x = post(f"/reviews/{ctx['r5']}/positions", {"area": "security", "position": "no", "text": "No threat model."}, user="m.hughes"); assert s == 200 and x["stage"] == "changes_requested", f"{s} {x}"
    rb = has(work("t.nguyen")["resubmit"], ctx["r5"]); assert rb and rb["requested_by"] == "m.hughes" and rb["text"] == "No threat model." and rb["requested_at"], rb
    assert not has(work("m.hughes")["positions"], ctx["r5"]), "a sent-back item waits on its author"
    s, x = post(f"/reviews/{ctx['r5']}/resubmit", {"note": "Threat model attached."}, user="t.nguyen"); assert s == 200, f"{s} {x}"
    assert not has(work("t.nguyen")["resubmit"], ctx["r5"]), "resubmitted: gone"
    return f"t.nguyen: {n} undecided epic(s) → {epic['external_id']} linked by {c6}, then changed; {c5} sent back by m.hughes → resubmit → gone"
step("e  an author: undecided epics, changed backlog items, items sent back", se)

def sf():
    s, ov = get("/overview", user="j.duduka"); assert s == 200
    for k in ("trend", "evidence_by_source", "decisions_by_status", "reviews_by_stage", "counts", "first_run", "bySeverity", "byApp", "reviews", "verification", "collect_interval_minutes", "llm"): assert k in ov, k
    p = ov["pipeline"]
    for k in ("by_stage", "in_flight", "by_board", "next_session", "open_conditions", "overdue_conditions", "circulations", "circulations_overdue", "changed_after_approval", "epics_without_decision"): assert k in p, k
    assert p["by_stage"] == {r_["stage"]: r_["n"] for r_ in ov["reviews_by_stage"]}, p["by_stage"]
    assert p["in_flight"] == sum(p["by_stage"].get(s_, 0) for s_ in ("submitted", "pre_review", "in_review", "changes_requested", "approved_pending_dependencies", "approved_subject_to_circulation")) > 0, p
    assert [b["code"] for b in p["by_board"]] == ["DA", "PCB"] and sum(b["in_flight"] for b in p["by_board"]) == p["in_flight"], p["by_board"]
    da = p["by_board"][0]; assert da["next_session"] and da["next_session"]["status"] in ("planned", "open") and da["next_session"]["code"] and da["next_session"]["scheduled_at"], da
    assert p["next_session"] and p["next_session"]["board"]["code"] in ("DA", "PCB") and p["next_session"]["code"], p["next_session"]
    assert p["open_conditions"] >= p["overdue_conditions"] >= 0 and p["circulations"] >= p["circulations_overdue"] >= 0 and p["changed_after_approval"] >= 1, p
    assert p["epics_without_decision"] == ov["counts"]["epics_without_decision"], p
    assert ov["me"]["awaiting"] == work("j.duduka")["counts"]["total"] > 0, ov["me"]
    boards = ", ".join("%s %d" % (b["code"], b["in_flight"]) for b in p["by_board"])
    return f"in flight {p['in_flight']} ({boards}); next {p['next_session']['code']}; conditions {p['open_conditions']}/{p['overdue_conditions']} overdue; chair awaiting {ov['me']['awaiting']}"
step("f  overview carries the pipeline and what is waiting on the caller", sf)

def sg():
    s, d = post("/decisions", {"title": "Smoke-work: messaging platform", "topic": "integration"}, user="t.nguyen"); assert s == 200, f"{s} {d}"; adr = d["id"]; mutations.append(f"decision {d['code']}")
    s, rows = get("/decisions"); row = next(x for x in rows if x["id"] == adr); assert row["review"] is None and row["links"] == {"depends_on": 0, "blocks": 0}, row
    s, rv = post("/reviews", {"type": "decision", "decision_id": adr, "title": f"Decide {d['code']}"}, user="t.nguyen"); assert s == 200, f"{s} {rv}"; mutations.append(f"review {rv['code']}")
    s, rows = get("/decisions"); row = next(x for x in rows if x["id"] == adr)
    assert row["review"] and row["review"]["code"] == rv["code"] and row["review"]["stage"] == "in_review" and row["review"]["board"]["code"] == "DA" and row["review"]["session"] is None, row["review"]
    s, det = get(f"/decisions/{adr}"); assert det["review_in_flight"] == row["review"] and det["links"] == {"depends_on": 0, "blocks": 0}, (det.get("review_in_flight"), det.get("links"))
    for st in ("accepted", "rejected"):
        s, x = post(f"/decisions/{adr}/status", {"status": st}, user="j.duduka"); assert s == 409 and x["error"] == "under review" and x["review"]["code"] == rv["code"] and x["review"]["board"]["code"] == "DA", f"{st}: {s} {x}"
    s, x = post(f"/decisions/{adr}/status", {"status": "accepted"}); assert s == 403, f"the platform admin never sets a status: {s} {x}"
    s, det = get(f"/decisions/{adr}"); assert det["status"] == "proposed", det["status"]
    s, a = get(f"/audit?entity=decisions&entity_id={adr}&action=status:refused_under_review"); assert len(a["rows"]) == 2 and a["rows"][0]["details"]["review"] == rv["code"] and a["rows"][0]["item_code"] == d["code"], a["rows"][:1]
    s, x = post(f"/decisions/{adr}/status", {"status": "proposed"}, user="j.duduka"); assert s == 200, f"other statuses stay allowed: {s} {x}"
    s, r = get(f"/reviews/{rv['id']}")
    for a_ in r["progress"]["areas"]:
        s, x = post(f"/reviews/{rv['id']}/positions", {"area": a_["area"], "position": "yes"}, user=a_["owners"][0]); assert s == 200, f"{s} {x}"
    s, x = post(f"/reviews/{rv['id']}/decide", {"outcome": "approved"}, user="j.duduka"); assert s == 200 and x["effective"], f"{s} {x}"
    s, rows = get("/decisions"); row = next(x for x in rows if x["id"] == adr); assert row["status"] == "accepted" and row["review"] is None, row
    return f"{d['code']}: review {rv['code']} in flight → accepted/rejected directly → 409 (audited); declared through the review → accepted"
step("g  decisions: review in flight, link counts, 409 while under review", sg)

def sh():
    s, r = post("/reviews", design("Smoke-work: findings per area", "Referral API"), user="t.nguyen"); assert s == 200, f"{s} {r}"; mutations.append(f"review {r['code']}")
    s, rv = get(f"/reviews/{r['id']}", user="m.hughes")
    pre = rv["pre_review"]; assert pre and pre["recommendation"] in ("approve", "approve_with_conditions", "request_changes", "reject") and isinstance(pre["findings"], int) and isinstance(pre["checks_failed"], int) and pre["at"], pre
    ev = [e for e in rv["events"] if e["kind"] == "pre_review"][-1]; assert pre["findings"] == len(ev["data"]["findings"]) > 0, "the demo estate yields findings"
    s, cat = get("/standards"); cats = {x["code"]: x.get("category") for x in cat}
    joined = 0
    for a_ in rv["progress"]["areas"]:
        assert isinstance(a_["mine"], bool) and a_["findings_count"] == len(a_["findings"]), a_
        for f in a_["findings"]:
            joined += 1; assert f["severity"] and f["title"] and f["code"] in cats and f["label"] and f["kind"], f
    assert joined > 0, f"no finding joined an area: {[(a_['area'], a_['findings_count']) for a_ in rv['progress']['areas']]}"
    assert next(a_ for a_ in rv["progress"]["areas"] if a_["area"] == "data")["mine"] is True, "m.hughes owns data"
    s, ch = get(f"/reviews/{r['id']}", user="j.duduka"); assert all(a_["mine"] is False for a_ in ch["progress"]["areas"]), "the chair has no vote"
    s, au = get(f"/reviews/{r['id']}", user="t.nguyen"); assert all(a_["mine"] is False for a_ in au["progress"]["areas"]), "the author never records"
    per_area = ", ".join("%s %d" % (a_["area"], a_["findings_count"]) for a_ in rv["progress"]["areas"])
    return f"{r['code']}: pre-review {pre['recommendation']} with {pre['findings']} finding(s); {joined} joined to areas ({per_area}); data is m.hughes's"
step("h  review detail: per-area mine + findings, pre-review summary", sh)

def si():
    s, rows = get("/sessions", user="j.duduka"); assert s == 200 and len(rows) >= 2, rows
    assert all(r_["board"]["code"] and isinstance(r_["items"], int) and isinstance(r_["declared"], int) and isinstance(r_["deferred"], int) and isinstance(r_["consent_count"], int) and r_["my_role"] == "chair" for r_ in rows), rows[:1]
    rank = lambda r_: {"open": 0, "planned": 1}.get(r_["status"], 2)
    assert all(rank(a) <= rank(b) for a, b in zip(rows, rows[1:])), "forthcoming before closed"
    closed = [r_ for r_ in rows if r_["status"] == "closed"]; assert all(a["scheduled_at"] >= b["scheduled_at"] for a, b in zip(closed, closed[1:])), "closed newest first"
    s, fc = get("/sessions?status=planned,open"); assert fc and all(r_["status"] in ("planned", "open") for r_ in fc) and all(a["scheduled_at"] <= b["scheduled_at"] for a, b in zip(fc, fc[1:])), fc
    s, da = get("/sessions?board=da&status=closed"); assert da and all(r_["board"]["code"] == "DA" and r_["status"] == "closed" for r_ in da) and any(r_["code"] == ctx["ses_code"] for r_ in da), da
    mine = next(r_ for r_ in da if r_["code"] == ctx["ses_code"]); assert mine["declared"] == 2 and mine["deferred"] == 1, mine
    s, pcb = get("/sessions?board=PCB"); assert pcb == [], pcb
    s, au = get("/sessions", user="a.uditor"); assert all(r_["my_role"] is None for r_ in au), "no seat, no role"
    return f"{len(rows)} sitting(s); {len(fc)} forthcoming; DA closed {len(da)} ({ctx['ses_code']}: 2 declared, 1 deferred); my_role chair / null"
step("i  GET /sessions: filters, ordering, my_role and counts", si)

def sj():
    s, me = post("/auth/local", {"user": "smoke-work.signin", "name": "Smoke Work", "user_type": "author"}); assert s == 200 and me["user"]["id"] == "smoke-work.signin", f"{s} {me}"; mutations.append("user smoke-work.signin (author)")
    s, a = get("/audit?entity=sign_in&limit=20"); assert a["rows"] and all(r_["entity"] == "sign_in" for r_ in a["rows"]) and any(r_["actor"] == "smoke-work.signin" and r_["action"] == "sign_in" for r_ in a["rows"]), a["rows"][:1]
    s, a = get("/audit?limit=1"); ents = a["facets"]["entities"]; assert "sign_in" in ents and "session" not in ents and "sessions" in ents, ents
    s, rv = get(f"/reviews/{ctx['r1']}")
    s, a = get(f"/audit?entity=reviews&entity_id={ctx['r1']}"); assert a["rows"] and all(r_["item_code"] == rv["code"] and r_["item_label"] == rv["title"] for r_ in a["rows"]), a["rows"][:1]
    s, a = get(f"/audit?entity=sessions&entity_id={ctx['ses']}&action=session:open"); assert a["rows"] and a["rows"][0]["item_code"] == ctx["ses_code"] and a["rows"][0]["item_label"] == "Smoke-work sitting", a["rows"][:1]
    s, a = get("/audit?entity=work_items&limit=5"); assert a["rows"] and all(re.fullmatch(r"(Epic|Feature) \d+", r_["item_code"] or "") and r_["item_label"] for r_ in a["rows"]), a["rows"][:1]
    s, a = get("/audit?entity=tenant&limit=5"); assert a["rows"] and all(r_["item_code"] is None and r_["item_label"] is None for r_ in a["rows"]), "unknown entities resolve to nothing"
    s, v = get("/audit/verify"); assert v["ok"] is True and v["broken_at"] is None, v
    return f"sign-in audited under sign_in (facets carry sign_in + sessions, never session); reviews/sessions/work items resolve to codes; chain intact over {v['rows']} rows"
step("j  audit: sign_in entity, item codes and labels, chain intact", sj)

passed = sum(1 for _, ok in results if ok); failed = len(results) - passed
print(f"\n{passed} passed, {failed} failed  ({BASE})")
if mutations: print("mutations made to the demo tenant: " + "; ".join(mutations))
sys.exit(1 if failed else 0)
PY
