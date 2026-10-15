import React from "react";
import { useNavigate } from "react-router-dom";
import { DataTable, Table, TableHead, TableRow, TableHeader, TableBody, TableCell, TableContainer, TableToolbar, TableToolbarContent, TableToolbarSearch, DataTableSkeleton, Button, Modal, TextInput, TextArea, Select, SelectItem, MultiSelect, InlineLoading } from "@carbon/react";
import { Add, MachineLearningModel } from "@carbon/icons-react";
import { get, post, fmtDate, labelFor } from "../api";
import { PageIntro, useLoad, useAiFeatures, VerificationTag, LoadError, RLink, StatusTag, KindTag, Markdown, EmptyState, useDocTitle } from "../components";
import { Gated } from "../auth";

// A log is chronological: the date sits beside the id, and rows arrive newest first (sortable as ever).
const headers = [{ key: "code", header: "Code" }, { key: "decided_at", header: "Decided" }, { key: "title", header: "Decision" }, { key: "topic", header: "Topic" }, { key: "applications", header: "Applications" }, { key: "status", header: "Status" }, { key: "review", header: "Review" }, { key: "verification", header: "Verification" }];
/** `links.depends_on` / `links.blocks` may arrive as counts or as lists. */
const n = (x: any) => (Array.isArray(x) ? x.length : typeof x === "number" ? x : 0);
const TOPICS = ["general", "hosting", "data-store", "integration", "ai-system", "security", "identity", "resilience"];

export function DecisionForm({ value, onChange, apps, onTriggerAssessment, triggerLabel }: { value: any; onChange: (v: any) => void; apps: any[]; onTriggerAssessment?: (s: { type: string; title: string | null; reason: string }) => void; triggerLabel?: string }) {
  // AI critical review of the argument: a button the author presses. It is always on the form — live when the
  // platform admin has enabled the Decision Review feature, greyed with the reason when not (disabled pattern:
  // the tooltip says how to enable it).
  const aiOn = useAiFeatures();
  const [review, setReview] = React.useState<any>(null);
  const [aiBusy, setAiBusy] = React.useState(false);
  const [aiErr, setAiErr] = React.useState<string | null>(null);
  const runReview = async () => {
    setAiBusy(true); setAiErr(null); setReview(null);
    try { setReview(await post("/decisions/review-draft", { title: value.title, topic: value.topic, context_md: value.context_md, options: parseOptions(value.optionsText || ""), decision_md: value.decision_md, justification_md: value.justification_md, consequences_md: value.consequences_md })); }
    catch (e: any) { setAiErr(String(e.message || e).split("\n")[0]); }
    finally { setAiBusy(false); }
  };
  return (
    <div className="ag-form">
      <TextInput id="title" labelText="Title" value={value.title} onChange={(e) => onChange({ ...value, title: e.target.value })} />
      <div className="ag-row">
        <Select id="topic" labelText="Topic" value={value.topic} onChange={(e) => onChange({ ...value, topic: e.target.value })}>{TOPICS.map((t) => <SelectItem key={t} value={t} text={labelFor("topic", t)} />)}</Select>
        {/* An empty selection means the decision applies to every application, so the field says so. */}
        <MultiSelect id="apps" titleText="Applications" label="All applications" items={apps} itemToString={(a: any) => a?.name || ""} initialSelectedItems={apps.filter((a) => value.application_ids.includes(a.id))} onChange={({ selectedItems }: any) => onChange({ ...value, application_ids: selectedItems.map((a: any) => a.id) })} />
      </div>
      <TextArea id="ctx" labelText="Context" value={value.context_md} onChange={(e) => onChange({ ...value, context_md: e.target.value })} rows={3} />
      <TextArea id="opts" labelText="Options considered (one per line: name | pros | cons)" value={value.optionsText} onChange={(e) => onChange({ ...value, optionsText: e.target.value })} rows={3} />
      <TextArea id="dec" labelText="Recommended Option" helperText="The option you recommend adopting, stated as the decision." value={value.decision_md} onChange={(e) => onChange({ ...value, decision_md: e.target.value })} rows={3} />
      <TextArea id="jus" labelText="Justification" helperText="Why this option wins against the alternatives — the argument the board will test." value={value.justification_md || ""} onChange={(e) => onChange({ ...value, justification_md: e.target.value })} rows={3} />
      <TextArea id="con" labelText="Consequences" helperText="What accepting this decision means: what becomes mandatory or excluded, and which risks are explicitly accepted." value={value.consequences_md} onChange={(e) => onChange({ ...value, consequences_md: e.target.value })} rows={3} />
      <TextInput id="constraint" labelText="Checkable constraint: allowed resource types (comma separated, optional)" helperText="Deployed resources outside this set will be reported as drift against this decision." placeholder="e.g. Microsoft.DBforPostgreSQL/flexibleServers" value={value.allowedTypes} onChange={(e) => onChange({ ...value, allowedTypes: e.target.value })} />
      <div className="ag-row snug">
        {aiBusy ? <InlineLoading description="Testing the argument" /> : (
          <Gated cap="create_decision"
            allowed={aiOn.review_decision === true && !!value.title.trim() && !!(value.decision_md || "").trim()}
            reason={aiOn.review_decision !== true ? "AI Decision Review is not enabled for this instance — a platform admin can switch it on under Settings · AI" : "Add a Title and a Recommended Option first"}>
            <Button size="sm" kind="ghost" renderIcon={MachineLearningModel} onClick={runReview}>Review Argument with AI</Button>
          </Gated>)}
        {aiErr && <span className="ag-muted ag-label">{aiErr}</span>}
      </div>
      {review && <div className="ag-ai-review">
        <div className="ag-row snug">
          <StatusTag kind="recommendation" value={review.verdict === "sound" ? "proceed" : "request_changes"} label={review.verdict === "sound" ? "Argument holds" : "Argument needs work"} />
          <span className="ag-muted ag-label">AI review ({review.model}) — advisory; nothing is stored, you decide what to submit.</span>
        </div>
        <Markdown md={review.assessment_md} />
        {review.issues?.length > 0 && <ul className="ag-area-findings">{review.issues.map((i: any, k: number) => <li key={k}><KindTag kind="decision_issue" value={i.kind} /><span>{i.point}</span></li>)}</ul>}
        {/* Critical claims without evidence: each suggestion can become a tracked assessment on the draft decision. */}
        {review.suggested_assessments?.length > 0 && <div>
          <div className="ag-label ag-muted">Evidence the Argument Is Missing</div>
          <ul className="ag-suggest">{review.suggested_assessments.map((s: any, k: number) => <li key={k}><KindTag kind="assessment_type" value={s.type} /><span className="ag-body">{s.title ? <span className="ag-strong">{s.title} · </span> : null}{s.reason}</span>{onTriggerAssessment && <Button size="sm" kind="ghost" renderIcon={Add} onClick={() => onTriggerAssessment(s)}>{triggerLabel || "Trigger Assessment"}</Button>}</li>)}</ul>
        </div>}
        {review.tightened && <Button size="sm" kind="tertiary" renderIcon={MachineLearningModel} onClick={() => { onChange({ ...value, decision_md: review.tightened.decision_md || value.decision_md, justification_md: review.tightened.justification_md || value.justification_md, consequences_md: review.tightened.consequences_md || value.consequences_md }); setReview(null); }}>Apply Tightened Argument</Button>}
      </div>}
    </div>
  );
}
export const parseOptions = (t: string) => t.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { const [name, pros, cons] = l.split("|").map((s) => s.trim()); return { name, pros: pros || "", cons: cons || "" }; });
export const emptyDecision = () => ({ title: "", topic: "general", application_ids: [] as string[], context_md: "", optionsText: "", decision_md: "", justification_md: "", consequences_md: "", allowedTypes: "" });

