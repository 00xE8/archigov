import React from "react";
import { useSearchParams } from "react-router-dom";
import { Tabs, TabList, Tab, TabPanels, TabPanel, DataTable, Table, TableHead, TableRow, TableHeader, TableBody, TableCell, TableContainer, TableToolbar, TableToolbarContent, TableToolbarSearch, TableExpandHeader, TableExpandRow, TableExpandedRow, DataTableSkeleton, Select, SelectItem, Button, InlineNotification, Tag } from "@carbon/react";
import { Add, Edit } from "@carbon/icons-react";
import { get, labelFor, fmtDate } from "../api";
import { PageIntro, useLoad, LoadError, RLink, Empty, useDocTitle, StatusTag, SeverityTag, OriginTag, CountUp, explainTag } from "../components";
import { Gated, useAuth } from "../auth";
import { LogRiskModal, UpdateRiskModal } from "../components/RiskModal";

const DEBT_LINK = (i: any) => i.link.kind === "decision" ? `/decisions/${i.link.id}` : i.link.kind === "review" ? `/reviews/${i.link.id}` : i.link.kind === "legacy" ? "/legacy" : i.link.kind === "third-parties" ? "/third-parties" : i.link.id ? `/applications/${i.link.id}` : null;

/**
 * The risk register — risks decisions accept, active exceptions, and risks authors log, each with an owner, a
 * severity and a review date — and the architecture debt derived from the records: aged findings, drift from
 * decisions, overdue conditions, end-of-life components, expired exceptions still failing, assessments and plans due.
 */
