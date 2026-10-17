import React from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { DataTable, Table, TableHead, TableRow, TableHeader, TableBody, TableCell, TableContainer, TableToolbar, TableToolbarContent, TableToolbarSearch, DataTableSkeleton, Button, Modal, TextInput, TextArea, Select, SelectItem, Dropdown, SkeletonText, InlineNotification, FilterableMultiSelect } from "@carbon/react";
import { Add } from "@carbon/icons-react";
import { get, post, fmtDate, labelFor, REVIEW_TYPES, ARTEFACT_KINDS, kindOfCode } from "../api";
import { PageIntro, useLoad, LoadError, RLink, StatusTag, EmptyState, KindTag, targetLink, progressText, progressShort, useDocTitle } from "../components";
import { Gated } from "../auth";

// Seven columns fit a 1440 viewport without the table scrolling: the code carries its title and last update, the board its session.
const headers = [{ key: "review", header: "Review" }, { key: "type", header: "Type" }, { key: "target", header: "Target" }, { key: "board", header: "Board" }, { key: "progress", header: "Progress" }, { key: "stage", header: "Stage" }, { key: "open_conditions", header: "Conditions" }];
const TEMPLATE = `## Design\n\nWhat is being built or changed, and how it fits the current estate.\n\n## Data\n\nWhat data is involved, where it lives, who can see it.\n\n## Security\n\nIdentity, network exposure, secrets.\n\n## Resilience\n\nAvailability, backup, failure modes.\n`;
const ARTEFACT_TYPES = ARTEFACT_KINDS.map((k) => k.kind);
const typeItems = REVIEW_TYPES.map((t) => ({ id: t, label: `${labelFor("review_type", t)} review` }));
const TYPE_HELP: Record<string, string> = {
  design: "A design for an application, pre-reviewed against the catalogue; approvals carry conditions.",
  decision: "An architecture decision proposed for acceptance by the board.",
  standard: "A draft standard to adopt; its rule is validated and dry-run first.",
  principle: "A draft principle to adopt.",
  pattern: "A draft pattern to adopt; its constraint is validated and dry-run first.",
  policy: "A draft policy to adopt; mandatory policies produce findings once adopted.",
  exception: "A request to accept a finding knowingly, for a stated time.",
};

/** The review's target for the list: what it is about and where that lives. */
function Target({ r }: { r: any }) {
  const t = r.target || (r.application_id ? { kind: "application", id: r.application_id, name: r.application_name } : null);
  if (!t) return <span className="ag-muted">—</span>;
  const to = targetLink(t);
  const text = t.code ? `${t.code}${t.name ? ` · ${t.name}` : ""}` : t.name || t.id;
  return to ? <RLink to={to}>{text}</RLink> : <span>{text}</span>;
}

