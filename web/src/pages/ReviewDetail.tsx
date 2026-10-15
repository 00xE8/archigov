import React from "react";
import { useParams } from "react-router-dom";
import { Button, SkeletonText, Modal, TextArea, Select, SelectItem, TextInput, Checkbox, ProgressIndicator, ProgressStep, Table, TableHead, TableRow, TableHeader, TableBody, TableCell, RadioButtonGroup, RadioButton, MultiSelect, FilterableMultiSelect, InlineNotification, InlineLoading, Tag } from "@carbon/react";
import { MachineLearningModel, Send, Checkmark, Add, ThumbsUp, Edit, Renew, Link as LinkIcon, ChevronDown, ChevronUp } from "@carbon/icons-react";
import { get, post, put, fmtDate, fmtDateTime, labelFor, sentence, currentUser, areaLabel, POSITIONS, RESOLUTIONS, ASSESSMENT_TYPES, ASSESSMENT_RESULTS } from "../api";
import { PageHeader, useLoad, useAiFeatures, VerificationTag, VerifyButton, Markdown, SeverityTag, Empty, OriginTag, LoadError, RLink, Crumbs, StatusTag, DateField, CitationLink, KindTag, targetLink, AreaTag, AreaPositionTag, artefactLink, progressText, progressShort, useDocTitle } from "../components";
import { Gated, useCan, useAuth } from "../auth";
import { DeclareModal, newCondition, DeclareCondition } from "../components/DeclareModal";

/** The pre-review's recommendation as a status key: "request changes" → request_changes. */
const recKey = (s: any) => String(s || "").trim().toLowerCase().replace(/\s+/g, "_");

// The submission template's section hints. A section whose body is still the hint (or empty) was not written.
const HINTS: Record<string, string> = {
  Design: "What is being built or changed, and how it fits the current estate.",
  Data: "What data is involved, where it lives, who can see it.",
  Security: "Identity, network exposure, secrets.",
  Resilience: "Availability, backup, failure modes.",
};
const OPEN_STAGES = ["submitted", "pre_review", "in_review", "changes_requested"];
// Positions may still be recorded while an approval circulates to the areas that were absent.
const ACTIVE_STAGES = [...OPEN_STAGES, "approved_subject_to_circulation"];
const TOPICS = ["general", "hosting", "data-store", "integration", "ai-system", "security", "identity", "resilience"];
const POSITION_HELP: Record<string, string> = { yes: "The area is content; the item can proceed as far as this area is concerned.", no: "The area objects; the item goes back to the submitter as changes requested.", conditional: "Yes if the condition is met. The item stays open until the chair resolves the condition and explains how.", not_my_area: "This area was derived wrongly; it is dropped from the item with your reason." };
// Event kinds as the server writes them: declare events are named by verb (approve, defer, refer…), a count-mode position is an "approval".
const EVENT_LABELS: Record<string, string> = { position: "Position recorded", approval: "Approval recorded", position_resolved: "Conditional resolved", dependency_created: "Dependent decision created", dependency_rejected: "Dependent decision rejected", became_effective: "Became effective", consent_declared: "Declared on the consent agenda", approve: "Outcome declared", request_changes: "Changes requested", defer: "Deferred", deferred: "Deferred", refer: "Referred", referred: "Referred", reject: "Rejected", withdraw: "Withdrawn", resubmitted: "Resubmitted", circulation_objection: "Objection in circulation", areas_changed: "Areas changed", patterns_changed: "Patterns claimed", declared: "Outcome declared", decided: "Outcome declared", assessment_requested: "Assessment requested", assessment_completed: "Assessment result recorded", assessment_waived: "Assessment waived" };
const asAreas = (list: any): { id: string; label: string }[] => (Array.isArray(list) ? list.map((a) => (typeof a === "string" ? { id: a, label: areaLabel(a) } : { id: a.id, label: a.label || areaLabel(a.id) })) : []);

