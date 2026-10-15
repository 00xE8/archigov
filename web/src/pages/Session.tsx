import React from "react";
import { useParams } from "react-router-dom";
import { DataTable, Table, TableHead, TableRow, TableHeader, TableBody, TableCell, TableContainer, DataTableSkeleton, SkeletonText, Button, Modal, TextArea, Select, SelectItem, MultiSelect, InlineNotification, InlineLoading, Tag, CopyButton } from "@carbon/react";
import { Renew, Play, Checkmark, CloseOutline, UserMultiple, Copy, Save, Time, Undo, Bullhorn, CheckmarkFilled, MachineLearningModel } from "@carbon/icons-react";
import { get, post, put, del, fmtDateTime, labelFor, currentUser, normaliseSeat, areaLabel, sentence } from "../api";
import { PageHeader, useLoad, useAiFeatures, LoadError, RLink, Crumbs, StatusTag, KindTag, AreaTag, AreaPositionTag, Empty, EmptyState, Markdown, useDocTitle } from "../components";
import { Gated, useAuth } from "../auth";
import { DeclareModal } from "../components/DeclareModal";

const AGENDA_HEADERS = [{ key: "n", header: "#" }, { key: "review", header: "Review" }, { key: "type", header: "Type" }, { key: "author", header: "Author" }, { key: "areas", header: "Areas" }, { key: "state", header: "State" }, { key: "actions", header: "Actions" }];
const LIVE = (it: any) => it.state === "listed" || it.state === "called";

/**
 * One sitting of a board. The agenda and the minutes are derived; people record attendance, delegate a seat for the
 * sitting, and the chair calls items and declares what the positions allow. Every action is gated by the session's
 * own `can`; the server is the authority.
 */
