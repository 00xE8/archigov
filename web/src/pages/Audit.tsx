import React from "react";
import { useSearchParams } from "react-router-dom";
import { Table, TableHead, TableRow, TableHeader, TableBody, TableCell, Select, SelectItem, Search, Button, DataTableSkeleton, CodeSnippet, InlineLoading, Tag } from "@carbon/react";
import { Security, ChevronDown, ChevronUp } from "@carbon/icons-react";
import { get, fmtDateTime, sentence, labelFor } from "../api";
import { PageIntro, useLoad, LoadError, RLink, DateField, Empty, StatusTag, useDocTitle, About } from "../components";

/** The instance's evidence-signing public key, for auditors to pin: a pack signed with any other key was not signed here. */
function SigningKey() {
  const [s] = useLoad<any>(() => get("/settings"));
  if (!s?.signing_public_key) return null;
  return (
    <About title="Evidence Signing Key">
      <p className="ag-body ag-mb-03">Every evidence pack and session minutes hash is signed with this instance's Ed25519 key; the public key travels inside each pack. Pin this value out of band — a pack whose <span className="ag-mono">public_key</span> does not match it was not signed by this instance, whatever its signature says.</p>
      <CodeSnippet type="multi" hideCopyButton={false}>{String(s.signing_public_key).trim()}</CodeSnippet>
    </About>
  );
}

/** Recomputes the audit hash chain server-side: every row's hash must cover the previous one. */
function VerifyChain() {
  const [busy, setBusy] = React.useState(false);
  const [res, setRes] = React.useState<any>(null);
  const [err, setErr] = React.useState<string | null>(null);
  if (busy) return <InlineLoading description="Verifying the chain" />;
  return (
    <div className="ag-row snug">
      {res && <StatusTag kind="check" value={res.ok ? "ok" : "failed"} label={res.ok ? `Chain intact · ${res.rows} rows` : `Chain broken at ${String(res.broken_at || "?").slice(0, 8)}`} />}
      {err && <span className="ag-muted ag-label">{err}</span>}
      <Button size="md" kind="tertiary" renderIcon={Security} onClick={async () => { setBusy(true); setErr(null); try { setRes(await get("/audit/verify")); } catch (e: any) { setErr(String(e.message || e)); } finally { setBusy(false); } }}>Verify Audit Chain</Button>
    </div>
  );
}

const KEYS = ["entity", "entity_id", "actor", "action", "since", "until", "q"] as const;
const LIMIT = 200;
const CATALOGUE = ["standard", "standards", "principle", "principles", "pattern", "patterns", "policy", "policies", "artefact", "artefacts"];
/** Where the item an audit row is about lives in the UI. */
const linkFor = (entity: string, id: string) =>
  entity === "application" || entity === "applications" ? `/applications/${id}`
  : CATALOGUE.includes(entity) ? `/governance?open=${id}`
  : entity === "decision" || entity === "decisions" ? `/decisions/${id}`
  : entity === "review" || entity === "reviews" ? `/reviews/${id}`
  : entity === "session" || entity === "sessions" ? `/sessions/${id}`
  : entity === "board" || entity === "boards" ? `/boards/${id}`
  : entity === "work_item" || entity === "work_items" ? "/backlog"
  : entity === "run" ? "/conformance?tab=runs"
  : entity === "evidence" ? "/evidence"
  : entity === "source" ? "/settings?tab=sources"
  : entity === "user" || entity === "users" ? "/settings?tab=access"
  : null;
const entityLabel = (e?: string | null) => (e ? labelFor("entity", e) : "—");