export default function ReviewDetail() {
  const { id } = useParams();
  const { me } = useAuth();
  const [r, reload, err] = useLoad<any>(() => get(`/reviews/${id}`), [id]);
  // Owner ids on the areas resolve to names through the board's members; the board also supplies area labels on an older review shape.
  const boardId: string | undefined = r?.board?.id;
  const [board] = useLoad<any>(() => (boardId ? get(`/boards/${boardId}`).catch(() => null) : Promise.resolve(null)), [boardId]);
  const [comment, setComment] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);
  // AI prefill for assessment summaries — a draft into the open modal's textarea, nothing stored; shown only when enabled
  const aiOn = useAiFeatures();
  const draftSummary = async (type: string) => {
    setBusy("ai-draft");
    try { const r: any = await post(`/reviews/${id}/assessments/draft`, { type }); setModal((cur: any) => cur ? { ...cur, text: r.result_md } : cur); }
    catch (e: any) { setErr2(String(e.message || e).split("\n")[0]); setModal(null); }
    finally { setBusy(null); }
  };
  const [modal, setModal] = React.useState<any>(null);
  const [err2, setErr2] = React.useState<string | null>(null);
  const needDecisions = modal?.kind === "resolve" || modal?.kind === "dependency";
  const [decisions] = useLoad<any[] | null>(() => (needDecisions ? get<any[]>("/decisions").catch(() => []) : Promise.resolve(null)), [needDecisions]);
  // the assessor picker: loaded when the request modal opens; auditors and service accounts cannot assess
  const needUsers = modal?.kind === "assess_request";
  const needPatterns = modal?.kind === "patterns";
  const [adoptedPatterns] = useLoad<any[] | null>(() => (needPatterns ? get<any[]>("/artefacts?kind=pattern").then((l) => l.filter((a) => a.lifecycle === "adopted")).catch(() => []) : Promise.resolve(null)), [needPatterns]);
  // one template per assessment type (served by the API): the summary's skeleton for both recording and providing
  const [assessTypes] = useLoad<any[] | null>(() => get<any[]>("/assessments/types").catch(() => null));
  const tpl = (t: string) => (assessTypes || []).find((x: any) => x.type === t)?.template || "";
  const [users] = useLoad<any[] | null>(() => (needUsers ? get<any[]>("/users").catch(() => []) : Promise.resolve(null)), [needUsers]);
  const assessors = (users || []).filter((u) => u.user_type !== "auditor" && u.user_type !== "service");
  const mayDecideGlobal = useCan("decide_review");
  useDocTitle(r ? r.code : null);
  if (err) return <LoadError what="this review" err={err} onRetry={reload} />;
  if (!r) return <SkeletonText paragraph lineCount={8} />;
  const type: string = r.type || "design";
  const open = OPEN_STAGES.includes(r.stage);
  const active = ACTIVE_STAGES.includes(r.stage);
  const myId = me?.user?.id || currentUser();
  // The signed-in identity is the truth; currentUser() is a dev-mode fallback whose default would otherwise make everyone "the submitter" on that user's reviews.
  const isSubmitter = me?.user ? me.user.id === r.submitted_by : currentUser() === r.submitted_by;
  // Per-review verdicts from the API win; an older server gives none, so the global capability stands in.
  const can = r.can || {};
  const why = r.why || {};
  const areasMode = r.progress?.mode === "areas";
  const progressAreas: any[] = areasMode ? r.progress.areas || [] : [];
  const boardAreas = asAreas(r.areas?.board_areas || board?.areas);
  const members: any[] = board?.members || [];
  const positions: any[] = r.positions || [];
  const nameOf = (uid?: string | null) => (!uid ? "—" : members.find((m) => m.user_id === uid)?.name || positions.find((p) => p.user_id === uid)?.name || uid);
  const canDecide = open && !isSubmitter && (can.decide !== undefined ? can.decide : mayDecideGlobal);
  const canApprove = open && !isSubmitter && can.approve === true;
  // The server's own verdict; an older server without `request_changes` still implies it for an approver.
  const canRequestChanges = open && !isSubmitter && (can.request_changes === true || (can.request_changes === undefined && can.approve === true));
  const canResubmit = r.stage === "changes_requested" && (can.resubmit === true || isSubmitter);
  const canRecord = active && !isSubmitter && can.record_position === true;
  // Areas this person owns (owners include delegates in an open session); when the server does not say, the modal offers every touched area.
  const myAreas = progressAreas.filter((a) => (a.owners || []).includes(myId));
  const recordable = (myAreas.length ? myAreas : progressAreas).filter((a) => a.state !== "not_my_area");
  const declareOutcomes: string[] | undefined = Array.isArray(can.declare_outcomes) ? can.declare_outcomes : undefined;
  const canDeclare = declareOutcomes ? active && declareOutcomes.length > 0 : canDecide;
  const onlyWithdraw = !!declareOutcomes && declareOutcomes.length === 1 && declareOutcomes[0] === "withdrawn";
  // Someone with a seat on the board but not the vote sees the action disabled and which seat it needs; everyone else does not see it at all.
  const boardName: string = r.board?.name || "the review's board";
  const mySeat: string | undefined = r.board ? (me?.user?.boards || []).find((b) => b.id === r.board.id || b.code === r.board.code)?.role : undefined;
  const seatGate = (ok: boolean, cap: string, reason: string, button: React.ReactElement<any>) => ok ? button : active && !isSubmitter && mySeat ? <Gated cap={cap} allowed={false} reason={reason}>{button}</Gated> : null;
  const events: any[] = r.events || [];
  const lastPre = [...events].reverse().find((e: any) => e.kind === "pre_review");
  const decided = [...events].reverse().find((e: any) => /decid|declar|approv|reject/i.test(String(e.kind)));
  const run = async (key: string, fn: () => Promise<any>) => { setBusy(key); setErr2(null); try { await fn(); reload(); } catch (e: any) { setErr2(String(e.message || e).split("\n")[0]); } finally { setBusy(null); } };
  const openDeclare = (initial?: { outcome?: string; conditions?: DeclareCondition[] }) => setModal({ kind: "declare", initial });
  // From a pre-review suggestion: open the declare modal with that condition included (and approved with conditions chosen).
  const addCondition = (text: string) => setModal((cur: any) => {
    const suggested: string[] = lastPre?.data?.suggested_conditions || [];
    const base: DeclareCondition[] = cur?.kind === "declare" ? cur.initial?.conditions || [] : suggested.map((t) => newCondition(t, r.submitted_by));
    const conditions = base.some((c) => c.text === text) ? base : [...base, newCondition(text, r.submitted_by)];
    return { kind: "declare", initial: { outcome: "approved_with_conditions", conditions } };
  });
  const target = r.target || (r.application ? { kind: "application", id: r.application.id, name: r.application.name } : r.decision ? { kind: "decision", id: r.decision.id, code: r.decision.code } : null);
  const tLink = targetLink(target);
  const outstanding: string = areasMode ? progressText(r.progress) : (r.progress?.outstanding || []).map((o: any) => `${o.step}${o.missing ? `: ${o.missing}` : ""}`).join(" · ");
  const decideReason = !active ? "This review is closed" : isSubmitter && !onlyWithdraw ? "Submitters cannot decide their own review" : why.decide || (can.decide === false ? (outstanding && mySeat === "chair" ? `Not yet: ${outstanding} outstanding` : `Needs the chair of ${boardName}${outstanding ? ` — ${outstanding} outstanding` : ""}`) : undefined);
  const pendingDeps: any[] = (r.dependencies || []).filter((d: any) => !d.resolved_state);
  const missingAreas = progressAreas.filter((a) => a.state === "missing");
  const liveFor = (a: any) => positions.find((p) => p.id === a.position_id) || positions.find((p) => p.area === a.area && !p.superseded);
  const earlierFor = (a: any) => positions.filter((p) => p.area === a.area && p.superseded);
  // The latest pre-review's verdict: the server's summary when it sends one, else the last pre-review event's.
  const preRec: string | null = r.pre_review?.recommendation || lastPre?.data?.recommendation || null;
  // The decision step's seat on this board sees Declare greyed with the reason; anyone else without the right does not see it.
  const decisionSeat = mySeat === "chair";
  // One line that answers "who is this waiting on": missing positions by owner, unresolved conditionals, open assessments.
  const openAssessments: any[] = (r.assessments || []).filter((a: any) => a.status === "requested");
  const waitingOn: React.ReactNode = (() => {
    if (!active) return null;
    if (r.progress?.via_fast_lane) return <>In the fast lane — nothing outstanding; ready for the chair to declare.</>;
    if (r.stage === "changes_requested") return <>Waiting on <span className="ag-strong">{r.submitted_by_name || r.submitted_by}</span> to revise and resubmit.</>;
    const parts: React.ReactNode[] = [];
    if (areasMode && missingAreas.length) {
      const named = missingAreas.map((a) => `${a.label || areaLabel(a.area, boardAreas)} (${(a.owners || []).length ? a.owners.map((u: string) => `${nameOf(u)}${u === myId ? " — you" : ""}`).join(", ") : "no owner"})`);
      parts.push(<React.Fragment key="pos">positions on {named.join(", ")}</React.Fragment>);
    }
    const conditionals = progressAreas.filter((a) => a.state === "conditional");
    if (conditionals.length) parts.push(<React.Fragment key="cond">the chair resolving the conditional on {conditionals.map((a) => a.label || areaLabel(a.area, boardAreas)).join(", ")}</React.Fragment>);
    if (!areasMode && outstanding) parts.push(<React.Fragment key="out">{outstanding}</React.Fragment>);
    if (openAssessments.length) parts.push(<React.Fragment key="as">the {openAssessments.map((a) => `${labelFor("assessment_type", a.type).toLowerCase()} assessment (${a.assigned_to_name || a.assigned_to})`).join(" and ")}</React.Fragment>);
    if (!parts.length) return r.stage === "approved_subject_to_circulation" ? null : <>Nothing outstanding — ready for the chair to declare.</>;
    return <>Waiting on {parts.map((p, i) => <React.Fragment key={i}>{i > 0 ? "; " : ""}{p}</React.Fragment>)}.</>;
  })();

  // the row actions an area offers this viewer; with none anywhere the column is dropped, so the table fits its half of the page
  const areaActions = (a: any) => ({
    canRow: canRecord && (myAreas.length === 0 || (a.owners || []).includes(myId)) && a.state !== "not_my_area",
    canResolve: can.resolve === true && a.state === "conditional" && !!(liveFor(a)?.id || a.position_id),
  });
  const anyAreaAction = progressAreas.some((a) => { const x = areaActions(a); return x.canRow || x.canResolve; });
  const fastLane = r.progress?.fast_lane ? <FastLaneSection fl={r.progress.fast_lane} via={!!r.progress.via_fast_lane} canEdit={isSubmitter && (open || r.stage === "changes_requested")} onEdit={() => setModal({ kind: "patterns", selected: (r.patterns || r.progress.fast_lane.patterns).map((p: any) => p.id) })} /> : null;

  return (
    <>
      <PageHeader breadcrumb={<Crumbs items={[{ to: "/reviews", label: "Reviews" }, { label: r.code }]} />} title={`${r.code} · ${r.title}`}
        about="A review is pre-reviewed automatically, then satisfied by its board's policy: in areas mode every touched area needs a yes, or a conditional the chair has resolved, from the decision maker who owns it; the chair declares the outcome the positions allow and never votes. Submitters cannot decide their own review."
        subtitle={<span className="ag-row snug">
          <KindTag kind="review_type" value={type} size="md" /><StatusTag kind="stage" value={r.stage} size="md" />{type === "design" && r.risk_tier && <StatusTag kind="risk" value={r.risk_tier} size="md" />}{r.impact && <KindTag kind="impact" value={r.impact} size="md" />}
          {preRec && <StatusTag kind="recommendation" value={recKey(preRec)} size="md" label={`Pre-review: ${sentence(preRec).toLowerCase()}`} />}
          {/* The session the item is listed on (or was declared at): a status tag that is also the way there. */}
          {r.session && (r.session.id ? <RLink to={`/sessions/${r.session.id}`} aria-label={`Session ${r.session.code}`}><StatusTag kind="session_status" value={r.session.status} size="md" label={`${r.session.code} · ${labelFor("session_status", r.session.status)}`} /></RLink> : <StatusTag kind="session_status" value={r.session.status} size="md" label={`${r.session.code} · ${labelFor("session_status", r.session.status)}`} />)}
        </span>}
        actions={active ? <>
          {open && <Gated cap="pre_review"><Button size="md" kind="tertiary" renderIcon={MachineLearningModel} disabled={busy === "pre"} onClick={() => run("pre", () => post(`/reviews/${r.id}/pre-review`))}>Run Pre-review</Button></Gated>}
          {/* Seat-specific: each action appears only for the seat that holds it. The chair has no vote, so Record position is never shown greyed. */}
          {areasMode
            ? <>
              {canRecord && <Button size="md" kind="secondary" renderIcon={ThumbsUp} onClick={() => setModal({ kind: "position", area: recordable[0]?.area || "", position: "yes", text: "" })}>Record Position</Button>}
              {/* The advisory seat sends an item back without holding an area; owners record a no on their area instead. */}
              {!canRecord && canRequestChanges && <Button size="md" kind="tertiary" renderIcon={Edit} onClick={() => setModal({ kind: "vote", decision: "request_changes", comment: "" })}>Request Changes</Button>}
            </>
            : <>
              {seatGate(canApprove, "approve_review", why.approve || `Needs a decision maker's seat on ${boardName}`, <Button size="md" kind="secondary" renderIcon={ThumbsUp} onClick={() => setModal({ kind: "vote", decision: "approve", comment: "" })}>Approve</Button>)}
              {canRequestChanges && <Button size="md" kind="tertiary" renderIcon={Edit} onClick={() => setModal({ kind: "vote", decision: "request_changes", comment: "" })}>Request Changes</Button>}
            </>}
          {canResubmit && <Button size="md" kind="tertiary" renderIcon={Renew} disabled={busy === "resubmit"} onClick={() => run("resubmit", () => post(`/reviews/${r.id}/resubmit`))}>Resubmit</Button>}
          {/* Declare: live for whoever may declare now; greyed with the reason for the decision seat that may not yet; absent for everyone else. */}
          {(canDeclare || (decisionSeat && !isSubmitter)) && <Gated cap="decide_review" allowed={canDeclare} reason={decideReason}><Button size="md" kind={onlyWithdraw ? "tertiary" : "primary"} renderIcon={Checkmark} onClick={() => openDeclare()}>{onlyWithdraw ? "Withdraw" : "Declare outcome"}</Button></Gated>}
        </> : null} />
      {/* The review's facts, structured instead of a run-on sentence: what it is for, whose board, who submitted, how it ended. */}
      <dl className="ag-facts">
        {target && <div><dt>For</dt><dd>{tLink ? <RLink inline to={tLink}>{target.code ? `${target.code}${target.name ? ` · ${target.name}` : ""}` : target.name}</RLink> : target.name}</dd></div>}
        {r.board && <div><dt>Board</dt><dd><RLink inline to={`/boards/${r.board.id}`}>{r.board.name}</RLink></dd></div>}
        <div><dt>Submitted By</dt><dd>{r.submitted_by_name || r.submitted_by} · {fmtDate(r.created_at)}</dd></div>
        {(r.patterns || []).length > 0 && <div><dt>Follows</dt><dd>{r.patterns.map((p: any, i: number) => <React.Fragment key={p.id}>{i > 0 ? ", " : ""}<RLink inline to={artefactLink(p.id)}>{p.code}</RLink></React.Fragment>)}</dd></div>}
        {r.decision && type !== "decision" && <div><dt>Decision</dt><dd><RLink inline to={`/decisions/${r.decision.id}`}>{r.decision.code}</RLink></dd></div>}
        {r.deferred_count > 0 && <div><dt>Deferred</dt><dd>{r.deferred_count} time{r.deferred_count === 1 ? "" : "s"}{r.deferred_reason ? ` (${r.deferred_reason})` : ""}</dd></div>}
        {!active && decided && <div><dt>Declared By</dt><dd>{nameOf(decided.actor)} · {fmtDateTime(decided.created_at)}</dd></div>}
      </dl>
      {err2 && <InlineNotification kind="error" lowContrast className="ag-notice" title="That did not work" subtitle={err2} onCloseButtonClick={() => setErr2(null)} />}
      {r.stage === "approved_pending_dependencies" && (
        <InlineNotification kind="info" lowContrast hideCloseButton className="ag-notice" title={pendingDeps.length ? `Effective once ${pendingDeps.map((d: any) => d.decision?.code || "a dependent decision").join(", ")} ${pendingDeps.length === 1 ? "is" : "are"} decided` : "Effective once its dependent decisions are decided"}
          subtitle={r.pending_outcome ? `Pending outcome: ${labelFor("outcome", r.pending_outcome).toLowerCase()}.` : undefined}>
          {/* Carbon forbids interactive children inside a notification; the links to the decisions are in the Dependencies section below. */}
        </InlineNotification>)}
      {r.stage === "approved_subject_to_circulation" && (
        <InlineNotification kind="info" lowContrast hideCloseButton className="ag-notice" title={`Approved subject to circulation · positions due ${fmtDate(r.circulation_due)}`}
          subtitle={missingAreas.length ? `Awaiting ${missingAreas.map((a) => `${a.label || areaLabel(a.area, boardAreas)}${(a.owners || []).length ? ` (${a.owners.map((u: string) => nameOf(u)).join(", ")})` : ""}`).join(", ")}. A no brings the item back to the next session; the last yes makes it effective.` : "Every area has now recorded a position."} />)}

      {r.policy?.steps?.length ? <Workflow r={r} /> : null}
      {waitingOn && <p className="ag-waiting">{waitingOn}</p>}

      {/* Two blocks side by side: what was submitted, and what the board is doing about it. The how-it-unfolded timeline runs full-width below. */}
      <div className="ag-grid-2">
        <div>
          <p className="ag-colhead">Submission</p>
          <section className="ag-section"><h2>Summary</h2><p className="ag-body">{r.summary || <span className="ag-muted">Not provided</span>}</p></section>
          {type === "design" && <section className="ag-section"><h2>Design</h2><DesignSections md={r.design_md} /></section>}
          {type !== "design" && r.artefact && <section className="ag-section"><h2>{labelFor("kind", r.artefact.kind || type)} under review</h2>
            <dl className="ag-kv">
              <dt>Item</dt><dd><RLink to={targetLink({ kind: r.artefact.kind || type, id: r.artefact.id }) || "/governance"}>{r.artefact.code} · {r.artefact.title}</RLink>{r.artefact.version ? <span className="ag-muted"> · version {r.artefact.version}</span> : null}</dd>
              {r.artefact.statement && <><dt>Statement</dt><dd>{r.artefact.statement}</dd></>}
              {r.artefact.lifecycle && <><dt>Lifecycle</dt><dd><StatusTag kind="lifecycle" value={r.artefact.lifecycle} /></dd></>}
            </dl></section>}
          {(r.workItems || []).length > 0 && <section className="ag-section"><h2>Requirements ({r.workItems.length})</h2>
            <Table size="sm"><TableHead><TableRow><TableHeader>Work Item</TableHeader><TableHeader>State</TableHeader></TableRow></TableHead>
              <TableBody>{r.workItems.map((w: any) => <TableRow key={w.id}>
                <TableCell><span className="ag-strong">{w.type} {w.external_id} · {w.title}</span><div className="ag-muted ag-label ag-wrap">{w.description}</div></TableCell>
                <TableCell>{w.material_change ? <StatusTag kind="attention" value="changed" /> : <StatusTag kind="work" value={w.state} />}</TableCell>
              </TableRow>)}</TableBody></Table></section>}
          {/* The how-it-unfolded record sits under the submission it narrates, beside the board's verdict. */}
          <p className="ag-colhead ag-mt-06">Activity</p>
          <section className="ag-section"><h2>Timeline</h2>
            <ul className="ag-timeline">{events.map((e: any) => (
              <li key={e.id} className={e.origin === "ai" ? "ai" : ""}>
                <div className="meta ag-row snug">{fmtDateTime(e.created_at)} · {e.actor} · {(EVENT_LABELS[e.kind] || sentence(e.kind)).toLowerCase()}{e.session_id ? <> · in <RLink to={`/sessions/${e.session_id}`}>{r.session?.id === e.session_id ? r.session.code : e.session_code || "session"}</RLink></> : null} <OriginTag origin={e.origin} />{e.kind === "pre_review" && e.origin === "ai" && <VerificationTag state={e.verification} origin={e.origin} by={e.verified_by} at={e.verified_at} />}</div>
                {e.kind === "pre_review" ? <PreReview e={e} folded={!!lastPre && e.id !== lastPre.id} onDone={reload} onAdd={canDeclare && type === "design" ? addCondition : undefined} /> : <EventBody e={e} boardAreas={boardAreas} nameOf={nameOf} />}
              </li>))}</ul>
            {active && <div className="ag-form ag-mt-05"><TextArea id="c" labelText="Comment" rows={2} value={comment} onChange={(e) => setComment(e.target.value)} /><div><Gated cap="comment" allowed={can.comment === undefined ? undefined : can.comment}><Button size="sm" kind="secondary" renderIcon={Send} disabled={!comment.trim() || busy === "c"} onClick={() => run("c", async () => { await post(`/reviews/${r.id}/comment`, { body: comment }); setComment(""); })}>Add Comment</Button></Gated></div></div>}
          </section>
        </div>
        <div>
          <p className="ag-colhead">Board Record</p>
          {/* In the lane, the lane is the record that matters and leads; out of it, the positions lead and the lane says briefly why not. */}
          {r.progress?.fast_lane?.eligible && fastLane}
          {areasMode ? (
            <section className="ag-section">
              {/* One action language on the page: section-header actions are tertiary, in-row actions are ghost. */}
              <div className="ag-row between"><h2>Areas &amp; Positions ({progressAreas.length})</h2>{can.edit_areas && active && <Button size="sm" kind="tertiary" renderIcon={Edit} onClick={() => setModal({ kind: "areas", selected: r.areas?.touched || progressAreas.map((a) => a.area) })}>Edit Areas</Button>}</div>
              {r.areas?.origin === "human" && <p className="ag-muted ag-label ag-mb-03">Areas set by hand{(r.areas.derived || []).length ? ` · derived: ${r.areas.derived.map((a: string) => areaLabel(a, boardAreas)).join(", ")}` : ""}</p>}
              {(r.progress?.advisory_objections || []).map((o: any) => (
                <div className="ag-finding" key={o.position_id}>
                  <div className="ag-row snug"><StatusTag kind="approval" value="request_changes" /><span className="title">{nameOf(o.by)}</span><KindTag kind="board_role" value={o.board_role} /><span className="ag-muted ag-label">{fmtDateTime(o.at)} · advisory: sends the item back, counts for no area</span></div>
                  {o.text && <div className="detail">{o.text}</div>}
                </div>))}
              {progressAreas.length === 0 ? <Empty>No areas touched. Run a pre-review to derive them, or set them by hand.</Empty> : (
              <Table size="sm"><TableHead><TableRow><TableHeader>Area</TableHeader><TableHeader>Position</TableHeader><TableHeader>Recorded By</TableHeader><TableHeader>Note</TableHeader>{anyAreaAction && <TableHeader>Actions</TableHeader>}</TableRow></TableHead>
                <TableBody>{progressAreas.map((a) => {
                  const live = liveFor(a); const earlier = earlierFor(a);
                  const { canRow, canResolve } = areaActions(a);
                  const findings = Array.isArray(a.findings) ? a.findings.length : a.findings_count;
                  return (<React.Fragment key={a.area}>
                    <TableRow>
                      <TableCell><AreaTag id={a.area} label={a.label} boardAreas={boardAreas} size="md" /></TableCell>
                      {/* A closed review awaits nobody: a position that was never recorded reads as history, not as outstanding work. */}
                      <TableCell><StatusTag kind="position" value={a.state || "missing"} label={!active && (a.state || "missing") === "missing" ? "Not recorded" : r.progress?.via_fast_lane && (a.state || "missing") === "missing" ? "Not required" : undefined}
                        explain={r.progress?.via_fast_lane && (a.state || "missing") === "missing" ? "In the fast lane no position is required; the owner may still record one, and a no or a conditional takes the item out of the lane." : undefined} /></TableCell>
                      <TableCell>{a.by
                        ? <><div>{nameOf(a.by)}{a.on_behalf_of ? <span className="ag-muted"> for {nameOf(a.on_behalf_of)}</span> : null}</div>{live?.at && <div className="ag-muted ag-label">{fmtDateTime(live.at)}</div>}</>
                        : <span className="ag-muted ag-label">owner{(a.owners || []).length === 1 ? "" : "s"}: {(a.owners || []).length ? a.owners.map((u: string) => nameOf(u)).join(", ") : "nobody"}</span>}</TableCell>
                      <TableCell className="ag-wrap">
                        {(a.text || live?.text) && <div>{a.text || live?.text}</div>}
                        {(a.state === "resolved" || live?.resolution) && <div className="ag-muted ag-label">Resolved by {nameOf(live?.resolved_by)}{live?.resolved_at ? ` on ${fmtDateTime(live.resolved_at)}` : ""}: {labelFor("resolution", live?.resolution || a.resolution).toLowerCase()}{live?.resolution_text ? ` — ${live.resolution_text}` : ""}</div>}
                        {earlier.length > 0 && <div className="ag-muted ag-label">Earlier: {earlier.map((p) => `${labelFor("position", p.position).toLowerCase()} by ${nameOf(p.user_id)} ${fmtDateTime(p.at)}`).join(" · ")}</div>}
                        {!(a.text || live?.text) && a.state !== "resolved" && !live?.resolution && !earlier.length && <span className="ag-muted">—</span>}
                      </TableCell>
                      {anyAreaAction && <TableCell><div className="ag-actions">
                        {canRow && <Button size="sm" kind="ghost" renderIcon={ThumbsUp} onClick={() => setModal({ kind: "position", area: a.area, position: "yes", text: "" })}>Record Position</Button>}
                        {canResolve && <Button size="sm" kind="ghost" renderIcon={Checkmark} onClick={() => setModal({ kind: "resolve", position: live || { id: a.position_id, area: a.area, text: a.text }, resolution: "accepted_condition", text: "", owner: r.submitted_by, due_at: "", decision_id: "", create: false, title: "", topic: "general" })}>Resolve</Button>}
                        {!canRow && !canResolve && <span className="ag-muted">—</span>}
                      </div></TableCell>}
                    </TableRow>
                    {/* Findings get the table's full width under their area instead of a cramped note cell. */}
                    {findings ? <TableRow className="ag-subrow"><TableCell colSpan={anyAreaAction ? 5 : 4}><AreaFindings a={a} /></TableCell></TableRow> : null}
                  </React.Fragment>);
                })}</TableBody></Table>)}
              <p className="ag-muted ag-label ag-mt-03">Each area needs a yes, or a conditional the chair has resolved, from the decision maker who owns it. The chair declares; the chair has no vote.</p>
            </section>)
            : Array.isArray(r.approvals) && <section className="ag-section"><h2>Approvals ({r.approvals.length})</h2>
              {r.approvals.length === 0 ? <Empty>{open ? "No approvals recorded yet." : "No approvals were recorded."}</Empty> : (
              <Table size="sm"><TableHead><TableRow><TableHeader>Decision</TableHeader><TableHeader>Member</TableHeader><TableHeader>Seat</TableHeader><TableHeader>When</TableHeader><TableHeader>Comment</TableHeader></TableRow></TableHead>
                <TableBody>{r.approvals.map((a: any, i: number) => <TableRow key={i}>
                  <TableCell><StatusTag kind="approval" value={a.decision} /></TableCell>
                  <TableCell>{a.name || a.user_id}</TableCell>
                  <TableCell><KindTag kind="board_role" value={a.board_role} /></TableCell>
                  <TableCell>{fmtDateTime(a.at)}</TableCell>
                  <TableCell className="ag-wrap">{a.comment || <span className="ag-muted">—</span>}</TableCell>
                </TableRow>)}</TableBody></Table>)}
            </section>}
          <AssessmentsSection r={r} active={active} myId={myId} boardAreas={boardAreas} setModal={setModal} tpl={tpl} />
          {r.progress?.fast_lane && !r.progress.fast_lane.eligible && fastLane}
          {((r.conditions || []).length > 0 || active) && <section className="ag-section"><h2>Conditions ({(r.conditions || []).length})</h2>
            {(r.conditions || []).length === 0 ? <Empty>No conditions.</Empty> : (
            <Table size="sm"><TableHead><TableRow><TableHeader>Condition</TableHeader><TableHeader>Area</TableHeader><TableHeader>Owner</TableHeader><TableHeader>Due</TableHeader><TableHeader>Status</TableHeader><TableHeader>Actions</TableHeader></TableRow></TableHead>
              <TableBody>{r.conditions.map((c: any) => <TableRow key={c.id}>
                <TableCell className="ag-wrap">{c.text}</TableCell>
                <TableCell>{c.area ? <AreaTag id={c.area} boardAreas={boardAreas} /> : <span className="ag-muted">—</span>}</TableCell>
                <TableCell>{c.owner || <span className="ag-muted">unassigned</span>}</TableCell>
                <TableCell>{fmtDate(c.due_at)}</TableCell>
                <TableCell><StatusTag kind="condition" value={c.status} /></TableCell>
                <TableCell>{(c.status === "open" || c.status === "overdue") ? <Gated cap="close_condition" mode="hide"><Button size="sm" kind="ghost" renderIcon={Checkmark} onClick={() => run(c.id, () => post(`/conditions/${c.id}/close`, { status: "met" }))}>Mark Met</Button></Gated> : <span className="ag-muted">—</span>}</TableCell>
              </TableRow>)}</TableBody></Table>)}
          </section>}
          {((r.dependencies || []).length > 0 || (r.dependents || []).length > 0 || (active && can.create_dependency)) && (
            <section className="ag-section">
              <div className="ag-row between"><h2>Dependencies</h2>{can.create_dependency && active && <Button size="sm" kind="tertiary" renderIcon={LinkIcon} onClick={() => setModal({ kind: "dependency", mode: "existing", decision_id: "", title: "", topic: "general", submit: true })}>Create Dependent Decision</Button>}</div>
              <h3 className="ag-mt-03">Depends On ({(r.dependencies || []).length})</h3>
              {(r.dependencies || []).length === 0 ? <Empty>No dependent decisions. {r.stage === "approved_pending_dependencies" ? "" : "An approval can be made pending a decision created from this item; it becomes effective when that decision is decided."}</Empty> : (
              <Table size="sm"><TableHead><TableRow><TableHeader>Decision</TableHeader><TableHeader>Status</TableHeader><TableHeader>Review</TableHeader></TableRow></TableHead>
                <TableBody>{(r.dependencies as any[]).map((d: any) => <TableRow key={d.id}>
                  <TableCell>{d.decision?.id ? <RLink to={`/decisions/${d.decision.id}`}>{d.decision.code} · {d.decision.title}</RLink> : d.decision?.code || "Decision"}</TableCell>
                  <TableCell><div className="ag-row tight">{d.decision?.status && <StatusTag kind="decision" value={d.decision.status} />}{d.resolved_state && <StatusTag kind="decision" value={d.resolved_state === "accepted" ? "accepted" : "rejected"} label={`Dependency ${d.resolved_state}`} />}</div></TableCell>
                  <TableCell>{d.review ? <div className="ag-row tight"><RLink to={`/reviews/${d.review.id}`}>{d.review.code}</RLink><StatusTag kind="stage" value={d.review.stage} size="sm" /></div> : <span className="ag-muted">—</span>}</TableCell>
                </TableRow>)}</TableBody></Table>)}
              {/* Only a decision review can block others (items approved pending the decision); other reviews get an empty list from the API. */}
              {Array.isArray(r.dependents) && (type === "decision" || r.dependents.length > 0) && <>
                <h3>Blocks ({r.dependents.length})</h3>
                {r.dependents.length === 0 ? <Empty>Nothing waits on this {type === "decision" ? "decision" : "review"}.</Empty> : (
                <Table size="sm"><TableHead><TableRow><TableHeader>Review</TableHeader><TableHeader>Stage</TableHeader></TableRow></TableHead>
                  <TableBody>{r.dependents.map((x: any, i: number) => { const rv = x.review || x; return <TableRow key={rv.id || i}><TableCell><RLink to={`/reviews/${rv.id}`}>{rv.code} · {rv.title}</RLink></TableCell><TableCell><StatusTag kind="stage" value={rv.stage} /></TableCell></TableRow>; })}</TableBody></Table>)}
              </>}
            </section>)}
        </div>
      </div>

      {modal?.kind === "vote" && (
        <Modal open modalHeading={modal.decision === "approve" ? `Approve ${r.code}` : `Request changes to ${r.code}`} primaryButtonText={modal.decision === "approve" ? "Record approval" : "Request changes"} secondaryButtonText="Cancel" danger={modal.decision === "request_changes"} primaryButtonDisabled={modal.decision === "request_changes" && !modal.comment.trim()} onRequestClose={() => setModal(null)}
          onRequestSubmit={() => { const v = modal; setModal(null); run("vote", () => post(`/reviews/${r.id}/approvals`, { decision: v.decision, comment: v.comment })); }}>
          <div className="ag-form">
            <p className="ag-body">{modal.decision === "approve" ? "Your approval counts towards the board's policy for this review; the chair declares once the policy is satisfied." : "The submitter is asked to revise and resubmit. Say what must change."}</p>
            <TextArea id="vc" labelText={modal.decision === "approve" ? "Comment (optional)" : "What must change"} rows={3} value={modal.comment} onChange={(e) => setModal({ ...modal, comment: e.target.value })} />
          </div>
        </Modal>)}

      {modal?.kind === "position" && (
        <Modal open modalHeading={`Record Position · ${r.code}`} primaryButtonText="Record Position" secondaryButtonText="Cancel" danger={modal.position === "no"} primaryButtonDisabled={!modal.area || (modal.position !== "yes" && !modal.text.trim()) || busy === "position"} onRequestClose={() => setModal(null)}
          onRequestSubmit={() => { const m = modal; setModal(null); run("position", () => post(`/reviews/${r.id}/positions`, { area: m.area, position: m.position, text: m.text.trim() || undefined })); }}>
          <div className="ag-form">
            <Select id="pos-area" labelText="Area" value={modal.area} onChange={(e) => setModal({ ...modal, area: e.target.value })}>
              {recordable.length === 0 && <SelectItem value="" text="No area left to record on" />}
              {recordable.map((a) => <SelectItem key={a.area} value={a.area} text={`${a.label || areaLabel(a.area, boardAreas)}${a.state && a.state !== "missing" ? ` · currently ${labelFor("position", a.state).toLowerCase()}` : ""}`} />)}
            </Select>
            <RadioButtonGroup legendText="Position" name="position" orientation="vertical" valueSelected={modal.position} onChange={(v) => setModal({ ...modal, position: String(v) })}>
              {POSITIONS.map((p) => <RadioButton key={p} id={`pos-${p}`} value={p} labelText={labelFor("position", p)} />)}
            </RadioButtonGroup>
            <p className="ag-muted ag-label">{POSITION_HELP[modal.position]}</p>
            <TextArea id="pos-text" labelText={modal.position === "yes" ? "Comment (optional)" : modal.position === "conditional" ? "The condition" : modal.position === "no" ? "What must change" : "Why this area does not apply"} rows={3} value={modal.text} onChange={(e) => setModal({ ...modal, text: e.target.value })} />
            <p className="ag-muted ag-label">You are recording as yourself; a delegate records on behalf of the seat. Recording again on the same area supersedes your earlier position.</p>
          </div>
        </Modal>)}

      {modal?.kind === "resolve" && (
        <Modal open size="lg" modalHeading={`Resolve the Conditional on ${areaLabel(modal.position?.area, boardAreas)}`} primaryButtonText="Resolve" secondaryButtonText="Cancel" primaryButtonDisabled={modal.text.trim().length < 10 || (modal.resolution === "dependent_decision" && (modal.create ? !modal.title.trim() : !modal.decision_id)) || busy === "resolve"} onRequestClose={() => setModal(null)}
          onRequestSubmit={() => {
            const m = modal; setModal(null);
            const body: any = { resolution: m.resolution, text: m.text.trim() };
            if (m.resolution === "accepted_condition") body.condition = { owner: m.owner || undefined, due_at: m.due_at || undefined };
            if (m.resolution === "dependent_decision") { if (m.create) body.create = { title: m.title.trim(), topic: m.topic }; else body.decision_id = m.decision_id; }
            run("resolve", () => post(`/positions/${m.position.id}/resolve`, body));
          }}>
          <div className="ag-form">
            {modal.position?.text && <p className="ag-body"><span className="ag-strong">Condition:</span> {modal.position.text}{modal.position.user_id ? <span className="ag-muted"> · {nameOf(modal.position.user_id)}</span> : null}</p>}
            <RadioButtonGroup legendText="How it is resolved" name="resolution" orientation="vertical" valueSelected={modal.resolution} onChange={(v) => setModal({ ...modal, resolution: String(v) })}>
              {RESOLUTIONS.map((x) => <RadioButton key={x} id={`res-${x}`} value={x} labelText={labelFor("resolution", x)} />)}
            </RadioButtonGroup>
            {modal.resolution === "accepted_condition" && <div className="ag-row end">
              <TextInput id="res-owner" labelText="Condition owner" value={modal.owner} onChange={(e) => setModal({ ...modal, owner: e.target.value })} />
              <DateField id="res-due" labelText="Due" value={modal.due_at} onChange={(ymd) => setModal({ ...modal, due_at: ymd })} />
            </div>}
            {modal.resolution === "dependent_decision" && <>
              <RadioButtonGroup legendText="Decision" name="res-dec-mode" valueSelected={modal.create ? "new" : "existing"} onChange={(v) => setModal({ ...modal, create: v === "new" })}>
                <RadioButton id="res-dec-existing" value="existing" labelText="Existing proposed decision" /><RadioButton id="res-dec-new" value="new" labelText="Create new" />
              </RadioButtonGroup>
              {modal.create
                ? <div className="ag-row end"><TextInput id="res-title" labelText="Title" placeholder="e.g. Key management for the referral service" value={modal.title} onChange={(e) => setModal({ ...modal, title: e.target.value })} /><Select id="res-topic" labelText="Topic" value={modal.topic} onChange={(e) => setModal({ ...modal, topic: e.target.value })}>{TOPICS.map((t) => <SelectItem key={t} value={t} text={labelFor("topic", t)} />)}</Select></div>
                : <Select id="res-decision" labelText="Proposed decision" value={modal.decision_id} onChange={(e) => setModal({ ...modal, decision_id: e.target.value })}><SelectItem value="" text={decisions ? "Choose a proposed decision" : "Loading"} />{(decisions || []).filter((d) => d.status === "proposed").map((d) => <SelectItem key={d.id} value={d.id} text={`${d.code} · ${d.title}`} />)}</Select>}
              <p className="ag-muted ag-label">A new decision is authored by the submitter and submitted for review on its own; this item is approved pending it and becomes effective when it is decided.</p>
            </>}
            <TextArea id="res-text" labelText="Explanation (recorded on the timeline and in the minutes; at least 10 characters)" rows={3} value={modal.text} onChange={(e) => setModal({ ...modal, text: e.target.value })} />
            <p className="ag-muted ag-label">A conditional is never overwritten: the resolution sits beside it, and the decision maker keeps the right to change to no until the session closes.</p>
          </div>
        </Modal>)}

      {modal?.kind === "areas" && (
        <Modal open modalHeading={`Areas Touched by ${r.code}`} primaryButtonText="Save Areas" secondaryButtonText="Cancel" primaryButtonDisabled={!modal.selected.length || busy === "areas"} onRequestClose={() => setModal(null)}
          onRequestSubmit={() => { const m = modal; setModal(null); run("areas", () => put(`/reviews/${r.id}/areas`, { areas: m.selected })); }}>
          <div className="ag-form">
            <MultiSelect id="areas-ms" titleText="Areas" label={modal.selected.length ? modal.selected.map((a: string) => areaLabel(a, boardAreas)).join(", ") : "Choose areas"} helperText={(r.areas?.derived || []).length ? `Derived from the item: ${r.areas.derived.map((a: string) => areaLabel(a, boardAreas)).join(", ")}` : "Nothing was derived; pick the areas this item touches."} items={boardAreas} itemToString={(x: any) => x?.label || ""} initialSelectedItems={boardAreas.filter((x) => modal.selected.includes(x.id))} onChange={({ selectedItems }: any) => setModal({ ...modal, selected: selectedItems.map((y: any) => y.id) })} />
            <p className="ag-muted ag-label">Each area set here needs its owner's position before the chair can declare. A hand-set list sticks: pre-review no longer re-derives it.</p>
          </div>
        </Modal>)}

      {modal?.kind === "patterns" && (
        <Modal open modalHeading={`Patterns ${r.code} Follows`} primaryButtonText="Save Patterns" secondaryButtonText="Cancel" primaryButtonDisabled={busy === "patterns" || !adoptedPatterns} onRequestClose={() => setModal(null)}
          onRequestSubmit={() => { const m = modal; setModal(null); run("patterns", () => put(`/reviews/${r.id}/patterns`, { patterns: m.selected })); }}>
          <div className="ag-form">
            {adoptedPatterns ? <FilterableMultiSelect id="patterns-ms" titleText="Adopted Patterns" placeholder="Filter patterns" helperText="Name only patterns the design really follows: a pattern with a rule is checked against the application, and reviewers judge the rest."
              items={adoptedPatterns} itemToString={(x: any) => (x ? `${x.code} · ${x.title}` : "")} selectedItems={adoptedPatterns.filter((x) => modal.selected.includes(x.id))}
              onChange={({ selectedItems }: any) => setModal({ ...modal, selected: selectedItems.map((y: any) => y.id) })} /> : <SkeletonText />}
          </div>
        </Modal>)}

      {modal?.kind === "dependency" && (
        <Modal open modalHeading={`Dependent Decision for ${r.code}`} primaryButtonText="Link Decision" secondaryButtonText="Cancel" primaryButtonDisabled={(modal.mode === "new" ? !modal.title.trim() : !modal.decision_id) || busy === "dependency"} onRequestClose={() => setModal(null)}
          onRequestSubmit={() => { const m = modal; setModal(null); run("dependency", () => post(`/reviews/${r.id}/dependencies`, m.mode === "new" ? { create: { title: m.title.trim(), topic: m.topic }, submit: m.submit } : { decision_id: m.decision_id })); }}>
          <div className="ag-form">
            <p className="ag-body">An approval of this item is stored as pending until the linked decision is decided; it becomes effective on acceptance and comes back to the board if the decision is rejected.</p>
            <RadioButtonGroup legendText="Decision" name="dep-mode" valueSelected={modal.mode} onChange={(v) => setModal({ ...modal, mode: String(v) })}>
              <RadioButton id="dep-existing" value="existing" labelText="Existing proposed decision" /><RadioButton id="dep-new" value="new" labelText="Create new" />
            </RadioButtonGroup>
            {modal.mode === "new" ? <>
              <div className="ag-row end"><TextInput id="dep-title" labelText="Title" value={modal.title} onChange={(e) => setModal({ ...modal, title: e.target.value })} /><Select id="dep-topic" labelText="Topic" value={modal.topic} onChange={(e) => setModal({ ...modal, topic: e.target.value })}>{TOPICS.map((t) => <SelectItem key={t} value={t} text={labelFor("topic", t)} />)}</Select></div>
              <Checkbox id="dep-submit" labelText="Submit it for review now (authored by this review's submitter, routed by the board's rules)" checked={modal.submit} onChange={(_, { checked }) => setModal({ ...modal, submit: checked })} />
            </> : <Select id="dep-decision" labelText="Proposed decision" value={modal.decision_id} onChange={(e) => setModal({ ...modal, decision_id: e.target.value })}><SelectItem value="" text={decisions ? "Choose a proposed decision" : "Loading"} />{(decisions || []).filter((d) => d.status === "proposed").map((d) => <SelectItem key={d.id} value={d.id} text={`${d.code} · ${d.title}`} />)}</Select>}
          </div>
        </Modal>)}

      {modal?.kind === "assess_request" && (
        <Modal open modalHeading={`Request an Assessment · ${r.code}`} primaryButtonText="Request" secondaryButtonText="Cancel" primaryButtonDisabled={!modal.assigned_to || (modal.type === "other" && !modal.title.trim()) || busy === "assess"} onRequestClose={() => setModal(null)}
          onRequestSubmit={() => { const m = modal; setModal(null); run("assess", () => post(`/reviews/${r.id}/assessments`, { type: m.type, title: m.title.trim() || null, area: m.area || null, assigned_to: m.assigned_to, due_at: m.due_at || null })); }}>
          <div className="ag-form">
            <p className="ag-body">The board asks, the assessor provides: the named assessor records the result themselves, and the review cannot be approved until every requested assessment is recorded or waived by the chair.</p>
            <div className="ag-row">
              <Select id="as-type" labelText="Type" value={modal.type} onChange={(e) => setModal({ ...modal, type: e.target.value })}>{ASSESSMENT_TYPES.map((t) => <SelectItem key={t} value={t} text={labelFor("assessment_type", t)} />)}</Select>
              {boardAreas.length > 0 && <Select id="as-area" labelText="Area (optional)" value={modal.area} onChange={(e) => setModal({ ...modal, area: e.target.value })}><SelectItem value="" text="None" />{boardAreas.map((a) => <SelectItem key={a.id} value={a.id} text={a.label} />)}</Select>}
            </div>
            <TextInput id="as-title" labelText={modal.type === "other" ? "Title" : "Title (optional)"} placeholder="e.g. DPIA for the SMS gateway" value={modal.title} onChange={(e) => setModal({ ...modal, title: e.target.value })} />
            <div className="ag-row end">
              <Select id="as-assignee" labelText="Assessor" value={modal.assigned_to} onChange={(e) => setModal({ ...modal, assigned_to: e.target.value })}>
                <SelectItem value="" text={users ? (assessors.length ? "Choose a user" : "No eligible users") : "Loading"} />
                {assessors.map((u) => <SelectItem key={u.id} value={u.id} text={`${u.name || u.id}${u.id === r.submitted_by ? " · submitter" : u.user_type ? ` · ${labelFor("user_type", u.user_type)}` : ""}`} />)}
              </Select>
              <DateField id="as-due" labelText="Due (optional)" value={modal.due_at} onChange={(ymd) => setModal({ ...modal, due_at: ymd })} />
            </div>
            <p className="ag-muted ag-label">The submitter may be the assessor (a DPIA is usually theirs to produce); auditors and service accounts cannot assess.</p>
          </div>
        </Modal>)}

      {modal?.kind === "assess_result" && (
        <Modal open modalHeading={`Record Result · ${modal.a.title || labelFor("assessment_type", modal.a.type)}`} primaryButtonText="Record Result" secondaryButtonText="Cancel" primaryButtonDisabled={modal.text.trim().length < 10 || busy === "assess"} onRequestClose={() => setModal(null)}
          onRequestSubmit={() => { const m = modal; setModal(null); run("assess", () => post(`/assessments/${m.a.id}/result`, { result: m.result, result_md: m.text.trim(), reference: m.reference.trim() || null })); }}>
          <div className="ag-form">
            <p className="ag-body">You record this as yourself; it is written to the timeline, the audit chain and the evidence pack with your name. An unsatisfactory result does not block the board — it informs the positions.</p>
            <RadioButtonGroup legendText="Result" name="as-result" orientation="vertical" valueSelected={modal.result} onChange={(v) => setModal({ ...modal, result: String(v) })}>
              {ASSESSMENT_RESULTS.map((x) => <RadioButton key={x} id={`asr-${x}`} value={x} labelText={labelFor("assessment_result", x)} />)}
            </RadioButtonGroup>
            {aiOn.draft_assessment && <div><Button size="sm" kind="ghost" renderIcon={MachineLearningModel} disabled={busy === "ai-draft"} onClick={() => draftSummary(modal.a.type)}>Draft Summary with AI</Button>{busy === "ai-draft" && <InlineLoading description="Drafting from the review" />}</div>}
            <TextArea id="as-summary" labelText="Summary (at least 10 characters)" helperText={aiOn.draft_assessment ? "An AI draft fills the headings from the review and marks gaps 'To be confirmed' — you record it as your own." : undefined} rows={4} value={modal.text} onChange={(e) => setModal({ ...modal, text: e.target.value })} />
            <TextInput id="as-ref" labelText="Reference (optional)" helperText="A pointer to the full document — a URL or document id. The document itself is never stored here." placeholder="e.g. https://dms.example/dpia-123" value={modal.reference} onChange={(e) => setModal({ ...modal, reference: e.target.value })} />
          </div>
        </Modal>)}

      {modal?.kind === "assess_provide" && (
        <Modal open modalHeading={modal.id ? `Update · ${modal.title || labelFor("assessment_type", modal.type)}` : `Provide an Assessment · ${r.code}`} primaryButtonText={modal.id ? "Save" : "Attach Assessment"} secondaryButtonText="Cancel"
          primaryButtonDisabled={modal.text.trim().length < 10 || (modal.type === "other" && !modal.title.trim()) || busy === "assess"} onRequestClose={() => setModal(null)}
          onRequestSubmit={() => { const m = modal; setModal(null); run("assess", () => m.id
            ? put(`/assessments/${m.id}/provided`, { result: m.result, result_md: m.text.trim(), reference: m.reference.trim() || null })
            : post(`/reviews/${r.id}/assessments/provide`, { type: m.type, title: m.title.trim() || null, area: m.area || null, result: m.result, result_md: m.text.trim(), reference: m.reference.trim() || null })); }}>
          <div className="ag-form">
            <p className="ag-body">Supporting information you attach as the submitter, recorded under your name on the timeline, the audit chain and the evidence pack. It never blocks an outcome — the board weighs it. Updating it later re-affirms it against the current version.</p>
            <div className="ag-row">
              <Select id="ap-type" labelText="Type" value={modal.type} disabled={!!modal.id} onChange={(e) => { const t = e.target.value; setModal({ ...modal, type: t, text: modal.text.trim() === "" || modal.text === tpl(modal.type) ? tpl(t) : modal.text }); }}>{ASSESSMENT_TYPES.map((t) => <SelectItem key={t} value={t} text={labelFor("assessment_type", t)} />)}</Select>
              {boardAreas.length > 0 && <Select id="ap-area" labelText="Area (optional)" value={modal.area} disabled={!!modal.id} onChange={(e) => setModal({ ...modal, area: e.target.value })}><SelectItem value="" text="None" />{boardAreas.map((a) => <SelectItem key={a.id} value={a.id} text={a.label} />)}</Select>}
            </div>
            {!modal.id && <TextInput id="ap-title" labelText={modal.type === "other" ? "Title" : "Title (optional)"} placeholder="e.g. Impact assessment for the kiosk rollout" value={modal.title} onChange={(e) => setModal({ ...modal, title: e.target.value })} />}
            <RadioButtonGroup legendText="Result" name="ap-result" orientation="vertical" valueSelected={modal.result} onChange={(v) => setModal({ ...modal, result: String(v) })}>
              {ASSESSMENT_RESULTS.map((x) => <RadioButton key={x} id={`apr-${x}`} value={x} labelText={labelFor("assessment_result", x)} />)}
            </RadioButtonGroup>
            {aiOn.draft_assessment && <div><Button size="sm" kind="ghost" renderIcon={MachineLearningModel} disabled={busy === "ai-draft"} onClick={() => draftSummary(modal.type)}>Draft Summary with AI</Button>{busy === "ai-draft" && <InlineLoading description="Drafting from the review" />}</div>}
            <TextArea id="ap-summary" labelText="Summary (at least 10 characters)" helperText="The template lists what a competent result answers; replace the headings' blanks." rows={8} value={modal.text} onChange={(e) => setModal({ ...modal, text: e.target.value })} />
            <TextInput id="ap-ref" labelText="Reference (optional)" helperText="A pointer to the full document — a URL or document id. The document itself is never stored here." value={modal.reference} onChange={(e) => setModal({ ...modal, reference: e.target.value })} />
          </div>
        </Modal>)}

      {modal?.kind === "assess_waive" && (
        <Modal open danger modalHeading={`Waive · ${modal.a.title || labelFor("assessment_type", modal.a.type)}`} primaryButtonText="Waive" secondaryButtonText="Cancel" primaryButtonDisabled={modal.reason.trim().length < 10 || busy === "assess"} onRequestClose={() => setModal(null)}
          onRequestSubmit={() => { const m = modal; setModal(null); run("assess", () => post(`/assessments/${m.a.id}/waive`, { reason: m.reason.trim() })); }}>
          <div className="ag-form">
            <p className="ag-body">Waiving removes this assessment from what blocks approval. The reason is recorded on the timeline, in the audit chain and in the evidence pack.</p>
            <TextArea id="as-waive" labelText="Reason (at least 10 characters)" rows={3} value={modal.reason} onChange={(e) => setModal({ ...modal, reason: e.target.value })} />
          </div>
        </Modal>)}

      {modal?.kind === "declare" && <DeclareModal reviewId={r.id} review={r} initial={modal.initial} onClose={() => setModal(null)} onSubmit={(body) => post(`/reviews/${r.id}/decide`, body).then(() => reload())} />}
    </>
  );
}

