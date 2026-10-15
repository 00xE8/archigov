import { db, uid, nowIso, j, audit } from "./db.js";
import { listElements, resourcesOf, hashOf, type Element } from "./model.js";

/**
 * Rule DSL. A standard's rule_json is one of:
 *  { scope: "resource", match: Match, assert: Assert }
 *  { scope: "application", assert: AppAssert }
 *
 * Match:  { type?: string, typeIn?: string[], typePrefix?: string, where?: Assert[] }
 * Assert: { path: string, op: "eq"|"neq"|"in"|"notIn"|"exists"|"missing"|"gte"|"lte"|"matches", value?: any }
 *       | { op: "decisionConstraint", topic: string }   -- resource must match the application's accepted ADR constraint
 *       | { op: "evidence", control: string, source?: "defender"|"azure_policy"|"manual", state?: "pass" }
 *             -- imported compliance evidence for the resource must exist with that state; missing evidence is a
 *                finding ("no evidence imported"), never a pass. This is how resource-level checks are consumed
 *                from Defender / Azure Policy instead of being rebuilt here.
 * AppAssert: { op: "hasDecision", topic: string, type?: string }  -- type narrows to applications that own a resource whose type starts with it
 *          | { op: "hasOwnerTag" } | { op: "maxResourcesOfType", type: string, max: number }
 *
 * An unknown op or an invalid regex is a rule error: the standard is reported in the run's rule_errors and
 * never counts as passing.
 */
export type Assert = { path?: string; op: string; value?: any; topic?: string; type?: string; max?: number; control?: string; source?: string; state?: string };
export interface Rule { scope: "resource" | "application"; match?: { type?: string; typeIn?: string[]; typePrefix?: string; where?: Assert[] }; assert: Assert; }

const RESOURCE_OPS = new Set(["eq", "neq", "in", "notIn", "exists", "missing", "gte", "lte", "matches"]);
const APP_OPS = new Set(["hasDecision", "hasOwnerTag", "maxResourcesOfType"]);