export default function Session() {
  const { id } = useParams();
  const { me } = useAuth();
  const [s, reload, err] = useLoad<any>(() => get(`/sessions/${id}`), [id]);
  const [users] = useLoad<any[]>(() => get<any[]>("/users").catch(() => []));
  const closed = s?.status === "closed";
  // The minutes route carries the hash and the markdown rendering; the session row may carry the minutes too.
  const [min] = useLoad<any>(() => (closed ? get(`/sessions/${id}/minutes`).catch(() => null) : Promise.resolve(null)), [id, closed]);
  const [msg, setMsg] = React.useState<{ kind: "success" | "error" | "info"; text: string } | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [modal, setModal] = React.useState<any>(null);
  const [notes, setNotes] = React.useState<string | null>(null);
  const aiOn = useAiFeatures();
  useDocTitle(s ? s.code : null);
  if (err) return <LoadError what="this session" err={err} onRetry={reload} />;
  if (!s) return <><SkeletonText heading width="40%" /><SkeletonText paragraph lineCount={2} width="60%" /><DataTableSkeleton headers={AGENDA_HEADERS} rowCount={4} showHeader={false} showToolbar={false} /></>;
  const can = s.can || {};
  const status: string = s.status;
  const myId = me?.user?.id || currentUser();
  const mySeat: string | undefined = (me?.user?.boards || []).find((b) => b.id === s.board?.id || b.code === s.board?.code)?.role;
  const attendance: any[] = s.attendance || [];
  const delegations: any[] = (s.delegations || []).filter((d: any) => !d.revoked_at);
  const items: any[] = s.items || [];
  const mine = attendance.find((a) => a.user_id === myId);
  const myDelegation = delegations.find((d) => d.delegator === myId);
  const nameOf = (uid?: string | null) => !uid ? "—" : attendance.find((a) => a.user_id === uid)?.name || delegations.find((d) => d.delegator === uid)?.delegator_name || delegations.find((d) => d.delegate === uid)?.delegate_name || (users || []).find((u) => u.id === uid)?.name || uid;
  const chairs = attendance.filter((a) => normaliseSeat(a.board_role) === "chair").map((a) => a.name || a.user_id);
  const consentItems = items.filter((it) => it.consent && it.state === "listed");
  const agendaItems = items.filter((it) => !(it.consent && it.state === "listed"));
  const declared = items.filter((it) => it.state === "declared").length;
  const deferred = items.filter((it) => it.state === "deferred").length;
  const notReached = items.filter((it) => it.state === "listed").length;
  const run = async (key: string, fn: () => Promise<any>, ok?: string | ((r: any) => string)) => { setBusy(key); setMsg(null); try { const r = await fn(); if (ok) setMsg({ kind: "success", text: typeof ok === "function" ? ok(r) : ok }); reload(); } catch (e: any) { setMsg({ kind: "error", text: String(e.message || e).split("\n")[0] }); } finally { setBusy(null); } };
  // A seat holder without the right sees the action disabled and why; everyone else does not see it.
  const gate = (ok: boolean, cap: string, reason: string, button: React.ReactElement<any>) => (ok ? button : mySeat ? <Gated cap={cap} allowed={false} reason={reason}>{button}</Gated> : null);
  const chairReason = `Needs the chair of ${s.board?.name || "this board"}`;
  const manageReason = `Needs the chair or secretary of ${s.board?.name || "this board"}`;
  const minutes = s.minutes || min?.minutes || null;
  const minutesHash: string | undefined = s.minutes_hash || min?.minutes_hash || minutes?.minutes_hash;
  const copyMarkdown = () => run("md", async () => { const m = min?.markdown ? min : await get<any>(`/sessions/${s.id}/minutes`); await navigator.clipboard.writeText(m.markdown || ""); }, "Minutes copied as markdown");
  const attend = (st: string) => run(`attend-${st}`, () => post(`/sessions/${s.id}/attendance`, { status: st }), st === "present" ? "Recorded as present" : "Apologies recorded");

  return (
    <>
      <PageHeader breadcrumb={<Crumbs items={[{ to: "/boards", label: "Boards" }, { to: `/boards/${s.board?.id}`, label: s.board?.code || "Board" }, { label: s.code }]} />} title={s.title ? `${s.code} · ${s.title}` : s.code}
        about="One sitting of the board. The agenda is derived from the reviews routed here (a consent agenda for items already satisfied at open); members record attendance or delegate their seat for the sitting, decision makers record positions per owned area, the chair calls items and declares, and closing derives the minutes and hashes them into the audit chain. The secretary's notes are the only authored part."
        subtitle={<span className="ag-row snug">
          <StatusTag kind="session_status" value={status} size="md" />
          <span>{fmtDateTime(s.scheduled_at)} · {s.board?.name ? <RLink inline to={`/boards/${s.board.id}`}>{s.board.name}</RLink> : "board"} · chair {chairs.length ? chairs.join(", ") : <span className="ag-muted">none seated</span>}
            {status === "open" && s.opened_at ? ` · opened ${fmtDateTime(s.opened_at)}` : ""}{closed && s.closed_at ? ` · closed ${fmtDateTime(s.closed_at)} by ${nameOf(s.closed_by)}` : ""}
            {mine ? <> · you: {labelFor("attendance", mine.status || "absent").toLowerCase()}{mine.on_behalf_of ? ` for ${nameOf(mine.on_behalf_of)}` : ""}</> : null}</span>
        </span>}
        actions={!closed ? <>
          {can.attend_self && <>
            <Button size="md" kind="tertiary" renderIcon={Checkmark} disabled={mine?.status === "present" || busy === "attend-present"} onClick={() => attend("present")}>I'm Present</Button>
            <Button size="md" kind="tertiary" renderIcon={CloseOutline} disabled={mine?.status === "apologies" || busy === "attend-apologies"} onClick={() => attend("apologies")}>Apologies</Button>
          </>}
          {can.delegate_self && (myDelegation
            ? <Button size="md" kind="tertiary" renderIcon={Undo} disabled={busy === "revoke"} onClick={() => run("revoke", () => del(`/sessions/${s.id}/delegations/${myDelegation.id}`), "Delegation revoked")}>Revoke delegation to {myDelegation.delegate_name || myDelegation.delegate}</Button>
            : <Button size="md" kind="tertiary" renderIcon={UserMultiple} onClick={() => setModal({ kind: "delegate", delegate: "", areas: mine?.areas || [] })}>Delegate My Seat</Button>)}
          {gate(!!can.manage, "manage_board", manageReason, <Button size="md" kind="tertiary" renderIcon={Renew} disabled={busy === "refresh"} onClick={() => run("refresh", () => post(`/sessions/${s.id}/agenda/refresh`), "Agenda refreshed")}>Refresh Agenda</Button>)}
          {status === "planned" && gate(!!can.open, "decide_review", chairReason, <Button size="md" kind="primary" renderIcon={Play} disabled={busy === "open"} onClick={() => run("open", () => post(`/sessions/${s.id}/open`), "Session opened")}>Open Session</Button>)}
          {status === "open" && gate(!!can.close, "decide_review", chairReason, <Button size="md" kind="primary" renderIcon={Checkmark} onClick={() => setModal({ kind: "close" })}>Close Session</Button>)}
        </> : undefined} />
      {msg && <InlineNotification kind={msg.kind} lowContrast title={msg.text} onCloseButtonClick={() => setMsg(null)} className="ag-notice" />}

      {/* Once closed the page is the record: the derived minutes come first, the agenda and the panels follow as the detail behind them. */}
      {closed && <section className="ag-section"><h2>Minutes</h2>
        {!minutes ? <SkeletonText paragraph lineCount={3} /> : <>
          <p className="ag-muted ag-body ag-mb-03">Derived on close from the agenda, the positions and the declared outcomes; hashed into the audit chain and shipped in the evidence pack.</p>
          {minutesHash && <div className="ag-hash ag-mb-05"><span className="ag-label ag-muted">SHA-256</span><span className="ag-mono">{minutesHash}</span><CopyButton feedback="Copied" iconDescription="Copy hash" align="top" onClick={() => navigator.clipboard.writeText(minutesHash)} /></div>}
          {(minutes.items || []).length === 0 ? <Empty>No items were on the agenda.</Empty> : (
            <TableContainer><Table size="sm"><TableHead><TableRow><TableHeader>Item</TableHeader><TableHeader>Outcome</TableHeader><TableHeader>Positions by Area</TableHeader></TableRow></TableHead>
              <TableBody>{minutes.items.map((it: any, i: number) => { const rid = it.id || items.find((x) => x.review?.code === it.code)?.review?.id; return (
                <TableRow key={it.code || i}>
                  <TableCell>{rid ? <RLink to={`/reviews/${rid}`}>{it.code}</RLink> : it.code}<div className="ag-muted ag-label">{it.title}{it.author_name || it.author ? ` · ${it.author_name || it.author}` : ""}</div></TableCell>
                  <TableCell>{it.outcome ? <StatusTag kind="outcome" value={it.outcome} /> : <StatusTag kind="item_state" value="deferred" />}{it.deferred_reason ? <div className="ag-muted ag-label">{it.deferred_reason}</div> : null}{it.rationale ? <div className="ag-muted ag-label">{it.rationale}</div> : null}</TableCell>
                  <TableCell><div className="ag-stack tight">{(it.positions || []).length === 0 ? <span className="ag-muted">—</span> : it.positions.map((p: any, k: number) => <div className="ag-row tight" key={k}><AreaPositionTag area={p.area || "seat"} label={p.area ? undefined : "Seat"} state={p.resolution ? "resolved" : p.position} size="sm" /><span className="ag-muted ag-label">{nameOf(p.by)}{p.on_behalf_of ? ` for ${nameOf(p.on_behalf_of)}` : ""}</span></div>)}</div></TableCell>
                </TableRow>); })}</TableBody></Table></TableContainer>)}
          <div className="ag-mt-05">{busy === "md" ? <InlineLoading description="Copying" /> : <Button size="sm" kind="tertiary" renderIcon={Copy} onClick={copyMarkdown}>Copy Markdown</Button>}</div>
        </>}
      </section>}

      <div className="ag-grid-agenda">
        <div>
          {(consentItems.length > 0 || (status === "open" && (s.consent_count || 0) > 0)) && (
            <section className="ag-section"><h2>Consent Agenda ({consentItems.length})</h2>
              <p className="ag-muted ag-body ag-mb-03">Items every touched area had already said yes to when the session opened. The chair declares them together; pull one to discuss it with the rest.</p>
              {consentItems.length === 0 ? <Empty>Every consent item has been declared or pulled.</Empty> : <AgendaTable s={s} items={consentItems} consent busy={busy} run={run} setModal={setModal} gate={gate} myId={myId} />}
              {status === "open" && consentItems.length > 0 && <div className="ag-mt-03">{gate(!!can.consent, "decide_review", chairReason, <Button size="sm" kind="secondary" renderIcon={CheckmarkFilled} onClick={() => setModal({ kind: "consent", rationale: "" })}>Declare Consent Items</Button>)}</div>}
            </section>)}
          <section className="ag-section"><h2>Agenda ({agendaItems.length})</h2>
            {items.length === 0 ? (
              <EmptyState title="Nothing on the agenda" actions={can.manage && !closed ? <Button size="sm" kind="tertiary" renderIcon={Renew} onClick={() => run("refresh", () => post(`/sessions/${s.id}/agenda/refresh`), "Agenda refreshed")}>Refresh Agenda</Button> : undefined}>
                The agenda is derived from the reviews routed to {s.board?.name || "this board"} that are still open and not listed on another session. Refresh it to pick up new submissions.
              </EmptyState>)
              : agendaItems.length === 0 ? <Empty>Every item is on the consent agenda.</Empty>
              : <AgendaTable s={s} items={agendaItems} busy={busy} run={run} setModal={setModal} gate={gate} myId={myId} />}
          </section>
        </div>
        {/* Right column, in the order the sitting needs them: is the board quorate, who is here, what the secretary noted. */}
        <div className="ag-side">
          <section className="ag-section"><h2>Quorum by Area</h2>
            {status === "planned" ? <p className="ag-muted ag-body">Computed when the session opens, from attendance and delegations.</p>
              : !(s.quorum || []).length ? <p className="ag-muted ag-body">This board has no areas, so quorum does not apply; approvals are counted.</p>
              : <div className="ag-stack tight">{s.quorum.map((q: any) => <div className="ag-row snug" key={q.area}><StatusTag kind="quorum" value={q.covered ? "covered" : "uncovered"} label={`${q.label || areaLabel(q.area)} · ${labelFor("quorum", q.covered ? "covered" : "uncovered")}`} />{(q.by || []).length ? <span className="ag-muted ag-label">by {q.by.map((u: string) => nameOf(u)).join(", ")}</span> : null}</div>)}</div>}
          </section>

          <section className="ag-section"><h2>Attendance ({attendance.filter((a) => a.status === "present").length} present)</h2>
            {attendance.length === 0 ? <Empty>No members on this board yet.</Empty> : (
              <TableContainer><Table size="sm"><TableHead><TableRow><TableHeader>Member</TableHeader><TableHeader>Seat</TableHeader><TableHeader>Areas</TableHeader><TableHeader className="ag-col-status">Status</TableHeader></TableRow></TableHead>
                <TableBody>{attendance.map((a) => (
                  <TableRow key={a.user_id}>
                    <TableCell>{a.name || a.user_id}{a.on_behalf_of ? <div className="ag-muted ag-label">for {nameOf(a.on_behalf_of)}</div> : null}</TableCell>
                    {/* A delegate keeps their own seat tag (a reviewer may hold a decision maker's seat for the sitting); someone from outside the board has only the delegate tag. */}
                    <TableCell><div className="ag-row tight">{a.board_role && <KindTag kind="board_role" value={a.board_role} />}{a.on_behalf_of ? <Tag size="sm" type="gray"><span title="Attending under a one-session delegation of a decision maker\u2019s seat.">Delegate</span></Tag> : null}</div></TableCell>
                    <TableCell><div className="ag-row tight">{(a.areas || []).length ? (a.areas as string[]).map((x) => <AreaTag key={x} id={x} />) : <span className="ag-muted">—</span>}</div></TableCell>
                    <TableCell className="ag-col-status">{can.record_attendance && !closed && !a.on_behalf_of
                      ? <Select id={`att-${a.user_id}`} labelText="Attendance" hideLabel inline size="sm" value={a.status || "absent"} disabled={busy === `att-${a.user_id}`} onChange={(e) => run(`att-${a.user_id}`, () => post(`/sessions/${s.id}/attendance`, { user_id: a.user_id, status: e.target.value }))}>{["present", "apologies", "absent"].map((x) => <SelectItem key={x} value={x} text={labelFor("attendance", x)} />)}</Select>
                      : <StatusTag kind="attendance" value={a.status || "absent"} />}</TableCell>
                  </TableRow>))}</TableBody></Table></TableContainer>)}
            {delegations.length > 0 && <div className="ag-mt-05">
              <div className="ag-label ag-muted">Delegations for this session</div>
              {delegations.map((d) => (
                <div className="ag-finding" key={d.id}>
                  <div className="ag-row between"><div><div className="ag-body"><span className="ag-strong">{d.delegate_name || d.delegate}</span> for {d.delegator_name || d.delegator}{d.on_instruction ? <span className="ag-muted"> · recorded by {nameOf(d.recorded_by)} on instruction</span> : null}</div><div className="ag-row tight ag-mt-02">{(d.areas || []).length ? (d.areas as string[]).map((x) => <AreaTag key={x} id={x} />) : <span className="ag-muted ag-label">whole seat</span>}</div></div>
                    {!closed && (d.delegator === myId || can.manage) && <Button size="sm" kind="ghost" renderIcon={Undo} disabled={busy === `rev-${d.id}`} onClick={() => run(`rev-${d.id}`, () => del(`/sessions/${s.id}/delegations/${d.id}`), "Delegation revoked")}>Revoke</Button>}</div>
                </div>))}
            </div>}
          </section>

          <section className="ag-section ag-span"><h2>Notes</h2>
            {can.manage && !closed ? (
              <div className="ag-form">
                <TextArea id="ses-notes" labelText="Secretary's notes (markdown)" helperText="The only human-written part of the minutes; everything else is derived." rows={6} value={notes ?? s.notes_md ?? ""} onChange={(e) => setNotes(e.target.value)} />
                <div className="ag-row snug">{busy === "notes" ? <InlineLoading description="Saving" /> : <Button size="sm" kind="tertiary" renderIcon={Save} disabled={notes === null || notes === (s.notes_md ?? "")} onClick={() => run("notes", () => put(`/sessions/${s.id}/notes`, { notes_md: notes }), "Notes saved").then(() => setNotes(null))}>Save Notes</Button>}
                  {/* derive→narrate: the AI drafts prose from the records into the field; the secretary edits and saves it as their own */}
                  {aiOn.draft_minutes && (busy === "ai-notes" ? <InlineLoading description="Drafting from the records" /> : <Button size="sm" kind="ghost" renderIcon={MachineLearningModel} onClick={() => run("ai-notes", async () => { const r: any = await post(`/sessions/${s.id}/draft-notes`); setNotes(r.notes_md); }, "AI draft inserted — edit and save it as your own")}>Draft Notes with AI</Button>)}</div>
              </div>)
              : s.notes_md ? <Markdown md={s.notes_md} /> : <p className="ag-muted ag-body">No notes.</p>}
          </section>
        </div>
      </div>

      {modal?.kind === "close" && (
        <Modal open modalHeading={`Close ${s.code}?`} primaryButtonText="Close Session" secondaryButtonText="Cancel" primaryButtonDisabled={busy === "close"} onRequestClose={() => setModal(null)} onRequestSubmit={() => { setModal(null); run("close", () => post(`/sessions/${s.id}/close`, notes !== null ? { notes_md: notes } : {}), "Session closed; minutes derived").then(() => setNotes(null)); }}>
          <div className="ag-form">
            <p className="ag-body"><span className="ag-strong">{declared} declared, {deferred} deferred</span>{notReached ? ` · ${notReached} not reached (deferred on close as "not reached")` : ""}{items.some((it) => it.state === "called") ? " · every called item must be declared or deferred first" : ""}.</p>
            <p className="ag-muted ag-body">Closing derives the minutes, hashes them into the audit chain and freezes positions on declared items.</p>
            <div><div className="ag-label ag-muted">Secretary's notes</div>{(notes ?? s.notes_md) ? <Markdown md={notes ?? s.notes_md} /> : <p className="ag-muted ag-body">No notes.</p>}</div>
          </div>
        </Modal>)}

      {modal?.kind === "delegate" && <DelegateModal s={s} myId={myId} mine={mine} users={users || []} initialAreas={modal.areas} busy={busy === "delegate"} onClose={() => setModal(null)} onSubmit={(body) => { setModal(null); return run("delegate", () => post(`/sessions/${s.id}/delegations`, body), (r: any) => `Seat delegated to ${r?.delegate_name || body.delegate} for this session`); }} />}

      {modal?.kind === "declare" && <DeclareModal reviewId={modal.item.review.id} onClose={() => setModal(null)} onSubmit={(body) => post(`/sessions/${s.id}/items/${modal.item.review.id}/declare`, body).then(() => { setMsg({ kind: "success", text: `${modal.item.review.code} declared ${labelFor("outcome", body.outcome).toLowerCase()}` }); reload(); })} />}

      {modal?.kind === "defer" && (
        <Modal open modalHeading={`Defer ${modal.item.review.code}`} primaryButtonText="Defer" secondaryButtonText="Cancel" primaryButtonDisabled={!modal.reason?.trim()} onRequestClose={() => setModal(null)} onRequestSubmit={() => { const m = modal; setModal(null); run("defer", () => post(`/sessions/${s.id}/items/${m.item.review.id}/defer`, { reason: m.reason }), `${m.item.review.code} deferred to the next session`); }}>
          <div className="ag-form"><p className="ag-body">The item stays in review and goes on the next agenda; the reason is recorded on the review and in the minutes.</p><TextArea id="defer-reason" labelText="Reason" rows={3} value={modal.reason || ""} onChange={(e) => setModal({ ...modal, reason: e.target.value })} /></div>
        </Modal>)}

      {modal?.kind === "nominate" && (
        <Modal open modalHeading={`Acting Chair for ${modal.item.review.code}`} primaryButtonText="Nominate" secondaryButtonText="Cancel" primaryButtonDisabled={!modal.acting_chair} onRequestClose={() => setModal(null)} onRequestSubmit={() => { const m = modal; setModal(null); run("nominate", () => post(`/sessions/${s.id}/items/${m.item.review.id}/nominate`, { acting_chair: m.acting_chair }), `${nameOf(m.acting_chair)} will chair ${m.item.review.code}`); }}>
          <div className="ag-form"><p className="ag-body">A chair who authored an item never acts on it. The acting chair calls, resolves and declares this item only; they must hold a decision-maker seat and not be its author.</p>
            <Select id="nom" labelText="Acting chair" value={modal.acting_chair || ""} onChange={(e) => setModal({ ...modal, acting_chair: e.target.value })}><SelectItem value="" text="Choose a decision maker" />{attendance.filter((a) => normaliseSeat(a.board_role) === "decision_maker" && a.user_id !== modal.item.review.submitted_by && !a.on_behalf_of).map((a) => <SelectItem key={a.user_id} value={a.user_id} text={a.name || a.user_id} />)}</Select></div>
        </Modal>)}

      {modal?.kind === "consent" && (
        <Modal open modalHeading={`Declare ${consentItems.length} Consent Item${consentItems.length === 1 ? "" : "s"}?`} primaryButtonText="Declare All" secondaryButtonText="Cancel" onRequestClose={() => setModal(null)} onRequestSubmit={() => { const m = modal; setModal(null); run("consent", () => post(`/sessions/${s.id}/consent/declare`, m.rationale?.trim() ? { rationale: m.rationale } : {}), (r: any) => `${r?.declared ?? consentItems.length} declared${r?.skipped?.length ? ` · ${r.skipped.length} skipped` : ""}`); }}>
          <div className="ag-form"><p className="ag-body">Each item is declared approved (or approved with conditions where it already carries some), with one audit row and one timeline event each. Pull an item first to discuss it instead.</p>
            <ul className="ag-suggest">{consentItems.map((it) => <li key={it.review.id}><span className="ag-body">{it.review.code} · {it.review.title}</span></li>)}</ul>
            <TextArea id="consent-rat" labelText="Rationale (optional, recorded on every item)" rows={2} value={modal.rationale || ""} onChange={(e) => setModal({ ...modal, rationale: e.target.value })} /></div>
        </Modal>)}
    </>
  );
}