/**
 * The due diligence requested for this submission, its results presented beside the positions that weigh them.
 * Request needs a chair / decision-maker / reviewer seat (the review's own `can`); only the assessor records; the
 * chair waives. Stale results assessed an earlier version and say so. One row per assessment with a single result
 * tag; the written result stays folded behind View Result so the table reads as a table, not as a document.
 */
function AssessmentsSection({ r, active, myId, boardAreas, setModal, tpl }: { r: any; active: boolean; myId: string; boardAreas: { id: string; label: string }[]; setModal: (m: any) => void; tpl: (t: string) => string }) {
  const assessments: any[] = r.assessments || [];
  const can = r.can || {};
  const [openResults, setOpenResults] = React.useState<Record<string, boolean>>({});
  if (!active && assessments.length === 0) return null;
  return (
    <section className="ag-section">
      <div className="ag-row between"><h2>Assessments ({assessments.length})</h2>
        <div className="ag-row snug">
          {/* the submitter's missing Request button explains itself (the server's own reason), per the disabled-states pattern */}
          {active && myId === r.submitted_by && !can.request_assessment && r.why?.request_assessment && <span className="ag-muted ag-label">{r.why.request_assessment}.</span>}
          {active && myId === r.submitted_by && <Button size="sm" kind="tertiary" renderIcon={Add} onClick={() => setModal({ kind: "assess_provide", id: null, type: "impact", title: "", area: "", result: "satisfactory", text: tpl("impact"), reference: "" })}>Provide Assessment</Button>}
          {can.request_assessment && active && <Button size="sm" kind="tertiary" renderIcon={Add} onClick={() => setModal({ kind: "assess_request", type: "dpia", title: "", area: "", assigned_to: "", due_at: "" })}>Request Assessment</Button>}
        </div>
      </div>
      {assessments.length === 0 ? <Empty>No assessments. The board can request due diligence that blocks approval until recorded or waived; the submitter can attach assessments already carried out.</Empty> : (
      <Table size="sm"><TableHead><TableRow><TableHeader>Assessment</TableHeader><TableHeader>Result</TableHeader><TableHeader>People</TableHeader><TableHeader>When</TableHeader><TableHeader>Actions</TableHeader></TableRow></TableHead>
        <TableBody>{assessments.map((a) => {
          const hasDetail = !!(a.result_md || a.waived_reason || a.reference);
          const showDetail = hasDetail && !!openResults[a.id];
          return (<React.Fragment key={a.id}>
          <TableRow>
            <TableCell><div className="ag-row tight"><KindTag kind="assessment_type" value={a.type} size="md" />{a.area && <AreaTag id={a.area} boardAreas={boardAreas} />}{a.provided && !a.on_decision && <Tag size="sm" type="gray"><span title="Attached by the submitter as supporting information — recorded by its author; it never blocks an outcome.">Provided</span></Tag>}{a.on_decision && <Tag size="sm" type="gray"><span title="Evidence the author gathered on the decision before submitting it for review — tracked from the draft decision onto this review; it never blocks an outcome.">On the Decision</span></Tag>}</div>{a.title && <div className="ag-label">{a.title}</div>}</TableCell>
            {/* One tag says where it stands: the result once recorded, otherwise the status. "Completed · satisfactory" was two tags for one fact. */}
            <TableCell>{a.status === "completed" && a.result ? <StatusTag kind="assessment_result" value={a.result} /> : <StatusTag kind="assessment_status" value={a.status} />}{a.stale ? <div className="ag-muted ag-label">against an earlier version</div> : null}</TableCell>
            <TableCell className="ag-label">{a.provided ? <>{a.completed_by_name || a.completed_by}<div className="ag-muted">submitter</div></> : <>{a.assigned_to_name || a.assigned_to}<div className="ag-muted">asked by {a.requested_by_name || a.requested_by}</div></>}{a.status === "waived" ? <div className="ag-muted">waived by {a.waived_by_name || a.waived_by}</div> : null}</TableCell>
            <TableCell className="ag-label">{a.status === "requested" ? (a.due_at ? `due ${fmtDate(a.due_at)}` : <span className="ag-muted">—</span>) : a.status === "waived" ? fmtDateTime(a.waived_at) : fmtDateTime(a.completed_at)}</TableCell>
            <TableCell><div className="ag-actions">
              {hasDetail && <Button size="sm" kind="ghost" renderIcon={showDetail ? ChevronUp : ChevronDown} onClick={() => setOpenResults((o) => ({ ...o, [a.id]: !o[a.id] }))}>{showDetail ? "Hide Result" : "View Result"}</Button>}
              {a.provided && active && myId === a.completed_by && <Button size="sm" kind="ghost" renderIcon={Edit} onClick={() => setModal({ kind: "assess_provide", id: a.id, type: a.type, title: a.title || "", area: a.area || "", result: a.result, text: a.result_md || "", reference: a.reference || "" })}>Update</Button>}
              {a.status === "requested" && active && myId === a.assigned_to && <Button size="sm" kind="ghost" renderIcon={Checkmark} onClick={() => setModal({ kind: "assess_result", a, result: "satisfactory", text: tpl(a.type), reference: "" })}>Record Result</Button>}
              {a.status === "requested" && active && can.waive_assessment && <Button size="sm" kind="ghost" onClick={() => setModal({ kind: "assess_waive", a, reason: "" })}>Waive</Button>}
            </div></TableCell>
          </TableRow>
          {showDetail && <TableRow className="ag-subrow"><TableCell colSpan={5}>
            {a.result_md && <Markdown md={a.result_md} />}
            {a.status === "waived" && a.waived_reason && <div className="ag-body ag-muted">{a.waived_reason}</div>}
            {a.reference && <div className="ag-label">Reference: <a className="cds--link" href={a.reference} target="_blank" rel="noreferrer">{a.reference}</a></div>}
          </TableCell></TableRow>}
        </React.Fragment>);
        })}</TableBody></Table>)}
    </section>
  );
}

