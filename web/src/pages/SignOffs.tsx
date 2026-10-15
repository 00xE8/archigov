import React from "react";
import { DataTable, Table, TableHead, TableRow, TableHeader, TableBody, TableCell, TableContainer, TableToolbar, TableToolbarContent, TableToolbarSearch, DataTableSkeleton, Select, SelectItem, Button, Modal, RadioButtonGroup, RadioButton, TextArea, InlineNotification, Stack } from "@carbon/react";
import { Stamp } from "@carbon/icons-react";
import { get, post, fmtDate } from "../api";
import { PageIntro, useLoad, LoadError, RLink, EmptyState, useDocTitle, StatusTag, KindTag, artefactLink } from "../components";

const headers = [{ key: "item", header: "Item" }, { key: "board", header: "Owning Board" }, { key: "last", header: "Last Sign-off" }, { key: "due", header: "Next Review" }, { key: "status", header: "Status" }, { key: "actions", header: "Actions" }];

/**
 * Review dates and periodic sign-offs: every adopted standard, principle, pattern and policy and every accepted
 * decision has a next review date, and the chair of the board that owns it reaffirms it or asks for a revision. A
 * sign-off is a named person's statement; nothing here is decided by the product.
 */
export default function SignOffs() {
  const [status, setStatus] = React.useState("");
  const [kind, setKind] = React.useState("all");
  const [data, reload, err] = useLoad<any>(() => get(`/sign-offs${status ? `?status=${status}` : ""}`), [status]);
  const [sign, setSign] = React.useState<any>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  useDocTitle("Sign-offs");
  if (err) return <LoadError what="sign-offs" err={err} onRetry={reload} />;
  const intro = <PageIntro title="Sign-offs" lead="Every adopted catalogue item and accepted decision, with its next review date — reaffirmed or sent for revision by the chair of the board that owns it."
    about={`A catalogue item comes up for review ${data ? data.cadence_months.artefact : 12} months after its adoption, a decision ${data ? data.cadence_months.decision : 24} months after it was decided, and then a full cadence after each reaffirmation. A revision brings it back in three months. Due soon means within 30 days. The chair of the board that owns it — the board its review type routes to — signs it off, and the due and overdue ones are in that chair's work queue.`} />;
  if (!data) return <>{intro}<DataTableSkeleton headers={headers} rowCount={6} showHeader={false} /></>;
  const items = data.items.filter((x: any) => kind === "all" || x.subject.kind === kind);
  const rows = items.map((x: any) => ({ id: `${x.subject.kind}:${x.subject.id}`, item: `${x.subject.code} ${x.subject.title}`, board: x.board?.name || "", last: x.last?.signed_at || "", due: x.due, status: x.status, actions: "" }));
  const byId = new Map(items.map((x: any) => [`${x.subject.kind}:${x.subject.id}`, x]));
  const linkOf = (s: any) => (s.kind === "decision" ? `/decisions/${s.id}` : artefactLink(s.id));
  return (
    <>
      {intro}
      {msg && <InlineNotification kind="success" lowContrast className="ag-notice" title={msg} onCloseButtonClick={() => setMsg(null)} />}
      {items.length === 0 && !status && kind === "all" ? <EmptyState title="Nothing to sign off yet">Adopted catalogue items and accepted decisions appear here with their next review date.</EmptyState> : (
        <DataTable rows={rows} headers={headers} isSortable>
          {({ rows, headers, getHeaderProps, getRowProps, getTableProps, onInputChange }: any) => (
            <TableContainer>
              <TableToolbar><TableToolbarContent>
                <div className="ag-toolbar-filters">
                  <Select id="so-status" labelText="Status" inline value={status} onChange={(e) => setStatus(e.target.value)}>
                    <SelectItem value="" text="All" /><SelectItem value="overdue" text="Overdue" /><SelectItem value="due_soon" text="Due soon" /><SelectItem value="current" text="In date" /><SelectItem value="revision_needed" text="Revision needed" />
                  </Select>
                  <Select id="so-kind" labelText="Kind" inline value={kind} onChange={(e) => setKind(e.target.value)}><SelectItem value="all" text="All" /><SelectItem value="artefact" text="Catalogue items" /><SelectItem value="decision" text="Decisions" /></Select>
                </div>
                <TableToolbarSearch onChange={onInputChange} placeholder="e.g. STD-001" persistent />
              </TableToolbarContent></TableToolbar>
              <Table {...getTableProps()} size="md">
                <TableHead><TableRow>{headers.map((h: any) => <TableHeader {...getHeaderProps({ header: h, isSortable: h.key !== "actions" })} key={h.key}>{h.header}</TableHeader>)}</TableRow></TableHead>
                <TableBody>{rows.length === 0 ? <TableRow><TableCell colSpan={headers.length}><span className="ag-muted">Nothing matches these filters.</span></TableCell></TableRow> : rows.map((r: any) => { const x: any = byId.get(r.id); return (
                  <TableRow {...getRowProps({ row: r })} key={r.id}>
                    <TableCell><div className="ag-row tight"><KindTag kind="kind" value={x.subject.type} /><RLink to={linkOf(x.subject)}>{x.subject.code}</RLink></div><div className="ag-label">{x.subject.title}</div></TableCell>
                    <TableCell>{x.board ? <RLink to={`/boards/${x.board.id}`}>{x.board.name}</RLink> : <span className="ag-muted">—</span>}</TableCell>
                    <TableCell>{x.last ? <><div className="ag-row tight"><StatusTag kind="signoff_outcome" value={x.last.outcome} /></div><div className="ag-muted ag-label">{fmtDate(x.last.signed_at)} · {x.last.signed_by_name || x.last.signed_by}</div>{x.last.note && <div className="ag-muted ag-label ag-wrap">{x.last.note}</div>}</> : <span className="ag-muted ag-label">Never · {x.subject.kind === "decision" ? "decided" : "adopted"} {fmtDate(x.subject.since)}</span>}</TableCell>
                    <TableCell>{fmtDate(x.due)}</TableCell>
                    <TableCell><StatusTag kind="signoff_status" value={x.status} /></TableCell>
                    <TableCell>{x.can_sign ? <Button size="sm" kind="ghost" renderIcon={Stamp} onClick={() => setSign(x)}>Sign Off</Button> : <span className="ag-muted ag-label" title={x.board ? `The chair of ${x.board.name} signs this off.` : undefined}>{x.board ? "Chair only" : "—"}</span>}</TableCell>
                  </TableRow>); })}</TableBody>
              </Table>
            </TableContainer>)}
        </DataTable>)}
      {sign && <SignModal x={sign} months={sign.subject.kind === "decision" ? data.cadence_months.decision : data.cadence_months.artefact} onClose={() => setSign(null)} onDone={(t) => { setSign(null); setMsg(t); reload(); }} />}
    </>
  );
}

