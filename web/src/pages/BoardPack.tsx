import React from "react";
import { useParams } from "react-router-dom";
import { Button, SkeletonText, Table, TableHead, TableRow, TableHeader, TableBody, TableCell, InlineNotification } from "@carbon/react";
import { Printer, Download } from "@carbon/icons-react";
import { get, fmtDate, fmtDateTime, labelFor } from "../api";
import { PageHeader, Crumbs, useLoad, LoadError, Markdown, StatusTag, Empty, useDocTitle } from "../components";

const d = (n: number | null | undefined) => (n === null || n === undefined ? "not available" : `${n} days`);
const FigTable = ({ caption, rows }: { caption: string; rows: [string, React.ReactNode][] }) => (
  <Table size="sm" aria-label={caption}><TableHead><TableRow><TableHeader>Figure</TableHeader><TableHeader>Value</TableHeader></TableRow></TableHead>
    <TableBody>{rows.map(([k, v]) => <TableRow key={k}><TableCell>{k}</TableCell><TableCell>{v}</TableCell></TableRow>)}</TableBody></Table>
);

/**
 * One signed board pack, laid out to be read in a sitting and printed: its verification (hash, signature, audit
 * chain — re-checked on open), the preparer's narrative with its origin, then the figures, the decisions and reviews of
 * the period, the roadmap's Now lane and the register gaps, and the disclaimer. Everything below the narrative is the
 * snapshot as signed; nothing is recomputed.
 */
