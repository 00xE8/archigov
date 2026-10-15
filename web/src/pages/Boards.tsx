import React from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Table, TableHead, TableRow, TableHeader, TableBody, TableCell, TableContainer, DataTableSkeleton, SkeletonText, Button, Modal, TextInput, TextArea, Select, SelectItem, Dropdown, NumberInput, MultiSelect, InlineNotification, InlineLoading, Tag, Checkbox, FormGroup } from "@carbon/react";
import { Add, Edit, TrashCan, Save, Calendar, User, TreeViewAlt, Flow } from "@carbon/icons-react";
import { get, post, put, del, labelFor, fmtDateTime, REVIEW_TYPES, BOARD_ROLES, BOARD_ROLE_LABELS, APPROVAL_SEATS, DECISION_SEATS, NO_SYSTEM_ROLE, normaliseSeat, ARTEFACT_KINDS, SEEDED_AREAS, AREA_LABELS, areaLabel } from "../api";
import { PageHeader, PageIntro, useLoad, LoadError, RLink, StatusTag, EmptyState, Empty, Crumbs, KindTag, AreaTag, progressText, useDocTitle } from "../components";
import { Gated, useCan, useAuth } from "../auth";
import { NewSessionModal } from "../components/NewSessionModal";

const seatList = (roles: string[]) => roles.map((r) => labelFor("board_role", r).toLowerCase()).join(" or ");
const defaultSeats = (kind: string, mode?: string) => (kind === "decision" ? DECISION_SEATS : mode === "areas" ? ["decision_maker"] : APPROVAL_SEATS);
type Area = { id: string; label: string };
/** The API's `areas` may be ids or {id,label}; the UI always works with {id,label}. */
const asAreas = (list: any): Area[] => (Array.isArray(list) ? list.map((a) => (typeof a === "string" ? { id: a, label: areaLabel(a) } : { id: a.id, label: a.label || areaLabel(a.id) })) : []);
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
/** A custom area's id from its label: lower-case words joined by hyphens, the way the seeded ids read. */
const areaSlug = (s: string) => String(s || "").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();

export default function Boards() {
  const [list, reload, err] = useLoad<any[]>(() => get("/boards"));
  // Next sitting per board comes from the sessions list (the board row may also carry `next_session` on a newer server).
  const [sessions] = useLoad<any[]>(() => get<any[]>("/sessions").catch(() => []));
  const [form, setForm] = React.useState<any>(null);
  const [msg, setMsg] = React.useState<string | null>(null);
  const nav = useNavigate();
  useDocTitle("Boards");
  const header = <PageIntro title="Boards" lead="The bodies that approve what goes into the catalogue and what gets built."
    about="Who sits on each board, which areas of responsibility each decision maker owns, which reviews the board receives, the approval policy each review type must satisfy, and the sessions at which the chair declares outcomes. A board with areas runs its approvals by area; a board without counts approvals."
    actions={<Gated cap="manage_platform"><Button size="md" renderIcon={Add} disabled={!list} onClick={() => setForm({ code: "", name: "", purpose: "" })}>New Board</Button></Gated>} />;
  if (err) return <>{header}<LoadError what="boards" err={err} onRetry={reload} /></>;
  if (!list) return <>{header}<DataTableSkeleton columnCount={6} rowCount={4} showHeader={false} showToolbar={false} /></>;
  const nextFor = (b: any) => {
    if (b.next_session) return b.next_session;
    const own = (sessions || []).filter((s) => (s.board?.id || s.board_id) === b.id && (s.status === "open" || s.status === "planned"));
    return own.find((s) => s.status === "open") || own.filter((s) => s.status === "planned").sort((x, y) => String(x.scheduled_at).localeCompare(String(y.scheduled_at)))[0] || null;
  };
  // Areas nobody owns: a review touching one cannot be approved until a decision maker (or a delegate) covers it.
  const unowned = (b: any): string[] => (Array.isArray(b.area_coverage) ? b.area_coverage.filter((c: any) => !(c.owners || []).length).map((c: any) => areaLabel(c.area, asAreas(b.areas))) : []);
  return (
    <>
      {header}
      {msg && <InlineNotification kind="error" lowContrast title={msg} onCloseButtonClick={() => setMsg(null)} className="ag-notice" />}
      {list.length === 0 ? (
        <EmptyState title="No boards yet" actions={<Gated cap="manage_platform"><Button size="md" renderIcon={Add} onClick={() => setForm({ code: "", name: "", purpose: "" })}>New Board</Button></Gated>}>
          Reviews are routed to a board by their type; the board's approval policy says who must approve before the chair decides. Loading the demo estate creates a Design Authority and a Policy &amp; Compliance Board.
        </EmptyState>
      ) : (
        <TableContainer><Table size="md">
          <TableHead><TableRow><TableHeader>Code</TableHeader><TableHeader>Board</TableHeader><TableHeader>Purpose</TableHeader><TableHeader>Members</TableHeader><TableHeader>In Flight</TableHeader><TableHeader>Next Session</TableHeader></TableRow></TableHead>
          <TableBody>{list.map((b) => { const next = nextFor(b); const gaps = unowned(b); return (
            <TableRow key={b.id}>
              <TableCell><RLink to={`/boards/${b.id}`}>{b.code}</RLink></TableCell>
              <TableCell><div className="ag-row tight">{b.name}{gaps.length > 0 && <span title={`No decision maker owns ${gaps.join(", ")}`}><StatusTag kind="quorum" value="uncovered" size="sm" label={`Unowned: ${gaps.join(", ")}`} /></span>}</div></TableCell>
              <TableCell className="ag-wrap">{b.purpose || <span className="ag-muted">—</span>}</TableCell>
              <TableCell>{typeof b.members === "number" ? b.members : Array.isArray(b.members) ? b.members.length : "—"}</TableCell>
              <TableCell>{b.in_flight ? <StatusTag kind="stage" value="in_review" label={`${b.in_flight} in review`} /> : <span className="ag-muted">0</span>}</TableCell>
              <TableCell>{next ? <span className="ag-row tight"><RLink to={`/sessions/${next.id}`}>{next.code}</RLink><span className="ag-muted ag-label">{fmtDateTime(next.scheduled_at)}</span>{next.status === "open" && <StatusTag kind="session_status" value="open" size="sm" />}</span> : <span className="ag-muted">{b.sessions_planned ? `${b.sessions_planned} planned` : "—"}</span>}</TableCell>
            </TableRow>); })}</TableBody>
        </Table></TableContainer>)}
      <Modal open={!!form} modalHeading="New Board" primaryButtonText="Create" secondaryButtonText="Cancel" primaryButtonDisabled={!form?.code?.trim() || !form?.name?.trim()} onRequestClose={() => setForm(null)}
        onRequestSubmit={async () => { try { const b: any = await post("/boards", form); setForm(null); reload(); if (b?.id) nav(`/boards/${b.id}`); } catch (e: any) { setMsg(String(e.message || e)); } }}>
        {form && <div className="ag-form">
          <p className="ag-body ag-muted">A new board starts empty: after creating it you will seat a chair and decision makers, add routing rules and set a workflow per review type — the board page walks you through what is missing.</p>
          <TextInput id="b-code" labelText="Code" placeholder="e.g. DA" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} />
          <TextInput id="b-name" labelText="Name" placeholder="e.g. Design Authority" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <TextArea id="b-purpose" labelText="Purpose" rows={2} placeholder="e.g. Approves designs, decisions, standards and patterns for the trust." value={form.purpose} onChange={(e) => setForm({ ...form, purpose: e.target.value })} />
        </div>}
      </Modal>
    </>
  );
}