function SignModal({ x, months, onClose, onDone }: { x: any; months: number; onClose: () => void; onDone: (text: string) => void }) {
  const [outcome, setOutcome] = React.useState("reaffirmed");
  const [note, setNote] = React.useState("");
  const [err, setErr] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const needsNote = outcome === "revision_needed";
  const save = async () => { setBusy(true); setErr(null); try { await post("/sign-offs", { subject_kind: x.subject.kind, subject_id: x.subject.id, outcome, note: note.trim() || null }); onDone(`${x.subject.code} ${outcome === "reaffirmed" ? "reaffirmed" : "marked for revision"}`); } catch (e: any) { setErr(String(e.message || e)); } finally { setBusy(false); } };
  return (
    <Modal open modalHeading={`Sign Off ${x.subject.code}`} primaryButtonText={busy ? "Signing…" : "Sign Off"} secondaryButtonText="Cancel" primaryButtonDisabled={busy || (needsNote && note.trim().length < 10)} onRequestClose={onClose} onRequestSubmit={save}>
      <Stack gap={5}>
        <p className="ag-body">{x.subject.title}. As the chair of the {x.board?.name}, you state whether it still holds. The sign-off is recorded under your name in the audit log.</p>
        <RadioButtonGroup legendText="Outcome" name="so-outcome" valueSelected={outcome} onChange={(v) => setOutcome(String(v))} orientation="vertical">
          <RadioButton id="so-reaffirmed" value="reaffirmed" labelText={`Reaffirm — it still holds; next review in ${months} months`} />
          <RadioButton id="so-revision" value="revision_needed" labelText="Revision needed — it comes back for sign-off in three months" />
        </RadioButtonGroup>
        <TextArea id="so-note" labelText={needsNote ? "What needs revising" : "Note (optional)"} rows={3} value={note} onChange={(e) => setNote(e.target.value)}
          invalid={needsNote && note.trim().length > 0 && note.trim().length < 10} invalidText="At least 10 characters." helperText={needsNote ? "Say what should change, so an author can draft the revision." : "Anything the next reviewer should know."} />
        {err && <InlineNotification kind="error" lowContrast hideCloseButton title="Not signed off" subtitle={err} />}
      </Stack>
    </Modal>
  );
}