export default function Decisions() {
  const [list, reload, err] = useLoad<any[]>(() => get("/decisions"));
  const [apps, , appsErr] = useLoad<any[]>(() => get("/applications"));
  const [form, setForm] = React.useState<any>(null);
  const nav = useNavigate();
  useDocTitle("Decision Log");
  if (err || appsErr) return <LoadError what="decisions" err={(err || appsErr)!} onRetry={reload} />;
  if (!list || !apps) return <DataTableSkeleton headers={headers} rowCount={6} showHeader={false} showToolbar />;
  const log = [...list].sort((a, b) => String(b.decided_at || b.created_at || "").localeCompare(String(a.decided_at || a.created_at || "")));
  const rows = log.map((d) => ({ id: d.id, code: d.code, title: d.title, topic: labelFor("topic", d.topic), applications: d.applications.map((a: any) => a.name).join(", "), status: d.status, review: d.review?.code || "", decided_at: d.decided_at || "", verification: d.verification }));
  return (
    <>
      <PageIntro title="Decision Log" lead="Architecture decision records: what was decided, the options considered, and whether the estate still conforms."
        about="MADR-style records with a unique ID, the options considered and, where it makes sense, a checkable constraint so the estate can be held to the decision continuously. A proposed decision is accepted through a review by its board; while that review is in flight the decision page defers to it."
        actions={<Gated cap="create_decision"><Button size="md" renderIcon={Add} onClick={() => setForm(emptyDecision())}>New Decision</Button></Gated>} />
      {list.length === 0 ? (
        <EmptyState title="No decisions recorded yet" actions={<><Gated cap="create_decision"><Button size="md" renderIcon={Add} onClick={() => setForm(emptyDecision())}>New Decision</Button></Gated><RLink to="/backlog">Draft one from a backlog epic</RLink></>}>
          Decisions are the Design Authority's positions, with the options considered. Give one a checkable constraint and the estate is held to it continuously: anything deployed outside it appears as drift.
        </EmptyState>
      ) : (
      <DataTable rows={rows} headers={headers} isSortable>
        {({ rows, headers, getHeaderProps, getRowProps, getTableProps, onInputChange }: any) => (
          <TableContainer>
            <TableToolbar><TableToolbarContent><TableToolbarSearch onChange={onInputChange} placeholder="e.g. ADR-0004" persistent /></TableToolbarContent></TableToolbar>
            <Table {...getTableProps()} size="md">
              <TableHead><TableRow>{headers.map((h: any) => <TableHeader {...getHeaderProps({ header: h })} key={h.key}>{h.header}</TableHeader>)}</TableRow></TableHead>
              <TableBody>{rows.map((r: any) => { const d = list.find((x) => x.id === r.id)!; return (
                <TableRow {...getRowProps({ row: r })} key={r.id}>
                  <TableCell><RLink to={`/decisions/${d.id}`}>{d.code}</RLink></TableCell>
                  {/* A proposed entry has no decided date yet; the log shows when it was logged, muted. */}
                  <TableCell>{d.decided_at ? fmtDate(d.decided_at) : <span className="ag-muted" title="Not decided yet — logged on this date, decided through its review.">{fmtDate(d.created_at)}</span>}</TableCell>
                  {/* Dependency links under the title: what this decision waits for, and what waits for it. */}
                  <TableCell>{d.title}{(n(d.links?.depends_on) || n(d.links?.blocks)) ? <div className="ag-muted ag-label">{[n(d.links?.depends_on) ? `blocked by ${n(d.links.depends_on)}` : "", n(d.links?.blocks) ? `blocks ${n(d.links.blocks)}` : ""].filter(Boolean).join(" · ")}</div> : null}</TableCell>
                  <TableCell>{labelFor("topic", d.topic)}</TableCell>
                  {/* Multi-word application names wrap: a separator between links, or the cell reads as one run of words. */}
                  <TableCell><div className="ag-row tight">{d.applications.length ? d.applications.map((a: any, i: number) => <React.Fragment key={a.id}>{i > 0 && <span className="ag-muted">·</span>}<RLink to={`/applications/${a.id}`}>{a.name}</RLink></React.Fragment>) : <span className="ag-muted">All applications</span>}</div></TableCell>
                  <TableCell><StatusTag kind="decision" value={d.status} /></TableCell>
                  {/* The review deciding it (if any): code, stage and the session it is listed on. */}
                  <TableCell>{d.review ? <div className="ag-row tight">{d.review.id ? <RLink to={`/reviews/${d.review.id}`}>{d.review.code}</RLink> : <span>{d.review.code}</span>}{d.review.stage && <StatusTag kind="stage" value={d.review.stage} size="sm" label={labelFor("stage", d.review.stage)} />}{d.review.session?.code && (d.review.session.id ? <RLink to={`/sessions/${d.review.session.id}`}>{d.review.session.code}</RLink> : <span className="ag-muted ag-label">{d.review.session.code}</span>)}</div> : <span className="ag-muted">—</span>}</TableCell>
                  <TableCell><VerificationTag state={d.verification} origin={d.origin} by={d.verified_by} at={d.verified_at} /></TableCell>
                </TableRow>); })}</TableBody>
            </Table>
          </TableContainer>)}
      </DataTable>)}
      <Modal open={!!form} size="lg" modalHeading="New Architecture Decision" primaryButtonText="Create as Proposed" secondaryButtonText="Cancel" primaryButtonDisabled={!form?.title} onRequestClose={() => setForm(null)}
        onRequestSubmit={async () => { const r: any = await post("/decisions", { ...form, options: parseOptions(form.optionsText), constraint: form.allowedTypes.trim() ? { allowedTypes: form.allowedTypes.split(",").map((s: string) => s.trim()).filter(Boolean) } : null }); setForm(null); reload(); nav(`/decisions/${r.id}`); }}>
        {/* From an AI suggestion: save the decision as a proposed draft, trigger the assessment on it, and land on its page to complete and later submit it — the association is on the row. */}
        {form && <DecisionForm value={form} onChange={setForm} apps={apps} triggerLabel="Save Draft & Trigger Assessment"
          onTriggerAssessment={async (s) => {
            const r: any = await post("/decisions", { ...form, options: parseOptions(form.optionsText), constraint: form.allowedTypes.trim() ? { allowedTypes: form.allowedTypes.split(",").map((x: string) => x.trim()).filter(Boolean) } : null });
            await post(`/decisions/${r.id}/assessments`, { type: s.type, title: s.title || s.reason.slice(0, 120) });
            setForm(null); reload(); nav(`/decisions/${r.id}`);
          }} />}
      </Modal>
    </>
  );
}
