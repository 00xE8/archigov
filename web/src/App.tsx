import React from "react";
import { BrowserRouter, Routes, Route, NavLink, Navigate, useLocation, useNavigate } from "react-router-dom";
import { Header, HeaderName, HeaderGlobalBar, HeaderGlobalAction, HeaderPanel, SideNav, SideNavItems, SideNavLink, SideNavMenu, SideNavMenuItem, SideNavDivider, Content, Theme, HeaderMenuButton, SkipToContent, Search, Form, ContainedList, ContainedListItem, Tag } from "@carbon/react";
import { Dashboard, Application, Rule, Document, Task, Compare, ListChecked, Settings, UserAvatar, Help, Search as SearchIcon, Catalog, Receipt, DataBase, Group, Calendar, Notification, BusinessProcesses, Hourglass, WarningSquare } from "@carbon/icons-react";
import Overview from "./pages/Overview";
import Applications from "./pages/Applications";
import BusinessServices from "./pages/BusinessServices";
import LegacyRegister from "./pages/LegacyRegister";
import ApplicationDetail from "./pages/ApplicationDetail";
import Catalogue from "./pages/Catalogue";
import Boards, { BoardDetail } from "./pages/Boards";
import Decisions from "./pages/Decisions";
import DecisionDetail from "./pages/DecisionDetail";
import Reviews from "./pages/Reviews";
import ReviewDetail from "./pages/ReviewDetail";
import Session from "./pages/Session";
import Sessions from "./pages/Sessions";
import Conformance from "./pages/Conformance";
import Backlog from "./pages/Backlog";
import Evidence from "./pages/Evidence";
import Audit from "./pages/Audit";
import SettingsPage from "./pages/Settings";
import { get, shortType, fmtDate, labelFor } from "./api";
import { useMedia, RLink } from "./components";
import { AuthProvider, AccountPanel, SignIn, useAuth, useCan, PersonaSwitcher } from "./auth";

type Item = { to: string; label: string; icon: React.ComponentType; end?: boolean };
// Overview sits above the groups: it is my work and the pipeline, not part of the model.
const OVERVIEW: Item = { to: "/", label: "Overview", icon: Dashboard, end: true };
// The nav mirrors the thesis: what was derived (model) → what people decided (governance) → where they meet (evidence).
// Labels say what a page holds, not just its noun: the delivery backlog is the teams' feed (never a backlog of
// decisions), "Imported evidence" never collides with its own group name, and "Board sessions" are sittings, not sign-ins.
const GROUPS: { title: string; icon: React.ComponentType; items: Item[] }[] = [
  { title: "Model", icon: DataBase, items: [
    { to: "/applications", label: "Applications", icon: Application },
    { to: "/services", label: "Business Services", icon: BusinessProcesses },
    { to: "/backlog", label: "Planned Changes", icon: ListChecked },
  ] },
  { title: "Governance", icon: Rule, items: [
    { to: "/governance", label: "Catalogue", icon: Rule },
    { to: "/decisions", label: "Decision Log", icon: Document },
    { to: "/reviews", label: "Reviews", icon: Task },
    { to: "/boards", label: "Boards", icon: Group },
    { to: "/sessions", label: "Board Sessions", icon: Calendar },
  ] },
  { title: "Evidence", icon: Compare, items: [
    { to: "/conformance", label: "Conformance", icon: Compare },
    { to: "/evidence", label: "Imported Evidence", icon: Catalog },
    { to: "/audit", label: "Audit Log", icon: Receipt },
  ] },
  // registers derived from the model and the decisions: what the estate is exposed to, and who has assessed it
  { title: "Risk", icon: WarningSquare, items: [
    { to: "/legacy", label: "Legacy Register", icon: Hourglass },
  ] },
];
const SETTINGS: Item = { to: "/settings", label: "Settings", icon: Settings };
const isActive = (path: string, it: Item) => (it.end ? path === it.to : path.startsWith(it.to));

