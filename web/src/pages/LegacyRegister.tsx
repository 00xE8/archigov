import React from "react";
import { DataTable, Table, TableHead, TableRow, TableHeader, TableBody, TableCell, TableContainer, TableToolbar, TableToolbarContent, TableToolbarSearch, TableExpandHeader, TableExpandRow, TableExpandedRow, DataTableSkeleton, InlineNotification, Button, Modal, Select, SelectItem, TextArea, TextInput, RadioButtonGroup, RadioButton, InlineLoading, Stack, SkeletonText } from "@carbon/react";
import { Add, Edit, Reset, Renew, MachineLearningModel, TrashCan } from "@carbon/icons-react";
import { get, post, put, labelFor, fmtDate, shortType } from "../api";
import { PageIntro, useLoad, LoadError, RLink, EmptyState, Empty, useDocTitle, CountUp, StatusTag, OriginTag, useAiFeatures } from "../components";
import { Gated } from "../auth";

/**
 * The legacy register: lifecycle-tracked components (OS images, runtimes, engines, Kubernetes) against their
 * vendors' support dates, derived from what collection holds and corrected by people, and the yearly legacy
 * assessment each application with legacy components needs (DORA Art. 8(7)). Nothing here is guessed: a version
 * the facts do not name is "unknown" until a person sets it.
 */