export function BoardDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const [b, reload, err] = useLoad<any>(() => get(`/boards/${id}`), [id]);
  const [users] = useLoad<any[]>(() => get<any[]>("/users").catch(() => []));
  // The board carries its last five sessions; the full list comes from its own route (absent on an older server).
  const [sessions, reloadSessions] = useLoad<any[] | null>(() => get<any[]>(`/boards/${id}/sessions`).catch(() => null), [id]);
  const [msg, setMsg] = React.useState<{ kind: "success" | "error"; text: string } | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [edit, setEdit] = React.useState<any>(null);
  const [member, setMember] = React.useState<{ user_id: string; board_role: string; areas: string[] }>({ user_id: "", board_role: "decision_maker", areas: [] });
  const [areaEdits, setAreaEdits] = React.useState<Record<string, string[]>>({});
  // The row whose areas are being edited: the MultiSelect renders only there, so the table stays narrow the rest of the time.
  const [editingAreas, setEditingAreas] = React.useState<string | null>(null);
  const [areasForm, setAreasForm] = React.useState<{ selected: string[]; custom: Area[]; newLabel: string; newId: string } | null>(null);
  const [routing, setRouting] = React.useState<any[] | null>(null);
  const [policy, setPolicy] = React.useState<{ type: string; steps: any[] } | null>(null);
  const [session, setSession] = React.useState(false);
  const [removeM, setRemoveM] = React.useState<any>(null); // member pending removal (danger confirm names the consequence)
  // The structure and flow diagrams open full-size on demand; the page itself stays a scannable summary.
  const [viewComposition, setViewComposition] = React.useState(false);
  const [viewFlow, setViewFlow] = React.useState<{ types: string[]; steps: any[] } | null>(null);
  const globalManage = useCan("manage_platform");
  const { me } = useAuth();
  useDocTitle(b ? b.name : null);
  if (err) return <LoadError what="this board" err={err} onRetry={reload} />;
  if (!b) return <SkeletonText paragraph lineCount={8} />;
  const canManage: boolean = b.can_manage ?? globalManage;
  // Areas are configuration (the platform admin or the board's chair, not its secretary); sessions are run by the chair or secretary. The server is the authority either way.
  const mySeat: string | undefined = (me?.user?.boards || []).find((x) => x.id === b.id || x.code === b.code)?.role;
  const canAreas: boolean = b.can?.areas ?? (b.can ? !!me?.user?.is_platform_admin || mySeat === "chair" : canManage);
  const canSessions: boolean = b.can?.sessions === true;
  const run = async (key: string, fn: () => Promise<any>, ok: string) => { setBusy(key); setMsg(null); try { await fn(); setMsg({ kind: "success", text: ok }); reload(); reloadSessions(); } catch (e: any) { setMsg({ kind: "error", text: String(e.message || e).split("\n")[0] }); } finally { setBusy(null); } };
  const members: any[] = b.members || [];
  const areas = asAreas(b.areas);
  const areaItems = areas.map((a) => ({ id: a.id, label: a.label }));
  const isDm = (m: any) => normaliseSeat(m.board_role) === "decision_maker";
  // Who owns each area: the server's view when it gives one, else decision makers whose areas include it.
  const coverage: { area: string; owners: string[] }[] = Array.isArray(b.area_coverage) ? b.area_coverage : areas.map((a) => ({ area: a.id, owners: members.filter((m) => isDm(m) && (m.areas || []).includes(a.id)).map((m) => m.user_id) }));
  const uncovered = coverage.filter((c) => !(c.owners || []).length).map((c) => areaLabel(c.area, areas));
  const sessionList: any[] = sessions ?? (Array.isArray(b.sessions) ? b.sessions : []);
  const showSessions = canSessions || sessions !== null || Array.isArray(b.sessions);
  const policies: Record<string, any> = b.policies || {};
  const policyTypes = Object.keys(policies);
  const roleItems = BOARD_ROLES.map((r) => ({ id: r, label: BOARD_ROLE_LABELS[r] }));
  const candidates = (users || []).filter((u) => !members.some((m) => m.user_id === u.id));
  const memberAreas = (m: any) => areaEdits[m.user_id] ?? (m.areas || []);
  const openAreasEditor = () => setAreasForm({ selected: areas.map((a) => a.id), custom: areas.filter((a) => !SEEDED_AREAS.includes(a.id)), newLabel: "", newId: "" });
  const nameOf = (uid: string) => members.find((m) => m.user_id === uid)?.name || uid;
  const openPolicyEditor = (t: string) => setPolicy({ type: t, steps: (policies[t]?.steps || []).map((s: any) => ({ name: s.name || labelFor("step", s.kind), kind: s.kind || "approvals", mode: s.mode === "areas" ? "areas" : "count", min: s.min ?? 1, roles: Array.from(new Set<string>((s.roles || defaultSeats(s.kind, s.mode)).map(normaliseSeat))) })) });
  const bySeat = (r: string) => members.filter((m) => normaliseSeat(m.board_role) === r).map((m) => m.name || m.user_id);
  const supportNames = members.filter((m) => ["reviewer", "secretary", "observer"].includes(normaliseSeat(m.board_role))).map((m) => m.name || m.user_id);
  const seatSummary = [
    bySeat("chair").length ? `Chair ${bySeat("chair").join(", ")}` : "No chair",
    bySeat("decision_maker").length ? `Decision makers ${bySeat("decision_maker").join(", ")}` : "No decision makers",
    ...(supportNames.length ? [`Advisory & support ${supportNames.join(", ")}`] : []),
  ].join(" · ");
  return (
    <>
      <PageHeader breadcrumb={<Crumbs items={[{ to: "/boards", label: "Boards" }, { label: b.code }]} />} title={b.name}
        subtitle={<span>{b.code}{b.purpose ? ` · ${b.purpose}` : ""}</span>}
        about="Who sits on this board and in which seat, which areas each decision maker owns, which reviews are routed here, the steps each review type passes before the chair declares, and the sessions it sits in. Changing members, routing or policies needs the chair, the secretary or a platform admin; rights in a review always come from the seat."
        actions={canManage ? <Button size="md" kind="ghost" renderIcon={Edit} onClick={() => setEdit({ name: b.name, purpose: b.purpose || "" })}>Edit Name &amp; Purpose</Button> : undefined} />
      {msg && <InlineNotification kind={msg.kind} lowContrast title={msg.text} onCloseButtonClick={() => setMsg(null)} className="ag-notice" />}
      {/* Setup callout (persistent, near the content it concerns): a board missing any of these cannot do its job, and each gap names its fix. */}
      {canManage && (!bySeat("chair").length || !bySeat("decision_maker").length || !(b.routing || []).length || !policyTypes.length) && (
        <InlineNotification kind="info" lowContrast hideCloseButton className="ag-notice" title="This board is not fully set up"
          subtitle={[
            !bySeat("chair").length ? "add a chair under Composition (nothing can be declared without one)" : "",
            !bySeat("decision_maker").length ? "add decision makers (the approvals step cannot be satisfied)" : "",
            !(b.routing || []).length ? "add a routing rule under Decision Flow (no reviews arrive here on their own)" : "",
            !policyTypes.length ? "add a workflow for at least one review type (until then the chair can declare at once)" : "",
          ].filter(Boolean).join(" · ")} />)}
      {uncovered.length > 0 && <InlineNotification kind="warning" lowContrast hideCloseButton className="ag-notice" title={`No decision maker owns ${uncovered.join(", ")}`} subtitle="A review touching that area cannot be approved in areas mode until a decision maker owns it, or a delegate covers it for the session." />}

      {/* 1 · Who the board is: the structure, who owns which area, and — for whoever runs it — member management.
          The tiers carry name, seat and areas for every reader; the table beneath is the editing surface, not a second listing. */}
      <section className="ag-section">
        <div className="ag-row between"><h2>Composition</h2><Button size="sm" kind="tertiary" renderIcon={TreeViewAlt} onClick={() => setViewComposition(true)}>View Composition</Button></div>
        <p className="ag-muted ag-body">{seatSummary}.</p>
        <div className="ag-subhead"><h3>Area Ownership ({areas.length})</h3>{canAreas && <Button size="sm" kind="ghost" renderIcon={Edit} onClick={openAreasEditor}>Edit Areas</Button>}</div>
        <p className="ag-muted ag-body ag-mb-03">Each review touches one or more areas, derived from what it cites and what it builds; every touched area needs its owner's position before the chair can declare. A board with no areas counts approvals instead.</p>
        {areas.length === 0 ? <Empty>No areas: every policy on this board runs in count mode.</Empty> : (
          <div className="ag-coverage-grid">
            {coverage.map((c) => (
              <div className={`ag-coverage-cell${(c.owners || []).length ? "" : " uncovered"}`} key={c.area}>
                <div className="ag-label ag-strong">{areaLabel(c.area, areas)}</div>
                {(c.owners || []).length ? <div className="ag-label ag-muted">{c.owners.map(nameOf).join(", ")}</div> : <StatusTag kind="quorum" value="uncovered" size="sm" label="Unowned" />}
              </div>))}
          </div>)}
        {canManage && <>
          <div className="ag-subhead"><h3>Manage Members ({members.length})</h3></div>
          {members.length === 0 ? <Empty>No members yet. A board with no chair cannot decide anything.</Empty> : (
            // TableContainer so the row being edited (its MultiSelect widens the Areas column) scrolls instead of clipping.
            <TableContainer><Table size="sm"><TableHead><TableRow><TableHeader>Name</TableHeader><TableHeader>System Role</TableHeader><TableHeader>Seat</TableHeader>{areas.length > 0 && <TableHeader>Areas</TableHeader>}<TableHeader>Actions</TableHeader></TableRow></TableHead>
              <TableBody>{members.map((m) => {
                const changed = isDm(m) && !sameSet(memberAreas(m), m.areas || []);
                return (
                <TableRow key={m.user_id}>
                  <TableCell>{m.name || m.user_id}</TableCell>
                  <TableCell>{m.user_type ? <KindTag kind="user_type" value={m.user_type} /> : <span className="ag-muted">{NO_SYSTEM_ROLE}</span>}</TableCell>
                  <TableCell><KindTag kind="board_role" value={m.board_role} /></TableCell>
                  {areas.length > 0 && <TableCell>{!isDm(m) ? <span className="ag-muted">—</span>
                    : editingAreas === m.user_id ? <MultiSelect id={`ma-${m.user_id}`} titleText="Areas" hideLabel label={memberAreas(m).length ? memberAreas(m).map((a) => areaLabel(a, areas)).join(", ") : "Choose areas"} size="sm" items={areaItems} itemToString={(x: any) => x?.label || ""} initialSelectedItems={areaItems.filter((x) => (m.areas || []).includes(x.id))} onChange={({ selectedItems }: any) => setAreaEdits({ ...areaEdits, [m.user_id]: selectedItems.map((y: any) => y.id) })} />
                    : <div className="ag-row tight">{(m.areas || []).length ? (m.areas as string[]).map((a) => <AreaTag key={a} id={a} boardAreas={areas} />) : <span className="ag-muted">None</span>}<Button size="sm" kind="ghost" renderIcon={Edit} iconDescription="Edit areas" hasIconOnly onClick={() => setEditingAreas(m.user_id)} /></div>}</TableCell>}
                  <TableCell><div className="ag-actions">
                    {busy === `areas-${m.user_id}` ? <InlineLoading description="Saving" /> : editingAreas === m.user_id && <>
                      <Button size="sm" kind="tertiary" renderIcon={Save} disabled={!changed} onClick={() => run(`areas-${m.user_id}`, () => put(`/boards/${b.id}/members/${encodeURIComponent(m.user_id)}`, { areas: memberAreas(m) }), `Areas for ${m.name || m.user_id} saved`).then(() => { setEditingAreas(null); setAreaEdits(({ [m.user_id]: _x, ...rest }) => rest); })}>Save</Button>
                      <Button size="sm" kind="ghost" onClick={() => { setEditingAreas(null); setAreaEdits(({ [m.user_id]: _x, ...rest }) => rest); }}>Cancel</Button>
                    </>}
                    {busy === `rm-${m.user_id}` ? <InlineLoading description="Removing" /> : <Button size="sm" kind="ghost" renderIcon={TrashCan} iconDescription="Remove from board" hasIconOnly onClick={() => setRemoveM(m)} />}
                  </div></TableCell>
                </TableRow>); })}</TableBody></Table></TableContainer>)}
          <div className="ag-filters ag-mt-05">
            <Select id="m-user" labelText="Add member" value={member.user_id} onChange={(e) => setMember({ ...member, user_id: e.target.value })}>
              <SelectItem value="" text={candidates.length ? "Choose a user" : "No users to add — create one under Settings · Users & access"} />
              {candidates.map((u) => <SelectItem key={u.id} value={u.id} text={`${u.name || u.id} · ${u.user_type ? labelFor("user_type", u.user_type) : NO_SYSTEM_ROLE}`} />)}
            </Select>
            <Dropdown id="m-role" titleText="Seat" label="Seat" items={roleItems} itemToString={(i: any) => i?.label || ""} selectedItem={roleItems.find((i) => i.id === member.board_role)} onChange={({ selectedItem }: any) => selectedItem && setMember({ ...member, board_role: selectedItem.id })} />
            {member.board_role === "decision_maker" && areas.length > 0 && <MultiSelect id="m-areas" titleText="Areas owned" label={member.areas.length ? member.areas.map((a) => areaLabel(a, areas)).join(", ") : "Choose areas"} items={areaItems} itemToString={(x: any) => x?.label || ""} onChange={({ selectedItems }: any) => setMember({ ...member, areas: selectedItems.map((y: any) => y.id) })} />}
            {busy === "add" ? <InlineLoading description="Adding" /> : <Button size="md" kind="tertiary" renderIcon={Add} disabled={!member.user_id} onClick={() => run("add", () => post(`/boards/${b.id}/members`, member.board_role === "decision_maker" ? member : { user_id: member.user_id, board_role: member.board_role }), "Member added").then(() => setMember({ user_id: "", board_role: "decision_maker", areas: [] }))}>Add</Button>}
          </div>
        </>}
      </section>

      {/* 2 · The board at work: its sittings beside what waits on it. */}
      <div className="ag-grid-2">
          {showSessions && <section className="ag-section"><h2>Sessions ({sessionList.length})</h2>
            <p className="ag-muted ag-body ag-mb-03">A sitting of the board. The agenda is derived from the reviews routed here; the chair calls each item, declares the outcome its positions allow, and the minutes are derived and hashed on close.</p>
            {sessionList.length === 0 ? <Empty>No sessions yet.{canSessions ? " Plan one and the agenda is derived from what is in review." : ""}</Empty> : (
              <Table size="sm"><TableHead><TableRow><TableHeader>Session</TableHeader><TableHeader>Date</TableHeader><TableHeader>Status</TableHeader><TableHeader>Items</TableHeader><TableHeader>Declared / Deferred</TableHeader></TableRow></TableHead>
                <TableBody>{sessionList.map((s: any) => (
                  <TableRow key={s.id}>
                    <TableCell><RLink to={`/sessions/${s.id}`}>{s.code}</RLink>{s.title ? <div className="ag-muted ag-label">{s.title}</div> : null}</TableCell>
                    <TableCell>{fmtDateTime(s.scheduled_at)}</TableCell>
                    <TableCell><StatusTag kind="session_status" value={s.status} /></TableCell>
                    <TableCell>{s.items ?? "—"}</TableCell>
                    <TableCell>{typeof s.declared === "number" || typeof s.deferred === "number" ? `${s.declared ?? 0} / ${s.deferred ?? 0}` : <span className="ag-muted">—</span>}</TableCell>
                  </TableRow>))}</TableBody></Table>)}
            {canSessions && <div className="ag-mt-03"><Button size="sm" kind="tertiary" renderIcon={Calendar} onClick={() => setSession(true)}>New Session</Button></div>}
          </section>}

          <section className="ag-section"><h2>Reviews in Flight ({(b.reviews_in_flight || []).length})</h2>
            {(b.reviews_in_flight || []).length === 0 ? <Empty>Nothing waiting on this board.</Empty> : b.reviews_in_flight.map((r: any) => (
              <div className="ag-finding" key={r.id}><div className="ag-row snug"><RLink to={`/reviews/${r.id}`} className="title">{r.code} · {r.title}</RLink><KindTag kind="review_type" value={r.type} /><StatusTag kind="stage" value={r.stage} /></div>{r.progress && <div className="detail ag-muted">{progressText(r.progress)}</div>}</div>))}
          </section>
      </div>

      {/* 3 · How reviews are decided: how they arrive (routing), then the steps each type must pass — full width, the flow needs the page. */}
      <section className="ag-section"><h2>Decision Flow</h2>
        <p className="ag-muted ag-body ag-mb-03">Reviews arrive here by routing rule and pass the steps set for their type; the chair declares once those steps are satisfied. The UI shows progress against these steps; the server enforces them.</p>
        <div className="ag-subhead"><h3>Routing</h3>{canManage && <Button size="sm" kind="ghost" renderIcon={Edit} onClick={() => setRouting((b.routing || []).map((r: any) => ({ review_type: r.review_type || "design", kind: r.kind || "", category: r.category || "", priority: r.priority ?? 0 })))}>Edit Routing</Button>}</div>
        <p className="ag-muted ag-body ag-mb-03">A rule matches a review type and, optionally, a catalogue kind or category; the highest priority wins.</p>
        {(b.routing || []).length === 0 ? <Empty>No routing rules: this board only receives reviews assigned to it explicitly.</Empty> : (
          <TableContainer><Table size="sm"><TableHead><TableRow><TableHeader>Review Type</TableHeader><TableHeader>Kind</TableHeader><TableHeader>Category</TableHeader><TableHeader>Priority</TableHeader></TableRow></TableHead>
            <TableBody>{b.routing.map((r: any, i: number) => <TableRow key={i}><TableCell><KindTag kind="review_type" value={r.review_type} /></TableCell><TableCell>{r.kind ? <KindTag kind="kind" value={r.kind} /> : <span className="ag-muted">any</span>}</TableCell><TableCell>{r.category || <span className="ag-muted">any</span>}</TableCell><TableCell>{r.priority ?? 0}</TableCell></TableRow>)}</TableBody></Table></TableContainer>)}
        <div className="ag-subhead"><h3>Workflows by Review Type</h3></div>
        <p className="ag-muted ag-body ag-mb-03">Every review type, whether this board handles it or not: how its reviews arrive, the steps they pass, and — for whoever runs the board — the workflow editor in place. A routed type with no workflow is decided by the chair alone.</p>
        <TableContainer><Table size="sm">
          <TableHead><TableRow><TableHeader>Review Type</TableHeader><TableHeader>Routed Here</TableHeader><TableHeader>Workflow</TableHeader><TableHeader>Actions</TableHeader></TableRow></TableHead>
          <TableBody>{REVIEW_TYPES.map((t) => {
            const rules = (b.routing || []).filter((r: any) => r.review_type === t);
            const steps: any[] | null = policies[t]?.steps || null;
            return (
              <TableRow key={t}>
                <TableCell><KindTag kind="review_type" value={t} size="md" /></TableCell>
                <TableCell>{rules.length
                  ? <div className="ag-row tight">{rules.map((r: any, i: number) => <span key={i} className="ag-label">{r.kind ? labelFor("kind", r.kind) : "any kind"}{r.category ? ` · ${r.category}` : ""} <span className="ag-muted">· priority {r.priority ?? 0}</span></span>)}</div>
                  : <span className="ag-muted">Not routed here</span>}</TableCell>
                <TableCell>{steps
                  ? <span className="ag-label">{steps.map((s: any) => s.name || labelFor("step", s.kind)).join(" → ") || "No steps"}</span>
                  : <span className={rules.length ? "" : "ag-muted"}>{rules.length ? <StatusTag kind="attention" value="decision" size="sm" label="No workflow — chair declares at once" /> : <span className="ag-muted">—</span>}</span>}</TableCell>
                <TableCell><div className="ag-actions">
                  {steps && <Button size="sm" kind="ghost" renderIcon={Flow} onClick={() => setViewFlow({ types: [t], steps })}>View Flow</Button>}
                  {canManage && (steps
                    ? <Button size="sm" kind="ghost" renderIcon={Edit} onClick={() => openPolicyEditor(t)}>Edit Workflow</Button>
                    : <Button size="sm" kind="ghost" renderIcon={Add} onClick={() => { const mode = areas.length ? "areas" : "count"; setPolicy({ type: t, steps: [{ name: "Pre-review", kind: "pre_review" }, { name: "Decision maker approvals", kind: "approvals", mode, min: 1, roles: defaultSeats("approvals", mode) }, { name: "Chair decision", kind: "decision", roles: DECISION_SEATS }] }); }}>Add Workflow</Button>)}
                </div></TableCell>
              </TableRow>);
          })}</TableBody>
        </Table></TableContainer>
      </section>

      {/* Full views: display only (RBAC untouched) — the page keeps the summaries, the modals carry the diagrams. */}
      <Modal open={viewComposition} passiveModal size="lg" modalHeading={`${b.name} · Composition`} onRequestClose={() => setViewComposition(false)}>
        <p className="ag-muted ag-body ag-mb-05">Who sits where, and the areas each decision maker answers for. Seats grant the rights; the chair declares and has no vote in areas mode.</p>
        <BoardComposition members={members} areas={areas} />
      </Modal>
      {viewFlow && <Modal open passiveModal size="lg" modalHeading={`${viewFlow.types.map((t) => labelFor("review_type", t)).join(" · ")} Reviews · Decision Flow`} onRequestClose={() => setViewFlow(null)}>
        <p className="ag-muted ag-body ag-mb-05">The steps the server enforces for these review types; the chair declares once they are satisfied. An areas-mode step needs every touched area's owner.</p>
        <PolicyDiagram steps={viewFlow.steps} members={members} areas={areas} />
      </Modal>}

      {removeM && <Modal open danger modalHeading={`Remove ${removeM.name || removeM.user_id} from ${b.code}?`} primaryButtonText="Remove Member" secondaryButtonText="Cancel"
        onRequestClose={() => setRemoveM(null)}
        onRequestSubmit={() => { const m = removeM; setRemoveM(null); run(`rm-${m.user_id}`, () => del(`/boards/${b.id}/members/${encodeURIComponent(m.user_id)}`), `${m.name || m.user_id} removed`); }}>
        <p className="ag-body">
          {normaliseSeat(removeM.board_role) === "chair" && bySeat("chair").length === 1
            ? "This is the board's only chair: nothing can be declared and no conditional can be resolved until a new chair is seated."
            : normaliseSeat(removeM.board_role) === "decision_maker" && bySeat("decision_maker").length === 1
            ? "This is the board's only decision maker: the approvals step cannot be satisfied until another is seated."
            : normaliseSeat(removeM.board_role) === "decision_maker" && (removeM.areas || []).length
            ? `Their areas (${(removeM.areas as string[]).map((a) => areaLabel(a, areas)).join(", ")}) lose their owner; reviews touching those areas cannot be approved until someone else owns them.`
            : "Their seat's rights end immediately. Positions they already recorded stay on the record; re-seating them later is a single step."}
        </p>
      </Modal>}

      <Modal open={!!edit} modalHeading={`Edit ${b.code}`} primaryButtonText="Save" secondaryButtonText="Cancel" primaryButtonDisabled={!edit?.name?.trim()} onRequestClose={() => setEdit(null)}
        onRequestSubmit={() => { const e = edit; setEdit(null); run("edit", () => put(`/boards/${b.id}`, e), "Board saved"); }}>
        {edit && <div className="ag-form"><TextInput id="e-name" labelText="Name" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /><TextArea id="e-purpose" labelText="Purpose" rows={2} value={edit.purpose} onChange={(e) => setEdit({ ...edit, purpose: e.target.value })} /></div>}
      </Modal>

      <Modal open={!!areasForm} modalHeading={`Areas of Responsibility for ${b.name}`} primaryButtonText="Save Areas" secondaryButtonText="Cancel" onRequestClose={() => setAreasForm(null)}
        onRequestSubmit={() => {
          const f = areasForm!; setAreasForm(null);
          // Keep the board's order for areas it already had, then newly ticked seeded ones, then custom ones.
          const order = [...areas.map((a) => a.id), ...SEEDED_AREAS, ...f.custom.map((c) => c.id)].filter((x, i, arr) => arr.indexOf(x) === i).filter((x) => f.selected.includes(x));
          const body = order.map((x) => ({ id: x, label: f.custom.find((c) => c.id === x)?.label || areaLabel(x, areas) }));
          run("areas", () => put(`/boards/${b.id}`, { areas: body }), "Areas saved");
        }}>
        {areasForm && <div className="ag-form">
          <p className="ag-body">Tick the areas this board holds decision makers accountable for. Removing an area takes it off every member who owned it; reviews already touching it keep their derived set until re-derived.</p>
          <FormGroup legendText="Areas">
            {SEEDED_AREAS.map((a) => <Checkbox key={a} id={`ar-${a}`} labelText={AREA_LABELS[a]} checked={areasForm.selected.includes(a)} onChange={(_, { checked }) => setAreasForm({ ...areasForm, selected: checked ? [...areasForm.selected, a] : areasForm.selected.filter((x) => x !== a) })} />)}
            {areasForm.custom.map((c) => <Checkbox key={c.id} id={`ar-${c.id}`} labelText={`${c.label} (custom · ${c.id})`} checked={areasForm.selected.includes(c.id)} onChange={(_, { checked }) => setAreasForm({ ...areasForm, selected: checked ? [...areasForm.selected, c.id] : areasForm.selected.filter((x) => x !== c.id) })} />)}
          </FormGroup>
          <div className="ag-filters">
            <TextInput id="ar-new-label" labelText="Add custom area" placeholder="e.g. Clinical safety" value={areasForm.newLabel} onChange={(e) => setAreasForm({ ...areasForm, newLabel: e.target.value, newId: areaSlug(e.target.value) })} />
            <TextInput id="ar-new-id" labelText="Id" placeholder="e.g. clinical-safety" value={areasForm.newId} onChange={(e) => setAreasForm({ ...areasForm, newId: areaSlug(e.target.value) })} />
            <Button size="md" kind="tertiary" renderIcon={Add} disabled={!areasForm.newLabel.trim() || !areasForm.newId || SEEDED_AREAS.includes(areasForm.newId) || areasForm.custom.some((c) => c.id === areasForm.newId)} onClick={() => setAreasForm({ ...areasForm, custom: [...areasForm.custom, { id: areasForm.newId, label: areasForm.newLabel.trim() }], selected: [...areasForm.selected, areasForm.newId], newLabel: "", newId: "" })}>Add</Button>
          </div>
        </div>}
      </Modal>

      {session && <NewSessionModal boards={[{ id: b.id, code: b.code, name: b.name }]} boardId={b.id} onClose={() => setSession(false)} onCreated={(s) => { setSession(false); if (s?.id) nav(`/sessions/${s.id}`); else { reload(); reloadSessions(); } }} />}

      <Modal open={!!routing} size="lg" modalHeading={`Routing Rules for ${b.name}`} primaryButtonText="Save Routing" secondaryButtonText="Cancel" onRequestClose={() => setRouting(null)}
        onRequestSubmit={() => { const rows = (routing || []).map((r) => ({ review_type: r.review_type, kind: r.kind || null, category: r.category || null, priority: Number(r.priority) || 0 })); setRouting(null); run("routing", () => put(`/boards/${b.id}/routing`, rows), "Routing saved"); }}>
        {routing && <div className="ag-form">
          {routing.length === 0 && <p className="ag-muted ag-body">No rules. Add one to receive reviews of a type.</p>}
          {routing.map((r, i) => (
            <div className="ag-routing-row" key={i}>
              <Select id={`rt-${i}`} labelText="Review type" value={r.review_type} onChange={(e) => setRouting(routing.map((x, k) => (k === i ? { ...x, review_type: e.target.value } : x)))}>{REVIEW_TYPES.map((t) => <SelectItem key={t} value={t} text={labelFor("review_type", t)} />)}</Select>
              <Select id={`rk-${i}`} labelText="Kind" value={r.kind} onChange={(e) => setRouting(routing.map((x, k) => (k === i ? { ...x, kind: e.target.value } : x)))}><SelectItem value="" text="Any" />{ARTEFACT_KINDS.map((k) => <SelectItem key={k.kind} value={k.kind} text={k.label} />)}</Select>
              <TextInput id={`rc-${i}`} labelText="Category" placeholder="e.g. AI" value={r.category} onChange={(e) => setRouting(routing.map((x, k) => (k === i ? { ...x, category: e.target.value } : x)))} />
              <NumberInput id={`rp-${i}`} label="Priority" min={0} max={100} value={r.priority} onChange={(_e, { value }) => setRouting(routing.map((x, k) => (k === i ? { ...x, priority: Number(value) || 0 } : x)))} />
              <Button size="md" kind="ghost" renderIcon={TrashCan} iconDescription="Remove rule" hasIconOnly onClick={() => setRouting(routing.filter((_x, k) => k !== i))} />
            </div>))}
          <div><Button size="sm" kind="tertiary" renderIcon={Add} onClick={() => setRouting([...routing, { review_type: "design", kind: "", category: "", priority: 0 }])}>Add Rule</Button></div>
        </div>}
      </Modal>

      <Modal open={!!policy} size="lg" modalHeading={policy ? `${labelFor("review_type", policy.type)} reviews · approval policy` : ""} primaryButtonText="Save Policy" secondaryButtonText="Cancel" primaryButtonDisabled={!policy?.steps?.length} onRequestClose={() => setPolicy(null)}
        onRequestSubmit={() => { const p = policy!; setPolicy(null); run("policy", () => put(`/boards/${b.id}/policies/${p.type}`, { policy: { steps: p.steps.map((s) => (s.kind === "pre_review" ? { name: s.name, kind: s.kind } : s.kind === "approvals" ? (s.mode === "areas" ? { name: s.name, kind: s.kind, mode: "areas", roles: s.roles } : { name: s.name, kind: s.kind, mode: "count", min: Number(s.min) || 1, roles: s.roles }) : { name: s.name, kind: s.kind, roles: s.roles })) } }), `Policy for ${labelFor("review_type", p.type).toLowerCase()} reviews saved`); }}>
        {policy && <div className="ag-form">
          <p className="ag-body">Steps run in order. An approvals step counts distinct approvals from the listed seats (count mode) or needs a yes on every area the review touches from the decision makers who own it (areas mode); a decision step names the seat that may declare once every earlier step is satisfied.</p>
          {areas.length === 0 && policy.steps.some((s) => s.kind === "approvals" && s.mode === "areas") && <InlineNotification kind="info" lowContrast hideCloseButton title="This board has no areas" subtitle="Areas mode needs areas on the board and on its decision makers; until then this step runs as count mode." />}
          {policy.steps.map((s, i) => (
            <div className="ag-policy-step" key={i}>
              <TextInput id={`ps-n-${i}`} labelText="Step" value={s.name} onChange={(e) => setPolicy({ ...policy, steps: policy.steps.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)) })} />
              {/* Changing the kind or mode resets the seats to that kind's default; the MultiSelect is keyed on both so it picks the new default up. */}
              <Select id={`ps-k-${i}`} labelText="Kind" value={s.kind} onChange={(e) => setPolicy({ ...policy, steps: policy.steps.map((x, k) => (k === i ? { ...x, kind: e.target.value, roles: defaultSeats(e.target.value, x.mode) } : x)) })}>{["pre_review", "approvals", "decision"].map((k) => <SelectItem key={k} value={k} text={labelFor("step", k)} />)}</Select>
              {s.kind === "approvals" ? <Select id={`ps-mode-${i}`} labelText="Mode" value={s.mode || "count"} onChange={(e) => setPolicy({ ...policy, steps: policy.steps.map((x, k) => (k === i ? { ...x, mode: e.target.value, roles: defaultSeats("approvals", e.target.value) } : x)) })}><SelectItem value="count" text="Count" /><SelectItem value="areas" text="Areas" /></Select> : <div />}
              {s.kind === "approvals" && s.mode !== "areas" ? <NumberInput id={`ps-m-${i}`} label="Minimum" min={1} max={20} value={s.min ?? 1} onChange={(_e, { value }) => setPolicy({ ...policy, steps: policy.steps.map((x, k) => (k === i ? { ...x, min: Number(value) || 1 } : x)) })} /> : <div />}
              {s.kind === "pre_review" ? <div className="ag-muted ag-label">Automatic</div> : <MultiSelect key={`${i}-${s.kind}-${s.mode}`} id={`ps-r-${i}`} titleText="Seats" label="Seats" items={roleItems} itemToString={(x: any) => x?.label || ""} initialSelectedItems={roleItems.filter((x) => (s.roles || []).includes(x.id))} onChange={({ selectedItems }: any) => setPolicy({ ...policy, steps: policy.steps.map((x, k) => (k === i ? { ...x, roles: selectedItems.map((y: any) => y.id) } : x)) })} />}
              <Button size="md" kind="ghost" renderIcon={TrashCan} iconDescription="Remove step" hasIconOnly onClick={() => setPolicy({ ...policy, steps: policy.steps.filter((_x, k) => k !== i) })} />
            </div>))}
          <div><Button size="sm" kind="tertiary" renderIcon={Add} onClick={() => { const mode = areas.length ? "areas" : "count"; setPolicy({ ...policy, steps: [...policy.steps, { name: "Approvals", kind: "approvals", mode, min: 1, roles: defaultSeats("approvals", mode) }] }); }}>Add Step</Button></div>
        </div>}
      </Modal>
    </>
  );
}

