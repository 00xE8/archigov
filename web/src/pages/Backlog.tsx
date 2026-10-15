import React from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Table, TableHead, TableRow, TableHeader, TableBody, TableCell, TableContainer, Tag, DataTableSkeleton, Button, Modal, InlineLoading, Select, SelectItem, Search, RadioButtonGroup, RadioButton, ContentSwitcher, Switch, TextInput, TextArea } from "@carbon/react";
import { MachineLearningModel, Task, Checkmark, Link as LinkIcon, Add, Edit as EditIcon } from "@carbon/icons-react";
import { get, post, put, fmtDate, sentence } from "../api";
import { PageIntro, useLoad, OriginTag, LoadError, RLink, StatusTag, EmptyState, Empty, useDocTitle } from "../components";
import { DecisionForm, parseOptions, emptyDecision } from "./Decisions";
import { Gated } from "../auth";

// "Covered by": the decision or review that stands behind the item — the column the page exists for.
const HEADERS = ["Work item", "Application", "State", "Covered by", "Changed", "Actions"];
// ?filter= as the Overview tiles link here: the epics with no decision, or the items that changed after approval.
const FILTERS = ["all", "no_decision", "changed"];

export default function Backlog() {
  const [items, reload, err] = useLoad<any[]>(() => get("/work-items"));
  const [apps, , appsErr] = useLoad<any[]>(() => get("/applications"));
  const [draft, setDraft] = React.useState<any>(null);
  const [drafting, setDrafting] = React.useState<string | null>(null);
  const [link, setLink] = React.useState<any>(null);
  const [manual, setManual] = React.useState<any>(null); // null | {id?, type, title, description, application_id, state}
  const [state, setState] = React.useState("all");
  const [app, setApp] = React.useState("all");
  const [q, setQ] = React.useState("");
  const [params, setParams] = useSearchParams();
  const filter = FILTERS.includes(params.get("filter") || "") ? (params.get("filter") as string) : "all";
  const setFilter = (v: string) => { const n = new URLSearchParams(params); if (v && v !== "all") n.set("filter", v); else n.delete("filter"); setParams(n, { replace: true }); };
  const nav = useNavigate();
  useDocTitle("Planned Changes");
  if (err || appsErr) return <LoadError what="the backlog" err={(err || appsErr)!} onRetry={reload} />;
  if (!items || !apps) return <DataTableSkeleton columnCount={HEADERS.length} rowCount={6} showHeader={false} showToolbar={false} />;
  const states = Array.from(new Set(items.map((w) => w.state))).sort();
  const ql = q.trim().toLowerCase();
  const visible = items.filter((w) => (state === "all" || w.state === state) && (app === "all" || w.application_id === app)
    && (filter === "all" || (filter === "no_decision" ? !!w.needs_decision : !!w.material_change))
    && (!ql || [w.type, w.external_id, w.title, w.description, ...(w.tags || [])].join(" ").toLowerCase().includes(ql)));
  const startDraft = async (w: any) => {
    setDrafting(w.id);
    try {
      const d: any = await post(`/work-items/${w.id}/draft-decision`);
      setDraft({ ...emptyDecision(), work_item_id: w.id, origin: d.origin === "ai" ? "ai" : "human", draftOrigin: d.origin, title: d.title, topic: d.topic, application_ids: w.application_id ? [w.application_id] : [], context_md: d.context_md, optionsText: (d.options || []).map((o: any) => `${o.name} | ${o.pros || ""} | ${o.cons || ""}`).join("\n"), decision_md: d.decision_md, justification_md: d.justification_md || "", consequences_md: d.consequences_md });
    } finally { setDrafting(null); }
  };
  return (
    <>
      <PageIntro title="Planned Changes" lead="The work delivery is planning — epics and features fed from the Azure DevOps backlog, plus potential changes logged by hand, with the decision or review that covers each one. A feed, never a gate."
        about="Epics and features arrive from Azure DevOps as they are created; projects and initiatives that no backlog tool knows yet are logged by hand, visibly marked as manual. The product flags items that have no architecture decision, and requirements that changed after their design was approved. Nothing here is a gate: planned changes feed the model, never an approval step."
        actions={<Gated cap="log_change" mode="hide"><Button size="md" renderIcon={Add} onClick={() => setManual({ type: "Project", title: "", description: "", application_id: "" })}>Log Potential Change</Button></Gated>} />
      {items.length === 0 ? (
        <EmptyState title="No planned changes yet" actions={<><Gated cap="log_change" mode="hide"><Button size="md" renderIcon={Add} onClick={() => setManual({ type: "Project", title: "", description: "", application_id: "" })}>Log Potential Change</Button></Gated><RLink to="/?start=1">Get started</RLink></>}>
          Planned changes arrive from the Azure DevOps backlog as a feed and are linked to the decisions and reviews that cover them. Load the demo estate to see epics with and without decisions, and a requirement that changed after approval.
        </EmptyState>
      ) : (<>
        {/* The two governance signals this feed exists for, as a counted switcher (the Overview tiles deep-link here). */}
        <ContentSwitcher className="ag-kind-switcher ag-mb-03" size="md" selectedIndex={FILTERS.indexOf(filter)} onChange={({ index }: any) => setFilter(FILTERS[index ?? 0])}>
          <Switch name="all" text={`All (${items.length})`} />
          <Switch name="no_decision" text={`Needs a Decision (${items.filter((w) => w.needs_decision).length})`} />
          <Switch name="changed" text={`Changed After Approval (${items.filter((w) => w.material_change).length})`} />
        </ContentSwitcher>
        <div className="ag-row ag-mb-05 end">
          <Select id="bl-state" labelText="State" inline value={state} onChange={(e) => setState(e.target.value)}><SelectItem value="all" text="All" />{states.map((s) => <SelectItem key={s} value={s} text={sentence(s)} />)}</Select>
          <Select id="bl-app" labelText="Application" inline value={app} onChange={(e) => setApp(e.target.value)}><SelectItem value="all" text="All" />{apps.map((a) => <SelectItem key={a.id} value={a.id} text={a.name} />)}</Select>
          <Search id="bl-q" size="md" labelText="Filter backlog" placeholder="e.g. 1042 or referrals" value={q} onChange={(e) => setQ(e.target.value)} onClear={() => setQ("")} />
        </div>
        {visible.length === 0 ? <Empty>{filter === "no_decision" ? "Every open epic has a decision." : filter === "changed" ? "Nothing has changed since approval." : "No backlog items match these filters."}</Empty> : (
        <TableContainer><Table size="md">
          <TableHead><TableRow>{HEADERS.map((h) => <TableHeader key={h}>{h}</TableHeader>)}</TableRow></TableHead>
          <TableBody>{visible.map((w) => (
            <TableRow key={w.id}>
              <TableCell><div><span className="ag-muted">{w.type} {w.external_id}</span> · <span className="ag-strong">{w.title}</span>{w.source_kind === "manual" && <> <Tag size="sm" type="gray"><span title="Logged by hand: a potential change not yet in any backlog source — origin human, author recorded in the audit log.">Manual</span></Tag></>}</div><div className="ag-muted ag-label ag-wrap">{w.description}</div><div className="ag-row tight ag-mt-02">{w.tags.map((t: string) => <Tag key={t} size="sm" type="gray"><span title="Tag carried over from the backlog source.">{t}</span></Tag>)}</div></TableCell>
              <TableCell>{w.application_id ? <RLink to={`/applications/${w.application_id}`}>{w.application_name}</RLink> : <span className="ag-muted">Unlinked</span>}</TableCell>
              <TableCell><StatusTag kind="work" value={w.state} /></TableCell>
              <TableCell>
                <div className="ag-row tight">
                  {w.needs_decision && <StatusTag kind="attention" value="decision" label="No decision" />}
                  {w.decision_code && <RLink to={`/decisions/${w.decision_id}`}>{w.decision_code}</RLink>}
                  {w.review_code && <><RLink to={`/reviews/${w.review_id}`}>{w.review_code}</RLink> <span className="ag-muted">({sentence(w.review_stage).toLowerCase()})</span></>}
                  {w.material_change ? <StatusTag kind="attention" value="changed" /> : null}
                </div>
              </TableCell>
              <TableCell>{fmtDate(w.changed_at)}</TableCell>
              <TableCell>
                <div className="ag-actions">
                  {/* Row actions are hidden, not disabled, for roles that lack them: a row of greyed buttons is noise. */}
                  {w.needs_decision && (drafting === w.id ? <InlineLoading description="Drafting" /> : <Gated cap="create_decision" mode="hide"><Button size="sm" kind="ghost" renderIcon={MachineLearningModel} onClick={() => startDraft(w)}>Draft Decision</Button></Gated>)}
                  {w.needs_decision && <Gated cap="submit_design_review" mode="hide"><Button size="sm" kind="ghost" renderIcon={Task} onClick={async () => { const r: any = await post("/reviews", { type: "design", title: w.title, application_id: w.application_id, work_item_id: w.id, risk_tier: w.tags.includes("clinical-safety") || w.tags.includes("ai") ? "high" : "medium", summary: w.description, design_md: "## Design\n\n_To be completed by the submitter._\n" }); nav(`/reviews/${r.id}`); }}>Open Review</Button></Gated>}
                  {w.material_change ? <Gated cap="comment" mode="hide"><Button size="sm" kind="ghost" renderIcon={Checkmark} onClick={async () => { await post(`/work-items/${w.id}/acknowledge-change`); reload(); }}>Acknowledge</Button></Gated> : null}
                  {w.source_kind === "manual" && <Gated cap="log_change" mode="hide"><Button size="sm" kind="ghost" renderIcon={EditIcon} onClick={() => setManual({ id: w.id, type: w.type, title: w.title, description: w.description || "", application_id: w.application_id || "", state: w.state })}>Edit</Button></Gated>}
                  {(!w.decision_id || !w.review_id) && w.state !== "Closed" && <Gated cap="comment" mode="hide"><Button size="sm" kind="ghost" renderIcon={LinkIcon} onClick={() => setLink({ item: w, kind: w.decision_id ? "review" : "decision", id: "" })}>Link Decision or Review</Button></Gated>}
                </div>
              </TableCell>
            </TableRow>))}</TableBody>
        </Table></TableContainer>)}
      </>)}

      <Modal open={!!draft} size="lg" modalHeading={<span className="ag-row snug">Draft decision {draft && <OriginTag origin={draft.draftOrigin} />}</span>} primaryButtonText="Create as Proposed" secondaryButtonText="Cancel" primaryButtonDisabled={!draft?.title} onRequestClose={() => setDraft(null)}
        onRequestSubmit={async () => { const r: any = await post("/decisions", { ...draft, options: parseOptions(draft.optionsText), constraint: draft.allowedTypes.trim() ? { allowedTypes: draft.allowedTypes.split(",").map((s: string) => s.trim()) } : null }); setDraft(null); reload(); nav(`/decisions/${r.id}`); }}>
        {draft && <><p className="ag-muted ag-body ag-mb-05">{draft.draftOrigin === "ai" ? "Drafted by the configured model from the backlog item. It is created as not human verified until someone verifies it." : "No model configured, so this is a template pre-filled from the backlog item. Configure LLM_BASE_URL and LLM_MODEL to draft options automatically."}</p><DecisionForm value={draft} onChange={setDraft} apps={apps} /></>}
      </Modal>

      {link && <LinkModal link={link} setLink={setLink} onDone={() => { setLink(null); reload(); }} />}

      {/* A manually logged potential change: a project or initiative no backlog source knows yet. Human origin, audited. */}
      <Modal open={!!manual} modalHeading={manual?.id ? `Edit ${manual.title || "Potential Change"}` : "Log a Potential Change"} primaryButtonText={manual?.id ? "Save" : "Log Change"} secondaryButtonText="Cancel"
        primaryButtonDisabled={!manual || manual.title.trim().length < 3} onRequestClose={() => setManual(null)}
        onRequestSubmit={async () => {
          if (manual.id) await put(`/work-items/${manual.id}`, { title: manual.title, description: manual.description, state: manual.state, application_id: manual.application_id || null });
          else await post("/work-items", { type: manual.type, title: manual.title, description: manual.description, application_id: manual.application_id || null });
          setManual(null); reload();
        }}>
        {manual && <div className="ag-form">
          <p className="ag-body ag-muted">A potential change is logged as a fact about intent — visibly manual, never pretending to be derived. It is flagged until a decision or review covers it; when a backlog source later carries the real work item, link that item and close this one.</p>
          <Select id="mc-type" labelText="Type" value={manual.type} disabled={!!manual.id} onChange={(e) => setManual({ ...manual, type: e.target.value })}>
            <SelectItem value="Project" text="Project" /><SelectItem value="Initiative" text="Initiative" /><SelectItem value="Change" text="Change" />
          </Select>
          <TextInput id="mc-title" labelText="Title" placeholder="e.g. Replace on-premises document store" value={manual.title} onChange={(e) => setManual({ ...manual, title: e.target.value })} />
          <TextArea id="mc-desc" labelText="Description (optional)" rows={3} value={manual.description} onChange={(e) => setManual({ ...manual, description: e.target.value })} />
          <Select id="mc-app" labelText="Application (optional)" value={manual.application_id} onChange={(e) => setManual({ ...manual, application_id: e.target.value })}>
            <SelectItem value="" text="None yet" />{apps.map((a) => <SelectItem key={a.id} value={a.id} text={a.name} />)}
          </Select>
          {manual.id && <Select id="mc-state" labelText="State" helperText="Removed keeps the entry on the record with its audit trail; nothing is deleted." value={manual.state} onChange={(e) => setManual({ ...manual, state: e.target.value })}>
            {["Proposed", "Active", "Closed", "Removed"].map((x) => <SelectItem key={x} value={x} text={x} />)}
          </Select>}
        </div>}
      </Modal>
    </>
  );
}