/**
 * The agenda (or its consent group) as a DataTable: position, the review, who wrote it, its areas by position state (the
 * ones waiting on *me* filled), its state, and the chair's actions. A design shows its risk tier; the pre-review verdict
 * rides along when the server puts it on the item.
 */
function AgendaTable({ s, items, consent, busy, run, setModal, gate, myId }: { s: any; items: any[]; consent?: boolean; busy: string | null; run: (key: string, fn: () => Promise<any>, ok?: string) => Promise<void>; setModal: (m: any) => void; gate: (ok: boolean, cap: string, reason: string, button: React.ReactElement<any>) => React.ReactNode; myId: string }) {
  const can = s.can || {};
  const open = s.status === "open";
  const closed = s.status === "closed";
  const chairReason = `Needs the chair of ${s.board?.name || "this board"}`;
  const rows = items.map((it, i) => ({ id: it.review.id, n: String(i + 1), review: it.review.code, type: labelFor("review_type", it.review.type), author: it.review.submitted_by_name || it.review.submitted_by, areas: "", state: it.review.item_state || it.state, actions: "" }));
  const headers = closed ? AGENDA_HEADERS.filter((h) => h.key !== "actions") : AGENDA_HEADERS;
  return (
    <DataTable rows={rows} headers={headers}>
      {({ rows, headers, getHeaderProps, getRowProps, getTableProps }: any) => (
        <TableContainer>
          <Table {...getTableProps()} size="md">
            <TableHead><TableRow>{headers.map((h: any) => <TableHeader {...getHeaderProps({ header: h })} key={h.key} className={h.key === "areas" ? "ag-col-areas" : undefined}>{h.header}</TableHeader>)}</TableRow></TableHead>
            <TableBody>{rows.map((r: any) => {
              const it = items.find((x) => x.review.id === r.id)!; const rv = it.review; const p = rv.progress;
              const live = LIVE(it) && !closed;
              const state = it.state === "declared" || it.state === "deferred" || it.state === "withdrawn" ? it.state : rv.item_state || (it.state === "called" ? "awaiting_positions" : it.state);
              return (
                <TableRow {...getRowProps({ row: r })} key={r.id}>
                  <TableCell>{r.cells[0].value}</TableCell>
                  <TableCell><RLink to={`/reviews/${rv.id}`}>{rv.code}</RLink><div className="ag-label">{rv.title}</div>{rv.deferred_count > 0 || it.acting_chair ? <div className="ag-muted ag-label">{rv.deferred_count > 0 ? `deferred ${rv.deferred_count} time${rv.deferred_count === 1 ? "" : "s"}` : ""}{rv.deferred_count > 0 && it.acting_chair ? " · " : ""}{it.acting_chair ? `acting chair ${it.acting_chair_name || it.acting_chair}` : ""}</div> : null}</TableCell>
                  <TableCell><div className="ag-row tight"><KindTag kind="review_type" value={rv.type} />{rv.type === "design" && rv.risk_tier && <StatusTag kind="risk" value={rv.risk_tier} size="sm" />}{rv.pre_review?.recommendation && <StatusTag kind="recommendation" value={String(rv.pre_review.recommendation).replace(/\s+/g, "_")} size="sm" label={`Pre-review: ${sentence(rv.pre_review.recommendation).toLowerCase()}`} />}</div></TableCell>
                  <TableCell>{rv.submitted_by_name || rv.submitted_by}</TableCell>
                  <TableCell className="ag-col-areas"><div className="ag-row tight">
                    {p?.mode === "areas" && Array.isArray(p.areas) && p.areas.length ? p.areas.map((a: any) => <AreaPositionTag key={a.area} area={a.area} label={a.label} state={a.state} size="sm" mine={a.mine === true || (a.mine === undefined && (a.owners || []).includes(myId))} />)
                      : Array.isArray(rv.areas) && rv.areas.length ? rv.areas.map((a: string) => <AreaTag key={a} id={a} />)
                      : p && typeof p.required === "number" ? <span className="ag-label ag-muted">{p.received ?? 0} of {p.required} approvals</span> : <span className="ag-muted">—</span>}
                  </div></TableCell>
                  <TableCell><div className="ag-row tight"><StatusTag kind="item_state" value={state} />{it.state === "called" && <StatusTag kind="item_state" value="called" />}{it.state === "declared" && it.outcome && <StatusTag kind="outcome" value={it.outcome} />}</div></TableCell>
                  {!closed && <TableCell><div className="ag-actions">
                    {busy && busy.endsWith(rv.id) ? <InlineLoading description="Working" /> : <>
                      {open && it.state === "listed" && gate(!!can.call, "decide_review", chairReason, <Button size="sm" kind="ghost" renderIcon={Bullhorn} onClick={() => run(`call-${rv.id}`, () => post(`/sessions/${s.id}/items/${rv.id}/call`), `${rv.code} called`)}>Call</Button>)}
                      {consent && open && it.state === "listed" && gate(!!can.consent, "decide_review", chairReason, <Button size="sm" kind="ghost" renderIcon={Undo} onClick={() => run(`pull-${rv.id}`, () => post(`/sessions/${s.id}/items/${rv.id}/pull`), `${rv.code} pulled from the consent agenda`)}>Pull</Button>)}
                      {open && live && gate(!!can.declare, "decide_review", chairReason, <Button size="sm" kind="ghost" renderIcon={Checkmark} onClick={() => setModal({ kind: "declare", item: it })}>Declare</Button>)}
                      {open && live && gate(!!can.declare, "decide_review", chairReason, <Button size="sm" kind="ghost" renderIcon={Time} onClick={() => setModal({ kind: "defer", item: it, reason: "" })}>Defer</Button>)}
                      {live && can.nominate && <Button size="sm" kind="ghost" renderIcon={UserMultiple} onClick={() => setModal({ kind: "nominate", item: it, acting_chair: it.acting_chair || "" })}>Nominate</Button>}
                    </>}
                  </div></TableCell>}
                </TableRow>); })}</TableBody>
          </Table>
        </TableContainer>)}
    </DataTable>
  );
}