function Shell() {
  const [open, setOpen] = React.useState(false);
  const [panel, setPanel] = React.useState<"search" | "help" | "account" | "notif" | null>(null);
  const wide = useMedia("(min-width: 66rem)"); // Carbon's lg breakpoint
  const loc = useLocation();
  const { me } = useAuth();
  // "Awaiting me": reviews whose board needs this person's approval or decision. Re-counted on every navigation; absent on an older API.
  const [awaiting, setAwaiting] = React.useState(0);
  React.useEffect(() => {
    if (!me?.authenticated) { setAwaiting(0); return; }
    get<any[]>("/reviews?awaiting=me").then((rs) => setAwaiting(Array.isArray(rs) ? rs.filter((r) => r.awaiting_me === true).length : 0)).catch(() => setAwaiting(0));
  }, [loc.pathname, me?.user?.id]);
  const badge = (it: Item) => (it.to === "/reviews" && awaiting > 0 ? <Tag size="sm" type="blue" className="ag-nav-badge"><span title="Reviews with an area or assessment waiting for you.">{awaiting} awaiting</span></Tag> : null);
  // Notifications: everything /me/work says is assigned to this person, polled every minute and on navigation.
  const [work, setWork] = React.useState<any>(null);
  React.useEffect(() => {
    if (!me?.authenticated) { setWork(null); return; }
    let on = true;
    const load = () => get<any>("/me/work").then((w) => on && setWork(w)).catch(() => {});
    load();
    const t = setInterval(load, 60000);
    return () => { on = false; clearInterval(t); };
  }, [me?.user?.id, loc.pathname]);
  const notifItems = workItems(work);
  React.useEffect(() => { setOpen(false); setPanel(null); }, [loc.pathname, loc.search]);
  React.useEffect(() => {
    if (!panel) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPanel(null); };
    document.addEventListener("keydown", onKey); return () => document.removeEventListener("keydown", onKey);
  }, [panel]);
  const toggle = (p: "search" | "help" | "account" | "notif") => setPanel((cur) => (cur === p ? null : p));
  // Settings is the platform admin's page: operations only, so nobody else carries it in their nav.
  // Authors still reach the Import tab through the Catalogue's Import menu (deep link; the route stays open to reads).
  const canManage = useCan("manage_platform");
  const settingsLink = canManage ? <SideNavLink as={NavLink} to={SETTINGS.to} renderIcon={SETTINGS.icon} isActive={isActive(loc.pathname, SETTINGS)}>{SETTINGS.label}</SideNavLink> : null;
  // Developer preview of the Entra sign-in page on an instance that runs in local mode.
  if (new URLSearchParams(loc.search).get("signin") === "1") return <SignIn loginUrl="/api/auth/login" />;
  const who = me?.user?.name || me?.user?.id || "account";
  return (
    <div className="ag-shell">
      <Theme theme="g100">
        <Header aria-label="Archigov" className="ag-header-glow">
          <SkipToContent />
          <HeaderMenuButton aria-label={open ? "Close menu" : "Open menu"} onClick={() => setOpen((o) => !o)} isActive={open} />
          <HeaderName href="/" prefix="">Archigov</HeaderName>
          <HeaderGlobalBar>
            {/* Dev mode (AUTH_MODE=local): the View as dropdown — every user with their roles, one click to act as them. */}
            <PersonaSwitcher />
            {me?.user && <HeaderGlobalAction aria-label={notifItems.length ? `Notifications · ${notifItems.length} assigned to you` : "Notifications · nothing assigned"} tooltipAlignment="end" isActive={panel === "notif"} onClick={() => toggle("notif")}>
              <Notification size={20} />
              {/* a numbered badge is allowed on the shell's large header buttons; it means "assigned", not "unread" */}
              {notifItems.length > 0 && <span className="ag-notif-badge" aria-hidden="true">{notifItems.length > 9 ? "9+" : notifItems.length}</span>}
            </HeaderGlobalAction>}
            <HeaderGlobalAction aria-label="Search" tooltipAlignment="end" isActive={panel === "search"} onClick={() => toggle("search")}><SearchIcon size={20} /></HeaderGlobalAction>
            <HeaderGlobalAction aria-label="Help" tooltipAlignment="end" isActive={panel === "help"} onClick={() => toggle("help")}><Help size={20} /></HeaderGlobalAction>
            <HeaderGlobalAction aria-label={`Account · ${who}`} tooltipAlignment="end" isActive={panel === "account"} onClick={() => toggle("account")}><UserAvatar size={20} /></HeaderGlobalAction>
          </HeaderGlobalBar>
          <HeaderPanel expanded={!!panel} className="ag-panel">
            {panel === "notif" && <NotificationsPanel items={notifItems} />}
            {panel === "search" && <SearchPanel onClose={() => setPanel(null)} />}
            {panel === "help" && <HelpPanel />}
            {panel === "account" && <AccountPanel />}
          </HeaderPanel>
          {wide ? (
            // ≥lg: expanded, fixed, grouped. The nav has its own column; it never overlays content.
            <SideNav aria-label="Side navigation" expanded isFixedNav isChildOfHeader>
              <SideNavItems>
                <SideNavLink as={NavLink} to={OVERVIEW.to} end renderIcon={OVERVIEW.icon} isActive={isActive(loc.pathname, OVERVIEW)}>{OVERVIEW.label}</SideNavLink>
                {GROUPS.map((g) => (
                  <React.Fragment key={g.title}>
                    <SideNavDivider />
                    <SideNavMenu title={g.title} renderIcon={g.icon} defaultExpanded isActive={g.items.some((it) => isActive(loc.pathname, it))}>
                      {g.items.map((it) => <SideNavMenuItem key={it.to} as={NavLink} isActive={isActive(loc.pathname, it)} {...({ to: it.to, end: it.end } as any)}>{it.label}{badge(it)}</SideNavMenuItem>)}
                    </SideNavMenu>
                  </React.Fragment>))}
                {settingsLink && <><SideNavDivider />{settingsLink}</>}
              </SideNavItems>
            </SideNav>
          ) : (
            // <lg: a rail (labels on hover) that the header button expands into an overlay.
            <SideNav aria-label="Side navigation" expanded={open} isChildOfHeader isFixedNav={false} isRail>
              <SideNavItems>
                {[OVERVIEW, ...GROUPS.flatMap((g) => g.items)].map((it) => <SideNavLink key={it.to} as={NavLink} to={it.to} end={it.end} renderIcon={it.icon} isActive={isActive(loc.pathname, it)}>{it.label}</SideNavLink>)}
                {settingsLink}
              </SideNavItems>
            </SideNav>
          )}
        </Header>
      </Theme>
      {/* Root theme is g10 (styles.scss); the explicit Theme keeps content tokens correct regardless. Offsets for the fixed header and nav live in .ag-content. */}
      <Theme theme="g10">
        <Content id="main-content" className="ag-content">
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/applications" element={<Applications />} />
            <Route path="/applications/:id" element={<ApplicationDetail />} />
            <Route path="/services" element={<BusinessServices />} />
            <Route path="/legacy" element={<LegacyRegister />} />
            <Route path="/governance" element={<Catalogue />} />
            {/* The catalogue used to be /standards; deep links (?open=, ?q=) keep working. */}
            <Route path="/standards" element={<Navigate to={`/governance${loc.search}`} replace />} />
            <Route path="/boards" element={<Boards />} />
            <Route path="/boards/:id" element={<BoardDetail />} />
            <Route path="/decisions" element={<Decisions />} />
            <Route path="/decisions/:id" element={<DecisionDetail />} />
            <Route path="/reviews" element={<Reviews />} />
            <Route path="/reviews/:id" element={<ReviewDetail />} />
            {/* Sessions across boards; a session's own page keeps its crumbs Boards › board › SES-0001. */}
            <Route path="/sessions" element={<Sessions />} />
            <Route path="/sessions/:id" element={<Session />} />
            <Route path="/conformance" element={<Conformance />} />
            <Route path="/evidence" element={<Evidence />} />
            <Route path="/audit" element={<Audit />} />
            <Route path="/backlog" element={<Backlog />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </Content>
      </Theme>
    </div>
  );
}

