import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import { SESSION_COOKIE, verifyToken } from "./session.js";
import { routeCapabilities, capabilitiesFor, legacyRolesOf, type Capability } from "./roles.js";
import { authMode } from "./entra.js";
import { principalStore, type Principal } from "./context.js";
import { getUser, ensureUser, profileOf, type UserRow } from "./users.js";

export type { Principal } from "./context.js";

/** A user row → the request principal: type, admin flag and board seats are read fresh on every request, so a change applies at once. */
export function principalFrom(u: UserRow, via: "session" | "header"): Principal {
  const p = profileOf(u);
  return { id: u.id, name: u.name, email: u.email, user_type: p.user_type, is_platform_admin: p.is_platform_admin, boards: p.boards, roles: legacyRolesOf(p), via };
}

/**
 * Who is calling. A valid session cookie wins in both modes; the user it names must still exist. Without one,
 * local mode honours the x-user header (scripts, curl, the old PoC behaviour): an unknown name becomes a user
 * lazily as a platform admin ONLY — no system role, no seats — so a fresh self-hosted instance can be set up
 * (packs, sources, users, boards) but nobody submits, approves or decides by accident; governance actions need
 * a user someone has described. A trusted-network convenience, NOT a security boundary. Entra mode yields nobody
 * without a session.
 */
export function resolvePrincipal(c: Context): Principal | null {
  const s = verifyToken<any>(getCookie(c, SESSION_COOKIE));
  if (s && s.id && s.mode === authMode()) {
    const u = getUser(String(s.id)) || (authMode() === "local" ? ensureUser(String(s.id), { name: s.name, email: s.email ?? null, user_type: null, is_platform_admin: true }) : null);
    if (u) return principalFrom(u, "session");
  }
  if (authMode() === "local") {
    const id = c.req.header("x-user") || "local-admin";
    return principalFrom(ensureUser(id, { name: id, user_type: null, is_platform_admin: true }), "header");
  }
  return null;
}

/** Path relative to /api, which is what the route rules are written against. */
export const apiPath = (c: Context) => c.req.path.replace(/^\/api(?=\/|$)/, "") || "/";

export const forbidden = (c: Context, capability: Capability, p: Principal | null, reason?: string) =>
  c.json({ error: "forbidden", capability, roles: p?.roles ?? [], user_type: p?.user_type ?? null, is_platform_admin: p?.is_platform_admin ?? false, ...(reason ? { reason } : {}) }, 403);

/**
 * One gate for the whole API: resolve the principal, map method+path to the capabilities that open it, deny with
 * 401 (no one) or 403 (none of them held), then run the handler with the principal in async context so audit
 * rows carry the role. Seat-held capabilities pass here when held on any board; the review/board handlers do the
 * specific check.
 */
export async function authMiddleware(c: Context, next: Next) {
  const need = routeCapabilities(c.req.method, apiPath(c));
  const p = resolvePrincipal(c);
  (c as any).set("principal", p);
  if (need !== "exempt") {
    if (!p) return c.json({ error: "sign_in_required", login_url: "/api/auth/login" }, 401);
    const have = capabilitiesFor(p);
    if (!need.some((cap) => have.has(cap))) return forbidden(c, need[0], p);
  }
  await principalStore.run({ principal: p }, () => next());
}
