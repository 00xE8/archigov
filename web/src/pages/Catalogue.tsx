import React from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { ContentSwitcher, Switch, DataTable, Table, TableHead, TableRow, TableHeader, TableBody, TableCell, TableContainer, TableToolbar, TableToolbarContent, Search, DataTableSkeleton, Button, Modal, TextInput, TextArea, Select, SelectItem, CodeSnippet, OverflowMenu, OverflowMenuItem, MenuButton, MenuItem, InlineNotification, InlineLoading, SkeletonText } from "@carbon/react";
import { Add, Download, MachineLearningModel } from "@carbon/icons-react";
import { get, post, put, download, labelFor, ARTEFACT_KINDS, REVIEW_TYPES, kindOfCode } from "../api";
import { PageIntro, useLoad, useAiFeatures, SeverityTag, Empty, LoadError, RLink, StatusTag, VerificationTag, VerifyButton, FindingEvidence, EmptyState, PackImporter, KindTag, artefactLink, useDocTitle } from "../components";
import { Gated, useCan } from "../auth";
import { ReaffirmationPanel, ReaffirmModal } from "../components/Reaffirmation";

const KIND_TABS = ["all", ...ARTEFACT_KINDS.map((k) => k.kind)];
const RULE_EXAMPLE = '{"scope":"resource","match":{"type":"Microsoft.KeyVault/vaults"},"assert":{"path":"props.enablePurgeProtection","op":"eq","value":true}}';
const CSV_EXAMPLE = "kind,title,category,statement,rationale,control_refs,rule_json,enforcement\npolicy,Production data stays in UK regions,Hosting,All production workloads run in UK regions.,UK GDPR Art.44,\"UK GDPR Art.44; DSPT 2025 A1.a\",,mandatory";
const JSON_EXAMPLE = '[\n  { "kind": "principle", "title": "Evidence, not assurance", "category": "Principle", "statement": "The repository records what was decided and on what evidence.", "control_refs": ["TOGAF Architecture Governance"] }\n]';

// The catalogue API; an older server only has /standards, which is the same shape with every row a standard.
const loadArtefacts = async (): Promise<any[]> => {
  try { return await get<any[]>("/artefacts"); }
  catch { const list = await get<any[]>("/standards"); return list.map((s) => ({ ...s, kind: s.kind || kindOfCode(s.code), lifecycle: s.lifecycle || "adopted", version: s.version || 1, legacy: true })); }
};
const loadOne = (id: string) => get<any>(`/artefacts/${id}`).catch(() => get<any>(`/standards/${id}`).then((s) => ({ ...s, kind: s.kind || kindOfCode(s.code), lifecycle: s.lifecycle || "adopted", legacy: true })));
const matches = (s: any, q: string) => !q || [s.code, s.title, s.category, ...(s.control_refs || [])].join(" ").toLowerCase().includes(q.toLowerCase());
const kindMeta = (kind: string) => ARTEFACT_KINDS.find((k) => k.kind === kind) || ARTEFACT_KINDS[0];
const hasRadar = (kind: string) => kind === "standard" || kind === "pattern";