export default function RiskRegister() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "debt" ? 1 : 0;
  const [data, reload, err] = useLoad<any>(() => get("/risks"));
  const [debt, reloadDebt] = useLoad<any>(() => get("/debt"));
  const [status, setStatus] = React.useState("live");
  const [log, setLog] = React.useState(false);
  const [edit, setEdit] = React.useState<any>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const { me } = useAuth();
  const myId = me?.user?.id;
  useDocTitle("Risk Register");
  if (err) return <LoadError what="the risk register" err={err} onRetry={reload} />;
  const c = data?.counts;
  const intro = (
    <PageIntro title="Risk Register" lead="The architecture risks the organisation has accepted or is carrying, who owns each one, and the debt the records show."
      about="Risks come from three places: the risks a decision accepts (their standing follows the decision), every active exception (a finding knowingly accepted until it expires), and risks an author logs. Each has an owner, a severity and a review date; only its owner or whoever logged it changes it, and closing needs a note. Architecture debt is not logged at all: it is derived from findings open longer than the debt age, drift from accepted decisions, overdue conditions, end-of-life components, expired exceptions still failing, and legacy assessments and exit plans due."
      actions={<Gated cap="create_decision"><Button size="md" renderIcon={Add} onClick={() => setLog(true)}>Log Risk</Button></Gated>}
      extra={c ? <div className="ag-hero-stats" aria-label="Risks at a glance">
        {([["Open", c.open, "red"], ["Accepted", c.accepted, "magenta"], ["High or Critical", c.high_or_critical, "red"], ["Review Overdue", c.review_overdue, "cyan"], ["Debt Items", debt?.total ?? 0, "blue"]] as [string, number, string][]).map(([l, n, t]) => (
          <div key={l} className={`ag-glass ag-glass-${t}`}><span className="n"><CountUp value={Number(n) || 0} /></span><span className="l">{l}</span></div>))}
      </div> : undefined} />
  );
  const setTab = (i: number) => { const n = new URLSearchParams(params); if (i === 1) n.set("tab", "debt"); else n.delete("tab"); setParams(n, { replace: true }); };
  const risks = (data?.risks || []).filter((r: any) => status === "all" || (status === "live" ? ["open", "accepted", "proposed"].includes(r.status) : r.status === status));
  return (
    <>
      {intro}
      {msg && <InlineNotification kind="success" lowContrast className="ag-notice" title={msg} onCloseButtonClick={() => setMsg(null)} />}
      <Tabs selectedIndex={tab} onChange={({ selectedIndex }: any) => setTab(selectedIndex)}>
        <TabList aria-label="Risk register views"><Tab>Risks ({data ? data.risks.length : "…"})</Tab><Tab>Architecture Debt ({debt ? debt.total : "…"})</Tab></TabList>
        <TabPanels>
          <TabPanel>
            {!data ? <DataTableSkeleton rowCount={5} showHeader={false} /> : (
              <TableContainer>
                <TableToolbar><TableToolbarContent><div className="ag-toolbar-filters">
                  <Select id="rr-status" labelText="Show" inline value={status} onChange={(e) => setStatus(e.target.value)}>
                    <SelectItem value="live" text="Open, accepted and proposed" /><SelectItem value="all" text="All" />{["open", "accepted", "proposed", "mitigated", "closed", "withdrawn"].map((s) => <SelectItem key={s} value={s} text={labelFor("risk_status", s)} />)}
                  </Select></div></TableToolbarContent></TableToolbar>
                <Table size="md" aria-label="Risks">
                  <TableHead><TableRow><TableHeader>Risk</TableHeader><TableHeader>Severity</TableHeader><TableHeader>Source</TableHeader><TableHeader>Owner</TableHeader><TableHeader>Status</TableHeader><TableHeader>Review By</TableHeader><TableHeader>Actions</TableHeader></TableRow></TableHead>
                  <TableBody>{risks.length === 0 ? <TableRow><TableCell colSpan={7}><span className="ag-muted">No risk matches.</span></TableCell></TableRow> : risks.map((r: any) => (
                    <TableRow key={r.id}>
                      <TableCell className="ag-wrap">{r.code && <span className="ag-mono ag-label">{r.code} </span>}<span className="ag-strong">{r.title}</span>{r.origin === "ai_assisted" && <> <OriginTag origin="ai" /></>}
                        {r.description && <div className="ag-muted ag-label">{r.description}</div>}
                        {r.applications.length > 0 && <div className="ag-label">{r.applications.map((a: any, i: number) => <React.Fragment key={a.id}>{i > 0 ? ", " : ""}<RLink inline to={`/applications/${a.id}`}>{a.name}</RLink></React.Fragment>)}</div>}
                        {r.closure_note && <div className="ag-muted ag-label">{labelFor("risk_status", r.status)}: {r.closure_note}</div>}</TableCell>
                      <TableCell><SeverityTag s={r.severity} /></TableCell>
                      <TableCell><Tag size="sm" type="gray"><span title={explainTag("risk_source", r.source)}>{labelFor("risk_source", r.source)}</span></Tag>{r.decision && <div><RLink to={`/decisions/${r.decision.id}`}>{r.decision.code}</RLink></div>}</TableCell>
                      <TableCell>{r.owner_name || r.owner || <span className="ag-muted">—</span>}</TableCell>
                      <TableCell><StatusTag kind="risk_status" value={r.status} /></TableCell>
                      <TableCell>{r.review_by ? <>{fmtDate(r.review_by)}{r.review_overdue && <div><StatusTag kind="condition" value="overdue" label="Review overdue" /></div>}</> : <span className="ag-muted">—</span>}</TableCell>
                      <TableCell>{r.editable && (myId === r.owner || myId === r.created_by) ? <Button size="sm" kind="ghost" renderIcon={Edit} onClick={() => setEdit(r)}>Update</Button> : <span className="ag-muted ag-label">{r.source === "exception" ? "Via the exception" : "Owner only"}</span>}</TableCell>
                    </TableRow>))}</TableBody>
                </Table>
              </TableContainer>)}
          </TabPanel>
          <TabPanel>
            {!debt ? <DataTableSkeleton rowCount={5} showHeader={false} /> : debt.total === 0 ? <Empty>No architecture debt in the records.</Empty> : <DebtTable debt={debt} />}
          </TabPanel>
        </TabPanels>
      </Tabs>
      {log && <LogRiskModal onClose={() => setLog(false)} onDone={(r) => { setLog(false); setMsg(`${r.code} logged`); reload(); }} />}
      {edit && <UpdateRiskModal risk={edit} onClose={() => setEdit(null)} onDone={(r) => { setEdit(null); setMsg(`${r.code} updated`); reload(); reloadDebt(); }} />}
    </>
  );
}