export default function LegacyRegister() {
  const [data, reload, err] = useLoad<any>(() => get("/lifecycle"));
  const [assess, setAssess] = React.useState<any>(null);
  const [correct, setCorrect] = React.useState<any>(null);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<{ kind: "success" | "error"; text: string } | null>(null);
  useDocTitle("Legacy Register");
  if (err) return <LoadError what="the legacy register" err={err} onRetry={reload} />;
  const c = data?.counts;
  const intro = (
    <PageIntro title="Legacy Register" lead="Components past or near their vendor's end of support, and the yearly risk assessment each application with legacy components needs."
      about="Operating system images, runtime stacks, database engines and Kubernetes versions are matched from what collection already holds and checked against the vendors' support dates (endoflife.date). A component past standard support is legacy: DORA Art. 8(7) asks for a specific risk assessment of legacy ICT systems every year, and again when what they connect to changes. Versions the facts do not name stay unknown until a person sets them, with a reason."
      extra={c ? <div className="ag-hero-stats" aria-label="Components at a glance">
        {([["End of Life", c.end_of_life, "red"], ["Extended Support", c.extended, "magenta"], ["Support Ending", c.ending, "teal"], ["Supported", c.supported, "green"], ["Unknown", c.unknown, "cyan"]] as [string, number, string][]).map(([l, n, t]) => (
          <div key={l} className={`ag-glass ag-glass-${t}`}><span className="n"><CountUp value={Number(n) || 0} /></span><span className="l">{l}</span></div>))}
      </div> : undefined} />
  );
  if (!data) return <>{intro}<DataTableSkeleton rowCount={5} showHeader={false} /></>;
  const groupOf = new Map<string, any>(data.components.map((g: any) => [g.key, g]));
  const keyLabel = (k: string) => { const g = groupOf.get(k); return g ? `${g.product_label} ${g.label}` : k.replace(":", " "); };
  const refresh = async () => { setBusy(true); setMsg(null); try { const r: any = await post("/lifecycle/refresh"); setMsg({ kind: r.failed?.length ? "error" : "success", text: r.failed?.length ? `Refreshed ${r.products - r.failed.length} products; kept the previous data for ${r.failed.join(", ")}` : `Lifecycle data refreshed (${r.fetched_at})` }); reload(); } catch (e: any) { setMsg({ kind: "error", text: String(e.message || e) }); } finally { setBusy(false); } };
  const compHeaders = [{ key: "product", header: "Product" }, { key: "version", header: "Version" }, { key: "state", header: "State" }, { key: "eol", header: "End of Support" }, { key: "extended", header: "Extended Until" }, { key: "resources", header: "Resources" }, { key: "apps", header: "Applications" }];
  const compRows = data.components.map((g: any) => ({ id: g.key, product: g.product_label, version: g.label, state: g.state, eol: g.eol || "", extended: g.extended || "", resources: g.resources.length, apps: g.applications.map((a: any) => a.name).join(", ") }));
  return (
    <>
      {intro}
      {msg && <InlineNotification kind={msg.kind} lowContrast className="ag-notice" title={msg.text} onCloseButtonClick={() => setMsg(null)} />}
      {data.due > 0 && <InlineNotification kind="warning" lowContrast hideCloseButton className="ag-notice" title={`${data.due} application${data.due === 1 ? "" : "s"} due a legacy assessment`}
        subtitle="Each has a component past its vendor's standard support and no assessment in date that covers it." />}

      <section className="ag-section">
        <h2>Legacy Assessments</h2>
        <p className="ag-muted ag-body ag-mb-03">One assessment per application, valid for {data.assessment_months} months, covering every component past standard support. A new legacy component makes it stale.</p>
        {data.applications.length === 0 ? <Empty>No application runs a lifecycle-tracked component yet.</Empty> : (
          <TableContainer><Table size="md" aria-label="Legacy assessments by application">
            <TableHead><TableRow><TableHeader>Application</TableHeader><TableHeader>Legacy Components</TableHeader><TableHeader>Assessment</TableHeader><TableHeader>Last Assessed</TableHeader><TableHeader>Valid Until</TableHeader><TableHeader>Actions</TableHeader></TableRow></TableHead>
            <TableBody>{data.applications.map((a: any) => (
              <TableRow key={a.id}>
                <TableCell><RLink to={`/applications/${a.id}`}>{a.name}</RLink></TableCell>
                <TableCell>{a.legacy.length ? <div className="ag-row tight">{a.legacy.map((k: string) => { const g = groupOf.get(k); return <StatusTag key={k} kind="lifecycle_state" value={g?.state || "unknown"} label={keyLabel(k)} />; })}</div> : <span className="ag-muted">None</span>}</TableCell>
                <TableCell><StatusTag kind="legacy_status" value={a.status} />{a.status === "stale" && <div className="ag-muted ag-label">Not covered: {a.new_since_last.map(keyLabel).join(", ")}</div>}</TableCell>
                <TableCell>{a.last ? <><div>{fmtDate(a.last.assessed_at)} · {a.last.assessed_by}</div><div className="ag-muted ag-label">{labelFor("assessment_result", a.last.result)}{a.last.reference ? <> · <a className="cds--link" href={a.last.reference} target="_blank" rel="noreferrer">reference</a></> : null}</div></> : <span className="ag-muted">Never</span>}</TableCell>
                <TableCell>{a.last ? fmtDate(a.last.valid_until) : <span className="ag-muted">—</span>}</TableCell>
                <TableCell>{a.legacy.length > 0 ? <Gated cap="verify"><Button size="sm" kind="ghost" renderIcon={Add} onClick={() => setAssess(a)}>Record Assessment</Button></Gated> : <span className="ag-muted">—</span>}</TableCell>
              </TableRow>))}</TableBody>
          </Table></TableContainer>)}
      </section>

      <section className="ag-section">
        {data.components.length === 0 ? <EmptyState title="No lifecycle-tracked components">Virtual machine images, App Service runtimes, PostgreSQL and MySQL engines and AKS clusters appear here once collected.</EmptyState> : (
          <DataTable rows={compRows} headers={compHeaders} isSortable>
            {({ rows, headers, getHeaderProps, getRowProps, getTableProps, getExpandHeaderProps, getExpandedRowProps, onInputChange }: any) => (
              <TableContainer title="Components" description="Each version found in the estate, worst first. Expand one for the resources running it and how each was matched.">
                <TableToolbar><TableToolbarContent><TableToolbarSearch onChange={onInputChange} placeholder="e.g. Windows Server" persistent /></TableToolbarContent></TableToolbar>
                <Table {...getTableProps()} size="md">
                  <TableHead><TableRow><TableExpandHeader {...getExpandHeaderProps()} aria-label="Expand all components" />{headers.map((h: any) => <TableHeader {...getHeaderProps({ header: h })} key={h.key}>{h.header}</TableHeader>)}</TableRow></TableHead>
                  <TableBody>{rows.map((r: any) => { const g = groupOf.get(r.id); return (
                    <React.Fragment key={r.id}>
                      <TableExpandRow {...getRowProps({ row: r })} aria-label={`Show the resources running ${g.product_label} ${g.label}`}>
                        <TableCell>{g.product_label}</TableCell>
                        <TableCell><span className="ag-mono">{g.label}</span></TableCell>
                        <TableCell><StatusTag kind="lifecycle_state" value={g.state} /></TableCell>
                        <TableCell>{g.eol ? fmtDate(g.eol) : <span className="ag-muted">—</span>}</TableCell>
                        <TableCell>{g.extended ? fmtDate(g.extended) : <span className="ag-muted">—</span>}</TableCell>
                        <TableCell>{g.resources.length}</TableCell>
                        <TableCell><div className="ag-row tight">{g.applications.map((a: any) => <RLink key={a.id} to={`/applications/${a.id}`}>{a.name}</RLink>)}</div></TableCell>
                      </TableExpandRow>
                      <TableExpandedRow {...getExpandedRowProps({ row: r })} colSpan={headers.length + 1}>
                        <Table size="sm" aria-label={`Resources running ${g.product_label} ${g.label}`}>
                          <TableHead><TableRow><TableHeader>Resource</TableHeader><TableHeader>Application</TableHeader><TableHeader>Matched From</TableHeader><TableHeader>Actions</TableHeader></TableRow></TableHead>
                          <TableBody>{g.resources.map((x: any) => (
                            <TableRow key={x.id}>
                              <TableCell><span className="ag-strong">{x.name}</span><div className="ag-muted ag-label ag-mono">{shortType(x.type)}</div></TableCell>
                              <TableCell>{x.application_id ? <RLink to={`/applications/${x.application_id}`}>{x.application_name}</RLink> : <span className="ag-muted">—</span>}</TableCell>
                              <TableCell><div className="ag-row tight">{x.origin === "human" && <OriginTag origin="human" />}<span className="ag-label">{x.method}{Object.keys(x.evidence || {}).length && x.origin !== "human" ? <span className="ag-muted ag-mono"> · {Object.values(x.evidence).join(" · ")}</span> : null}</span></div></TableCell>
                              <TableCell><Gated cap="verify"><Button size="sm" kind="ghost" renderIcon={Edit} onClick={() => setCorrect({ ...x, origin: x.origin })}>Correct</Button></Gated></TableCell>
                            </TableRow>))}</TableBody>
                        </Table>
                      </TableExpandedRow>
                    </React.Fragment>); })}</TableBody>
                </Table>
              </TableContainer>)}
          </DataTable>)}
      </section>

      {data.unmatched.length > 0 && <section className="ag-section">
        <h2>Version Unknown ({data.unmatched.length})</h2>
        <p className="ag-muted ag-body ag-mb-03">Resources of a tracked type whose collected facts name no version. Nothing is guessed: set the version once and it stays until someone resets it.</p>
        <TableContainer><Table size="md" aria-label="Resources with an unknown version">
          <TableHead><TableRow><TableHeader>Resource</TableHeader><TableHeader>Type</TableHeader><TableHeader>Application</TableHeader><TableHeader>Why</TableHeader><TableHeader>Actions</TableHeader></TableRow></TableHead>
          <TableBody>{data.unmatched.map((x: any) => (
            <TableRow key={x.id}>
              <TableCell>{x.name}</TableCell>
              <TableCell><span className="ag-mono">{shortType(x.type)}</span></TableCell>
              <TableCell>{x.application_id ? <RLink to={`/applications/${x.application_id}`}>{x.application_name}</RLink> : <span className="ag-muted">—</span>}</TableCell>
              <TableCell><span className="ag-label">{x.reason}</span></TableCell>
              <TableCell><Gated cap="verify"><Button size="sm" kind="ghost" renderIcon={Edit} onClick={() => setCorrect(x)}>Set Version</Button></Gated></TableCell>
            </TableRow>))}</TableBody>
        </Table></TableContainer>
      </section>}

      <div className="ag-row between ag-mt-05">
        <p className="ag-muted ag-label">Lifecycle dates from <a className="cds--link" href={data.snapshot.url} target="_blank" rel="noreferrer">endoflife.date</a> ({data.snapshot.licence}), {data.snapshot.refreshed ? "refreshed" : "bundled with this release"} {fmtDate(data.snapshot.fetched_at)} · {data.snapshot.products.length} products · support ending means within {data.warn_days} days.</p>
        <Gated cap="manage_platform" mode="hide">{busy ? <InlineLoading description="Refreshing" /> : <Button size="sm" kind="tertiary" renderIcon={Renew} onClick={refresh}>Refresh Lifecycle Data</Button>}</Gated>
      </div>

      {assess && <AssessModal app={assess} keyLabel={keyLabel} onClose={() => setAssess(null)} onDone={() => { setAssess(null); setMsg({ kind: "success", text: `Legacy assessment recorded for ${assess.name}` }); reload(); }} />}
      {correct && <CorrectModal resource={correct} onClose={() => setCorrect(null)} onDone={(t) => { setCorrect(null); setMsg({ kind: "success", text: t }); reload(); }} />}
    </>
  );
}