export default function Catalogue() {
  const [list, reload, err] = useLoad<any[]>(loadArtefacts);
  const [boards] = useLoad<any[]>(() => get<any[]>("/boards").catch(() => []));
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const openId = params.get("open");
  const q = params.get("q") || "";
  const kind = KIND_TABS.includes(params.get("kind") || "") ? (params.get("kind") as string) : "all";
  const [lifecycle, setLifecycle] = React.useState("all");
  const [detail, reloadDetail] = useLoad<any>(() => (openId ? loadOne(openId) : Promise.resolve(null)), [openId]);
  const [preview, , previewErr] = useLoad<any>(() => (openId ? get<any>(`/artefacts/${openId}/preview`) : Promise.resolve(null)), [openId]);
  const [edit, setEdit] = React.useState<any>(null);
  const [ruleError, setRuleError] = React.useState<string | null>(null);
  // AI drafting in the editor: shown only when the platform admin has switched the feature on
  const aiOn = useAiFeatures();
  const [aiBusy, setAiBusy] = React.useState<string | null>(null);
  const [aiNote, setAiNote] = React.useState<string | null>(null);
  const [importing, setImporting] = React.useState<"pack" | "csv" | "json" | null>(null);
  const [retire, setRetire] = React.useState<any>(null);
  // Reaffirming from the item: the detail modal steps aside for the reaffirm modal and returns after (modals never nest).
  const [reaffirm, setReaffirm] = React.useState(false);
  const [msg, setMsg] = React.useState<{ kind: "success" | "error" | "warning"; text: string } | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const canManage = useCan("manage_artefacts");
  useDocTitle(openId && detail ? detail.code : "Governance Catalogue");
  if (err) return <LoadError what="the catalogue" err={err} onRetry={reload} />;
  if (!list) return <DataTableSkeleton columnCount={8} rowCount={8} showHeader={false} showToolbar />;
  const setParam = (k: string, v: string) => { const n = new URLSearchParams(params); if (v && v !== "all") n.set(k, v); else n.delete(k); setParams(n, { replace: true }); };
  const legacy = list.some((s) => s.legacy);
  const byKind = (k: string) => list.filter((s) => k === "all" || s.kind === k);
  const visible = byKind(kind).filter((s) => matches(s, q) && (lifecycle === "all" || (s.lifecycle || "adopted") === lifecycle));
  const boardName = (id?: string | null) => (id ? (boards || []).find((b) => b.id === id)?.name || "—" : "—");
  const meta = kindMeta(kind === "all" ? "standard" : kind);
  const setRuleText = (ruleText: string) => { setEdit({ ...edit, ruleText }); if (ruleError) setRuleError(null); };
  const newArtefact = (k = kind === "all" ? "standard" : kind) => { setRuleError(null); setEdit({ kind: k, title: "", category: k === "principle" ? "Principle" : "Security", statement: "", rationale: "", status: "adopt", severity: "medium", control_refs: "", ruleText: "", enforcement: "mandatory", context: "", solution: "", applicability: "" }); };
  const editArtefact = (a: any) => { setRuleError(null); setEdit({ ...a, control_refs: (a.control_refs || []).join(", "), ruleText: a.rule ? JSON.stringify(a.rule, null, 2) : "", enforcement: a.enforcement || "mandatory", context: a.context || "", solution: a.solution || "", applicability: a.applicability || "" }); };
  const run = async (key: string, fn: () => Promise<any>, ok: (r: any) => string) => { setBusy(key); setMsg(null); try { const r = await fn(); setMsg({ kind: "success", text: ok(r) }); reload(); if (openId) reloadDetail(); } catch (e: any) { setMsg({ kind: "error", text: String(e.message || e).split("\n")[0] }); } finally { setBusy(null); } };
  const submitForReview = async (a: any) => {
    setBusy(`review-${a.id}`); setMsg(null);
    try { const r: any = await post("/reviews", { type: a.kind, artefact_id: a.id, title: `${a.code} · ${a.title}`, summary: a.statement, impact: "minor" }); nav(`/reviews/${r.id}`); }
    catch (e: any) { setMsg({ kind: "error", text: String(e.message || e).split("\n")[0] }); setBusy(null); }
  };
  const refLink = (c: string) => <RLink key={c} to={`/governance?q=${encodeURIComponent(c)}`}>{c}</RLink>;
  // Three references in the row; the rest are counted, and named on hover.
  const refs = (list: string[]) => { const shown = list.slice(0, 3); const rest = list.slice(3); return <span className="ag-refs">{shown.map((c) => <span key={c}>{refLink(c)}</span>)}{rest.length > 0 && <span className="ag-more" title={rest.join(" · ")}>+{rest.length}</span>}</span>; };
  // Six columns: the item gets the width, and its state (severity · lifecycle · verification) is one cluster.
  const headers = [{ key: "code", header: "Code" }, { key: "title", header: kind === "all" ? "Item" : meta.label }, { key: "severity", header: "Status" }, { key: "open_findings", header: "Open Findings" }, { key: "controls", header: "Control References" }, { key: "actions", header: "Actions" }];
  const rows = visible.map((s) => ({ id: s.id, code: s.code, title: s.title, severity: s.severity, open_findings: s.open_findings, controls: (s.control_refs || []).join(", "), actions: "" }));
  return (
    <>
      <PageIntro title="Governance Catalogue" lead="Standards, principles, patterns and policies: the human statements the estate is checked against."
        about="Each item is a human statement with control references and, where it can be, a checkable rule evaluated continuously against the derived model. Every kind is reviewed by a board before it is adopted, and only adopted items produce findings."
        actions={<>
          <Gated cap="import_artefacts"><MenuButton label="Import" kind="tertiary" size="md" menuAlignment="bottom-end">
            <MenuItem label="Import a Pack" onClick={() => setImporting("pack")} />
            <MenuItem label="Import CSV" onClick={() => setImporting("csv")} />
            <MenuItem label="Import JSON" onClick={() => setImporting("json")} />
            <MenuItem label="Import an ArchiMate Model…" onClick={() => nav("/settings?tab=import")} />
          </MenuButton></Gated>
          <Gated cap="manage_artefacts"><Button size="md" renderIcon={Add} onClick={() => newArtefact()}>New {kind === "all" ? "catalogue item" : meta.label.toLowerCase()}</Button></Gated>
        </>} />
      {msg && <InlineNotification kind={msg.kind} lowContrast title={msg.text} onCloseButtonClick={() => setMsg(null)} className="ag-notice" />}
      {legacy && <InlineNotification kind="info" lowContrast hideCloseButton className="ag-notice" title="This server only knows standards" subtitle="Kinds, lifecycle, boards and reviews of catalogue items need the current server; everything here is shown as an adopted standard." />}

      {/* A filter over one table, not tabbed content, so a ContentSwitcher: Tabs without TabPanels point aria-controls at panels that do not exist. */}
      <ContentSwitcher className="ag-kind-switcher" selectedIndex={KIND_TABS.indexOf(kind)} onChange={({ index }: any) => setParam("kind", KIND_TABS[index ?? 0])}>
        {[<Switch key="all" name="all" text={`All (${list.length})`} />, ...ARTEFACT_KINDS.map((k) => <Switch key={k.kind} name={k.kind} text={`${k.plural} (${byKind(k.kind).length})`} />)]}
      </ContentSwitcher>
      {kind !== "all" && <p className="ag-muted ag-body ag-kind-blurb ag-mt-03">{meta.description} Codes are {meta.prefix}-nnn.</p>}

      {list.length === 0 ? (
        <>
          <EmptyState title="The catalogue is empty" actions={<Gated cap="manage_artefacts"><Button size="md" renderIcon={Add} onClick={() => newArtefact("standard")}>New Standard</Button></Gated>}>
            Without standards, principles, patterns and policies, conformance, pre-review and evidence packs have nothing to check against. Start with a pack:
          </EmptyState>
          <section className="ag-section ag-mt-05"><h3>Starter Packs</h3><PackImporter onImported={reload} /></section>
        </>
      ) : (
      <DataTable rows={rows} headers={headers} isSortable>
        {({ rows, headers, getHeaderProps, getRowProps, getTableProps }: any) => (
          <TableContainer>
            <TableToolbar><TableToolbarContent>
              <div className="ag-toolbar-filters"><Select id="cat-life" labelText="Lifecycle" inline value={lifecycle} onChange={(e) => setLifecycle(e.target.value)}><SelectItem value="all" text="All" />{["draft", "in_review", "adopted", "retired"].map((l) => <SelectItem key={l} value={l} text={labelFor("lifecycle", l)} />)}</Select></div>
              <Search id="cat-q" size="lg" labelText="Filter the catalogue" placeholder="e.g. STD-003, POL-001 or ISO 27001 A.8.20" value={q} onChange={(e) => setParam("q", e.target.value)} onClear={() => setParam("q", "")} />
            </TableToolbarContent></TableToolbar>
            <Table {...getTableProps()} size="md">
              <TableHead><TableRow>{headers.map((h: any) => <TableHeader {...getHeaderProps({ header: h })} key={h.key} className={h.key === "controls" ? "ag-col-refs" : h.key === "title" ? "ag-col-item" : h.key === "code" ? "ag-col-code" : undefined}>{h.header}</TableHeader>)}</TableRow></TableHead>
              <TableBody>{rows.length === 0 ? <TableRow><TableCell colSpan={headers.length}><span className="ag-muted">Nothing matches these filters.</span></TableCell></TableRow> : rows.map((r: any) => { const s = list.find((x) => x.id === r.id)!; const draft = (s.lifecycle || "adopted") === "draft"; const adopted = (s.lifecycle || "adopted") === "adopted"; return (
                <TableRow {...getRowProps({ row: r })} key={r.id}>
                  {/* The code with its kind beside it; the kind tag is only needed when kinds are mixed. */}
                  <TableCell><div className="ag-row tight"><RLink to={`${artefactLink(s.id)}${q ? `&q=${encodeURIComponent(q)}` : ""}`}>{s.code}</RLink>{kind === "all" && <KindTag kind="kind" value={s.kind} />}</div></TableCell>
                  {/* Classification (category, radar / enforcement, version, board) is plain text under the title; colour is kept for the status cluster. */}
                  <TableCell className="ag-col-item">{s.title}<div className="ag-muted ag-label">{[s.category, hasRadar(s.kind) ? labelFor("radar", s.status) : s.kind === "policy" ? labelFor("enforcement", s.enforcement || "mandatory") : "", s.rule ? "Rule" : "Manual", s.version ? `v${s.version}` : "", s.board_id ? boardName(s.board_id) : ""].filter(Boolean).join(" · ")}</div></TableCell>
                  {/* Status is for exceptions here: "adopted" and "human verified" are the catalogue's norm and say nothing on
                      every row, so the list shows only drafts/in-review/retired, the items nobody has verified and the ones
                      overdue for reaffirmation or sent for revision; the open modal keeps the full set. (The same selectivity
                      as Conformance, where verified is the exception shown.) */}
                  <TableCell><div className="ag-row tight"><SeverityTag s={s.severity} />{(s.lifecycle || "adopted") !== "adopted" && <StatusTag kind="lifecycle" value={s.lifecycle} />}{(s.verification || "unverified") !== "verified" && <VerificationTag state={s.verification || "unverified"} origin={s.origin} />}{s.reaffirmation?.status === "overdue" && <StatusTag kind="signoff_status" value="overdue" label="Reaffirmation overdue" />}{s.reaffirmation?.revision_needed && <StatusTag kind="signoff_outcome" value="revision_needed" />}</div></TableCell>
                  <TableCell><div className="ag-row tight">{s.open_findings ? <StatusTag kind="finding" value="open" label={`${s.open_findings} open`} /> : <span className="ag-muted">0</span>}{s.excepted ? <StatusTag kind="finding" value="excepted" label={`${s.excepted} excepted`} /> : null}</div></TableCell>
                  <TableCell>{(s.control_refs || []).length ? refs(s.control_refs) : <span className="ag-muted">—</span>}</TableCell>
                  <TableCell>{busy === `review-${s.id}` ? <InlineLoading description="Creating review" /> : canManage && !s.legacy ? (
                    <OverflowMenu aria-label={`Actions for ${s.code}`} size="sm" flipped>
                      <OverflowMenuItem itemText="Open" onClick={() => setParam("open", s.id)} />
                      {draft && <OverflowMenuItem itemText="Submit for review" onClick={() => submitForReview(s)} />}
                      <OverflowMenuItem itemText="Edit" onClick={() => editArtefact(s)} />
                      {adopted && <OverflowMenuItem itemText="Retire" isDelete onClick={() => setRetire(s)} />}
                    </OverflowMenu>) : <span className="ag-muted">—</span>}</TableCell>
                </TableRow>); })}</TableBody>
            </Table>
          </TableContainer>)}
      </DataTable>)}

      <Modal open={!!openId && !reaffirm} passiveModal size="lg" modalHeading={detail ? `${detail.code} · ${detail.title}` : "Loading"} onRequestClose={() => setParam("open", "")}>
        {!detail ? <SkeletonText paragraph lineCount={6} /> : (
          <div>
            <div className="ag-row snug ag-mb-05">
              <KindTag kind="kind" value={detail.kind} size="md" /><StatusTag kind="lifecycle" value={detail.lifecycle || "adopted"} /><SeverityTag s={detail.severity} />
              <span className="ag-muted">{hasRadar(detail.kind) ? `${labelFor("radar", detail.status)} · ` : detail.kind === "policy" ? `${labelFor("enforcement", detail.enforcement || "mandatory")} · ` : ""}{detail.category} · owner {detail.owner || "—"}{detail.version ? ` · version ${detail.version}` : ""}{detail.board_id ? ` · ${boardName(detail.board_id)}` : ""}</span>
              <VerificationTag state={detail.verification || "unverified"} origin={detail.origin} by={detail.verified_by} at={detail.verified_at} />
              <VerifyButton size="sm" path={detail.legacy ? `/standards/${detail.id}/verify` : `/artefacts/${detail.id}/verify`} state={detail.verification || "unverified"} onDone={() => { reloadDetail(); reload(); }} />
              {!detail.legacy && <>
                <Gated cap="manage_artefacts" mode="hide"><Button size="sm" kind="ghost" onClick={() => editArtefact(detail)}>Edit</Button></Gated>
                {(detail.lifecycle || "adopted") === "draft" && <Gated cap="manage_artefacts" mode="hide"><Button size="sm" kind="tertiary" disabled={busy === `review-${detail.id}`} onClick={() => submitForReview(detail)}>Submit for Review</Button></Gated>}
                {detail.review_id && (detail.lifecycle === "in_review") && <RLink to={`/reviews/${detail.review_id}`}>Open the review</RLink>}
                {(detail.lifecycle || "adopted") === "adopted" && <Gated cap="manage_artefacts" mode="hide"><Button size="sm" kind="danger--ghost" onClick={() => setRetire(detail)}>Retire</Button></Gated>}
              </>}
            </div>
            <dl className="ag-kv">
              <dt>Statement</dt><dd>{detail.statement}</dd>
              <dt>Rationale</dt><dd>{detail.rationale || "—"}</dd>
              {detail.kind === "pattern" && <><dt>Context</dt><dd>{detail.context || "—"}</dd><dt>Solution</dt><dd>{detail.solution || "—"}</dd><dt>Applicability</dt><dd>{detail.applicability || "—"}</dd></>}
              {detail.kind === "policy" && <><dt>Enforcement</dt><dd>{labelFor("enforcement", detail.enforcement || "mandatory")}</dd></>}
              <dt>Control references</dt><dd className="ag-row tight">{(detail.control_refs || []).length ? detail.control_refs.map((c: string) => refLink(c)) : "—"}</dd>
              <dt>Checkable rule</dt><dd>{detail.rule ? <CodeSnippet type="multi" feedback="Copied">{JSON.stringify(detail.rule, null, 2)}</CodeSnippet> : <span className="ag-muted">Manual: evidenced through reviews, not evaluated automatically.</span>}</dd>
              {detail.rule_error && <><dt>Rule error</dt><dd><StatusTag kind="run" value="error" label={detail.rule_error} /></dd></>}
            </dl>
            {detail.reaffirmation && <div className="ag-mt-06"><ReaffirmationPanel r={detail.reaffirmation} heading="h3" onReaffirm={() => setReaffirm(true)} /></div>}
            {!detail.legacy && <section className="ag-section ag-mt-06"><h3>Pre-review Preview</h3>
              {preview ? <PreviewPanel p={preview} /> : previewErr ? <p className="ag-muted ag-body">The preview is not available on this server.</p> : <SkeletonText paragraph lineCount={2} />}
            </section>}
            <h3>Findings ({(detail.findings || []).length})</h3>
            {(detail.findings || []).length === 0 ? <Empty>No current findings.</Empty> : (
              <Table size="sm"><TableHead><TableRow><TableHeader>Application</TableHeader><TableHeader>Element</TableHeader><TableHeader>Evidence</TableHeader><TableHeader>Status</TableHeader></TableRow></TableHead>
                <TableBody>{detail.findings.map((f: any) => <TableRow key={f.id}><TableCell><RLink to={`/applications/${f.application_id}`}>{f.application_name}</RLink></TableCell><TableCell>{f.element_name}</TableCell><TableCell><FindingEvidence e={f.evidence} /></TableCell><TableCell><StatusTag kind="finding" value={f.status} /></TableCell></TableRow>)}</TableBody></Table>)}
            {(detail.exceptions || []).length > 0 && <><h3>Exceptions</h3>{detail.exceptions.map((e: any) => <div className="ag-finding" key={e.id}><div className="ag-row snug"><span className="title">{e.application_name}</span><StatusTag kind="exception" value={e.status} /></div><div className="detail">{e.reason}</div></div>)}</>}
          </div>)}
      </Modal>

      {reaffirm && detail?.reaffirmation && <ReaffirmModal x={detail.reaffirmation} months={detail.reaffirmation.cadence_months} onClose={() => setReaffirm(false)} onDone={(t) => { setReaffirm(false); setMsg({ kind: "success", text: t }); reloadDetail(); reload(); }} />}

      <Modal open={importing === "pack"} passiveModal size="lg" modalHeading="Import a Pack" onRequestClose={() => setImporting(null)}>
        <p className="ag-body ag-muted ag-mb-05">Packs are versioned content with control references only — never a framework's own text. Importing adds the items you do not already have and leaves existing ones untouched; imported items start as drafts unless the pack says otherwise.</p>
        <PackImporter onImported={reload} />
      </Modal>
      {importing === "csv" && <TextImport title="Import CSV" kind="csv" example={CSV_EXAMPLE} onClose={() => setImporting(null)} onDone={reload} />}
      {importing === "json" && <TextImport title="Import JSON" kind="json" example={JSON_EXAMPLE} onClose={() => setImporting(null)} onDone={reload} />}

      <Modal open={!!retire} danger modalHeading={retire ? `Retire ${retire.code}?` : ""} primaryButtonText="Retire" secondaryButtonText="Cancel" onRequestClose={() => setRetire(null)}
        onRequestSubmit={() => { const a = retire; setRetire(null); run(`retire-${a.id}`, () => post(`/artefacts/${a.id}/retire`), () => `${a.code} retired · it no longer produces findings`); }}>
        <p className="ag-body">A retired item stops being evaluated and stays on record with its history. Findings it produced are resolved at the next evaluation; nothing is deleted.</p>
      </Modal>

      <Modal open={!!edit} modalHeading={edit?.id ? `Edit ${edit.code}` : `New ${labelFor("kind", edit?.kind).toLowerCase()}`} primaryButtonText={edit?.id && (edit.lifecycle || "adopted") === "adopted" ? "Save as new draft version" : "Save"} secondaryButtonText="Cancel" size="lg" onRequestClose={() => setEdit(null)}
        onRequestSubmit={async () => {
          let rule: any = null;
          if (edit.ruleText?.trim()) { try { rule = JSON.parse(edit.ruleText); } catch { setRuleError(`Enter valid JSON, e.g. ${RULE_EXAMPLE}`); return; } }
          const body: any = { kind: edit.kind, title: edit.title, category: edit.category, statement: edit.statement, rationale: edit.rationale, status: hasRadar(edit.kind) ? edit.status : "adopt", severity: edit.severity, rule, control_refs: String(edit.control_refs).split(",").map((s: string) => s.trim()).filter(Boolean) };
          if (edit.kind === "policy") body.enforcement = edit.enforcement;
          if (edit.kind === "pattern") { body.context = edit.context; body.solution = edit.solution; body.applicability = edit.applicability; }
          const id = edit.id; const legacyRow = !!edit.legacy;
          await run(id ? `save-${id}` : "save", async () => (id ? put(legacyRow ? `/standards/${id}` : `/artefacts/${id}`, body) : post(legacyRow || legacy ? "/standards" : "/artefacts", body)), (r: any) => (id ? `${edit.code} saved${(edit.lifecycle || "adopted") === "adopted" && !legacyRow ? " as a new draft version — submit it for review to adopt it" : ""}` : `${r?.code || "Item"} created as a draft`));
          setEdit(null);
        }}>
        {edit && <div className="ag-form">
          {!edit.id && <Select id="kind" labelText="Kind" helperText={kindMeta(edit.kind).description} value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value })}>{ARTEFACT_KINDS.map((k) => <SelectItem key={k.kind} value={k.kind} text={k.label} />)}</Select>}
          {edit.id && (edit.lifecycle || "adopted") === "adopted" && !edit.legacy && <InlineNotification kind="info" lowContrast hideCloseButton title="Editing an adopted item creates a new draft version" subtitle="The adopted version keeps producing findings until the new draft has been reviewed and adopted." />}
          <TextInput id="t" labelText="Title" value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
          <div className="ag-row">
            <TextInput id="c" labelText="Category" value={edit.category} onChange={(e) => setEdit({ ...edit, category: e.target.value })} />
            {hasRadar(edit.kind) && <Select id="st" labelText="Radar status" value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })}>{["adopt", "trial", "assess", "hold", "retire"].map((s) => <SelectItem key={s} value={s} text={labelFor("radar", s)} />)}</Select>}
            {edit.kind === "policy" && <Select id="enf" labelText="Enforcement" value={edit.enforcement} onChange={(e) => setEdit({ ...edit, enforcement: e.target.value })}>{["mandatory", "recommended"].map((s) => <SelectItem key={s} value={s} text={labelFor("enforcement", s)} />)}</Select>}
            <Select id="sev" labelText="Severity" value={edit.severity} onChange={(e) => setEdit({ ...edit, severity: e.target.value })}>{["critical", "high", "medium", "low"].map((s) => <SelectItem key={s} value={s} text={labelFor("severity", s)} />)}</Select>
          </div>
          <TextArea id="s" labelText="Statement" value={edit.statement} onChange={(e) => setEdit({ ...edit, statement: e.target.value })} rows={2} />
          <TextArea id="r" labelText="Rationale" value={edit.rationale || ""} onChange={(e) => setEdit({ ...edit, rationale: e.target.value })} rows={2} />
          {edit.kind === "pattern" && <>
            <TextArea id="ctx" labelText="Context" helperText="The recurring situation this pattern addresses" value={edit.context} onChange={(e) => setEdit({ ...edit, context: e.target.value })} rows={2} />
            <TextArea id="sol" labelText="Solution" helperText="The proven arrangement, in enough detail to apply it" value={edit.solution} onChange={(e) => setEdit({ ...edit, solution: e.target.value })} rows={3} />
            <TextInput id="app" labelText="Applicability" placeholder="e.g. Internet-facing APIs handling patient data" value={edit.applicability} onChange={(e) => setEdit({ ...edit, applicability: e.target.value })} />
          </>}
          <TextInput id="cr" labelText="Control references (comma separated)" placeholder="e.g. ISO 27001 A.8.27, DORA Art.8, DSPT 2025 B2.a" value={edit.control_refs} onChange={(e) => setEdit({ ...edit, control_refs: e.target.value })} />
          {/* AI proposes, the author saves, a board adopts: references append for the author to prune; a drafted rule lands in the field with its validation and blast radius said out loud. */}
          {aiOn.suggest_references && edit.title && edit.statement && <div><Button size="sm" kind="ghost" renderIcon={MachineLearningModel} disabled={aiBusy === "refs"} onClick={async () => {
            setAiBusy("refs"); setAiNote(null);
            try { const r: any = await post("/artefacts/suggest-references", { kind: edit.kind, title: edit.title, statement: edit.statement, category: edit.category || undefined });
              const have = new Set(String(edit.control_refs).split(",").map((s: string) => s.trim()).filter(Boolean));
              const add = r.references.map((x: any) => x.ref).filter((ref: string) => !have.has(ref));
              setEdit((cur: any) => ({ ...cur, control_refs: [...have, ...add].join(", ") }));
              setAiNote(add.length ? `AI suggested ${add.length} reference${add.length === 1 ? "" : "s"} (${r.model}) — verify each against the framework before saving: ${r.references.map((x: any) => `${x.ref} (${x.why})`).join("; ")}` : "AI suggested nothing new.");
            } catch (e: any) { setAiNote(String(e.message || e).split("\n")[0]); } finally { setAiBusy(null); }
          }}>Suggest References with AI</Button></div>}
          <TextArea id="rule" className="ag-mono-field" labelText="Checkable rule (JSON, optional)" helperText={edit.kind === "principle" ? "Principles are usually manual; a rule is allowed when one can be stated." : `Example: ${RULE_EXAMPLE}`} invalid={!!ruleError} invalidText={ruleError || ""} value={edit.ruleText} onChange={(e) => setRuleText(e.target.value)} rows={6} />
          {aiOn.draft_rule && edit.title && edit.statement && <div><Button size="sm" kind="ghost" renderIcon={MachineLearningModel} disabled={aiBusy === "rule"} onClick={async () => {
            setAiBusy("rule"); setAiNote(null); setRuleError(null);
            try { const r: any = await post("/artefacts/draft-rule", { kind: edit.kind, title: edit.title, statement: edit.statement, category: edit.category || undefined });
              if (r.rule) setEdit((cur: any) => ({ ...cur, ruleText: JSON.stringify(r.rule, null, 2) }));
              setAiNote(r.validation.ok
                ? `AI draft rule (${r.model}) · valid · would raise ${r.impact.findings} finding${r.impact.findings === 1 ? "" : "s"} across ${r.impact.applications} application${r.impact.applications === 1 ? "" : "s"} today · ${r.rationale} Verify before saving; adoption still goes through a board.`
                : `AI could not produce a valid rule: ${r.validation.error}${r.rationale ? ` · ${r.rationale}` : ""}`);
            } catch (e: any) { setAiNote(String(e.message || e).split("\n")[0]); } finally { setAiBusy(null); }
          }}>Draft Rule with AI</Button></div>}
          {aiBusy && <InlineLoading description="Asking the model" />}
          {aiNote && <p className="ag-muted ag-label ag-wrap">{aiNote}</p>}
        </div>}
      </Modal>
    </>
  );
}

