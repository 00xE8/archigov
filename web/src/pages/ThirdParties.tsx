import React from "react";
import { Table, TableHead, TableRow, TableHeader, TableBody, TableCell, TableContainer, DataTableSkeleton, InlineNotification, Button, Modal, Select, SelectItem, TextArea, TextInput, RadioButtonGroup, RadioButton, InlineLoading, Stack, SkeletonText, Tag } from "@carbon/react";
import { Add, MachineLearningModel } from "@carbon/icons-react";
import { get, post, labelFor, fmtDate } from "../api";
import { PageIntro, useLoad, LoadError, RLink, Empty, useDocTitle, CountUp, StatusTag, CriticalityTag, DateField, useAiFeatures } from "../components";
import { Gated } from "../auth";

/**
 * Third parties: the ICT providers the estate relies on (the cloud platform from resource types, named suppliers
 * from resource tags), how concentrated critical and important applications are on any one of them — a designated
 * critical third party especially — and whether each critical reliance has an exit plan in date (DORA Art. 28(8),
 * PRA SS2/21 ch. 10). Derived, not typed in; the exit plans are recorded by named authors.
 */
export default function ThirdParties() {
  const [data, reload, err] = useLoad<any>(() => get("/third-parties"));
  const [plan, setPlan] = React.useState<any>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  useDocTitle("Third Parties");
  if (err) return <LoadError what="third parties" err={err} onRetry={reload} />;
  const c = data?.counts;
  const intro = (
    <PageIntro title="Third Parties" lead="The ICT providers the estate relies on, how concentrated critical applications are on any one of them, and an exit plan for each critical reliance."
      about="Providers are derived: the cloud platform from each resource's type, and named suppliers from supplier, vendor or provider tags on resources. An application classified critical or important — or supporting a regulated service — needs an exit plan for every provider it relies on (DORA Art. 28(8), PRA SS2/21 ch. 10): how it would leave, how substitutable the provider is, and when the plan was last tested. Designated critical third parties are marked from the designation list the platform admin keeps current."
      extra={c ? <div className="ag-hero-stats" aria-label="Third parties at a glance">
        {([["Providers", c.providers, "blue"], ["Designated CTPs Relied On", c.ctp_relied_on, "magenta"], ["Critical Apps on a CTP", c.critical_on_ctp, "red"], ["Exit Plans Due", c.exit_plans_due, "cyan"]] as [string, number, string][]).map(([l, n, t]) => (
          <div key={l} className={`ag-glass ag-glass-${t}`}><span className="n"><CountUp value={Number(n) || 0} /></span><span className="l">{l}</span></div>))}
      </div> : undefined} />
  );
  if (!data) return <>{intro}<DataTableSkeleton rowCount={4} showHeader={false} /></>;
  return (
    <>
      {intro}
      {msg && <InlineNotification kind="success" lowContrast className="ag-notice" title={msg} onCloseButtonClick={() => setMsg(null)} />}
      {data.concentration.map((k: any) => (
        <InlineNotification key={k.provider} kind="warning" lowContrast hideCloseButton className="ag-notice"
          title={`${k.critical} of ${k.of} critical or important applications rely on ${k.name}`}
          subtitle={k.ctp ? `${k.ctp.entity} is a designated critical third party (${data.ctp.instrument}). Concentration on one provider is a risk to weigh, and an exit plan per reliance is how it is evidenced.` : "Concentration on one provider is a risk to weigh; an exit plan per reliance is how it is evidenced."} />))}

      <section className="ag-section">
        <h2>Providers</h2>
        <p className="ag-muted ag-body ag-mb-03">Each provider, the applications that rely on it, and the regulated services behind them.</p>
        {data.providers.length === 0 ? <Empty>No provider is named by the collected estate yet.</Empty> : (
          <TableContainer><Table size="md" aria-label="Providers">
            <TableHead><TableRow><TableHeader>Provider</TableHeader><TableHeader>Kind</TableHeader><TableHeader>Critical Third Party</TableHeader><TableHeader>Applications</TableHeader><TableHeader>Critical &amp; Important</TableHeader><TableHeader>Regulated Services</TableHeader><TableHeader>Resources</TableHeader><TableHeader>Regions</TableHeader></TableRow></TableHead>
            <TableBody>{data.providers.map((p: any) => (
              <TableRow key={p.id}>
                <TableCell><span className="ag-strong">{p.name}</span></TableCell>
                <TableCell>{labelFor("provider_kind", p.kind)}</TableCell>
                <TableCell>{p.ctp ? <Tag size="sm" type="magenta"><span title={`${p.ctp.entity} — designated under ${data.ctp.instrument}, effective ${data.ctp.effective}.`}>Designated</span></Tag> : <span className="ag-muted">No</span>}</TableCell>
                <TableCell className="ag-wrap">{p.applications.map((a: any, i: number) => <React.Fragment key={a.id}>{i > 0 ? ", " : ""}<RLink inline to={`/applications/${a.id}`}>{a.name}</RLink></React.Fragment>)}</TableCell>
                <TableCell>{p.critical} <span className="ag-muted ag-label">({Math.round(p.share * 100)}%)</span></TableCell>
                <TableCell className="ag-wrap">{p.regulated_services.length ? <span className="ag-label">{p.regulated_services.join("; ")}</span> : <span className="ag-muted">None</span>}</TableCell>
                <TableCell>{p.resources}</TableCell>
                <TableCell><span className="ag-mono ag-nowrap">{p.regions.join(", ") || "—"}</span></TableCell>
              </TableRow>))}</TableBody>
          </Table></TableContainer>)}
      </section>

      <section className="ag-section">
        <h2>Exit Plans</h2>
        <p className="ag-muted ag-body ag-mb-03">One per critical or important application and provider, valid for a year. Substitutability is recorded in the DORA register's vocabulary and fills its column there.</p>
        {data.exit_plans.length === 0 ? <Empty>No critical or important application relies on a provider yet.</Empty> : (
          <TableContainer><Table size="md" aria-label="Exit plans">
            <TableHead><TableRow><TableHeader>Application</TableHeader><TableHeader>Provider</TableHeader><TableHeader>Exit Plan</TableHeader><TableHeader>Substitutability</TableHeader><TableHeader>Last Tested</TableHeader><TableHeader>Recorded</TableHeader><TableHeader>Actions</TableHeader></TableRow></TableHead>
            <TableBody>{data.exit_plans.map((e: any) => (
              <TableRow key={`${e.application.id}|${e.provider.id}`}>
                <TableCell><RLink to={`/applications/${e.application.id}`}>{e.application.name}</RLink><div><CriticalityTag value={e.application.criticality} /></div></TableCell>
                <TableCell>{e.provider.name}{e.provider.ctp && <div className="ag-muted ag-label">designated CTP</div>}</TableCell>
                <TableCell><StatusTag kind="exit_status" value={e.status} size="sm" /></TableCell>
                <TableCell>{e.last?.details?.substitutability ? labelFor("substitutability", e.last.details.substitutability) : <span className="ag-muted">—</span>}</TableCell>
                <TableCell>{e.last?.details?.tested_at ? fmtDate(e.last.details.tested_at) : <span className="ag-muted">{e.last ? "Not tested" : "—"}</span>}</TableCell>
                <TableCell>{e.last ? <><div>{fmtDate(e.last.assessed_at)} · {e.last.assessed_by}</div><div className="ag-muted ag-label">valid until {fmtDate(e.last.valid_until)}</div></> : <span className="ag-muted">Never</span>}</TableCell>
                <TableCell><Gated cap="verify"><Button size="sm" kind="ghost" renderIcon={Add} onClick={() => setPlan(e)}>Record Exit Plan</Button></Gated></TableCell>
              </TableRow>))}</TableBody>
          </Table></TableContainer>)}
      </section>

      <p className="ag-muted ag-label ag-mt-05">Critical third parties as designated under {data.ctp.instrument}, effective {fmtDate(data.ctp.effective)}: {data.ctp.entries.map((e: any) => e.entity).join(", ")}. HM Treasury designates on a rolling basis; the platform admin keeps this list current.</p>
      {plan && <ExitPlanModal e={plan} onClose={() => setPlan(null)} onDone={() => { setPlan(null); setMsg(`Exit plan recorded for ${plan.application.name} · ${plan.provider.name}`); reload(); }} />}
    </>
  );
}

