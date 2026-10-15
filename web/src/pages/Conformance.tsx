import React from "react";
import { Tabs, TabList, Tab, TabPanels, TabPanel, Button, SkeletonText, Table, TableHead, TableRow, TableHeader, TableBody, TableCell, TableContainer, Select, SelectItem, Modal, TextArea, InlineLoading, Search, CodeSnippet, Tag, OverflowMenu, OverflowMenuItem, Link as CarbonLink } from "@carbon/react";
import { Renew } from "@carbon/icons-react";
import { get, post, fmtDate, fmtDateTime, shortType, labelFor } from "../api";
import { PageIntro, useLoad, SeverityTag, Empty, VerificationTag, LoadError, RLink, StatusTag, DateField, FindingEvidence, useTabParam, ExportMenu, EmptyState, KindTag, artefactLink, useDocTitle } from "../components";
import { Gated, useCan } from "../auth";

const TABS = ["findings", "drift", "exceptions", "conditions", "changes", "runs"];
const uniq = (xs: any[], id: string, name: string) => Array.from(new Map(xs.filter((x) => x[id]).map((x) => [x[id], x[name]])).entries()).sort((a, b) => String(a[1]).localeCompare(String(b[1])));

export default function Conformance() {
  const [d, reload, err] = useLoad<any>(() => get("/conformance"));
  const [tab, onTab] = useTabParam(TABS);
  const [sev, setSev] = React.useState("all");
  const [app, setApp] = React.useState("all");
  const [std, setStd] = React.useState("all");
  const [q, setQ] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [exc, setExc] = React.useState<any>(null);
  const [resolve, setResolve] = React.useState<any>(null);
  const [runId, setRunId] = React.useState<string | null>(null);
  // Both hooks run every render (no short-circuit); a chair has either capability.
  const canExcept = useCan("grant_exception");
  const canResolve = useCan("resolve_finding");
  const chair = canExcept || canResolve;
  useDocTitle("Conformance");
  if (err) return <LoadError what="conformance" err={err} onRetry={reload} />;
  if (!d) return <SkeletonText paragraph lineCount={8} />;
  const apps = uniq(d.findings, "application_id", "application_name");
  const stds = uniq(d.findings, "standard_id", "standard_code");
  const ql = q.trim().toLowerCase();
  const findings = d.findings.filter((f: any) => (sev === "all" || f.severity === sev) && (app === "all" || f.application_id === app) && (std === "all" || f.standard_id === std)
    && (!ql || [f.standard_code, f.standard_title, f.application_name, f.element_name, f.message].join(" ").toLowerCase().includes(ql)));
  const drift = d.decisionDrift.length;
  const runs: any[] = d.runs || [];
  const neverRun = runs.length === 0;
  return (
    <>
      <PageIntro title="Conformance" lead="Where what is deployed, planned or approved breaks a standard or a decision."
        about="Findings are raised by adopted catalogue items with a checkable rule, evaluated against the derived model and the imported evidence; decision drift is a deployed resource that contradicts an accepted decision. Re-evaluated hourly and whenever a decision is accepted. Exceptions keep a finding visible as excepted; conditions come from approvals; changed-after-approval items come from the backlog feed."
        actions={<>{busy ? <InlineLoading description="Evaluating" /> : <Gated cap="pre_review"><Button size="md" kind="tertiary" renderIcon={Renew} onClick={async () => { setBusy(true); try { await post("/evaluate"); reload(); } finally { setBusy(false); } }}>Evaluate Now</Button></Gated>}<ExportMenu /></>} />
      <Tabs selectedIndex={tab} onChange={onTab}>
        <TabList aria-label="Conformance views">
          <Tab>Findings ({d.findings.length})</Tab><Tab>Decision Drift ({drift})</Tab><Tab>Exceptions ({d.exceptions.length})</Tab><Tab>Open Conditions ({d.conditions.length})</Tab><Tab>Changed After Approval ({d.materialChanges.length})</Tab><Tab>Run History ({runs.length})</Tab>
        </TabList>
        <TabPanels>
          <TabPanel>
            {drift > 0 && <p className="ag-muted ag-label ag-mb-03">Includes {drift} decision-drift finding{drift === 1 ? "" : "s"}, also listed under Decision drift.</p>}
            {d.findings.length === 0 ? (neverRun
              ? <EmptyState title="Nothing has been evaluated yet" actions={<><RLink to="/?start=1">Get started</RLink><RLink to="/governance">Catalogue</RLink></>}>Conformance compares the collected estate and the accepted decisions against adopted standards, patterns and policies that carry a checkable rule. Load or connect an estate, adopt some, then evaluate.</EmptyState>
              : <Empty>No open findings against the checkable standards.</Empty>) : (
              <>
                <div className="ag-row ag-mb-05 end">
                  <Select id="sev" labelText="Severity" inline value={sev} onChange={(e) => setSev(e.target.value)}><SelectItem value="all" text="All" />{["critical", "high", "medium", "low"].map((s) => <SelectItem key={s} value={s} text={labelFor("severity", s)} />)}</Select>
                  <Select id="app" labelText="Application" inline value={app} onChange={(e) => setApp(e.target.value)}><SelectItem value="all" text="All" />{apps.map(([id, name]) => <SelectItem key={String(id)} value={String(id)} text={String(name)} />)}</Select>
                  <Select id="std" labelText="Standard" inline value={std} onChange={(e) => setStd(e.target.value)}><SelectItem value="all" text="All" />{stds.map(([id, code]) => <SelectItem key={String(id)} value={String(id)} text={String(code)} />)}</Select>
                  <Search id="fq" size="md" labelText="Filter findings" placeholder="e.g. sql-referrals" value={q} onChange={(e) => setQ(e.target.value)} onClear={() => setQ("")} />
                </div>
                {findings.length === 0 ? <Empty>No findings match these filters.</Empty> : (
                  <TableContainer><Table size="sm">
                    <TableHead><TableRow><TableHeader>Severity</TableHeader><TableHeader>Catalogue Item</TableHeader><TableHeader>Application</TableHeader><TableHeader>Element</TableHeader><TableHeader>Evidence</TableHeader><TableHeader>Status</TableHeader><TableHeader>Actions</TableHeader></TableRow></TableHead>
                    <TableBody>{findings.map((f: any) => (
                      <TableRow key={f.id}>
                        <TableCell><SeverityTag s={f.severity} /></TableCell>
                        <TableCell><div className="ag-row tight"><RLink to={artefactLink(f.standard_id)}>{f.artefact_code || f.standard_code}</RLink>{f.artefact_kind && f.artefact_kind !== "standard" && <KindTag kind="kind" value={f.artefact_kind} />}</div><div className="ag-muted ag-label">{f.standard_title}</div></TableCell>
                        <TableCell>{f.application_id ? <RLink to={`/applications/${f.application_id}`}>{f.application_name}</RLink> : "—"}</TableCell>
                        {/* Verification only when a person has stood behind the element; "not verified" is the default and says nothing on every row. */}
                        <TableCell>{f.element_name}<div className="ag-muted ag-label">{shortType(f.element_type)}</div>{f.element_verification === "verified" && <div className="ag-mt-02"><VerificationTag state="verified" /></div>}</TableCell>
                        <TableCell><FindingEvidence e={f.evidence} /></TableCell>
                        <TableCell><StatusTag kind="finding" value={f.status} /><div className="ag-muted ag-label ag-mt-02 ag-nowrap">since {fmtDate(f.first_seen)}</div></TableCell>
                        {/* Several row actions in a dense table: Carbon's overflow menu keeps the column 2rem wide. Only a chair sees it. */}
                        <TableCell>{f.status === "open" && chair && (
                          <OverflowMenu aria-label="Finding actions" size="sm" flipped>
                            <OverflowMenuItem itemText="Grant exception" onClick={() => setExc({ standard_id: f.standard_id, application_id: f.application_id, element_id: f.element_id, reason: "", expires_at: "", label: `${f.standard_code} for ${f.element_name || f.application_name}` })} />
                            <OverflowMenuItem itemText="Mark resolved" onClick={() => setResolve({ id: f.id, reason: "", label: `${f.standard_code} for ${f.element_name || f.application_name}` })} />
                          </OverflowMenu>)}</TableCell>
                      </TableRow>))}</TableBody>
                  </Table></TableContainer>)}
              </>)}
          </TabPanel>
          <TabPanel>
            <p className="ag-body ag-mb-05">Deployed resources that contradict an accepted architecture decision. This is the gap between what the Design Authority approved and what runs.</p>
            {drift === 0 ? <Empty>Nothing deployed contradicts an accepted decision.</Empty> : d.decisionDrift.map((f: any) => (
              <div className="ag-finding" key={f.id}><div className="ag-row snug"><SeverityTag s={f.severity} /><span className="title">{f.message}</span></div><div className="detail"><RLink inline to={`/applications/${f.application_id}`}>{f.application_name}</RLink> · {f.evidence.decision} allows {(f.evidence.allowedTypes || []).map(shortType).join(", ")} · actual {shortType(f.evidence.actualType)} · <RLink inline to={`/decisions/${f.decision_id}`}>open decision</RLink></div></div>))}
          </TabPanel>
          <TabPanel>
            {d.exceptions.length === 0 ? <Empty>No exceptions. Grant one from a finding when a risk is accepted knowingly; it keeps the finding visible as excepted rather than deleting it.</Empty> : (
              <Table size="sm"><TableHead><TableRow><TableHeader>Standard</TableHeader><TableHeader>Application</TableHeader><TableHeader>Reason</TableHeader><TableHeader>Approved By</TableHeader><TableHeader>Expires</TableHeader><TableHeader>Status</TableHeader></TableRow></TableHead>
                <TableBody>{d.exceptions.map((e: any) => <TableRow key={e.id}><TableCell>{e.standard_code}<div className="ag-muted ag-label">{e.standard_title}</div></TableCell><TableCell>{e.application_name}</TableCell><TableCell>{e.reason}</TableCell><TableCell>{e.approved_by}</TableCell><TableCell>{fmtDate(e.expires_at)}</TableCell><TableCell><StatusTag kind="exception" value={e.status} /></TableCell></TableRow>)}</TableBody></Table>)}
          </TabPanel>
          <TabPanel>
            {d.conditions.length === 0 ? <Empty>No open conditions. Conditions are attached when a review is approved with conditions; each has an owner and a due date.</Empty> : (
              <Table size="sm"><TableHead><TableRow><TableHeader>Review</TableHeader><TableHeader>Condition</TableHeader><TableHeader>Owner</TableHeader><TableHeader>Due</TableHeader><TableHeader>Status</TableHeader></TableRow></TableHead>
                <TableBody>{d.conditions.map((c: any) => <TableRow key={c.id}><TableCell><RLink to={`/reviews/${c.review_id}`}>{c.review_code}</RLink><div className="ag-muted ag-label">{c.review_title}</div></TableCell><TableCell>{c.text}</TableCell><TableCell>{c.owner}</TableCell><TableCell>{fmtDate(c.due_at)}</TableCell><TableCell><StatusTag kind="condition" value={c.status} /></TableCell></TableRow>)}</TableBody></Table>)}
          </TabPanel>
          <TabPanel>
            <p className="ag-body ag-mb-05">Backlog items whose content changed after the design linked to them was approved. The approval may no longer cover what is being built.</p>
            {d.materialChanges.length === 0 ? <Empty>No material changes since approval.</Empty> : d.materialChanges.map((w: any) => <div className="ag-finding" key={w.id}><div className="ag-row snug"><StatusTag kind="attention" value="changed" /><span className="title">{w.type} {w.external_id} · {w.title}</span></div><div className="detail">{w.description}</div><div className="detail ag-muted">changed {fmtDate(w.changed_at)} · review {w.review_code ? <RLink inline to={`/reviews/${w.review_id}`}>{w.review_code}</RLink> : "—"} · <RLink inline to="/backlog">manage in the delivery backlog</RLink></div></div>)}
          </TabPanel>
          <TabPanel>
            {neverRun ? <Empty>No runs yet. Syncs and evaluations are recorded here with their outcome.</Empty> : (<>
              <p className="ag-muted ag-label ag-mb-03">Open a run to see what changed: findings opened, resolved and reopened by that evaluation.</p>
              <Table size="sm"><TableHead><TableRow><TableHeader>Kind</TableHeader><TableHeader>Source</TableHeader><TableHeader>Started</TableHeader><TableHeader>Status</TableHeader><TableHeader>Standards</TableHeader><TableHeader>Resources</TableHeader><TableHeader>Findings</TableHeader><TableHeader>Error</TableHeader></TableRow></TableHead>
                <TableBody>{runs.map((r: any) => { const st = r.stats || {}; const errLines = r.error ? String(r.error).split("\n") : []; return (
                  <TableRow key={r.id}>
                    <TableCell><Tag size="sm" type="gray"><span title="What this run did: a sync collects from a source; an evaluation checks the model against the adopted catalogue.">{labelFor("run_kind", r.kind || "evaluate")}</span></Tag></TableCell>
                    <TableCell>{r.source_name || <span className="ag-muted">—</span>}</TableCell>
                    <TableCell className="ag-nowrap"><CarbonLink href={`#run-${r.id}`} onClick={(e: React.MouseEvent) => { e.preventDefault(); setRunId(r.id); }}>{fmtDateTime(r.started_at)}</CarbonLink></TableCell>
                    <TableCell><StatusTag kind="run" value={r.status === "done" || r.status === "error" ? r.status : "running"} /></TableCell>
                    <TableCell>{st.standards ?? <span className="ag-muted">—</span>}</TableCell>
                    <TableCell>{st.resources ?? (st.created !== undefined ? `${st.created + (st.updated || 0) + (st.unchanged || 0)} collected` : <span className="ag-muted">—</span>)}</TableCell>
                    <TableCell>{st.findings ?? <span className="ag-muted">—</span>}{(st.opened || st.resolved) ? <span className="ag-muted"> (+{st.opened || 0} / −{st.resolved || 0})</span> : null}</TableCell>
                    <TableCell>{errLines.length === 0 ? <span className="ag-muted">—</span> : <><div>{errLines[0].slice(0, 160)}</div>{errLines.length > 1 && <CodeSnippet type="multi" hideCopyButton={false}>{r.error}</CodeSnippet>}</>}</TableCell>
                  </TableRow>); })}</TableBody></Table></>)}
          </TabPanel>
        </TabPanels>
      </Tabs>
      {runId && <RunModal id={runId} onClose={() => setRunId(null)} />}
      <Modal open={!!exc} modalHeading={`Grant Exception: ${exc?.label}`} primaryButtonText="Grant" secondaryButtonText="Cancel" primaryButtonDisabled={!exc?.reason} onRequestClose={() => setExc(null)}
        onRequestSubmit={async () => { await post("/exceptions", { standard_id: exc.standard_id, application_id: exc.application_id, element_id: exc.element_id, reason: exc.reason, expires_at: exc.expires_at ? new Date(exc.expires_at).toISOString() : null }); setExc(null); reload(); }}>
        {exc && <div className="ag-form"><TextArea id="reason" labelText="Reason (recorded with your name)" rows={3} value={exc.reason} onChange={(e) => setExc({ ...exc, reason: e.target.value })} /><DateField id="exp" labelText="Expires" helperText="Exceptions without an expiry are allowed but will be flagged in evidence packs" value={exc.expires_at} onChange={(ymd) => setExc({ ...exc, expires_at: ymd })} /></div>}
      </Modal>
      <Modal open={!!resolve} modalHeading={`Mark Resolved: ${resolve?.label}`} primaryButtonText="Mark Resolved" secondaryButtonText="Cancel" primaryButtonDisabled={!resolve?.reason?.trim()} onRequestClose={() => setResolve(null)}
        onRequestSubmit={async () => { await post(`/findings/${resolve.id}/resolve`, { reason: resolve.reason }); setResolve(null); reload(); }}>
        {resolve && <div className="ag-form"><p className="ag-body">Records that a person considers this finding dealt with, with your name and reason in the audit log. The next evaluation reopens it if the condition still holds.</p><TextArea id="rreason" labelText="Reason (required, recorded with your name)" rows={3} value={resolve.reason} onChange={(e) => setResolve({ ...resolve, reason: e.target.value })} /></div>}
      </Modal>
    </>
  );
}