/** What a reviewer would see before adopting the item: validity checks and the findings the rule would raise today. */
function PreviewPanel({ p }: { p: any }) {
  const checks: any[] = p.checks || [];
  const impact = p.impact || {};
  return (
    <div className="ag-stack">
      {checks.length === 0 ? <p className="ag-muted ag-body">No checks reported.</p> : checks.map((c, i) => (
        <div className="ag-row snug" key={i}><StatusTag kind="precheck" value={c.state} label={`${labelFor("precheck", c.state)} · ${c.name}`} />{c.detail && <span className="ag-muted ag-label">{c.detail}</span>}</div>))}
      <p className="ag-body">{typeof impact.findings === "number" ? <>If adopted now, the rule would raise <span className="ag-strong">{impact.findings}</span> finding{impact.findings === 1 ? "" : "s"} across {impact.applications ?? 0} application{impact.applications === 1 ? "" : "s"}.</> : <span className="ag-muted">No rule to dry-run.</span>}</p>
      {Array.isArray(impact.sample) && impact.sample.length > 0 && (
        <Table size="sm"><TableHead><TableRow><TableHeader>Element</TableHeader><TableHeader>Application</TableHeader><TableHeader>Finding</TableHeader></TableRow></TableHead>
          <TableBody>{impact.sample.map((s: any, i: number) => <TableRow key={i}><TableCell>{s.element_name}</TableCell><TableCell>{s.application_name}</TableCell><TableCell>{s.message}</TableCell></TableRow>)}</TableBody></Table>)}
    </div>
  );
}

