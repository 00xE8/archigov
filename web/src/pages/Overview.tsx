import React from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button, SkeletonText, Table, TableHead, TableRow, TableHeader, TableBody, TableCell, ClickableTile, InlineLoading, InlineNotification, Tile, Tag, ContainedList, ContainedListItem } from "@carbon/react";
import { Renew, Play, Settings as SettingsIcon, Application, ChartNetwork, Cube, WarningAlt, TaskApproved, Time, Unlocked, DecisionTree, ChangeCatalog } from "@carbon/icons-react";
import { get, post, fmtDate, fmtDateTime, labelFor } from "../api";
import { PageIntro, PageHeader, Coverage, CountUp, useLoad, LoadError, RLink, StatusTag, PackImporter, AreaTag, AreaPositionTag, KindTag, useDocTitle, artefactLink } from "../components";
import { Gated, useCan } from "../auth";

// Carbon Charts is a separate chunk; the dashboard shows skeletons for the chart row until it arrives.
const OverviewCharts = React.lazy(() => import("../charts"));
const STAGE_ORDER = ["submitted", "pre_review", "in_review", "changes_requested", "approved_subject_to_circulation", "approved_pending_dependencies", "approved_with_conditions", "approved", "rejected", "withdrawn"];

export default function Overview() {
  const [d, reload, err] = useLoad<any>(() => get("/overview"));
  // My work is a newer route; an older server simply has no such section. Boards and sessions back the pipeline on an older /overview.
  const [work] = useLoad<any>(() => get("/me/work").catch(() => null));
  const [boards] = useLoad<any[]>(() => get<any[]>("/boards").catch(() => []));
  const [sessions] = useLoad<any[]>(() => get<any[]>("/sessions").catch(() => []));
  const [busy, setBusy] = React.useState(false);
  const [params] = useSearchParams();
  const nav = useNavigate();
  // Re-running the engine is an operations action as much as a governance one: authors and platform admins alike.
  const canEval = useCan("pre_review") || useCan("manage_platform");
  useDocTitle("Overview");
  if (err) return <LoadError what="the overview" err={err} onRetry={reload} />;
  if (!d) return <SkeletonText paragraph lineCount={6} />;
  const c = d.counts;
  const v = d.verification;
  // An instance with nothing collected has nothing to show; it shows the way in instead.
  const firstRun = !!d.first_run || (c.resources ?? 0) === 0;
  if (firstRun || params.get("start") === "1") return <GetStarted forced={!firstRun} onDone={reload} />;
  // Whole tile is the target; a problem is signalled by an icon + word tag beside the number, never by colouring the digits.
  // Each tile carries an icon and a tone; a tile whose number needs attention takes the alert tone (still also flagged in words).
  const tile = (label: string, value: number, to: string, icon: React.ComponentType<any>, tone: string, flag?: React.ReactNode) => {
    const Icon = icon;
    const t = flag && value ? "alert" : tone;
    return (
      <ClickableTile key={label} className={`ag-tile ag-ktile ag-kt-${t}`} href={to} onClick={(e: React.SyntheticEvent) => { e.preventDefault(); nav(to); }}>
        <div className="ag-row between"><div className="label">{label}</div><span className="ag-kt-icon" aria-hidden="true"><Icon size={20} /></span></div>
        <div className="ag-row snug"><span className="value"><CountUp value={value} /></span>{flag}</div>
      </ClickableTile>
    );
  };
  // The tile label already says what changed, so the tag says only the state.
  const flag = (n: number, value: string, label?: string) => (n ? <StatusTag kind="attention" value={value} label={label} /> : null);
  return (
    <>
      <PageIntro kicker={d.tenant} title="Overview" lead="What waits on you, then the governance pipeline and the state of the estate."
        about="The model below is derived from your estate and backlog. Decisions, the governance catalogue and reviews are the human layer on top of it. Nothing here asserts compliance; it shows evidence and who has verified it."
        extra={<div className="ag-hero-stats" aria-label="Estate at a glance">
          {[["Applications", c.applications, "teal"], ["Resources", c.resources, "cyan"], ["Open findings", c.findings_open, c.findings_open ? "red" : "green"], ["Reviews in flight", d.pipeline?.in_flight ?? c.reviews_open ?? 0, "blue"]].map(([l, n, t]) => (
            <div key={String(l)} className={`ag-glass ag-glass-${t}`}><span className="n"><CountUp value={Number(n) || 0} /></span><span className="l">{l}</span></div>))}
        </div>}
        actions={busy ? <InlineLoading description="Evaluating conformance" /> : <Gated cap="pre_review" allowed={canEval} reason="Needs the Author role or platform admin"><Button kind="tertiary" size="md" renderIcon={Renew} onClick={async () => { setBusy(true); try { await post("/evaluate"); reload(); } finally { setBusy(false); } }}>Evaluate Conformance</Button></Gated>} />

      <MyWork w={work} />

      <div className="ag-tiles">
        {tile("Applications (derived)", c.applications, "/applications", Application, "teal")}
        {tile("Shared services", c.shared_services ?? 0, "/applications#shared", ChartNetwork, "teal")}
        {tile("Resources", c.resources, "/applications", Cube, "cyan")}
        {tile("Open findings", c.findings_open, "/conformance", WarningAlt, "green", flag(c.findings_open, "open"))}
        {tile("Reviews in progress", d.pipeline?.in_flight ?? c.reviews_open, "/reviews", TaskApproved, "blue")}
        {tile("Overdue conditions", c.conditions_overdue, "/conformance?tab=conditions", Time, "green", flag(c.conditions_overdue, "overdue"))}
        {tile("Expired exceptions", c.exceptions_expired, "/conformance?tab=exceptions", Unlocked, "green", flag(c.exceptions_expired, "expired"))}
        {tile("Epics without a decision", c.epics_without_decision, "/backlog?filter=no_decision", DecisionTree, "purple", flag(c.epics_without_decision, "decision"))}
        {tile("Planned change after approval", c.material_changes, "/backlog?filter=changed", ChangeCatalog, "purple", flag(c.material_changes, "changed", "Changed"))}
      </div>

      {/* The state of the estate at a glance (gauges + donut), then the comparisons and the trend; the pipeline detail follows. */}
      <React.Suspense fallback={<div className="ag-charts"><Tile className="ag-chart"><SkeletonText paragraph lineCount={5} /></Tile><Tile className="ag-chart"><SkeletonText paragraph lineCount={5} /></Tile></div>}>
        <OverviewCharts bySeverity={d.bySeverity || {}} trend={d.trend} evidenceBySource={d.evidence_by_source} verification={v}
          byApp={d.byApp} stages={d.pipeline?.by_stage ? Object.entries(d.pipeline.by_stage) : Array.isArray(d.reviews_by_stage) ? d.reviews_by_stage.map((x: any) => [x.stage, x.n]) : undefined} />
      </React.Suspense>

      <Pipeline d={d} boards={boards || []} sessions={sessions || []} />
      <p className="ag-muted ag-body ag-mb-07">
        {/* links inside running text are inline (underlined), never colour alone */}
        Last evaluation {d.lastRun ? fmtDateTime(d.lastRun.finished_at) : "never"}{d.lastRun ? ` · ${d.lastRun.stats.standards} checkable items over ${d.lastRun.stats.resources} resources` : ""}.
        {c.artefacts && <> Catalogue: <RLink inline to="/governance?kind=standard">{c.artefacts.standard ?? 0} standards</RLink>, <RLink inline to="/governance?kind=principle">{c.artefacts.principle ?? 0} principles</RLink>, <RLink inline to="/governance?kind=pattern">{c.artefacts.pattern ?? 0} patterns</RLink>, <RLink inline to="/governance?kind=policy">{c.artefacts.policy ?? 0} policies</RLink>{c.drafts_in_review ? <> · <RLink inline to="/reviews">{c.drafts_in_review} draft{c.drafts_in_review === 1 ? "" : "s"} in review</RLink></> : null}.</>}
      </p>

      <section className="ag-section">
        <h2>Human Verification Coverage</h2>
        <div className="ag-grid-2">
          <div className="ag-stack">
            <Coverage label="Applications" value={v.applications.verified || 0} total={v.applications.total} />
            <Coverage label="Resources" value={v.resources.verified || 0} total={v.resources.total} />
            <Coverage label="Resource to application links" value={v.relations.verified || 0} total={v.relations.total} />
          </div>
          <div className="ag-stack">
            <Coverage label="Decisions" value={v.decisions.verified || 0} total={v.decisions.total} />
            <Coverage label="AI outputs" value={v.ai_outputs.verified || 0} total={v.ai_outputs.total || 0} />
          </div>
        </div>
        <p className="ag-muted ag-label ag-mt-03">Verification drops back to unverified automatically when the underlying evidence changes.</p>
      </section>
    </>
  );
}

