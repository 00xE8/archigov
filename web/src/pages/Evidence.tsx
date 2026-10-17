import React from "react";
import { DataTable, Table, TableHead, TableRow, TableHeader, TableBody, TableCell, TableContainer, TableToolbar, TableToolbarContent, TableToolbarSearch, Select, SelectItem, Button, Modal, TextArea, SkeletonText, InlineNotification, InlineLoading } from "@carbon/react";
import { Upload, Renew } from "@carbon/icons-react";
import { get, post, fmtDateTime, labelFor, shortType } from "../api";
import { PageIntro, useLoad, LoadError, RLink, StatusTag, EmptyState, Empty, useDocTitle } from "../components";
import { Gated } from "../auth";

const SOURCES = ["defender", "azure_policy", "manual"];
const HEADERS = [{ key: "source", header: "Source" }, { key: "control", header: "Control" }, { key: "resource", header: "Resource" }, { key: "application", header: "Application" }, { key: "state", header: "State" }, { key: "detail", header: "Assessment" }, { key: "observed_at", header: "Observed" }];
const EXAMPLE = `[
  { "resourceName": "sql-referrals", "control": "min-tls-1.2", "state": "fail", "severity": "high", "detail": { "assessment": "Minimum TLS version should be 1.2" } },
  { "resourceName": "app-referrals-api", "control": "web-https-only", "state": "pass" }
]`;