/** A timeline event that is not a pre-review: the session events read as label + what happened; anything else is its markdown body. */
function EventBody({ e, boardAreas, nameOf }: { e: any; boardAreas: { id: string; label: string }[]; nameOf: (u?: string | null) => string }) {
  const d = e.data || {};
  const area = d.area as string | undefined;
  let line: React.ReactNode = null;
  switch (e.kind) {
    case "position": line = <div className="ag-row tight">{area ? <AreaPositionTag area={area} state={d.position} boardAreas={boardAreas} size="sm" /> : d.position ? <StatusTag kind="position" value={d.position} size="sm" /> : null}{d.on_behalf_of ? <span className="ag-muted ag-label">for {nameOf(d.on_behalf_of)}</span> : null}{d.text ? <span className="ag-body">{d.text}</span> : null}</div>; break;
    case "position_resolved": line = <div className="ag-row tight">{area && <AreaTag id={area} boardAreas={boardAreas} />}<span className="ag-body">{labelFor("resolution", d.resolution)}{d.text || d.resolution_text ? ` — ${d.text || d.resolution_text}` : ""}</span></div>; break;
    case "dependency_created": case "dependency_rejected": { const dec = d.decision || {}; const code = dec.code || d.decision_code || d.code; line = <span className="ag-body">{e.kind === "dependency_created" ? "depends on " : "dependency rejected: "}{dec.id || d.decision_id ? <RLink to={`/decisions/${dec.id || d.decision_id}`}>{code || "decision"}</RLink> : code || "a decision"}{dec.title ? ` · ${dec.title}` : ""}</span>; break; }
    case "became_effective": line = d.stage || d.outcome ? <StatusTag kind="stage" value={d.stage || d.outcome} size="sm" /> : null; break;
    case "deferred": line = d.reason ? <span className="ag-body">{d.reason}</span> : null; break;
    case "referred": line = <span className="ag-body">to {d.board?.name || d.board_name || d.board_code || d.board_id || "another board"}{d.reason || d.rationale ? ` — ${d.reason || d.rationale}` : ""}</span>; break;
    case "circulation_objection": line = <div className="ag-row tight">{area && <AreaPositionTag area={area} state="no" boardAreas={boardAreas} size="sm" />}{d.text ? <span className="ag-body">{d.text}</span> : null}</div>; break;
    case "areas_changed": { const to: string[] = d.areas || d.to || []; line = to.length ? <div className="ag-row tight">{to.map((a) => <AreaTag key={a} id={a} boardAreas={boardAreas} />)}</div> : null; break; }
    case "assessment_requested": line = <div className="ag-row tight"><KindTag kind="assessment_type" value={d.type} />{d.title && <span className="ag-body">{d.title}</span>}{d.area && <AreaTag id={d.area} boardAreas={boardAreas} />}<span className="ag-muted ag-label">assessor {nameOf(d.assigned_to)}{d.due_at ? ` · due ${fmtDate(d.due_at)}` : ""}</span></div>; break;
    case "assessment_completed": line = <div className="ag-row tight"><KindTag kind="assessment_type" value={d.type} />{d.title && <span className="ag-body">{d.title}</span>}<StatusTag kind="assessment_result" value={d.result} size="sm" />{d.reference && <a className="cds--link" href={d.reference} target="_blank" rel="noreferrer">reference</a>}</div>; break;
    case "assessment_waived": line = <div className="ag-row tight"><KindTag kind="assessment_type" value={d.type} />{d.title && <span className="ag-body">{d.title}</span>}<StatusTag kind="assessment_status" value="waived" size="sm" /></div>; break;
    case "consent_declared": line = d.outcome ? <StatusTag kind="outcome" value={d.outcome} size="sm" /> : null; break;
    case "patterns_changed": { const to: string[] = d.to || []; line = to.length ? <div className="ag-row tight">{to.map((c) => <Tag key={c} size="sm" type="purple"><span title="An adopted pattern the design claims to follow">{c}</span></Tag>)}</div> : null; break; }
    default: { if (d.outcome) line = <div className="ag-row tight"><StatusTag kind="outcome" value={d.outcome} size="sm" />{d.fast_lane ? <StatusTag kind="fast_lane" value="eligible" size="sm" label="Via the Fast Lane" /> : null}{d.circulation_due ? <span className="ag-muted ag-label">positions due {fmtDate(d.circulation_due)}</span> : null}</div>; }
  }
  // The dependency event's body repeats the link line; everything else keeps its body (the position text, the rationale, a comment).
  return <>{line}{e.body_md && e.kind !== "dependency_created" ? <Markdown md={e.body_md} /> : null}</>;
}

