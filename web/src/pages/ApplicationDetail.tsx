import React from "react";
import { useParams } from "react-router-dom";
import { Tabs, TabList, Tab, TabPanels, TabPanel, Button, Tag, SkeletonText, Table, TableHead, TableRow, TableHeader, TableBody, TableCell, TableContainer, Modal, Select, SelectItem, CopyButton } from "@carbon/react";
import { Checkmark, Move } from "@carbon/icons-react";
import { get, post, fmtDate, shortType, labelFor } from "../api";
import { PageHeader, useLoad, VerificationTag, VerifyButton, SeverityTag, Empty, OriginTag, LoadError, RLink, Crumbs, StatusTag, FindingEvidence, useTabParam, ExportMenu, VerifiedBy, KindTag, artefactLink, ShortId, useDocTitle } from "../components";
import { Gated } from "../auth";
import { DesignPanel } from "../components/ArchimateView";
import { ClassificationLine } from "../components/ClassificationPanel";

const TABS = ["resources", "design", "findings", "decisions", "reviews", "backlog", "exceptions"];

export default function ApplicationDetail() {
  const { id } = useParams();
  const [a, reload, err] = useLoad<any>(() => get(`/applications/${id}`), [id]);
  const [apps] = useLoad<any[]>(() => get("/applications"));
  const [tab, onTab] = useTabParam(TABS);
  const [move, setMove] = React.useState<any>(null);
  const [target, setTarget] = React.useState("");
  useDocTitle(a ? a.name : null);
  if (err) return <LoadError what="this application" err={err} onRetry={reload} />;
  if (!a) return <SkeletonText paragraph lineCount={8} />;
  const owners = Array.from(new Set(a.resources.map((r: any) => r.tags.owner).filter(Boolean)));
  const unverifiedRes = a.resources.filter((r: any) => r.verification !== "verified").length;
  const verifiedRes = a.resources.length - unverifiedRes;
  const hasEvidence = a.resources.some((r: any) => Array.isArray(r.evidence));
  return (
    <>
      <PageHeader breadcrumb={<Crumbs items={[{ to: "/applications", label: "Applications" }, { label: a.name }]} />} title={a.name}
        subtitle={<span>Inferred by <span className="ag-mono ag-nowrap">{(a.provenance.methods || []).join(", ")}</span> from {a.resources.length} resources · confidence {Math.round(a.confidence * 100)}% · owners: {owners.join(", ") || "none"}</span>}
        about="Derived from the connected estate, never typed in: the resources that make the application up (with why each one belongs here), the evidence imported for them, and the findings, decisions, reviews and backlog that cover it. Verifying records that a person stands behind the derivation; a human reassignment is never overridden by collectors. The classification line says how critical the application is and which business services or regulated functions depend on it — derived from tags, or set by a person with a reason."
        extra={<ClassificationLine appId={a.id} c={a.classification} onChange={reload} />}
        actions={<>
          <VerificationTag state={a.verification} origin={a.origin} by={a.verified_by} at={a.verified_at} size="md" />
          {a.verification === "verified" && <VerifiedBy by={a.verified_by} at={a.verified_at} />}
          <VerifyButton size="md" path={`/elements/${a.id}/verify`} state={a.verification} onDone={reload} />
          <Gated cap="verify"><Button size="md" kind="primary" renderIcon={Checkmark} disabled={unverifiedRes === 0 && a.verification === "verified"} onClick={async () => { await post(`/applications/${a.id}/verify-all`); reload(); }}>Verify Application and {unverifiedRes} Resources</Button></Gated>
          <ExportMenu application={a.id} name={a.name} />
        </>} />

      <Tabs selectedIndex={tab} onChange={onTab}>
        <TabList aria-label="Application sections">
          <Tab>Resources ({a.resources.length})</Tab>
          <Tab>Design</Tab>
          <Tab>Findings ({a.findings.length})</Tab>
          <Tab>Decisions ({a.decisions.length})</Tab>
          <Tab>Reviews ({a.reviews.length})</Tab>
          <Tab>Planned Changes ({a.workItems.length})</Tab>
          <Tab>Exceptions ({a.exceptions.length})</Tab>
        </TabList>
        <TabPanels>
          <TabPanel>
            {/* TableContainer: seven columns overflow a 1440 viewport, so the table scrolls inside it instead of clipping the action buttons. */}
            <TableContainer><Table size="sm">
              <TableHead><TableRow><TableHeader>Name</TableHeader><TableHeader>Type</TableHeader><TableHeader>Region</TableHeader><TableHeader>Why It Belongs Here</TableHeader>{hasEvidence && <TableHeader>Imported Evidence</TableHeader>}<TableHeader>Verification</TableHeader><TableHeader>Actions</TableHeader></TableRow></TableHead>
              <TableBody>{a.resources.map((r: any) => (
                <TableRow key={r.id}>
                  {/* The provider id is long; the last two segments identify the resource, the whole id is on hover and one click away. */}
                  <TableCell><div>{r.name}</div>{r.source_ref && <div className="ag-id ag-muted"><ShortId id={r.source_ref} /><CopyButton feedback="Copied" iconDescription="Copy resource id" align="top" onClick={() => navigator.clipboard.writeText(String(r.source_ref))} /></div>}</TableCell>
                  <TableCell>{shortType(r.subtype)}</TableCell>
                  <TableCell>{r.props.location}</TableCell>
                  <TableCell>{r.belongs ? <div className="ag-row tight"><OriginTag origin={r.belongs.origin} /><span className="ag-mono ag-nowrap">{JSON.parse(r.belongs.provenance_json).method}</span><span className="ag-muted ag-nowrap">· {Math.round(r.belongs.confidence * 100)}%</span></div> : "—"}</TableCell>
                  {hasEvidence && <TableCell>{Array.isArray(r.evidence) && r.evidence.length ? <div className="ag-row tight">{r.evidence.map((e: any) => <StatusTag key={e.id || `${e.source}-${e.control}`} kind="evidence" value={e.state} label={`${labelFor("evidence_source", e.source)} · ${e.control} · ${labelFor("evidence", e.state)}`} />)}</div> : <span className="ag-muted">—</span>}</TableCell>}
                  <TableCell><VerificationTag state={r.verification} origin={r.origin} by={r.verified_by} at={r.verified_at} /></TableCell>
                  <TableCell><div className="ag-actions"><VerifyButton path={`/elements/${r.id}/verify`} state={r.verification} onDone={reload} /><Gated cap="verify" mode="hide"><Button size="sm" kind="ghost" renderIcon={Move} iconDescription="Move to another application" hasIconOnly onClick={() => { setMove(r); setTarget(""); }} /></Gated></div></TableCell>
                </TableRow>))}</TableBody>
            </Table></TableContainer>
            {a.dependsOn.length > 0 && <div className="ag-section ag-mt-06"><h3>Dependencies (from Provider References)</h3><div className="ag-row tight">{a.dependsOn.map((d: any) => <Tag key={d.id} type="gray"><span title={`Dependency derived from provider references: this application's resources reference ${d.name} (${shortType(d.subtype)})`}>{d.name} · {shortType(d.subtype)}</span></Tag>)}</div></div>}
          </TabPanel>
          <TabPanel>{tab === 1 && <DesignPanel appId={a.id} />}</TabPanel>
          <TabPanel>
            {a.findings.length === 0 ? <Empty>No open findings against the checkable standards. {verifiedRes} of {a.resources.length} resources human verified.</Empty> : (
              <Table size="sm">
                <TableHead><TableRow><TableHeader>Severity</TableHeader><TableHeader>Standard</TableHeader><TableHeader>Finding</TableHeader><TableHeader>Evidence</TableHeader><TableHeader>Status</TableHeader><TableHeader>Since</TableHeader></TableRow></TableHead>
                <TableBody>{a.findings.map((f: any) => (
                  <TableRow key={f.id}>
                    <TableCell><SeverityTag s={f.severity} /></TableCell>
                    <TableCell><div className="ag-row tight"><RLink to={artefactLink(f.standard_id)}>{f.artefact_code || f.standard_code}</RLink>{f.artefact_kind && f.artefact_kind !== "standard" && <KindTag kind="kind" value={f.artefact_kind} />}</div><div className="ag-muted ag-label">{f.standard_title}</div></TableCell>
                    <TableCell>{f.message}</TableCell>
                    <TableCell><FindingEvidence e={f.evidence} /></TableCell>
                    <TableCell><StatusTag kind="finding" value={f.status} /></TableCell>
                    <TableCell>{fmtDate(f.first_seen)}</TableCell>
                  </TableRow>))}</TableBody>
              </Table>)}
          </TabPanel>
          <TabPanel>
            {a.decisions.length === 0 ? <Empty>No decisions recorded for this application.</Empty> : a.decisions.map((d: any) => (
              <div className="ag-finding" key={d.id}>
                <div className="ag-row snug"><RLink to={`/decisions/${d.id}`} className="title">{d.code} · {d.title}</RLink><StatusTag kind="decision" value={d.status} /><VerificationTag state={d.verification} origin={d.origin} by={d.verified_by} at={d.verified_at} /></div>
                <div className="detail ag-muted">{labelFor("topic", d.topic)} · {d.author} · {fmtDate(d.decided_at || d.created_at)}</div>
              </div>))}
          </TabPanel>
          <TabPanel>
            {a.reviews.length === 0 ? <Empty>No reviews.</Empty> : a.reviews.map((r: any) => (
              <div className="ag-finding" key={r.id}><div className="ag-row snug"><RLink to={`/reviews/${r.id}`} className="title">{r.code} · {r.title}</RLink><StatusTag kind="stage" value={r.stage} /><StatusTag kind="risk" value={r.risk_tier} /></div><div className="detail ag-muted">{r.summary}</div></div>))}
          </TabPanel>
          <TabPanel>
            {a.workItems.length === 0 ? <Empty>No backlog items linked.</Empty> : a.workItems.map((w: any) => (
              <div className="ag-finding" key={w.id}><div className="ag-row snug"><span className="title">{w.type} {w.external_id} · {w.title}</span><StatusTag kind="work" value={w.state} />{w.material_change ? <StatusTag kind="attention" value="changed" /> : null}{w.needs_decision ? <StatusTag kind="attention" value="decision" label="No decision" /> : null}</div><div className="detail ag-muted">{w.description}</div></div>))}
          </TabPanel>
          <TabPanel>
            {a.exceptions.length === 0 ? <Empty>No exceptions.</Empty> : a.exceptions.map((e: any) => (
              <div className="ag-finding" key={e.id}><div className="ag-row snug"><span className="title">{e.standard_code}</span><StatusTag kind="exception" value={e.status} /><span className="ag-muted">expires {fmtDate(e.expires_at)} · approved by {e.approved_by}</span></div><div className="detail">{e.reason}</div></div>))}
          </TabPanel>
        </TabPanels>
      </Tabs>

      <Modal open={!!move} modalHeading={`Move ${move?.name} to another application`} primaryButtonText="Move" secondaryButtonText="Cancel" primaryButtonDisabled={!target}
        onRequestClose={() => setMove(null)} onRequestSubmit={async () => { await post(`/resources/${move.id}/move`, { applicationId: target }); setMove(null); reload(); }}>
        <p className="ag-body ag-mb-05">A human reassignment becomes the source of truth for this resource; collectors will not override it.</p>
        <Select id="target" labelText="Application" value={target} onChange={(e) => setTarget(e.target.value)}>
          <SelectItem value="" text="None selected" />
          {(apps || []).filter((x) => x.id !== a.id).map((x) => <SelectItem key={x.id} value={x.id} text={x.name} />)}
        </Select>
      </Modal>
    </>
  );
}