const reviewLink = (r: any) => (r?.id ? <RLink to={`/reviews/${r.id}`}>{r.code || "Review"}</RLink> : <span>{r?.code || "Review"}</span>);
const sessionLink = (s: any) => (s?.id ? <RLink to={`/sessions/${s.id}`}>{s.code}</RLink> : s?.code ? <span>{s.code}</span> : null);
const count = (n: number) => <Tag size="sm" type="gray"><span title="How many items are in this queue.">{n}</span></Tag>;

/**
 * My work: one compact list per queue that is waiting on this person, each row linking to where the action happens.
 * Hidden entirely when the server has no such route (older API) or when nothing waits (auditors, a platform admin without a seat).
 */
function MyWork({ w }: { w: any }) {
  if (!w) return null;
  const list = (k: string): any[] => (Array.isArray(w[k]) ? w[k] : []);
  const positions = list("positions"), declare = list("declare"), resolve = list("resolve"), assessments = list("assessments"), sessions = list("sessions"), circulations = list("circulations"), resubmit = list("resubmit"), changed = list("changed"), noDecision = list("no_decision"), signOffs = list("sign_offs");
  // Overdue conditions first, then by due date.
  const conditions = [...list("conditions")].sort((a, b) => Number(b.status === "overdue") - Number(a.status === "overdue") || String(a.due_at || "").localeCompare(String(b.due_at || "")));
  const total = positions.length + declare.length + resolve.length + assessments.length + sessions.length + conditions.length + circulations.length + resubmit.length + changed.length + noDecision.length + signOffs.length;
  if (total === 0) return null;
  const head = (title: string, n: number) => <span className="ag-work-head">{title}{count(n)}</span>;
  const queue = (key: string, title: string, rows: any[], row: (x: any, i: number) => React.ReactNode) => rows.length === 0 ? null : (
    <ContainedList key={key} className={`ag-queue ag-q-${key}`} label={head(title, rows.length)} kind="on-page" size="sm">
      {rows.map((x, i) => <ContainedListItem key={x.id || x.review?.id || x.position_id || x.work_item?.id || i}><div className="ag-work-row">{row(x, i)}</div></ContainedListItem>)}
    </ContainedList>);
  return (
    <section className="ag-section">
      <h2 className="ag-work-head">My Work <Tag size="sm" type="blue"><span title="Everything waiting for you, across all your queues.">{total}</span></Tag></h2>
      <div className="ag-work">
        {queue("positions", "Positions awaited from you", positions, (x) => <>{reviewLink(x.review)}<span className="ag-muted ag-label">{x.review?.title}</span>{(x.areas || []).map((a: string) => <AreaPositionTag key={a} area={a} state="missing" mine size="sm" />)}{sessionLink(x.session)}</>)}
        {queue("declare", "Ready to declare", declare, (x) => <>{reviewLink(x.review)}<span className="ag-muted ag-label">{x.review?.title}</span>{x.ready ? <StatusTag kind="item_state" value="ready" size="sm" /> : (x.outstanding || []).length ? <span className="ag-muted ag-label">awaiting {x.outstanding.join(", ")}</span> : null}{sessionLink(x.session)}</>)}
        {queue("resolve", "Conditionals to resolve", resolve, (x) => <><span>{reviewLink(x.review)}</span><AreaPositionTag area={x.area} label={x.label} state="conditional" size="sm" /><span className="ag-muted ag-label">{x.by_name || x.by}{x.on_behalf_of ? ` for ${x.on_behalf_of}` : ""}{x.text ? ` · ${x.text}` : ""}</span>{sessionLink(x.session)}</>)}
        {queue("assessments", "Assessments assigned to you", assessments, (x) => <>{reviewLink(x.review)}<KindTag kind="assessment_type" value={x.type} />{x.title && <span className="ag-muted ag-label">{x.title}</span>}{x.area && <AreaTag id={x.area} />}{x.due_at && <span className="ag-muted ag-label">due {fmtDate(x.due_at)}</span>}{x.overdue && <StatusTag kind="condition" value="overdue" size="sm" />}<span className="ag-muted ag-label">asked by {x.requested_by_name || x.requested_by}</span></>)}
        {queue("sessions", "Sessions this week", sessions, (x) => <>{sessionLink(x)}<span>{x.board?.name || x.board?.code}</span><span className="ag-muted ag-label">{fmtDateTime(x.scheduled_at)}</span><StatusTag kind="session_status" value={x.status} size="sm" />{x.my_role && <KindTag kind="board_role" value={x.my_role} />}{x.my_attendance === "present" || x.my_attendance === "apologies" ? <StatusTag kind="attendance" value={x.my_attendance} size="sm" label={x.my_attendance === "present" ? "I'm present" : "Apologies"} /> : <span className="ag-muted ag-label">attendance not recorded</span>}{typeof x.items === "number" && <span className="ag-muted ag-label">{x.items} item{x.items === 1 ? "" : "s"}{x.consent_count ? ` · ${x.consent_count} on consent` : ""}</span>}</>)}
        {queue("conditions", "Conditions you own", conditions, (x) => <>{reviewLink(x.review)}<span>{x.text}</span>{x.area && <AreaTag id={x.area} />}<span className="ag-muted ag-label">due {fmtDate(x.due_at)}</span><StatusTag kind="condition" value={x.status || "open"} size="sm" /></>)}
        {queue("circulations", "Circulations due", circulations, (x) => <>{reviewLink(x.review)}<span className="ag-muted ag-label">positions due {fmtDate(x.circulation_due)}</span>{x.overdue && <StatusTag kind="condition" value="overdue" size="sm" />}{(x.missing || []).length ? <span className="ag-muted ag-label">awaiting {x.missing.join(", ")}</span> : null}{x.mine && <StatusTag kind="position" value="mine" size="sm" label="Your position" />}</>)}
        {queue("resubmit", "Sent back to you", resubmit, (x) => <>{reviewLink(x.review)}<span className="ag-muted ag-label">{x.review?.title}</span><StatusTag kind="stage" value="changes_requested" size="sm" /><span className="ag-muted ag-label">by {x.requested_by}{x.requested_at ? ` · ${fmtDate(x.requested_at)}` : ""}{x.text ? ` · ${x.text}` : ""}</span></>)}
        {queue("changed", "Planned changes · changed after approval", changed, (x) => <><RLink to="/backlog?filter=changed">{x.work_item?.type} {x.work_item?.external_id}</RLink><span>{x.work_item?.title}</span><StatusTag kind="attention" value="changed" size="sm" />{x.review?.id && <span className="ag-muted ag-label">review {reviewLink(x.review)}</span>}</>)}
        {queue("sign_offs", "Reaffirmations due", signOffs, (x) => <><RLink to={x.subject?.kind === "decision" ? `/decisions/${x.subject.id}` : artefactLink(x.subject?.id)}>{x.subject?.code}</RLink><span className="ag-muted ag-label">{x.subject?.title}</span><span className="ag-muted ag-label">due {fmtDate(x.due)}</span><StatusTag kind="signoff_status" value={x.status} /></>)}
        {queue("no_decision", "Epics without a decision", noDecision, (x) => <><RLink to="/backlog?filter=no_decision">{x.work_item?.type} {x.work_item?.external_id}</RLink><span>{x.work_item?.title}</span>{x.work_item?.application_name && <span className="ag-muted ag-label">{x.work_item.application_name}</span>}<StatusTag kind="attention" value="decision" size="sm" label="No decision" /></>)}
      </div>
    </section>
  );
}

