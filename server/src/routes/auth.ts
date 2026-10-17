import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { z } from "zod";
import { audit, nowIso, setSetting } from "../db.js";
import { actorOf } from "../http.js";
import { SESSION_COOKIE, OIDC_COOKIE, SESSION_TTL_SECONDS, signToken, verifyToken, cookieOptions } from "../auth/session.js";
import { USER_TYPES, BOARD_ROLES, LEGACY_NAMES, canMap, resolveRoleName, type Profile } from "../auth/roles.js";
import { authMode, entraConfigured, loginRedirect, completeLogin, logoutUrl } from "../auth/entra.js";
import { resolvePrincipal, principalFrom, type Principal } from "../auth/middleware.js";
import { upsertUser, applyGrants, listUsers, legacyRoleOf, boardByCode, setMembership, getUser } from "../auth/users.js";
import { about } from "../about.js";

export const auth = new Hono();

const profile = (p: Principal): Profile => ({ user_type: p.user_type, is_platform_admin: p.is_platform_admin, boards: p.boards });
const me = (p: Principal | null) => ({
  mode: authMode(), authenticated: !!p,
  user: p ? { id: p.id, name: p.name, email: p.email, user_type: p.user_type, is_platform_admin: p.is_platform_admin, boards: p.boards, roles: p.roles } : null,
  can: canMap(p ? profile(p) : null),
  ...(authMode() === "entra" ? { login_url: "/api/auth/login" } : {}),
});
const expiry = () => Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
/** Display details for an identity, kept so audit rows (which carry the stable id) can show a name. */
const rememberUser = (p: { id: string; name: string; email: string | null }) => setSetting(`user.${p.id}`, JSON.stringify({ name: p.name, email: p.email, last_sign_in: nowIso() }));

auth.get("/auth/me", (c) => c.json(me(resolvePrincipal(c))));
// the legal notices and the source offer: open before sign-in (auth/roles.ts), so the sign-in page shows them too
auth.get("/auth/about", (c) => c.json(about()));

// ---------- local mode: pick who you are (the PoC "acting as", now a signed session over a users row) ----------
const LocalIn = z.object({
  user: z.string().trim().min(1).max(120), name: z.string().trim().max(200).optional(),
  // user_type null = no system role (someone who only holds board seats, or an operations identity)
  user_type: z.enum(USER_TYPES).nullable().optional(), is_platform_admin: z.boolean().optional(),
  board_memberships: z.array(z.object({ board_code: z.string().min(1), board_role: z.enum(BOARD_ROLES) })).optional(),
  // legacy: a single old role name still works and expands to type/flag/seat
  role: z.string().optional(),
});
auth.post("/auth/local", async (c) => {
  if (authMode() !== "local") return c.json({ error: "local sign-in is disabled when AUTH_MODE=entra" }, 400);
  const b = LocalIn.parse(await c.req.json());
  const existed = !!getUser(b.user);
  // a brand-new local user with nothing specified is bootstrapped like the x-user fallback: a platform admin ONLY
  // (no system role, no seats). As soon as the caller says anything about who this is (a type, a role, a board),
  // the admin flag is opt-in and the type is what they said (or none).
  const described = b.user_type !== undefined || b.is_platform_admin !== undefined || !!b.role || !!b.board_memberships?.length;
  const u = upsertUser(b.user, { name: b.name, user_type: b.user_type, is_platform_admin: b.is_platform_admin }, { user_type: null, is_platform_admin: !described });
  if (b.role) { const g = resolveRoleName(b.role); if (g) applyGrants(b.user, [g], b.user); }
  for (const m of b.board_memberships || []) { const board = boardByCode(m.board_code); if (board) setMembership(board.id, u.id, m.board_role); }
  const p = principalFrom(getUser(b.user)!, "session");
  setCookie(c, SESSION_COOKIE, signToken({ id: p.id, name: p.name, email: p.email, mode: "local", exp: expiry() }), cookieOptions(SESSION_TTL_SECONDS));
  rememberUser(p);
  audit(b.user, "sign_in", "sign_in", null, { mode: "local", user_type: p.user_type, is_platform_admin: p.is_platform_admin, new_user: !existed });
  return c.json(me(p));
});