export default function Evidence() {
  const [summary, reloadSummary, sErr] = useLoad<any>(() => get("/evidence/summary"));
  const [items, reloadItems, iErr] = useLoad<any[]>(() => get("/evidence"));
  const [source, setSource] = React.useState("all");
  const [control, setControl] = React.useState("all");
  const [state, setState] = React.useState("all");
  const [imp, setImp] = React.useState<any>(null);
  // Settings tell us whether Defender / Azure Policy can be synced from here; absent on an older API, so nothing is assumed.
  const [settings] = useLoad<any>(() => get("/settings").catch(() => null));
  const [syncing, setSyncing] = React.useState<string | null>(null);
  const [syncMsg, setSyncMsg] = React.useState<{ kind: "success" | "error" | "warning"; text: string } | null>(null);
  useDocTitle("Imported Evidence");
  if (sErr || iErr) return <LoadError what="imported evidence" err={(sErr || iErr)!} onRetry={() => { reloadSummary(); reloadItems(); }} />;
  if (!summary || !items) return <SkeletonText paragraph lineCount={8} />;
  const syncable = (k: "defender" | "policy") => !!(settings?.[k]?.configured || settings?.[k]?.fixtures);
  const sync = async (k: "defender" | "policy", label: string) => {
    setSyncing(k); setSyncMsg(null);
    try { const r: any = await post(`/sources/${k}/sync`); const un = r.unmatched?.length || 0; setSyncMsg({ kind: un ? "warning" : "success", text: `${label}: imported ${r.imported ?? "—"} assessments${un ? ` · ${un} unmatched resource${un === 1 ? "" : "s"}` : ""}` }); reloadSummary(); reloadItems(); }
    catch (e: any) { setSyncMsg({ kind: "error", text: `${label}: ${String(e.message || e).split("\n")[0]}` }); }
    finally { setSyncing(null); }
  };
  const controls = Array.from(new Set(items.map((e) => e.control))).sort();
  const visible = items.filter((e) => (source === "all" || e.source === source) && (control === "all" || e.control === control) && (state === "all" || e.state === state));
  const rows = visible.map((e) => ({ id: e.id, source: labelFor("evidence_source", e.source), control: e.control, resource: e.resource_name || "", application: e.application_name || "", state: e.state, detail: e.detail?.assessment || "", observed_at: e.observed_at || "" }));
  const sources: any[] = summary.sources || [];
  const openImport = () => setImp({ source: "defender", text: "", err: null, busy: false, result: null });
  const reloadAll = () => { reloadSummary(); reloadItems(); };
  return (
    <>
      <PageIntro title="Imported Evidence" lead="Resource-level assessments imported from Defender for Cloud and Azure Policy, attached to each resource."
        about="Resource-level compliance checks are produced by Defender for Cloud and Azure Policy. archigov imports their assessments as evidence attached to each resource and lets standards assert on that state; it never re-implements the check. Missing evidence is a finding, never a pass."
        actions={<>
          {syncable("defender") && (syncing === "defender" ? <InlineLoading description="Syncing Defender for Cloud" /> : <Gated cap="manage_platform" reason="Platform admin only"><Button size="md" kind="tertiary" renderIcon={Renew} disabled={!!syncing} onClick={() => sync("defender", "Defender for Cloud")}>Sync Defender for Cloud</Button></Gated>)}
          {syncable("policy") && (syncing === "policy" ? <InlineLoading description="Syncing Azure Policy" /> : <Gated cap="manage_platform" reason="Platform admin only"><Button size="md" kind="tertiary" renderIcon={Renew} disabled={!!syncing} onClick={() => sync("policy", "Azure Policy")}>Sync Azure Policy</Button></Gated>)}
          <Gated cap="manage_platform" reason="Platform admin only"><Button size="md" renderIcon={Upload} onClick={openImport}>Import Evidence</Button></Gated>
        </>} />
      {syncMsg && <InlineNotification kind={syncMsg.kind} lowContrast title={syncMsg.text} onCloseButtonClick={() => setSyncMsg(null)} className="ag-notice" />}
      {(summary.total ?? items.length) === 0 ? (
        <EmptyState title="No evidence imported yet" actions={<><Gated cap="manage_platform" reason="Platform admin only"><Button size="md" renderIcon={Upload} onClick={openImport}>Import Evidence</Button></Gated><RLink to="/?start=1">Get started</RLink></>}>
          Import assessments from Defender for Cloud or Azure Policy, or paste them manually, and the standards that assert on imported state start producing findings. The demo estate ships with a set.
        </EmptyState>
      ) : (<>
        <section className="ag-section"><h2>By Source</h2>
          <TableContainer><Table size="sm">
            <TableHead><TableRow><TableHeader>Source</TableHeader><TableHeader>Controls</TableHeader><TableHeader>Resources</TableHeader><TableHeader>Pass</TableHeader><TableHeader>Fail</TableHeader><TableHeader>Unknown</TableHeader><TableHeader>Last Import</TableHeader><TableHeader>Unmatched in Last Import</TableHeader></TableRow></TableHead>
            <TableBody>{sources.map((s: any) => (
              <TableRow key={s.source}>
                <TableCell>{labelFor("evidence_source", s.source)}</TableCell>
                <TableCell>{s.controls}</TableCell>
                <TableCell>{s.resources}</TableCell>
                <TableCell><StatusTag kind="evidence" value="pass" label={`${s.pass ?? 0} pass`} /></TableCell>
                <TableCell>{s.fail ? <StatusTag kind="evidence" value="fail" label={`${s.fail} fail`} /> : <span className="ag-muted">0</span>}</TableCell>
                <TableCell>{s.unknown ? <StatusTag kind="evidence" value="unknown" label={`${s.unknown} unknown`} /> : <span className="ag-muted">0</span>}</TableCell>
                <TableCell>{fmtDateTime(s.last_import)}</TableCell>
                <TableCell>{(s.last_unmatched || []).length ? <span>{s.last_unmatched.length} · <span className="ag-mono">{s.last_unmatched.slice(0, 3).join(", ")}{s.last_unmatched.length > 3 ? "…" : ""}</span></span> : <span className="ag-muted">0</span>}</TableCell>
              </TableRow>))}</TableBody>
          </Table></TableContainer>
        </section>
        {/* "Imported": machine evidence about resources — distinct from the human assessments requested on a review. */}
        <section className="ag-section"><h2>Imported Assessments ({items.length})</h2>
          {/* Filters sit above the table, not inside the toolbar, where Carbon's flex layout squeezes inline selects until their value clips. */}
          <div className="ag-filters ag-mb-05">
            <Select id="ev-src" labelText="Source" inline value={source} onChange={(e) => setSource(e.target.value)}><SelectItem value="all" text="All" />{SOURCES.map((s) => <SelectItem key={s} value={s} text={labelFor("evidence_source", s)} />)}</Select>
            <Select id="ev-ctl" labelText="Control" inline value={control} onChange={(e) => setControl(e.target.value)}><SelectItem value="all" text="All" />{controls.map((c) => <SelectItem key={c} value={c} text={c} />)}</Select>
            <Select id="ev-state" labelText="State" inline value={state} onChange={(e) => setState(e.target.value)}><SelectItem value="all" text="All" />{["pass", "fail", "unknown"].map((s) => <SelectItem key={s} value={s} text={labelFor("evidence", s)} />)}</Select>
          </div>
          <DataTable rows={rows} headers={HEADERS} isSortable>
            {({ rows, headers, getHeaderProps, getRowProps, getTableProps, onInputChange }: any) => (
              <TableContainer>
                <TableToolbar><TableToolbarContent>
                  <TableToolbarSearch onChange={onInputChange} placeholder="e.g. sql-referrals" persistent />
                </TableToolbarContent></TableToolbar>
                <Table {...getTableProps()} size="sm">
                  <TableHead><TableRow>{headers.map((h: any) => <TableHeader {...getHeaderProps({ header: h })} key={h.key}>{h.header}</TableHeader>)}</TableRow></TableHead>
                  <TableBody>{rows.length === 0 ? <TableRow><TableCell colSpan={headers.length}><Empty>No assessments match these filters.</Empty></TableCell></TableRow> : rows.map((r: any) => { const e = visible.find((x) => x.id === r.id)!; return (
                    <TableRow {...getRowProps({ row: r })} key={r.id}>
                      <TableCell>{labelFor("evidence_source", e.source)}</TableCell>
                      <TableCell><span className="ag-mono ag-nowrap">{e.control}</span></TableCell>
                      <TableCell>{e.resource_name}<div className="ag-muted ag-label">{shortType(e.resource_type)}</div></TableCell>
                      <TableCell>{e.application_id ? <RLink to={`/applications/${e.application_id}`}>{e.application_name}</RLink> : <span className="ag-muted">—</span>}</TableCell>
                      {/* Pass is this table's norm; a quiet word keeps the fails and unknowns the only tags in the column. */}
                      <TableCell>{e.state === "pass" ? <span className="ag-muted">Pass</span> : <StatusTag kind="evidence" value={e.state} />}</TableCell>
                      <TableCell>{e.detail?.assessment || <span className="ag-muted">—</span>}</TableCell>
                      <TableCell className="ag-nowrap">{fmtDateTime(e.observed_at)}</TableCell>
                    </TableRow>); })}</TableBody>
                </Table>
              </TableContainer>)}
          </DataTable>
        </section>
      </>)}

      <Modal open={!!imp} size="lg" modalHeading="Import Evidence" primaryButtonText={imp?.result ? "Done" : "Import"} secondaryButtonText="Cancel" primaryButtonDisabled={!imp?.result && (!imp?.text?.trim() || imp?.busy)} onRequestClose={() => setImp(null)}
        onRequestSubmit={async () => {
          if (imp.result) { setImp(null); return; }
          let parsed: any; try { parsed = JSON.parse(imp.text); if (!Array.isArray(parsed)) throw new Error(); } catch { setImp({ ...imp, err: "Enter a JSON array of items, like the example." }); return; }
          setImp({ ...imp, busy: true, err: null });
          try { const r: any = await post("/evidence/import", { source: imp.source, items: parsed }); setImp({ ...imp, busy: false, result: r }); reloadAll(); }
          catch (e: any) { setImp({ ...imp, busy: false, err: String(e.message || e) }); }
        }}>
        {imp && <div className="ag-form">
          <p className="ag-body">Paste assessments exported from the source. Each item names the resource (by name, provider id or element id), the control key and its state. Existing resource · source · control rows are updated; nothing is deleted.</p>
          <Select id="imp-src" labelText="Source" value={imp.source} onChange={(e) => setImp({ ...imp, source: e.target.value })}>{SOURCES.map((s) => <SelectItem key={s} value={s} text={labelFor("evidence_source", s)} />)}</Select>
          <TextArea id="imp-json" className="ag-mono-field" labelText="Items (JSON array)" rows={10} placeholder={`e.g. ${EXAMPLE}`} value={imp.text} onChange={(e) => setImp({ ...imp, text: e.target.value, err: null })} invalid={!!imp.err} invalidText={imp.err || undefined} />
          {imp.busy && <InlineLoading description="Importing" />}
          {imp.result && <InlineNotification kind={imp.result.unmatched?.length ? "warning" : "success"} lowContrast hideCloseButton title={`Imported: ${imp.result.created ?? 0} new, ${imp.result.updated ?? 0} updated, ${imp.result.unchanged ?? 0} unchanged`} subtitle={imp.result.unmatched?.length ? `Unmatched resources (${imp.result.unmatched.length}): ${imp.result.unmatched.join(", ")}` : undefined} />}
        </div>}
      </Modal>
    </>
  );
}