/**
 * The governance pipeline: reviews by stage as a tag row (colour + icon + word, counts in the words, never colour alone),
 * each board's in-flight count with its next sitting, and the follow-ups that keep approvals honest. Reads the newer
 * `pipeline` block when the server sends it; otherwise it is assembled from the older counts, the boards and the sessions.
 */
function Pipeline({ d, boards, sessions }: { d: any; boards: any[]; sessions: any[] }) {
  const p = d.pipeline || {};
  const c = d.counts || {};
  const stages: [string, number][] = p.by_stage && typeof p.by_stage === "object"
    ? Object.entries(p.by_stage).map(([k, n]) => [k, Number(n) || 0] as [string, number])
    : Array.isArray(d.reviews_by_stage) ? d.reviews_by_stage.map((x: any) => [x.stage, Number(x.n) || 0] as [string, number]) : [];
  stages.sort((a, b) => (STAGE_ORDER.indexOf(a[0]) + 1 || 99) - (STAGE_ORDER.indexOf(b[0]) + 1 || 99));
  const live = (s: any) => s && (s.status === "open" || s.status === "planned");
  // Next sitting per board: the server's, else the open one, else the soonest planned.
  const nextFor = (boardId: string) => { const own = sessions.filter((s) => (s.board?.id || s.board_id) === boardId && live(s)); return own.find((s) => s.status === "open") || own.filter((s) => s.status === "planned").sort((a, b) => String(a.scheduled_at).localeCompare(String(b.scheduled_at)))[0] || null; };
  const rows: any[] = Array.isArray(p.by_board) && p.by_board.length ? p.by_board.map((b: any) => ({ ...b, next_session: b.next_session ?? nextFor(b.id) })) : boards.map((b) => ({ id: b.id, code: b.code, name: b.name, in_flight: b.in_flight ?? 0, next_session: nextFor(b.id) }));
  const next = p.next_session || rows.map((r) => r.next_session && { ...r.next_session, board: r.next_session.board || { id: r.id, code: r.code, name: r.name } }).filter(Boolean).sort((a: any, b: any) => Number(b.status === "open") - Number(a.status === "open") || String(a.scheduled_at).localeCompare(String(b.scheduled_at)))[0] || null;
  const inFlight = typeof p.in_flight === "number" ? p.in_flight : c.reviews_open;
  const openConditions = typeof p.open_conditions === "number" ? p.open_conditions : undefined;
  const overdueConditions = typeof p.overdue_conditions === "number" ? p.overdue_conditions : c.conditions_overdue;
  const circulations = typeof p.circulations === "number" ? p.circulations : undefined;
  const changed = typeof p.changed_after_approval === "number" ? p.changed_after_approval : c.material_changes;
  const epics = typeof p.epics_without_decision === "number" ? p.epics_without_decision : c.epics_without_decision;
  const decisions: any[] = Array.isArray(d.decisions_by_status) ? d.decisions_by_status : [];
  return (
    <section className="ag-section">
      <h2>Governance Pipeline</h2>
      <div className="ag-pipeline">
        <div>
          <div className="ag-label ag-muted ag-mb-03">Reviews by stage · <RLink inline to="/reviews">{inFlight ?? 0} in flight</RLink></div>
          {stages.length === 0 ? <p className="ag-muted ag-body">No reviews yet.</p> : <div className="ag-row tight ag-stage-rail">{stages.map(([stage, n]) => <StatusTag key={stage} kind="stage" value={stage} label={`${labelFor("stage", stage)} · ${n}`} />)}</div>}
          {decisions.length > 0 && <p className="ag-muted ag-label ag-mt-03"><RLink inline to="/decisions">Decisions</RLink>: {decisions.map((x: any) => `${x.n} ${labelFor("decision", x.status).toLowerCase()}`).join(" · ")}</p>}
          <dl className="ag-kv ag-mt-05">
            <dt>Next session</dt><dd>{next ? <span className="ag-row tight"><RLink to={`/sessions/${next.id}`}>{next.code}</RLink><span>{next.board?.name || next.board?.code || ""}</span><span className="ag-muted">{fmtDateTime(next.scheduled_at)}</span><StatusTag kind="session_status" value={next.status} size="sm" /></span> : <span className="ag-muted">None planned · <RLink inline to="/sessions">Sessions</RLink></span>}</dd>
            <dt>Conditions</dt><dd><RLink inline to="/conformance?tab=conditions">{openConditions !== undefined ? `${openConditions} open` : "Open conditions"}</RLink>{overdueConditions ? <> · <StatusTag kind="condition" value="overdue" size="sm" label={`${overdueConditions} overdue`} /></> : null}</dd>
            {circulations !== undefined && <><dt>Circulations</dt><dd><RLink inline to="/reviews">{circulations} in circulation</RLink>{p.circulations_overdue ? <> · <StatusTag kind="condition" value="overdue" size="sm" label={`${p.circulations_overdue} overdue`} /></> : null}</dd></>}
            <dt>Follow-ups</dt><dd className="ag-row tight"><RLink inline to="/backlog?filter=changed">{changed ?? 0} changed after approval</RLink><span className="ag-muted">·</span><RLink inline to="/backlog?filter=no_decision">{epics ?? 0} epic{epics === 1 ? "" : "s"} without a decision</RLink></dd>
          </dl>
        </div>
        <div>
          <div className="ag-label ag-muted ag-mb-03">By board</div>
          {rows.length === 0 ? <p className="ag-muted ag-body">No boards yet.</p> : (
            <Table size="sm"><TableHead><TableRow><TableHeader>Board</TableHeader><TableHeader>In Flight</TableHeader><TableHeader>Next Session</TableHeader></TableRow></TableHead>
              <TableBody>{rows.map((b) => (
                <TableRow key={b.id}>
                  <TableCell><RLink to={`/boards/${b.id}`}>{b.name || b.code}</RLink></TableCell>
                  <TableCell>{b.in_flight ? <StatusTag kind="stage" value="in_review" label={`${b.in_flight} in review`} /> : <span className="ag-muted">0</span>}</TableCell>
                  <TableCell>{b.next_session ? <span className="ag-row tight"><RLink to={`/sessions/${b.next_session.id}`}>{b.next_session.code}</RLink><span className="ag-muted ag-label">{fmtDateTime(b.next_session.scheduled_at)}</span></span> : <span className="ag-muted">—</span>}</TableCell>
                </TableRow>))}</TableBody></Table>)}
        </div>
      </div>
    </section>
  );
}

