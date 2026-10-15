import React from "react";
import { DataTable, Button, Modal, RadioButtonGroup, RadioButton, TextArea, InlineNotification, Stack, Table, TableHead, TableRow, TableHeader, TableBody, TableCell } from "@carbon/react";
import { Stamp } from "@carbon/icons-react";
import { post, fmtDate } from "../api";
import { StatusTag, RLink } from "../components";

/** What a reaffirmation is about, and the board whose chair makes it. */
export interface ReaffirmTarget { subject: { kind: "artefact" | "decision"; id: string; code: string; title: string }; board?: { id: string; name: string } | null }

/**
 * The owning chair's statement that an adopted catalogue item or accepted decision still holds, or needs revising.
 * It moves the reaffirm-by date and is recorded under the chair's name; it approves and changes nothing — approval is
 * the board's review, and a revision is drafted by an author and adopted through one.
 */
export function ReaffirmModal({ x, months, onClose, onDone }: { x: ReaffirmTarget; months: number; onClose: () => void; onDone: (text: string) => void }) {
  const [outcome, setOutcome] = React.useState("reaffirmed");
  const [note, setNote] = React.useState("");
  const [err, setErr] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const revise = outcome === "revision_needed";
  const save = async () => {
    setBusy(true); setErr(null);
    try { await post("/sign-offs", { subject_kind: x.subject.kind, subject_id: x.subject.id, outcome, note: note.trim() || null }); onDone(`${x.subject.code} ${revise ? "marked as needing revision" : "reaffirmed"}`); }
    catch (e: any) { setErr(String(e.message || e)); } finally { setBusy(false); }
  };
  return (
    <Modal open modalHeading={`Reaffirm or Revise ${x.subject.code}`} primaryButtonText={busy ? "Recording…" : revise ? "Ask for Revision" : "Reaffirm"} secondaryButtonText="Cancel"
      primaryButtonDisabled={busy || (revise && note.trim().length < 10)} onRequestClose={onClose} onRequestSubmit={save}>
      <Stack gap={5}>
        <p className="ag-body">{x.subject.title}. As the chair of the {x.board?.name || "owning board"}, you state whether it still holds. This is recorded under your name in the audit log; it does not approve or change the {x.subject.kind === "decision" ? "decision" : "item"}.</p>
        <RadioButtonGroup legendText="Outcome" name="ra-outcome" valueSelected={outcome} onChange={(v) => setOutcome(String(v))} orientation="vertical">
          <RadioButton id="ra-reaffirmed" value="reaffirmed" labelText={`Reaffirm — it still holds; next reaffirmation in ${months} months`} />
          <RadioButton id="ra-revision" value="revision_needed" labelText="Revision needed — it comes back for reaffirmation in three months" />
        </RadioButtonGroup>
        <TextArea id="ra-note" labelText={revise ? "What needs revising" : "Note (optional)"} rows={3} value={note} onChange={(e) => setNote(e.target.value)}
          invalid={revise && note.trim().length > 0 && note.trim().length < 10} invalidText="At least 10 characters."
          helperText={revise ? "Say what should change, so an author can draft the revision for the board." : "Anything the next chair to reaffirm it should know."} />
        {err && <InlineNotification kind="error" lowContrast hideCloseButton title="Not recorded" subtitle={err} />}
      </Stack>
    </Modal>
  );
}

/**
 * A record's reaffirmation on its own page: in date or not, the reaffirm-by date, the board whose chair reaffirms it,
 * and every reaffirmation so far. The owning chair's Reaffirm calls onReaffirm and the host opens ReaffirmModal — the
 * catalogue swaps it for its own detail modal, because modals never nest.
 */
export function ReaffirmationPanel({ r, heading = "h2", onReaffirm }: { r: any; heading?: "h2" | "h3"; onReaffirm: () => void }) {
  const H = heading;
  const decision = r.subject.kind === "decision";
  return (
    <section className="ag-section">
      <div className="ag-row between"><H>Reaffirmation</H>{r.can_sign && <Button size="sm" kind="tertiary" renderIcon={Stamp} onClick={onReaffirm}>Reaffirm</Button>}</div>
      <div className="ag-row snug ag-mb-03">
        <StatusTag kind="signoff_status" value={r.status} />
        {r.revision_needed && <StatusTag kind="signoff_outcome" value="revision_needed" />}
        <span className="ag-body">Reaffirm by {fmtDate(r.due)}</span>
        {r.board && <span className="ag-muted ag-label">· the chair of <RLink inline to={`/boards/${r.board.id}`}>{r.board.name}</RLink></span>}
      </div>
      <p className="ag-muted ag-label ag-mb-03">Every {r.cadence_months} months the chair of the owning board states that this {decision ? "decision" : "item"} still holds, or that it needs revising. A reaffirmation approves nothing: approval is the board's review.</p>
      {r.history.length === 0 ? <p className="ag-muted ag-body">Not reaffirmed yet · {decision ? "decided" : "adopted"} {fmtDate(r.subject.since)}.</p> : <History r={r} />}
    </section>
  );
}

const HISTORY_HEADERS = [{ key: "outcome", header: "Outcome" }, { key: "by", header: "By" }, { key: "date", header: "Date" }, { key: "note", header: "Note" }];
function History({ r }: { r: any }) {
  const rows = r.history.map((h: any, i: number) => ({ id: String(i), outcome: h.outcome, by: h.signed_by_name || h.signed_by, date: h.signed_at, note: h.note || "" }));
  return (
    <DataTable rows={rows} headers={HISTORY_HEADERS} size="sm">
      {({ rows, headers, getHeaderProps, getRowProps, getTableProps }: any) => (
        <Table {...getTableProps()} aria-label={`Reaffirmations of ${r.subject.code}`}>
          <TableHead><TableRow>{headers.map((h: any) => <TableHeader {...getHeaderProps({ header: h })} key={h.key}>{h.header}</TableHeader>)}</TableRow></TableHead>
          <TableBody>{rows.map((row: any) => { const h = r.history[Number(row.id)]; return (
            <TableRow {...getRowProps({ row })} key={row.id}>
              <TableCell><StatusTag kind="signoff_outcome" value={h.outcome} /></TableCell>
              <TableCell>{h.signed_by_name || h.signed_by}</TableCell>
              <TableCell className="ag-nowrap">{fmtDate(h.signed_at)}</TableCell>
              <TableCell className="ag-wrap">{h.note || <span className="ag-muted">—</span>}</TableCell>
            </TableRow>); })}</TableBody>
        </Table>)}
    </DataTable>
  );
}