function getPath(obj: any, path: string): any {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function evalAssert(target: any, a: Assert): boolean {
  const v = a.path ? getPath(target, a.path) : undefined;
  const norm = (x: any) => (typeof x === "string" ? x.toLowerCase() : x);
  switch (a.op) {
    case "eq": return norm(v) === norm(a.value);
    case "neq": return norm(v) !== norm(a.value);
    case "in": return Array.isArray(a.value) && a.value.map(norm).includes(norm(v));
    case "notIn": return !(Array.isArray(a.value) && a.value.map(norm).includes(norm(v)));
    case "exists": return v !== undefined && v !== null && v !== "";
    case "missing": return v === undefined || v === null || v === "";
    case "gte": return typeof v === "number" && v >= a.value;
    case "lte": return typeof v === "number" && v <= a.value;
    case "matches": {
      let re: RegExp;
      try { re = new RegExp(String(a.value), "i"); } catch (e: any) { throw new Error(`invalid regular expression in "matches": ${e.message}`); }
      return typeof v === "string" && re.test(v);
    }
    default: throw new Error(`unknown assert op "${a.op}"`);
  }
}

function matches(res: Element, m?: Rule["match"]): boolean {
  if (!m) return true;
  const t = (res.subtype || "").toLowerCase();
  if (m.type && t !== m.type.toLowerCase()) return false;
  if (m.typeIn && !m.typeIn.map((x) => x.toLowerCase()).includes(t)) return false;
  if (m.typePrefix && !t.startsWith(m.typePrefix.toLowerCase())) return false;
  if (m.where && !m.where.every((w) => evalAssert(resourceView(res), w))) return false;
  return true;
}

const resourceView = (r: Element) => ({ name: r.name, type: r.subtype, location: r.props.location, tags: r.tags, props: r.props });

/** Validate the shape of a rule before running it, so a typo'd op is an error for that artefact, not a silent pass. */
export function validateRule(rule: Rule) {
  if (rule.scope !== "resource" && rule.scope !== "application") throw new Error(`unknown scope "${(rule as any).scope}"`);
  const a = rule.assert;
  if (!a || typeof a.op !== "string") throw new Error("rule has no assert.op");
  if (rule.scope === "resource") {
    if (a.op === "decisionConstraint") { if (!a.topic) throw new Error("decisionConstraint needs a topic"); }
    else if (a.op === "evidence") { if (!a.control) throw new Error("evidence assert needs a control"); }
    else if (!RESOURCE_OPS.has(a.op)) throw new Error(`unknown assert op "${a.op}"`);
    else if (!a.path && a.op !== "exists" && a.op !== "missing") throw new Error(`assert op "${a.op}" needs a path`);
    for (const w of rule.match?.where || []) if (!RESOURCE_OPS.has(w.op)) throw new Error(`unknown match op "${w.op}"`);
  } else if (!APP_OPS.has(a.op)) throw new Error(`unknown application assert op "${a.op}"`);
}

export interface Finding { standard_id: string; element_id: string | null; application_id: string | null; decision_id: string | null; severity: string; message: string; evidence: any; }

/** The accepted decision on a topic that applies to this application. An ADR with no application list applies to all of them. */
function acceptedDecision(appId: string, topic: string) {
  const rows = db.prepare("SELECT * FROM decisions WHERE status='accepted' AND topic=? ORDER BY decided_at DESC").all(topic) as any[];
  return rows.find((d) => { const ids = j(d.application_ids_json, []) as string[]; return ids.length === 0 || ids.includes(appId); }) || null;
}

function activeException(standardId: string, appId: string | null, elementId: string | null): boolean {
  const now = nowIso();
  const rows = db.prepare("SELECT * FROM exceptions WHERE standard_id=? AND status='active' AND (expires_at IS NULL OR expires_at > ?)").all(standardId, now) as any[];
  return rows.some((e) => (e.element_id && e.element_id === elementId) || (e.application_id && e.application_id === appId && !e.element_id));
}

const evidenceStmt = () => db.prepare("SELECT * FROM evidence WHERE resource_id=? AND control=? AND (? IS NULL OR source=?) ORDER BY observed_at DESC LIMIT 1");

/** Evaluate one resource-scoped assert. Returns null when conforming, otherwise the message + evidence for a finding. */
function checkResource(r: Element, a: Assert, s: any, app: Element | null): { message: string; evidence: any; decision_id: string | null; severity: string } | null | "skip" {
  if (a.op === "decisionConstraint") {
    if (!app) return "skip";
    const d = acceptedDecision(app.id, a.topic!);
    if (!d) return "skip"; // nothing to conform to; the application-scoped rule flags the missing decision
    const c = j(d.constraint_json, null);
    if (c?.allowedTypes && !c.allowedTypes.map((x: string) => x.toLowerCase()).includes((r.subtype || "").toLowerCase()))
      return { message: `${r.name} (${r.subtype}) contradicts ${d.code} "${d.title}"`, evidence: { decision: d.code, allowedTypes: c.allowedTypes, actualType: r.subtype, resource: r.source_ref }, decision_id: d.id, severity: s.severity };
    return null;
  }
  if (a.op === "evidence") {
    const want = (a.state || "pass").toLowerCase();
    const ev = evidenceStmt().get(r.id, a.control, a.source ?? null, a.source ?? null) as any;
    if (!ev) return { message: `${r.name}: no evidence imported for "${a.control}"${a.source ? ` from ${a.source}` : ""}`, severity: "medium", decision_id: null,
      evidence: { control: a.control, source: a.source ?? null, state: "unknown", resource: r.source_ref } };
    if (String(ev.state).toLowerCase() !== want)
      return { message: `${r.name}: ${s.title}`, severity: s.severity, decision_id: null,
        evidence: { control: a.control, source: ev.source, state: ev.state, observed_at: ev.observed_at, imported_severity: ev.severity, detail: j(ev.detail_json, {}), resource: r.source_ref } };
    return null;
  }
  if (!evalAssert(resourceView(r), a)) {
    const actual = a.path ? getPath(resourceView(r), a.path) : undefined;
    return { message: `${r.name}: ${s.title}`, severity: s.severity, decision_id: null, evidence: { path: a.path, expected: { op: a.op, value: a.value }, actual: actual ?? null, resource: r.source_ref } };
  }
  return null;
}

/** The slice of the derived model an evaluation runs over, built once per run (and once per dry run). */
export interface ModelContext { apps: Element[]; appOf: Map<string, Element>; appResources: Map<string, Element[]>; allResources: Element[] }
export function modelContext(): ModelContext {
  const apps = listElements("application");
  const appOf = new Map<string, Element>();
  const appResources = new Map<string, Element[]>();
  for (const app of apps) { const rs = resourcesOf(app.id); appResources.set(app.id, rs); rs.forEach((r) => appOf.set(r.id, app)); }
  return { apps, appOf, appResources, allResources: listElements("resource") };
}

/** Only adopted artefacts (of any kind) on the active side of the radar are evaluated: a draft, a retired artefact or one still being assessed never produces a finding. */
export const EVALUABLE_SQL = "SELECT * FROM standards WHERE rule_json IS NOT NULL AND lifecycle='adopted' AND status IN ('adopt','retire','hold')";

/** Evaluate one artefact's rule over the model. Throws on an invalid rule; the caller decides whether that is a run error or a pre-review failure. */
export function evaluateArtefact(s: any, rule: Rule, ctx: ModelContext): Finding[] {
  const findings: Finding[] = [];
  validateRule(rule);
  if (rule.scope === "resource") {
    for (const r of ctx.allResources) {
      if (!matches(r, rule.match)) continue;
      const app = ctx.appOf.get(r.id) || null;
      const res = checkResource(r, rule.assert, s, app);
      if (res && res !== "skip") findings.push({ standard_id: s.id, element_id: r.id, application_id: app?.id || null, decision_id: res.decision_id, severity: res.severity, message: res.message, evidence: res.evidence });
    }
  } else {
    for (const app of ctx.apps) {
      const a = rule.assert;
      const rs = ctx.appResources.get(app.id) || [];
      if (a.op === "hasDecision") {
        const relevant = !a.type || rs.some((r) => (r.subtype || "").toLowerCase().startsWith(a.type!.toLowerCase()));
        if (relevant && !acceptedDecision(app.id, a.topic!)) {
          findings.push({ standard_id: s.id, element_id: app.id, application_id: app.id, decision_id: null, severity: s.severity,
            message: `${app.name} has no accepted decision on "${a.topic}"`, evidence: { topic: a.topic, resources: rs.length } });
        }
      } else if (a.op === "hasOwnerTag") {
        const owners = new Set(rs.map((r) => r.tags.owner || r.tags.Owner).filter(Boolean));
        if (owners.size === 0) findings.push({ standard_id: s.id, element_id: app.id, application_id: app.id, decision_id: null, severity: s.severity,
          message: `${app.name} has no owner on any of its ${rs.length} resources`, evidence: { resources: rs.length } });
      } else if (a.op === "maxResourcesOfType") {
        const n = rs.filter((r) => (r.subtype || "").toLowerCase() === a.type!.toLowerCase()).length;
        if (n > (a.max ?? 0)) findings.push({ standard_id: s.id, element_id: app.id, application_id: app.id, decision_id: null, severity: s.severity,
          message: `${app.name} has ${n} × ${a.type} (max ${a.max})`, evidence: { count: n } });
      }
    }
  }
  return findings;
}

export function evaluateAll(actor = "system") {
  const runId = uid();
  const started = nowIso();
  db.prepare("INSERT INTO runs(id,kind,started_at) VALUES (?,?,?)").run(runId, "evaluate", started);

  const standards = db.prepare(EVALUABLE_SQL).all() as any[];
  const ctx = modelContext();
  const { apps, allResources } = ctx;

  const findings: Finding[] = [];
  const rule_errors: { standard: string; message: string }[] = [];
  // which kinds of artefact were evaluated: standards, patterns and policies all run through the same engine
  const by_kind: Record<string, number> = { standard: 0, principle: 0, pattern: 0, policy: 0 };
  for (const s of standards) {
    const rule: Rule = j(s.rule_json);
    if (!rule) continue;
    const kind = s.kind || "standard"; by_kind[kind] = (by_kind[kind] || 0) + 1;
    try {
      findings.push(...evaluateArtefact(s, rule, ctx));
    } catch (e: any) {
      // a broken rule is an error for that artefact, visible in the run — never a pass and never a crash
      rule_errors.push({ standard: s.code, message: String(e.message) });
    }
  }

  // Exceptions: downgrade to 'excepted' rather than drop, so they stay visible
  const now = nowIso();
  const seen = new Set<string>();
  const open: Finding[] = [];
  let excepted = 0, opened = 0, resolved = 0, reopened = 0;
  // the ids behind the deltas are kept on the run, so "what changed since last run" is a stored fact
  const changes = { opened: [] as string[], resolved: [] as string[], reopened: [] as string[] };
  const reopenedHuman: { id: string; standard_id: string; message: string; resolved_by: string; resolution: string | null }[] = [];
  const existing = db.prepare("SELECT id, status, resolved_by, resolution FROM findings WHERE fingerprint=?");
  // a finding that comes back clears any human resolution: the condition is demonstrably still there
  const upsert = db.prepare(`INSERT INTO findings(id,standard_id,element_id,application_id,decision_id,severity,message,evidence_json,status,fingerprint,first_seen,last_seen)
    VALUES (@id,@standard_id,@element_id,@application_id,@decision_id,@severity,@message,@evidence_json,@status,@fingerprint,@now,@now)
    ON CONFLICT(fingerprint) DO UPDATE SET last_seen=@now, status=@status, message=@message, evidence_json=@evidence_json, severity=@severity, resolved_at=NULL, resolved_by=NULL, resolution=NULL`);
  db.transaction(() => {
    for (const f of findings) {
      const fp = hashOf([f.standard_id, f.element_id, f.application_id]);
      seen.add(fp);
      const status = activeException(f.standard_id, f.application_id, f.element_id) ? "excepted" : "open";
      if (status === "open") open.push(f); else excepted++;
      const cur = existing.get(fp) as any;
      const newId = uid();
      if (!cur) { opened++; changes.opened.push(newId); }
      else if (cur.status === "resolved") { reopened++; changes.reopened.push(cur.id); if (cur.resolved_by) reopenedHuman.push({ id: cur.id, standard_id: f.standard_id, message: f.message, resolved_by: cur.resolved_by, resolution: cur.resolution }); }
      upsert.run({ id: newId, ...f, evidence_json: JSON.stringify(f.evidence), status, fingerprint: fp, now });
    }
    const current = db.prepare("SELECT id, fingerprint FROM findings WHERE status IN ('open','excepted')").all() as any[];
    for (const o of current) if (!seen.has(o.fingerprint)) { db.prepare("UPDATE findings SET status='resolved', resolved_at=? WHERE id=?").run(now, o.id); resolved++; changes.resolved.push(o.id); }
    // expire exceptions
    db.prepare("UPDATE exceptions SET status='expired' WHERE status='active' AND expires_at IS NOT NULL AND expires_at <= ?").run(now);
    // overdue conditions
    db.prepare("UPDATE conditions SET status='overdue' WHERE status='open' AND due_at IS NOT NULL AND due_at < ?").run(now);
  })();
  // a finding a human had closed is back: that is material, so it is audited per finding
  for (const f of reopenedHuman) audit(actor, "reopened", "findings", f.id, { standard_id: f.standard_id, message: f.message, previously_resolved_by: f.resolved_by, previous_resolution: f.resolution });

  // stats describe what is open after exceptions, so the Runs tab and the Overview agree; opened/resolved/reopened are this run's deltas
  const stats = { standards: standards.length, applications: apps.length, resources: allResources.length, findings: open.length, excepted, opened, resolved, reopened,
    bySeverity: open.reduce((m: any, f) => ((m[f.severity] = (m[f.severity] || 0) + 1), m), {}), rule_errors, by_kind };
  db.prepare("UPDATE runs SET finished_at=?, status='done', stats_json=?, changes_json=? WHERE id=?").run(nowIso(), JSON.stringify(stats), JSON.stringify(changes), runId);
  audit(actor, "evaluate", "run", runId, stats);
  return { runId, ...stats };
}

/** Rule errors from the most recent completed evaluation, keyed by standard code. */
export function lastRuleErrors(): Record<string, string> {
  const last = db.prepare("SELECT stats_json FROM runs WHERE kind='evaluate' AND status='done' ORDER BY started_at DESC LIMIT 1").get() as any;
  const errs: { standard: string; message: string }[] = j(last?.stats_json, {})?.rule_errors || [];
  return Object.fromEntries(errs.map((e) => [e.standard, e.message]));
}

/** Evaluate the rules for one application only, without persisting. Used by pre-review. */
export function dryRunForApplication(appId: string): { standard: any; message: string; evidence: any; error?: boolean }[] {
  const out: { standard: any; message: string; evidence: any; error?: boolean }[] = [];
  const standards = db.prepare(EVALUABLE_SQL).all() as any[];
  const rs = resourcesOf(appId);
  const app = { id: appId } as Element;
  for (const s of standards) {
    const rule: Rule = j(s.rule_json); if (!rule) continue;
    try {
      validateRule(rule);
      if (rule.scope === "resource") {
        for (const r of rs) {
          if (!matches(r, rule.match)) continue;
          const res = checkResource(r, rule.assert, s, app);
          if (res && res !== "skip") out.push({ standard: s, message: res.message, evidence: res.evidence });
        }
      } else if (rule.assert.op === "hasDecision") {
        const relevant = !rule.assert.type || rs.some((r) => (r.subtype || "").toLowerCase().startsWith(rule.assert.type!.toLowerCase()));
        if (relevant && !acceptedDecision(appId, rule.assert.topic!)) out.push({ standard: s, message: `No accepted decision on "${rule.assert.topic}"`, evidence: { topic: rule.assert.topic } });
      }
    } catch (e: any) {
      out.push({ standard: s, message: `Rule could not be evaluated: ${e.message}`, evidence: { rule_error: true }, error: true });
    }
  }
  return out;
}
