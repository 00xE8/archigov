import React from "react";
import { Modal, TextInput, TextArea, Select, SelectItem, FilterableMultiSelect, InlineNotification, Stack, SkeletonText } from "@carbon/react";
import { get, post, put, labelFor } from "../api";
import { DateField, useLoad } from "../components";

const SEVERITIES = ["low", "medium", "high", "critical"];
const STATUSES = ["open", "accepted", "mitigated", "closed"];

/** Log a risk — on its own, or as one a decision accepts (decision set), perhaps from an AI suggestion (origin ai_assisted). */
export function LogRiskModal({ decision, initial, onClose, onDone }: { decision?: { id: string; code: string } | null; initial?: { title?: string; description?: string; severity?: string; origin?: "human" | "ai_assisted" }; onClose: () => void; onDone: (r: any) => void }) {
  const [users] = useLoad<any[]>(() => get<any[]>("/users").catch(() => []));
  const [apps] = useLoad<any[]>(() => (decision ? Promise.resolve([]) : get<any[]>("/applications").catch(() => [])));
  const [f, setF] = React.useState({ title: initial?.title || "", description: initial?.description || "", severity: initial?.severity || "medium", owner: "", review_by: "", application_ids: [] as string[] });
  const [err, setErr] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const owners = (users || []).filter((u) => u.user_type !== "auditor" && u.user_type !== "service" && !(u.is_platform_admin && !u.user_type));
  const save = async () => { setBusy(true); setErr(null); try { onDone(await post("/risks", { ...f, owner: f.owner || null, review_by: f.review_by || null, decision_id: decision?.id ?? null, application_ids: f.application_ids, origin: initial?.origin || "human" })); } catch (e: any) { setErr(String(e.message || e)); } finally { setBusy(false); } };
  return (
    <Modal open modalHeading={decision ? `Risk Accepted by ${decision.code}` : "Log Risk"} primaryButtonText={busy ? "Logging…" : "Log Risk"} secondaryButtonText="Cancel" primaryButtonDisabled={busy || f.title.trim().length < 5} onRequestClose={onClose} onRequestSubmit={save}>
      {!users ? <SkeletonText paragraph lineCount={5} /> : <Stack gap={5}>
        {initial?.origin === "ai_assisted" && <p className="ag-muted ag-label">Suggested by AI from the decision's text. Check it holds before you log it; it is recorded as AI-assisted and as yours.</p>}
        {decision && <p className="ag-body">Its standing follows {decision.code}: proposed while the decision is proposed, accepted once it is, withdrawn if it is rejected or superseded.</p>}
        <TextInput id="rk-title" labelText="Title" placeholder="e.g. Single-region writes for admissions" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} invalid={f.title.trim().length > 0 && f.title.trim().length < 5} invalidText="At least 5 characters." maxLength={200} />
        <TextArea id="rk-desc" labelText="Description (optional)" rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} helperText="What could go wrong, and what it would affect." />
        <div className="ag-row">
          <Select id="rk-sev" labelText="Severity" value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })}>{SEVERITIES.map((s) => <SelectItem key={s} value={s} text={labelFor("severity", s)} />)}</Select>
          <Select id="rk-owner" labelText="Owner" value={f.owner} onChange={(e) => setF({ ...f, owner: e.target.value })} helperText="Defaults to you."><SelectItem value="" text="Me" />{owners.map((u) => <SelectItem key={u.id} value={u.id} text={u.name || u.id} />)}</Select>
          <DateField id="rk-review" labelText="Review By (optional)" value={f.review_by} onChange={(v) => setF({ ...f, review_by: v })} helperText="When the owner looks at it again." />
        </div>
        {!decision && apps && apps.length > 0 && <FilterableMultiSelect id="rk-apps" titleText="Applications (optional)" placeholder="Filter applications" items={apps} itemToString={(a: any) => (a ? a.name : "")} selectedItems={apps.filter((a) => f.application_ids.includes(a.id))} onChange={({ selectedItems }: any) => setF({ ...f, application_ids: selectedItems.map((a: any) => a.id) })} />}
        {err && <InlineNotification kind="error" lowContrast hideCloseButton title="Not logged" subtitle={err} />}
      </Stack>}
    </Modal>
  );
}

/** Change a risk: its status (mitigated or closed needs a note), severity, owner and review date. Only its owner or whoever logged it. */
export function UpdateRiskModal({ risk, onClose, onDone }: { risk: any; onClose: () => void; onDone: (r: any) => void }) {
  const [users] = useLoad<any[]>(() => get<any[]>("/users").catch(() => []));
  const [f, setF] = React.useState({ status: STATUSES.includes(risk.stored_status) ? risk.stored_status : "open", severity: risk.severity, owner: risk.owner || "", review_by: risk.review_by || "", note: "" });
  const [err, setErr] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const needsNote = (f.status === "closed" || f.status === "mitigated") && f.status !== risk.stored_status;
  const save = async () => { setBusy(true); setErr(null); try { onDone(await put(`/risks/${risk.id}`, { status: f.status, severity: f.severity, owner: f.owner || null, review_by: f.review_by || null, note: f.note.trim() || null })); } catch (e: any) { setErr(String(e.message || e)); } finally { setBusy(false); } };
  return (
    <Modal open modalHeading={`Update ${risk.code}`} primaryButtonText={busy ? "Saving…" : "Save"} secondaryButtonText="Cancel" primaryButtonDisabled={busy || (needsNote && f.note.trim().length < 10)} onRequestClose={onClose} onRequestSubmit={save}>
      <Stack gap={5}>
        <p className="ag-body">{risk.title}</p>
        {risk.decision && risk.status !== risk.stored_status && <p className="ag-muted ag-label">Shown as {labelFor("risk_status", risk.status).toLowerCase()} because {risk.decision.code} is {risk.decision.status}; what you set here applies once the decision stands.</p>}
        <div className="ag-row">
          <Select id="ru-status" labelText="Status" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>{STATUSES.map((s) => <SelectItem key={s} value={s} text={labelFor("risk_status", s)} />)}</Select>
          <Select id="ru-sev" labelText="Severity" value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })}>{SEVERITIES.map((s) => <SelectItem key={s} value={s} text={labelFor("severity", s)} />)}</Select>
          <Select id="ru-owner" labelText="Owner" value={f.owner} onChange={(e) => setF({ ...f, owner: e.target.value })}>{(users || []).map((u) => <SelectItem key={u.id} value={u.id} text={u.name || u.id} />)}</Select>
        </div>
        <DateField id="ru-review" labelText="Review By" value={f.review_by} onChange={(v) => setF({ ...f, review_by: v })} />
        <TextArea id="ru-note" labelText={needsNote ? `How it was ${f.status}` : "Note (optional)"} rows={3} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} invalid={needsNote && f.note.trim().length > 0 && f.note.trim().length < 10} invalidText="At least 10 characters." />
        {err && <InlineNotification kind="error" lowContrast hideCloseButton title="Not saved" subtitle={err} />}
      </Stack>
    </Modal>
  );
}