function HelpPanel() {
  return (
    <div className="ag-panel-body">
      <h3>What Archigov Is</h3>
      <p className="ag-body">The architecture model is derived from your cloud estate and backlog, not drawn by hand. Standards, decisions and reviews are the human layer on top of it. Nothing here asserts compliance: it shows evidence and who stands behind it.</p>
      <h3>Finding Your Way</h3>
      <dl className="ag-kv stacked">
        <dt>Model</dt><dd>What was collected and inferred: applications, their resources and criticality, the business services that depend on them, and the planned changes fed from the delivery backlog.</dd>
        <dt>Overview</dt><dd>Your work first: positions, declarations and sessions waiting on you, then the governance pipeline and the state of the estate.</dd>
        <dt>Governance</dt><dd>What people decided: the catalogue of standards, principles, patterns and policies, architecture decisions, reviews of all of them, the boards that approve them and the sessions they sit in.</dd>
        <dt>Board Sessions</dt><dd>A board sits in sessions: decision makers record a position for each area of responsibility they own, or delegate their seat for the sitting, and the chair declares the outcome those positions allow.</dd>
        <dt>Evidence</dt><dd>Where the two meet: conformance findings and drift, imported assessments from Defender for Cloud and Azure Policy, and the audit log.</dd>
        <dt>Risk</dt><dd>Registers derived from the model: the legacy register of components past or near their vendor's end of support, and the yearly legacy assessments that cover them.</dd>
      </dl>
      <div className="ag-row snug"><RLink to="/?start=1">Get started</RLink>{useCan("manage_platform") && <RLink to="/settings">Settings</RLink>}</div>
    </div>
  );
}