/** Attach a backlog item to the decision or the review that covers it. */
function LinkModal({ link, setLink, onDone }: { link: any; setLink: (l: any) => void; onDone: () => void }) {
  const [decisions, , dErr] = useLoad<any[]>(() => get("/decisions"));
  const [reviews, , rErr] = useLoad<any[]>(() => get("/reviews"));
  const w = link.item;
  const options = link.kind === "decision" ? (decisions || []).map((d) => ({ id: d.id, text: `${d.code} · ${d.title}` })) : (reviews || []).map((r) => ({ id: r.id, text: `${r.code} · ${r.title}` }));
  return (
    <Modal open modalHeading={`Link ${w.type} ${w.external_id}`} primaryButtonText="Link" secondaryButtonText="Cancel" primaryButtonDisabled={!link.id} onRequestClose={() => setLink(null)}
      onRequestSubmit={async () => { await post(`/work-items/${w.id}/link`, link.kind === "decision" ? { decision_id: link.id } : { review_id: link.id }); onDone(); }}>
      <div className="ag-form">
        <p className="ag-body">Linking records which architecture decision or design review covers this item, so a later change to the item can be compared with what was approved.</p>
        <RadioButtonGroup legendText="Link to" name="link-kind" valueSelected={link.kind} onChange={(v) => setLink({ ...link, kind: String(v), id: "" })}>
          <RadioButton labelText="A decision" value="decision" id="lk-d" disabled={!!w.decision_id} />
          <RadioButton labelText="A review" value="review" id="lk-r" disabled={!!w.review_id} />
        </RadioButtonGroup>
        {(dErr || rErr) && <p className="ag-muted ag-label">{dErr || rErr}</p>}
        <Select id="lk-target" labelText={link.kind === "decision" ? "Decision" : "Review"} value={link.id} onChange={(e) => setLink({ ...link, id: e.target.value })}>
          <SelectItem value="" text="None selected" />
          {options.map((o) => <SelectItem key={o.id} value={o.id} text={o.text} />)}
        </Select>
      </div>
    </Modal>
  );
}
