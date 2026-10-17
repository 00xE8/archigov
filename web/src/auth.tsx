import React from "react";
import { Button, Tile, InlineNotification, Modal, TextInput, Dropdown, Tag, DismissibleTag, Tooltip, ToastNotification, SkeletonText, Toggle, Select, SelectItem } from "@carbon/react";
import { Login, Logout, UserAvatar, User, Switcher, Group, Settings as SettingsIcon, Add } from "@carbon/icons-react";
import { get, post, setAuthMode, currentUser, setCurrentUser, USER_TYPE_ITEMS, NO_SYSTEM_ROLE, BOARD_ROLES, BOARD_ROLE_LABELS, NEED_FOR, CAP_ALIAS, AUTHOR_CAPS, normaliseUserType, labelFor } from "./api";
import { BrandMark } from "./brand";
import { LegalLine } from "./components/About";

export type Caps = Record<string, boolean>;
export type Board = { id: string; code: string; name: string; role: string };
export type Me = {
  mode: "local" | "entra"; authenticated: boolean;
  user: { id: string; name: string; email?: string; user_type?: string; is_platform_admin?: boolean; boards?: Board[]; roles?: string[] } | null;
  can: Caps; login_url?: string; legacy?: boolean;
};

const CAPS = ["read", "export_evidence", "submit_design_review", "submit_review", "comment", "resubmit", "manage_artefacts", "manage_standards", "create_decision", "pre_review", "verify", "import_artefacts", "manage_platform", "manage_sources", "manage_board", "approve_review", "request_changes", "decide_review", "grant_exception", "resolve_finding", "close_condition", "set_decision_status"];
const ALL: Caps = Object.fromEntries(CAPS.map((k) => [k, true]));

type Auth = { me: Me | null; refresh: () => Promise<void> };
const Ctx = React.createContext<Auth>({ me: null, refresh: async () => {} });

/**
 * Loads /auth/me once, exposes who is signed in and what they may do, renders the sign-in page when the
 * API says so, and turns 403s into a toast. An older API without /auth/me degrades to the local PoC
 * identity with every capability (the server still decides).
 */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [me, setMe] = React.useState<Me | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [signIn, setSignIn] = React.useState<string | null>(null);
  const [toast, setToast] = React.useState<string | null>(null);
  const refresh = React.useCallback(async () => {
    try {
      const m = await get<Me>("/auth/me");
      setAuthMode(m.mode);
      setMe({ ...m, can: m.can || ALL });
      setSignIn(m.mode === "entra" && !m.authenticated ? m.login_url || "/api/auth/login" : null);
    } catch (e: any) {
      if (e?.code === "sign_in_required") { setMe(null); setSignIn(e.login_url || "/api/auth/login"); }
      else { setAuthMode("local"); setMe({ mode: "local", authenticated: true, user: { id: currentUser(), name: currentUser(), roles: ["admin"] }, can: ALL, legacy: true }); setSignIn(null); }
    } finally { setLoading(false); }
  }, []);
  React.useEffect(() => {
    refresh();
    const onSign = (e: Event) => setSignIn((e as CustomEvent).detail?.login_url || "/api/auth/login");
    const onForbid = (e: Event) => setToast((e as CustomEvent).detail?.message || "Not allowed");
    window.addEventListener("archigov:signin", onSign); window.addEventListener("archigov:forbidden", onForbid);
    return () => { window.removeEventListener("archigov:signin", onSign); window.removeEventListener("archigov:forbidden", onForbid); };
  }, [refresh]);
  if (loading) return <div className="ag-signin"><SkeletonText paragraph lineCount={3} width="24rem" /></div>;
  if (signIn && !(me && me.authenticated)) return <SignIn loginUrl={signIn} />;
  return (
    <Ctx.Provider value={{ me, refresh }}>
      {children}
      {toast && <div className="ag-toasts" aria-live="polite"><ToastNotification kind="error" lowContrast title="Not allowed" subtitle={toast} timeout={8000} onClose={() => { setToast(null); return true; }} /></div>}
    </Ctx.Provider>
  );
}

