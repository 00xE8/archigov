import React from "react";
import { DataTable, Table, TableHead, TableRow, TableHeader, TableBody, TableCell, TableContainer, TableToolbar, TableToolbarContent, TableToolbarSearch, DataTableSkeleton, Select, SelectItem, Button, InlineNotification } from "@carbon/react";
import { Stamp } from "@carbon/icons-react";
import { get, fmtDate } from "../api";
import { PageIntro, useLoad, LoadError, RLink, EmptyState, useDocTitle, StatusTag, KindTag, artefactLink } from "../components";
import { ReaffirmModal } from "../components/Reaffirmation";

const headers = [{ key: "item", header: "Item" }, { key: "board", header: "Owning Board" }, { key: "last", header: "Last Outcome" }, { key: "due", header: "Reaffirm By" }, { key: "status", header: "Status" }, { key: "actions", header: "Actions" }];

/**
 * Reaffirmations across the catalogue and the decision log: every adopted standard, principle, pattern and policy and
 * every accepted decision with its reaffirm-by date, reaffirmed or sent for revision by the chair of the board that owns
 * it. Each record's own page carries the same; this is the list an auditor asks for. Nothing here is decided by the product.
 */
export default function Reaffirmations() {
  const [status, setStatus] = React.useState("");
  const [kind, setKind] = React.useState("all");
  const [data, reload, err] = useLoad<any>(() => get(`/sign-offs${status ? `?status=${status}` : ""}`), [status]);
  const [sign, setSign] = React.useState<any>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  useDocTitle("Reaffirmations");
  if (err) return <LoadError what="reaffirmations" err={err} onRetry={reload} />;
  const intro = <PageIntro title="Reaffirmations" lead="Every adopted catalogue item and accepted decision, with the date by which the chair of the board that owns it states it still holds — or that it needs revising."
    about={`A reaffirmation approves nothing: approval is the board's review, and the Decision Log records what was decided. This is the periodic check that it is still true. A catalogue item is due ${data ? data.cadence_months.artefact : 12} months after its adoption, a decision ${data ? data.cadence_months.decision : 24} months after it was decided, and a full cadence after each reaffirmation; a revision brings it back in three months. Due soon means within 30 days. The chair of the board that owns it — the board its review type routes to — reaffirms it here or on the record's own page, and the due and overdue ones are in that chair's work queue.`} />;
  if (!data) return <>{intro}<DataTableSkeleton headers={headers} rowCount={6} showHeader={false} /></>;
  const items = data.items.filter((x: any) => kind === "all" || x.subject.kind === kind);
  const rows = items.map((x: any) => ({ id: `${x.subject.kind}:${x.subject.id}`, item: `${x.subject.code} ${x.subject.title}`, board: x.board?.name || "", last: x.last?.signed_at || "", due: x.due, status: x.status, actions: "" }));
  const byId = new Map(items.map((x: any) => [`${x.subject.kind}:${x.subject.id}`, x]));
  const linkOf = (s: any) => (s.kind === "decision" ? `/decisions/${s.id}` : artefactLink(s.id));
  return (
    <>
      {intro}
      {msg && <InlineNotification kind="success" lowContrast className="ag-notice" title={msg} onCloseButtonClick={() => setMsg(null)} />}
      {items.length === 0 && !status && kind === "all" ? <EmptyState title="Nothing to reaffirm yet">Adopted catalogue items and accepted decisions appear here with the date they are due for reaffirmation.</EmptyState> : (
        <DataTable rows={rows} headers={headers} isSortable>
          {({ rows, headers, getHeaderProps, getRowProps, getTableProps, onInputChange }: any) => (
            <TableContainer>
              <TableToolbar><TableToolbarContent>
                <div className="ag-toolbar-filters">
                  <Select id="ra-status" labelText="Status" inline value={status} onChange={(e) => setStatus(e.target.value)}>
                    <SelectItem value="" text="All" /><SelectItem value="overdue" text="Overdue" /><SelectItem value="due_soon" text="Due soon" /><SelectItem value="current" text="In date" /><SelectItem value="revision_needed" text="Revision needed" />
                  </Select>
                  <Select id="ra-kind" labelText="Kind" inline value={kind} onChange={(e) => setKind(e.target.value)}><SelectItem value="all" text="All" /><SelectItem value="artefact" text="Catalogue items" /><SelectItem value="decision" text="Decisions" /></Select>
                </div>
                <TableToolbarSearch onChange={onInputChange} placeholder="e.g. STD-001" persistent />
              </TableToolbarContent></TableToolbar>
              <Table {...getTableProps()} size="md">
                <TableHead><TableRow>{headers.map((h: any) => <TableHeader {...getHeaderProps({ header: h, isSortable: h.key !== "actions" })} key={h.key}>{h.header}</TableHeader>)}</TableRow></TableHead>
                <TableBody>{rows.length === 0 ? <TableRow><TableCell colSpan={headers.length}><span className="ag-muted">Nothing matches these filters.</span></TableCell></TableRow> : rows.map((r: any) => { const x: any = byId.get(r.id); return (
                  <TableRow {...getRowProps({ row: r })} key={r.id}>
                    <TableCell><div className="ag-row tight"><KindTag kind="kind" value={x.subject.type} /><RLink to={linkOf(x.subject)}>{x.subject.code}</RLink></div><div className="ag-label">{x.subject.title}</div></TableCell>
                    <TableCell>{x.board ? <RLink to={`/boards/${x.board.id}`}>{x.board.name}</RLink> : <span className="ag-muted">—</span>}</TableCell>
                    <TableCell>{x.last ? <><div className="ag-row tight"><StatusTag kind="signoff_outcome" value={x.last.outcome} /></div><div className="ag-muted ag-label">{fmtDate(x.last.signed_at)} · {x.last.signed_by_name || x.last.signed_by}</div>{x.last.note && <div className="ag-muted ag-label ag-wrap">{x.last.note}</div>}</> : <span className="ag-muted ag-label">Not reaffirmed yet · {x.subject.kind === "decision" ? "decided" : "adopted"} {fmtDate(x.subject.since)}</span>}</TableCell>
                    <TableCell>{fmtDate(x.due)}</TableCell>
                    <TableCell><StatusTag kind="signoff_status" value={x.status} /></TableCell>
                    <TableCell>{x.can_sign ? <Button size="sm" kind="ghost" renderIcon={Stamp} onClick={() => setSign(x)}>Reaffirm</Button> : <span className="ag-muted ag-label" title={x.board ? `The chair of ${x.board.name} reaffirms this.` : undefined}>{x.board ? "Chair only" : "—"}</span>}</TableCell>
                  </TableRow>); })}</TableBody>
              </Table>
            </TableContainer>)}
        </DataTable>)}
      {sign && <ReaffirmModal x={sign} months={sign.subject.kind === "decision" ? data.cadence_months.decision : data.cadence_months.artefact} onClose={() => setSign(null)} onDone={(t) => { setSign(null); setMsg(t); reload(); }} />}
    </>
  );
}
