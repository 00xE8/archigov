import React from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { DataTable, Table, TableHead, TableRow, TableHeader, TableBody, TableCell, TableContainer, TableToolbar, TableToolbarContent, TableToolbarSearch, DataTableSkeleton, Button, Select, SelectItem } from "@carbon/react";
import { Calendar } from "@carbon/icons-react";
import { get, fmtDateTime, normaliseSeat } from "../api";
import { PageIntro, useLoad, LoadError, RLink, StatusTag, EmptyState, KindTag, useDocTitle } from "../components";
import { Gated, useAuth } from "../auth";
import { NewSessionModal } from "../components/NewSessionModal";

const headers = [{ key: "code", header: "Code" }, { key: "board", header: "Board" }, { key: "scheduled_at", header: "Date" }, { key: "status", header: "Status" }, { key: "items", header: "Items" }, { key: "declared", header: "Declared / deferred" }, { key: "my_role", header: "My Seat" }];
const STATUSES = ["planned", "open", "closed"];
const ORDER: Record<string, number> = { open: 0, planned: 1, closed: 2 };
const ABOUT = "A session is one sitting of a board. Its agenda is derived from the reviews routed to that board, decision makers record positions for the areas they own (or delegate their seat for the sitting), the chair declares the outcome the positions allow, and the minutes are derived and hashed on close. Sessions are planned from a board by its chair or secretary.";

/** Every session across boards: what is open now, what is next, what was held. Planning one still belongs to a board's chair or secretary. */
export default function Sessions() {
  const { me } = useAuth();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const status = params.get("status") || "all";
  const board = params.get("board") || "all";
  // The whole list, filtered here: it is short, and an older server only filters on one exact status.
  const [list, reload, err] = useLoad<any[]>(() => get("/sessions"));
  const [boards] = useLoad<any[]>(() => get<any[]>("/boards").catch(() => []));
  const [modal, setModal] = React.useState(false);
  const setParam = (k: string, v: string) => { const n = new URLSearchParams(params); if (v && v !== "all") n.set(k, v); else n.delete(k); setParams(n, { replace: true }); };
  useDocTitle("Board Sessions");
  if (err) return <LoadError what="sessions" err={err} onRetry={reload} />;
  if (!list) return <DataTableSkeleton headers={headers} rowCount={5} showHeader={false} showToolbar />;
  const seats = me?.user?.boards || [];
  const seatOn = (b: any) => seats.find((x) => x.id === b?.id || (b?.code && x.code === b.code))?.role;
  const myRole = (s: any) => s.my_role || seatOn(s.board) || (s.board_id ? seats.find((x) => x.id === s.board_id)?.role : undefined);
  // Boards this person may plan a session for: the board says so, or the seat does.
  const plannable = (boards || []).filter((b) => b.can?.sessions === true || ["chair", "secretary"].includes(normaliseSeat(seatOn(b) || "")));
  const visible = list
    .filter((s) => (status === "all" || s.status === status) && (board === "all" || s.board?.id === board || s.board_id === board))
    .sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) || (a.status === "closed" ? String(b.scheduled_at).localeCompare(String(a.scheduled_at)) : String(a.scheduled_at).localeCompare(String(b.scheduled_at))));
  const rows = visible.map((s) => ({ id: s.id, code: s.code, board: s.board?.name || "", scheduled_at: s.scheduled_at, status: s.status, items: s.items ?? 0, declared: `${s.declared ?? 0} / ${s.deferred ?? 0}`, my_role: myRole(s) || "" }));
  const newButton = <Gated cap="manage_board" allowed={plannable.length > 0} reason="Needs the chair or secretary of a board"><Button size="md" renderIcon={Calendar} onClick={() => setModal(true)}>New Session</Button></Gated>;
  return (
    <>
      <PageIntro title="Board Sessions" lead="Every sitting of every board: open now, planned next, and the record of those held." about={ABOUT} actions={newButton} />
      {list.length === 0 ? (
        <EmptyState title="No sessions yet" actions={newButton}>
          Sessions are planned from a board by its chair or secretary; the agenda is derived from the reviews routed to that board. Once one exists it is listed here with its date, state and your seat.
        </EmptyState>
      ) : (
        <DataTable rows={rows} headers={headers} isSortable>
          {({ rows, headers, getHeaderProps, getRowProps, getTableProps, onInputChange }: any) => (
            <TableContainer>
              <TableToolbar><TableToolbarContent>
                <div className="ag-toolbar-filters">
                  <Select id="ses-status" labelText="Status" inline value={status} onChange={(e) => setParam("status", e.target.value)}>{STATUSES.map((s) => <SelectItem key={s} value={s} text={s === "planned" ? "Planned" : s === "open" ? "Open" : "Closed"} />)}<SelectItem value="all" text="All" /></Select>
                  {(boards || []).length > 0 && <Select id="ses-board" labelText="Board" inline value={board} onChange={(e) => setParam("board", e.target.value)}><SelectItem value="all" text="All" />{boards!.map((b) => <SelectItem key={b.id} value={b.id} text={b.name} />)}</Select>}
                </div>
                <TableToolbarSearch onChange={onInputChange} placeholder="e.g. SES-0002" persistent />
              </TableToolbarContent></TableToolbar>
              <Table {...getTableProps()} size="md">
                <TableHead><TableRow>{headers.map((h: any) => <TableHeader {...getHeaderProps({ header: h })} key={h.key}>{h.header}</TableHeader>)}</TableRow></TableHead>
                <TableBody>{rows.length === 0 ? <TableRow><TableCell colSpan={headers.length}><span className="ag-muted">No sessions match these filters.</span></TableCell></TableRow> : rows.map((r: any) => { const s = visible.find((x) => x.id === r.id)!; const role = myRole(s); return (
                  <TableRow {...getRowProps({ row: r })} key={r.id}>
                    <TableCell><RLink to={`/sessions/${s.id}`}>{s.code}</RLink>{s.title ? <div className="ag-muted ag-label">{s.title}</div> : null}</TableCell>
                    <TableCell>{s.board?.id ? <RLink to={`/boards/${s.board.id}`}>{s.board.name || s.board.code}</RLink> : s.board?.name || <span className="ag-muted">—</span>}</TableCell>
                    <TableCell className="ag-nowrap">{fmtDateTime(s.scheduled_at)}</TableCell>
                    <TableCell><StatusTag kind="session_status" value={s.status} /></TableCell>
                    <TableCell>{s.items ?? <span className="ag-muted">—</span>}{s.consent_count ? <div className="ag-muted ag-label">{s.consent_count} on consent</div> : null}</TableCell>
                    <TableCell>{typeof s.declared === "number" || typeof s.deferred === "number" ? `${s.declared ?? 0} / ${s.deferred ?? 0}` : <span className="ag-muted">—</span>}</TableCell>
                    <TableCell>{role ? <KindTag kind="board_role" value={role} /> : <span className="ag-muted">—</span>}</TableCell>
                  </TableRow>); })}</TableBody>
              </Table>
            </TableContainer>)}
        </DataTable>)}
      {modal && <NewSessionModal boards={plannable.map((b) => ({ id: b.id, code: b.code, name: b.name }))} onClose={() => setModal(false)} onCreated={(s) => { setModal(false); if (s?.id) nav(`/sessions/${s.id}`); else reload(); }} />}
    </>
  );
}
