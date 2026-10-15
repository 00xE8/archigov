import { Hono } from "hono";
import { z } from "zod";
import { audit } from "../db.js";
import { actorOf } from "../http.js";
import { USER_TYPES } from "../auth/roles.js";
import { listUsers, getUser, upsertUser, membershipsOf } from "../auth/users.js";

/**
 * Users: the two RBAC levels per identity (user_type author | auditor | service | null, and the platform-admin
 * flag); seats are managed on the boards. Reading is open (names are needed to pick board members); writing is
 * platform-admin only (route rules).
 */
export const users = new Hono();

users.get("/users", (c) => c.json(listUsers()));
users.get("/users/:id", (c) => { const u = getUser(c.req.param("id")); return u ? c.json({ ...u, boards: membershipsOf(u.id) }) : c.json({ error: "not found" }, 404); });

const UserIn = z.object({ id: z.string().trim().min(1).max(200), name: z.string().trim().max(200).optional(), email: z.string().trim().max(200).nullable().optional(), user_type: z.enum(USER_TYPES).nullable().default(null), is_platform_admin: z.boolean().default(false) });
users.post("/users", async (c) => {
  const b = UserIn.parse(await c.req.json());
  if (getUser(b.id)) return c.json({ error: "user already exists; use PUT /users/:id" }, 409);
  const u = upsertUser(b.id, { name: b.name, email: b.email, user_type: b.user_type, is_platform_admin: b.is_platform_admin });
  audit(actorOf(c), "create", "user", u.id, { user_type: u.user_type, is_platform_admin: u.is_platform_admin });
  return c.json({ ...u, boards: [] });
});
users.put("/users/:id", async (c) => {
  const id = c.req.param("id"); const cur = getUser(id); if (!cur) return c.json({ error: "not found" }, 404);
  const b = UserIn.omit({ id: true }).partial().parse(await c.req.json());
  const u = upsertUser(id, { name: b.name, email: b.email, user_type: b.user_type, is_platform_admin: b.is_platform_admin });
  audit(actorOf(c), "update", "user", id, { user_type: u.user_type, is_platform_admin: u.is_platform_admin, changed: Object.keys(b) });
  return c.json({ ...u, boards: membershipsOf(id) });
});