/**
 * The fast lane on this review: whether the deterministic checks hold (each one with its reason), the derived risk
 * tier and the patterns claimed. In the lane the chair may declare without positions; out of it the full policy applies.
 */
function FastLaneSection({ fl, via, canEdit, onEdit }: { fl: any; via: boolean; canEdit: boolean; onEdit: () => void }) {
  const failed = (fl.checks || []).filter((c: any) => !c.ok);
  const [all, setAll] = React.useState(false);
  const shown = fl.eligible || all ? fl.checks || [] : failed;
  return (
    <section className="ag-section">
      <div className="ag-row between"><h2>Fast Lane</h2>{canEdit && <Button size="sm" kind="tertiary" renderIcon={Edit} onClick={onEdit}>Edit Patterns</Button>}</div>
      <div className="ag-row snug ag-mb-03">
        <StatusTag kind="fast_lane" value={fl.eligible ? "eligible" : "full"} label={fl.eligible ? "In the Fast Lane" : "Full Policy"} />
        <StatusTag kind="risk" value={fl.risk?.tier} label={`Risk: ${labelFor("severity", fl.risk?.tier)}`} explain={(fl.risk?.reasons || []).join(" ")} />
      </div>
      <p className="ag-body ag-mb-03">{fl.eligible
        ? via ? "Every check passes: the chair may declare this design approved without area positions. Any area owner can still take it out of the lane by recording a no or a conditional." : "Every check passes, and the positions already satisfy the policy."
        : `This board's fast lane is open to low-risk designs that follow adopted patterns. ${failed.length === 1 ? "One check keeps" : `${failed.length} checks keep`} this one on the full policy.`}</p>
      <Table size="sm" aria-label="Fast lane checks"><TableHead><TableRow><TableHeader>Check</TableHeader><TableHeader>Result</TableHeader><TableHeader>Why</TableHeader></TableRow></TableHead>
        <TableBody>{shown.map((c: any) => <TableRow key={c.id}>
          <TableCell className="ag-nowrap">{c.name}</TableCell>
          <TableCell><StatusTag kind="check" value={c.ok ? "ok" : "failed"} label={c.ok ? "Passes" : "Fails"} size="sm" /></TableCell>
          <TableCell className="ag-wrap"><span className="ag-label">{c.detail}</span></TableCell>
        </TableRow>)}</TableBody></Table>
      {!fl.eligible && failed.length < (fl.checks || []).length && <Button size="sm" kind="ghost" renderIcon={all ? ChevronUp : ChevronDown} onClick={() => setAll(!all)}>{all ? "Show Failing Checks Only" : `Show All ${(fl.checks || []).length} Checks`}</Button>}
    </section>
  );
}