// Actions as the server writes them ("decide:approved", "position:yes", "session:open", "lifecycle_in_review"), read as sentences.
const SESSION_ACTIONS: Record<string, string> = { create: "Session planned", open: "Session opened", close: "Session closed", attendance: "Attendance recorded", delegate: "Seat delegated", revoke_delegation: "Delegation revoked", call: "Item called", nominate: "Acting chair nominated", pull: "Item pulled from consent", defer: "Item deferred", consent_declare: "Consent items declared", agenda: "Agenda changed", refresh: "Agenda refreshed", notes: "Notes saved" };
const REVIEW_ACTIONS: Record<string, string> = { effective: "Review became effective", areas: "Areas changed", circulation_objection: "Objection in circulation", create: "Review submitted", submit: "Review submitted", resubmit: "Review resubmitted", comment: "Comment added", pre_review: "Pre-review run", approve: "Approval recorded", request_changes: "Changes requested", withdraw: "Review withdrawn" };
const PLAIN: Record<string, string> = { create: "Created", update: "Updated", delete: "Deleted", verify: "Verified", unverify: "Marked unverified", evaluate: "Evaluated", ingest: "Ingested", seed: "Seeded", sync: "Synced", resolve: "Resolved", reopened: "Reopened", reopen: "Reopened", approve: "Approved", reject: "Rejected", accept: "Accepted", retire: "Retired", adopt: "Adopted", import: "Imported", import_evidence: "Evidence imported", sign_in: "Signed in", sign_out: "Signed out", login: "Signed in", logout: "Signed out", move: "Moved", link: "Linked", acknowledge: "Acknowledged", exception: "Exception granted", perturb: "Perturbed (demo)", simulate_change: "Change simulated (demo)", backup: "Backed up", settings: "Settings saved", status: "Status changed" };
export function actionLabel(action?: string | null): string {
  if (!action) return "—";
  const [head, ...rest] = String(action).split(":");
  const tail = rest.join(":");
  if (head === "decide" && tail) return `Declared ${labelFor("outcome", tail).toLowerCase()}`;
  if (head === "position" && tail) return tail === "resolve" ? "Conditional resolved" : `Position: ${labelFor("position", tail).toLowerCase()}`;
  if (head === "session" && tail) return SESSION_ACTIONS[tail] || `Session: ${sentence(tail).toLowerCase()}`;
  if (head === "review" && tail) return REVIEW_ACTIONS[tail] || `Review: ${sentence(tail).toLowerCase()}`;
  if (head === "dependency" && tail) return tail === "create" ? "Dependent decision created" : `Dependency: ${sentence(tail).toLowerCase()}`;
  if (head === "assessment" && tail) return ({ request: "Assessment requested", result: "Assessment result recorded", waive: "Assessment waived", reassign: "Assessment reassigned" } as Record<string, string>)[tail] || `Assessment: ${sentence(tail).toLowerCase()}`;
  if (head === "board" && tail) return tail === "areas" ? "Board areas changed" : `Board: ${sentence(tail).toLowerCase()}`;
  // a sign-off is the record of a reaffirmation (the UI's word), so the log reads as the page does
  if (head === "signoff" && tail) return tail === "reaffirmed" ? "Reaffirmed" : tail === "revision_needed" ? "Marked as needing revision" : `Reaffirmation: ${sentence(tail).toLowerCase()}`;
  if (head === "decision" && tail) return `Decision ${labelFor("decision", tail).toLowerCase()}`;
  if (tail) return `${sentence(head)}: ${sentence(tail).toLowerCase()}`;
  if (head.startsWith("lifecycle_")) return `Lifecycle: ${labelFor("lifecycle", head.slice("lifecycle_".length)).toLowerCase()}`;
  if (head.startsWith("status_")) return `Status: ${sentence(head.slice("status_".length)).toLowerCase()}`;
  return PLAIN[head] || sentence(head);
}

/** Details as key: value chips; arrays and objects are counted; the raw JSON is one click away. */
function Details({ d }: { d: any }) {
  const [raw, setRaw] = React.useState(false);
  if (d === null || d === undefined || (typeof d === "object" && Object.keys(d).length === 0) || d === "") return <span className="ag-muted">—</span>;
  if (typeof d !== "object") return <span className="ag-body">{String(d)}</span>;
  const entries = Object.entries(d);
  const chip = (k: string, v: any) => {
    const text = v === null || v === undefined ? "—" : Array.isArray(v) ? `${v.length} item${v.length === 1 ? "" : "s"}` : typeof v === "object" ? `${Object.keys(v).length} field${Object.keys(v).length === 1 ? "" : "s"}` : String(v);
    const full = typeof v === "object" && v !== null ? JSON.stringify(v) : text;
    return <Tag key={k} size="sm" type="gray" title={full.length > 40 ? full : undefined}>{k}: {text.length > 40 ? `${text.slice(0, 40)}…` : text}</Tag>;
  };
  return (
    <div>
      <div className="ag-chips">
        {entries.map(([k, v]) => chip(k, v))}
        <Button size="sm" kind="ghost" hasIconOnly iconDescription={raw ? "Hide raw JSON" : "Show raw JSON"} renderIcon={raw ? ChevronUp : ChevronDown} onClick={() => setRaw((r) => !r)} />
      </div>
      {raw && <div className="ag-mt-02"><CodeSnippet type="multi" feedback="Copied" hideCopyButton={false}>{JSON.stringify(d, null, 2)}</CodeSnippet></div>}
    </div>
  );
}

