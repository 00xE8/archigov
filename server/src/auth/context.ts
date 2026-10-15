import { AsyncLocalStorage } from "node:async_hooks";
import type { Membership, Role, UserType } from "./roles.js";

/**
 * The principal of the request being handled, available anywhere below the auth middleware without threading
 * it through every call. db.audit() reads the role from here, so every existing `audit(actorOf(c), …)` call
 * records who acted as what without changing its signature. This module has no imports from the app, so db.ts
 * and the middleware can both depend on it without a cycle.
 */
export interface Principal {
  id: string; name: string; email: string | null;
  user_type: UserType | null; is_platform_admin: boolean; boards: Membership[];
  /** the old global role names this profile still answers to */
  roles: Role[];
  via: "session" | "header";
}

export const principalStore = new AsyncLocalStorage<{ principal: Principal | null }>();
export const currentPrincipal = (): Principal | null => principalStore.getStore()?.principal ?? null;
/**
 * What the actor acted as, for the audit row: the system role, or — for someone without one — the seats they
 * hold, with "+platform_admin" when the flag is set ("author", "decision_maker", "chair+decision_maker",
 * "platform_admin"). The seat actually used is in the row's details.
 */
export const currentRole = (): string | null => {
  const p = currentPrincipal();
  if (!p) return null;
  const seats = [...new Set((p.boards || []).map((b) => b.role))].sort().join("+");
  const base = p.user_type ?? (seats || null);
  if (p.is_platform_admin) return base ? `${base}+platform_admin` : "platform_admin";
  return base ?? p.roles?.[0] ?? "none";
};