/** Record the yearly legacy assessment for one application: a result, the written assessment under the template, and a link to where the document lives. */
function AssessModal({ app, keyLabel, onClose, onDone }: { app: any; keyLabel: (k: string) => string; onClose: () => void; onDone: () => void }) {
  const [d] = useLoad<any>(() => get(`/applications/${app.id}/legacy`), [app.id]);
  const aiOn = useAiFeatures();
  const [result, setResult] = React.useState("satisfactory_with_remarks");
  const [summary, setSummary] = React.useState<string | null>(null);
  const [reference, setReference] = React.useState("");
  const [err, setErr] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  React.useEffect(() => { if (d && summary === null) setSummary(d.template); }, [d]);
  const refBad = reference.trim().length > 0 && !/^https?:\/\//i.test(reference.trim());
  const save = async () => { setBusy("save"); setErr(null); try { await post(`/applications/${app.id}/legacy-assessments`, { result, summary_md: summary, reference: reference.trim() || null }); onDone(); } catch (e: any) { setErr(String(e.message || e)); } finally { setBusy(null); } };
  const draft = async () => { setBusy("ai"); setErr(null); try { const r: any = await post(`/applications/${app.id}/legacy-assessments/draft`); setSummary(r.summary_md); } catch (e: any) { setErr(String(e.message || e)); } finally { setBusy(null); } };
  return (
    <Modal open size="lg" modalHeading={`Legacy Assessment · ${app.name}`} primaryButtonText={busy === "save" ? "Recording…" : "Record Assessment"} secondaryButtonText="Cancel"
      primaryButtonDisabled={!!busy || !summary || summary.trim().length < 10 || refBad} onRequestClose={onClose} onRequestSubmit={save}>
      {!d ? <SkeletonText paragraph lineCount={6} /> : <Stack gap={5}>
        <p className="ag-body">The yearly risk assessment of this application's legacy ICT components (DORA Art. 8(7)). It is recorded under your name, valid for a year, and goes stale if another legacy component appears.</p>
        <div><div className="ag-label ag-muted ag-mb-03">Components it covers</div><div className="ag-row tight">{d.legacy.map((k: string) => { const c = d.components.find((x: any) => `${x.product}:${x.cycle}` === k); return <StatusTag key={k} kind="lifecycle_state" value={c?.state || "unknown"} label={keyLabel(k)} />; })}</div></div>
        <RadioButtonGroup legendText="Result" name="legacy-result" valueSelected={result} onChange={(v) => setResult(String(v))} orientation="vertical">
          {(d.results as string[]).map((r) => <RadioButton key={r} id={`lr-${r}`} value={r} labelText={labelFor("assessment_result", r)} />)}
        </RadioButtonGroup>
        <div className="ag-row between"><span className="cds--label">Assessment</span>
          {busy === "ai" ? <InlineLoading description="Drafting from the register" /> : <Gated cap="verify" allowed={aiOn.draft_assessment === true} reason="AI Assessment Drafting is not enabled for this instance — a platform admin can switch it on under Settings · AI"><Button size="sm" kind="tertiary" renderIcon={MachineLearningModel} onClick={draft}>Draft with AI</Button></Gated>}</div>
        <TextArea id="legacy-summary" labelText="Assessment" hideLabel rows={12} className="ag-mono-field" value={summary ?? ""} onChange={(e) => setSummary(e.target.value)}
          helperText="Answer each heading. A draft from AI fills only what the register knows; compensating controls and the plan are yours." invalid={!!summary && summary.trim().length > 0 && summary.trim().length < 10} invalidText="At least 10 characters." />
        <TextInput id="legacy-ref" labelText="Reference (optional)" placeholder="https://…" helperText="A link to where the full assessment lives; the document itself is never uploaded." value={reference} onChange={(e) => setReference(e.target.value)} invalid={refBad} invalidText="A link starting with http:// or https://" />
        {err && <InlineNotification kind="error" lowContrast hideCloseButton title="Not recorded" subtitle={err} />}
      </Stack>}
    </Modal>
  );
}