/** A decision maker hands their seat to another user for this sitting: one hop, never to an auditor, a service account or the author of an item on the agenda. */
function DelegateModal({ s, myId, mine, users, initialAreas, busy, onClose, onSubmit }: { s: any; myId: string; mine: any; users: any[]; initialAreas: string[]; busy: boolean; onClose: () => void; onSubmit: (body: { delegate: string; areas?: string[] }) => Promise<void> }) {
  const [delegate, setDelegate] = React.useState("");
  const [areas, setAreas] = React.useState<string[]>(initialAreas);
  const authors = new Set((s.items || []).map((it: any) => it.review?.submitted_by));
  const takenDelegates = new Set((s.delegations || []).filter((d: any) => !d.revoked_at).map((d: any) => d.delegate));
  const candidates = users.filter((u) => u.id !== myId && !["auditor", "service"].includes(u.user_type) && !authors.has(u.id) && !takenDelegates.has(u.id));
  const myAreas: string[] = mine?.areas || initialAreas || [];
  const areaItems = myAreas.map((a) => ({ id: a, label: areaLabel(a) }));
  return (
    <Modal open modalHeading="Delegate My Seat for This Session" primaryButtonText="Delegate" secondaryButtonText="Cancel" primaryButtonDisabled={!delegate || busy || (myAreas.length > 0 && areas.length === 0)} onRequestClose={onClose} onRequestSubmit={() => onSubmit(myAreas.length ? { delegate, areas } : { delegate })}>
      <div className="ag-form">
        <p className="ag-body">The delegate records positions as themselves, on behalf of your seat, for this sitting only. One hop: a delegate cannot delegate on. You keep the right to record or change a position yourself until the session closes.</p>
        <Select id="dlg-user" labelText="Delegate to" value={delegate} onChange={(e) => setDelegate(e.target.value)}>
          <SelectItem value="" text={candidates.length ? "Choose a user" : "No eligible users"} />
          {candidates.map((u) => <SelectItem key={u.id} value={u.id} text={`${u.name || u.id}${u.user_type ? ` · ${labelFor("user_type", u.user_type)}` : ""}`} />)}
        </Select>
        {myAreas.length > 0 && <MultiSelect id="dlg-areas" titleText="Areas" helperText="Which of your areas the delegate covers; all of them by default." label={areas.length ? areas.map((a) => areaLabel(a)).join(", ") : "Choose areas"} items={areaItems} itemToString={(x: any) => x?.label || ""} initialSelectedItems={areaItems.filter((x) => initialAreas.includes(x.id))} onChange={({ selectedItems }: any) => setAreas(selectedItems.map((y: any) => y.id))} />}
        <p className="ag-muted ag-label">Not allowed: auditors, service accounts, the author of any item on this agenda, or someone already delegated to in this session.</p>
      </div>
    </Modal>
  );
}