type Hit = { to: string; text: string };
/**
 * The header's notification feed: one row per thing /me/work says is assigned to this person — positions and
 * declarations awaited, assessments and conditions with due dates, circulations, resubmissions. The badge counts
 * what is assigned (not "unread"); rows new since the panel was last opened carry a New tag (a per-viewer
 * convenience in localStorage, nothing more).
 */
function workItems(w: any): { key: string; to: string; label: string; text: string; detail?: string }[] {
  if (!w) return [];
  const rv = (x: any) => x?.review || x || {};
  const out: { key: string; to: string; label: string; text: string; detail?: string }[] = [];
  for (const x of w.positions || []) out.push({ key: `pos:${rv(x).id}`, to: `/reviews/${rv(x).id}`, label: "Position awaited", text: `${rv(x).code} · ${rv(x).title}`, detail: (x.areas || []).map((a: string) => labelFor("area", a)).join(", ") || undefined });
  for (const x of w.declare || []) out.push({ key: `dec:${rv(x).id}`, to: `/reviews/${rv(x).id}`, label: "Ready to declare", text: `${rv(x).code} · ${rv(x).title}` });
  for (const x of w.resolve || []) out.push({ key: `rsl:${x.id || rv(x).id}`, to: `/reviews/${rv(x).id}`, label: "Conditional to resolve", text: `${rv(x).code} · ${rv(x).title}` });
  for (const x of w.assessments || []) out.push({ key: `ass:${x.id}`, to: `/reviews/${rv(x).id}`, label: "Assessment assigned", text: `${labelFor("assessment_type", x.type)}${x.title ? ` · ${x.title}` : ""} · ${rv(x).code}`, detail: x.due_at ? `due ${fmtDate(x.due_at)}` : undefined });
  for (const x of w.conditions || []) out.push({ key: `cnd:${x.id}`, to: `/reviews/${rv(x).id}`, label: "Condition you own", text: `${x.text ? `${String(x.text).slice(0, 80)} · ` : ""}${rv(x).code}`, detail: x.due_at ? `due ${fmtDate(x.due_at)}` : undefined });
  for (const x of w.circulations || []) out.push({ key: `cir:${x.id || rv(x).id}`, to: `/reviews/${rv(x).id}`, label: "Position due by circulation", text: `${rv(x).code} · ${rv(x).title}`, detail: x.due_at || x.circulation_due ? `due ${fmtDate(x.due_at || x.circulation_due)}` : undefined });
  for (const x of w.resubmit || []) out.push({ key: `rsb:${rv(x).id}`, to: `/reviews/${rv(x).id}`, label: "Changes requested on your review", text: `${rv(x).code} · ${rv(x).title}` });
  return out;
}
const SEEN_KEY = "ag-notif-seen";
const seenKeys = (): Set<string> => { try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || "[]")); } catch { return new Set(); } };
const markSeen = (keys: string[]) => { try { localStorage.setItem(SEEN_KEY, JSON.stringify([...new Set([...seenKeys(), ...keys])].slice(-500))); } catch { /* private mode: the New tags just persist */ } };

