import { db, j, nowIso, audit, getSetting } from "../db.js";
import { isUserType, isBoardRole, resolveRoleName, legacyRolesOf, type UserType, type BoardRole, type Membership, type Profile, type RoleGrant } from "./roles.js";

/**
 * Users and their board memberships. A user row is the identity the product knows (the Entra "<tid>:<oid>" or
 * the local name); its `user_type` (author, auditor, service or none) and `is_platform_admin` are the two RBAC
 * levels, board seats live in board_members. In entra mode the type and the flag follow the app roles on every
 * sign-in; memberships are always managed in-app.
 */
export interface UserRow { id: string; name: string; email: string | null; user_type: UserType | null; is_platform_admin: boolean; created_at: string; updated_at: string }
const row = (r: any): UserRow | null => r ? { id: r.id, name: r.name, email: r.email ?? null, user_type: isUserType(r.user_type) ? r.user_type : null, is_platform_admin: !!r.is_platform_admin, created_at: r.created_at, updated_at: r.updated_at } : null;

export const getUser = (id: string): UserRow | null => row(db.prepare("SELECT * FROM users WHERE id=?").get(id));

export function membershipsOf(userId: string): Membership[] {
  return (db.prepare("SELECT b.id, b.code, b.name, m.board_role role, m.areas_json FROM board_members m JOIN boards b ON b.id=m.board_id WHERE m.user_id=? ORDER BY b.code").all(userId) as any[])
    .filter((m) => isBoardRole(m.role)).map(({ areas_json, ...m }) => ({ ...m, areas: j(areas_json, []) || [] })) as Membership[];
}
export const profileOf = (u: UserRow): Profile => ({ user_type: u.user_type, is_platform_admin: u.is_platform_admin, boards: membershipsOf(u.id) });
export const listUsers = () => (db.prepare("SELECT * FROM users ORDER BY name").all() as any[]).map((r) => { const u = row(r)!; return { ...u, boards: membershipsOf(u.id) }; });

export interface UserDefaults { name?: string; email?: string | null; user_type: UserType | null; is_platform_admin: boolean }
export interface UserPatch { name?: string; email?: string | null; user_type?: UserType | null; is_platform_admin?: boolean }

/** Create the user if missing with the given defaults; an existing row is never overwritten by defaults. */
export function ensureUser(id: string, defaults: UserDefaults): UserRow {
  const cur = getUser(id);
  if (cur) return cur;
  const now = nowIso();
  db.prepare("INSERT INTO users(id,name,email,user_type,is_platform_admin,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(id, defaults.name || id, defaults.email ?? null, defaults.user_type, defaults.is_platform_admin ? 1 : 0, now, now);
  return getUser(id)!;
}
/** Create or update; only the fields given change (user_type: null clears the system role). Returns the row after the write. */
export function upsertUser(id: string, patch: UserPatch, defaults?: { user_type: UserType | null; is_platform_admin: boolean }): UserRow {
  const cur = getUser(id);
  if (!cur) return ensureUser(id, { name: patch.name, email: patch.email, user_type: patch.user_type !== undefined ? patch.user_type : defaults?.user_type ?? null, is_platform_admin: patch.is_platform_admin ?? defaults?.is_platform_admin ?? false });
  db.prepare("UPDATE users SET name=?, email=?, user_type=?, is_platform_admin=?, updated_at=? WHERE id=?")
    .run(patch.name ?? cur.name, patch.email === undefined ? cur.email : patch.email, patch.user_type === undefined ? cur.user_type : patch.user_type, (patch.is_platform_admin ?? cur.is_platform_admin) ? 1 : 0, nowIso(), id);
  return getUser(id)!;
}

export const boardByCode = (code: string) => db.prepare("SELECT * FROM boards WHERE code=?").get(code.toUpperCase()) as any;
/** Set (or change) a seat; `areas` — the areas of responsibility a decision maker owns — are replaced when given and kept otherwise. */
export function setMembership(boardId: string, userId: string, role: BoardRole, areas?: string[] | null) {
  db.prepare("INSERT INTO board_members(board_id,user_id,board_role,added_at,areas_json) VALUES (?,?,?,?,?) ON CONFLICT(board_id,user_id) DO UPDATE SET board_role=excluded.board_role, areas_json=CASE WHEN ? THEN excluded.areas_json ELSE board_members.areas_json END")
    .run(boardId, userId, role, nowIso(), JSON.stringify(areas ?? []), areas ? 1 : 0);
}
export const setMemberAreas = (boardId: string, userId: string, areas: string[]) => db.prepare("UPDATE board_members SET areas_json=? WHERE board_id=? AND user_id=?").run(JSON.stringify(areas), boardId, userId).changes > 0;
export const removeMembership = (boardId: string, userId: string) => db.prepare("DELETE FROM board_members WHERE board_id=? AND user_id=?").run(boardId, userId).changes > 0;

/**
 * Apply a set of role grants (user type, admin flag, board seats) to a user; unknown boards are skipped. The first
 * user type wins and any platform_admin sets the flag; a user created by a seat-only grant has no system role.
 */
export function applyGrants(userId: string, grants: RoleGrant[], actor = "system") {
  let type: UserType | undefined, admin: boolean | undefined;
  for (const g of grants) { if (g.user_type && !type) type = g.user_type; if (g.is_platform_admin) admin = true; }
  if (!getUser(userId)) ensureUser(userId, { user_type: type ?? null, is_platform_admin: admin ?? false });
  else if (type !== undefined || admin !== undefined) upsertUser(userId, { user_type: type, is_platform_admin: admin });
  for (const g of grants) if (g.board) { const b = boardByCode(g.board.code); if (b) { setMembership(b.id, userId, g.board.role); audit(actor, "board_member:set", "boards", b.id, { user_id: userId, board_role: g.board.role, via: "role_grant" }); } }
}

/** Old `roles.<user>` settings → user rows (and DA seats for chair/reviewer/board_member). Idempotent: migrated keys are renamed. */
export function migrateLegacyRoles(): number {
  const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'roles.%'").all() as any[];
  let n = 0;
  for (const r of rows) {
    const user = r.key.slice("roles.".length); const g = resolveRoleName(r.value);
    if (g) { applyGrants(user, [g], "migration"); n++; }
    db.transaction(() => { db.prepare("DELETE FROM settings WHERE key=?").run(r.key); db.prepare("INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(`legacy_roles.${user}`, r.value); })();
  }
  return n;
}

/** What a user row answers to in the old vocabulary (for /auth/roles and /auth/me.roles). */
export const legacyRoleOf = (u: UserRow) => legacyRolesOf(profileOf(u));
export const demoLoaded = () => !!getSetting("demo.loaded");
