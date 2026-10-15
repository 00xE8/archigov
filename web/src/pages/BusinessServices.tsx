import React from "react";
import { useNavigate } from "react-router-dom";
import { DataTable, Table, TableHead, TableRow, TableHeader, TableBody, TableCell, TableContainer, TableToolbar, TableToolbarContent, TableToolbarSearch, TableExpandHeader, TableExpandRow, TableExpandedRow, DataTableSkeleton, InlineNotification, ActionableNotification, Tag } from "@carbon/react";
import { get, labelFor, shortType, slug } from "../api";
import { PageIntro, useLoad, LoadError, RLink, EmptyState, useDocTitle, CountUp, CriticalityTag, VerificationTag, CountTag, explainTag } from "../components";

/**
 * Business services → the applications behind them → their resources, regions and shared services: the dependency
 * mapping operational-resilience rules ask for (PRA SS1/21 ch. 5, FCA SYSC 15A.4, DORA Art. 8, NCSC CAF A3), derived
 * from the model and the applications' classification — never drawn.
 */
export default function BusinessServices() {
  const [data, reload, err] = useLoad<any>(() => get("/business-services"));
  useDocTitle("Business Services");
  const nav = useNavigate();
  const headers = [{ key: "name", header: "Service" }, { key: "kind", header: "Kind" }, { key: "apps", header: "Applications" }, { key: "resources", header: "Resources" }, { key: "regions", header: "Regions" }, { key: "shared", header: "Shared Services Relied On" }, { key: "open", header: "Open Findings" }, { key: "verified", header: "Classification" }];
  if (err) return <LoadError what="business services" err={err} onRetry={reload} />;
  const counts = data?.counts;
  const intro = (
    <PageIntro title="Business Services" lead="The services the estate supports, mapped to the applications, resources, regions and shared services behind them."
      about="Each application's classification names the services it supports — an important business service (PRA SS1/21, FCA SYSC 15A), a critical or important function (DORA), an essential function (NCSC CAF) or a plain business service — and how critical it is. This page turns that into the dependency map those rules ask for: every service, the applications behind it, and through them the resources, regions and shared platforms it relies on. It is derived from tags and from classifications people set; nothing here is drawn by hand."
      extra={counts ? <div className="ag-hero-stats" aria-label="Classification at a glance">
        {([["Critical", counts.critical, "red"], ["Important", counts.important, "blue"], ["Standard", counts.standard, "teal"], ["Unclassified", counts.unclassified, "cyan"], ["Human Verified", counts.verified, "green"]] as [string, number, string][]).map(([l, n, t]) => (
          <div key={l} className={`ag-glass ag-glass-${t}`}><span className="n"><CountUp value={Number(n) || 0} /></span><span className="l">{l} {l === "Human Verified" ? `of ${counts.applications}` : "applications"}</span></div>))}
      </div> : undefined} />
  );
  if (!data) return <>{intro}<DataTableSkeleton headers={headers} rowCount={5} showHeader={false} showToolbar /></>;
  const rowId = (s: any) => `${s.kind}-${slug(s.name)}`;
  const rows = data.services.map((s: any) => ({ id: rowId(s), name: s.name, kind: labelFor("service_kind", s.kind), apps: s.applications.length, resources: s.resources, regions: s.regions.join(", "), shared: s.shared_services.length, open: s.open_findings, verified: s.verified ? 1 : 0 }));
  const byId = new Map(data.services.map((s: any) => [rowId(s), s]));
  return (
    <>
      {intro}
      {(data.unclassified.length > 0 || data.critical_without_service.length > 0) && (
        <div className="ag-mb-05">
          {data.unclassified.length > 0 && <ActionableNotification kind="warning" lowContrast inline hideCloseButton className="ag-notice"
            title={`${data.unclassified.length} application${data.unclassified.length === 1 ? "" : "s"} unclassified`}
            subtitle={`No tag says how critical ${data.unclassified.length === 1 ? "it is" : "they are"} and nobody has classified ${data.unclassified.length === 1 ? "it" : "them"}: ${data.unclassified.map((a: any) => a.name).join(", ")}.`}
            actionButtonLabel="Show Unclassified" onActionButtonClick={() => nav("/applications?criticality=unclassified")} />}
          {data.critical_without_service.length > 0 && <InlineNotification kind="info" lowContrast hideCloseButton title="Critical applications with no named service"
            subtitle={`Classified critical, but no service names what depends on them: ${data.critical_without_service.map((a: any) => a.name).join(", ")}.`} />}
        </div>)}
      {data.services.length === 0 ? (
        <EmptyState title="No services named yet" actions={<RLink to="/applications">Classify an application</RLink>}>
          Services come from tags on resources (<span className="ag-mono">ibs</span>, <span className="ag-mono">cif</span>, <span className="ag-mono">essential-function</span>, <span className="ag-mono">business-service</span>) or from a classification a person sets on an application.
        </EmptyState>
      ) : (
        <DataTable rows={rows} headers={headers} isSortable>
          {({ rows, headers, getHeaderProps, getRowProps, getTableProps, getExpandHeaderProps, getExpandedRowProps, onInputChange }: any) => (
            <TableContainer title="Service Dependency Map" description="Expand a service to see each application behind it, its resource types, regions and the shared platforms it relies on.">
              <TableToolbar><TableToolbarContent><TableToolbarSearch onChange={onInputChange} placeholder="e.g. referrals" persistent /></TableToolbarContent></TableToolbar>
              <Table {...getTableProps()} size="md">
                <TableHead><TableRow><TableExpandHeader {...getExpandHeaderProps()} aria-label="Expand all services" />{headers.map((h: any) => <TableHeader {...getHeaderProps({ header: h })} key={h.key}>{h.header}</TableHeader>)}</TableRow></TableHead>
                <TableBody>{rows.map((r: any) => { const s: any = byId.get(r.id); return (
                  <React.Fragment key={r.id}>
                    <TableExpandRow {...getRowProps({ row: r })} aria-label={`Show what ${s.name} depends on`}>
                      <TableCell><strong>{s.name}</strong></TableCell>
                      <TableCell><Tag size="sm" type={s.regulated ? "high-contrast" : "gray"}><span title={explainTag("service_kind", s.kind)}>{labelFor("service_kind", s.kind)}</span></Tag></TableCell>
                      <TableCell><div className="ag-row tight">{s.applications.map((a: any) => <RLink key={a.id} to={`/applications/${a.id}`}>{a.name}</RLink>)}</div></TableCell>
                      <TableCell>{s.resources}</TableCell>
                      <TableCell><span className="ag-mono">{s.regions.join(", ") || "—"}</span></TableCell>
                      <TableCell>{s.shared_services.length ? s.shared_services.map((x: any) => x.name).join(", ") : <span className="ag-muted">None</span>}</TableCell>
                      <TableCell><CountTag n={s.open_findings} /></TableCell>
                      <TableCell>{s.verified ? <VerificationTag state="verified" /> : <VerificationTag state="unverified" />}</TableCell>
                    </TableExpandRow>
                    <TableExpandedRow {...getExpandedRowProps({ row: r })} colSpan={headers.length + 1}>
                      <Table size="sm" aria-label={`Applications behind ${s.name}`}>
                        <TableHead><TableRow><TableHeader>Application</TableHeader><TableHeader>Criticality</TableHeader><TableHeader>Resources by Type</TableHeader><TableHeader>Regions</TableHeader><TableHeader>Shared Services</TableHeader><TableHeader>Open Findings</TableHeader></TableRow></TableHead>
                        <TableBody>{s.applications.map((a: any) => (
                          <TableRow key={a.id}>
                            <TableCell><RLink to={`/applications/${a.id}`}>{a.name}</RLink></TableCell>
                            <TableCell><div className="ag-row tight"><CriticalityTag value={a.criticality} /><VerificationTag state={a.verification} origin={a.origin} size="sm" /></div></TableCell>
                            <TableCell><div className="ag-row tight">{a.resource_types.map((t: any) => <span key={t.type} className="ag-mono ag-nowrap">{shortType(t.type)} ×{t.n}</span>)}</div></TableCell>
                            <TableCell><span className="ag-mono">{a.regions.join(", ") || "—"}</span></TableCell>
                            <TableCell>{a.shared_services.length ? a.shared_services.map((x: any) => x.name).join(", ") : <span className="ag-muted">None</span>}</TableCell>
                            <TableCell><CountTag n={a.open_findings} /></TableCell>
                          </TableRow>))}</TableBody>
                      </Table>
                    </TableExpandedRow>
                  </React.Fragment>); })}</TableBody>
              </Table>
            </TableContainer>)}
        </DataTable>)}
    </>
  );
}
