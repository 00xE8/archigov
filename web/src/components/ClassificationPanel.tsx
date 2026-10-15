import React from "react";
import { createPortal } from "react-dom";
import { Button, Modal, Select, SelectItem, TextInput, TextArea, InlineNotification, InlineLoading, Stack } from "@carbon/react";
import { Add, TrashCan, Edit, Reset, MachineLearningModel } from "@carbon/icons-react";
import { put, post, labelFor, fmtDate, CRITICALITIES, SERVICE_KINDS, REGULATED_KINDS } from "../api";
import { CriticalityTag, ServiceTag, VerificationTag, VerifyButton, OriginTag, useAiFeatures } from "../components";
import { Gated } from "../auth";

type Service = { name: string; kind: string };

/**
 * An application's criticality classification, as a line in the page header: the tier, the services it supports,
 * where the classification came from and whether a person stands behind it — with Classify (set it by hand, with a
 * reason), Reset to Derived and Verify for an author.
 */
export function ClassificationLine({ appId, c, onChange }: { appId: string; c: any; onChange: () => void }) {
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  if (!c) return null;
  const how = c.origin === "human" ? `Set by ${c.set_by} on ${fmtDate(c.set_at)}: ${c.reason}` : c.method ? `Derived from ${c.method.replace(/^tag:/, "the ")}${c.method.startsWith("tag:") ? " tag" : c.method === "regulated-service" ? " (a regulated service depends on it)" : ""}` : "No tag says how critical it is";
  return (
    <div className="ag-row snug ag-mt-03" role="group" aria-label="Classification">
      <span className="ag-label ag-muted">Classification</span>
      <CriticalityTag value={c.criticality} size="md" />
      {(c.services || []).map((s: Service) => <ServiceTag key={`${s.kind}:${s.name}`} s={s} size="md" />)}
      <OriginTag origin={c.origin} />
      <VerificationTag state={c.verification} origin={c.origin} by={c.verified_by} at={c.verified_at} />
      <span className="ag-muted ag-label" title={how}>{how.length > 90 ? `${how.slice(0, 88)}…` : how}</span>
      <Gated cap="verify"><Button size="sm" kind="ghost" renderIcon={Edit} onClick={() => setOpen(true)}>Classify</Button></Gated>
      {c.origin === "human" && <Gated cap="verify"><Button size="sm" kind="ghost" renderIcon={Reset} disabled={busy} onClick={async () => { setBusy(true); try { await post(`/applications/${appId}/classification/reset`); onChange(); } finally { setBusy(false); } }}>Reset to Derived</Button></Gated>}
      {c.origin !== "human" && <VerifyButton path={`/applications/${appId}/classification/verify`} state={c.verification} onDone={onChange} />}
      {/* The line sits in the hero band, whose isolation and overflow would clip a modal rendered in place. */}
      {open && createPortal(<ClassifyModal appId={appId} c={c} onClose={() => setOpen(false)} onSaved={() => { setOpen(false); onChange(); }} />, document.body)}
    </div>
  );
}

