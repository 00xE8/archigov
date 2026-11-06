import React from "react";
import { Button, InlineNotification, Modal, Select, SelectItem, TextInput } from "@carbon/react";
import { post, fmtDate } from "../api";
import { StatusTag } from "../components";

/**
 * A condition of an approval, raised as a work item in Azure DevOps. From the moment it exists the work is the delivery
 * team's: this shows what the source last said of it and links there. Closing the work item is evidence that the team
 * considers the work done; whether the condition is met stays a board's judgment, recorded with Mark Met.
 */
export function RaisedWorkItem({ raised, compact }: { raised: any; compact?: boolean }) {
  if (!raised) return <span className="ag-muted">—</span>;
  if (!raised.external_id) return <span className="ag-muted ag-label" title={raised.error || undefined}>Asked for; Azure DevOps has not confirmed it</span>;
  const note = raised.gone ? "No longer in Azure DevOps" : raised.closed ? `Closed ${fmtDate(raised.closed_at)}; the board confirms the condition` : null;
  return (
    <span className="ag-row tight">
      <a className="cds--link ag-nowrap" href={raised.url} target="_blank" rel="noreferrer" title={`${raised.title || "Work item"} · opens in Azure DevOps`}>{raised.type || "Work item"} {raised.external_id}</a>
      {!raised.gone && raised.state && <StatusTag kind="work" value={raised.state} size="sm" />}
      {note && !compact && <span className="ag-muted ag-label">{note}</span>}
    </span>
  );
}

/** What the work item would be called unless the person raising it says otherwise (the server uses the same words). */
const defaultTitle = (review: any, condition: any) => `Condition of ${review.code}: ${String(condition.text).replace(/\s+/g, " ").trim()}`.slice(0, 255);

/**
 * The confirmation for raising one condition: it says exactly what will be created and where, and what that does and
 * does not mean, before anything is sent. One work item per condition; asking again never makes a second.
 */
export function RaiseConditionModal({ review, condition, onClose, onDone }: { review: any; condition: any; onClose: () => void; onDone: () => void }) {
  const parents: any[] = review.raise?.parents || [];
  const type: string = review.raise?.type || "Work item";
  const [title, setTitle] = React.useState(() => defaultTitle(review, condition));
  // a request already made keeps the place it was made for
  const [parent, setParent] = React.useState<string>(condition.raised?.parent_work_item_id || (parents.length === 1 ? parents[0].id : ""));
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // asked for earlier with no answer: the request is kept as it was sent, so its title and place are no longer open
  const [unconfirmed, setUnconfirmed] = React.useState(!!condition.raised && !condition.raised.external_id);
  const under = parents.find((p) => p.id === parent);
  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const r: any = await post(`/conditions/${condition.id}/raise`, { title: title.trim() || undefined, work_item_id: parent || undefined });
      if (r?.unconfirmed) { setUnconfirmed(true); onDone(); return; }
      onDone(); onClose();
    } catch (e: any) { setError(String(e.message || e).split("\n")[0]); }
    finally { setBusy(false); }
  };
  return (
    <Modal open modalHeading="Raise in Azure DevOps" primaryButtonText={busy ? "Creating…" : unconfirmed ? "Check Again" : `Create ${type}`} secondaryButtonText={unconfirmed ? "Close" : "Cancel"}
      primaryButtonDisabled={busy || (!unconfirmed && (!title.trim() || !parent))} onRequestClose={onClose} onRequestSubmit={submit}>
      <div className="ag-form">
        <p className="ag-body">Creates one {type} in Azure DevOps{under ? <> under {under.type} {under.external_id}</> : null}, linked back to {review.code}. From then on the delivery team owns it: archigov does not change it again, and reads its state back. Closing it tells the board the work is done; the board still confirms here that the condition is met.</p>
        <div><div className="ag-label ag-muted">Condition</div><div className="ag-body">{condition.text}</div></div>
        {parents.length > 1 && (
          <Select id="raise-parent" labelText="Under" helperText="This review covers several work items: choose the one this condition belongs to." value={parent} onChange={(e) => setParent(e.target.value)} disabled={unconfirmed}>
            <SelectItem value="" text="Choose a work item" />
            {parents.map((p) => <SelectItem key={p.id} value={p.id} text={`${p.type} ${p.external_id} · ${p.title}`} />)}
          </Select>)}
        <TextInput id="raise-title" labelText="Title" helperText="As the delivery team will see it. The work item's description carries the condition in the board's words." maxLength={255} value={title}
          invalid={!title.trim()} invalidText="A work item needs a title." onChange={(e) => setTitle(e.target.value)} disabled={unconfirmed} />
        {unconfirmed && <InlineNotification kind="warning" lowContrast hideCloseButton title="Azure DevOps did not answer" subtitle="The work item may have been created all the same. Check Again looks for it first, so it is never created twice." />}
        {error && <InlineNotification kind="error" lowContrast hideCloseButton title="Not raised" subtitle={error} />}
      </div>
    </Modal>
  );
}

/** Whether the raise action is shown for a condition: to whoever may raise it, while it is open and not yet a work item, on an instance that has Azure DevOps at all. */
export const canRaise = (review: any, condition: any) => !!condition.can_raise && !!review.raise && review.raise.connected !== false
  && !condition.raised?.external_id && ["open", "overdue"].includes(condition.status);

/** The row action: greyed with the reason while raising is off or not possible for this review. */
export function RaiseButton({ review, condition, onRaise, Gated }: { review: any; condition: any; onRaise: () => void; Gated: React.ComponentType<any> }) {
  if (!canRaise(review, condition)) return null;
  return <Gated cap="comment" allowed={!!review.raise.available} reason={review.raise.reason}><Button size="sm" kind="ghost" onClick={onRaise}>{condition.raised ? "Check Again" : "Raise in Azure DevOps"}</Button></Gated>;
}
