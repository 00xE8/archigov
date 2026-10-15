#!/usr/bin/env bash
# Archigov empty-instance smoke test — the "usable in ten minutes with an empty database" path, through the API.
#
#   scripts/smoke-empty.sh [base_url]     default http://localhost:8080
#
# Run it against an instance started with SEED_DEMO=false on a fresh data dir. It imports the core standards
# pack and loads the demo estate, so the instance is populated afterwards. Prints PASS/FAIL per step and exits
# non-zero on any FAIL.
set -u
BASE="${1:-http://localhost:8080}"
command -v python3 >/dev/null || { echo "python3 is required"; exit 2; }

python3 - "$BASE" <<'PY'
import json, sys
import urllib.request, urllib.error

BASE = sys.argv[1].rstrip("/") + "/api"
HDR = {"x-user": "smoke-empty", "Content-Type": "application/json"}

def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, headers=HDR, method=method)
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try: return e.code, json.loads(raw) if raw else None
        except Exception: return e.code, raw.decode(errors="replace")

get = lambda p: call("GET", p)
post = lambda p, b=None: call("POST", p, {} if b is None else b)

results = []
def step(label, fn):
    try:
        detail = fn() or ""
        results.append((label, True)); print(f"PASS  {label}" + (f"  — {detail}" if detail else ""))
    except AssertionError as e:
        results.append((label, False)); print(f"FAIL  {label}  — {e}")
    except Exception as e:
        results.append((label, False)); print(f"FAIL  {label}  — {type(e).__name__}: {e}")

def s0():
    s, h = get("/health"); assert s == 200 and h.get("ok"), f"health {s} {h}"
step("0  instance reachable", s0)

def a():
    s, st = get("/settings"); assert s == 200, f"{s} {st}"
    assert st["demo_loaded"] is False, f"demo_loaded={st['demo_loaded']} — this is not an empty instance (start with SEED_DEMO=false on a fresh data dir)"
    assert isinstance(st["azure_configured"], bool) and isinstance(st["llm"]["configured"], bool) and isinstance(st["collect_interval_minutes"], (int, float)), st
    return f"demo_loaded=false, azure_configured={st['azure_configured']}, llm.configured={st['llm']['configured']}, collect every {st['collect_interval_minutes']} min"
step("a  settings say what is and is not configured", a)

def b():
    s, ov = get("/overview"); assert s == 200, f"{s} {ov}"
    assert ov["first_run"] is True and ov["counts"]["resources"] == 0, (ov.get("first_run"), ov["counts"])
    assert ov["counts"]["standards"] == 0, f"expected no standards on an empty instance, got {ov['counts']['standards']}"
    return "first_run=true, 0 resources, 0 standards"
step("b  overview flags first run", b)

def c():
    s, packs = get("/standards/packs"); assert s == 200, f"{s} {packs}"
    core = next((p for p in packs if p["id"] == "archigov-core"), None); assert core and len(core["standards"]) == 5, packs
    return f"archigov-core v{core['version']}: {', '.join(x['code'] for x in core['standards'])}"
step("c  core standards pack is offered", c)

def d():
    s, r = post("/standards/packs/archigov-core/import"); assert s == 200 and r["imported"] == 5 and r["skipped"] == 0, f"{s} {r}"
    s, stds = get("/standards"); assert len(stds) == 5 and all(x["verification"] == "unverified" for x in stds), [(x["code"], x["verification"]) for x in stds]
    assert all(x["rule"] for x in stds) and all(x["control_refs"] for x in stds), "pack standards must carry a rule and control references"
    s, again = post("/standards/packs/archigov-core/import"); assert again["imported"] == 0 and again["skipped"] == 5, again
    return "imported 5 (all unverified, each with a rule and control refs); second import skipped 5"
step("d  import the core pack", d)

def e():
    s, r = post("/sources/demo/load"); assert s == 200 and not r.get("skipped"), f"{s} {r}"
    assert r["ingest"]["created"] == 39, r["ingest"]
    return f"demo estate loaded: {r['ingest']['created']} resources, {r['ingest']['applications']} applications, {r['ingest']['shared_services']} shared service(s)"
step("e  load the demo estate", e)

def f():
    s, ov = get("/overview"); c = ov["counts"]
    assert ov["first_run"] is False and c["resources"] == 39 and c["applications"] == 8 and c["shared_services"] == 1, (ov["first_run"], c)
    assert c["standards"] == 12, f"expected 5 pack + 7 demo-only adopted standards = 12, got {c['standards']}"
    assert c["artefacts"] == {"standard": 12, "principle": 1, "pattern": 1, "policy": 1}, c.get("artefacts")
    assert c["drafts_in_review"] == 1, f"the demo seeds one draft policy (POL-002), got {c.get('drafts_in_review')}"
    return f"first_run=false; {c['resources']} resources, {c['applications']} applications, {c['standards']} standards + 1 principle, 1 pattern, 1 policy adopted, 1 draft"
step("f  overview reflects the populated model", f)

def g():
    s, run = post("/evaluate"); assert s == 200 and run["findings"] > 0, run
    s, conf = get("/conformance"); assert conf["findings"], "no findings after evaluate"
    s, ov = get("/overview"); assert ov["counts"]["findings_open"] > 0, ov["counts"]
    return f"{run['findings']} open findings across {run['standards']} checkable standards"
step("g  evaluate produces findings", g)

def h():
    s, st = get("/settings"); assert st["demo_loaded"] is True, st
    return "demo_loaded=true"
step("h  settings now report the demo source", h)

passed = sum(1 for _, ok in results if ok); failed = len(results) - passed
print(f"\n{passed} passed, {failed} failed  ({BASE})")
sys.exit(1 if failed else 0)
PY
