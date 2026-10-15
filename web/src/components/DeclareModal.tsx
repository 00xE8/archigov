import React from "react";
import { Modal, Select, SelectItem, TextArea, TextInput, Checkbox, Button, InlineNotification, SkeletonText } from "@carbon/react";
import { Add } from "@carbon/icons-react";
import { get, labelFor, OUTCOME_HELP, OUTCOMES_NEEDING_REASON, areaLabel } from "../api";
import { DateField, useLoad, progressText } from "../components";

export type DeclareCondition = { text: string; owner: string; due_at: string; on: boolean };
export type DeclareBody = { outcome: string; rationale: string; conditions?: { text: string; owner?: string; due_at?: string }[]; circulation_due?: string; board_id?: string; reason?: string };

/** A condition row as the editor holds it; the submitter owns it unless the chair says otherwise. */
export const newCondition = (text: string, owner: string): DeclareCondition => ({ text, owner, due_at: "", on: true });
/** Outcomes an older server (no `can.declare_outcomes`) accepted from the chair. */
const LEGACY_OUTCOMES = (type: string) => (type === "design" ? ["approved", "approved_with_conditions", "rejected", "withdrawn"] : ["approved", "rejected", "withdrawn"]);

/**
 * The chair declares the outcome the positions allow. Shared by the review page and the session agenda: the caller
 * passes the review (with its `can.declare_outcomes`) or just the id, in which case the modal loads it. The outcome
 * list is the server's; each outcome carries one line of help; a reason is mandatory for sending an item back,
 * deferring, referring or rejecting; referral picks the board; circulation needs a due date.
 */
