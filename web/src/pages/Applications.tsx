import React from "react";
import { useLocation } from "react-router-dom";
import { DataTable, Table, TableHead, TableRow, TableHeader, TableBody, TableCell, TableContainer, TableToolbar, TableToolbarContent, TableToolbarSearch, DataTableSkeleton } from "@carbon/react";
import { get, UK_REGIONS } from "../api";
import { PageIntro, useLoad, VerificationTag, CountTag, LoadError, RLink, StatusTag, EmptyState, useDocTitle } from "../components";

export default function Applications() {
  const [apps, reload, err] = useLoad<any[]>(() => get("/applications"));
  // Shared services are a newer endpoint; an instance without it simply shows no section.
  const [shared, , sharedErr] = useLoad<any[]>(() => get("/shared-services"));
  // Which regions count as home is tenant policy, not the UI's: the `home_regions` setting (older servers fall back to
  // the historical UK default). While settings load, no region is flagged — never a wrong red that then disappears.
  const [settings, , settingsErr] = useLoad<any>(() => get("/settings"));
  const homeRegions: string[] | null = Array.isArray(settings?.home_regions) ? settings.home_regions : settingsErr ? UK_REGIONS : settings ? UK_REGIONS : null;
  const foreign = (l: string) => !!homeRegions && homeRegions.length > 0 && !homeRegions.includes(l);
  const loc = useLocation();
  useDocTitle("Applications");
  React.useEffect(() => { if (loc.hash === "#shared" && shared) document.getElementById("shared")?.scrollIntoView({ block: "start" }); }, [loc.hash, shared]);
  if (err) return <LoadError what="applications" err={err} onRetry={reload} />;
  const hasEvidence = !!apps?.some((a) => typeof a.evidence_fail_count === "number");
  const headers = [
    { key: "name", header: "Application" }, { key: "owners", header: "Owner" }, { key: "resource_count", header: "Resources" }, { key: "locations", header: "Regions" }, { key: "decision_count", header: "Decisions" }, { key: "open_findings", header: "Open Findings" },
    ...(hasEvidence ? [{ key: "evidence_fail_count", header: "Imported Evidence" }] : []),
    { key: "how", header: "How It Was Derived" }, { key: "verification", header: "Verification" },
  ];
  if (!apps) return <DataTableSkeleton headers={headers} rowCount={6} showHeader={false} showToolbar />;
  const rows = apps.map((a) => ({ id: a.id, name: a.name, owners: a.owners.join(", ") || "—", resource_count: a.resource_count, locations: a.locations.join(", "), decision_count: a.decision_count, open_findings: a.open_findings, evidence_fail_count: a.evidence_fail_count ?? "", how: (a.provenance.methods || []).join(", "), verification: a.verification }));
  return (
    <>
      <PageIntro title="Applications" lead="Inferred from the connected estate, never typed in, with the method and confidence recorded."
        about="Applications are not entered by hand. They are inferred from tags and resource-group conventions in the connected estate, with the method and confidence recorded so a person can confirm or correct each one. Hub networks, shared platforms and identity resource groups are classified as shared services instead." />
      {apps.length === 0 ? (
        <EmptyState title="No applications yet" actions={<RLink to="/?start=1">Get started</RLink>}>
          Applications are derived from a connected estate, never typed in. Connect Azure or load the demo estate and they appear here with the method and confidence recorded.
        </EmptyState>
      ) : (
      <DataTable rows={rows} headers={headers} isSortable>
        {({ rows, headers, getHeaderProps, getRowProps, getTableProps, onInputChange }: any) => (
          <TableContainer>
            <TableToolbar><TableToolbarContent><TableToolbarSearch onChange={onInputChange} placeholder="e.g. Referral API" persistent /></TableToolbarContent></TableToolbar>
            <Table {...getTableProps()} size="md">
              <TableHead><TableRow>{headers.map((h: any) => <TableHeader {...getHeaderProps({ header: h })} key={h.key}>{h.header}</TableHeader>)}</TableRow></TableHead>
              <TableBody>{rows.map((r: any) => { const a = apps.find((x) => x.id === r.id)!; return (
                <TableRow {...getRowProps({ row: r })} key={r.id}>
                  <TableCell><RLink to={`/applications/${a.id}`}>{a.name}</RLink></TableCell>
                  <TableCell>{a.owners.join(", ") || <span className="ag-muted">None</span>}</TableCell>
                  <TableCell>{a.resource_count}</TableCell>
                  <TableCell><div className="ag-row tight">{a.locations.map((l: string) => (foreign(l) ? <StatusTag key={l} kind="attention" value="region" label={`${l} · outside home regions`} /> : <span key={l} className="ag-mono">{l}</span>))}</div></TableCell>
                  <TableCell>{a.decision_count}</TableCell>
                  <TableCell><CountTag n={a.open_findings} /></TableCell>
                  {/* zero failing is the quiet default (as everywhere): a muted count, a tag only when something fails */}
                  {hasEvidence && <TableCell>{typeof a.evidence_fail_count === "number" ? (a.evidence_fail_count ? <StatusTag kind="evidence" value="fail" label={`${a.evidence_fail_count} failing`} /> : <span className="ag-muted">0 failing</span>) : "—"}</TableCell>}
                  <TableCell><span className="ag-mono ag-nowrap">{(a.provenance.methods || []).join(", ")}</span> <span className="ag-muted">· {Math.round(a.confidence * 100)}%</span></TableCell>
                  <TableCell><VerificationTag state={a.verification} origin={a.origin} by={a.verified_by} at={a.verified_at} /></TableCell>
                </TableRow>); })}</TableBody>
            </Table>
          </TableContainer>)}
      </DataTable>)}

      {shared && !sharedErr && (
        <section className="ag-section ag-mt-07" id="shared">
          <h2>Shared Services</h2>
          <p className="ag-muted ag-body ag-mb-05">Hub networks, shared platforms and identity resource groups are classified here instead of becoming applications. They still appear as dependencies of the applications that use them.</p>
          {shared.length === 0 ? <p className="ag-muted ag-body">None detected in the connected estate.</p> : (
            <Table size="md">
              <TableHead><TableRow><TableHeader>Shared Service</TableHeader><TableHeader>Resources</TableHeader><TableHeader>Regions</TableHeader><TableHeader>Used By</TableHeader><TableHeader>Verification</TableHeader></TableRow></TableHead>
              <TableBody>{shared.map((s: any) => (
                <TableRow key={s.id}>
                  <TableCell>{s.name}</TableCell>
                  <TableCell>{s.resource_count}</TableCell>
                  <TableCell><span className="ag-mono">{(s.locations || []).join(", ") || "—"}</span></TableCell>
                  <TableCell><div className="ag-row tight">{(s.used_by || []).length ? s.used_by.map((a: any) => <RLink key={a.id} to={`/applications/${a.id}`}>{a.name}</RLink>) : <span className="ag-muted">No application references it yet</span>}</div></TableCell>
                  <TableCell><VerificationTag state={s.verification} origin={s.origin} by={s.verified_by} at={s.verified_at} /></TableCell>
                </TableRow>))}</TableBody>
            </Table>)}
        </section>)}
    </>
  );
}