export const useAuth = () => React.useContext(Ctx);
/** Capability check with alias fallback for older servers; an unknown capability is allowed client-side (the server is the authority). */
export function canDo(me: Me | null, cap: string): boolean {
  if (!me || !me.can) return true;
  const v = me.can[cap];
  if (v !== undefined) return v !== false;
  const alias = CAP_ALIAS[cap];
  return alias ? me.can[alias] !== false : true;
}
export function useCan(cap: string) { const { me } = useAuth(); return canDo(me, cap); }

/**
 * Wraps one action. Without the capability the action is disabled with a tooltip naming who it needs
 * (mode "disable"), or not rendered at all (mode "hide" — for row actions, where a disabled menu is noise).
 * `allowed` lets a page pass a per-item verdict from the API (e.g. a review's own `can`) instead of the global map.
 * A platform admin without a system role is told why an author's action is off: the flag runs the instance, it does not author.
 */
export function Gated({ cap, children, mode = "disable", allowed, reason }: { cap: string; children: React.ReactElement<any>; mode?: "disable" | "hide"; allowed?: boolean; reason?: string }) {
  const { me } = useAuth();
  const ok = allowed === undefined ? canDo(me, cap) : allowed;
  if (ok) return children;
  if (mode === "hide") return null;
  const adminNotAuthor = !!me?.user?.is_platform_admin && !me?.user?.user_type && AUTHOR_CAPS.has(cap);
  const label = reason || (adminNotAuthor ? "Platform admin is not an author — assign the Author role" : `Needs ${NEED_FOR[cap] || "a different role"}`);
  return (
    <Tooltip label={label} align="bottom">
      <span className="ag-gated" tabIndex={0}>{React.cloneElement(children, { disabled: true })}</span>
    </Tooltip>
  );
}

/** Entra mode, not signed in: the only thing on the page is the way in. */
export function SignIn({ loginUrl }: { loginUrl: string }) {
  const err = new URLSearchParams(window.location.search).get("error");
  return (
    <div className="ag-signin">
      <Tile className="ag-signin-card">
        <h1 className="ag-brand"><BrandMark />archigov</h1>
        <p className="ag-body">The architecture model is derived from your cloud estate and backlog, not drawn by hand. Standards, decisions and reviews are the human layer on top of it. Nothing here asserts compliance: it shows evidence and who stands behind it.</p>
        {err && <InlineNotification kind="error" lowContrast hideCloseButton title="Sign-in did not complete" subtitle={err} />}
        <div><Button size="lg" renderIcon={Login} onClick={() => { window.location.href = loginUrl; }}>Sign in with Microsoft Entra ID</Button></div>
        <p className="ag-muted ag-label">Use your organisation's Entra ID account. Your system role (author, auditor, service account) and whether you administer the platform come from the app roles assigned to you; what you may approve or decide comes from your seat on each board.</p>
        <LegalLine />
      </Tile>
    </div>
  );
}

/** Header account panel: who you are, your system role and seats, and sign out / switch user. */
export function AccountPanel() {
  const { me } = useAuth();
  const [sw, setSw] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const u = me?.user;
  const legacyRoles = u?.roles?.length && !u.user_type ? u.roles : [];
  const signOut = async () => {
    setBusy(true);
    try { const r: any = await post("/auth/logout"); window.location.href = r?.logout_url || "/"; } catch { window.location.href = "/"; }
  };
  return (
    <div className="ag-panel-body">
      <h3>Account</h3>
      <div className="ag-row snug"><UserAvatar size={20} /><span className="ag-body ag-strong">{u?.name || u?.id || "—"}</span></div>
      {u?.email && <div className="ag-muted ag-label">{u.email}</div>}
      {/* Classification, not status: system role, platform admin and seats are gray tags. */}
      <div className="ag-row tight ag-mt-03">
        {u?.user_type && <Tag size="sm" type="gray" renderIcon={User}><span title="System role: an author submits and authors, an auditor reads and exports, a service account is read-only.">{labelFor("user_type", u.user_type)}</span></Tag>}
        {u?.is_platform_admin && <Tag size="sm" type="gray" renderIcon={SettingsIcon}><span title="Operational only: sources, settings, users and boards configuration — never submit, approve or decide.">Platform admin</span></Tag>}
        {legacyRoles.map((r) => <Tag key={r} size="sm" type="gray" renderIcon={User}><span title="Legacy role name, mapped to its modern equivalent.">{labelFor("role", r)}</span></Tag>)}
        {!u?.user_type && legacyRoles.length === 0 && <span className="ag-muted ag-label">{NO_SYSTEM_ROLE}</span>}
      </div>
      {Array.isArray(u?.boards) && (
        <div className="ag-mt-03">
          <div className="ag-muted ag-label">Board seats</div>
          {u!.boards!.length === 0 ? <div className="ag-muted ag-label">No seat on any board — nothing to approve or decide.</div>
            : <div className="ag-row tight ag-mt-02">{u!.boards!.map((b) => <Tag key={b.id} size="sm" type="gray" renderIcon={Group}><span title="A seat on this board; governance rights come from board seats, not system roles.">{b.name} · {labelFor("board_role", b.role).toLowerCase()}</span></Tag>)}</div>}
        </div>)}
      <p className="ag-muted ag-label ag-mt-03">{me?.mode === "entra" ? "Signed in with Microsoft Entra ID." : "Local sign-in (PoC): the user, system role and seats you choose are recorded as the actor on everything you do. Switch persona from the View as dropdown in the header."}</p>
      <div className="ag-row snug ag-mt-05">
        {me?.mode === "entra"
          ? <Button size="sm" kind="tertiary" renderIcon={Logout} disabled={busy} onClick={signOut}>Sign Out</Button>
          : <Button size="sm" kind="tertiary" renderIcon={Switcher} onClick={() => setSw(true)}>Custom User</Button>}
      </div>
      {sw && <SwitchUser onClose={() => setSw(false)} />}
    </div>
  );
}