export function DeclareModal({ reviewId, review, initial, onClose, onSubmit }: { reviewId: string; review?: any; initial?: { outcome?: string; conditions?: DeclareCondition[] }; onClose: () => void; onSubmit: (body: DeclareBody) => Promise<unknown> }) {
  const [full, , loadErr] = useLoad<any>(() => (review?.can ? Promise.resolve(review) : get(`/reviews/${reviewId}`)), [reviewId]);
  const [form, setForm] = React.useState<any>(null);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const type: string = full?.type || "design";
  const outcomes: string[] = React.useMemo(() => (Array.isArray(full?.can?.declare_outcomes) ? full.can.declare_outcomes : LEGACY_OUTCOMES(type)), [full, type]);
  // Preselect only an approving outcome (or the single allowed withdrawal). When approval is not yet on the list,
  // nothing is preselected: the chair must choose to send an item back, never find it chosen for them.
  const preferred = [initial?.outcome, type === "design" ? "approved_with_conditions" : "approved", "approved"].find((o) => o && outcomes.includes(o)) || "";
  React.useEffect(() => {
    if (!full || form) return;
    const lastPre = [...(full.events || [])].reverse().find((e: any) => e.kind === "pre_review");
    const suggested: string[] = lastPre?.data?.suggested_conditions || [];
    const pick = preferred || (outcomes.length === 1 ? outcomes[0] : "");
    setForm({ outcome: pick, rationale: "", conditions: initial?.conditions ?? suggested.map((t) => newCondition(t, full.submitted_by)), circulation_due: "", board_id: "" });
  }, [full]);
  const [boards] = useLoad<any[] | null>(() => (form?.outcome === "referred" ? get<any[]>("/boards").catch(() => []) : Promise.resolve(null)), [form?.outcome === "referred"]);
  const onlyWithdraw = outcomes.length === 1 && outcomes[0] === "withdrawn";
  const needsReason = !!form && OUTCOMES_NEEDING_REASON.includes(form.outcome);
  const missingAreas: any[] = (full?.progress?.areas || []).filter((a: any) => a.state === "missing");
  const boardAreas = full?.areas?.board_areas;
  const invalid = !form || !form.outcome || (needsReason && !form.rationale.trim()) || (form.outcome === "referred" && !form.board_id) || (form.outcome === "approved_subject_to_circulation" && !form.circulation_due);
  const setCond = (i: number, patch: Partial<DeclareCondition>) => setForm({ ...form, conditions: form.conditions.map((x: DeclareCondition, k: number) => (k === i ? { ...x, ...patch } : x)) });
  const submit = async () => {
    if (invalid) return;
    const body: DeclareBody = { outcome: form.outcome, rationale: form.rationale };
    if (form.outcome === "approved_with_conditions") body.conditions = form.conditions.filter((c: DeclareCondition) => c.on && c.text.trim()).map(({ text, owner, due_at }: DeclareCondition) => ({ text, owner, due_at: due_at || undefined }));
    if (form.outcome === "approved_subject_to_circulation") body.circulation_due = form.circulation_due;
    if (form.outcome === "referred") body.board_id = form.board_id;
    if (form.outcome === "deferred") body.reason = form.rationale;
    setBusy(true); setErr(null);
    try { await onSubmit(body); onClose(); } catch (e: any) { setErr(String(e.message || e).split("\n")[0]); } finally { setBusy(false); }
  };
  const code = full?.code || review?.code || "";
  return (
    <Modal open size="lg" modalHeading={onlyWithdraw ? `Withdraw ${code}` : `Declare outcome · ${code}`} primaryButtonText={onlyWithdraw ? "Withdraw" : "Declare"} secondaryButtonText="Cancel" primaryButtonDisabled={invalid || busy} danger={form?.outcome === "rejected"} onRequestClose={onClose} onRequestSubmit={submit}>
      {loadErr && <InlineNotification kind="error" lowContrast hideCloseButton title="Could not load the review" subtitle={loadErr} />}
      {!form && !loadErr && <SkeletonText paragraph lineCount={4} />}
      {form && <div className="ag-form">
        {type !== "design" && <p className="ag-body">{type === "decision" ? "Approving accepts the decision; rejecting leaves it proposed." : type === "exception" ? "Approving grants the exception for the stated time; the finding stays visible as excepted." : `Approving adopts this ${type}: it starts producing findings at the next evaluation. Rejecting returns it to draft.`}</p>}
        {/* Why approval is not on the list, in the modal itself: which areas, approvals or assessments still hold the item up. */}
        {!outcomes.includes("approved") && !onlyWithdraw && full?.progress && !full.progress.satisfied && <p className="ag-muted ag-body">Approval is not yet available: {progressText(full.progress) || "the policy is not satisfied"}.</p>}
        {!outcomes.includes("approved") && !onlyWithdraw && ((full?.assessments || []) as any[]).some((a) => a.status === "requested") && (
          <p className="ag-muted ag-body">Assessments outstanding: {((full?.assessments || []) as any[]).filter((a) => a.status === "requested").map((a) => a.title || labelFor("assessment_type", a.type)).join(", ")} — the result must be recorded, or waived by the chair.</p>)}
        <Select id="dm-outcome" labelText="Outcome" helperText={form.outcome ? OUTCOME_HELP[form.outcome] : undefined} value={form.outcome} onChange={(e) => setForm({ ...form, outcome: e.target.value })}>
          {!preferred && outcomes.length > 1 && <SelectItem value="" text="Choose an outcome" />}
          {outcomes.map((o) => <SelectItem key={o} value={o} text={labelFor("outcome", o)} />)}
        </Select>
        {form.outcome === "approved_subject_to_circulation" && <>
          <p className="ag-body">{missingAreas.length ? <>Circulated to: {missingAreas.map((a: any) => `${areaLabel(a.area, boardAreas)}${(a.owners || []).length ? ` (${a.owners.join(", ")})` : ""}`).join(" · ")}.</> : "Every touched area already has a position; approve instead."}</p>
          <DateField id="dm-circ" labelText="Positions due by" value={form.circulation_due} onChange={(ymd) => setForm({ ...form, circulation_due: ymd })} />
        </>}
        {form.outcome === "referred" && (
          <Select id="dm-board" labelText="Refer to" value={form.board_id} onChange={(e) => setForm({ ...form, board_id: e.target.value })}>
            <SelectItem value="" text={boards ? "Choose a board" : "Loading"} />
            {(boards || []).filter((b) => b.id !== full?.board?.id).map((b) => <SelectItem key={b.id} value={b.id} text={`${b.code} · ${b.name}`} />)}
          </Select>)}
        <TextArea id="dm-rationale" labelText={needsReason ? "Reason (recorded in the audit trail)" : "Rationale (recorded in the audit trail)"} rows={3} value={form.rationale} onChange={(e) => setForm({ ...form, rationale: e.target.value })} invalid={needsReason && form.rationale.length > 0 && !form.rationale.trim()} />
        {form.outcome === "approved_with_conditions" && <div>
          <div className="ag-row between"><span className="ag-body ag-strong">Conditions</span><Button size="sm" kind="ghost" renderIcon={Add} onClick={() => setForm({ ...form, conditions: [...form.conditions, newCondition("", full?.submitted_by || "")] })}>Add Condition</Button></div>
          {form.conditions.length === 0 && <p className="ag-muted ag-body">No conditions yet. Pre-review suggestions can be added from the timeline.</p>}
          {form.conditions.map((c: DeclareCondition, i: number) => (
            <div className="ag-condition" key={i}>
              <Checkbox id={`dm-on${i}`} labelText="Include this condition" hideLabel checked={c.on} onChange={(_, { checked }) => setCond(i, { on: checked })} />
              <TextInput id={`dm-t${i}`} labelText="Condition" value={c.text} onChange={(e) => setCond(i, { text: e.target.value })} />
              <TextInput id={`dm-o${i}`} labelText="Owner" value={c.owner} onChange={(e) => setCond(i, { owner: e.target.value })} />
              <DateField id={`dm-d${i}`} labelText="Due" value={c.due_at} onChange={(ymd) => setCond(i, { due_at: ymd })} />
            </div>))}
        </div>}
        {err && <InlineNotification kind="error" lowContrast hideCloseButton title="Could not declare" subtitle={err} />}
      </div>}
    </Modal>
  );
}
