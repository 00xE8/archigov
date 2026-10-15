import { createHash, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { resolveRoleName, type UserType, type RoleGrant } from "./roles.js";
import { appBaseUrl } from "./session.js";

/**
 * Microsoft Entra ID sign-in, OpenID Connect authorization-code flow with PKCE against the v2.0 endpoints.
 *   discovery   https://login.microsoftonline.com/{tenant}/v2.0/.well-known/openid-configuration
 *   authorize   {authorization_endpoint}  (response_type=code, scope=openid profile email, state, nonce, S256 PKCE)
 *   token       {token_endpoint}          (grant_type=authorization_code, code_verifier, client_secret when confidential)
 *   keys        {jwks_uri}                (RS256; `kid` in the token header selects the key)
 *   sign-out    {end_session_endpoint}?post_logout_redirect_uri=…
 * Docs: https://learn.microsoft.com/entra/identity-platform/v2-protocols-oidc
 *       https://learn.microsoft.com/entra/identity-platform/v2-oauth2-auth-code-flow
 *       https://learn.microsoft.com/entra/identity-platform/id-token-claims-reference
 * Identity: id tokens are RS256 only; `sub` is pairwise per app and `email`/`preferred_username` are mutable and
 * unverified, so the stable user key is `oid` + `tid` (stored as "<tid>:<oid>"); name/preferred_username are
 * display only. Roles: the `roles` claim carries the app-role VALUE strings assigned to the user or their
 * groups (absent when none). Each value is resolved with auth/roles.resolveRoleName: a user type (author,
 * auditor, service), the literal platform_admin (the operations flag), a board seat qualified as
 * "<BOARD>:<seat>" or "board/<BOARD>/<seat>" (e.g. "PCB:chair", "board/DA/decision_maker"), a legacy name
 * (admin, architect, engineer, submitter, chair, reviewer, board_member, auditor), after ENTRA_ROLE_MAP
 * ("arb.chair=chair,archigov.owner=platform_admin"), or the last dotted segment of the value (so a dotted value
 * keeps the legacy-suffix meaning: "arb.chair" is the legacy chair, not a board called ARB). The type and the
 * flag follow the claims on every sign-in; seats from board-qualified values and legacy aliases are applied
 * in-app. No recognised type → ENTRA_DEFAULT_ROLE (default: no system role, i.e. read only).
 */
export const authMode = (): "local" | "entra" => (process.env.AUTH_MODE === "entra" ? "entra" : "local");
export const entraConfigured = () => !!(process.env.ENTRA_TENANT_ID && process.env.ENTRA_CLIENT_ID && appBaseUrl());
const tenant = () => process.env.ENTRA_TENANT_ID || "";
const clientId = () => process.env.ENTRA_CLIENT_ID || "";
export const redirectUri = () => `${appBaseUrl()}/api/auth/callback`;

interface Discovery { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string; end_session_endpoint?: string }
let disc: { at: number; doc: Discovery } | null = null;
export async function discovery(): Promise<Discovery> {
  if (disc && Date.now() - disc.at < 3600_000) return disc.doc;
  const url = `https://login.microsoftonline.com/${encodeURIComponent(tenant())}/v2.0/.well-known/openid-configuration`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`OIDC discovery failed (${r.status}) for ${url}`);
  disc = { at: Date.now(), doc: (await r.json()) as Discovery };
  return disc.doc;
}

const b64u = (b: Buffer) => b.toString("base64url");
export function pkce() {
  const verifier = b64u(randomBytes(32));
  return { verifier, challenge: b64u(createHash("sha256").update(verifier).digest()) };
}