function DebtTable({ debt }: { debt: any }) {
  const KINDS = Object.keys(debt.counts);
  const headers = [{ key: "application", header: "Application" }, { key: "total", header: "Debt Items" }, { key: "kinds", header: "What" }];
  const rows = debt.by_application.map((g: any) => ({ id: g.application?.id || "_tenant", application: g.application?.name || "Across the estate", total: g.total, kinds: "" }));
  const byId = new Map(debt.by_application.map((g: any) => [g.application?.id || "_tenant", g]));
  return (
    <DataTable rows={rows} headers={headers} isSortable>
      {({ rows, headers, getHeaderProps, getRowProps, getTableProps, getExpandHeaderProps, getExpandedRowProps, onInputChange }: any) => (
        <TableContainer title="Architecture Debt" description={`Derived from the records, never logged. A finding becomes debt after ${debt.finding_days} days open. Expand an application for each item and where it lives.`}>
          <TableToolbar><TableToolbarContent><TableToolbarSearch onChange={onInputChange} placeholder="e.g. Pharmacy" persistent /></TableToolbarContent></TableToolbar>
          <Table {...getTableProps()} size="md">
            <TableHead><TableRow><TableExpandHeader {...getExpandHeaderProps()} aria-label="Expand all applications" />{headers.map((h: any) => <TableHeader {...getHeaderProps({ header: h })} key={h.key}>{h.header}</TableHeader>)}</TableRow></TableHead>
            <TableBody>{rows.map((r: any) => { const g: any = byId.get(r.id); return (
              <React.Fragment key={r.id}>
                <TableExpandRow {...getRowProps({ row: r })} aria-label={`Show the debt items of ${g.application?.name || "the estate"}`}>
                  <TableCell>{g.application ? <RLink to={`/applications/${g.application.id}`}>{g.application.name}</RLink> : "Across the estate"}</TableCell>
                  <TableCell>{g.total}</TableCell>
                  <TableCell className="ag-wrap"><span className="ag-label">{KINDS.filter((k) => g.counts[k]).map((k) => `${labelFor("debt_kind", k)} ${g.counts[k]}`).join(" · ")}</span></TableCell>
                </TableExpandRow>
                <TableExpandedRow {...getExpandedRowProps({ row: r })} colSpan={headers.length + 1}>
                  <Table size="sm" aria-label={`Debt items of ${g.application?.name || "the estate"}`}>
                    <TableHead><TableRow><TableHeader>Kind</TableHeader><TableHeader>Item</TableHeader><TableHeader>Since</TableHeader></TableRow></TableHead>
                    <TableBody>{g.items.map((i: any, k: number) => { const to = DEBT_LINK(i); return (
                      <TableRow key={k}><TableCell className="ag-nowrap">{labelFor("debt_kind", i.kind)}</TableCell>
                        <TableCell className="ag-wrap">{to ? <RLink inline to={to}>{i.title}</RLink> : i.title}{i.detail && <div className="ag-muted ag-label">{i.detail}</div>}</TableCell>
                        <TableCell>{i.since ? fmtDate(i.since) : <span className="ag-muted">—</span>}</TableCell></TableRow>); })}</TableBody>
                  </Table>
                </TableExpandedRow>
              </React.Fragment>); })}</TableBody>
          </Table>
        </TableContainer>)}
    </DataTable>
  );
}