/**
 * The board as a visible structure: chair → decision makers (with the areas each one owns) → advisory & support.
 * Read-only for everyone with read — rights come from the seats themselves, and all editing stays in the gated
 * blocks beneath (members/policies need manage_board or platform admin on the server).
 */
function BoardComposition({ members, areas }: { members: any[]; areas: Area[] }) {
  const seat = (m: any) => normaliseSeat(m.board_role);
  const chairs = members.filter((m) => seat(m) === "chair");
  const dms = members.filter((m) => seat(m) === "decision_maker");
  const support = members.filter((m) => ["reviewer", "secretary", "observer"].includes(seat(m)));
  const card = (m: any) => (
    <div className={`ag-person${seat(m) === "chair" ? " chair" : ""}`} key={m.user_id}>
      <div className="ag-row tight"><User size={16} /><span className="ag-body ag-strong">{m.name || m.user_id}</span><KindTag kind="board_role" value={m.board_role} /></div>
      {seat(m) === "decision_maker" && areas.length > 0 && (
        <div className="ag-row tight ag-mt-02">{(m.areas || []).length ? (m.areas as string[]).map((a) => <AreaTag key={a} id={a} boardAreas={areas} />) : <span className="ag-muted ag-label">no areas owned</span>}</div>)}
    </div>);
  const tier = (label: string, note: string, cards: React.ReactNode) => (
    <div className="ag-tier">
      <div className="ag-tier-label"><span className="ag-strong">{label}</span> · {note}</div>
      <div className="ag-tier-cards">{cards}</div>
    </div>);
  return (
    <div className="ag-org">
      {tier("Chair", "moderates and declares the outcome the positions allow; no vote in areas mode", chairs.length ? chairs.map(card) : <div className="ag-person missing">No chair — nothing can be declared</div>)}
      <div className="ag-org-connector" aria-hidden="true" />
      {tier("Decision makers", areas.length ? "one position per owned area: yes, no, conditional or not my area" : "approvals are counted on this board", dms.length ? dms.map(card) : <div className="ag-person missing">None — the approvals step cannot be satisfied</div>)}
      {support.length > 0 && <>
        <div className="ag-org-connector" aria-hidden="true" />
        {tier("Advisory & support", "assess and run the board; no vote", support.map(card))}
      </>}
    </div>
  );
}