/** The board's approval policy as steps, with where this review stands: done, current, or blocked by requested changes. */
function Workflow({ r }: { r: any }) {
  const steps: any[] = r.policy.steps;
  const outstanding: any[] = r.progress?.outstanding || [];
  const areasMode = r.progress?.mode === "areas";
  const closed = !OPEN_STAGES.includes(r.stage);
  const changes = r.stage === "changes_requested";
  const isOutstanding = (s: any) => (areasMode && s.kind === "approvals") ? !r.progress?.satisfied : outstanding.some((o) => o.step === s.name || o.step === s.kind || o.step === labelFor("step", s.kind));
  // Steps before the first outstanding one are complete; the first outstanding is current; the rest wait.
  const firstOpen = closed ? steps.length : steps.findIndex((s) => isOutstanding(s) || (s.kind === "decision" && !closed));
  const cur = firstOpen === -1 ? steps.length : firstOpen;
  return (
    <div className="ag-steps">
      <ProgressIndicator currentIndex={cur} spaceEqually>
        {steps.map((s, i) => {
          const label = s.name || labelFor("step", s.kind);
          const secondary = s.kind === "approvals" ? (s.mode === "areas" || areasMode ? `${r.progress?.received ?? 0} of ${r.progress?.required ?? 0} areas` : `${r.progress?.received ?? 0} of ${s.min ?? r.progress?.required ?? 1} approvals`) : s.kind === "decision" ? (closed ? labelFor("stage", r.stage) : `declared by ${(s.roles || ["chair"]).map((x: string) => labelFor("board_role", x).toLowerCase()).join(" or ")}`) : "automatic";
          return <ProgressStep key={i} label={label} secondaryLabel={secondary} complete={i < cur} current={i === cur && !closed} invalid={changes && i === cur} />;
        })}
      </ProgressIndicator>
      {/* Carbon's horizontal ProgressIndicator does not reserve height for secondary labels, so leave room before the summary.
          One line only — the board and "n of m areas"; which areas still hold the item up is the Areas & positions section's job. */}
      <p className="ag-muted ag-label ag-mt-06">{r.board ? `${r.board.name} · ` : ""}{closed ? `${ACTIVE_STAGES.includes(r.stage) ? "Declared" : "Closed"}: ${labelFor("stage", r.stage).toLowerCase()}` : (progressShort(r.progress) || "").replace("/", " of ") || progressText(r.progress) || "In progress"}</p>
    </div>
  );
}