/** What one run changed: the findings it opened, resolved and reopened. */
function RunModal({ id, onClose }: { id: string; onClose: () => void }) {
  const [r, , err] = useLoad<any>(() => get(`/runs/${id}`), [id]);
  const st = r?.stats || {};
  const ch = r?.changes || {};
  const group = (title: string, items: any[]) => (
    <section className="ag-section" key={title}><h3>{title} ({items.length})</h3>
      {items.length === 0 ? <p className="ag-muted ag-body">None.</p> : items.map((f: any) => (
        <div className="ag-finding" key={f.id}><div className="ag-row snug"><SeverityTag s={f.severity} /><RLink to={`/governance?q=${encodeURIComponent(f.standard_code || "")}`}>{f.standard_code}</RLink><span className="title">{f.element_name}</span>{f.application_id && <RLink to={`/applications/${f.application_id}`}>{f.application_name}</RLink>}</div><div className="detail ag-muted">{f.message}</div></div>))}
    </section>);
  const none = !ch.opened?.length && !ch.resolved?.length && !ch.reopened?.length;
  return (
    <Modal open passiveModal size="lg" modalHeading={r ? `${labelFor("run_kind", r.kind || "evaluate")} · ${fmtDateTime(r.started_at)}` : "Run"} onRequestClose={onClose}>
      {err ? <InlineLoadingError err={err} /> : !r ? <SkeletonText paragraph lineCount={6} /> : (
        <div>
          <dl className="ag-kv ag-mb-05">
            <dt>Kind</dt><dd>{labelFor("run_kind", r.kind || "evaluate")}{r.source_name ? ` · ${r.source_name}` : ""}</dd>
            <dt>Status</dt><dd><StatusTag kind="run" value={r.status === "done" || r.status === "error" ? r.status : "running"} /></dd>
            <dt>Scope</dt><dd>{st.standards !== undefined ? `${st.standards} checkable standards · ` : ""}{st.resources !== undefined ? `${st.resources} resources` : st.created !== undefined ? `${st.created + (st.updated || 0) + (st.unchanged || 0)} collected` : "—"}</dd>
            <dt>Findings</dt><dd>{st.findings ?? "—"}{st.excepted ? ` open · ${st.excepted} excepted` : ""}</dd>
            {r.error && <><dt>Error</dt><dd><CodeSnippet type="multi" hideCopyButton={false}>{r.error}</CodeSnippet></dd></>}
          </dl>
          {r.changes === undefined ? <p className="ag-muted ag-body">This server does not record per-run changes.</p> : none ? <p className="ag-muted ag-body">No changes: this run opened, resolved and reopened nothing.</p> : (
            <>{group("Opened", ch.opened || [])}{group("Resolved", ch.resolved || [])}{group("Reopened", ch.reopened || [])}</>)}
        </div>)}
    </Modal>
  );
}
function InlineLoadingError({ err }: { err: string }) { return <p className="ag-muted ag-body">Could not load this run: {err}</p>; }