/** Record an exit plan for one application's reliance on one provider: adequacy, the written plan, substitutability and the last test. */
function ExitPlanModal({ e, onClose, onDone }: { e: any; onClose: () => void; onDone: () => void }) {
  const [d] = useLoad<any>(() => get(`/applications/${e.application.id}/third-parties`), [e.application.id]);
  const aiOn = useAiFeatures();
  const [result, setResult] = React.useState("satisfactory_with_remarks");
  const [subst, setSubst] = React.useState(e.last?.details?.substitutability || "");
  const [tested, setTested] = React.useState<string>(e.last?.details?.tested_at || "");
  const [summary, setSummary] = React.useState<string | null>(null);
  const [reference, setReference] = React.useState("");
  const [err, setErr] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  React.useEffect(() => { if (d && summary === null) setSummary(d.template); }, [d]);
  const refBad = reference.trim().length > 0 && !/^https?:\/\//i.test(reference.trim());
  const save = async () => { setBusy("save"); setErr(null); try { await post(`/applications/${e.application.id}/exit-plans`, { provider: e.provider.id, result, substitutability: subst, tested_at: tested || null, summary_md: summary, reference: reference.trim() || null }); onDone(); } catch (x: any) { setErr(String(x.message || x)); } finally { setBusy(null); } };
  const draft = async () => { setBusy("ai"); setErr(null); try { const r: any = await post(`/applications/${e.application.id}/exit-plans/draft`, { provider: e.provider.id }); setSummary(r.summary_md); } catch (x: any) { setErr(String(x.message || x)); } finally { setBusy(null); } };
  return (
    <Modal open size="lg" modalHeading={`Exit Plan · ${e.application.name} · ${e.provider.name}`} primaryButtonText={busy === "save" ? "Recording…" : "Record Exit Plan"} secondaryButtonText="Cancel"
      primaryButtonDisabled={!!busy || !subst || !summary || summary.trim().length < 10 || refBad} onRequestClose={onClose} onRequestSubmit={save}>
      {!d ? <SkeletonText paragraph lineCount={6} /> : <Stack gap={5}>
        <p className="ag-body">How this application would leave {e.provider.name} in a planned or a stressed exit (DORA Art. 28(8), PRA SS2/21 ch. 10). It is recorded under your name and valid for a year.</p>
        <div className="ag-row">
          <Select id="ep-subst" labelText="Substitutability" helperText="As the DORA register of information records it (B_07.01)." value={subst} onChange={(x) => setSubst(x.target.value)}>
            <SelectItem value="" text="Choose" />{(d.substitutability as string[]).map((s) => <SelectItem key={s} value={s} text={labelFor("substitutability", s)} />)}
          </Select>
          <DateField id="ep-tested" labelText="Last Tested (optional)" helperText="When the plan was last exercised." value={tested} onChange={setTested} />
        </div>
        <RadioButtonGroup legendText="Adequacy" name="ep-result" valueSelected={result} onChange={(v) => setResult(String(v))} orientation="horizontal">
          {(d.results as string[]).map((r) => <RadioButton key={r} id={`ep-${r}`} value={r} labelText={labelFor("assessment_result", r)} />)}
        </RadioButtonGroup>
        <div className="ag-row between"><span className="cds--label">Exit Plan</span>
          {busy === "ai" ? <InlineLoading description="Drafting from the model" /> : <Gated cap="verify" allowed={aiOn.draft_assessment === true} reason="AI Assessment Drafting is not enabled for this instance — a platform admin can switch it on under Settings · AI"><Button size="sm" kind="tertiary" renderIcon={MachineLearningModel} onClick={draft}>Draft with AI</Button></Gated>}</div>
        <TextArea id="ep-summary" labelText="Exit Plan" hideLabel rows={12} className="ag-mono-field" value={summary ?? ""} onChange={(x) => setSummary(x.target.value)}
          helperText="Answer each heading. A draft from AI fills only what the model knows; alternatives, timelines, costs and test results are yours." invalid={!!summary && summary.trim().length > 0 && summary.trim().length < 10} invalidText="At least 10 characters." />
        <TextInput id="ep-ref" labelText="Reference (optional)" placeholder="https://…" helperText="A link to where the full plan lives; the document itself is never uploaded." value={reference} onChange={(x) => setReference(x.target.value)} invalid={refBad} invalidText="A link starting with http:// or https://" />
        {err && <InlineNotification kind="error" lowContrast hideCloseButton title="Not recorded" subtitle={err} />}
      </Stack>}
    </Modal>
  );
}