export default function Audit() {
  const [params, setParams] = useSearchParams();
  const f = Object.fromEntries(KEYS.map((k) => [k, params.get(k) || ""])) as Record<(typeof KEYS)[number], string>;
  const qs = KEYS.filter((k) => f[k]).map((k) => `${k}=${encodeURIComponent(f[k])}`).join("&");
  const [d, reload, err] = useLoad<any>(() => get(`/audit?limit=${LIMIT}${qs ? `&${qs}` : ""}`), [qs]);
  const [qText, setQText] = React.useState(f.q);
  const set = (k: string, v: string) => { const n = new URLSearchParams(params); if (v) n.set(k, v); else n.delete(k); setParams(n, { replace: true }); };
  // Free text is debounced before it reaches the URL (and the API); the selects apply immediately.
  React.useEffect(() => { const t = setTimeout(() => { if (qText !== f.q) set("q", qText); }, 300); return () => clearTimeout(t); }, [qText]); // eslint-disable-line react-hooks/exhaustive-deps
  useDocTitle("Audit Log");
  if (err) return <LoadError what="the audit log" err={err} onRetry={reload} />;
  const facets = d?.facets || { entities: [], actors: [], actions: [] };
  const rows: any[] = d?.rows || [];
  return (
    <>
      <PageIntro title="Audit Log" lead="Who did what, when, in a hash chain that can be checked for tampering."
        about="Every verification, position, declaration, exception, import and sync is recorded with its actor. Each row's hash covers the one before it, so the log can be verified end to end; the evidence pack records the chain head. Filter it here, or arrive from an item's own audit trail." actions={<VerifyChain />} />
      {/* Auditors verify from this page, so the key that signs every evidence pack is published here, not only in Settings. */}
      <SigningKey />
      {/* All six filters carry their label above the control (the date pickers allow nothing else), so the row shares one baseline. */}
      <div className="ag-filters ag-mb-05">
        <Select id="a-entity" labelText="Entity" value={f.entity} onChange={(e) => set("entity", e.target.value)}><SelectItem value="" text="All" />{(facets.entities || []).map((x: string) => <SelectItem key={x} value={x} text={entityLabel(x)} />)}</Select>
        <Select id="a-actor" labelText="Actor" value={f.actor} onChange={(e) => set("actor", e.target.value)}><SelectItem value="" text="All" />{(facets.actors || []).map((x: string) => <SelectItem key={x} value={x} text={x} />)}</Select>
        <Select id="a-action" labelText="Action" value={f.action} onChange={(e) => set("action", e.target.value)}><SelectItem value="" text="All" />{(facets.actions || []).map((x: string) => <SelectItem key={x} value={x} text={actionLabel(x)} />)}</Select>
        <DateField id="a-since" labelText="Since" value={f.since} onChange={(v) => set("since", v)} />
        <DateField id="a-until" labelText="Until" value={f.until} onChange={(v) => set("until", v)} />
        <div className="ag-filter-search"><Search id="a-q" size="md" labelText="Search details" placeholder="e.g. REV-0006" value={qText} onChange={(e) => setQText(e.target.value)} onClear={() => { setQText(""); set("q", ""); }} /></div>
        {qs && <Button size="md" kind="ghost" onClick={() => { setQText(""); setParams({}, { replace: true }); }}>Clear Filters</Button>}
      </div>
      {f.entity_id && <p className="ag-muted ag-label ag-mb-03">Showing entries for one {entityLabel(f.entity || "item").toLowerCase()} · <span className="ag-mono">{f.entity_id}</span></p>}
      {!d ? <DataTableSkeleton columnCount={6} rowCount={8} showHeader={false} showToolbar={false} /> : rows.length === 0 ? (
        <Empty>{qs ? "No audit entries match these filters." : "No audit entries yet. Actions taken in the product are recorded here as they happen."}</Empty>
      ) : (
        <Table size="sm">
          <TableHead><TableRow><TableHeader>When</TableHeader><TableHeader>Actor</TableHeader><TableHeader>Action</TableHeader><TableHeader>Entity</TableHeader><TableHeader>Item</TableHeader><TableHeader>Details</TableHeader></TableRow></TableHead>
          <TableBody>{rows.map((r: any) => {
            const to = r.entity_id ? linkFor(r.entity, r.entity_id) : null;
            // The item's human code when the server names it; the short id otherwise.
            const code: string | null = r.item_code || null;
            const text = code ? <span>{code}</span> : r.entity_id ? <span className="ag-mono">{String(r.entity_id).slice(0, 8)}</span> : null;
            return (
              <TableRow key={r.id}>
                <TableCell className="ag-nowrap">{fmtDateTime(r.at)}</TableCell>
                <TableCell>{r.actor_name && r.actor_name !== r.actor ? <>{r.actor_name}<div className="ag-muted ag-label">{r.actor}</div></> : r.actor}</TableCell>
                <TableCell>{actionLabel(r.action)}</TableCell>
                <TableCell>{entityLabel(r.entity)}</TableCell>
                <TableCell>{text ? (to ? <RLink to={to}>{text}</RLink> : <span className="ag-muted">{text}</span>) : <span className="ag-muted">—</span>}{r.item_label ? <div className="ag-muted ag-label ag-wrap">{r.item_label}</div> : null}</TableCell>
                <TableCell><Details d={r.details ?? r.data} /></TableCell>
              </TableRow>);
          })}</TableBody>
        </Table>)}
      {rows.length >= LIMIT && <p className="ag-muted ag-label ag-mt-03">Showing the most recent {LIMIT} entries. Narrow the filters to see older ones.</p>}
    </>
  );
}