/** First run: nothing is collected yet, so the page is the way in — three steps, each a real action. */
function GetStarted({ forced, onDone }: { forced: boolean; onDone: () => void }) {
  const [s, , sErr] = useLoad<any>(() => get("/settings"));
  const [busy, setBusy] = React.useState<string | null>(null);
  const [msg, setMsg] = React.useState<{ kind: "success" | "error"; text: string } | null>(null);
  const nav = useNavigate();
  const run = async (key: string, fn: () => Promise<any>, ok: (r: any) => string) => {
    setBusy(key);
    try { const r: any = await fn(); if (r && r.ok === false) throw new Error(r.error || "The source reported an error"); setMsg({ kind: "success", text: ok(r) }); onDone(); }
    catch (e: any) { setMsg({ kind: "error", text: String(e.message || e).split("\n")[0] }); }
    finally { setBusy(null); }
  };
  return (
    <>
      <PageHeader kicker={forced ? <RLink to="/">Back to the overview</RLink> : undefined} title="Get Started"
        subtitle="archigov derives the architecture model from a real estate; nothing is drawn by hand. Connect a source or load the demo estate, add the standards you want checked, and the overview fills in." />
      {msg && <InlineNotification kind={msg.kind} lowContrast title={msg.text} onCloseButtonClick={() => setMsg(null)} className="ag-notice" />}
      <div className="ag-start">
        <Tile className="ag-start-tile">
          <h3>1 · Load the Demo Estate</h3>
          <p className="ag-body ag-muted">A fictional NHS trust: 39 Azure resources that derive into 8 applications, with standards, decisions, reviews and imported Defender assessments. Reversible: delete the data directory to start again.</p>
          {busy === "demo" ? <InlineLoading description="Loading the demo estate" /> : <Button size="md" renderIcon={Play} onClick={() => run("demo", () => post("/sources/demo/load"), (r) => `Demo estate loaded · ${r?.stats?.applications ?? ""} applications derived from ${r?.collected ?? r?.stats?.created ?? ""} resources`)}>Load Demo Estate</Button>}
        </Tile>
        <Tile className="ag-start-tile">
          <h3>2 · Connect Azure</h3>
          <p className="ag-body ag-muted">Read-only Resource Graph access with Reader on the subscriptions in scope. Only metadata is read; there is no data-plane access.</p>
          {s?.azure_configured
            ? (busy === "azure" ? <InlineLoading description="Collecting from Azure Resource Graph" /> : <Button size="md" kind="tertiary" renderIcon={Renew} onClick={() => run("azure", () => post("/sources/azure/sync"), (r) => `Collected ${r.collected} resources from Azure Resource Graph`)}>Sync Now</Button>)
            : <>
                <p className="ag-muted ag-label">Set <span className="ag-mono">AZURE_TENANT_ID</span>, <span className="ag-mono">AZURE_CLIENT_ID</span> and <span className="ag-mono">AZURE_CLIENT_SECRET</span> (or a managed identity), optionally <span className="ag-mono">AZURE_SUBSCRIPTIONS</span>, on the container and restart it.{sErr ? ` (${sErr})` : ""}</p>
                <Gated cap="manage_platform" mode="hide"><Button size="md" kind="tertiary" renderIcon={SettingsIcon} onClick={() => nav("/settings")}>Open Settings</Button></Gated>
              </>}
        </Tile>
        <Tile className="ag-start-tile">
          <h3>3 · Add Standards and Policies</h3>
          <p className="ag-body ag-muted">Standards are the human statements the estate is checked against. Start with the architecture pack; resource-level checks arrive as imported evidence from Defender for Cloud and Azure Policy rather than being rebuilt here.</p>
          <div><PackImporter onImported={onDone} /><div className="ag-mt-05"><RLink to="/governance">Or write your own in the catalogue</RLink></div></div>
        </Tile>
      </div>
    </>
  );
}