export default function Reviews() {
  const [params, setParams] = useSearchParams();
  const awaiting = params.get("awaiting") === "me";
  const session = params.get("session") || "";
  // The server filters by session (and by "awaiting me"); the session filter is applied here too for a server that ignores it.
  const qs = [awaiting ? "awaiting=me" : "", session ? `session=${encodeURIComponent(session)}` : ""].filter(Boolean).join("&");
  const [list, reload, err] = useLoad<any[]>(() => get(`/reviews${qs ? `?${qs}` : ""}`), [qs]);
  const [boards] = useLoad<any[]>(() => get<any[]>("/boards").catch(() => []));
  const [sessions] = useLoad<any[]>(() => get<any[]>("/sessions").catch(() => []));
  const [type, setType] = React.useState("all");
  const [board, setBoard] = React.useState("all");
  const [form, setForm] = React.useState<any>(null);
  const nav = useNavigate();
  useDocTitle("Reviews");
  if (err) return <LoadError what="reviews" err={err} onRetry={reload} />;
  if (!list) return <DataTableSkeleton headers={headers} rowCount={6} showHeader={false} showToolbar />;
  const typed = list.some((r) => r.type);
  const visible = list.filter((r) => (type === "all" || (r.type || "design") === type) && (board === "all" || r.board?.id === board) && (!session || !r.session || r.session.id === session || r.session.code === session));
  const rows = visible.map((r) => ({ id: r.id, review: `${r.code} ${r.title}`, type: labelFor("review_type", r.type || "design"), target: r.target?.name || r.application_name || "", board: `${r.board?.name || ""} ${r.session?.code || ""}`, progress: progressShort(r.progress), stage: r.stage, open_conditions: r.open_conditions }));
  const open = () => setForm({ type: "design", title: "", summary: "", application_id: "", decision_id: "", artefact_id: "", finding_id: "", risk_tier: "medium", impact: "minor", design_md: TEMPLATE, patterns: [] });
  const setParam = (k: string, v: string) => { const n = new URLSearchParams(params); if (v) n.set(k, v); else n.delete(k); setParams(n, { replace: true }); };
  const setAwaiting = (on: boolean) => setParam("awaiting", on ? "me" : "");
  // Open and planned sittings first, then the record; a session the URL names but the list lacks still shows as an option.
  const sessionItems = [...(sessions || [])].sort((a, b) => (a.status === "closed" ? 1 : 0) - (b.status === "closed" ? 1 : 0) || String(a.scheduled_at).localeCompare(String(b.scheduled_at)));
  return (
    <>
      <PageIntro title="Reviews" lead="Everything submitted to a board, by type and target, with where each one stands."
        about="Every review names its type and its target: a design for an application, a decision, a draft standard, principle, pattern or policy, or an exception. It is routed to a board, pre-reviewed automatically, and decided only once the board's approval policy is satisfied."
        actions={<Gated cap="submit_design_review"><Button size="md" renderIcon={Add} onClick={open}>Submit for Review</Button></Gated>} />
      {list.length === 0 && !awaiting && !session && type === "all" ? (
        <EmptyState title="No reviews yet" actions={<><Gated cap="submit_design_review"><Button size="md" renderIcon={Add} onClick={open}>Submit for Review</Button></Gated><RLink to="/?start=1">Get started</RLink></>}>
          Designs, decisions and catalogue items are submitted here for a board. A low-risk design is pre-reviewed automatically against the catalogue, and every finding cites what it rests on.
        </EmptyState>
      ) : (
      <DataTable rows={rows} headers={headers} isSortable>
        {({ rows, headers, getHeaderProps, getRowProps, getTableProps, onInputChange }: any) => (
          <TableContainer>
            <TableToolbar><TableToolbarContent>
              <div className="ag-toolbar-filters">
              <Select id="rv-type" labelText="Type" inline value={type} onChange={(e) => setType(e.target.value)}><SelectItem value="all" text="All" />{REVIEW_TYPES.map((t) => <SelectItem key={t} value={t} text={labelFor("review_type", t)} />)}</Select>
              {(boards || []).length > 0 && <Select id="rv-board" labelText="Board" inline value={board} onChange={(e) => setBoard(e.target.value)}><SelectItem value="all" text="All" />{boards!.map((b) => <SelectItem key={b.id} value={b.id} text={b.name} />)}</Select>}
              {(sessionItems.length > 0 || session) && <Select id="rv-session" labelText="Session" inline value={session} onChange={(e) => setParam("session", e.target.value)}><SelectItem value="" text="Any" />{sessionItems.map((s) => <SelectItem key={s.id} value={s.id} text={`${s.code} · ${s.board?.code || ""} · ${labelFor("session_status", s.status)}`} />)}{session && !sessionItems.some((s) => s.id === session) && <SelectItem value={session} text={session} />}</Select>}
              <Select id="rv-show" labelText="Show" inline value={awaiting ? "mine" : "all"} onChange={(e) => setAwaiting(e.target.value === "mine")}><SelectItem value="all" text="All reviews" /><SelectItem value="mine" text="Awaiting me" /></Select>
              </div>
              <TableToolbarSearch onChange={onInputChange} placeholder="e.g. REV-0002" persistent />
            </TableToolbarContent></TableToolbar>
            <Table {...getTableProps()} size="md">
              <TableHead><TableRow>{headers.map((h: any) => <TableHeader {...getHeaderProps({ header: h })} key={h.key}>{h.header}</TableHeader>)}</TableRow></TableHead>
              <TableBody>{rows.length === 0 ? <TableRow><TableCell colSpan={headers.length}><span className="ag-muted">{awaiting ? "Nothing is waiting on you." : session ? "Nothing is listed on that session." : "No reviews match these filters."}</span></TableCell></TableRow> : rows.map((r: any) => { const x = list.find((y) => y.id === r.id)!; return (
                <TableRow {...getRowProps({ row: r })} key={r.id}>
                  <TableCell className="ag-col-review"><RLink to={`/reviews/${x.id}`}>{x.code}</RLink><div className="ag-label">{x.title}</div><div className="ag-muted ag-label">updated {fmtDate(x.updated_at)}</div></TableCell>
                  {/* Classification together: the type and, for a design, its risk tier (a status, so it keeps its colour). */}
                  <TableCell><div className="ag-row tight"><KindTag kind="review_type" value={x.type || "design"} />{(x.type || "design") === "design" && x.risk_tier && <StatusTag kind="risk" value={x.risk_tier} size="sm" />}</div></TableCell>
                  <TableCell><Target r={x} /></TableCell>
                  {/* The board, and beneath it the session the review is listed on (or was declared at); the list row may carry only its code. */}
                  <TableCell>{x.board?.name || <span className="ag-muted">—</span>}{x.session?.code && <div className="ag-label">{x.session.id ? <RLink to={`/sessions/${x.session.id}`}>{x.session.code}</RLink> : x.session.code}</div>}</TableCell>
                  {/* "2/3 areas" at a glance; which areas still hold the item up is one hover away. */}
                  <TableCell>{x.progress ? <span className="ag-label ag-nowrap" title={progressText(x.progress)}>{progressShort(x.progress) || progressText(x.progress)}</span> : <span className="ag-muted">—</span>}</TableCell>
                  {/* "Awaiting you" is a notification, not a problem: the same filled-blue tag as My work, never the red attention tag. */}
                  <TableCell><div className="ag-row tight"><StatusTag kind="stage" value={x.stage} />{x.progress?.via_fast_lane && <StatusTag kind="fast_lane" value="eligible" label="Fast Lane" />}{x.awaiting_me && <StatusTag kind="position" value="mine" label="Awaiting you" />}</div></TableCell>
                  <TableCell>{x.open_conditions ? (x.overdue_conditions ? <StatusTag kind="condition" value="overdue" label={`${x.open_conditions} open · ${x.overdue_conditions} overdue`} /> : <StatusTag kind="condition" value="open" label={`${x.open_conditions} open`} />) : null}</TableCell>
                </TableRow>); })}</TableBody>
            </Table>
          </TableContainer>)}
      </DataTable>)}
      {!typed && list.length > 0 && <p className="ag-muted ag-label ag-mt-03">This server does not type reviews yet; everything here is a design review.</p>}
      {form && <SubmitModal form={form} setForm={setForm} onDone={(id) => { setForm(null); reload(); nav(`/reviews/${id}`); }} />}
    </>
  );
}