function NotificationsPanel({ items }: { items: { key: string; to: string; label: string; text: string; detail?: string }[] }) {
  // what was new when the panel opened stays tagged while it is open; everything is marked seen for next time
  const [openedWith] = React.useState<Set<string>>(() => seenKeys());
  React.useEffect(() => { markSeen(items.map((i) => i.key)); }, [items]);
  return (
    <div className="ag-panel-body">
      <h3>Notifications</h3>
      <p className="ag-muted ag-label ag-mb-03">Everything assigned to you right now — positions, declarations, assessments, conditions and resubmissions. The same queues live on the Overview.</p>
      {items.length === 0 ? <p className="ag-muted ag-body">Nothing is assigned to you.</p> : (
        <ContainedList label={`Assigned to you (${items.length})`} kind="on-page" size="sm">
          {items.map((i) => (
            <ContainedListItem key={i.key}>
              <RLink to={i.to} className="ag-notif-item">
                <span className="ag-row tight"><Tag size="sm" type="gray">{i.label}</Tag>{!openedWith.has(i.key) && <Tag size="sm" type="blue"><span title="Assigned since you last opened this panel.">New</span></Tag>}</span>
                <span className="ag-label">{i.text}</span>
                {i.detail && <span className="ag-muted ag-label">{i.detail}</span>}
              </RLink>
            </ContainedListItem>))}
        </ContainedList>)}
    </div>
  );
}

function SearchPanel({ onClose }: { onClose: () => void }) {
  const [q, setQ] = React.useState("");
  const [res, setRes] = React.useState<any>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const nav = useNavigate();
  React.useEffect(() => {
    const s = q.trim();
    if (s.length < 2) { setRes(null); setErr(null); return; }
    const t = setTimeout(() => { get(`/search?q=${encodeURIComponent(s)}`).then((r) => { setRes(r); setErr(null); }).catch((e) => { setRes(null); setErr(String(e.message || e)); }); }, 250);
    return () => clearTimeout(t);
  }, [q]);
  const groups: [string, Hit[]][] = res ? ([
    ["Applications", (res.applications || []).map((a: any) => ({ to: `/applications/${a.id}`, text: a.name }))],
    ["Resources", (res.resources || []).map((r: any) => ({ to: r.application_id ? `/applications/${r.application_id}` : "/applications", text: `${r.name} · ${shortType(r.subtype)}${r.application_name ? ` · ${r.application_name}` : ""}` }))],
    ["Catalogue", (res.standards || res.artefacts || []).map((s: any) => ({ to: `/governance?open=${s.id}`, text: `${s.code} · ${s.title}` }))],
    ["Decision Log", (res.decisions || []).map((d: any) => ({ to: `/decisions/${d.id}`, text: `${d.code} · ${d.title}` }))],
    ["Reviews", (res.reviews || []).map((r: any) => ({ to: `/reviews/${r.id}`, text: `${r.code} · ${r.title}` }))],
    ["Planned Changes", (res.work_items || []).map((w: any) => ({ to: "/backlog", text: `${w.external_id} · ${w.title}` }))],
  ] as [string, Hit[]][]).filter(([, items]) => items.length > 0) : [];
  const first = groups[0]?.[1]?.[0];
  const go = (h: Hit) => { nav(h.to); onClose(); };
  return (
    <Form className="ag-panel-body" onSubmit={(e) => { e.preventDefault(); if (first) go(first); }}>
      <h3>Search</h3>
      <Search id="global-search" labelText="Search" placeholder="e.g. STD-003, Referral API" size="lg" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      {err && <p className="ag-muted ag-label">{err}</p>}
      {res && groups.length === 0 && <p className="ag-muted ag-body">Nothing matches “{q.trim()}”.</p>}
      {groups.map(([label, items]) => <ContainedList key={label} label={label} kind="on-page" size="sm">{items.map((h) => <ContainedListItem key={h.to + h.text} onClick={() => go(h)}>{h.text}</ContainedListItem>)}</ContainedList>)}
      <p className="ag-muted ag-label">Enter opens the first result · Escape closes</p>
    </Form>
  );
}

export default function App() { return <BrowserRouter><AuthProvider><Shell /></AuthProvider></BrowserRouter>; }