/** One line of roles for the persona dropdown: "Platform admin", "Author · DA chair · PCB decision maker". */
export function personaSummary(u: any): string {
  const bits: string[] = [];
  if (u?.user_type) bits.push(labelFor("user_type", u.user_type));
  if (u?.is_platform_admin) bits.push("Platform admin");
  for (const b of u?.boards || []) bits.push(`${b.code || b.name} ${labelFor("board_role", b.role || b.board_role).toLowerCase()}`);
  return bits.join(" · ") || NO_SYSTEM_ROLE;
}

/**
 * Dev mode, on exactly when the server runs AUTH_MODE=local: a header dropdown of every user with their roles —
 * one click switches the browser to that persona (their real system role, flag and every board seat). Switching
 * signs in as them (POST /auth/local), so everything done afterwards is recorded as that user, audit log included.
 * Never rendered under Entra; the server re-derives capabilities on every request either way.
 */
export function PersonaSwitcher() {
  const { me } = useAuth();
  const local = me?.mode === "local" && !!me.user;
  const [users, setUsers] = React.useState<any[]>([]);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => { if (local) get<any[]>("/users").then((u) => setUsers(Array.isArray(u) ? u : [])).catch(() => setUsers([])); }, [local]);
  if (!local) return null;
  const current = users.find((u) => u.id === me!.user!.id) || null;
  const switchTo = async (u: any) => {
    if (!u || u.id === me!.user!.id) return;
    setBusy(true);
    try { await post("/auth/local", { user: u.id }); setCurrentUser(u.id); window.location.reload(); } catch { setBusy(false); }
  };
  return (
    <div className="ag-persona" title="Local sign-in (PoC): everything you do is recorded as this user.">
      <Dropdown id="persona-switch" size="sm" titleText="View as" hideLabel label={me!.user!.name || me!.user!.id} items={users}
        itemToString={(u: any) => (u ? `${u.name || u.id} — ${personaSummary(u)}` : "")}
        renderSelectedItem={(u: any) => u?.name || u?.id || ""}
        selectedItem={current} onChange={({ selectedItem }: any) => switchTo(selectedItem)} disabled={busy || users.length === 0} />
    </div>
  );
}