function ClassifyModal({ appId, c, onClose, onSaved }: { appId: string; c: any; onClose: () => void; onSaved: () => void }) {
  const [criticality, setCriticality] = React.useState<string>(c.criticality || "");
  const [services, setServices] = React.useState<Service[]>((c.services || []).map((s: Service) => ({ ...s })));
  const [reason, setReason] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const aiOn = useAiFeatures();
  const [suggestion, setSuggestion] = React.useState<any>(null);
  const [aiBusy, setAiBusy] = React.useState(false);
  const [aiErr, setAiErr] = React.useState<string | null>(null);
  const suggest = async () => {
    setAiBusy(true); setAiErr(null); setSuggestion(null);
    try { setSuggestion(await post(`/applications/${appId}/classification/suggest`)); } catch (e: any) { setAiErr(String(e.message || e)); } finally { setAiBusy(false); }
  };
  const regulated = services.some((s) => s.name.trim() && REGULATED_KINDS.includes(s.kind));
  const critInvalid = regulated && criticality !== "critical";
  const reasonInvalid = reason.trim().length > 0 && reason.trim().length < 10;
  const derived = c.derived;
  const save = async () => {
    setBusy(true); setError(null);
    try { await put(`/applications/${appId}/classification`, { criticality: criticality || null, services: services.filter((s) => s.name.trim()), reason }); onSaved(); }
    catch (e: any) { setError(String(e.message || e)); } finally { setBusy(false); }
  };
  return (
    <Modal open size="md" modalHeading="Classify Application" primaryButtonText={busy ? "Saving…" : "Save Classification"} secondaryButtonText="Cancel"
      primaryButtonDisabled={busy || critInvalid || reason.trim().length < 10} onRequestClose={onClose} onRequestSubmit={save}>
      <Stack gap={5}>
        <p className="ag-body">A classification you set is yours: collection never overwrites it, and it is recorded with your reason. Reset to Derived hands it back to the tags.</p>
        {derived && <p className="ag-muted ag-label">The tags say: {derived.criticality ? labelFor("criticality", derived.criticality) : "unclassified"}{(derived.services || []).length ? ` · ${derived.services.map((s: Service) => `${labelFor("service_kind_short", s.kind)} ${s.name}`).join(", ")}` : ""}.</p>}
        <div>{aiBusy ? <InlineLoading description="Asking the model" /> : (
          <Gated cap="verify" allowed={aiOn.suggest_classification === true} reason="AI Classification Suggestion is not enabled for this instance — a platform admin can switch it on under Settings · AI">
            <Button size="sm" kind="tertiary" renderIcon={MachineLearningModel} onClick={suggest}>Suggest with AI</Button>
          </Gated>)}</div>
        {aiErr && <InlineNotification kind="error" lowContrast hideCloseButton title="No suggestion" subtitle={aiErr} />}
        {/* A suggestion is advisory and never stored: applying it fills the form, and the person still saves it with their own reason. */}
        {suggestion && <div className="ag-ai-review">
          <div className="ag-row snug"><span className="ag-colhead">AI Suggestion</span><span className="ag-muted ag-label">{suggestion.model} · advisory, not saved</span></div>
          <div className="ag-row snug"><CriticalityTag value={suggestion.criticality} />{suggestion.services.map((s: Service) => <ServiceTag key={`${s.kind}:${s.name}`} s={s} />)}</div>
          {suggestion.rationale && <p className="ag-body">{suggestion.rationale}</p>}
          <div><Button size="sm" kind="tertiary" onClick={() => { setCriticality(suggestion.criticality || ""); setServices(suggestion.services.map((s: Service) => ({ ...s }))); setSuggestion(null); }}>Apply Suggestion</Button></div>
        </div>}
        <Select id="cls-crit" labelText="Criticality" value={criticality} onChange={(e) => setCriticality(e.target.value)}
          invalid={critInvalid} invalidText="An application that supports an important business service, a critical or important function or an essential function is critical.">
          <SelectItem value="" text="Unclassified" />
          {CRITICALITIES.map((x) => <SelectItem key={x} value={x} text={labelFor("criticality", x)} />)}
        </Select>
        <fieldset className="ag-fieldset">
          <legend className="cds--label">Services It Supports</legend>
          <Stack gap={3}>
            {services.length === 0 && <p className="ag-muted ag-label">None named. Name the business services or functions that depend on this application.</p>}
            {services.map((s, i) => (
              <div className="ag-row snug ag-service-row" key={i}>
                <div className="ag-grow"><TextInput id={`cls-svc-${i}`} labelText="Service" hideLabel={i > 0} placeholder="e.g. Take card payments" value={s.name} maxLength={120}
                  onChange={(e) => setServices(services.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))} /></div>
                <div className="ag-service-kind"><Select id={`cls-kind-${i}`} labelText="Kind" hideLabel={i > 0} value={s.kind} onChange={(e) => setServices(services.map((x, k) => (k === i ? { ...x, kind: e.target.value } : x)))}>
                  {SERVICE_KINDS.map((k) => <SelectItem key={k} value={k} text={labelFor("service_kind", k)} />)}
                </Select></div>
                <Button size="md" kind="ghost" hasIconOnly renderIcon={TrashCan} iconDescription="Remove service" tooltipPosition="left" onClick={() => setServices(services.filter((_x, k) => k !== i))} />
              </div>))}
            <div><Button size="sm" kind="tertiary" renderIcon={Add} onClick={() => setServices([...services, { name: "", kind: "business_service" }])}>Add Service</Button></div>
          </Stack>
        </fieldset>
        <TextArea id="cls-reason" labelText="Reason" helperText="Why this classification is right; it is recorded in the audit log with your name." rows={3} value={reason} onChange={(e) => setReason(e.target.value)}
          invalid={reasonInvalid} invalidText="At least 10 characters." />
        {error && <InlineNotification kind="error" lowContrast hideCloseButton title="Not saved" subtitle={error} />}
      </Stack>
    </Modal>
  );
}