export default function BoardPack() {
  const { hash } = useParams();
  const [p, reload, err] = useLoad<any>(() => get(`/board-packs/${hash}`), [hash]);
  const [v] = useLoad<any>(() => get(`/evidence-pack/verify?hash=${hash}`).catch(() => null), [hash]);
  useDocTitle(p ? p.title : "Board Pack");
  if (err) return <LoadError what="this board pack" err={err} onRetry={reload} />;
  if (!p) return <SkeletonText paragraph lineCount={10} />;
  const m = p.metrics;
  const ok = v && v.hash_ok && v.signature_ok && v.chain_ok;
  return (
    <div className="ag-board-pack">
      <PageHeader breadcrumb={<Crumbs items={[{ to: "/metrics", label: "Governance Metrics" }, { label: "Board Pack" }]} />} title={p.title}
        subtitle={<span>{p.tenant}{p.board ? ` · ${p.board.name}` : ""} · {fmtDate(p.period.from)} – {fmtDate(p.period.to)} ({p.period.days} days)</span>}
        actions={<div className="ag-row snug ag-no-print">
          <Button size="md" kind="tertiary" renderIcon={Printer} onClick={() => window.print()}>Print</Button>
          <Button size="md" kind="ghost" renderIcon={Download} href={`/api/board-packs/${p.hash}?download=1`}>Download JSON</Button>
        </div>} />
      <dl className="ag-facts">
        <div><dt>Prepared By</dt><dd>{p.generated_by_name || p.generated_by} · {fmtDateTime(p.generated_at)}</dd></div>
        <div><dt>Verification</dt><dd>{!v ? "checking…" : <span className="ag-row tight">
          <StatusTag kind="check" value={v.hash_ok ? "ok" : "failed"} label={v.hash_ok ? "Content intact" : "Content changed"} explain="The SHA-256 of the pack's content matches its hash." />
          <StatusTag kind="check" value={v.signature_ok ? "ok" : "failed"} label={v.signature_ok ? "Signature valid" : "Signature invalid"} explain="The Ed25519 signature verifies with the public key inside the pack." />
          <StatusTag kind="check" value={v.chain_ok ? "ok" : "failed"} label={v.chain_ok ? "Audit chain intact" : "Audit chain broken"} explain="The audit log's hash chain re-walks unbroken up to the head the pack was anchored to." />
        </span>}</dd></div>
        <div><dt>Hash</dt><dd><span className="ag-mono">{p.hash}</span></dd></div>
      </dl>
      {v && !ok && <InlineNotification kind="error" lowContrast hideCloseButton className="ag-notice" title="This pack does not verify" subtitle="Its content, signature or audit-chain anchor no longer matches what was signed. Do not rely on it." />}

      <section className="ag-section"><h2>Narrative</h2>
        {p.narrative ? <>
          <p className="ag-muted ag-label">{p.narrative.origin === "ai_assisted" ? `Drafted with AI from the figures, edited and submitted by ${p.narrative.author_name || p.narrative.author}.` : `Written by ${p.narrative.author_name || p.narrative.author}.`}</p>
          <Markdown md={p.narrative.md} />
        </> : <Empty>The preparer added no narrative; the figures speak for themselves.</Empty>}
      </section>

      <div className="ag-grid-2">
        <section className="ag-section"><h2>Reviews</h2>
          <FigTable caption="Review figures" rows={[["Decided in the period", m.reviews.decided], ["Lead time, median · 90th percentile", `${d(m.reviews.lead_time_days.median)} · ${d(m.reviews.lead_time_days.p90)}`], ["Sent back at least once", m.reviews.recycle_rate === null ? "not available" : `${m.reviews.recycle_rate}%`],
            ["Approvals in the fast lane", `${m.reviews.fast_lane.via_fast_lane} of ${m.reviews.fast_lane.approvals}`], ["Position latency, median", d(m.reviews.position_latency_days.median)], ["Open now · oldest", `${m.reviews.open} · ${d(m.reviews.oldest_open_days)}`]]} />
        </section>
        <section className="ag-section"><h2>Decisions, Conditions and Exceptions</h2>
          <FigTable caption="Decision, condition and exception figures" rows={[["Decisions accepted · median from draft", `${m.decisions.accepted} · ${d(m.decisions.lead_time_days.median)}`],
            ["Realisation", `${m.decisions.realisation.realised} realised · ${m.decisions.realisation.in_progress} in progress · ${m.decisions.realisation.not_started} not started · ${m.decisions.realisation.not_checkable} not checkable`],
            ["Conditions open · overdue · met", `${m.conditions.open} · ${m.conditions.overdue} · ${m.conditions.met}`], ["Exceptions active · expiring in 30 days", `${m.exceptions.active} · ${m.exceptions.expiring_30_days}`],
            ["Exceptions by age", m.exceptions.ageing.map((a: any) => `${a.bucket}: ${a.n}`).join(" · ")]]} />
        </section>
        <section className="ag-section"><h2>Conformance</h2>
          <FigTable caption="Conformance figures" rows={[["Open findings", `${m.conformance.open} (${["critical", "high", "medium", "low"].map((s) => `${m.conformance.open_by_severity[s] || 0} ${s}`).join(", ")})`], ["Opened · resolved in the period", `${m.conformance.opened} · ${m.conformance.resolved}`],
            ["Time to fix, median · 90th percentile", `${d(m.conformance.time_to_fix_days.median)} · ${d(m.conformance.time_to_fix_days.p90)}`], ["Oldest open finding", d(m.conformance.oldest_open_days)]]} />
        </section>
        <section className="ag-section"><h2>Coverage</h2>
          <FigTable caption="Coverage figures" rows={[["Applications verified by a person", `${m.coverage.verification.applications?.verified ?? 0} of ${m.coverage.verification.applications?.total ?? 0}`], ["Applications classified · verified", `${m.coverage.classification.classified} · ${m.coverage.classification.verified} of ${m.coverage.classification.total}`],
            ["Legacy assessments in date", `${m.coverage.legacy_assessments.current} of ${m.coverage.legacy_assessments.needed}`], ["Exit plans in date", `${m.coverage.exit_plans.current} of ${m.coverage.exit_plans.needed}`],
            ...(m.coverage.sign_offs ? [["Items in date for reaffirmation", `${m.coverage.sign_offs.current} of ${m.coverage.sign_offs.total} · ${m.coverage.sign_offs.overdue} overdue`] as [string, React.ReactNode]] : [])]} />
        </section>
      </div>

      <section className="ag-section"><h2>Decisions in the Period ({p.decisions_in_period.length})</h2>
        {p.decisions_in_period.length === 0 ? <Empty>None.</Empty> : <Table size="sm" aria-label="Decisions in the period"><TableHead><TableRow><TableHeader>Decision</TableHeader><TableHeader>Status</TableHeader><TableHeader>Decided</TableHeader></TableRow></TableHead>
          <TableBody>{p.decisions_in_period.map((x: any) => <TableRow key={x.code}><TableCell><span className="ag-mono">{x.code}</span> {x.title}</TableCell><TableCell>{labelFor("decision", x.status)}</TableCell><TableCell>{fmtDate(x.decided_at)}</TableCell></TableRow>)}</TableBody></Table>}
      </section>
      <section className="ag-section"><h2>Reviews Declared in the Period ({p.reviews_declared_in_period.length})</h2>
        {p.reviews_declared_in_period.length === 0 ? <Empty>None.</Empty> : <Table size="sm" aria-label="Reviews in the period"><TableHead><TableRow><TableHeader>Review</TableHeader><TableHeader>Type</TableHeader><TableHeader>Outcome</TableHeader><TableHeader>Declared</TableHeader></TableRow></TableHead>
          <TableBody>{p.reviews_declared_in_period.map((x: any) => <TableRow key={x.code}><TableCell><span className="ag-mono">{x.code}</span> {x.title}</TableCell><TableCell>{labelFor("review_type", x.type)}</TableCell>
            <TableCell><span className="ag-row tight"><StatusTag kind="stage" value={x.outcome} />{x.via_fast_lane && <StatusTag kind="fast_lane" value="eligible" label="Fast Lane" />}</span></TableCell><TableCell>{fmtDate(x.decided_at)}</TableCell></TableRow>)}</TableBody></Table>}
      </section>
      <section className="ag-section"><h2>Roadmap · Now ({p.roadmap.now.length})</h2>
        <p className="ag-muted ag-label ag-mb-03">{p.roadmap.counts.now} now · {p.roadmap.counts.next} next · {p.roadmap.counts.later} later · {p.roadmap.counts.done} done.</p>
        {p.roadmap.now.length === 0 ? <Empty>Nothing in progress or due.</Empty> : <Table size="sm" aria-label="Roadmap now"><TableHead><TableRow><TableHeader>Item</TableHeader><TableHeader>Kind</TableHeader><TableHeader>Status</TableHeader><TableHeader>Due</TableHeader></TableRow></TableHead>
          <TableBody>{p.roadmap.now.map((x: any, i: number) => <TableRow key={i}><TableCell>{x.title}{x.applications.length > 0 && <div className="ag-muted ag-label">{x.applications.join(", ")}</div>}</TableCell><TableCell>{labelFor("roadmap_kind", x.kind)}</TableCell><TableCell>{labelFor("roadmap_status", x.status)}</TableCell><TableCell>{x.due ? fmtDate(x.due) : "—"}</TableCell></TableRow>)}</TableBody></Table>}
      </section>
      {p.registers.risks && <section className="ag-section"><h2>Risks Needing Attention ({p.registers.risks.attention.length})</h2>
        <p className="ag-muted ag-label ag-mb-03">{p.registers.risks.counts.open} open · {p.registers.risks.counts.accepted} accepted · {p.registers.risks.counts.review_overdue} with the review overdue. Listed: live high and critical risks, and any whose review date has passed.</p>
        {p.registers.risks.attention.length === 0 ? <Empty>None.</Empty> : <Table size="sm" aria-label="Risks needing attention"><TableHead><TableRow><TableHeader>Risk</TableHeader><TableHeader>Severity</TableHeader><TableHeader>Status</TableHeader><TableHeader>Owner</TableHeader><TableHeader>Review By</TableHeader></TableRow></TableHead>
          <TableBody>{p.registers.risks.attention.map((x: any, i: number) => <TableRow key={i}><TableCell>{x.code && <span className="ag-mono">{x.code} </span>}{x.title}{x.decision && <div className="ag-muted ag-label">accepted by {x.decision}</div>}</TableCell><TableCell>{labelFor("severity", x.severity)}</TableCell><TableCell>{labelFor("risk_status", x.status)}</TableCell><TableCell>{x.owner || "—"}</TableCell><TableCell>{x.review_by ? fmtDate(x.review_by) : "—"}{x.review_overdue ? " (overdue)" : ""}</TableCell></TableRow>)}</TableBody></Table>}
      </section>}
      <section className="ag-section"><h2>Register Gaps</h2>
        <div className="ag-grid-2">
          <div><p className="ag-colhead">Legacy Assessments Due ({p.registers.legacy_due.length})</p>
            {p.registers.legacy_due.length === 0 ? <Empty>None.</Empty> : <ul className="ag-plain-list">{p.registers.legacy_due.map((x: any) => <li key={x.application} className="ag-label">{x.application} · {x.status === "stale" ? "stale" : "due"} · {x.components.join(", ")}</li>)}</ul>}</div>
          <div><p className="ag-colhead">Exit Plans Due ({p.registers.exit_plans_due.length})</p>
            {p.registers.exit_plans_due.length === 0 ? <Empty>None.</Empty> : <ul className="ag-plain-list">{p.registers.exit_plans_due.map((x: any, i: number) => <li key={i} className="ag-label">{x.application} · {x.provider}</li>)}</ul>}
            {p.registers.concentration.map((c: any) => <p key={c.provider} className="ag-label ag-mt-03">{c.critical} of {c.of} critical or important applications rely on {c.provider}{c.designated_entity ? ` (${c.designated_entity}, a designated critical third party)` : ""}.</p>)}</div>
        </div>
      </section>
      <p className="ag-muted ag-label ag-mt-05">{p.disclaimer} Verify it at any time with GET /api/evidence-pack/verify?hash={p.hash.slice(0, 12)}…</p>
    </div>
  );
}