/** Local mode: become a user with any combination of system role, platform-admin flag and board seats (for role combinations no seeded user has). The page reloads so every list reflects the new identity. */
function SwitchUser({ onClose }: { onClose: () => void }) {
  const { me } = useAuth();
  const [user, setUser] = React.useState(me?.user?.id || currentUser());
  const [type, setType] = React.useState(normaliseUserType(me?.user?.user_type));
  const [admin, setAdmin] = React.useState(!!me?.user?.is_platform_admin);
  const [seats, setSeats] = React.useState<{ board_code: string; board_role: string }[]>([]);
  const [boardCode, setBoardCode] = React.useState("");
  const [boardRole, setBoardRole] = React.useState("decision_maker");
  const [boards, setBoards] = React.useState<any[] | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  React.useEffect(() => { get<any[]>("/boards").then(setBoards).catch(() => setBoards([])); }, []);
  const roleItems = BOARD_ROLES.map((id) => ({ id, label: BOARD_ROLE_LABELS[id] }));
  const addSeat = () => { if (!boardCode) return; setSeats([...seats.filter((s) => s.board_code !== boardCode), { board_code: boardCode, board_role: boardRole }]); setBoardCode(""); };
  const typeHelp = me?.legacy ? "This server does not manage system roles yet; every local user acts as admin." : !type ? "Without a system role this user only reads; a board seat adds approving or deciding." : type === "author" ? "Submits designs, drafts catalogue items and decisions, runs pre-review and verifies." : undefined;
  return (
    <Modal open modalHeading="Custom User" primaryButtonText="Switch" secondaryButtonText="Cancel" primaryButtonDisabled={!user.trim()} onRequestClose={onClose}
      onRequestSubmit={async () => {
        try {
          // Never send the legacy `role` here: the server expands it into grants (author → a DA reviewer seat),
          // which silently REWROTE real seats — switching to j.duduka as an author demoted the DA chair.
          // The modern fields say exactly what is meant; a legacy server gets no POST at all (x-user suffices).
          if (!me?.legacy) await post("/auth/local", { user: user.trim(), user_type: type || null, is_platform_admin: admin, board_memberships: seats });
          setCurrentUser(user.trim());
          window.location.reload();
        } catch (e: any) { setErr(String(e.message || e)); }
      }}>
      <div className="ag-form">
        <p className="ag-body">Local sign-in stands in for single sign-on while this instance is a proof of concept. The user, system role, platform-admin flag and board seats you choose are recorded as the actor on verifications, approvals and the audit trail.</p>
        <TextInput id="su-user" labelText="User" placeholder="e.g. j.duduka" value={user} onChange={(e) => setUser(e.target.value)} />
        <Dropdown id="su-type" titleText="System role" label="Choose a role" items={USER_TYPE_ITEMS} itemToString={(i: any) => i?.label || ""} selectedItem={USER_TYPE_ITEMS.find((i) => i.id === type)} onChange={({ selectedItem }: any) => selectedItem && setType(selectedItem.id)} disabled={!!me?.legacy} helperText={typeHelp} />
        <Toggle id="su-admin" labelText="Platform admin" labelA="No" labelB="Yes" toggled={admin} onToggle={setAdmin} disabled={!!me?.legacy} />
        <p className="ag-muted ag-label">A platform admin runs the instance (sources, settings, users, boards). It is not an author and grants nothing in a review.</p>
        {boards && boards.length > 0 && <>
          <div className="ag-row end">
            <Select id="su-board" labelText="Board seats (optional)" value={boardCode} onChange={(e) => setBoardCode(e.target.value)}><SelectItem value="" text="Choose a board" />{boards.map((b) => <SelectItem key={b.id} value={b.code} text={b.name} />)}</Select>
            <Dropdown id="su-brole" titleText="Seat" label="Seat" items={roleItems} itemToString={(i: any) => i?.label || ""} selectedItem={roleItems.find((i) => i.id === boardRole)} onChange={({ selectedItem }: any) => selectedItem && setBoardRole(selectedItem.id)} disabled={!boardCode} />
            <Button size="md" kind="tertiary" renderIcon={Add} disabled={!boardCode} onClick={addSeat}>Add Seat</Button>
          </div>
          {seats.length > 0 && <div className="ag-row tight">
            {seats.map((s) => <DismissibleTag key={s.board_code} type="gray" text={`${s.board_code} · ${BOARD_ROLE_LABELS[s.board_role] || s.board_role}`} title="Remove seat" onClose={() => setSeats(seats.filter((x) => x.board_code !== s.board_code))} />)}
          </div>}
          <p className="ag-muted ag-label">Seats listed here are granted on switch; seats the user already holds are kept. Seats are removed on each board's own page.</p>
        </>}
        {err && <InlineNotification kind="error" lowContrast hideCloseButton title="Could not switch user" subtitle={err} />}
      </div>
    </Modal>
  );
}