/** CSV or JSON paste-import of catalogue items; every row becomes a draft. */
function TextImport({ title, kind, example, onClose, onDone }: { title: string; kind: "csv" | "json"; example: string; onClose: () => void; onDone: () => void }) {
  const [text, setText] = React.useState("");
  const [res, setRes] = React.useState<any>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      if (kind === "csv") setRes(await post("/import/csv", { kind: "artefacts", csv: text }));
      else { let items: any; try { items = JSON.parse(text); if (!Array.isArray(items)) throw new Error(); } catch { setErr("Enter a JSON array of items, like the example."); return; } setRes(await post("/import/artefacts", items)); }
      onDone();
    } catch (e: any) { setErr(String(e.message || e).split("\n")[0]); } finally { setBusy(false); }
  };
  return (
    <Modal open size="lg" modalHeading={title} primaryButtonText={res ? "Done" : "Import"} secondaryButtonText="Cancel" primaryButtonDisabled={!res && (!text.trim() || busy)} onRequestClose={onClose} onRequestSubmit={() => (res ? onClose() : submit())}>
      <div className="ag-form">
        <p className="ag-body">Each row or item has a kind (standard, principle, pattern, policy), a title, category, statement and control references, optionally a rule. Everything imported starts as a draft: it has no effect until a board adopts it.</p>
        {kind === "csv" && <div><Button size="sm" kind="ghost" renderIcon={Download} onClick={() => download("/import/templates/csv?kind=artefacts", "archigov-artefacts-template.csv").catch((e) => setErr(String(e.message || e)))}>Download Template</Button></div>}
        <TextArea id="ti-text" className="ag-mono-field" labelText={kind === "csv" ? "CSV" : "JSON array"} rows={10} placeholder={`e.g. ${example}`} value={text} onChange={(e) => { setText(e.target.value); setErr(null); }} invalid={!!err} invalidText={err || undefined} />
        {busy && <InlineLoading description="Importing" />}
        {res && <InlineNotification kind={res.errors?.length ? "warning" : "success"} lowContrast hideCloseButton title={`Imported: ${res.created ?? res.imported ?? 0} new, ${res.updated ?? 0} updated, ${res.unchanged ?? res.skipped ?? 0} unchanged`} subtitle={res.errors?.length ? `${res.errors.length} row${res.errors.length === 1 ? "" : "s"} had problems` : undefined} />}
        {res?.errors?.length ? <Table size="sm"><TableHead><TableRow><TableHeader>Line</TableHeader><TableHeader>Problem</TableHeader></TableRow></TableHead><TableBody>{res.errors.map((e: any, i: number) => <TableRow key={i}><TableCell>{e.line}</TableCell><TableCell>{e.message}</TableCell></TableRow>)}</TableBody></Table> : null}
      </div>
    </Modal>
  );
}

export { REVIEW_TYPES };