/** Set (or reset) the components a resource runs, with a reason: the correction a person makes when the facts are silent or wrong. */
function CorrectModal({ resource, onClose, onDone }: { resource: any; onClose: () => void; onDone: (text: string) => void }) {
  const [products] = useLoad<any[]>(() => get<any[]>("/lifecycle/products"));
  const [rows, setRows] = React.useState<{ product: string; cycle: string }[]>([{ product: "", cycle: "" }]);
  const [reason, setReason] = React.useState("");
  const [err, setErr] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const cyclesOf = (p: string) => (products || []).find((x) => x.id === p)?.cycles || [];
  const valid = rows.every((r) => r.product && r.cycle) && reason.trim().length >= 10;
  const save = async () => { setBusy(true); setErr(null); try { await put(`/resources/${resource.id}/lifecycle`, { components: rows, reason }); onDone(`${resource.name}: version set`); } catch (e: any) { setErr(String(e.message || e)); } finally { setBusy(false); } };
  const reset = async () => { setBusy(true); setErr(null); try { await post(`/resources/${resource.id}/lifecycle/reset`); onDone(`${resource.name}: handed back to the collected facts`); } catch (e: any) { setErr(String(e.message || e)); } finally { setBusy(false); } };
  return (
    <Modal open size="md" modalHeading={`Set Version · ${resource.name}`} primaryButtonText={busy ? "Saving…" : "Save Version"} secondaryButtonText="Cancel" primaryButtonDisabled={busy || !valid} onRequestClose={onClose} onRequestSubmit={save}>
      {!products ? <SkeletonText paragraph lineCount={4} /> : <Stack gap={5}>
        <p className="ag-body">What this resource really runs. Your setting replaces what collection matched, is recorded with your reason, and stays until someone resets it.</p>
        <fieldset className="ag-fieldset"><legend className="cds--label">Components</legend><Stack gap={3}>
          {rows.map((r, i) => (
            <div className="ag-row snug ag-service-row" key={i}>
              <div className="ag-grow"><Select id={`lc-p-${i}`} labelText="Product" hideLabel={i > 0} value={r.product} onChange={(e) => setRows(rows.map((x, k) => (k === i ? { product: e.target.value, cycle: "" } : x)))}>
                <SelectItem value="" text="Choose a product" />{products.map((p) => <SelectItem key={p.id} value={p.id} text={p.label} />)}</Select></div>
              <div className="ag-service-kind"><Select id={`lc-c-${i}`} labelText="Version" hideLabel={i > 0} value={r.cycle} disabled={!r.product} onChange={(e) => setRows(rows.map((x, k) => (k === i ? { ...x, cycle: e.target.value } : x)))}>
                <SelectItem value="" text="Choose" />{cyclesOf(r.product).map((c: any) => <SelectItem key={c.cycle} value={c.cycle} text={`${c.label} · ${labelFor("lifecycle_state", c.state).toLowerCase()}`} />)}</Select></div>
              <Button size="md" kind="ghost" hasIconOnly renderIcon={TrashCan} iconDescription="Remove component" tooltipPosition="left" disabled={rows.length === 1} onClick={() => setRows(rows.filter((_x, k) => k !== i))} />
            </div>))}
          <div><Button size="sm" kind="tertiary" renderIcon={Add} disabled={rows.length >= 5} onClick={() => setRows([...rows, { product: "", cycle: "" }])}>Add Component</Button></div>
        </Stack></fieldset>
        <TextArea id="lc-reason" labelText="Reason" rows={2} helperText="How you know; it is recorded in the audit log with your name." value={reason} onChange={(e) => setReason(e.target.value)} invalid={reason.trim().length > 0 && reason.trim().length < 10} invalidText="At least 10 characters." />
        {resource.origin === "human" && <div><Button size="sm" kind="ghost" renderIcon={Reset} disabled={busy} onClick={reset}>Reset to Collected Facts</Button></div>}
        {err && <InlineNotification kind="error" lowContrast hideCloseButton title="Not saved" subtitle={err} />}
      </Stack>}
    </Modal>
  );
}