// ---------- legacy aliases of the users API (the old global roles, expressed from the new model) ----------
auth.get("/auth/roles", (c) => c.json(listUsers().map((u) => ({ user: u.id, role: legacyRoleOf(u)[0] ?? null, roles: legacyRoleOf(u), user_type: u.user_type, is_platform_admin: u.is_platform_admin, boards: u.boards }))));
auth.post("/auth/roles", async (c) => {
  const b = z.object({ user: z.string().trim().min(1).max(120), role: z.string().min(1) }).parse(await c.req.json());
  const g = resolveRoleName(b.role);
  if (!g) return c.json({ error: `unknown role "${b.role}"; use a user type (${USER_TYPES.join(", ")}), platform_admin, <BOARD>:<seat> (${BOARD_ROLES.join(", ")}) or a legacy name (${LEGACY_NAMES.join(", ")})` }, 400);
  applyGrants(b.user, [g], actorOf(c));
  const u = getUser(b.user)!;
  audit(actorOf(c), "assign_role", "user", b.user, { role: b.role, user_type: u.user_type, is_platform_admin: u.is_platform_admin });
  return c.json({ ok: true, user: b.user, role: b.role, user_type: u.user_type, is_platform_admin: u.is_platform_admin, boards: legacyRoleOf(u) });
});

// ---------- entra mode: the OIDC dance ----------
auth.get("/auth/login", async (c) => {
  if (authMode() !== "entra") return c.json({ error: "Microsoft Entra sign-in is not enabled (set AUTH_MODE=entra)" }, 400);
  if (!entraConfigured()) return c.json({ error: "Microsoft Entra is not configured: set ENTRA_TENANT_ID, ENTRA_CLIENT_ID and APP_BASE_URL" }, 500);
  const { url, state, nonce, verifier } = await loginRedirect();
  setCookie(c, OIDC_COOKIE, signToken({ state, nonce, verifier, exp: Math.floor(Date.now() / 1000) + 600 }), cookieOptions(600));
  return c.redirect(url, 302);
});
auth.get("/auth/callback", async (c) => {
  const q = c.req.query();
  const st = verifyToken<any>(getCookie(c, OIDC_COOKIE));
  deleteCookie(c, OIDC_COOKIE, { path: "/" });
  const fail = (msg: string) => c.redirect(`/?error=${encodeURIComponent(msg)}`, 302);
  if (q.error) return fail(q.error_description || q.error);
  if (!st || !q.code || q.state !== st.state) return fail("Sign-in state did not match; start again.");
  try {
    const u = await completeLogin(q.code, st.verifier, st.nonce);
    // Entra is the source of truth for the type and the admin flag on every sign-in; board memberships from
    // "<BOARD>.<role>" values and legacy aliases are applied in-app and otherwise managed there
    upsertUser(u.id, { name: u.name, email: u.email, user_type: u.user_type, is_platform_admin: u.is_platform_admin });
    applyGrants(u.id, u.grants.filter((g) => g.board), u.id);
    setCookie(c, SESSION_COOKIE, signToken({ id: u.id, name: u.name, email: u.email, mode: "entra", exp: expiry() }), cookieOptions(SESSION_TTL_SECONDS));
    rememberUser(u);
    // the actor is the stable "<tid>:<oid>" key; name/email are display only (mutable, unverified)
    audit(u.id, "sign_in", "sign_in", null, { mode: "entra", user_type: u.user_type, is_platform_admin: u.is_platform_admin, tid: u.tid, name: u.name });
    return c.redirect("/", 302);
  } catch (e: any) { return fail(e.message || "Sign-in failed"); }
});
auth.post("/auth/logout", async (c) => {
  const p = resolvePrincipal(c);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  // sign-ins and sign-outs are audited under the entity `sign_in` (board sittings are `sessions`); rows written before
  // this change carry `session` and are read back as `sign_in` by GET /audit — the chained history is never rewritten
  if (p) audit(p.id, "sign_out", "sign_in", null, { mode: authMode() });
  return c.json({ ok: true, logout_url: authMode() === "entra" ? await logoutUrl() : null });
});
