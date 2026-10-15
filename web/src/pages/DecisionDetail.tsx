import React from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Button, Tag, SkeletonText, Table, TableHead, TableRow, TableHeader, TableBody, TableCell, Modal, StructuredListWrapper, StructuredListHead, StructuredListBody, StructuredListRow, StructuredListCell, ActionableNotification, Select, SelectItem, TextInput, TextArea, RadioButtonGroup, RadioButton } from "@carbon/react";
import { Edit, CheckmarkOutline, CloseOutline, Send, Add, Checkmark, ChevronDown, ChevronUp } from "@carbon/icons-react";
import { get, post, put, fmtDate, shortType, labelFor, ASSESSMENT_RESULTS } from "../api";
import { PageHeader, useLoad, VerificationTag, VerifyButton, Markdown, SeverityTag, Empty, LoadError, RLink, Crumbs, StatusTag, VerifiedBy, DateField, artefactLink, useDocTitle } from "../components";
import { DecisionForm, parseOptions } from "./Decisions";
import { Gated, useAuth } from "../auth";

// Status changes are consequential (acceptance starts continuous conformance checks), so each one confirms and names the object.
const CONFIRM: Record<string, { heading: (code: string) => string; body: string; button: string; danger?: boolean }> = {
  accepted: { heading: (c) => `Accept ${c}?`, body: "Accepting records this decision as the Design Authority's position. If it carries a checkable constraint, deployed resources are evaluated against it from now on and contradictions appear as drift.", button: "Accept" },
  rejected: { heading: (c) => `Reject ${c}?`, body: "Rejecting closes this proposal. It stays on record with its options and audit trail; nothing is deleted.", button: "Reject", danger: true },
  superseded: { heading: (c) => `Mark ${c} superseded?`, body: "The decision stops being enforced and is kept for the record. Create or accept the decision that replaces it separately.", button: "Mark superseded" },
};

/** A linked decision or review: its code links to its page, a decision's status rides along as a tag. A dependent nests the `review` that waits on this decision. */
function LinkedItem({ x }: { x: any }) {
  const it = x.review || x.decision || x;
  const code: string = it.code || it.id || "—";
  const to = it.stage || /^REV-/.test(code) ? `/reviews/${it.id}` : `/decisions/${it.id}`;
  return <span className="ag-row tight">{it.id ? <RLink to={to}>{code}</RLink> : code}{it.title ? <span className="ag-muted ag-label">{it.title}</span> : null}{it.status ? <StatusTag kind="decision" value={it.status} size="sm" /> : it.stage ? <StatusTag kind="stage" value={it.stage} size="sm" /> : null}</span>;
}