/**
 * The pre-review findings that derived an area, joined to its row: severity · code · title, each linking to the catalogue
 * item. Up to two show as they are; more fold behind "n findings".
 */
function AreaFindings({ a }: { a: any }) {
  const [open, setOpen] = React.useState(false);
  const findings: any[] = Array.isArray(a.findings) ? a.findings : [];
  const n = typeof a.findings_count === "number" ? a.findings_count : findings.length;
  if (!n) return null;
  const folded = findings.length > 2;
  const show = !folded || open;
  return (
    <div className="ag-mt-02">
      {folded
        ? <Button size="sm" kind="ghost" renderIcon={open ? ChevronUp : ChevronDown} onClick={() => setOpen((o) => !o)}>{n} finding{n === 1 ? "" : "s"}</Button>
        : <span className="ag-muted ag-label">{n} finding{n === 1 ? "" : "s"}{findings.length === 0 ? " from the pre-review" : ""}</span>}
      {show && findings.length > 0 && <ul className="ag-area-findings">{findings.map((f, i) => (
        <li key={i}><SeverityTag s={f.severity} />{f.code ? <RLink to={f.id ? artefactLink(f.id) : `/governance?q=${encodeURIComponent(f.code)}`}>{f.code}</RLink> : null}<span>{f.title || f.label}</span>{f.kind && f.kind !== "standard" && <KindTag kind="kind" value={f.kind} />}</li>))}</ul>}
    </div>
  );
}