export async function loginRedirect(): Promise<{ url: string; state: string; nonce: string; verifier: string }> {
  const d = await discovery();
  const { verifier, challenge } = pkce();
  const state = b64u(randomBytes(16)), nonce = b64u(randomBytes(16));
  const p = new URLSearchParams({ client_id: clientId(), response_type: "code", redirect_uri: redirectUri(), response_mode: "query",
    scope: "openid profile email", state, nonce, code_challenge: challenge, code_challenge_method: "S256" });
  return { url: `${d.authorization_endpoint}?${p}`, state, nonce, verifier };
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
export interface EntraUser { id: string; name: string; email: string | null; tid: string; user_type: UserType | null; is_platform_admin: boolean; grants: RoleGrant[] }

export async function completeLogin(code: string, verifier: string, nonce: string): Promise<EntraUser> {
  const d = await discovery();
  const form = new URLSearchParams({ client_id: clientId(), grant_type: "authorization_code", code, redirect_uri: redirectUri(), code_verifier: verifier, scope: "openid profile email" });
  if (process.env.ENTRA_CLIENT_SECRET) form.set("client_secret", process.env.ENTRA_CLIENT_SECRET);
  const r = await fetch(d.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form });
  const tok: any = await r.json().catch(() => ({}));
  if (!r.ok || !tok.id_token) throw new Error(`token exchange failed: ${tok.error || r.status} ${tok.error_description || ""}`.trim());
  jwks ||= createRemoteJWKSet(new URL(d.jwks_uri));
  const { payload } = await jwtVerify(tok.id_token, jwks, { audience: clientId(), algorithms: ["RS256"] });
  return mapClaims(payload, nonce, d.issuer);
}

/** ENTRA_ROLE_MAP="arb.chair=chair,archigov.owner=platform_admin" → { "arb.chair": "chair", … } (keys lower-cased). */
const roleMap = (): Record<string, string> => Object.fromEntries((process.env.ENTRA_ROLE_MAP || "").split(",").map((p) => p.split("=").map((s) => s.trim())).filter((kv) => kv.length === 2 && kv[0] && kv[1]).map(([k, v]) => [k.toLowerCase(), v]));

/** App-role values → role grants (see the module comment); unknown values are dropped. Exported for tests. */
export function mapRoleValues(values: unknown): RoleGrant[] {
  const map = roleMap();
  const out: RoleGrant[] = [];
  const seen = new Set<string>();
  for (const v of Array.isArray(values) ? values : []) {
    if (typeof v !== "string") continue;
    const mapped = map[v.trim().toLowerCase()];
    const g = (mapped && resolveRoleName(mapped)) || resolveRoleName(v);
    if (!g) continue;
    const key = JSON.stringify(g);
    if (!seen.has(key)) { seen.add(key); out.push(g); }
  }
  return out;
}
/** The profile a set of grants amounts to: first user type wins (else ENTRA_DEFAULT_ROLE, else none), any platform_admin sets the flag. */
export function profileFromGrants(grants: RoleGrant[]): { user_type: UserType | null; is_platform_admin: boolean } {
  const type = grants.find((g) => g.user_type)?.user_type;
  const fallback = resolveRoleName(process.env.ENTRA_DEFAULT_ROLE || "")?.user_type;
  return { user_type: type ?? fallback ?? null, is_platform_admin: grants.some((g) => g.is_platform_admin) };
}

/** Claim checks beyond signature/aud/exp: issuer shape and tenant, nonce, then identity and role mapping. Exported for tests. */
export function mapClaims(payload: Record<string, any>, nonce: string, discoveredIssuer?: string): EntraUser {
  const iss = String(payload.iss || ""), tid = String(payload.tid || ""), oid = String(payload.oid || "");
  if (!/^https:\/\/login\.microsoftonline\.com\/[^/]+\/v2\.0$/.test(iss) || !tid || !iss.includes(`/${tid}/`)) throw new Error("id_token issuer mismatch");
  if (discoveredIssuer && !discoveredIssuer.includes("{tenantid}") && discoveredIssuer !== iss) throw new Error("id_token issuer does not match discovery");
  if (/^[0-9a-f-]{36}$/i.test(tenant()) && tid.toLowerCase() !== tenant().toLowerCase()) throw new Error("id_token tenant mismatch");
  if (payload.nonce !== nonce) throw new Error("id_token nonce mismatch");
  if (!oid) throw new Error("id_token has no oid claim (the profile scope is required)");
  const grants = mapRoleValues(payload.roles);
  return {
    id: `${tid}:${oid}`, tid,
    name: String(payload.name || payload.preferred_username || oid),
    email: (payload.email || payload.preferred_username || null) as string | null,
    ...profileFromGrants(grants), grants,
  };
}

export async function logoutUrl(): Promise<string | null> {
  try { const d = await discovery(); return d.end_session_endpoint ? `${d.end_session_endpoint}?${new URLSearchParams({ post_logout_redirect_uri: `${appBaseUrl()}/` })}` : null; }
  catch { return null; }
}