/** Type first, then the target that type needs, then the board it will go to (resolved by the server's routing). */
function SubmitModal({ form, setForm, onDone }: { form: any; setForm: (f: any) => void; onDone: (id: string) => void }) {
  const t: string = form.type;
  const isArtefact = ARTEFACT_TYPES.includes(t);
  const km = ARTEFACT_KINDS.find((k) => k.kind === t) || ARTEFACT_KINDS[0];
  const [apps] = useLoad<any[]>(() => get<any[]>("/applications").catch(() => []));
  const [decisions] = useLoad<any[]>(() => (t === "decision" ? get<any[]>("/decisions").catch(() => []) : Promise.resolve([])), [t]);
  const [artefacts] = useLoad<any[]>(() => (isArtefact ? get<any[]>(`/artefacts?kind=${t}`).catch(() => get<any[]>("/standards").then((l) => l.filter((s) => kindOfCode(s.code) === t))) : Promise.resolve([])), [t]);
  const [patterns] = useLoad<any[]>(() => (t === "design" ? get<any[]>("/artefacts?kind=pattern").then((l) => l.filter((a) => a.lifecycle === "adopted")).catch(() => []) : Promise.resolve([])), [t]);
  const [findings] = useLoad<any[]>(() => (t === "exception" ? get<any>("/conformance").then((d) => (d.findings || []).filter((f: any) => f.status === "open")).catch(() => []) : Promise.resolve([])), [t]);
  const artefact = (artefacts || []).find((a) => a.id === form.artefact_id);
  const [route, setRoute] = React.useState<any>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const decision = (decisions || []).find((d) => d.id === form.decision_id);
  const finding = (findings || []).find((f) => f.id === form.finding_id);
  // preview the board with what the server routes by: type, kind, category (a decision's topic) and the applications
  React.useEffect(() => {
    const qs = new URLSearchParams({ type: t }); if (isArtefact) qs.set("kind", t); if (artefact?.category) qs.set("category", artefact.category);
    if (t === "decision" && decision?.topic) qs.set("category", decision.topic);
    const routeApps: string[] = t === "design" ? [form.application_id] : t === "decision" ? (decision?.application_ids || []) : t === "exception" ? [finding?.application_id] : [];
    for (const a of routeApps.filter(Boolean)) qs.append("application", a);
    get<any>(`/boards/route?${qs}`).then(setRoute).catch(() => setRoute(null));
  }, [t, artefact?.category, form.application_id, decision?.id, finding?.id]);
  const targetOk = t === "design" ? true : t === "decision" ? !!form.decision_id : t === "exception" ? !!form.finding_id : !!form.artefact_id;
  const submit = async () => {
    const body: any = { type: t, title: form.title, summary: form.summary };
    if (t === "design") { body.application_id = form.application_id || null; body.risk_tier = form.risk_tier; body.design_md = form.design_md; if ((form.patterns || []).length) body.patterns = form.patterns; }
    else if (t === "decision") body.decision_id = form.decision_id;
    else if (t === "exception") body.finding_id = form.finding_id;
    else { body.artefact_id = form.artefact_id; body.impact = form.impact; }
    try { const r: any = await post("/reviews", body); onDone(r.id); } catch (e: any) { setErr(String(e.message || e).split("\n")[0]); }
  };
  // Picking an artefact or decision pre-fills the title so the review reads as "STD-012 · TLS 1.3 everywhere".
  const pick = (key: string, id: string, list: any[]) => { const x = list.find((y) => y.id === id); setForm({ ...form, [key]: id, title: form.title || (x ? `${x.code} · ${x.title}` : ""), summary: form.summary || (x?.statement || x?.summary || "") }); };
  return (
    <Modal open size="lg" modalHeading="Submit for Review" primaryButtonText="Submit" secondaryButtonText="Cancel" primaryButtonDisabled={!form.title?.trim() || !targetOk} onRequestClose={() => setForm(null)} onRequestSubmit={submit}>
      <div className="ag-form">
        <Dropdown id="rv-type" titleText="Type" label="Choose a type" helperText={TYPE_HELP[t]} items={typeItems} itemToString={(i: any) => i?.label || ""} selectedItem={typeItems.find((i) => i.id === t)} onChange={({ selectedItem }: any) => selectedItem && setForm({ ...form, type: selectedItem.id, artefact_id: "", decision_id: "", finding_id: "" })} />
        {t === "design" && <div className="ag-row">
          <Select id="app" labelText="Application" value={form.application_id} onChange={(e) => setForm({ ...form, application_id: e.target.value })}><SelectItem value="" text="None (new application)" />{(apps || []).map((a) => <SelectItem key={a.id} value={a.id} text={a.name} />)}</Select>
          <Select id="risk" labelText="Risk Tier" helperText="The board holds the design to at least its application's criticality" value={form.risk_tier} onChange={(e) => setForm({ ...form, risk_tier: e.target.value })}>{["low", "medium", "high"].map((x) => <SelectItem key={x} value={x} text={labelFor("severity", x)} />)}</Select>
        </div>}
        {t === "design" && (patterns || []).length > 0 && <FilterableMultiSelect id="rv-patterns" titleText="Follows Adopted Patterns" placeholder="Filter patterns"
          helperText={route?.policy?.fast_lane?.enabled ? `${route.name} offers a fast lane: a low-risk design that follows ${route.policy.fast_lane.require_pattern ? "at least one adopted pattern" : "adopted patterns"} and passes every check can be declared without area positions.` : "Optional: the adopted patterns this design follows. A pattern with a rule is checked against the application."}
          items={patterns!} itemToString={(x: any) => (x ? `${x.code} · ${x.title}` : "")} selectedItems={patterns!.filter((x) => (form.patterns || []).includes(x.id))}
          onChange={({ selectedItems }: any) => setForm({ ...form, patterns: selectedItems.map((y: any) => y.id) })} />}
        {t === "decision" && <Select id="dec" labelText="Decision" value={form.decision_id} onChange={(e) => pick("decision_id", e.target.value, decisions || [])}><SelectItem value="" text={decisions ? "Choose a decision" : "Loading"} />{(decisions || []).map((d) => <SelectItem key={d.id} value={d.id} text={`${d.code} · ${d.title} (${labelFor("decision", d.status).toLowerCase()})`} />)}</Select>}
        {isArtefact && <div className="ag-row">
          <Select id="art" labelText={labelFor("review_type", t)} value={form.artefact_id} onChange={(e) => pick("artefact_id", e.target.value, artefacts || [])}><SelectItem value="" text={artefacts ? (artefacts.length ? `Choose a ${km.label.toLowerCase()}` : `No ${km.plural.toLowerCase()} in the catalogue yet`) : "Loading"} />{(artefacts || []).map((a) => <SelectItem key={a.id} value={a.id} text={`${a.code} · ${a.title}${a.lifecycle ? ` (${labelFor("lifecycle", a.lifecycle).toLowerCase()})` : ""}`} />)}</Select>
          <Select id="impact" labelText="Impact" helperText="Major changes need every approval the policy lists" value={form.impact} onChange={(e) => setForm({ ...form, impact: e.target.value })}>{["minor", "major"].map((x) => <SelectItem key={x} value={x} text={labelFor("impact", x)} />)}</Select>
        </div>}
        {t === "exception" && <Select id="fnd" labelText="Finding" value={form.finding_id} onChange={(e) => { const f = (findings || []).find((x) => x.id === e.target.value); setForm({ ...form, finding_id: e.target.value, title: form.title || (f ? `Exception: ${f.standard_code} for ${f.element_name || f.application_name}` : "") }); }}><SelectItem value="" text={findings ? (findings.length ? "Choose an open finding" : "No open findings") : "Loading"} />{(findings || []).map((f) => <SelectItem key={f.id} value={f.id} text={`${f.standard_code} · ${f.element_name || f.application_name} · ${labelFor("severity", f.severity)}`} />)}</Select>}
        <TextInput id="t" labelText="Title" placeholder="e.g. Referral API: managed document service for attachments" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        <TextArea id="sum" labelText="Summary" rows={2} value={form.summary} onChange={(e) => setForm({ ...form, summary: e.target.value })} />
        {t === "design" && <TextArea id="design" className="ag-mono-field" labelText="Design (markdown)" rows={10} value={form.design_md} onChange={(e) => setForm({ ...form, design_md: e.target.value })} />}
        {route === null ? <p className="ag-muted ag-label">The board is assigned by the server's routing rules when you submit.</p> : route?.name ? <p className="ag-body">Will be reviewed by <span className="ag-strong">{route.name}</span>{route.policy?.steps?.length ? ` · ${route.policy.steps.length} step${route.policy.steps.length === 1 ? "" : "s"} in its approval policy` : ""}.</p> : <SkeletonText width="40%" />}
        {err && <InlineNotification kind="error" lowContrast hideCloseButton title="Could not submit" subtitle={err} />}
      </div>
    </Modal>
  );
}
