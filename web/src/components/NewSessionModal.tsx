import React from "react";
import { Modal, Select, SelectItem, TextInput, TimePicker, InlineNotification } from "@carbon/react";
import { post, toYMD } from "../api";
import { DateField } from "../components";

export type SessionBoard = { id: string; code?: string; name: string };

/**
 * Plan a sitting of a board. Shared by the board page (board fixed) and the Sessions list (board picked here):
 * the server derives the agenda from the reviews routed to that board. Only the chair or secretary may plan one;
 * the caller decides who sees the button, the server refuses anyone else.
 */
export function NewSessionModal({ boards, boardId, onClose, onCreated }: { boards: SessionBoard[]; boardId?: string; onClose: () => void; onCreated: (session: any) => void }) {
  const [board, setBoard] = React.useState(boardId || (boards.length === 1 ? boards[0].id : ""));
  const [form, setForm] = React.useState(() => { const d = new Date(); d.setDate(d.getDate() + 7); return { date: toYMD(d), time: "10:00", title: "" }; });
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const timeOk = /^([01]\d|2[0-3]):[0-5]\d$/.test(form.time);
  const ok = !!board && /^\d{4}-\d{2}-\d{2}$/.test(form.date) && timeOk;
  const chosen = boards.find((b) => b.id === board);
  const submit = async () => {
    if (!ok) return;
    setBusy(true); setErr(null);
    try { const s: any = await post(`/boards/${board}/sessions`, { scheduled_at: new Date(`${form.date}T${form.time}:00`).toISOString(), title: form.title.trim() || undefined }); onCreated(s); }
    catch (e: any) { setErr(String(e.message || e).split("\n")[0]); } finally { setBusy(false); }
  };
  return (
    <Modal open modalHeading="New Session" primaryButtonText="Plan Session" secondaryButtonText="Cancel" primaryButtonDisabled={!ok || busy} onRequestClose={onClose} onRequestSubmit={submit}>
      <div className="ag-form">
        <p className="ag-body">The agenda is derived when the session is planned: every review routed to the board that is still open, ready items first, then the most deferred. Refresh it later to pick up new submissions.</p>
        {!boardId && (
          <Select id="ses-board" labelText="Board" value={board} onChange={(e) => setBoard(e.target.value)}>
            <SelectItem value="" text={boards.length ? "Choose a board" : "No board you chair or run"} />
            {boards.map((b) => <SelectItem key={b.id} value={b.id} text={b.code ? `${b.code} · ${b.name}` : b.name} />)}
          </Select>)}
        <div className="ag-filters">
          <DateField id="ses-date" labelText="Date" value={form.date} onChange={(ymd) => setForm({ ...form, date: ymd })} />
          <TimePicker id="ses-time" labelText="Time (24-hour)" placeholder="hh:mm" pattern="([01]\d|2[0-3]):[0-5]\d" value={form.time} invalid={!!form.time && !timeOk} invalidText="Use hh:mm, for example 10:00" onChange={(e) => setForm({ ...form, time: e.target.value })} />
        </div>
        <TextInput id="ses-title" labelText="Title (optional)" placeholder={`e.g. ${chosen?.name || "Design Authority"} — fortnightly`} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        {err && <InlineNotification kind="error" lowContrast hideCloseButton title="Could not plan the session" subtitle={err} />}
      </div>
    </Modal>
  );
}