/** The design, section by section. A section the submitter never filled in says so instead of showing the template's hint. */
function DesignSections({ md }: { md?: string | null }) {
  const text = md || "";
  const parts = text.split(/^##\s+/m);
  const pre = parts[0].trim();
  const secs = parts.slice(1).map((p) => { const nl = p.indexOf("\n"); const heading = (nl === -1 ? p : p.slice(0, nl)).trim(); const body = (nl === -1 ? "" : p.slice(nl + 1)).trim(); return { heading, body }; });
  if (!pre && secs.length === 0) return <p className="ag-muted ag-body">Not provided</p>;
  return (
    <>
      {pre && <Markdown md={pre} />}
      {/* The template's first section is itself called "Design"; under the section's own "Design" heading that h3 is noise, so the lead renders as body text. */}
      {secs.map((s, i) => { const empty = !s.body || s.body === HINTS[s.heading]; const lead = i === 0 && !pre && s.heading === "Design"; return <div key={i} className="ag-mb-05">{!lead && <h3>{s.heading}</h3>}{empty ? <p className="ag-muted ag-body">Not provided</p> : <Markdown md={s.body} />}</div>; })}
    </>
  );
}

/**
 * A pre-review event: for designs the rules-engine findings; for catalogue items the validity checks and the dry-run
 * impact. A superseded pre-review (one with a later run after it) folds to its recommendation line — the latest run
 * is the one the board reads, and repeating every earlier run's findings buried the rest of the timeline.
 */
function PreReview({ e, onDone, onAdd, folded }: { e: any; onDone: () => void; onAdd?: (text: string) => void; folded?: boolean }) {
  const [expanded, setExpanded] = React.useState(false);
  const d = e.data || {};
  const suggested: string[] = d.suggested_conditions || [];
  const checks: any[] = d.checks || [];
  const impact = d.impact;
  const recommendation = sentence(d.recommendation || (checks.some((c) => c.state === "fail") ? "request changes" : "proceed")).toLowerCase();
  const nFindings = (d.findings || []).length + checks.filter((c) => c.state === "fail").length;
  if (folded && !expanded) return (
    <div className="ag-row snug">
      <span className="ag-body">Recommendation: {recommendation}</span>
      <span className="ag-muted ag-label">· {nFindings} finding{nFindings === 1 ? "" : "s"} · superseded by a later pre-review</span>
      <Button size="sm" kind="ghost" renderIcon={ChevronDown} onClick={() => setExpanded(true)}>Show Details</Button>
    </div>);
  return (
    <div className="ag-prereview">
      <div className="ag-row between">
        <div className="ag-body"><span className="ag-strong">Recommendation: {recommendation}</span> <span className="ag-muted">· {d.engine === "llm" ? `model ${d.model}` : "deterministic checks"}</span></div>
        <div className="ag-row snug">
          {e.origin === "ai" && <VerifyButton path={`/review-events/${e.id}/verify`} state={e.verification} onDone={onDone} />}
          {folded && <Button size="sm" kind="ghost" renderIcon={ChevronUp} onClick={() => setExpanded(false)}>Hide Details</Button>}
        </div>
      </div>
      {d.summary && <p className="ag-body ag-mt-02 ag-mb-03">{d.summary}</p>}
      {checks.length > 0 && <div className="ag-stack ag-mb-03">{checks.map((c, i) => <div className="ag-row snug" key={i}><StatusTag kind="precheck" value={c.state} label={`${labelFor("precheck", c.state)} · ${c.name}`} />{c.detail && <span className="ag-muted ag-label">{c.detail}</span>}</div>)}</div>}
      {impact && <div className="ag-mb-03"><p className="ag-body">{typeof impact.findings === "number" ? <>If adopted now, the rule would raise <span className="ag-strong">{impact.findings}</span> finding{impact.findings === 1 ? "" : "s"} across {impact.applications ?? 0} application{impact.applications === 1 ? "" : "s"}.</> : "No rule to dry-run."}</p>
        {Array.isArray(impact.sample) && impact.sample.length > 0 && <Table size="sm"><TableHead><TableRow><TableHeader>Element</TableHeader><TableHeader>Application</TableHeader><TableHeader>Finding</TableHeader></TableRow></TableHead><TableBody>{impact.sample.map((s: any, i: number) => <TableRow key={i}><TableCell>{s.element_name}</TableCell><TableCell>{s.application_name}</TableCell><TableCell>{s.message}</TableCell></TableRow>)}</TableBody></Table>}</div>}
      {(d.findings || []).map((f: any, i: number) => (
        <div className="ag-finding" key={i}>
          <div className="ag-row snug"><SeverityTag s={f.severity} /><span className="title">{f.title}</span></div>
          <div className="detail">{f.detail}</div>
          <div className="ag-cites">{(f.citations || []).map((c: any, k: number) => <CitationLink key={k} c={c} />)}</div>
        </div>))}
      {suggested.length > 0 && <div className="ag-mt-03">
        <div className="ag-label ag-muted">Suggested conditions</div>
        <ul className="ag-suggest">{suggested.map((t, i) => <li key={i}><span className="ag-body">{t}</span>{onAdd && <Button size="sm" kind="ghost" renderIcon={Add} onClick={() => onAdd(t)}>Add as Condition</Button>}</li>)}</ul>
      </div>}
      <p className="ag-muted ag-label ag-mt-03">Pre-review never approves. Every finding cites the catalogue item, decision, resource or section it rests on; citations that did not resolve were discarded.</p>
    </div>
  );
}