export default function DecisionDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const [d, reload, err] = useLoad<any>(() => get(`/decisions/${id}`), [id]);
  const [apps] = useLoad<any[]>(() => get("/applications"));
  const [form, setForm] = React.useState<any>(null);
  const [confirm, setConfirm] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  // A review the server named in a 409: the decision is being decided through it, so the page defers to it the same way.
  const [blocked, setBlocked] = React.useState<any>(null);
  useDocTitle(d ? d.code : null);
  if (err) return <LoadError what="this decision" err={err} onRetry={reload} />;
  if (!d) return <SkeletonText paragraph lineCount={8} />;
  const setStatus = async (status: string) => {
    try { await post(`/decisions/${d.id}/status`, { status }); setConfirm(null); reload(); }
    catch (e: any) { if (e?.status === 409 && e.body?.review) { setConfirm(null); setBlocked(e.body.review); reload(); } else throw e; }
  };
  const c = confirm ? CONFIRM[confirm] : null;
  // While a review of this decision is in flight, acceptance happens there: the chair declares what the positions allow.
  const inFlight: any = d.review_in_flight || blocked || null;
  return (
    <>
      <PageHeader breadcrumb={<Crumbs items={[{ to: "/decisions", label: "Decision Log" }, { label: d.code }]} />} title={`${d.code} · ${d.title}`}
        about="An architecture decision record: the context, the options considered and the consequences. A checkable constraint holds the deployed estate to the decision continuously — contradictions appear as drift. While a review of this decision is in flight, acceptance happens there, not here."
        subtitle={<span className="ag-row snug"><StatusTag kind="decision" value={d.status} size="md" /><span>{labelFor("topic", d.topic)} · by {d.author} · created {fmtDate(d.created_at)}{d.decided_at ? ` · decided ${fmtDate(d.decided_at)}` : ""}</span></span>}
        actions={<>
          <VerificationTag state={d.verification} origin={d.origin} by={d.verified_by} at={d.verified_at} size="md" />
          {d.verification === "verified" && <VerifiedBy by={d.verified_by} at={d.verified_at} />}
          <VerifyButton size="md" path={`/decisions/${d.id}/verify`} state={d.verification} onDone={reload} />
          <Gated cap="create_decision"><Button size="md" kind="ghost" renderIcon={Edit} onClick={() => setForm({ title: d.title, topic: d.topic, application_ids: d.application_ids, context_md: d.context_md || "", optionsText: d.options.map((o: any) => `${o.name} | ${o.pros || ""} | ${o.cons || ""}`).join("\n"), decision_md: d.decision_md || "", justification_md: d.justification_md || "", consequences_md: d.consequences_md || "", allowedTypes: (d.constraint?.allowedTypes || []).join(", ") })}>Edit</Button></Gated>
          {/* The author's path to the board: the review is where acceptance happens, so a proposed decision submits from here. */}
          {!inFlight && d.status === "proposed" && <Gated cap="submit_review" mode="hide"><Button size="md" kind="tertiary" renderIcon={Send} disabled={busy === "submit"} onClick={async () => { setBusy("submit"); try { const r: any = await post("/reviews", { type: "decision", decision_id: d.id, title: `${d.code} · ${d.title}`, summary: d.decision_md || d.title }); nav(`/reviews/${r.id}`); } finally { setBusy(null); } }}>Submit for Review</Button></Gated>}
          {!inFlight && d.status === "proposed" && <><Gated cap="set_decision_status"><Button size="md" kind="primary" renderIcon={CheckmarkOutline} onClick={() => setConfirm("accepted")}>Accept</Button></Gated><Gated cap="set_decision_status"><Button size="md" kind="danger--tertiary" renderIcon={CloseOutline} onClick={() => setConfirm("rejected")}>Reject</Button></Gated></>}
          {!inFlight && d.status === "accepted" && <Gated cap="set_decision_status"><Button size="md" kind="tertiary" onClick={() => setConfirm("superseded")}>Mark Superseded</Button></Gated>}
        </>} />
      {inFlight && <>
        <ActionableNotification kind="info" lowContrast inline hideCloseButton className="ag-notice"
          title={`Under review at ${inFlight.board?.name || inFlight.board?.code || "its board"} · ${inFlight.code || "review"}${inFlight.stage ? ` (${labelFor("stage", inFlight.stage).toLowerCase()})` : ""}${inFlight.session?.code ? ` · ${inFlight.session.code}` : ""}`}
          subtitle="Acceptance happens through the review: decision makers record positions and the chair declares the outcome they allow."
          actionButtonLabel="Open review" onActionButtonClick={() => inFlight.id && nav(`/reviews/${inFlight.id}`)} />
        {/* Carbon keeps interactive content out of a notification body, so the links sit beneath it. */}
        <div className="ag-row snug ag-label ag-mb-05">
          {inFlight.id && <RLink to={`/reviews/${inFlight.id}`}>{inFlight.code}</RLink>}
          {inFlight.session?.id && <RLink to={`/sessions/${inFlight.session.id}`}>{inFlight.session.code}{inFlight.session.status ? ` · ${labelFor("session_status", inFlight.session.status).toLowerCase()}` : ""}</RLink>}
          {inFlight.board?.id && <RLink to={`/boards/${inFlight.board.id}`}>{inFlight.board.name || inFlight.board.code}</RLink>}
        </div>
      </>}

      <div className="ag-grid-2">
        <div>
          <section className="ag-section"><h2>Context</h2><Markdown md={d.context_md} /></section>
          <section className="ag-section"><h2>Options Considered</h2>
            {d.options.length === 0 ? <Empty>No options recorded.</Empty> : (
              <StructuredListWrapper><StructuredListHead><StructuredListRow head><StructuredListCell head>Option</StructuredListCell><StructuredListCell head>Pros</StructuredListCell><StructuredListCell head>Cons</StructuredListCell></StructuredListRow></StructuredListHead>
                <StructuredListBody>{d.options.map((o: any, i: number) => <StructuredListRow key={i}><StructuredListCell>{o.name}</StructuredListCell><StructuredListCell>{o.pros}</StructuredListCell><StructuredListCell>{o.cons}</StructuredListCell></StructuredListRow>)}</StructuredListBody></StructuredListWrapper>)}
          </section>
          <section className="ag-section"><h2>Recommended Option</h2><Markdown md={d.decision_md} /></section>
          {d.justification_md ? <section className="ag-section"><h2>Justification</h2><Markdown md={d.justification_md} /></section> : null}
          <section className="ag-section"><h2>Consequences</h2><p className="ag-muted ag-label ag-mb-03">What accepting this decision means, and which risks were accepted with it.</p><Markdown md={d.consequences_md} /></section>
        </div>
        <div>
          <section className="ag-section"><h2>Applies To</h2><div className="ag-row snug">{d.applications.map((a: any, i: number) => <React.Fragment key={a.id}>{i > 0 && <span className="ag-muted">·</span>}<RLink to={`/applications/${a.id}`}>{a.name}</RLink></React.Fragment>)}{d.applications.length === 0 && <span className="ag-muted">All applications</span>}</div></section>
          <DecisionAssessments d={d} onChanged={reload} />
          <section className="ag-section"><h2>Checkable Constraint</h2>
            {d.constraint?.allowedTypes ? <div><p className="ag-body ag-mb-03">Deployed resources of these kinds are allowed; anything else is drift against this decision.</p><div className="ag-row tight">{d.constraint.allowedTypes.map((t: string) => <Tag key={t} type="gray" size="sm"><span title="A resource type this decision allows; a deployed resource of any other type is drift against it.">{shortType(t)}</span></Tag>)}</div></div> : <span className="ag-muted">None. This decision is evidenced through reviews only.</span>}
          </section>
          <section className="ag-section"><h2>Conformance ({d.findings.length})</h2>
            {d.findings.length === 0 ? <Empty>{d.status === "accepted" ? "Nothing deployed contradicts this decision." : "Conformance is checked once the decision is accepted."}</Empty> : (
              <Table size="sm"><TableHead><TableRow><TableHeader>Severity</TableHeader><TableHeader>Element</TableHeader><TableHeader>Finding</TableHeader></TableRow></TableHead>
                <TableBody>{d.findings.map((f: any) => <TableRow key={f.id}><TableCell><SeverityTag s={f.severity} /></TableCell><TableCell>{f.element_name}</TableCell><TableCell>{f.message}</TableCell></TableRow>)}</TableBody></Table>)}
          </section>
          <section className="ag-section"><h2>Linked Items</h2>
            <dl className="ag-kv">
              <dt>Catalogue items</dt><dd className="ag-row tight">{d.standards.length ? d.standards.map((s: any) => <RLink key={s.id} to={artefactLink(s.id)}>{s.code}</RLink>) : "—"}</dd>
              <dt>Reviews</dt><dd className="ag-row tight">{d.reviews.length ? d.reviews.map((r: any) => <RLink key={r.id} to={`/reviews/${r.id}`}>{r.code}</RLink>) : "—"}</dd>
              {/* Dependent decisions: what this one waits for, and what waits for it (absent on an older server). */}
              {Array.isArray(d.depends_on) && <><dt>Depends on</dt><dd className="ag-row tight">{d.depends_on.length ? d.depends_on.map((x: any, i: number) => <LinkedItem key={x.id || i} x={x} />) : "—"}</dd></>}
              {Array.isArray(d.dependents) && <><dt>Blocks</dt><dd className="ag-row tight">{d.dependents.length ? d.dependents.map((x: any, i: number) => <LinkedItem key={x.id || i} x={x} />) : "—"}</dd></>}
              <dt>Backlog</dt><dd>{d.workItems.length ? d.workItems.map((w: any) => <span key={w.id}>{w.type} {w.external_id} · {w.title}</span>) : "—"}</dd>
            </dl>
          </section>
          <section className="ag-section"><h2>Audit Trail</h2>
            {d.audit.length === 0
              ? <p className="ag-muted ag-body">No audit entries yet. Seeded decisions start without a trail; every status change, edit and verification from now on is recorded here and in the <RLink inline to={`/audit?entity=decision&entity_id=${d.id}`}>audit log</RLink>.</p>
              : <ul className="ag-timeline">{d.audit.map((a: any) => <li key={a.id}><div className="meta">{fmtDate(a.at)} · {a.actor}</div><div className="ag-body">{a.action}</div></li>)}</ul>}
          </section>
        </div>
      </div>

      <Modal open={!!c} danger={!!c?.danger} modalHeading={c ? c.heading(d.code) : ""} primaryButtonText={c?.button || ""} secondaryButtonText="Cancel" onRequestClose={() => setConfirm(null)} onRequestSubmit={() => confirm && setStatus(confirm)}>
        <p className="ag-body">{c?.body}</p>
      </Modal>

      <Modal open={!!form} size="lg" modalHeading={`Edit ${d.code}`} primaryButtonText="Save" secondaryButtonText="Cancel" onRequestClose={() => setForm(null)}
        onRequestSubmit={async () => { await put(`/decisions/${d.id}`, { ...form, options: parseOptions(form.optionsText), constraint: form.allowedTypes.trim() ? { allowedTypes: form.allowedTypes.split(",").map((s: string) => s.trim()).filter(Boolean) } : null }); setForm(null); reload(); }}>
        {form && apps && <DecisionForm value={form} onChange={setForm} apps={apps} triggerLabel="Trigger Assessment"
          onTriggerAssessment={async (s) => { await post(`/decisions/${d.id}/assessments`, { type: s.type, title: s.title || s.reason.slice(0, 120) }); setForm(null); reload(); }} />}
      </Modal>
    </>
  );
}

