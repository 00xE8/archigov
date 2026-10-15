import React from "react";
import { useNavigate } from "react-router-dom";
import { Tile, Select, SelectItem, Button, Modal, TextInput, TextArea, InlineNotification, InlineLoading, Stack, SkeletonText, Table, TableHead, TableRow, TableHeader, TableBody, TableCell, TableContainer } from "@carbon/react";
import { Add, MachineLearningModel } from "@carbon/icons-react";
import { get, post, fmtDate, fmtDateTime } from "../api";
import { PageIntro, useLoad, LoadError, RLink, Empty, useDocTitle, OriginTag, useAiFeatures } from "../components";
import { Gated, useAuth } from "../auth";

const MetricsCharts = React.lazy(() => import("../metricsCharts"));
const PERIODS = [30, 90, 180, 365];
const d = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${n} d`);
const pct = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${n}%`);
const of = (a: number, b: number) => (b ? `${a} of ${b}` : "—");

function Figure({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return <Tile className="ag-figure"><span className="label">{label}</span><span className="value">{value}</span>{sub && <span className="sub">{sub}</span>}</Tile>;
}

/**
 * Governance metrics from the records — how fast reviews and decisions are decided and how often they recycle, how
 * conditions and exceptions age, how conformance trends and how fast findings are fixed, how much a named person
 * stands behind — over a stated period, and the board packs a chair or secretary prepares from them. Figures, never
 * verdicts: nothing here is coloured good or bad.
 */
export default function Metrics() {
  const [days, setDays] = React.useState(90);
  const [m, reload, err] = useLoad<any>(() => get(`/metrics?days=${days}`), [days]);
  const [packs, reloadPacks] = useLoad<any[]>(() => get<any[]>("/board-packs").catch(() => []));
  const [prepare, setPrepare] = React.useState(false);
  const { me } = useAuth();
  const nav = useNavigate();
  const prepares = (me?.user?.boards || []).some((b: any) => b.role === "chair" || b.role === "secretary");
  useDocTitle("Governance Metrics");
  if (err) return <LoadError what="governance metrics" err={err} onRetry={reload} />;
  const v = m?.coverage?.verification || {};
  return (
    <>
      <PageIntro title="Governance Metrics" lead="How the governance itself is performing, from the records: decision speed, recycling, ageing, conformance and who stands behind what."
        about="Every figure is a count, a median or a 90th percentile over records you can open, for the period stated. Lead time runs from submission to the declared outcome; recycling counts reviews sent back at least once; position latency runs from (re)submission to each position; time to fix runs from a finding's first sighting to its resolution. Nothing is coloured good or bad — the board decides what a figure means. A board pack signs a snapshot of these figures with the decisions, reviews, roadmap and register gaps of the period."
        actions={prepares ? <Button size="md" renderIcon={Add} onClick={() => setPrepare(true)}>Prepare Board Pack</Button> : undefined} />
      <div className="ag-toolbar-filters ag-mb-05">
        <Select id="m-days" labelText="Period" value={String(days)} onChange={(e) => setDays(Number(e.target.value))}>{PERIODS.map((p) => <SelectItem key={p} value={String(p)} text={`Last ${p} days`} />)}</Select>
      </div>
      {!m ? <SkeletonText paragraph lineCount={10} /> : <>
        <section className="ag-section"><h2>Reviews</h2>
          <div className="ag-figures">
            <Figure label="Decided" value={m.reviews.decided} sub={`${m.reviews.open} open · oldest ${d(m.reviews.oldest_open_days)}`} />
            <Figure label="Lead Time" value={d(m.reviews.lead_time_days.median)} sub={`median · 90th percentile ${d(m.reviews.lead_time_days.p90)}`} />
            <Figure label="Recycled" value={pct(m.reviews.recycle_rate)} sub="sent back at least once" />
            <Figure label="Fast Lane" value={of(m.reviews.fast_lane.via_fast_lane, m.reviews.fast_lane.approvals)} sub="approvals that rested on the fast lane" />
            <Figure label="Position Latency" value={d(m.reviews.position_latency_days.median)} sub={`median over ${m.reviews.position_latency_days.n} position${m.reviews.position_latency_days.n === 1 ? "" : "s"}`} />
          </div>
        </section>
        <section className="ag-section"><h2>Decisions, Conditions and Exceptions</h2>
          <div className="ag-figures">
            <Figure label="Decisions Accepted" value={m.decisions.accepted} sub={`median ${d(m.decisions.lead_time_days.median)} from draft · ${m.decisions.proposed} proposed`} />
            <Figure label="Realisation" value={`${m.decisions.realisation.realised} realised`} sub={`${m.decisions.realisation.in_progress} in progress · ${m.decisions.realisation.not_started} not started · ${m.decisions.realisation.not_checkable} not checkable`} />
            <Figure label="Conditions" value={`${m.conditions.overdue} overdue`} sub={`${m.conditions.open} open · ${m.conditions.met} met · on time ${pct(m.conditions.met_on_time_rate)}`} />
            <Figure label="Exceptions" value={`${m.exceptions.active} active`} sub={`${m.exceptions.expiring_30_days} expiring in 30 days · ${m.exceptions.without_expiry} without expiry`} />
          </div>
        </section>
        <section className="ag-section"><h2>Conformance and Coverage</h2>
          <div className="ag-figures">
            <Figure label="Open Findings" value={m.conformance.open} sub={`${m.conformance.opened} opened · ${m.conformance.resolved} resolved in the period`} />
            <Figure label="Time to Fix" value={d(m.conformance.time_to_fix_days.median)} sub={`median · 90th percentile ${d(m.conformance.time_to_fix_days.p90)}`} />
            <Figure label="Human Verified" value={of(v.applications?.verified ?? 0, v.applications?.total ?? 0)} sub={`applications · ${of(v.decisions?.verified ?? 0, v.decisions?.total ?? 0)} decisions`} />
            <Figure label="Classified" value={of(m.coverage.classification.classified, m.coverage.classification.total)} sub={`${m.coverage.classification.verified} verified by a person`} />
            <Figure label="Legacy Assessments" value={of(m.coverage.legacy_assessments.current, m.coverage.legacy_assessments.needed)} sub={<RLink to="/legacy">in date</RLink>} />
            <Figure label="Exit Plans" value={of(m.coverage.exit_plans.current, m.coverage.exit_plans.needed)} sub={<RLink to="/third-parties">in date</RLink>} />
          </div>
        </section>
        <React.Suspense fallback={<SkeletonText paragraph lineCount={6} />}><MetricsCharts m={m} /></React.Suspense>
      </>}

      <section className="ag-section">
        <h2>Board Packs</h2>
        <p className="ag-muted ag-body ag-mb-03">Signed snapshots of the figures, the decisions and reviews of the period, the roadmap's Now lane and the register gaps — verifiable like the evidence pack. A board's chair or secretary prepares them.</p>
        {!packs ? <SkeletonText /> : packs.length === 0 ? <Empty>No board pack yet.{prepares ? " Prepare one for the next sitting." : ""}</Empty> : (
          <TableContainer><Table size="md" aria-label="Board packs">
            <TableHead><TableRow><TableHeader>Board Pack</TableHeader><TableHeader>Period</TableHeader><TableHeader>Narrative</TableHeader><TableHeader>Prepared By</TableHeader><TableHeader>Hash</TableHeader></TableRow></TableHead>
            <TableBody>{packs.map((p) => (
              <TableRow key={p.id}>
                <TableCell><RLink to={`/board-packs/${p.hash}`}>{p.title}</RLink>{p.board_code && <div className="ag-muted ag-label">{p.board_code}</div>}</TableCell>
                <TableCell>{fmtDate(p.from_at)} – {fmtDate(p.to_at)}</TableCell>
                <TableCell>{p.narrative_origin ? <OriginTag origin={p.narrative_origin === "ai_assisted" ? "ai" : "human"} /> : <span className="ag-muted">None</span>}</TableCell>
                <TableCell>{p.created_by_name || p.created_by}<div className="ag-muted ag-label">{fmtDateTime(p.created_at)}</div></TableCell>
                <TableCell><span className="ag-mono">{p.hash.slice(0, 12)}…</span></TableCell>
              </TableRow>))}</TableBody>
          </Table></TableContainer>)}
      </section>
      {prepare && <PrepareModal days={days} onClose={() => setPrepare(false)} onDone={(hash) => { setPrepare(false); reloadPacks(); nav(`/board-packs/${hash}`); }} />}
    </>
  );
}

/** Prepare a board pack: the period, an optional title and board, and the narrative — the preparer's own, perhaps drafted by AI first. */
function PrepareModal({ days, onClose, onDone }: { days: number; onClose: () => void; onDone: (hash: string) => void }) {
  const { me } = useAuth();
  const aiOn = useAiFeatures();
  const myBoards = (me?.user?.boards || []).filter((b: any) => b.role === "chair" || b.role === "secretary");
  const [period, setPeriod] = React.useState(days);
  const [title, setTitle] = React.useState("");
  const [board, setBoard] = React.useState(myBoards[0]?.id || "");
  const [narrative, setNarrative] = React.useState("");
  const [aiUsed, setAiUsed] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const draft = async () => { setBusy("ai"); setErr(null); try { const r: any = await post("/board-packs/draft-narrative", { days: period }); setNarrative(r.narrative_md); setAiUsed(true); } catch (e: any) { setErr(String(e.message || e)); } finally { setBusy(null); } };
  const save = async () => { setBusy("save"); setErr(null); try { const r: any = await post("/board-packs", { days: period, title: title.trim() || undefined, board_id: board || null, narrative_md: narrative.trim() || null, narrative_origin: aiUsed ? "ai_assisted" : "human" }); onDone(r.hash); } catch (e: any) { setErr(String(e.message || e)); } finally { setBusy(null); } };
  return (
    <Modal open size="lg" modalHeading="Prepare Board Pack" primaryButtonText={busy === "save" ? "Signing…" : "Sign Board Pack"} secondaryButtonText="Cancel" primaryButtonDisabled={!!busy} onRequestClose={onClose} onRequestSubmit={save}>
      <Stack gap={5}>
        <p className="ag-body">The pack is built from the records for the period, signed with the instance key and anchored to the audit chain, so anyone can check later that it is what Archigov held. The narrative is the only part you write; it is recorded under your name{aiUsed ? ", marked as AI-assisted" : ""}.</p>
        <div className="ag-row">
          <Select id="bp-days" labelText="Period" value={String(period)} onChange={(e) => setPeriod(Number(e.target.value))}>{PERIODS.map((p) => <SelectItem key={p} value={String(p)} text={`Last ${p} days`} />)}</Select>
          <Select id="bp-board" labelText="Board" value={board} onChange={(e) => setBoard(e.target.value)} helperText="Reviews in the pack are this board's; the other figures are tenant-wide.">
            <SelectItem value="" text="All boards" />{myBoards.map((b: any) => <SelectItem key={b.id} value={b.id} text={b.name} />)}</Select>
        </div>
        <TextInput id="bp-title" labelText="Title (optional)" placeholder="e.g. Design Authority — October" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
        <div className="ag-row between"><span className="cds--label">Narrative (optional)</span>
          {busy === "ai" ? <InlineLoading description="Drafting from the figures" /> : <Gated cap="manage_board" allowed={aiOn.draft_board_narrative === true} reason="AI Board Pack Narrative is not enabled for this instance — a platform admin can switch it on under Settings · AI"><Button size="sm" kind="tertiary" renderIcon={MachineLearningModel} onClick={draft}>Draft with AI</Button></Gated>}</div>
        <TextArea id="bp-narrative" labelText="Narrative" hideLabel rows={8} value={narrative} onChange={(e) => setNarrative(e.target.value)} helperText="What the board should take from the figures. A draft from AI states only what the figures say; you submit it as your own." />
        {err && <InlineNotification kind="error" lowContrast hideCloseButton title="Not signed" subtitle={err} />}
      </Stack>
    </Modal>
  );
}