/**
 * One approval policy as a flow diagram: a column per step, edges left to right, and an areas-mode approvals
 * step fanning out into a node per decision maker (with the areas they own) before converging on the chair —
 * the real shape of the workflow. Pure SVG on semantic tokens (layer fill, subtle borders, square corners);
 * display only, with the whole flow in the image's accessible name. Rights are unaffected: it draws the same
 * policy the server enforces.
 */
function PolicyDiagram({ steps, members, areas }: { steps: any[]; members: any[]; areas: Area[] }) {
  const markerId = `agdg-${React.useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const W = 248, H = 72, HGAP = 72, VGAP = 16, CAP = 26;
  type N = { title: string; sub: string; kind: "auto" | "actor" | "decision"; missing?: boolean };
  const holders = (roles: string[]) => { const want = (roles || []).map(normaliseSeat); return members.filter((m) => want.includes(normaliseSeat(m.board_role))); };
  const cols: { caption: string; nodes: N[] }[] = steps.map((s: any, i: number) => {
    const roles: string[] = s.roles || defaultSeats(s.kind, s.mode);
    const caption = `Step ${i + 1} · ${labelFor("step", s.kind)}${s.kind === "approvals" ? ` · ${s.mode === "areas" ? "by area" : "counted"}` : ""}`;
    if (s.kind === "pre_review") return { caption, nodes: [{ title: s.name || "Automatic pre-review", sub: "Rules engine · never approves", kind: "auto" as const }] };
    if (s.kind === "approvals" && s.mode === "areas") {
      const dms = holders(["decision_maker"]);
      return { caption, nodes: dms.length
        ? dms.map((m) => ({ title: m.name || m.user_id, sub: (m.areas || []).length ? (m.areas as string[]).map((a) => areaLabel(a, areas)).join(" · ") : "No areas owned", kind: "actor" as const }))
        : [{ title: "No decision makers", sub: "This step cannot be satisfied", kind: "actor" as const, missing: true }] };
    }
    if (s.kind === "approvals") {
      const who = holders(roles).map((m) => m.name || m.user_id).join(", ");
      return { caption, nodes: [{ title: s.name || "Approvals", sub: `At least ${s.min ?? 1} from ${seatList(roles)}s${who ? ` — ${who}` : ""}`, kind: "actor" as const }] };
    }
    const who = holders(roles).map((m) => m.name || m.user_id).join(", ");
    return { caption, nodes: [{ title: s.name || "Decision", sub: who ? `Declares what the positions allow — ${who}` : "No chair seated", kind: "decision" as const, missing: !who }] };
  });
  if (!cols.length) return null;
  const colH = cols.map((c) => c.nodes.length * H + (c.nodes.length - 1) * VGAP);
  const bodyH = Math.max(...colH, H);
  const width = cols.length * W + (cols.length - 1) * HGAP;
  const height = CAP + bodyH;
  const x = (i: number) => i * (W + HGAP);
  const y = (i: number, j: number) => CAP + (bodyH - colH[i]) / 2 + j * (H + VGAP);
  const alt = cols.map((c) => `${c.caption}: ${c.nodes.map((n) => `${n.title} (${n.sub})`).join("; ")}`).join(". ");
  return (
    <div className="ag-diagram">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={alt}>
        <defs><marker id={markerId} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L8 4 L0 8 Z" className="ag-dg-head" /></marker></defs>
        {cols.slice(0, -1).map((c, i) => c.nodes.map((_a, j) => cols[i + 1].nodes.map((_b, k) => {
          const x1 = x(i) + W, y1 = y(i, j) + H / 2, x2 = x(i + 1) - 2, y2 = y(i + 1, k) + H / 2;
          return <path key={`${i}-${j}-${k}`} className="ag-dg-edge" markerEnd={`url(#${markerId})`} d={`M ${x1} ${y1} C ${x1 + HGAP / 2} ${y1}, ${x2 - HGAP / 2} ${y2}, ${x2} ${y2}`} />;
        })))}
        {cols.map((c, i) => (
          <g key={i}>
            <text className="ag-dg-cap" x={x(i)} y={14}>{c.caption}</text>
            {c.nodes.map((n, j) => (
              <g key={j}>
                <rect className={`ag-dg-node${n.missing ? " missing" : ""}`} x={x(i) + 0.5} y={y(i, j) + 0.5} width={W - 1} height={H - 1} />
                {n.kind === "decision" && !n.missing && <rect className="ag-dg-accent" x={x(i)} y={y(i, j)} width={3} height={H} />}
                <foreignObject x={x(i)} y={y(i, j)} width={W} height={H}>
                  <div className="ag-dg-body"><div className="ag-dg-title">{n.title}</div><div className="ag-dg-sub" title={n.sub}>{n.sub}</div></div>
                </foreignObject>
              </g>))}
          </g>))}
      </svg>
    </div>
  );
}

export const BoardTag = ({ b }: { b: any }) => (b ? <Tag size="sm" type="gray"><span title="The board this item is routed to; its seats and approval policy decide what happens next.">{b.name || b.code}</span></Tag> : null);