/**
 * Evidence on the decision: assessments the author triggers (completed by a named assessor) or provides while the
 * decision is proposed — gathered BEFORE review, carried onto the review as "on the decision", never blocking.
 */
function DecisionAssessments({ d, onChanged }: { d: any; onChanged: () => void }) {
  const { me } = useAuth();
  const myId = me?.user?.id || "";
  const assessments: any[] = d.assessments || [];
  const author = myId === d.author;
  const proposed = d.status === "proposed";
  const [modal, setModal] = React.useState<any>(null);
  const [open, setOpen] = React.useState<Record<string, boolean>>({});
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [types] = useLoad<any[] | null>(() => get<any[]>("/assessments/types").catch(() => null));
  const [users] = useLoad<any[] | null>(() => (modal?.kind === "trigger" ? get<any[]>("/users").catch(() => []) : Promise.resolve(null)), [modal?.kind]);
  const tpl = (t: string) => (types || []).find((x: any) => x.type === t)?.template || "";
  const run = async (fn: () => Promise<any>) => { setBusy(true); setErr(null); try { await fn(); setModal(null); onChanged(); } catch (e: any) { setErr(String(e.message || e).split("\n")[0]); } finally { setBusy(false); } };
  if (assessments.length === 0 && !(author && proposed)) return null;
  return (
    <section className="ag-section">
      <div className="ag-row between"><h2>Evidence ({assessments.length})</h2>
        {author && proposed && <div className="ag-row snug">
          <Button size="sm" kind="tertiary" renderIcon={Add} onClick={() => setModal({ kind: "trigger", type: "impact", title: "", assigned_to: myId, due_at: "" })}>Trigger Assessment</Button>
          <Button size="sm" kind="tertiary" renderIcon={Add} onClick={() => setModal({ kind: "provide", type: "impact", title: "", result: "satisfactory", text: tpl("impact"), reference: "" })}>Provide Assessment</Button>
        </div>}
      </div>
      {err && <p className="ag-muted ag-label">{err}</p>}
      {assessments.length === 0 ? <Empty>No evidence gathered yet. Trigger an assessment (yours or someone else's to complete) or attach one already done; it follows the decision onto its review.</Empty> : (
      <Table size="sm"><TableHead><TableRow><TableHeader>Assessment</TableHeader><TableHeader>Result</TableHeader><TableHeader>People</TableHeader><TableHeader>When</TableHeader><TableHeader>Actions</TableHeader></TableRow></TableHead>
        <TableBody>{assessments.map((a: any) => (<React.Fragment key={a.id}>
          <TableRow>
            <TableCell><div className="ag-row tight"><Tag size="sm" type="gray"><span title="A due-diligence assessment.">{labelFor("assessment_type", a.type)}</span></Tag>{a.provided && <Tag size="sm" type="gray"><span title="Attached by the author as evidence already gathered; recorded under their name.">Provided</span></Tag>}</div>{a.title && <div className="ag-label">{a.title}</div>}</TableCell>
            <TableCell>{a.status === "completed" && a.result ? <StatusTag kind="assessment_result" value={a.result} /> : <StatusTag kind="assessment_status" value={a.status} />}</TableCell>
            <TableCell className="ag-label">{a.provided ? <>{a.completed_by_name || a.completed_by}<div className="ag-muted">author</div></> : <>{a.assigned_to_name || a.assigned_to}<div className="ag-muted">asked by {a.requested_by_name || a.requested_by}</div></>}</TableCell>
            <TableCell className="ag-label">{a.status === "requested" ? (a.due_at ? `due ${fmtDate(a.due_at)}` : <span className="ag-muted">—</span>) : fmtDate(a.completed_at)}</TableCell>
            <TableCell><div className="ag-actions">
              {(a.result_md || a.reference) && <Button size="sm" kind="ghost" renderIcon={open[a.id] ? ChevronUp : ChevronDown} onClick={() => setOpen((o) => ({ ...o, [a.id]: !o[a.id] }))}>{open[a.id] ? "Hide Result" : "View Result"}</Button>}
              {a.status === "requested" && myId === a.assigned_to && <Button size="sm" kind="ghost" renderIcon={Checkmark} onClick={() => setModal({ kind: "result", a, result: "satisfactory", text: tpl(a.type), reference: "" })}>Record Result</Button>}
              {a.provided && proposed && myId === a.completed_by && <Button size="sm" kind="ghost" renderIcon={Edit} onClick={() => setModal({ kind: "provide", id: a.id, type: a.type, title: a.title || "", result: a.result, text: a.result_md || "", reference: a.reference || "" })}>Update</Button>}
            </div></TableCell>
          </TableRow>
          {open[a.id] && <TableRow className="ag-subrow"><TableCell colSpan={5}>
            {a.result_md && <Markdown md={a.result_md} />}
            {a.reference && <div className="ag-label">Reference: <a className="cds--link" href={a.reference} target="_blank" rel="noreferrer">{a.reference}</a></div>}
          </TableCell></TableRow>}
        </React.Fragment>))}</TableBody></Table>)}
      <p className="ag-muted ag-label ag-mt-03">Evidence here never blocks anything; it informs the board. The review this decision goes to shows each row as "on the decision".</p>

      {modal?.kind === "trigger" && (
        <Modal open modalHeading={`Trigger an Assessment · ${d.code}`} primaryButtonText="Trigger" secondaryButtonText="Cancel" primaryButtonDisabled={busy || (modal.type === "other" && !modal.title.trim()) || !modal.assigned_to} onRequestClose={() => setModal(null)}
          onRequestSubmit={() => run(() => post(`/decisions/${d.id}/assessments`, { type: modal.type, title: modal.title.trim() || null, assigned_to: modal.assigned_to || null, due_at: modal.due_at || null }))}>
          <div className="ag-form">
            <p className="ag-body">The named assessor completes it and records the result; the decision stays a draft until you submit it for review.</p>
            <Select id="da-type" labelText="Type" value={modal.type} onChange={(e) => setModal({ ...modal, type: e.target.value })}>{(types || []).map((t: any) => <SelectItem key={t.type} value={t.type} text={t.label} />)}</Select>
            <TextInput id="da-title" labelText={modal.type === "other" ? "Title" : "Title (optional)"} value={modal.title} onChange={(e) => setModal({ ...modal, title: e.target.value })} />
            <div className="ag-row end">
              <Select id="da-assignee" labelText="Assessor" value={modal.assigned_to} onChange={(e) => setModal({ ...modal, assigned_to: e.target.value })}>
                {(users || []).filter((u) => u.user_type !== "auditor" && u.user_type !== "service").map((u) => <SelectItem key={u.id} value={u.id} text={`${u.name || u.id}${u.id === myId ? " · you" : ""}`} />)}
              </Select>
              <DateField id="da-due" labelText="Due (optional)" value={modal.due_at} onChange={(ymd) => setModal({ ...modal, due_at: ymd })} />
            </div>
          </div>
        </Modal>)}
      {modal?.kind === "provide" && (
        <Modal open modalHeading={modal.id ? "Update Evidence" : `Provide an Assessment · ${d.code}`} primaryButtonText={modal.id ? "Save" : "Attach Assessment"} secondaryButtonText="Cancel" primaryButtonDisabled={busy || modal.text.trim().length < 10 || (modal.type === "other" && !modal.title.trim())} onRequestClose={() => setModal(null)}
          onRequestSubmit={() => run(() => modal.id
            ? put(`/assessments/${modal.id}/provided`, { result: modal.result, result_md: modal.text.trim(), reference: modal.reference.trim() || null })
            : post(`/decisions/${d.id}/assessments/provide`, { type: modal.type, title: modal.title.trim() || null, result: modal.result, result_md: modal.text.trim(), reference: modal.reference.trim() || null }))}>
          <div className="ag-form">
            {!modal.id && <Select id="dp-type" labelText="Type" value={modal.type} onChange={(e) => { const t = e.target.value; setModal({ ...modal, type: t, text: modal.text.trim() === "" || modal.text === tpl(modal.type) ? tpl(t) : modal.text }); }}>{(types || []).map((t: any) => <SelectItem key={t.type} value={t.type} text={t.label} />)}</Select>}
            {!modal.id && <TextInput id="dp-title" labelText={modal.type === "other" ? "Title" : "Title (optional)"} value={modal.title} onChange={(e) => setModal({ ...modal, title: e.target.value })} />}
            <RadioButtonGroup legendText="Result" name="dp-result" orientation="vertical" valueSelected={modal.result} onChange={(v) => setModal({ ...modal, result: String(v) })}>
              {ASSESSMENT_RESULTS.map((x) => <RadioButton key={x} id={`dpr-${x}`} value={x} labelText={labelFor("assessment_result", x)} />)}
            </RadioButtonGroup>
            <TextArea id="dp-summary" labelText="Summary (at least 10 characters)" rows={6} value={modal.text} onChange={(e) => setModal({ ...modal, text: e.target.value })} />
            <TextInput id="dp-ref" labelText="Reference (optional)" helperText="A pointer to the full document — never the document itself." value={modal.reference} onChange={(e) => setModal({ ...modal, reference: e.target.value })} />
          </div>
        </Modal>)}
      {modal?.kind === "result" && (
        <Modal open modalHeading={`Record Result · ${modal.a.title || labelFor("assessment_type", modal.a.type)}`} primaryButtonText="Record Result" secondaryButtonText="Cancel" primaryButtonDisabled={busy || modal.text.trim().length < 10} onRequestClose={() => setModal(null)}
          onRequestSubmit={() => run(() => post(`/assessments/${modal.a.id}/result`, { result: modal.result, result_md: modal.text.trim(), reference: modal.reference.trim() || null }))}>
          <div className="ag-form">
            <p className="ag-body">You record this as yourself; it is audited on the decision and follows it onto the review.</p>
            <RadioButtonGroup legendText="Result" name="dr-result" orientation="vertical" valueSelected={modal.result} onChange={(v) => setModal({ ...modal, result: String(v) })}>
              {ASSESSMENT_RESULTS.map((x) => <RadioButton key={x} id={`drr-${x}`} value={x} labelText={labelFor("assessment_result", x)} />)}
            </RadioButtonGroup>
            <TextArea id="dr-summary" labelText="Summary (at least 10 characters)" rows={6} value={modal.text} onChange={(e) => setModal({ ...modal, text: e.target.value })} />
            <TextInput id="dr-ref" labelText="Reference (optional)" value={modal.reference} onChange={(e) => setModal({ ...modal, reference: e.target.value })} />
          </div>
        </Modal>)}
    </section>
  );
}
